"""Regression: deleting a session purges its events, so crash recovery never
re-processes it as an orphan.

Events have no FK to sessions, so delete_session used to leave them behind. Because
list_active_session_ids derives "active" from events, a deleted session stayed
permanently active — every restart re-marked it INTERRUPTED and appended a junk event.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ctx_weft.core.events.types import Event
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.event_store import PostgresEventStore
from netlivecowork.persistence.postgres.state_store import PostgresStateStore

pytestmark = pytest.mark.asyncio

_TS = datetime(2026, 6, 25, tzinfo=timezone.utc)


def _ev(sid: str, seq: int, type_: str, **payload) -> Event:
    return Event(id=f"evt_{seq:020d}", run_id="r1", sequence=seq, session_id=sid,
                 type=type_, timestamp=_TS, tenant_id="default", payload=payload)


async def test_delete_session_purges_events(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'd.db').as_posix()}")
    es = PostgresEventStore(factory)
    ss = PostgresStateStore(factory)
    sid = "ses_del"

    await es.append(_ev(sid, 1, "SessionCreated"))
    await es.append(_ev(sid, 2, "RunStarted"))          # unfinished → would be "active"
    await ss.append_sse_event(sid, '{"type":"message"}')
    assert sid in await es.list_active_session_ids()

    await ss.delete_session(sid)

    assert sid not in await es.list_active_session_ids(), "deleted session must not be recoverable"
    assert await es.read_by_session(sid) == [], "events must be purged on delete"
    assert await ss.load_sse_events(sid) == [], "SSE history must be purged on delete"
