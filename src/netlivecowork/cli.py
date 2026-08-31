"""netlivecowork CLI entry point.

Usage:
  netlivecowork serve [--port 8000] [--host 0.0.0.0]
  netlivecowork run --template <id> --prompt <text>

LLM default accounts (bundled flat JSON seed, evaluated at startup):
  packaging/default_data/default_llm_accounts.json   出厂/随包默认账号（可多账号/多 provider）
    每项字段：account / style / api_key(明文或 enc:v1:) / base_url / model /
              context_limit / output_reserve / output_ceiling / timeout_sec
  NLC_LLM_ACCOUNTS_FILE   dev 覆盖：指向本地 gitignored 种子文件（不设 → 用随包模板）
  （不再用 NLC_LLM_ACCOUNT/STYLE/API_KEY/... 环境变量；账号由 bootstrap_from_seed 读 JSON）

Persistence (DATABASE_URL env var or --db-url flag):
  not set                              → in-memory (default)
  sqlite  (or sqlite:///path/to.db)    → SQLite via aiosqlite (dev)
  postgresql+asyncpg://user:pw@host/db → Postgres (prod)

Snapshots (crash-recovery acceleration; only with a DB backend):
  NLC_SNAPSHOT_EVERY_N_EVENTS  写快照前累计的事件数（RunFinished 边界），默认 50
  NLC_SNAPSHOT_KEEP            每个 session 保留的最新快照张数，默认 3
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from netlivecowork.bootstrap import build_host_runtime, db_url_from
from netlivecowork.bootstrap import lifecycle
from netlivecowork.providers.templates import canonical_template_id

logger = logging.getLogger(__name__)

def cmd_migrate(args):
    """Apply pending one-time DB data migrations (or --dry-run to only report counts)."""
    from netlivecowork.config import get_settings
    raw = getattr(args, "db_url", None) or get_settings().database_url
    if not raw:
        print("No DB configured (DATABASE_URL unset / no --db-url) — nothing to migrate.")
        return

    async def _run():
        from netlivecowork.persistence.postgres import init_db
        from netlivecowork.persistence.postgres.migrations import run_pending
        factory = await init_db(db_url_from(args))
        results = await run_pending(factory, dry_run=args.dry_run)
        if not results:
            print("No pending migrations.")
            return
        tag = "would affect" if args.dry_run else "applied"
        for mid, n in results.items():
            print(f"  {mid}: {tag} {n} row(s)")

    asyncio.run(_run())


def cmd_serve(args):
    """Start the HTTP/SSE server."""
    import uvicorn
    from netlivecowork.api.main import create_app

    hr = build_host_runtime(args)
    app = create_app(hr, lifespan=lifecycle.make_lifespan(hr))
    if getattr(sys, "frozen", False):
        # 前端产物挂 '/'，**必须在所有 API 路由注册之后**，否则后面的路由全被遮掉。
        from netlivecowork.api.spa import mount_spa
        mount_spa(app)
        print(f"[NetLIVE Cowork] starting on http://{args.host}:{args.port}", flush=True)
    # log_config=None: keep our root logging (set up in main()) instead of letting
    # uvicorn install its own isolated handlers, so core/host logs share one sink.
    uvicorn.run(app, host=args.host, port=args.port, log_config=None)


def cmd_run(args):
    """Run a single task from CLI."""
    hr = build_host_runtime(args)
    runtime = hr.core

    async def _run():
        # LLM / DB / 模板与 serve 共用同一套：单次任务不装目录监视、不做会话恢复。
        handles = await lifecycle.start_oneshot(hr)
        try:
            await _run_task()
        finally:
            await lifecycle.stop(handles)

    async def _run_task():
        # 工作目录（绝对路径）：执行前登记给 fs provider，由其按 session 管理
        session_id = None
        workspace = getattr(args, "workspace", None)
        if workspace:
            from ctx_weft.core.utils import generate_id
            from ctx_weft.providers.capability_filesystem import FilesystemToolsProvider
            session_id = generate_id("ses")
            fs = next(
                (p for p in runtime.providers.get_capability_providers()
                 if isinstance(p, FilesystemToolsProvider)),
                None,
            )
            if fs is None:
                raise SystemExit("No filesystem provider available to register --workspace")
            fs.register_session(session_id, workspace)  # 非绝对路径 → ValueError

        handle, state = await runtime.run_single_task(
            session_id=session_id,
            template_id=canonical_template_id(args.template),
            user_prompt=args.prompt,
        )
        print("\n=== Result ===")
        if state.verdict:
            print(f"Outcome: {state.verdict.task_outcome}")
            print(f"Summary: {state.verdict.summary}")
        elif state.transcript:
            last = state.transcript[-1]
            print(f"Response: {last.assistant_text}")

    asyncio.run(_run())


def _argv_with_frozen_default(argv: list[str]) -> list[str]:
    """冻结态没有命令行参数（Electron 直接 spawn exe），默认当成 `serve` 跑。

    端口取 NLC_BACKEND_PORT（Electron 注入，默认 15926）。dev 下原样返回，
    不给 `ipmc` 裸命令加隐含行为——那边该打印帮助。
    """
    import os
    if argv or not getattr(sys, "frozen", False):
        return argv
    return ["serve", "--host", "0.0.0.0", "--port", os.environ.get("NLC_BACKEND_PORT", "15926")]


def main():
    # Office broker 子进程入口。放在最前面、走独立分支：它由 manager.py 用【本 exe】拉起
    # （冻结态没法 `python -m`），是个纯粹的 COM 代理进程，不该去连数据库、起 runtime。
    if "--office-broker" in sys.argv[1:]:
        from netlivecowork.observability.logging import configure_logging
        configure_logging()
        from netlivecowork.office_broker.server import main as _broker_main
        return _broker_main([a for a in sys.argv[1:] if a != "--office-broker"])

    # 冻结态的进程级预置（修 std 流、NLC_* 路径绝对化、共享 venv）；dev 下只加载 .env。
    # 必须早于 configure_logging：日志目录来自这里解析出来的 NLC_LOG_DIR。
    from netlivecowork.bootstrap import frozen
    frozen.prepare()

    # Configure root logging first so ctx_weft.* and netlivecowork.* logs are
    # captured from this point on (env-driven: NLC_LOG_LEVEL/FORMAT/FILE).
    from netlivecowork.observability.logging import configure_logging
    configure_logging()

    parser = argparse.ArgumentParser(prog="netlivecowork")
    subparsers = parser.add_subparsers(dest="command")

    # serve
    serve_parser = subparsers.add_parser("serve", help="Start HTTP/SSE server")
    serve_parser.add_argument("--host", default="0.0.0.0")
    serve_parser.add_argument("--port", type=int, default=8000)
    serve_parser.add_argument("--agents-dir", default=None, help="Agent templates directory (overrides NLC_AGENTS_DIR)")
    serve_parser.add_argument("--no-tools", action="store_false", dest="enable_tools")
    serve_parser.add_argument("--skills-dir", default=None, help="Local skills directory (overrides NLC_SKILLS_DIR)")
    serve_parser.add_argument("--db-url", default=None, help="DB URL (overrides DATABASE_URL env var)")

    # run
    run_parser = subparsers.add_parser("run", help="Run a single task")
    run_parser.add_argument("--template", required=True)
    run_parser.add_argument("--prompt", required=True)
    run_parser.add_argument("--workspace", default=None, help="Agent working directory (absolute path)")
    run_parser.add_argument("--db-url", default=None, help="DB URL (overrides DATABASE_URL env var)")

    # migrate
    migrate_parser = subparsers.add_parser("migrate", help="Apply pending one-time DB data migrations")
    migrate_parser.add_argument("--db-url", default=None, help="DB URL (overrides DATABASE_URL env var)")
    migrate_parser.add_argument("--dry-run", action="store_true", help="Report affected rows without writing")

    args = parser.parse_args(_argv_with_frozen_default(sys.argv[1:]))
    if args.command == "serve":
        cmd_serve(args)
    elif args.command == "run":
        cmd_run(args)
    elif args.command == "migrate":
        cmd_migrate(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
