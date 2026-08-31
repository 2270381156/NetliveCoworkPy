"""PostgresMemoryProvider.supersede — aiosqlite-backed behavioral test.

Mirrors ctx-weft's in_memory supersede contract (used by root-task fold):
mark given event ids superseded so they no longer recall; skip already-superseded
/ unknown ids; return the count actually flipped.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ctx_weft.protocols import MemoryEvent, MemoryEventType, MemoryAddress, ProviderContext
from netlivecowork.persistence.postgres import init_db
from netlivecowork.providers.memory.postgres import PostgresMemoryProvider

pytestmark = pytest.mark.asyncio

T = MemoryEventType
_BASE = datetime(2026, 1, 1, tzinfo=UTC)


def _ctx() -> ProviderContext:
    return ProviderContext(session_id="s1", tenant_id="default")


def _agent_scope() -> MemoryAddress:
    return MemoryAddress(session_id="s1", task_id="t1", agent_id="A")


async def _provider(tmp_path) -> PostgresMemoryProvider:
    factory = await init_db(f"sqlite:///{(tmp_path / 'mem.db').as_posix()}")
    return PostgresMemoryProvider(factory)


async def _ingest_dispatch(mem, content: str, ts: int) -> str:
    return await mem.ingest(
        MemoryEvent(type=T.TASK_DISPATCH, address=_agent_scope(), content=content,
                    timestamp=_BASE + timedelta(seconds=ts), role="assistant",
                    metadata={"tool_call_id": f"tc-{content}"}),
        _ctx(),
    )


async def test_supersede_hides_events_and_returns_count(tmp_path) -> None:
    mem = await _provider(tmp_path)
    id1 = await _ingest_dispatch(mem, "a", 0)
    await _ingest_dispatch(mem, "b", 1)
    id3 = await _ingest_dispatch(mem, "c", 2)

    n = await mem.supersede([id1, id3], _ctx())
    assert n == 2

    remaining = await mem.recall_recent(_agent_scope(), [T.TASK_DISPATCH], 100, _ctx())
    assert [r.content for r in remaining] == ["b"]


async def test_supersede_skips_already_superseded_and_unknown(tmp_path) -> None:
    mem = await _provider(tmp_path)
    id1 = await _ingest_dispatch(mem, "a", 0)

    assert await mem.supersede([id1], _ctx()) == 1
    # second time it's already superseded; unknown id never matched → 0 flipped
    assert await mem.supersede([id1, "mev_does_not_exist"], _ctx()) == 0


async def test_supersede_empty_is_noop(tmp_path) -> None:
    mem = await _provider(tmp_path)
    assert await mem.supersede([], _ctx()) == 0
