"""PostgresEventStore：events 持久化。"""

from __future__ import annotations

import json
import logging
from datetime import timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ctx_weft.core.state.event_store import EventStore
from ctx_weft.core.state.event_store import RunSnapshot
from ctx_weft.core.events import Event
from netlivecowork.persistence.postgres.models import EventModel, SnapshotModel

logger = logging.getLogger(__name__)


class PostgresEventStore(EventStore):
    """SQLAlchemy-backed event store."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        keep_snapshots: int = 3,
    ) -> None:
        self._factory = session_factory
        # 每个 session 保留多少张最新快照；写入新快照后清理多余的旧快照。
        self._keep_snapshots = max(1, keep_snapshots)

    async def append(self, event: Event) -> None:
        async with self._factory() as db:
            async with db.begin():
                db.add(EventModel(
                    id=event.id,
                    run_id=event.run_id,
                    session_id=event.session_id,
                    task_id=event.task_id,
                    agent_id=event.agent_id,
                    tenant_id=event.tenant_id,
                    type=event.type,
                    sequence=event.sequence,
                    payload_json=json.dumps(event.payload),
                    metadata_json=json.dumps(event.metadata),
                    causation_id=event.causation_id,
                    timestamp=event.timestamp,
                ))

    async def read_by_session(self, session_id: str) -> list[Event]:
        """Load all events for a session ordered by id (ULID)."""
        async with self._factory() as db:
            q = (
                select(EventModel)
                .where(EventModel.session_id == session_id)
                .order_by(EventModel.id)
            )
            result = await db.execute(q)
            rows = result.scalars().all()
            return [_row_to_event(r) for r in rows]

    async def read_session_events_of_types(
        self, session_id: str, types: tuple[str, ...],
    ) -> list[Event]:
        """Load only the given event types for a session, ordered by id (ULID).

        轻查询：恢复决策按事件折叠（如 HITL 待解决判定）而不全量回放。
        """
        async with self._factory() as db:
            q = (
                select(EventModel)
                .where(
                    EventModel.session_id == session_id,
                    EventModel.type.in_(tuple(str(t) for t in types)),
                )
                .order_by(EventModel.id)
            )
            result = await db.execute(q)
            return [_row_to_event(r) for r in result.scalars().all()]

    async def list_active_session_ids(self) -> list[str]:
        """Sessions currently active (need crash recovery).

        会话每完成一轮对话发 ``SessionFinished``，下一条消息经 ``SessionResumed`` 重新激活——
        故「曾发过 SessionFinished」并非终态，旧的「有 SessionFinished 即排除」会把所有多轮
        会话的后续崩溃漏掉（停在 RUNNING、前端不弹续跑条）。判据改为：最近一次「开启边界」
        (SessionCreated/SessionResumed) 晚于最近一次 SessionFinished，或从未 finished。
        事件 id 是 ULID（字典序即时间序），故用 ``max(id)`` 比较。
        """
        from sqlalchemy import func, or_
        from sqlalchemy import select as sa_select
        async with self._factory() as db:
            opened = (
                sa_select(EventModel.session_id, func.max(EventModel.id).label("opened"))
                .where(EventModel.type.in_(("SessionCreated", "SessionResumed")))
                .group_by(EventModel.session_id)
                .subquery()
            )
            finished = (
                sa_select(EventModel.session_id, func.max(EventModel.id).label("finished"))
                .where(EventModel.type == "SessionFinished")
                .group_by(EventModel.session_id)
                .subquery()
            )
            q = (
                sa_select(opened.c.session_id)
                .outerjoin(finished, finished.c.session_id == opened.c.session_id)
                .where(or_(finished.c.finished.is_(None), opened.c.opened > finished.c.finished))
            )
            result = await db.execute(q)
            return list(result.scalars().all())

    async def last_activity_times(
        self, exclude_types: tuple[str, ...] = ("SessionStatusChanged",)
    ) -> dict[str, str]:
        """每个 session「最后一次真实活动」的时间（ISO 串），供前端列表排序/展示。

        取事件日志里每个 session 最后一条事件的 timestamp，但**排除** SessionStatusChanged
        ——它是崩溃恢复每次启动都会补发的记帐事件（见 startup.py recover()），时间戳＝启动
        时刻，会让重启后的会话集体跳到「现在」。事件日志是不可变追加流，其 timestamp 即真实
        发生时间，不像 sessions.updated_at（onupdate=now 的行写入时间）会被恢复写入污染。
        """
        from sqlalchemy import func
        async with self._factory() as db:
            result = await db.execute(
                select(EventModel.session_id, func.max(EventModel.timestamp))
                .where(EventModel.type.not_in(exclude_types))
                .group_by(EventModel.session_id)
            )
            return {sid: _iso(ts) for sid, ts in result.all() if ts is not None}

    async def read_after(self, session_id: str, after_event_id: str) -> list[Event]:
        """Load events for session with id > after_event_id (ULID ordering)."""
        async with self._factory() as db:
            q = (
                select(EventModel)
                .where(
                    EventModel.session_id == session_id,
                    EventModel.id > after_event_id,
                )
                .order_by(EventModel.id)
            )
            result = await db.execute(q)
            return [_row_to_event(r) for r in result.scalars().all()]

    async def save_snapshot(self, snapshot: RunSnapshot) -> None:
        async with self._factory() as db:
            async with db.begin():
                db.add(SnapshotModel(
                    id=snapshot.id,
                    session_id=snapshot.session_id,
                    last_event_id=snapshot.last_event_id,
                    last_event_sequence=snapshot.last_event_sequence,
                    state_blob_json=json.dumps(snapshot.state_blob),
                    snapshot_reason=snapshot.snapshot_reason,
                    created_at=snapshot.snapshot_at,
                ))
                await db.flush()  # 让新行参与下面的"保留最新"排序
                await self._prune_snapshots(db, snapshot.session_id)

    async def _prune_snapshots(self, db: AsyncSession, session_id: str) -> None:
        """删除该 session 除最新 keep_snapshots 张之外的旧快照。

        恢复只取最新一张（load_latest_snapshot），旧快照纯属占用——逐 RunFinished
        定期写入会让其无界累积，故每次写入后顺手清理。按 id（ULID，时间可排序）
        取最新 N 个保留；子查询带 LIMIT，Postgres / SQLite 均支持。
        """
        keep_ids = (
            select(SnapshotModel.id)
            .where(SnapshotModel.session_id == session_id)
            .order_by(SnapshotModel.id.desc())
            .limit(self._keep_snapshots)
        )
        await db.execute(
            delete(SnapshotModel).where(
                SnapshotModel.session_id == session_id,
                SnapshotModel.id.not_in(keep_ids),
            )
        )

    async def load_latest_snapshot(self, session_id: str) -> RunSnapshot | None:
        async with self._factory() as db:
            q = (
                select(SnapshotModel)
                .where(SnapshotModel.session_id == session_id)
                .order_by(SnapshotModel.created_at.desc())
                .limit(1)
            )
            result = await db.execute(q)
            row = result.scalar_one_or_none()
            if row is None:
                return None
            return RunSnapshot(
                id=row.id,
                run_id="",
                session_id=row.session_id,
                last_event_id=row.last_event_id,
                last_event_sequence=row.last_event_sequence,
                state_blob=json.loads(row.state_blob_json),
                snapshot_reason=row.snapshot_reason,
                snapshot_at=row.created_at,
            )


def _iso(dt) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _row_to_event(row: EventModel) -> Event:
    return Event(
        id=row.id,
        run_id=row.run_id,
        sequence=row.sequence,
        session_id=row.session_id,
        type=row.type,
        timestamp=row.timestamp,
        tenant_id=row.tenant_id,
        task_id=row.task_id,
        agent_id=row.agent_id,
        payload=json.loads(row.payload_json),
        metadata=json.loads(row.metadata_json),
        causation_id=row.causation_id,
    )
