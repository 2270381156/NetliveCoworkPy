"""段尾锚（v2：apply_compact → 框架侧 segment_fold）— aiosqlite-backed.

Mirrors the in-memory contract (ctx-weft tests/unit/test_compact_trailing_anchor.py):
when a folded block has no surviving event after it (single-segment plain_text fold
[USER_PROMPT, LLM_RESPONSE]), the TASK_COMPACT_SUMMARY must be anchored to the folded
segment's own position (the last archived event's timestamp), NOT wall-clock now().

Otherwise a detached background observe that folds late (after the next turn's
USER_PROMPT was ingested) writes a now()-stamped summary that sorts AFTER the new user
message → the assembler treats history as ending in an assistant turn, appends the
"continue task" resume cue, and buries the real request → blank reply.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ctx_weft.protocols import MemoryEvent, MemoryEventType, MemoryScope, MemoryAddress, ProviderContext
from netlivecowork.persistence.postgres import init_db
from netlivecowork.providers.memory.postgres import PostgresMemoryProvider

pytestmark = pytest.mark.asyncio

T = MemoryEventType


def _ctx() -> ProviderContext:
    return ProviderContext(session_id="s1", tenant_id="default")


async def _provider(tmp_path) -> PostgresMemoryProvider:
    factory = await init_db(f"sqlite:///{(tmp_path / 'mem.db').as_posix()}")
    return PostgresMemoryProvider(factory)


async def _fold_trailing_segment(p, sc, ctx, base):
    """Ingest a single plain_text segment [UP1, LLM] and fold it (plain_text boundary)."""
    async def ing(typ, c, ts, role):
        await p.ingest(MemoryEvent(type=typ, address=sc, content=c, timestamp=ts, role=role), ctx)

    await ing(T.USER_PROMPT, "原始诉求", base, "user")
    await ing(T.LLM_RESPONSE, "上一轮回复", base + timedelta(seconds=1), "assistant")
    from ctx_weft.core.loop.steps.segment_fold import segment_fold
    await segment_fold(p, sc, MemoryScope.TASK, "段摘要", ctx)


async def test_pg_trailing_fold_summary_anchored_to_segment_not_now(tmp_path) -> None:
    p = await _provider(tmp_path)
    ctx = _ctx()
    sc = MemoryAddress(session_id="s1", task_id="task1", agent_id="a1")
    base = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)

    await _fold_trailing_segment(p, sc, ctx, base)

    summaries = await p.recall_recent(sc, [T.TASK_COMPACT_SUMMARY], 10, ctx)
    assert len(summaries) == 1
    # The folded LLM_RESPONSE sat at base+1s; the summary must inherit that position
    # (not wall-clock now()). Compare tz-naive — the sqlite test backend strips tzinfo.
    got = summaries[0].timestamp.replace(tzinfo=None)
    expected = (base + timedelta(seconds=1)).replace(tzinfo=None)
    assert got == expected, (
        f"summary anchored to {got} (now()?) instead of the folded segment position {expected}"
    )


async def test_pg_user_prompt_after_trailing_fold_sorts_newest(tmp_path) -> None:
    p = await _provider(tmp_path)
    ctx = _ctx()
    sc = MemoryAddress(session_id="s1", task_id="task1", agent_id="a1")
    base = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)

    await _fold_trailing_segment(p, sc, ctx, base)

    # Next turn: the user's new message (later than the folded segment).
    await p.ingest(MemoryEvent(type=T.USER_PROMPT, address=sc, content="新问题",
                               timestamp=base + timedelta(seconds=10), role="user"), ctx)

    recent = await p.recall_recent(
        sc, [T.USER_PROMPT, T.LLM_RESPONSE, T.TASK_COMPACT_SUMMARY], 10, ctx,
    )
    # recall_recent returns newest-first.
    assert recent[0].content == "新问题", (
        f"newest record is {recent[0].type}:{recent[0].content!r}, not the new USER_PROMPT — "
        "the fold summary leapfrogged the new user message"
    )
