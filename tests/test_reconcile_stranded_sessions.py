"""启动期 reconcile：投影 `RUNNING` 但事件日志非 active（终态）= 卡死幽灵行，
校正为最后一条 SessionFinished 的 final_status。

背景：投影是可能失真的派生视图——ProjectionUpdater/EventPersister 各自独立事务且都吞异常，
一次 SessionFinished 的投影写若因瞬时故障失败，事件已终态、投影却停在 RUNNING，会话永久卡住。
事件日志是真相，故每次启动据事件对账、幂等自愈（不止一次性清历史残留）。
"""

from __future__ import annotations

from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.event_store import PostgresEventStore
from netlivecowork.persistence.postgres.models import SessionModel
from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater
from netlivecowork.persistence.postgres.reconcile import reconcile_stranded_running_sessions
from netlivecowork.persistence.postgres.state_store import PostgresStateStore

_TS = datetime(2026, 7, 12, tzinfo=timezone.utc)


def _ev(seq: int, type_: str, sid: str = "s1", **payload) -> Event:
    # id 单调（ULID 序）——list_active_session_ids / 取末条 SessionFinished 都比 max(id)。
    return Event(id=f"evt_{sid}_{seq:04d}", run_id="run_1", sequence=seq, session_id=sid,
                 type=type_, timestamp=_TS, payload=payload)


async def _status(factory, sid: str) -> str | None:
    async with factory() as db:
        row = await db.get(SessionModel, sid)
        return row.status if row else None


async def test_reconcile_resets_stranded_running_to_finished_status(tmp_path) -> None:
    """投影 RUNNING、事件日志停在 SessionFinished(SUCCEEDED) → 校正为 SUCCEEDED。"""
    factory = await init_db(f"sqlite:///{(tmp_path / 'stranded.db').as_posix()}")
    events = PostgresEventStore(factory)
    state = PostgresStateStore(factory)
    proj = ProjectionUpdater(factory)

    # 事件真相：本轮已成功收尾。
    await events.append(_ev(1, "SessionCreated"))
    await events.append(_ev(2, "SessionFinished", final_status="SUCCEEDED"))

    # 投影建行后停在 RUNNING（模拟 SessionFinished 的投影写被吞/丢 → 幽灵 RUNNING）。
    await proj.on_event(_ev(1, EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    assert await _status(factory, "s1") == "RUNNING"

    n = await reconcile_stranded_running_sessions(state, events)

    assert n == 1
    assert await _status(factory, "s1") == "SUCCEEDED"


async def test_reconcile_leaves_genuinely_active_session_untouched(tmp_path) -> None:
    """事件日志确为 active（SessionResumed 晚于 SessionFinished，崩溃时真在跑）的会话，
    reconcile 绝不能动——它归 runtime.recover() 处理（转 INTERRUPTED）。"""
    factory = await init_db(f"sqlite:///{(tmp_path / 'active.db').as_posix()}")
    events = PostgresEventStore(factory)
    state = PostgresStateStore(factory)
    proj = ProjectionUpdater(factory)

    await events.append(_ev(1, "SessionCreated", sid="s2"))
    await events.append(_ev(2, "SessionFinished", sid="s2", final_status="SUCCEEDED"))
    await events.append(_ev(3, "SessionResumed", sid="s2"))   # 新一轮开启、仍在跑

    await proj.on_event(_ev(1, EventType.SESSION_CREATED, sid="s2", template_id="tpl", root_agent_id="agt"))
    assert await _status(factory, "s2") == "RUNNING"

    n = await reconcile_stranded_running_sessions(state, events)

    assert n == 0
    assert await _status(factory, "s2") == "RUNNING"
