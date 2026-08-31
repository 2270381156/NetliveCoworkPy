"""前端构建产物挂成 SPA。只有冻结态用得上（dev 的前端跑在 vite 里）。

由 cli.cmd_serve 在**所有 API 路由注册之后**调用：先挂 '/' 会把后面注册的路由全遮掉。
"""

from __future__ import annotations

import mimetypes
import os
import sys
from pathlib import Path

# 显式覆盖 JS/CSS 的 MIME 映射，优先于 Windows 注册表（HKCR\.js）。
# Starlette StaticFiles 经 Python mimetypes.guess_type 推断 Content-Type，
# 而 mimetypes 在 Windows 上会读注册表；部分机器的 .js / .mjs 被改成
# text/plain → Vite 产物的 <script type="module"> 被 Chromium 以非 JS MIME
# 拒绝加载 → 渲染端白屏。add_type 在 init()（含注册表读取）之后生效，故覆盖之；
# 注册表正常的机器也无副作用（幂等）。须在挂载 SPA 之前执行（模块导入即运行）。
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")


def _frontend_dist() -> str:
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, "frontend_dist")  # type: ignore[attr-defined]
    # parents[3]：api → netlivecowork → src → 仓库根
    return os.path.join(Path(__file__).parents[3], "frontend-desktop", "dist")


def mount_spa(app) -> None:
    """把前端构建产物挂到 '/'（须在所有 API 路由注册之后）。"""
    dist = _frontend_dist()
    if not os.path.isdir(dist):
        print(f"[NetLIVE Cowork] frontend dist not found: {dist} (API-only)", flush=True)
        return

    from starlette.exceptions import HTTPException as StarletteHTTPException
    from starlette.staticfiles import StaticFiles

    class _SPAFiles(StaticFiles):
        """BrowserRouter SPA：客户端路由(无扩展名)404 回退 index.html；
        index.html 一律 no-store（否则升级后旧 index.html 仍指向已不存在的 chunk hash）。"""

        @staticmethod
        def _looks_like_file(path: str) -> bool:
            """末段含 '.' 视为静态资源请求（app.js / styles.css / *.map …），
            否则视为客户端路由。"""
            return "." in path.rsplit("/", 1)[-1]

        async def get_response(self, path: str, scope):
            is_index = path in ("", "index.html")
            try:
                resp = await super().get_response(path, scope)
            except StarletteHTTPException as exc:
                # 仅对客户端路由回退 index.html。缺失的资源（如升级后旧 hash 的
                # /assets/*.js）必须返回真 404；若回退成 index.html，会以 text/html
                # 下发，被 Chromium 当作非法 module 拒绝 → 白屏（与注册表 MIME bug 同症状）。
                if exc.status_code == 404 and not self._looks_like_file(path):
                    resp = await super().get_response("index.html", scope)
                    resp.headers["Cache-Control"] = "no-store"
                    return resp
                raise
            if is_index:
                resp.headers["Cache-Control"] = "no-store"
            return resp

    app.mount("/", _SPAFiles(directory=dist, html=True), name="frontend")
