"""段作用域折叠 + 渲染序排序（v2：apply_compact → 框架侧 segment_fold）— aiosqlite 行为测试。

镜像 ctx-weft tests/unit/test_segment_scoped_fold.py（spec 2026-07-21 段协议）；
策展政策（段界=末条 user 回合、protect user+SUMMARY、锚点）现内置于 segment_fold，
provider 只执行显式 id 集的原子 fold。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ctx_weft.protocols import MemoryEvent, MemoryEventType, MemoryScope, MemoryAddress, ProviderContext
from ctx_weft.core.loop.steps.segment_fold import segment_fold
from netlivecowork.persistence.postgres import init_db
from netlivecowork.providers.memory.postgres import PostgresMemoryProvider

pytestmark = pytest.mark.asyncio

T = MemoryEventType
BASE = datetime(2026, 7, 21, 10, 0, 0, tzinfo=UTC)


def _ctx() -> ProviderContext:
    return ProviderContext(session_id="s1", tenant_id="default")


async def _provider(tmp_path) -> PostgresMemoryProvider:
    factory = await init_db(f"sqlite:///{(tmp_path / 'mem.db').as_posix()}")
    return PostgresMemoryProvider(factory)


def _sc() -> MemoryAddress:
    return MemoryAddress(session_id="s1", task_id="task1", agent_id="a1")


async def _chrono(p, sc, ctx):
    return list(reversed(await p.recall_recent(
        sc, [T.USER_PROMPT, T.LLM_RESPONSE, T.TOOL_RESULT, T.TASK_COMPACT_SUMMARY],
        100, ctx)))


async def test_pg_since_last_folds_only_current_segment(tmp_path) -> None:
    """[UP1, A1(免折残留), UP2, A2a, A2b] + since_last=UP → 只折 A2；A1 保 raw；
    摘要锚在 UP2 之后。"""
    p, ctx, sc = await _provider(tmp_path), _ctx(), _sc()

    async def ing(typ, c, sec, role):
        await p.ingest(MemoryEvent(type=typ, address=sc, content=c,
                                   timestamp=BASE + timedelta(seconds=sec), role=role), ctx)

    await ing(T.USER_PROMPT,  "UP1 第一问", 0, "user")
    await ing(T.LLM_RESPONSE, "A1 段一回答", 1, "assistant")
    await ing(T.USER_PROMPT,  "UP2 第二问", 2, "user")
    await ing(T.LLM_RESPONSE, "A2a 当前段", 3, "assistant")
    await ing(T.TOOL_RESULT,  "A2b 工具",   4, "tool")

    await segment_fold(p, sc, MemoryScope.TASK, "S2", ctx)

    contents = [r.content for r in await _chrono(p, sc, ctx)]
    assert contents == ["UP1 第一问", "A1 段一回答", "UP2 第二问", "S2"], contents


async def test_pg_since_last_after_collapsed_up_still_folds(tmp_path) -> None:
    """坍缩 UP 形态（timestamp 回填、seq 最高）在场：段界必须按渲染序判定，
    坍缩 UP 之后的 raw 照折——seq 序实现会归档池空、摘要照写 raw 不折（今日实证 bug）。"""
    p, ctx, sc = await _provider(tmp_path), _ctx(), _sc()

    async def ing(typ, c, sec, role):
        await p.ingest(MemoryEvent(type=typ, address=sc, content=c,
                                   timestamp=BASE + timedelta(seconds=sec), role=role), ctx)

    await ing(T.USER_PROMPT,  "UP1", 0, "user")
    await ing(T.LLM_RESPONSE, "A1",  1, "assistant")
    await ing(T.LLM_RESPONSE, "A2",  2, "assistant")
    await ing(T.LLM_RESPONSE, "A3",  3, "assistant")
    # 坍缩 UP：ts 回填到 A2 之前 1.5s 处，但最后 ingest（seq 最高）——L3 collapse_task_layer 形态
    await p.ingest(MemoryEvent(
        type=T.USER_PROMPT, address=sc, content="坍缩UP",
        timestamp=BASE + timedelta(seconds=1, microseconds=500_000), role="user",
        metadata={"collapsed": True}), ctx)

    await segment_fold(p, sc, MemoryScope.TASK, "S", ctx)

    chrono = await _chrono(p, sc, ctx)
    contents = [r.content for r in chrono]
    assert "A2" not in contents and "A3" not in contents, \
        f"坍缩 UP 之后的当前段 raw 必须被折: {contents}"
    s_idx = next(i for i, r in enumerate(chrono) if r.type == T.TASK_COMPACT_SUMMARY)
    cup_idx = contents.index("坍缩UP")
    assert s_idx > cup_idx, f"摘要必须锚在坍缩 UP 之后: {contents}"


# v2 迁移注记：test_pg_without_since_last_folds_whole_scope 已删——「无 since_last 整
# scope 归档池」旋钮随 apply_compact 消亡；v2 段折恒段作用域（跨段合折按设计不存在，
# 无 user 回合时的整分区防御分支由 ctx-weft test_segment_fold 锁定）。
