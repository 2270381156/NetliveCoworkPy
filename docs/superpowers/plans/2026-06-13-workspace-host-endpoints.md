# Workspace 浏览端点 (host 侧) + create-session workspace 字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 host 侧补三个只读 `/workspace` 端点并打通 create-session 的 workspace 字段，让 `frontend-desktop` 的 WorkspacePanel + 文件预览可用。

**Architecture:** host 直接读文件系统（不动 fs provider）。新 `api/workspace.py` 路由提供 `files`/`file`/`file/raw` 三端点，路径校验约束在内存 `_sessions` 各 entry 的 workspace 根之内。`SessionEntry` 增 `workspace` 字段并在 `to_dict()` 回传，create/restore 时填入。前端把 API 边界字段 `working_dir` 改名为 `workspace`。

**Tech Stack:** FastAPI / Starlette `FileResponse`、pydantic、pytest + pytest-asyncio（直接调用路由函数测试，参照 `tests/test_hitl_rest_cold_resume.py`）；前端 React + TypeScript + vitest。

设计来源：`docs/superpowers/specs/2026-06-13-workspace-host-endpoints-design.md`

---

### Task 1: 后端 workspace 端点（schema + router + 单测）

**Files:**
- Create: `src/loomex_host/api/schemas/workspace.py`
- Create: `src/loomex_host/api/workspace.py`
- Test: `tests/test_workspace_endpoints.py`

- [ ] **Step 1: 写 schema**

Create `src/loomex_host/api/schemas/workspace.py`:

```python
from __future__ import annotations

from pydantic import BaseModel


class WorkspaceEntry(BaseModel):
    name: str
    path: str          # 绝对路径——前端导航时直接当下一次的 path
    is_dir: bool
    size: int | None = None  # 目录为 None


class WorkspaceListing(BaseModel):
    root: str
    path: str
    parent: str
    entries: list[WorkspaceEntry]
```

- [ ] **Step 2: 写 router（先于测试存在，便于 import）**

Create `src/loomex_host/api/workspace.py`:

```python
"""只读 workspace 浏览端点（桌面前端用）。

host 直接读文件系统：filesystem capability provider 只管 agent 执行期的 per-session
workspace 生命周期，不参与 host 侧浏览。路径为绝对路径（前端按绝对 entry.path 导航），
并约束在所有已登记 workspace 根之内，防越权读任意磁盘文件。
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from loomex_host.api.models import session as _sm
from loomex_host.api.schemas.workspace import WorkspaceEntry, WorkspaceListing

router = APIRouter(prefix="/workspace", tags=["workspace"])


def registered_roots() -> list[Path]:
    """所有内存 session 的 workspace 根（绝对、已 resolve）。"""
    roots: list[Path] = []
    for e in _sm._sessions.values():
        ws = getattr(e, "workspace", None)
        if ws:
            try:
                roots.append(Path(ws).resolve())
            except OSError:
                continue
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


@router.get("/file/raw")
def read_file_raw(path: str = Query(...)) -> FileResponse:
    target = _authorize(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(target))
```

- [ ] **Step 3: 写失败测试**

Create `tests/test_workspace_endpoints.py`:

```python
"""host 侧只读 workspace 端点。直接调用路由函数（参照 test_hitl_rest_cold_resume），
用内存 _sessions 注入登记根，覆盖列目录形状 / 文本 / 原始字节 / 越权 403 / 404 / 非 UTF-8 400。"""
from __future__ import annotations

import os

import pytest
from fastapi import HTTPException

from loomex_host.api import workspace as ws_api
from loomex_host.api.models import session as sm


class _Entry:
    def __init__(self, workspace: str) -> None:
        self.workspace = workspace


@pytest.fixture
def ws_root(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "hello.txt").write_text("hi", encoding="utf-8")
    (tmp_path / "sub" / "a.md").write_text("# A", encoding="utf-8")
    return tmp_path


@pytest.fixture
def register(ws_root):
    saved = dict(sm._sessions)
    sm._sessions.clear()
    sm._sessions["s1"] = _Entry(str(ws_root))
    yield ws_root
    sm._sessions.clear()
    sm._sessions.update(saved)


def test_list_files_shape(register):
    listing = ws_api.list_files(path=str(register))
    names = {e.name: e for e in listing.entries}
    assert names["sub"].is_dir is True
    assert names["hello.txt"].is_dir is False
    assert names["hello.txt"].size == 2
    assert listing.entries[0].is_dir is True          # 目录在前
    assert os.path.isabs(listing.entries[0].path)     # entry.path 绝对


def test_read_file_text(register):
    out = ws_api.read_file(path=str(register / "hello.txt"))
    assert out["content"] == "hi"
    assert os.path.isabs(out["path"])


def test_read_file_raw(register):
    resp = ws_api.read_file_raw(path=str(register / "hello.txt"))
    assert os.path.normpath(resp.path) == os.path.normpath(str(register / "hello.txt"))


def test_outside_root_403(register, tmp_path_factory):
    other = tmp_path_factory.mktemp("other")
    (other / "secret.txt").write_text("x", encoding="utf-8")
    with pytest.raises(HTTPException) as ei:
        ws_api.read_file(path=str(other / "secret.txt"))
    assert ei.value.status_code == 403


def test_missing_404(register):
    with pytest.raises(HTTPException) as ei:
        ws_api.read_file(path=str(register / "nope.txt"))
    assert ei.value.status_code == 404


def test_non_utf8_400(register):
    p = register / "bin.dat"
    p.write_bytes(b"\xff\xfe\x00\x01")
    with pytest.raises(HTTPException) as ei:
        ws_api.read_file(path=str(p))
    assert ei.value.status_code == 400
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `python -m pytest tests/test_workspace_endpoints.py -v`
Expected: 6 passed。
（若 `resp.path` 报属性错，starlette 版本可能用 `resp.path`——确认无误；本仓 fastapi 0.136 的 FileResponse 暴露 `.path`。）

- [ ] **Step 5: 提交**

```bash
git add src/loomex_host/api/schemas/workspace.py src/loomex_host/api/workspace.py tests/test_workspace_endpoints.py
git commit -m "feat(api): host-side read-only /workspace browse endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 把 workspace router 挂到 app

**Files:**
- Modify: `src/loomex_host/api/main.py:53-64`

- [ ] **Step 1: 导入并挂载**

在 `main.py` 的 router import 段（约 53-58 行）加：

```python
    from loomex_host.api.workspace import router as workspace_router
```

在 `include_router` 段（约 60-66 行）加（与其它一致用 `/api/v1` 前缀）：

```python
    app.include_router(workspace_router, prefix="/api/v1")
```

- [ ] **Step 2: 冒烟校验路由已注册**

Run:
```bash
python -c "from loomex_host.api.workspace import router; print([r.path for r in router.routes])"
```
Expected: `['/workspace/files', '/workspace/file', '/workspace/file/raw']`

- [ ] **Step 3: 跑全量后端测试确认无回归**

Run: `python -m pytest tests/ -q`
Expected: 全绿（含 Task 1 的 6 个新测试）。

- [ ] **Step 4: 提交**

```bash
git add src/loomex_host/api/main.py
git commit -m "feat(api): mount /workspace router under /api/v1

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: SessionEntry.workspace 字段 + to_dict + create/restore 填入

**Files:**
- Modify: `src/loomex_host/api/models/session.py`（`SessionEntry.__init__`、`to_dict`、`load_sessions_from_db`）
- Modify: `src/loomex_host/api/sessions.py`（`create_session` 设 `entry.workspace`）
- Test: `tests/test_session_workspace_field.py`

- [ ] **Step 1: 写失败测试**

Create `tests/test_session_workspace_field.py`:

```python
"""SessionEntry.to_dict() 必须回传 workspace（前端 session.workspace 据此渲染工作区根）。"""
from __future__ import annotations

from loomex_host.api.models.session import SessionEntry


def _entry() -> SessionEntry:
    return SessionEntry(
        session_id="s1",
        template_id="tpl",
        user_prompt="hi",
        tenant_id="default",
        llm_model="m",
        llm_account="acc",
    )


def test_to_dict_includes_workspace_default_none():
    d = _entry().to_dict()
    assert "workspace" in d
    assert d["workspace"] is None


def test_to_dict_reflects_set_workspace():
    e = _entry()
    e.workspace = "C:/ws/demo"
    assert e.to_dict()["workspace"] == "C:/ws/demo"
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `python -m pytest tests/test_session_workspace_field.py -v`
Expected: FAIL —— `assert "workspace" in d` 失败（to_dict 暂无该键）。

- [ ] **Step 3: 给 SessionEntry 加字段**

在 `src/loomex_host/api/models/session.py` 的 `SessionEntry.__init__` 末尾（`self._consumer_token: int = 0` 之后）加：

```python
        self.workspace: str | None = None
```

- [ ] **Step 4: to_dict 回传 workspace**

在 `to_dict()` 返回的 dict 里，`"llm_model": self.llm_model,` 之后加一行：

```python
            "workspace": self.workspace,
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `python -m pytest tests/test_session_workspace_field.py -v`
Expected: 2 passed。

- [ ] **Step 6: create_session 填入 workspace**

在 `src/loomex_host/api/sessions.py` 的 `create_session` 内，构造 `entry` 之后、加入 `_sessions` 之前（约 227-228 行 `entry.root_agent_id = handle.agent_id` 附近）加：

```python
    entry.workspace = req.workspace
```

- [ ] **Step 7: restore 时灌回 workspace**

在 `src/loomex_host/api/models/session.py` 的 `load_sessions_from_db` 内，`entry.failure_counter = sess.failure_counter` 之后加：

```python
        entry.workspace = sess.workspace
```

- [ ] **Step 8: 跑全量后端测试确认无回归**

Run: `python -m pytest tests/ -q`
Expected: 全绿。

- [ ] **Step 9: 提交**

```bash
git add src/loomex_host/api/models/session.py src/loomex_host/api/sessions.py tests/test_session_workspace_field.py
git commit -m "feat(api): carry session workspace through to_dict + create/restore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 前端把 API 边界字段 working_dir → workspace

**Files:**
- Modify: `frontend-desktop/src/types/index.ts`（`Session.working_dir`、`CreateSessionRequest.working_dir`）
- Modify: `frontend-desktop/src/components/ChatPanel.tsx:129`
- Modify: `frontend-desktop/src/App.tsx:79`
- Modify: `frontend-desktop/src/hooks/useProjectGroups.ts`（从 Session 读字段处）

说明：仅改 **API 边界字段**（请求/响应里与后端对接的名）。内部 camelCase 名 `PendingSession.workingDir`、`WorkspacePanel` 的 `workingDir` prop、`Project.working_dir`（前端派生类型）、NewSessionDialog 状态**保持不变**。

- [ ] **Step 1: 改类型**

`frontend-desktop/src/types/index.ts`：
- 第 21 行 `Session` 接口里 `working_dir: string` → `workspace: string`
- 第 32 行 `CreateSessionRequest` 里 `working_dir?: string | null` → `workspace?: string | null`

- [ ] **Step 2: 改 create 调用发 workspace**

`frontend-desktop/src/components/ChatPanel.tsx` 第 129 行：

```tsx
        workspace: pendingSession?.workingDir || null,
```
（把原 `working_dir:` 改为 `workspace:`；右侧仍读内部 `pendingSession.workingDir`。）

- [ ] **Step 3: 改 App.tsx 读响应字段**

`frontend-desktop/src/App.tsx` 第 79 行：

```tsx
    : sse.session?.workspace ?? ''
```
（`working_dir` → `workspace`。）

- [ ] **Step 4: 改 useProjectGroups 从 Session 读字段**

`frontend-desktop/src/hooks/useProjectGroups.ts`：把**从 session 对象读** `s.working_dir` 的地方（约第 59 行 `const id = s.working_dir || NO_PROJECT_ID` 与第 74 行附近赋值给 `wd` 的源）改为 `s.workspace`。

注意：`Project.working_dir`（该 hook **输出**的派生类型字段）保留原名不改——它不是 API 契约，SessionList 等消费方继续用 `project.working_dir`。只改“从 `Session` 实例读取”的那一处源字段。

- [ ] **Step 5: 类型检查无遗漏引用**

Run: `cd frontend-desktop && npx tsc -b`
Expected: 无错误。若报 `Property 'working_dir' does not exist on type 'Session'`，说明还有从 Session 读旧名的地方，按提示改成 `workspace`。

- [ ] **Step 6: 跑前端测试确认无回归**

Run: `cd frontend-desktop && npx vitest run`
Expected: 全绿（preview 等既有测试不受字段改名影响）。

- [ ] **Step 7: 提交**

```bash
git add frontend-desktop/src/types/index.ts frontend-desktop/src/components/ChatPanel.tsx frontend-desktop/src/App.tsx frontend-desktop/src/hooks/useProjectGroups.ts
git commit -m "feat(desktop): align session workspace field with backend (working_dir -> workspace)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 验收（实现完成后手动确认）

- `python -m pytest tests/ -q` 全绿；`cd frontend-desktop && npx tsc -b && npx vitest run` 全绿。
- 创建带工作目录的 session 后，`GET /api/v1/sessions/{id}` 响应含正确 `workspace`。
- WorkspacePanel 能列根目录、进子目录、回父级；文本/代码/markdown 与 pdf/docx/xlsx/pptx/图片均能预览。
- 传入工作目录之外的 path → 403。

## 不在本计划范围

`llm_provider`/`llm_account` 错位、`/llms/ping`、`/llms/available-models`、skills（`/skills` vs `/skill-sources`）、`/sessions/{id}/input`、`/cancel`、SSE 小遗漏——见 spec「不在本次范围」。
