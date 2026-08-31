"""段折 user 感知语义（v2：apply_compact → 框架侧 segment_fold）— aiosqlite 行为测试。

镜像 ctx-weft tests/unit/test_compact_user_aware.py：user 回合永不被折（段锚点）、
前段 raw 不跨段折入（段作用域）、TASK 层摘要 role=assistant、AGENT 层摘要 role=user。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ctx_weft.core.loop.steps.segment_fold import segment_fold
from ctx_weft.protocols import MemoryAddress, MemoryEvent, MemoryEventType, MemoryScope, ProviderContext
from netlivecowork.persistence.postgres import init_db
from netlivecowork.providers.memory.postgres import PostgresMemoryProvider

pytestmark = pytest.mark.asyncio

T = MemoryEventType


def _ctx() -> ProviderContext:
    return ProviderContext(session_id="s1", tenant_id="default")


async def _provider(tmp_path) -> PostgresMemoryProvider:
    factory = await init_db(f"sqlite:///{(tmp_path / 'mem.db').as_posix()}")
    return PostgresMemoryProvider(factory)


async def test_pg_segment_fold_protects_user_prompts_and_prior_segment(tmp_path) -> None:
    p = await _provider(tmp_path)
    base = datetime(2026, 6, 27, 10, 0, 0, tzinfo=UTC)
    ctx = _ctx()
    sc = MemoryAddress(session_id="s1", task_id="task1", agent_id="a1")

    async def ing(typ, c, ts, role):
        await p.ingest(MemoryEvent(type=typ, address=sc, content=c, timestamp=ts, role=role), ctx)

    await ing(T.USER_PROMPT,   "原始诉求",  base,                         "user")
    await ing(T.LLM_RESPONSE,  "想法1",    base + timedelta(seconds=1),   "assistant")
    await ing(T.TOOL_RESULT,   "结果1",    base + timedelta(seconds=2),   "tool")
    await ing(T.USER_PROMPT,   "HITL回复", base + timedelta(seconds=3),   "user")
    await ing(T.LLM_RESPONSE,  "想法2",    base + timedelta(seconds=4),   "assistant")

    await segment_fold(p, sc, MemoryScope.TASK, "段摘要", ctx)

    recs = list(reversed(await p.recall_recent(
        sc,
        [T.USER_PROMPT, T.LLM_RESPONSE, T.TOOL_RESULT, T.TASK_COMPACT_SUMMARY],
        100,
        ctx,
    )))
    kinds = [(r.type, r.content) for r in recs]

    assert (T.USER_PROMPT, "原始诉求") in kinds
    assert (T.USER_PROMPT, "HITL回复") in kinds
    # 段作用域：只折当前段（HITL 之后的 想法2）；前段 raw 保留（短段免折残留语义）
    assert (T.LLM_RESPONSE, "想法1") in kinds, "前段 raw 不得跨段折入"
    assert (T.TOOL_RESULT, "结果1") in kinds
    assert (T.LLM_RESPONSE, "想法2") not in kinds

    s_idx = next(i for i, (t, _) in enumerate(kinds) if t == T.TASK_COMPACT_SUMMARY)
    up2_idx = kinds.index((T.USER_PROMPT, "HITL回复"))
    assert up2_idx < s_idx, "摘要落当前段位置，不抢占前段"


async def test_pg_task_segment_summary_role_is_assistant(tmp_path) -> None:
    p = await _provider(tmp_path)
    base = datetime(2026, 6, 27, 10, 0, 0, tzinfo=UTC)
    ctx = _ctx()
    sc = MemoryAddress(session_id="s1", task_id="task1", agent_id="a1")

    async def ing(typ, c, ts, role):
        await p.ingest(MemoryEvent(type=typ, address=sc, content=c, timestamp=ts, role=role), ctx)

    await ing(T.USER_PROMPT,  "原始诉求", base,                       "user")
    await ing(T.LLM_RESPONSE, "想法",    base + timedelta(seconds=1), "assistant")

    await segment_fold(p, sc, MemoryScope.TASK, "段摘要", ctx)

    recs = await p.recall_recent(sc, [T.TASK_COMPACT_SUMMARY], 100, ctx)
    assert len(recs) == 1
    assert recs[0].role == "assistant"


async def test_pg_agent_layer_summary_role_stays_user(tmp_path) -> None:
    p = await _provider(tmp_path)
    base = datetime(2026, 6, 27, 10, 0, 0, tzinfo=UTC)
    ctx = _ctx()
    sc = MemoryAddress(session_id="s1", task_id="task1", agent_id="a1")

    async def ing(typ, c, ts, role):
        await p.ingest(MemoryEvent(type=typ, address=sc, content=c, timestamp=ts, role=role), ctx)

    await ing(T.TASK_DISPATCH,        "delegate", base,                       "assistant")
    await ing(T.TASK_DISPATCH_RESULT, "done",     base + timedelta(seconds=1), "tool")

    await segment_fold(p, MemoryAddress(session_id="s1", agent_id="a1"),
                       MemoryScope.AGENT, "派发摘要", ctx)

    recs = await p.recall_recent(sc, [T.AGENT_COMPACT_SUMMARY], 100, ctx)
    assert len(recs) == 1
    assert recs[0].role == "user"
