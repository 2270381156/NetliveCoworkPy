"""ProjectionUpdater — EventBus subscriber that maintains projection tables.

Subscribes to all events; derives Session / Task projection state and writes
to DB. This is the only writer for sessions / tasks tables.

EventPersister handles raw event append; this class handles derived state.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ctx_weft.core.events.types import TRANSIENT_EVENT_TYPES, Event, EventType
from netlivecowork.persistence.postgres.models import SessionModel, TaskModel

logger = logging.getLogger(__name__)

# 事件→状态映射统一由 core 维护（与 reducer / 前端 SSE 共用单一真相）。
from ctx_weft.core.events import TASK_STATUS_BY_EVENT as _TASK_STATUS_MAP

_VALID_SESSION_STATUSES = frozenset({
    "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "INTERRUPTED", "PAUSED_HITL", "PAUSED",
})


class ProjectionUpdater:
    """Subscribes to EventBus; keeps sessions/tasks projection tables in sync."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = session_factory

    async def on_event(self, event: Event) -> None:
        # 瞬态 delta 不影响任何投影状态，提前短路省去每 token 的分发开销。
        if event.type in TRANSIENT_EVENT_TYPES:
            return
        try:
            await self._handle(event)
        except Exception:
            logger.exception(
                "ProjectionUpdater: error on event %s (%s)", event.id, event.type
            )

    async def _handle(self, event: Event) -> None:
        t = event.type
        p = event.payload

        if t == EventType.SESSION_CREATED:
            await self._upsert_session(event, p)

        elif t == EventType.SESSION_RESUMED:
            # 新一轮开启边界 → 投影翻回 RUNNING。与 SESSION_CREATED 对称、由事件驱动：host
            # /messages 开新轮不再带外手写投影 RUNNING（那会在 core emit SessionResumed 之前
            # 造出「投影 RUNNING 但事件日志仍终态」的状态，崩溃恢复的 list_active_session_ids
            # 看不见它 → 会话永久滞留 RUNNING。详见 sessions.py send_message）。
            await self._update_session(event.session_id, status="RUNNING")

        elif t == EventType.SESSION_STATUS_CHANGED:
            new_status = p.get("new_status", "")
            if new_status in _VALID_SESSION_STATUSES:
                await self._update_session(event.session_id, status=new_status)

        elif t == EventType.SESSION_FINISHED:
            final_status = p.get("final_status", "SUCCEEDED")
            if final_status in _VALID_SESSION_STATUSES:
                await self._update_session(event.session_id, status=final_status)

        elif t == EventType.SESSION_PAUSED_HITL:
            # 纯文本暂停(form=wait)= 软待命 PAUSED;ask_user/审批 = PAUSED_HITL。
            status = "PAUSED" if p.get("form") == "wait" else "PAUSED_HITL"
            await self._update_session(event.session_id, status=status)

        elif t in (
            EventType.HITL_APPROVED, EventType.HITL_MODIFIED, EventType.HITL_ANSWERED,
            EventType.HITL_REJECTED, EventType.HITL_CANCELLED,
        ):
            # HITL 解决 → session 回 RUNNING（仅当仍处暂停态，避免覆盖已到的终态）。
            await self._update_session_if_status(
                event.session_id, from_status=("PAUSED_HITL", "PAUSED"), to_status="RUNNING",
            )

        elif t == EventType.RUN_CANCELED:
            # RUN_CANCELED 不得覆盖已落的终态：熔断 trip 会协作取消在途兄弟 run，其
            # RUN_CANCELED 落在 SESSION_FINISHED(FAILED) 之后——无条件置 CANCELED 会把
            # 熔断终态盖掉（core reducer / SSE 层均不据此改状态，仅本投影需守卫）。
            # 真用户取消不受影响：彼时会话仍非终态，且 cancel_all 自己发 SESSION_STATUS_CHANGED(CANCELED)。
            await self._update_session_if_status(
                event.session_id,
                from_status=("RUNNING", "INTERRUPTED", "PAUSED", "PAUSED_HITL"),
                to_status="CANCELED",
            )

        elif t == EventType.RECOGNIZE_INTENT_TOOL_CALL:
            goal = p.get("session_goal", "")
            if goal:
                await self._update_session(event.session_id, goal=goal)
            # root task 创建时 title 为空、由 recognize_intent 并发补填——投影须落进
            # tasks 表，否则导入/重启后任务面板丢 name/description。空值不覆盖已有值。
            if event.task_id:
                values = {}
                if p.get("title"):
                    values["title"] = p["title"]
                if p.get("description"):
                    values["description"] = p["description"]
                if values:
                    await self._update_task(event.task_id, **values)

        elif t == EventType.FAILURE_THRESHOLD_HIT:
            # failure_counter 真折叠（与 core reducer / SessionEntry.apply 三处同义）：
            # 熔断补标的聚合失败（TASK_FAILED_BY_THRESHOLD）不是「新的一次失败」，不再由本事件
            # 驱动计数——计数改由下方 TASK_FAILED（非阈值码）+1 / TASK_FINISHED 清零承担。
            pass

        elif t == EventType.TASK_CREATED:
            await self._upsert_task(event, p)

        elif t == EventType.TASK_REQUEUED and event.task_id:
            # 重排：状态回 PENDING、清旧产出；reopen 还会带回改写后的 user_prompt。
            values: dict = {"status": "PENDING", "outputs_json": json.dumps(None)}
            new_up = p.get("user_prompt")
            if new_up is not None:
                values["user_prompt"] = new_up
            await self._update_task(event.task_id, **values)

        elif t in _TASK_STATUS_MAP and event.task_id:
            await self._update_task(event.task_id, status=_TASK_STATUS_MAP[t])
            # TASK_FAILED：普通失败 +1（熔断聚合失败 TASK_FAILED_BY_THRESHOLD 不计）；
            # TASK_FINISHED：成功清零（连败语义）。与 core reducer 同义。
            if t == EventType.TASK_FAILED:
                if (p or {}).get("error_code") != "TASK_FAILED_BY_THRESHOLD":
                    await self._increment_failure_counter(event.session_id)
            elif t == EventType.TASK_FINISHED:
                await self._reset_failure_counter(event.session_id)

        elif t == EventType.TASK_FINALIZED and event.task_id:
            await self._update_task(
                event.task_id,
                outputs_json=json.dumps(p.get("outputs")),
                error=p.get("error"),
            )

    # ── Session helpers ───────────────────────────────────────────────────────

    async def _upsert_session(self, event: Event, p: dict) -> None:
        from ctx_weft.core.utils import now_utc
        async with self._factory() as db:
            async with db.begin():
                existing = await db.get(SessionModel, event.session_id)
                if existing is None:
                    db.add(SessionModel(
                        id=event.session_id,
                        tenant_id=p.get("tenant_id", event.tenant_id),
                        user_prompt=p.get("user_prompt", ""),
                        status="RUNNING",
                        goal="",
                        root_agent_id=p.get("root_agent_id"),
                        llm_provider=p.get("llm_account") or None,
                        llm_model=p.get("llm_model") or None,
                        token_budget=p.get("token_budget", 200_000),
                        config_json=json.dumps({
                            "template_id": p.get("template_id", ""),
                        }),
                        created_at=event.timestamp or now_utc(),
                    ))
                else:
                    # SessionCreated can be replayed; update only if not yet set
                    if not existing.root_agent_id:
                        existing.root_agent_id = p.get("root_agent_id")

    async def _update_session(self, session_id: str, **values) -> None:
        async with self._factory() as db:
            async with db.begin():
                await db.execute(
                    sql_update(SessionModel)
                    .where(SessionModel.id == session_id)
                    .values(**values)
                )

    async def _update_session_if_status(
        self, session_id: str, from_status: tuple[str, ...], to_status: str
    ) -> None:
        async with self._factory() as db:
            async with db.begin():
                row = await db.get(SessionModel, session_id)
                if row is not None and row.status in from_status:
                    row.status = to_status

    async def _increment_failure_counter(self, session_id: str) -> None:
        async with self._factory() as db:
            async with db.begin():
                row = await db.get(SessionModel, session_id)
                if row is not None:
                    row.failure_counter = (row.failure_counter or 0) + 1

    async def _reset_failure_counter(self, session_id: str) -> None:
        async with self._factory() as db:
            async with db.begin():
                row = await db.get(SessionModel, session_id)
                # TASK_FINISHED 是最高频成功路径事件，绝大多数会话计数本就是 0——
                # 已为 0 则跳过赋值，省掉每次成功都发一条空 UPDATE 的写放大。
                if row is not None and row.failure_counter:
                    row.failure_counter = 0

    # ── Task helpers ──────────────────────────────────────────────────────────

    async def _upsert_task(self, event: Event, p: dict) -> None:
        from ctx_weft.core.utils import now_utc
        task_data: dict = p.get("task", {})
        task_id = task_data.get("id") or event.task_id
        if not task_id:
            return
        is_daemon = (task_data.get("settings") or {}).get("_type") == "MetadataFillerTaskSettings"
        async with self._factory() as db:
            async with db.begin():
                existing = await db.get(TaskModel, task_id)
                if existing is None:
                    db.add(TaskModel(
                        id=task_id,
                        session_id=event.session_id,
                        status=task_data.get("status", "ACTIVE"),
                        title=task_data.get("title", ""),
                        description=task_data.get("description", ""),
                        user_prompt=task_data.get("user_prompt") or None,
                        assigned_agent_id=task_data.get("assigned_agent_id") or event.agent_id,
                        creator_agent_id=task_data.get("creator_agent_id") or event.agent_id,
                        is_daemon=is_daemon,
                        created_at=event.timestamp or now_utc(),
                    ))

    async def _update_task(self, task_id: str, **values) -> None:
        async with self._factory() as db:
            async with db.begin():
                await db.execute(
                    sql_update(TaskModel)
                    .where(TaskModel.id == task_id)
                    .values(**values)
                )
