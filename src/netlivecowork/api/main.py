"""netlivecowork FastAPI application."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from netlivecowork.api import deps

logger = logging.getLogger(__name__)


def create_app(hr: Any, *, lifespan: Any, cors_origins: list[str] | None = None) -> FastAPI:
    """把装好的 HostRuntime 接到 HTTP 面上：注入 deps、挂路由、挂外面给的 lifespan。

    api 层不参与装配，也不决定启动顺序——它拿到的是成品。装配在 bootstrap.host_runtime，
    需要事件循环的启动步骤在 bootstrap.lifecycle。
    """
    deps.set_runtime(hr.core)
    deps.set_agent_template_provider(hr.agent_template_provider)
    deps.set_template_store(hr.template_syncer.store)
    deps.set_template_syncer(hr.template_syncer)
    if hr.core.hitl_manager is not None:
        deps.set_hitl_manager(hr.core.hitl_manager)

    app = FastAPI(
        title="CtxWeft Agent Runtime",
        version="0.4.0",
        description="Protocol-based agent runtime with Knowledge/Memory/Capability providers",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins or ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    from netlivecowork.api.sessions import router as sessions_router
    from netlivecowork.api.hitl import router as hitl_router
    from netlivecowork.api.templates import router as templates_router
    from netlivecowork.api.llms import router as llms_router
    from netlivecowork.api.mcp import router as mcp_router
    from netlivecowork.api.workspace import router as workspace_router
    from netlivecowork.api.rewind import router as rewind_router
    from netlivecowork.api.skills import router as skills_router
    from netlivecowork.api.coworks import router as coworks_router
    from netlivecowork.api.spool import router as spool_router
    from netlivecowork.api.w3_auth import router as w3_auth_router

    app.include_router(sessions_router, prefix="/api/v1")
    app.include_router(hitl_router, prefix="/api/v1")
    app.include_router(llms_router, prefix="/api/v1")
    app.include_router(mcp_router, prefix="/api/v1")
    app.include_router(workspace_router, prefix="/api/v1")
    app.include_router(rewind_router, prefix="/api/v1")
    app.include_router(skills_router, prefix="/api/v1")
    app.include_router(coworks_router, prefix="/api/v1")
    app.include_router(templates_router, prefix="/api/v1/agent-templates")
    app.include_router(templates_router, prefix="/api/v1/templates")
    app.include_router(spool_router)
    app.include_router(w3_auth_router)

    @app.get("/health")
    async def health():
        # app_id 供客户端判断"这个端口上的后端是不是我自己的"。端口可能被同族的
        # 另一个品牌占着，只看 200 会把别人的后端当自己的复用 —— 后端把前端挂在 /，
        # 复用之后整个界面和数据都是对方的，而且不报错。
        import os

        return {
            "status": "ok",
            "runtime": deps._runtime is not None,
            "app_id": os.getenv("NLC_APP_ID", ""),
        }

    return app