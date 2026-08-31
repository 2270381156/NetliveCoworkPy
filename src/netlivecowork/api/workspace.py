"""workspace 浏览与文件管理端点（桌面前端用）。

host 直接读写文件系统：filesystem capability provider 只管 agent 执行期的 per-session
workspace 生命周期，不参与 host 侧的浏览与管理。路径为绝对路径（前端按绝对 entry.path
导航），并约束在所有已登记 workspace 根之内，防越权读写任意磁盘文件。

写操作（上传 / 删除 / 打包下载）比读多两道闸：
  · 目标文件名来自客户端 → 一律经 workspace_store.safe_upload_name 收敛成纯文件名，
    否则 `../../` 就能写到工作区之外，而且写成功了不报错；
  · 删目录前先看有没有**还在跑**的会话正用着它——删目录本身不危险，把正在干活的 agent
    的工作目录抽掉才危险：它下一步的读写会莫名其妙地失败，而现场已经没了、无从追查。
"""
from __future__ import annotations

import os
import shutil
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from netlivecowork import workspace_store
from netlivecowork.api.models import session as _sm
from netlivecowork.api.schemas.workspace import (
    DraftRootRequest,
    WorkspaceEntry,
    WorkspaceListing,
    WorkspaceUploadResult,
)

router = APIRouter(prefix="/workspace", tags=["workspace"])

# 草稿工作区根：新建会话草稿期（session 尚未创建）供前端浏览所选目录。
# 全局单份——UI 同时只有一个草稿，重复登记即替换；会话真正创建/草稿取消后由前端清除。
_draft_root: Path | None = None


def registered_roots() -> list[Path]:
    """所有内存 session 的 workspace 根 + 草稿根（绝对、已 resolve）。会话根优先。"""
    roots: list[Path] = []
    for e in _sm._sessions.values():
        ws = getattr(e, "workspace", None)
        if ws:
            try:
                roots.append(Path(ws).resolve())
            except OSError:
                continue
    if _draft_root is not None:
        roots.append(_draft_root)
    return roots


def _root_for(target: Path, roots: list[Path]) -> Path | None:
    for r in roots:
        if target == r or r in target.parents:
            return r
    return None


def _authorize(path: str) -> Path:
    """解析 path 并校验落在某登记根之内；空 path 兜底到第一个根。"""
    roots = registered_roots()
    if not roots:
        raise HTTPException(status_code=403, detail="no registered workspace")
    if not path:
        return roots[0]
    try:
        target = Path(path).resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"bad path: {e}") from e
    if _root_for(target, roots) is None:
        raise HTTPException(status_code=403, detail="path outside any registered workspace")
    return target


@router.get("/files", response_model=WorkspaceListing)
def list_files(path: str = Query("")) -> WorkspaceListing:
    target = _authorize(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory")
    roots = registered_roots()
    root = _root_for(target, roots) or target
    entries: list[WorkspaceEntry] = []
    with os.scandir(target) as it:
        for de in it:
            is_dir = de.is_dir(follow_symlinks=False)
            size: int | None = None
            if not is_dir:
                try:
                    size = de.stat(follow_symlinks=False).st_size
                except OSError:
                    size = None
            entries.append(WorkspaceEntry(name=de.name, path=str(Path(de.path)), is_dir=is_dir, size=size))
    entries.sort(key=lambda e: (not e.is_dir, e.name.lower()))
    parent = str(target.parent) if target != root else str(root)
    return WorkspaceListing(root=str(root), path=str(target), parent=parent, entries=entries)


@router.get("/file")
def read_file(path: str = Query(...)) -> dict:
    target = _authorize(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=400, detail="not valid UTF-8 text") from e
    return {"path": str(target), "content": content}


@router.get("/file/stat")
def file_stat(path: str = Query(...)) -> dict:
    """轻量元数据（mtime + size），供前端轮询判断文件是否变化以自动刷新预览。

    只 stat 不读内容，故轮询开销极小；返回 404 表示文件已不存在。
    """
    target = _authorize(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    st = target.stat()
    return {"path": str(target), "mtime": st.st_mtime, "size": st.st_size}


@router.get("/file/raw")
def read_file_raw(path: str = Query(...)) -> FileResponse:
    target = _authorize(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(target))


# ── 写操作 ───────────────────────────────────────────────────────────────────
# 两道闸都在 workspace_store 里算，本模块只负责翻成 HTTP：
#   * 单文件大小上限 —— 恒定生效；
#   * 工作区软限额 —— 仅在配置了配额时生效（地端默认不限，见 config）。

_UPLOAD_CHUNK = 1024 * 1024


def _entry_of(p: Path) -> WorkspaceEntry:
    st = p.stat()
    return WorkspaceEntry(name=p.name, path=str(p), is_dir=False, size=st.st_size)


async def _write_upload(src: UploadFile, dest: Path, max_bytes: int, budget: int | None) -> int:
    """流式落盘并即时判限；超限即中止并删除半截文件。

    不先整份读进内存——大文件会把进程撑爆；也不在写完之后才判，那样超限的字节已经落盘了。
    """
    written = 0
    try:
        with dest.open("wb") as fh:
            while chunk := await src.read(_UPLOAD_CHUNK):
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"file exceeds max upload size ({max_bytes} bytes)",
                    )
                if budget is not None and written > budget:
                    raise HTTPException(status_code=413, detail="workspace quota exceeded")
                fh.write(chunk)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return written


@router.post("/upload", response_model=WorkspaceUploadResult)
async def upload_files(
    path: str = Query("", description="目标目录；留空则落在第一个已登记的工作区根"),
    files: list[UploadFile] = File(...),
) -> WorkspaceUploadResult:
    from netlivecowork.config import get_settings
    settings = get_settings()

    target = _authorize(path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=400, detail="target is not a directory")
    root = _root_for(target, registered_roots()) or target

    # 配额按**整个工作区根**算，不是按当前子目录——用户建几层目录不该绕开限额。
    budget: int | None = None
    if settings.workspace_quota_bytes > 0:
        used = workspace_store.directory_size(root)
        budget = settings.workspace_quota_bytes - used
        if budget <= 0:
            raise HTTPException(status_code=413, detail="workspace quota exhausted")

    saved: list[WorkspaceEntry] = []
    for f in files:
        try:
            name = workspace_store.safe_upload_name(f.filename or "")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        dest = target / name
        if dest.is_dir():
            raise HTTPException(status_code=409, detail=f"{name} is an existing directory")
        written = await _write_upload(f, dest, settings.workspace_max_upload_bytes, budget)
        if budget is not None:
            budget -= written
        saved.append(_entry_of(dest))

    return WorkspaceUploadResult(root=str(root), path=str(target), uploaded=saved)


@router.get("/download")
def download_folder(path: str = Query("", description="要打包的目录；留空则第一个已登记的根")) -> FileResponse:
    """把一个目录打包成 zip 下载。

    先落临时文件再回传，不在内存里攒——工作区可能很大。响应发完由 BackgroundTask 删掉。

    超过 NLC_WORKSPACE_MAX_DOWNLOAD_BYTES 直接 413：既防打爆磁盘，也防用户等一个永远
    转不完的圈。压缩前按原始大小判，判据对用户是可解释的（压缩后多大事先谁也不知道）。
    """
    from netlivecowork.config import get_settings
    settings = get_settings()

    target = _authorize(path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory")

    limit = settings.workspace_max_download_bytes
    if limit > 0 and workspace_store.directory_size(target) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"folder exceeds the max download size ({limit} bytes)",
        )

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for abs_path, rel in workspace_store.iter_files(target):
                try:
                    zf.write(abs_path, rel)
                except OSError:
                    continue          # 单个文件读不到就跳过，不毁掉整包
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise

    return FileResponse(
        str(tmp_path),
        media_type="application/zip",
        filename=f"{target.name}.zip",
        background=BackgroundTask(tmp_path.unlink, missing_ok=True),
    )


@router.delete("/file")
def delete_file(path: str = Query(...)) -> dict:
    """删除工作区内的单个文件。目录走 DELETE /workspace/dir（递归，判据更严）。"""
    target = _authorize(path)
    if target in registered_roots():
        raise HTTPException(status_code=400, detail="refusing to delete a workspace root")
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if target.is_dir():
        raise HTTPException(status_code=400, detail="is a directory; use DELETE /workspace/dir")
    try:
        target.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"cannot delete: {e}") from e
    return {"path": str(target), "deleted": True}


def _sessions_using(target: Path) -> list[str]:
    """哪些**还在跑**的会话的工作区落在 target 之内。

    只拦活跃会话，已结束的不拦：历史会话的工作目录被删掉，最坏是回看时文件没了；
    正在跑的被删掉，是 agent 当场失败且现场已经不存在。
    """
    active = {"RUNNING", "QUEUED", "PAUSED_HITL", "WAITING_INPUT"}
    out: list[str] = []
    for sid, e in _sm._sessions.items():
        if getattr(e, "status", None) not in active:
            continue
        ws = getattr(e, "workspace", None)
        if not ws:
            continue
        try:
            if workspace_store.is_within(Path(ws).resolve(), target):
                out.append(sid)
        except OSError:
            continue
    return out


@router.delete("/dir")
def delete_dir(path: str = Query(...)) -> dict:
    """递归删除工作区内的一个目录。

    三道闸：必须落在已登记根内（_authorize）、不能是根自身、不能有活跃会话正用着它。
    """
    target = _authorize(path)
    if target in registered_roots():
        raise HTTPException(status_code=400, detail="refusing to delete a workspace root")
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="not a directory; use DELETE /workspace/file")

    busy = _sessions_using(target)
    if busy:
        raise HTTPException(
            status_code=409,
            detail=f"still in use by running session(s): {', '.join(busy[:3])}",
        )
    try:
        shutil.rmtree(target)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"cannot delete: {e}") from e
    return {"path": str(target), "deleted": True}


@router.post("/draft-root")
def register_draft_root(req: DraftRootRequest) -> dict:
    """登记草稿工作区根（新建会话选完目录、session 创建前供面板浏览）。

    与 POST /sessions 的 workspace 登记同级信任：路径必须是本机存在的绝对目录。
    """
    global _draft_root
    p = Path(req.path)
    if not p.is_absolute():
        raise HTTPException(status_code=400, detail="draft root must be an absolute path")
    try:
        resolved = p.resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"bad path: {e}") from e
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=400, detail="draft root must be an existing directory")
    _draft_root = resolved
    return {"path": str(resolved)}


@router.delete("/draft-root")
def clear_draft_root() -> dict:
    """清除草稿根（会话已创建或草稿被取消时调用）。幂等。"""
    global _draft_root
    _draft_root = None
    return {"cleared": True}
