"""PostgresMemoryProvider.recall_recent_by_agent — aiosqlite-backed behavioral test.

Mirrors ctx-weft's in_memory contract (unified AgentRecall assembly): recall an
agent's task-layer records across ALL its tasks (by agent_id, ignoring task_id),
newest-first, excluding superseded; every record carries metadata["task_id"].
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


async def _provider(tmp_path) -> PostgresMemoryProvider:
    factory = await init_db(f"sqlite:///{(tmp_path / 'mem.db').as_posix()}")
    return PostgresMemoryProvider(factory)


async def _ingest(mem, *, task_id: str, agent_id: str, content: str, ts: int) -> str:
    return await mem.ingest(
        MemoryEvent(
            type=T.USER_PROMPT,  # task-layer conversation type
            address=MemoryAddress(session_id="s1", task_id=task_id, agent_id=agent_id),
            content=content,
            timestamp=_BASE + timedelta(seconds=ts),
            role="user",
        ),
        _ctx(),
    )


async def test_recall_spans_agent_tasks_newest_first(tmp_path) -> None:
    mem = await _provider(tmp_path)
    # Agent A has records under two different tasks; agent B under its own task.
    await _ingest(mem, task_id="t1", agent_id="A", content="a1", ts=0)
    await _ingest(mem, task_id="t2", agent_id="A", content="a2", ts=2)
    await _ingest(mem, task_id="t9", agent_id="B", content="b1", ts=1)

    scope = MemoryAddress(session_id="s1", task_id="", agent_id="A")
    recs = await mem.recall_recent_by_agent(scope, [T.USER_PROMPT], 100, _ctx())

    # Both A tasks returned (task_id ignored), B excluded, newest-first by timestamp.
    assert [r.content for r in recs] == ["a2", "a1"]
    # Each record marks its originating task.
    assert {r.metadata["task_id"] for r in recs} == {"t1", "t2"}


async def test_recall_excludes_superseded_and_respects_limit(tmp_path) -> None:
    mem = await _provider(tmp_path)
    id1 = await _ingest(mem, task_id="t1", agent_id="A", content="a1", ts=0)
    await _ingest(mem, task_id="t1", agent_id="A", content="a2", ts=1)
    await _ingest(mem, task_id="t2", agent_id="A", content="a3", ts=2)

    await mem.supersede([id1], _ctx())  # close-time supersede hides a1

    scope = MemoryAddress(session_id="s1", task_id="", agent_id="A")
    recs = await mem.recall_recent_by_agent(scope, [T.USER_PROMPT], 100, _ctx())
    assert [r.content for r in recs] == ["a3", "a2"]

    # limit keeps only the newest N
    top1 = await mem.recall_recent_by_agent(scope, [T.USER_PROMPT], 1, _ctx())
    assert [r.content for r in top1] == ["a3"]
