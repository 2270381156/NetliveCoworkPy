"""PostgresProjectionStore — Session/Task 投影表的读层。

写操作由 ProjectionUpdater 通过 EventBus 事件驱动。
此类只暴露只读查询接口，供 API 层使用。

保留的写方法：
  - delete_session      （DELETE /sessions/{id} 端点需要）
  - append_sse_event    （SSE 历史持久化）
  - update_session_status （recovery 标记 INTERRUPTED 用）
  - save_session_title  （用户手动命名会话）
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import delete as sql_delete, select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from netlivecowork.persistence.postgres.models import (
    EventModel,
    SessionModel,
    SessionSSEEventModel,
    SnapshotModel,
    TaskModel,
)

logger = logging.getLogger(__name__)


@dataclass
class SessionRecord:
    """Host 读模型行：sessions 投影表的读出形状。

    刻意独立于 core 的领域 `Session`——host 读层只需 API/restore 用到的字段，
    不该为了拆解而先组装一个 core 领域对象。core 运行只依赖 EventStore，
    这张投影表纯是 host 的读模型（见 ProjectionUpdater）。
    """
    id: str
    tenant_id: str
    user_prompt: str
    status: str
    goal: str
    root_agent_id: str | None
    llm_provider: str | None
    llm_model: str | None
    token_budget: int
    failure_counter: int
    title: str = ""
    config: dict = field(default_factory=dict)
    workspace: str | None = None  # agent 工作目录（绝对路径）；host 自有列
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PostgresStateStore:
    """Read-only projection store + SSE persistence."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = session_factory

    # ── Session reads ─────────────────────────────────────────────────────────

    async def list_sessions(self) -> list[SessionRecord]:
        async with self._factory() as db:
            result = await db.execute(
                select(SessionModel).order_by(SessionModel.created_at.desc())
            )
            return [_row_to_record(r) for r in result.scalars().all()]

    async def get_session_record(self, session_id: str) -> SessionRecord | None:
        async with self._factory() as db:
            row = await db.get(SessionModel, session_id)
            return _row_to_record(row) if row is not None else None

    async def list_active_session_ids(self) -> list[str]:
        """Return session IDs with status=RUNNING — used by recovery."""
        async with self._factory() as db:
            result = await db.execute(
                select(SessionModel.id).where(SessionModel.status == "RUNNING")
            )
            return list(result.scalars().all())

    # ── Task reads ────────────────────────────────────────────────────────────

    async def load_tasks(self, session_id: str) -> list[dict]:
        """Return frontend-shaped task dicts for a session.

        Includes an ``is_daemon`` key for the caller to filter daemon tasks;
        it should be popped before storing in the SSE task registry.
        """
        async with self._factory() as db:
            result = await db.execute(
                select(TaskModel).where(TaskModel.session_id == session_id)
            )
            return [_row_to_task_dict(r) for r in result.scalars().all()]

    # ── SSE event persistence ─────────────────────────────────────────────────

    async def append_sse_event(self, session_id: str, event_json: str) -> None:
        async with self._factory() as db:
            async with db.begin():
                db.add(SessionSSEEventModel(
                    session_id=session_id,
                    event_json=event_json,
                ))

    async def load_sse_events(self, session_id: str) -> list[str]:
        async with self._factory() as db:
            result = await db.execute(
                select(SessionSSEEventModel)
                .where(SessionSSEEventModel.session_id == session_id)
                .order_by(SessionSSEEventModel.id)
            )
            return [r.event_json for r in result.scalars().all()]

    # ── Per-session workspace (host-owned column; survives process restart) ───

    async def save_workspace(self, session_id: str, workspace: str) -> None:
        """写入某 session 的工作目录列。须在 start_session 之后调用——SESSION_CREATED 已
        由 ProjectionUpdater 同步处理、sessions 行此刻必已存在（见 EventBus.emit 同步 drain）。"""
        async with self._factory() as db:
            async with db.begin():
                result = await db.execute(
                    sql_update(SessionModel)
                    .where(SessionModel.id == session_id)
                    .values(workspace=workspace)
                )
                if result.rowcount == 0:
                    logger.warning("save_workspace: session %s row not found", session_id)

    async def get_workspace(self, session_id: str) -> str | None:
        """读回某 session 的 workspace，供 resume 前重新登记给 fs provider。"""
        async with self._factory() as db:
            row = await db.get(SessionModel, session_id)
            return row.workspace if row is not None else None

    async def save_session_title(self, session_id: str, title: str) -> bool:
        """持久化用户手动标题；返回会话行是否存在。"""
        async with self._factory() as db:
            async with db.begin():
                result = await db.execute(
                    sql_update(SessionModel)
                    .where(SessionModel.id == session_id)
                    .values(title=title)
                )
                return bool(result.rowcount)

    async def get_session_status(self, session_id: str) -> str | None:
        """读回某 session 的持久状态（recover 据此跳过 PAUSED_HITL；spec/07 §9）。"""
        async with self._factory() as db:
            row = await db.get(SessionModel, session_id)
            return row.status if row is not None else None

    # ── Mutation (limited — host-owned metadata + recovery + delete) ─────────

    async def update_session_status(self, session_id: str, status: str) -> None:
        """Used by recovery to mark sessions INTERRUPTED."""
        async with self._factory() as db:
            async with db.begin():
                await db.execute(
                    sql_update(SessionModel)
                    .where(SessionModel.id == session_id)
                    .values(status=status)
                )

    async def delete_session(self, session_id: str) -> None:
        async with self._factory() as db:
            async with db.begin():
                # 先删 FK 子行（tasks + snapshots 都 FK 到 sessions.id，无 ON DELETE CASCADE），
                # 否则在 PRAGMA foreign_keys=ON 下删 session 行会触发外键约束失败。
                await db.execute(
                    sql_delete(TaskModel).where(TaskModel.session_id == session_id)
                )
                await db.execute(
                    sql_delete(SnapshotModel).where(SnapshotModel.session_id == session_id)
                )
                # events / session_sse_events 无 FK，过去删 session 不会连带清掉它们 → 留下孤儿事件：
                # 崩溃恢复的 list_active_session_ids 是从 events 推算的，会把已删会话当成 active 反复处理
                # （每次重启给它追加一条 INTERRUPTED、且永不收敛）。删除会话即一并清空其事件与 SSE 历史。
                await db.execute(
                    sql_delete(EventModel).where(EventModel.session_id == session_id)
                )
                await db.execute(
                    sql_delete(SessionSSEEventModel).where(SessionSSEEventModel.session_id == session_id)
                )
                row = await db.get(SessionModel, session_id)
                if row is not None:
                    await db.delete(row)  # workspace 是同行的列，随之删除


# ── Row → model helpers ───────────────────────────────────────────────────────


def _utc_iso(dt) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _row_to_record(row: SessionModel) -> SessionRecord:
    return SessionRecord(
        id=row.id,
        tenant_id=row.tenant_id,
        user_prompt=row.user_prompt,
        status=row.status,
        title=row.title or "",
        goal=row.goal or "",
        root_agent_id=row.root_agent_id,
        llm_provider=row.llm_provider,
        llm_model=row.llm_model,
        token_budget=row.token_budget,
        failure_counter=row.failure_counter,
        config=json.loads(row.config_json),
        workspace=row.workspace,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _row_to_task_dict(row: TaskModel) -> dict:
    """Map a TaskModel row to a frontend-shaped dict.

    The ``is_daemon`` key is included so callers can filter daemon tasks;
    it is not part of the miniAgents task shape.
    """
    ts = _utc_iso(row.created_at)
    updated = _utc_iso(row.updated_at) or ts
    return {
        "id": row.id,
        "session_id": row.session_id,
        "status": row.status,
        "title": row.title,
        "description": row.description,
        "user_prompt": row.user_prompt or "",
        "assigned_agent_id": row.assigned_agent_id or "",
        "creator_agent_id": row.creator_agent_id or "",
        "settings": {},
        "result": None,
        "outputs": json.loads(row.outputs_json),
        "error": row.error,
        "created_at": ts,
        "updated_at": updated,
        "is_daemon": row.is_daemon,
    }
