"""PostgresMemoryProvider：SQLAlchemy async 实现（memory protocol v2）。

v2 协议面（8 方法）：写 ingest/fold、读 load_view/recall_topic/recall_semantic、
订阅 subscribe_topic/list_subscriptions、能力 describe。

- **词汇双读**：新行 type 列存 kind 字符串（"conversation_turn"…），存量行存 legacy
  类型字符串；load_view 用 memory_compat.kind_expansion 展开 `type IN (...)`，返回前经
  normalize_view（legacy dispatch 配对 + kind/scope 重打）。零数据迁移（设计 §6）。
- **record-id 契约**：event.id 给定时采用并按 id 幂等（重复 ingest/fold 重放 = no-op）。
- **fold 原子**：遗忘 + 补偿单事务（postgres/sqlite 天然满足）。
- 策展政策（keep_last/protect/段界/锚点）在框架侧 segment_fold——本 provider 只按显式
  id 集与显式 replacement 执行（apply_compact 已随 v2 消亡）。

文末另有 **Legacy test-compat 区**：recall_recent / recall_recent_by_agent /
count_recent / supersede 为非协议实例方法，仅供存量测试兼容（镜像 ctx-weft in-memory
provider 的 P4a 范围决策）；新代码一律 load_view / fold。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from sqlalchemy import and_, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ctx_weft.core.utils import generate_id
from netlivecowork.persistence.postgres.models import (
    MemoryEventModel,
    MemorySubscriptionModel,
)
from ctx_weft.protocols import (
    EVENT_LAYER,
    MemoryAddress,
    MemoryEvent,
    MemoryEventType,
    MemoryProvider,
    MemoryProviderInfo,
    MemoryRecord,
    MemoryScope,
    ProviderContext,
    Subscription,
)
from ctx_weft.protocols.memory_compat import (
    MemoryKind,
    kind_expansion,
    kind_of,
    layer_of,
    legacy_type_of,
    matches_legacy_type,
    normalize_view,
    validate_half_address,
)

logger = logging.getLogger(__name__)

_DEFAULT_KINDS = (MemoryKind.CONVERSATION_TURN, MemoryKind.SUMMARY)


def _partition_where(address: MemoryAddress, scope: MemoryScope):
    """归属分区 WHERE：按 scope 选 key 列（seq 计数与视图查询共用口径）。"""
    if scope is MemoryScope.TASK:
        return and_(MemoryEventModel.session_id == address.session_id,
                    MemoryEventModel.layer == "task",
                    MemoryEventModel.task_id == address.task_id)
    if scope is MemoryScope.AGENT:
        return and_(MemoryEventModel.session_id == address.session_id,
                    MemoryEventModel.layer == "agent",
                    MemoryEventModel.agent_id == address.agent_id)
    return and_(MemoryEventModel.session_id == address.session_id,
                MemoryEventModel.layer == "session")


def _parse_row_vocab(row: MemoryEventModel):
    """type 列 → (legacy type | None, kind | None)。新行存 kind 字符串、旧行存 legacy 类型。"""
    try:
        return MemoryEventType(row.type), None
    except ValueError:
        pass
    try:
        return None, MemoryKind(row.type)
    except ValueError:
        return None, None  # 未知词汇（前向兼容）：不进视图


class PostgresMemoryProvider(MemoryProvider):
    """Postgres-backed memory provider（v2）。"""

    name = "postgres_memory"

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = session_factory

    # ── 写（2）────────────────────────────────────────────────────────────────

    async def ingest(self, event: MemoryEvent, ctx: ProviderContext) -> str:
        async with self._factory() as db:
            async with db.begin():
                if event.id is not None and await self._id_exists(db, event.id):
                    return event.id  # record-id 契约：已存在（含 superseded）= no-op
                return await self._ingest_in_tx(db, event)

    async def fold(
        self,
        supersede_ids: list[str],
        replacements: list[MemoryEvent],
        ctx: ProviderContext,
    ) -> list[str]:
        """原子"遗忘 + 补偿"：单事务；已 superseded / 不存在的 id 跳过；replacement 按 id 幂等。"""
        new_ids: list[str] = []
        async with self._factory() as db:
            async with db.begin():
                if supersede_ids:
                    await db.execute(
                        update(MemoryEventModel)
                        .where(
                            MemoryEventModel.id.in_(supersede_ids),
                            MemoryEventModel.is_superseded == False,  # noqa: E712
                        )
                        .values(is_superseded=True)
                    )
                for ev in replacements:
                    if ev.id is not None and await self._id_exists(db, ev.id):
                        new_ids.append(ev.id)
                        continue
                    new_ids.append(await self._ingest_in_tx(db, ev))
        return new_ids

    @staticmethod
    async def _id_exists(db: AsyncSession, event_id: str) -> bool:
        result = await db.execute(
            select(MemoryEventModel.id).where(MemoryEventModel.id == event_id))
        return result.scalar_one_or_none() is not None

    async def _ingest_in_tx(self, db: AsyncSession, event: MemoryEvent) -> str:
        """ingest 内核（须在事务内调用）；fold 复用以保证原子性。"""
        event_id = event.id or generate_id("mev")
        # v2 归一：kind 解析失败 = 死类型（存储保留、视图不见）；scope 恒可解析
        try:
            kind = kind_of(event.type, event.kind)
        except ValueError:
            kind = None
        scope = layer_of(event.type, event.scope)
        addr = event.address

        result = await db.execute(
            select(func.coalesce(func.max(MemoryEventModel.seq_no), 0))
            .where(_partition_where(addr, scope))
        )
        max_seq = result.scalar_one() or 0

        topic_seq = 0
        if event.topic:
            # PUBLICATION 覆盖语义：同 topic 旧发布（新旧词汇皆认）标 superseded，只留最新一条
            if kind is MemoryKind.PUBLICATION:
                await db.execute(
                    update(MemoryEventModel)
                    .where(
                        MemoryEventModel.topic == event.topic,
                        MemoryEventModel.type.in_(
                            kind_expansion(MemoryKind.PUBLICATION, MemoryScope.SESSION)),
                        MemoryEventModel.is_superseded == False,  # noqa: E712
                    )
                    .values(is_superseded=True)
                )
            result2 = await db.execute(
                select(func.coalesce(func.max(MemoryEventModel.topic_seq_no), 0))
                .where(MemoryEventModel.topic == event.topic)
            )
            topic_seq = (result2.scalar_one() or 0) + 1

        content_str = (
            event.content if isinstance(event.content, str) else json.dumps(event.content)
        )
        db.add(MemoryEventModel(
            id=event_id,
            session_id=addr.session_id,
            task_id=addr.task_id,
            agent_id=addr.agent_id,
            layer=scope.value,
            # 新词汇行存 kind 字符串；legacy 构造（type 给定）原样存 legacy 类型字符串
            type=str(event.type) if event.type is not None else str(event.kind),
            role=event.role,
            topic=event.topic,
            content=content_str,
            seq_no=max_seq + 1,
            topic_seq_no=topic_seq,
            metadata_json=json.dumps(event.metadata),
            timestamp=event.timestamp,
        ))
        return event_id

    # ── 读（3）────────────────────────────────────────────────────────────────

    async def load_view(
        self,
        address: MemoryAddress,
        scope: MemoryScope,
        ctx: ProviderContext,
        kinds: list[MemoryKind] | None = None,
    ) -> list[MemoryRecord]:
        """工作记忆回放（v2 §4）：全量幸存、(timestamp, seq_no) 升序、半址过滤、双词汇视图。"""
        validate_half_address(address, scope)
        wanted = list(kinds) if kinds is not None else list(_DEFAULT_KINDS)
        type_strs: set[str] = set()
        for k in wanted:
            type_strs |= kind_expansion(k, scope)

        conds = [
            MemoryEventModel.session_id == address.session_id,
            MemoryEventModel.layer == scope.value,
            MemoryEventModel.is_superseded == False,  # noqa: E712
            MemoryEventModel.type.in_(type_strs),
        ]
        if scope is MemoryScope.TASK:
            if address.task_id is not None:
                conds.append(MemoryEventModel.task_id == address.task_id)
                if address.agent_id is not None:  # 全址时防御性校验 agent 归属
                    conds.append(MemoryEventModel.agent_id == address.agent_id)
            else:  # 跨 task 聚合
                conds.append(MemoryEventModel.agent_id == address.agent_id)
        elif scope is MemoryScope.AGENT:
            conds.append(MemoryEventModel.agent_id == address.agent_id)

        async with self._factory() as db:
            result = await db.execute(
                select(MemoryEventModel)
                .where(*conds)
                .order_by(MemoryEventModel.timestamp.asc(), MemoryEventModel.seq_no.asc())
            )
            rows = result.scalars().all()
        return normalize_view([_row_to_record(r) for r in rows])

    async def recall_topic(
        self,
        topic: str,
        since: int,
        ctx: ProviderContext,
    ) -> tuple[list[MemoryRecord], int]:
        async with self._factory() as db:
            result = await db.execute(
                select(MemoryEventModel)
                .where(
                    MemoryEventModel.topic == topic,
                    MemoryEventModel.topic_seq_no > since,
                    MemoryEventModel.is_superseded == False,  # noqa: E712
                )
                .order_by(MemoryEventModel.topic_seq_no)
            )
            rows = result.scalars().all()
            records = [_row_to_record(r) for r in rows]
            new_cursor = rows[-1].topic_seq_no if rows else since
            return records, new_cursor

    async def recall_semantic(
        self,
        query: str,
        scope: MemoryAddress,
        top_k: int,
        ctx: ProviderContext,
    ) -> list[MemoryRecord]:
        return []  # No pgvector in V1

    # ── 订阅（2）──────────────────────────────────────────────────────────────

    async def subscribe_topic(
        self,
        session_id: str,
        topic: str,
        intent: Literal["subtask", "predecessor", "long_term_background", "long_term_project_log"],
        ctx: ProviderContext,
        task_id: str = "",
    ) -> str:
        sub_id = generate_id("sub")
        async with self._factory() as db:
            async with db.begin():
                existing = await db.execute(
                    select(MemorySubscriptionModel)
                    .where(
                        MemorySubscriptionModel.session_id == session_id,
                        MemorySubscriptionModel.task_id == task_id,
                        MemorySubscriptionModel.topic == topic,
                    )
                )
                row = existing.scalar_one_or_none()
                if row is None:
                    db.add(MemorySubscriptionModel(
                        id=sub_id,
                        session_id=session_id,
                        task_id=task_id,
                        topic=topic,
                        cursor=0,
                        intent=intent,
                    ))
                else:
                    sub_id = row.id  # 幂等：保留原游标
        return sub_id

    async def list_subscriptions(
        self, session_id: str, ctx: ProviderContext, task_id: str | None = None,
    ) -> list[Subscription]:
        async with self._factory() as db:
            stmt = select(MemorySubscriptionModel).where(
                MemorySubscriptionModel.session_id == session_id
            )
            if task_id is not None:
                # 该 task 自己的订阅 + session 级订阅（task_id == ""）
                stmt = stmt.where(MemorySubscriptionModel.task_id.in_([task_id, ""]))
            result = await db.execute(stmt)
            rows = result.scalars().all()
            return [
                Subscription(
                    session_id=r.session_id,
                    topic=r.topic,
                    cursor=r.cursor,
                    intent=r.intent,  # type: ignore[arg-type]
                    task_id=r.task_id,
                )
                for r in rows
            ]

    # ── 能力 ──────────────────────────────────────────────────────────────────

    async def describe(self, ctx: ProviderContext) -> MemoryProviderInfo:
        return MemoryProviderInfo(
            name=self.name,
            supports_semantic=False,
            supports_topic=True,
            archives_superseded=True,
        )

    # ── Legacy test-compat（非协议方法，仅供存量测试；新代码用 load_view/fold）──

    async def _partition_rows(self, address: MemoryAddress, scope: MemoryScope):
        """分区内全量幸存行（无 type 过滤，升序）；legacy wrapper 的 Python 侧匹配基底。"""
        async with self._factory() as db:
            result = await db.execute(
                select(MemoryEventModel)
                .where(
                    _partition_where(address, scope),
                    MemoryEventModel.is_superseded == False,  # noqa: E712
                )
                .order_by(MemoryEventModel.timestamp.asc(), MemoryEventModel.seq_no.asc())
            )
            return result.scalars().all()

    async def recall_recent(
        self,
        scope: MemoryAddress,
        types: list[MemoryEventType],
        limit: int,
        ctx: ProviderContext,
    ) -> list[MemoryRecord]:
        type_set = set(types)
        layers = {EVENT_LAYER[t] for t in type_set}
        matching: list[tuple[Any, MemoryEventType | None, MemoryKind | None]] = []
        for lyr in layers:
            for row in await self._partition_rows(scope, lyr):
                type_, kind = _parse_row_vocab(row)
                row_scope = MemoryScope(row.layer)
                if any(matches_legacy_type(type_, kind, row_scope, row.role, t)
                       for t in type_set):
                    matching.append((row, type_, kind))
        matching.sort(key=lambda x: (x[0].timestamp, x[0].seq_no))
        recent = matching[-limit:] if limit and limit > 0 else matching
        return [_legacy_stamped(_row_to_record(row)) for row, _t, _k in reversed(recent)]

    async def recall_recent_by_agent(
        self,
        agent_scope: MemoryAddress,
        types: list[MemoryEventType],
        limit: int,
        ctx: ProviderContext,
    ) -> list[MemoryRecord]:
        type_set = set(types)
        cross = MemoryAddress(session_id=agent_scope.session_id, agent_id=agent_scope.agent_id)
        async with self._factory() as db:
            result = await db.execute(
                select(MemoryEventModel)
                .where(
                    MemoryEventModel.session_id == cross.session_id,
                    MemoryEventModel.agent_id == cross.agent_id,
                    MemoryEventModel.layer == "task",
                    MemoryEventModel.is_superseded == False,  # noqa: E712
                )
                .order_by(MemoryEventModel.timestamp.asc(), MemoryEventModel.seq_no.asc())
            )
            rows = result.scalars().all()
        matching = []
        for row in rows:
            type_, kind = _parse_row_vocab(row)
            if any(matches_legacy_type(type_, kind, MemoryScope.TASK, row.role, t)
                   for t in type_set):
                matching.append(row)
        recent = matching[-limit:] if limit and limit > 0 else matching
        return [_legacy_stamped(_row_to_record(r)) for r in reversed(recent)]

    async def count_recent(
        self,
        scope: MemoryAddress,
        types: list[MemoryEventType],
        ctx: ProviderContext,
    ) -> int:
        return len(await self.recall_recent(scope, types, 0, ctx))

    async def supersede(
        self,
        event_ids: list[str],
        ctx: ProviderContext,
    ) -> int:
        """把给定 event id 标记 superseded（已 superseded / 不存在的跳过）。返回标记条数。"""
        if not event_ids:
            return 0
        async with self._factory() as db:
            async with db.begin():
                result = await db.execute(
                    update(MemoryEventModel)
                    .where(
                        MemoryEventModel.id.in_(event_ids),
                        MemoryEventModel.is_superseded == False,  # noqa: E712
                    )
                    .values(is_superseded=True)
                )
        return result.rowcount or 0


def _legacy_stamped(rec: MemoryRecord) -> MemoryRecord:
    """recall wrapper 出口契约（legacy 视界）：v2 行回填 legacy 等价 type。"""
    if rec.type is None:
        rec.type = legacy_type_of(rec.kind, rec.scope, rec.role)
    return rec


def _row_to_record(row: MemoryEventModel) -> MemoryRecord:
    content: Any = row.content
    try:
        parsed = json.loads(row.content)
        if isinstance(parsed, list):
            content = parsed
    except (json.JSONDecodeError, TypeError):
        pass

    type_, kind = _parse_row_vocab(row)
    try:
        scope = MemoryScope(row.layer)
    except ValueError:
        scope = None
    return MemoryRecord(
        id=row.id,
        type=type_,
        content=content,
        timestamp=row.timestamp,
        role=row.role,  # type: ignore[arg-type]
        topic=row.topic,
        kind=kind,   # legacy 行为 None → normalize_view 按 LEGACY_TRIPLE 重打
        scope=scope,
        address=MemoryAddress(session_id=row.session_id, task_id=row.task_id,
                              agent_id=row.agent_id),
        metadata={**json.loads(row.metadata_json), "seq_no": row.seq_no,
                  "layer": row.layer, "task_id": row.task_id},
    )
