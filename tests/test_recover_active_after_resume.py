"""Regression: a session that finished a turn and was RESUMED (multi-turn chat) and
then crashed must still be reported active by list_active_session_ids — otherwise
recover() skips it and it stays stuck on RUNNING (no resume bar).

Bug: both event stores treated "ever emitted SessionFinished" as terminal, ignoring a
later SessionResumed. A conversational session emits SessionFinished at the end of every
turn, so any multi-turn session that crashes mid-later-turn was excluded from recovery.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ctx_weft.core.events.types import Event
from ctx_weft.core.state.event_store import InMemoryEventStore
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.event_store import PostgresEventStore

pytestmark = pytest.mark.asyncio


def _ev(seq: int, type_: str) -> Event:
    # ids must be monotonic (ULID-like) — list_active_session_ids compares max(id).
    return Event(
        id=f"evt_{seq:04d}", run_id="run_1", sequence=seq, session_id="s1",
        type=type_, timestamp=datetime(2026, 6, 25, tzinfo=timezone.utc), payload={},
    )


# Turn 1 ends (SessionFinished), turn 2 starts via SessionResumed, then crash mid-run.
_RESUMED_THEN_CRASHED = [
    _ev(1, "SessionCreated"),
    _ev(2, "RunStarted"),
    _ev(3, "RunFinished"),
    _ev(4, "SessionFinished"),   # turn 1 done
    _ev(5, "SessionResumed"),    # next user message re-activates the session
    _ev(6, "RunStarted"),        # turn 2 running … then process crashes here
]


async def test_inmemory_store_reports_resumed_session_active() -> None:
    store = InMemoryEventStore()
    for e in _RESUMED_THEN_CRASHED:
        await store.append(e)
    assert "s1" in await store.list_active_session_ids(), (
        "session resumed after a finished turn must be active for crash recovery"
    )


async def test_postgres_store_reports_resumed_session_active(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'active.db').as_posix()}")
    store = PostgresEventStore(factory)
    for e in _RESUMED_THEN_CRASHED:
        await store.append(e)
    assert "s1" in await store.list_active_session_ids(), (
        "session resumed after a finished turn must be active for crash recovery"
    )


async def test_genuinely_finished_session_not_active(tmp_path) -> None:
    """Guard: a session whose last boundary IS SessionFinished must NOT be recovered."""
    factory = await init_db(f"sqlite:///{(tmp_path / 'done.db').as_posix()}")
    store = PostgresEventStore(factory)
    for e in [_ev(1, "SessionCreated"), _ev(2, "RunStarted"),
              _ev(3, "RunFinished"), _ev(4, "SessionFinished")]:
        await store.append(e)
    assert "s1" not in await store.list_active_session_ids()

    mem = InMemoryEventStore()
    for e in [_ev(1, "SessionCreated"), _ev(2, "SessionFinished")]:
        await mem.append(e)
    assert "s1" not in await mem.list_active_session_ids()
