"""HITL → 持久 session 状态投影：PAUSED_HITL ↔ RUNNING（spec/07 §9.1）。"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import SessionModel
from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater
from netlivecowork.persistence.postgres.state_store import PostgresStateStore

_TS = datetime(2026, 6, 12, tzinfo=timezone.utc)


def _ev(type_: str, **payload) -> Event:
    return Event(id=f"evt_{type_}", run_id="r1", sequence=1, session_id="ses_1",
                 type=type_, timestamp=_TS, payload=payload)


async def _status(factory) -> str | None:
    async with factory() as db:
        row = await db.get(SessionModel, "ses_1")
        return row.status if row else None


async def test_session_paused_hitl_then_resume(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 't.db').as_posix()}")
    proj = ProjectionUpdater(factory)

    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    assert await _status(factory) == "RUNNING"

    await proj.on_event(_ev(EventType.SESSION_PAUSED_HITL))
    assert await _status(factory) == "PAUSED_HITL"

    # state store read-back
    store = PostgresStateStore(factory)
    assert await store.get_session_status("ses_1") == "PAUSED_HITL"

    await proj.on_event(_ev(EventType.HITL_ANSWERED, hitl_id="h1"))
    assert await _status(factory) == "RUNNING"


async def test_hitl_resolve_does_not_clobber_terminal(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 't2.db').as_posix()}")
    proj = ProjectionUpdater(factory)
    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_ev(EventType.SESSION_FINISHED, final_status="SUCCEEDED"))
    assert await _status(factory) == "SUCCEEDED"
    # a late HITL resolve must NOT flip a finished session back to RUNNING
    await proj.on_event(_ev(EventType.HITL_ANSWERED, hitl_id="h1"))
    assert await _status(factory) == "SUCCEEDED"


async def test_plaintext_pause_projects_paused(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'pt.db').as_posix()}")
    proj = ProjectionUpdater(factory)
    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_ev(EventType.SESSION_PAUSED_HITL, capability_id="control:wait_for_user", form="wait"))
    assert await _status(factory) == "PAUSED"


async def test_ask_user_pause_projects_paused_hitl(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'ask.db').as_posix()}")
    proj = ProjectionUpdater(factory)
    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_ev(EventType.SESSION_PAUSED_HITL, capability_id="control:ask_user", form="question"))
    assert await _status(factory) == "PAUSED_HITL"


async def test_hitl_answered_resumes_from_paused(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'res.db').as_posix()}")
    proj = ProjectionUpdater(factory)
    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_ev(EventType.SESSION_PAUSED_HITL, capability_id="control:wait_for_user", form="wait"))
    await proj.on_event(_ev(EventType.HITL_ANSWERED, hitl_id="h1"))
    assert await _status(factory) == "RUNNING"
