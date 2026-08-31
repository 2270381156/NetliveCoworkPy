"""cowork 清单接口 —— "这台机器上现在能用哪几个"。

**薄，只转发**（架构设计 §3.1）：判断在 cowork 那一层，这里只把结果翻成 DTO。

⚠ 它是**界面阵容的唯一真值源**。构建期那份 branding 里的全量清单不再参与——
那是打包时固定的，装几个都显示七个。
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["coworks"])


class CoworkResponse(BaseModel):
    """给界面的一条。**字段名与前端 CoworkDTO 一一对应，改动要两边一起改。**"""

    id: str
    display_name: str
    subtitle: str
    accent: str
    order: int
    #: 取 logo 的地址；**没有 logo 就是 None**，界面据此回落首字母。
    #:
    #: 给的是**地址不是图片本体**：`/coworks` 每次列阵容都会被调，把几十 KB 的 base64
    #: 塞进来，每次都要传一遍、解析一遍。图片交给浏览器按 URL 缓存更合适。
    logo_url: str | None = None


@router.get("/coworks", response_model=list[CoworkResponse])
def list_coworks() -> list[CoworkResponse]:
    """已装的 cowork，按展示次序。

    **空数组有三种原因**（还没对账 / 对账了但没开通 / 这个构建就没有这一层），
    数据上长得一模一样，但该让用户做的事完全相反 —— 所以界面必须自己分辨，
    见前端 `lineup.ts`。这里不替它决定：**接口只回答"现在装了哪几个"**。

    ⚠ 不抛：拿不到就返回空，界面会显示空态而不是崩掉。
    """
    try:
        from netlivecowork import paths
        from netlivecowork.cowork import installed

        root = paths.coworks_dir()
        return [
            CoworkResponse(
                id=c.id,
                display_name=c.display_name,
                subtitle=c.subtitle,
                accent=c.accent,
                order=c.order,
                logo_url=(f"/api/v1/coworks/{c.id}/logo" if _logo_path(root, c) else None),
            )
            for c in installed.list_all(root)
        ]
    except Exception:
        logger.warning("cowork：列清单失败，返回空", exc_info=True)
        return []


#: 允许作为 logo 提供的类型。**白名单，不是黑名单** —— 套件是下发来的，
#: 让它决定回什么 Content-Type 等于让它在这个源上执行任意脚本。
_LOGO_TYPES = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
}

#: logo 大小上限。装一张"不知道多大"的图，内存和界面都可能被一个坏包拖垮。
_LOGO_MAX_BYTES = 512 * 1024


def _logo_path(coworks_dir, cowork):
    """这个 cowork 的 logo 文件；没有就 None。

    清单写了 `branding.logo` 就用它，否则按约定找 `logo.svg|png|webp`。
    **两条都要挡住路径穿越**：文件名来自下发的清单，`resolve()` 之后必须仍在套件目录内
    —— 只比字符串的话 `a/../../b` 这种能混过去。
    """
    from netlivecowork.cowork.manifest_parse import LOGO_CANDIDATES

    base = (Path(coworks_dir) / cowork.id).resolve()
    names = [cowork.logo_file] if cowork.logo_file else list(LOGO_CANDIDATES)
    for name in names:
        if not name or Path(name).suffix.lower() not in _LOGO_TYPES:
            continue
        try:
            p = (base / name).resolve()
        except OSError:
            continue
        if p.is_file() and (p == base or base in p.parents):
            return p
    return None


@router.get("/coworks/{cowork_id}/logo")
def get_cowork_logo(cowork_id: str) -> FileResponse:
    """套件自带的 logo。**没有就 404** —— 界面拿不到会回落首字母，那是正常路径不是故障。

    ⚠ 只按 id 找**已装**的那个套件，不接受任意路径：`cowork_id` 同样来自外部。
    """
    from netlivecowork import paths
    from netlivecowork.cowork import installed

    root = paths.coworks_dir()
    cowork = installed.get(root, cowork_id)
    if cowork is None:
        raise HTTPException(status_code=404, detail="没有这个 cowork")
    p = _logo_path(root, cowork)
    if p is None:
        raise HTTPException(status_code=404, detail="这个 cowork 没有 logo")
    if p.stat().st_size > _LOGO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="logo 太大")
    return FileResponse(str(p), media_type=_LOGO_TYPES[p.suffix.lower()])


class RecheckResponse(BaseModel):
    installed: dict[str, str]
    skipped: dict[str, str]
    removed: list[str]
    failed: dict[str, str]


@router.post("/coworks/recheck", response_model=RecheckResponse)
def recheck_coworks() -> RecheckResponse:
    """立刻对一次账。

    **给客户端主进程调**：它取完包摆进暂存目录之后调这里，让后端装下去。
    **光问不装等于白问** —— 装只在启动时发生，不调这里的话新下发的要等下次重启。

    对账之后**必须重读**：不重读的话能力判断停在旧快照上，
    表现是"装上了但用不了"（需求 F5）。
    """
    from netlivecowork import paths
    from netlivecowork.cowork import runtime as cowork_runtime
    from netlivecowork.cowork.reconcile import reconcile

    result = reconcile(paths.cowork_staging_dir(), paths.coworks_dir())
    cowork_runtime.reload()
    # 阵容/归属/市场路由由 reload 重建；**账号得单独来一次** —— 它只在开机那条路上登记，
    # 不重建的话收回之后那个账号还挂着，且带着可用的凭据（需求 F5）。
    from netlivecowork.bootstrap.host_runtime import rebuild_cowork_llm_accounts

    rebuild_cowork_llm_accounts()
    return RecheckResponse(
        installed=result.installed,
        skipped=result.skipped,
        removed=list(result.removed),
        failed=result.failed,
    )
