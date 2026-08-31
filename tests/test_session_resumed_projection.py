"""SESSION_RESUMED → 持久 session 状态投影翻回 RUNNING（方案 A）。

回归背景：`/messages` 开新一轮曾在 core emit SessionResumed 之前、由 host 带外手写投影
`RUNNING`。若用户恰在「投影已 RUNNING」但「SessionResumed 尚未落库」的窗口关程序，事件日志
仍呈上一轮终态（list_active_session_ids 判定 NOT active）→ recover() 看不见它 → 投影永久
滞留 RUNNING、无法 /resume 也无法开新轮。修复：投影 RUNNING 改由 SessionResumed 事件驱动
（与 SessionCreated 对称），host 不再带外手写，缝隙消除。
"""

from __future__ import annotations

from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import SessionModel
from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater

_TS = datetime(2026, 7, 10, tzinfo=timezone.utc)


def _ev(type_: str, **payload) -> Event:
    return Event(id=f"evt_{type_}", run_id="r1", sequence=1, session_id="ses_1",
                 type=type_, timestamp=_TS, payload=payload)


async def _status(factory) -> str | None:
    async with factory() as db:
        row = await db.get(SessionModel, "ses_1")
        return row.status if row else None


async def test_session_resumed_projects_running_after_finished(tmp_path) -> None:
    """上一轮结束（SUCCEEDED）后，SessionResumed 须把投影翻回 RUNNING——
    使投影与事件日志由同一事件同步流转，不再有带外写入的缝隙。"""
    factory = await init_db(f"sqlite:///{(tmp_path / 'resumed.db').as_posix()}")
    proj = ProjectionUpdater(factory)

    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_ev(EventType.SESSION_FINISHED, final_status="SUCCEEDED"))
    assert await _status(factory) == "SUCCEEDED"

    await proj.on_event(_ev(EventType.SESSION_RESUMED, root_agent_id="agt"))
    assert await _status(factory) == "RUNNING"
