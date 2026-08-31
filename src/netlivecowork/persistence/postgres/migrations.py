"""One-time DB data migrations, applied at startup (idempotent, gated).

`run_pending()` runs each not-yet-applied migration once per DB and records it in an
`applied_migrations` marker table, so subsequent boots are a cheap no-op (one SELECT).
Each migration runs in its own transaction. SQLAlchemy Core only → portable across
SQLite (dev) and Postgres (prod).

To add a migration: append `(id, coro)` to MIGRATIONS. NEVER change an existing id or
reorder — ids are the applied-marker keys.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from netlivecowork.persistence.postgres.models import (
    EventModel,
    MemoryEventModel,
    SessionSSEEventModel,
    TaskModel,
)

logger = logging.getLogger(__name__)

# task 层 raw 类型——对齐 finalize._FINAL_RAW_TYPES（close 时软删的三类）。
_RAW_TYPES = ("llm_response", "tool_invocation", "tool_result")
# 终态 task（对话已定稿）。in-flight 的 PENDING/ACTIVE/SUSPENDED/TO_BE_OBSERVED 绝不碰——
# 它们的 raw 是活对话，删了会毁掉续跑。
_TERMINAL_STATUSES = ("FINISHED", "FAILED", "CANCELED")


async def _m001_supersede_legacy_terminal_task_raw(db: AsyncSession) -> int:
    """回填 v0.4.12 遗漏的「close 时软删 task 层末 raw 段」。

    旧版本 close 不 supersede task 层 raw、且装配不跨 task 召回，故残留 raw 无害；当前版本
    用 recall_recent_by_agent 跨 task 召回，会把这些残留 raw 灌进每次 prompt → 会话膨胀、
    escalating_compact 够不到 → 压不动。这里对**终态 task** 补做当前
    finalize._supersede_final_raw_segment 做的事：软删 raw 三类，保留 USER_PROMPT +
    TASK_COMPACT_SUMMARY 胶囊（跨 task 召回仍用；agent 层另有镜像，故无损）。

    幂等：is_superseded == False 过滤，重跑命中 0 行。返回 supersede 条数。
    """
    terminal_task_ids = select(TaskModel.id).where(TaskModel.status.in_(_TERMINAL_STATUSES))
    result = await db.execute(
        update(MemoryEventModel)
        .where(
            MemoryEventModel.layer == "task",
            MemoryEventModel.type.in_(_RAW_TYPES),
            MemoryEventModel.is_superseded == False,  # noqa: E712 — SQL boolean, not Python
            MemoryEventModel.task_id.in_(terminal_task_ids),
        )
        .values(is_superseded=True)
    )
    return result.rowcount or 0


# task 层胶囊类型——fold 折叠某单元时随其 agent 对话一并 supersede（对齐 fold_root_experience
# 的 _TASK_BODY_TYPES 中的胶囊部分，compact.py:332-335）。raw 三类由 m001 处理，此处只补胶囊。
_CAPSULE_TYPES = ("user_prompt", "task_compact_summary")


async def _m002_supersede_folded_task_capsules(db: AsyncSession) -> int:
    """回填 v0.4.12 遗漏的「fold 时跨层软删 task 层胶囊」。

    当前 fold_root_experience 折某顶层单元时，连其 task 层 USER_PROMPT + TASK_COMPACT_SUMMARY
    胶囊一并 supersede（compact.py:332-335），与 agent 层 finish/dispatch 对同命运。v0.4.12 的
    fold 只折 agent 层对话回合、不跨层删 task 层胶囊，故**已折单元**的 user_prompt 残留 live，被
    recall_recent_by_agent 跨 task 灌进每次 prompt → 「## Context so far 之前的信息没被压缩掉」、
    摘要位置错乱。

    「已折」的数据判据：终态 task 且其 agent 层 conversation turn **存在且全部 superseded**（保留
    窗口内的 task 至少有 1 条 live 回合，故被排除；在途 task 非终态，亦排除）。对这类 task 软删其
    残留 task 层胶囊，使其只由 agent 层 AGENT_COMPACT_SUMMARY 代表——与当前 fold 行为一致。

    幂等：is_superseded==False 过滤 + 「无 live 回合」判据，重跑命中 0 行。返回 supersede 条数。
    """
    ME = MemoryEventModel
    turn = aliased(ME)
    has_turn = select(turn.id).where(
        turn.task_id == TaskModel.id, turn.type == "agent_conversation_turn",
    ).exists()
    has_live_turn = select(turn.id).where(
        turn.task_id == TaskModel.id,
        turn.type == "agent_conversation_turn",
        turn.is_superseded == False,  # noqa: E712 — SQL boolean, not Python
    ).exists()
    folded_task_ids = select(TaskModel.id).where(
        TaskModel.status.in_(_TERMINAL_STATUSES), has_turn, ~has_live_turn,
    )
    result = await db.execute(
        update(ME)
        .where(
            ME.layer == "task",
            ME.type.in_(_CAPSULE_TYPES),
            ME.is_superseded == False,  # noqa: E712 — SQL boolean, not Python
            ME.task_id.in_(folded_task_ids),
        )
        .values(is_superseded=True)
    )
    return result.rowcount or 0


# composer 排序 history 的记录类型（决定 fold 摘要该锚在谁之前）。**排除** session 层
# blackboard_publish（不进排序 history，composer.py:305/307）与摘要自身；对齐 core 防御锚点
# 用的记录集（agent 回合 + task 层胶囊），使 m003 与 fold_root_experience 算出同一个锚。
_HISTORY_ANCHOR_TYPES = ("user_prompt", "task_compact_summary", "agent_conversation_turn")


async def _m003_reanchor_agent_summaries(db: AsyncSession) -> int:
    """把现存 live fold 摘要（AGENT_COMPACT_SUMMARY）错位的锚点时间戳就地归位。

    core fold 的锚点历史上只取「存活单元 agent 回合最早 ts」、漏了 task 层胶囊 ts；存量数据里某单元
    user 回合被折而 task 层 user_prompt 存活时，摘要会排到该 user_prompt 之后、不再是首条。core 防御
    锚点（fold_root_experience）已修将来的 fold，本迁移把**现存**那条摘要就地归位（否则要等下次压缩）。

    目标 ts = 该 agent 在排序 history 里最早的 live 记录（_HISTORY_ANCHOR_TYPES，**排除 session 层
    blackboard_publish 与摘要自身**）ts − 1µs——与 core 防御锚点同口径。仅当摘要现 ts ≥ 该最早 ts
    （确属错位）才移；已在最前的跳过（幂等）。只改 timestamp、不动 seq_no（recall 以 timestamp 为
    主键；改 seq_no 反而可能撞 (scope,seq_no)）。返回移动条数。
    """
    ME = MemoryEventModel
    summaries = (await db.execute(
        select(ME.id, ME.agent_id, ME.timestamp).where(
            ME.type == "agent_compact_summary",
            ME.is_superseded == False,  # noqa: E712 — SQL boolean, not Python
        )
    )).all()
    moved = 0
    for sid, agent_id, s_ts in summaries:
        earliest = (await db.execute(
            select(ME.timestamp).where(
                ME.agent_id == agent_id,
                ME.is_superseded == False,  # noqa: E712
                ME.type.in_(_HISTORY_ANCHOR_TYPES),
            ).order_by(ME.timestamp.asc()).limit(1)
        )).scalar_one_or_none()
        if earliest is None or s_ts < earliest:
            continue  # 无 history 记录 / 已在最前 → 幂等跳过
        await db.execute(
            update(ME).where(ME.id == sid).values(timestamp=earliest - timedelta(microseconds=1))
        )
        moved += 1
    return moved


# HITL 事件 payload 键（spec 2026-07-05）：approval_id → hitl_id；HitlRequired/SessionPausedHitl
# 补显式 form。事件**类型名**不变。本函数是全库唯一允许出现旧 key 与 wait_for_user sentinel
# 判断的地方（core/host 代码已只认 hitl_id/form）。
_HITL_PAYLOAD_EVENT_TYPES = (
    "HitlRequired", "HitlApproved", "HitlAnswered", "HitlRejected",
    "HitlModified", "HitlTimeout", "HitlCancelled", "SessionPausedHitl",
)
_FORM_BACKFILL_TYPES = ("HitlRequired", "SessionPausedHitl")


async def _m004_hitl_id_and_form(db: AsyncSession) -> int:
    """HITL 事件 payload 迁移：approval_id 换 key 为 hitl_id；补 form 字段；回填答案文本。

    form 推导 = 旧 kind + capability_id sentinel：kind=approval → approval；
    kind=input 且 capability_id 以 ':wait_for_user' 结尾 → wait；否则 → question。
    旧 kind 键保留在 payload 里（无害,新代码不读）。

    第二遍 `_m004_backfill_answer_messages`：HitlAnswered 缺 message 时从 SSE 流回填
    答复原文（旧版本应答只解内存 future、事件不记答案 → 冷决定查询判不可用,恢复重跑时
    已答过的问题重新弹框）。

    幂等：无 approval_id 且 form 已存在 → payload 不变、不计数；message 已存在不重写。
    降级注意：迁移后旧版二进制读不懂 hitl_id,回滚需还原 DB 备份（与 m001-m003 约定一致）。
    返回改写行数。
    """
    rows = (await db.execute(
        select(EventModel.id, EventModel.type, EventModel.payload_json)
        .where(EventModel.type.in_(_HITL_PAYLOAD_EVENT_TYPES))
    )).all()
    changed = 0
    for eid, etype, payload_json in rows:
        try:
            p = json.loads(payload_json or "{}")
        except ValueError:
            continue  # 坏行不炸迁移
        orig = dict(p)
        if "approval_id" in p:
            p["hitl_id"] = p.pop("approval_id")
        if etype in _FORM_BACKFILL_TYPES and "form" not in p:
            if str(p.get("capability_id", "")).endswith(":wait_for_user"):
                p["form"] = "wait"
            elif p.get("kind", "approval") == "approval":
                p["form"] = "approval"
            else:
                p["form"] = "question"
        if p != orig:
            await db.execute(
                update(EventModel).where(EventModel.id == eid)
                .values(payload_json=json.dumps(p, ensure_ascii=False))
            )
            changed += 1
    changed += await _m004_backfill_answer_messages(db)
    return changed


def _as_utc_naive(dt: datetime | None) -> datetime | None:
    """时间归一到 naive UTC 再比较（事件列 aware/naive 混存、SSE created_at 带 offset）。"""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _sse_text(content) -> str:
    """SSE message 帧的 content → 纯文本（str 原样;多模态 part 列表取 text 段拼接）。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            p.get("text", "") for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return ""


async def _m004_backfill_answer_messages(db: AsyncSession) -> int:
    """HitlAnswered 缺 message → 从 session_sse_events 回填答复原文。第一遍键归一后调用。

    判据（宁缺勿错）：应答时刻该 session **恰有这一条 pending** 才回填——多 pending 是
    0.4.19 应答入口固定 resolve pending[0] 的错配窗口,答复与问题的配对不可靠,保持重问。
    答案取该 session SSE 流中 created_at ∈ (required.ts, answered.ts] 的最后一条
    role=user 消息文本（应答入口先回显用户消息、再发 HitlAnswered,故必落在窗口内）;
    窗口内无消息则不臆造。回填后冷决定查询（fold_cold_hitl_decision）对该应答直接可用,
    恢复重跑不再重问。幂等：message 已存在（含本函数回填的）不重写。返回改写行数。
    """
    rows = (await db.execute(
        select(EventModel.id, EventModel.session_id, EventModel.type,
               EventModel.timestamp, EventModel.payload_json)
        .where(EventModel.type.in_(("HitlRequired", *_HITL_ALL_RESOLVE_TYPES)))
        .order_by(EventModel.id)
    )).all()

    # 单遍升序折叠 pending（键已归一为 hitl_id）,收集"单 pending 窗口且缺 message"的应答
    pending: dict[str, dict[str, datetime | None]] = {}  # session → {hitl_id: required_ts}
    todo: list[tuple[str, str, datetime | None, datetime | None, dict]] = []
    for row in rows:
        try:
            p = json.loads(row.payload_json or "{}")
        except ValueError:
            continue  # 坏行不炸迁移
        rid = p.get("hitl_id", "")
        if not rid:
            continue
        if row.type == "HitlRequired":
            pending.setdefault(row.session_id, {})[rid] = row.timestamp
            continue
        sess_pending = pending.get(row.session_id, {})
        if (row.type == "HitlAnswered" and not p.get("message")
                and set(sess_pending) == {rid}):
            todo.append((row.id, row.session_id, sess_pending[rid], row.timestamp, p))
        sess_pending.pop(rid, None)

    changed = 0
    sse_cache: dict[str, list[tuple[datetime, str]]] = {}  # session → [(created_at, text)] 升序
    for eid, sid, required_ts, answered_ts, p in todo:
        lo, hi = _as_utc_naive(required_ts), _as_utc_naive(answered_ts)
        if hi is None:
            continue  # 无应答时刻无法定窗口,不臆造
        if sid not in sse_cache:
            msgs: list[tuple[datetime, str]] = []
            for (evt_json,) in (await db.execute(
                select(SessionSSEEventModel.event_json)
                .where(SessionSSEEventModel.session_id == sid)
                .order_by(SessionSSEEventModel.id)
            )).all():
                try:
                    obj = json.loads(evt_json)
                except ValueError:
                    continue
                if obj.get("type") != "message" or obj.get("role") != "user":
                    continue
                try:
                    ts = _as_utc_naive(datetime.fromisoformat(obj.get("created_at", "")))
                except ValueError:
                    continue
                text_ = _sse_text(obj.get("content")).strip()
                if ts is not None and text_:
                    msgs.append((ts, text_))
            sse_cache[sid] = msgs
        answer = None
        for ts, text_ in sse_cache[sid]:
            if ts <= hi and (lo is None or ts > lo):
                answer = text_  # 升序扫描,留窗口内最后一条
        if answer is None:
            continue
        p["message"] = answer
        await db.execute(
            update(EventModel).where(EventModel.id == eid)
            .values(payload_json=json.dumps(p, ensure_ascii=False))
        )
        changed += 1
    return changed


# m005 判据用的 resolve 集合。应答型四类 = "用户回复过"的证据（HitlCancelled 来自
# interrupt/delete/GC 或 m005 自身,不算人工应答,否则重跑会把自插的 cancel 当证据误伤邻条）。
_HITL_REPLY_RESOLVE_TYPES = ("HitlApproved", "HitlModified", "HitlAnswered", "HitlRejected")
_HITL_ALL_RESOLVE_TYPES = (*_HITL_REPLY_RESOLVE_TYPES, "HitlCancelled")


async def _m005_cancel_stale_legacy_hitl(db: AsyncSession) -> int:
    """收口 0.4.19 及更早版本积压的僵尸 pending HITL：补插 HitlCancelled 事件行。

    旧 `/messages` 应答入口固定 resolve pending[0] 且一次回复只消一条,多 pending 时用户
    视觉上回答的请求可能从未收到 resolve 事件 → fold_pending_hitl 永远算它 pending,升级后
    被 recover/多 pending 面板整批翻出（用户报"已回答的 HITL 又出现"）。

    ①②为前提、③/③'满足其一才收口（宁保守勿误伤）：
    ① legacy 事件——payload 留有旧 ``kind`` 键（m004 保留;新代码只写 form）;
    ② 折叠后仍 pending;
    ③ 其后（按事件 ULID 序）同 session 存在**应答型** resolve——证明用户回复过、该条是错配遗留;
    ③' **重问副本**——同 (session, task, tool_call_id) 的另一条 Required 已被人工应答。
       来源：0.4.19 冷应答后重跑,ReconcileStep 以原 tool_call_id 重新 invoke dangling
       ask_user,而 find_for_tool_call 决定缓存是纯内存（重启只重建 pending、不重建已解决）
       → 未命中即重新登记,同一问题以新 hitl_id 重发。副本落在最后一次应答之后,③不成立,
       首版按"真悬挂"保留 → PAUSED_HITL 会话重现"已答复过的 HITL"。空 tool_call_id
       （wait 气泡）不参与匹配。
    其余尾部无应答的是真悬而未决,保留。**不看 SessionFinished**：它是每轮结束都发的
    （TaskManager._fire_session_done）,不是"会话终结"标记;僵尸场景（回答过→对话继续→轮次
    完成）必然带它,首版据此跳过导致真实数据零收口。fold/pending 面板也从不读它。

    收口方式=事件语义：插入 HitlCancelled（payload 带 reason 标记,causation_id 指回
    Required 行）,不改不删既有事件;fold 自然减掉。幂等：重跑时已插的 cancel 把该条折掉,
    且 cancel 不在应答型证据集合里。返回插入行数。
    """
    rows = (await db.execute(
        select(EventModel.id, EventModel.session_id, EventModel.task_id, EventModel.agent_id,
               EventModel.tenant_id, EventModel.type, EventModel.payload_json)
        .where(EventModel.type.in_(("HitlRequired", *_HITL_ALL_RESOLVE_TYPES)))
        .order_by(EventModel.id)
    )).all()

    # 单遍升序扫描：折 pending + 记每 session 最后一条应答型 resolve 的事件 id（判据③）
    # + 记已被人工应答的 (session, task, tool_call_id)（判据③',重问副本匹配键）
    pending: dict[str, dict[str, tuple]] = {}   # session_id → {hitl_id: (required_row, is_legacy)}
    last_reply_id: dict[str, str] = {}
    req_key: dict[str, tuple] = {}              # hitl_id → (session, task, tool_call_id),仅非空 tcid
    answered_keys: set[tuple] = set()
    for row in rows:
        try:
            p = json.loads(row.payload_json or "{}")
        except ValueError:
            continue  # 坏行不炸迁移
        rid = p.get("hitl_id", "")
        if not rid:
            continue
        if row.type == "HitlRequired":
            pending.setdefault(row.session_id, {})[rid] = (row, "kind" in p)
            tcid = p.get("tool_call_id") or ""
            if tcid:
                req_key[rid] = (row.session_id, row.task_id or "", tcid)
        else:
            pending.get(row.session_id, {}).pop(rid, None)
            if row.type in _HITL_REPLY_RESOLVE_TYPES:
                last_reply_id[row.session_id] = row.id  # 升序扫描,天然是最大值
                key = req_key.get(rid)
                if key is not None:
                    answered_keys.add(key)

    from ctx_weft.core.utils import generate_id
    now = datetime.now(timezone.utc)
    inserted = 0
    for sid, d in pending.items():
        last_reply = last_reply_id.get(sid, "")
        for rid, (row, is_legacy) in d.items():
            if not is_legacy:
                continue
            if req_key.get(rid) in answered_keys:
                reason = "m005_stale_reask_duplicate"   # ③' 同 tool_call_id 已被应答的重问副本
            elif last_reply > row.id:
                reason = "m005_stale_legacy_cleanup"    # ③ 其后有人工应答的错配遗留
            else:
                continue
            await db.execute(insert(EventModel).values(
                id=generate_id("evt"), run_id=None, session_id=sid,
                task_id=row.task_id, agent_id=row.agent_id,
                tenant_id=row.tenant_id or "default",
                type="HitlCancelled", sequence=0,
                payload_json=json.dumps(
                    {"hitl_id": rid, "reason": reason},
                    ensure_ascii=False),
                metadata_json="{}", causation_id=row.id, timestamp=now,
            ))
            inserted += 1
    return inserted


# m006 判据用的事件集。task 生命周期 → 回放状态（对齐 core TASK_STATUS_BY_EVENT）。
_M006_LIFECYCLE_STATUS = {
    "TaskStarted": "ACTIVE", "TaskResumed": "ACTIVE", "TaskSuspended": "SUSPENDED",
    "TaskRequeued": "PENDING", "TaskFinished": "FINISHED", "TaskFailed": "FAILED",
    "TaskCanceled": "CANCELED",
}
_M006_TERMINAL = ("FINISHED", "FAILED", "CANCELED")
_M006_CLOSE_EVENT_BY_STATUS = {
    "FINISHED": "TaskFinished", "FAILED": "TaskFailed", "CANCELED": "TaskCanceled",
}
_M006_SCAN_TYPES = (
    "TaskCreated", *_M006_LIFECYCLE_STATUS, "RunFinished",
    "SessionResumed", "SessionFinished", "HitlRequired", *_HITL_ALL_RESOLVE_TYPES,
)


async def _m006_close_stale_tasks(db: AsyncSession) -> int:
    """收口存量滞留非终态 task：补插对应终态事件行 + 同步投影行。

    历史发射缺口（运行崩溃只发 RunFinished 不发 TaskFailed[2026-06-18 才修]、老 interrupt
    不补 TaskCanceled）让"用户眼中已完成"的 task 在事件里滞留 ACTIVE/SUSPENDED；
    recover_session 的 restore 对非终态任务无条件重排成 PENDING 重跑（升级后被用户
    应答僵尸 HITL / 点恢复大面积触发 → "已完成的 task 变 pending 还重跑"）。

    两判据（满足其一即收口,宁保守勿误伤）：
    a) **死亡 run**——该 task 自身事件序的最后一条是 RunFinished 且 final_status 为终态
       （SUSPENDED=park/outage 挂起,不算死亡）→ 按 final_status 补同名终态事件,还原真相；
    b) **代际证据**——其后（按事件 ULID 序）同 session 有 SESSION_RESUMED（用户已开新一轮）
       或 SESSION_FINISHED（该轮已走完收尾,滞留者已被 TM 遗弃）→ 补 TaskCanceled。
       SessionFinished 是每轮结束都发的（_fire_session_done）,不是"会话终结"标记——首版把它
       当整会话跳过条件,导致真实数据（几乎每个会话都有完成轮次）零收口;硬中断/崩溃不经
       _fire_session_done、不会留下它,故崩溃恢复人群天然不受此证据波及。
    不动：已终态 / parked（仍有未决 HITL,真等待点）/
    最新一轮无死亡证据的滞留（合法崩溃恢复对象,restore 复活正是其设计语义）。

    收口方式=事件语义（与 m005 同）：插入终态事件行（reason 标记,causation_id 指回证据
    事件）,不改删既有事件;另把 tasks 投影行 status 改写为同值（投影与回放同为事件驱动,
    同一缺口两边都停在旧状态）。幂等：补插的终态使 task 重折为 terminal。返回收口任务数。
    """
    rows = (await db.execute(
        select(EventModel.id, EventModel.session_id, EventModel.task_id, EventModel.agent_id,
               EventModel.tenant_id, EventModel.type, EventModel.payload_json)
        .where(EventModel.type.in_(_M006_SCAN_TYPES))
        .order_by(EventModel.id)
    )).all()

    # 单遍升序扫描（全按事件 ULID 序）
    tasks: dict[str, dict[str, dict]] = {}      # session_id → {task_id: 状态账}
    last_gen: dict[str, str] = {}               # session_id → 最后一条代际证据事件 id
    pending: dict[str, dict[str, str]] = {}     # session_id → {hitl_id: task_id}（parked 判定）
    for row in rows:
        try:
            p = json.loads(row.payload_json or "{}")
        except ValueError:
            continue  # 坏行不炸迁移
        sid = row.session_id
        if row.type == "TaskCreated":
            tid = (p.get("task") or {}).get("id") or row.task_id
            if tid:
                tasks.setdefault(sid, {})[tid] = {
                    "status": (p.get("task") or {}).get("status", "PENDING"),
                    "last_eid": row.id, "agent_id": row.agent_id,
                    "tenant_id": row.tenant_id or "default", "dead_run": None,
                }
        elif row.type in _M006_LIFECYCLE_STATUS:
            e = tasks.get(sid, {}).get(row.task_id or "")
            if e is not None:  # 无 TaskCreated 的孤儿事件：回放也建不出该 task,跳过
                e["status"] = _M006_LIFECYCLE_STATUS[row.type]
                e["last_eid"] = row.id
                e["dead_run"] = None  # 后续生命周期出现 → 之前的 run 结局不再是"最后一条"
        elif row.type == "RunFinished":
            e = tasks.get(sid, {}).get(row.task_id or "")
            if e is not None:
                fs = p.get("final_status", "")
                # 终态 run=死亡证据；SUSPENDED(park/outage)/未知值 → 清空（最新 run 结局为准）
                e["dead_run"] = (row.id, fs) if fs in _M006_TERMINAL else None
        elif row.type in ("SessionResumed", "SessionFinished"):
            last_gen[sid] = row.id  # 升序扫描,天然是最大值
        elif row.type == "HitlRequired":
            rid = p.get("hitl_id", "")
            if rid:
                pending.setdefault(sid, {})[rid] = row.task_id or ""
        else:  # HITL resolve 五类
            rid = p.get("hitl_id", "")
            if rid:
                pending.get(sid, {}).pop(rid, None)

    from ctx_weft.core.utils import generate_id
    now = datetime.now(timezone.utc)
    closed = 0
    for sid, tmap in tasks.items():
        parked = {tid for tid in pending.get(sid, {}).values() if tid}
        for tid, e in tmap.items():
            if e["status"] in _M006_TERMINAL or tid in parked:
                continue
            if e["dead_run"] is not None:
                causation, close_status = e["dead_run"]
                reason = "m006_dead_run_backfill"
            elif last_gen.get(sid, "") > e["last_eid"]:
                causation, close_status = last_gen[sid], "CANCELED"
                reason = "m006_stale_turn_backfill"
            else:
                continue  # 最新一轮的滞留：合法崩溃恢复对象,保留
            await db.execute(insert(EventModel).values(
                id=generate_id("evt"), run_id=None, session_id=sid,
                task_id=tid, agent_id=e["agent_id"], tenant_id=e["tenant_id"],
                type=_M006_CLOSE_EVENT_BY_STATUS[close_status], sequence=0,
                payload_json=json.dumps({"reason": reason}, ensure_ascii=False),
                metadata_json="{}", causation_id=causation, timestamp=now,
            ))
            await db.execute(
                update(TaskModel).where(TaskModel.id == tid).values(status=close_status)
            )
            closed += 1
    return closed


async def _m009_backfill_task_metadata(db: AsyncSession) -> int:
    """从 RecognizeIntentToolCall 事件回填 tasks 表空缺的 title/description。

    修复前 ProjectionUpdater 只消费该事件的 session_goal、丢弃 title/description
    （tasks 列仅 TASK_CREATED 时写入,而 root task 创建时元数据为空、由 recognize_intent
    并发补填）→ 存量 root task 行的 title/description 永远空,导入/重启后任务面板无名。
    投影修复（2026-07-06）只管新事件,本迁移从事件 payload 回填存量真值——比续跑时
    recognize_intent 重新生成更准（历史原值,不依赖 LLM 重算）。

    判据：按事件 ULID 升序扫描,同 task 多条取最后一条（重试轮的最新元数据）;目标 =
    事件信封 task_id（recognize_intent 直跑在 root task 上;存量数据核验 67/67 均指向
    非 daemon root task）。**按字段独立回填且只填空字段**——已有值（手工或修复后代码
    写入）绝不覆盖。幂等：字段非空后重跑命中 0 行。返回改写的 task 行数。
    """
    rows = (await db.execute(
        select(EventModel.task_id, EventModel.payload_json)
        .where(EventModel.type == "RecognizeIntentToolCall")
        .order_by(EventModel.id)
    )).all()

    # task_id → 最后一条事件的 (title, description)（升序扫描,后写覆盖前写）
    latest: dict[str, tuple[str, str]] = {}
    for task_id, payload_json in rows:
        if not task_id:
            continue
        try:
            p = json.loads(payload_json or "{}")
        except ValueError:
            continue  # 坏行不炸迁移
        latest[task_id] = (p.get("title") or "", p.get("description") or "")

    changed = 0
    for task_id, (title, description) in latest.items():
        row = (await db.execute(
            select(TaskModel.title, TaskModel.description)
            .where(TaskModel.id == task_id)
        )).one_or_none()
        if row is None:
            continue  # 事件孤儿（task 行已删）
        values: dict[str, str] = {}
        if title and not (row[0] or ""):
            values["title"] = title
        if description and not (row[1] or ""):
            values["description"] = description
        if values:
            await db.execute(
                update(TaskModel).where(TaskModel.id == task_id).values(**values)
            )
            changed += 1
    return changed


def _canonical_tid(tid: str) -> str:
    return tid if ":" in tid else f"agent:{tid}"


async def _m010_canonical_template_id_prefix(db: AsyncSession) -> int:
    """模板加载改 cap.id 前缀精确路由（spec 2026-07-22）后，裸 template_id 一律
    TemplateNotFoundError。resume / 冷 HITL / 手动 compact 的 template_id 来自事件重放
    （SessionCreated 载荷）与快照（serialize_view 的 sessions.*.template_id），存量数据
    不迁移则旧会话全部不可恢复。

    改写两处：events.payload_json 顶层 "template_id" 键（防御性：不限事件类型）；
    snapshots.state_blob_json 的 sessions.*.template_id。
    幂等：已含 ':' 的 id 跳过，重跑命中 0 行。返回改写行数（events + snapshots）。
    """
    changed = 0

    rows = (await db.execute(
        select(EventModel.id, EventModel.payload_json)
        .where(EventModel.payload_json.like('%"template_id"%'))
    )).all()
    for eid, payload_json in rows:
        try:
            payload = json.loads(payload_json or "{}")
        except ValueError:
            continue
        tid = payload.get("template_id")
        if not isinstance(tid, str) or not tid or ":" in tid:
            continue
        payload["template_id"] = _canonical_tid(tid)
        await db.execute(
            update(EventModel).where(EventModel.id == eid)
            .values(payload_json=json.dumps(payload, ensure_ascii=False)))
        changed += 1

    from netlivecowork.persistence.postgres.models import SnapshotModel
    srows = (await db.execute(
        select(SnapshotModel.id, SnapshotModel.state_blob_json)
        .where(SnapshotModel.state_blob_json.like('%"template_id"%'))
    )).all()
    for sid, blob in srows:
        try:
            state = json.loads(blob or "{}")
        except ValueError:
            continue
        dirty = False
        for sess in (state.get("sessions") or {}).values():
            tid = sess.get("template_id")
            if isinstance(tid, str) and tid and ":" not in tid:
                sess["template_id"] = _canonical_tid(tid)
                dirty = True
        if dirty:
            await db.execute(
                update(SnapshotModel).where(SnapshotModel.id == sid)
                .values(state_blob_json=json.dumps(state, ensure_ascii=False)))
            changed += 1

    return changed


async def _m011_repair_observer_notice_reason(db: AsyncSession) -> int:
    """修补旧版 failed notice 的 reason_text：过程复述/裸兜底 → 真死因。

    2026-07-22 前 core 把 verdict.act_recap（过程复述）当 TASK_FAILED.error_message 发，
    host 直落 session_notice.reason_text——通告框把「actor 做了什么」展示成了死因；
    act_recap 为空时落裸「会话失败」。observer 专门写的根因（report_task_outcome 的
    task_failure_reason）没进事件链，但其工具调用以 observer_control_tool_call 帧
    带全参持久化在同一 SSE 流里——本迁移从那里取材，就地改写 notice 帧。

    指纹判定（宁缺勿错，只认旧帧特征）：kind=failed 且 reason_code=TASK_FAILED_BY_OBSERVER
    的 notice，其 reason_text 恰等于**前方最近一次** fail 判决帧的 act_recap（旧路径逐字
    透传）或裸「会话失败」（act_recap 为空的旧兜底）→ 改写为该判决的 task_failure_reason，
    没写则用 _OBSERVER_FAIL_FALLBACK 固定提示。修复后的新帧（真死因/固定文案）不再命中
    指纹；无判决帧可取材（规则 observe 判死）不动。「最近一次判决」与 notice 合成时的
    _last_task_failure（最后一次失败即死因）同语义。幂等：改写后指纹失配，重跑命中 0 行。
    返回改写帧数。
    """
    from netlivecowork.api.models.session import _OBSERVER_FAIL_FALLBACK

    sids = [r[0] for r in (await db.execute(
        select(SessionSSEEventModel.session_id).distinct()
        .where(SessionSSEEventModel.event_json.like('%TASK_FAILED_BY_OBSERVER%'))
    )).all()]

    changed = 0
    for sid in sids:
        rows = (await db.execute(
            select(SessionSSEEventModel.id, SessionSSEEventModel.event_json)
            .where(SessionSSEEventModel.session_id == sid)
            .order_by(SessionSSEEventModel.id)
        )).all()
        last_fail: dict | None = None   # 最近一次 fail 判决的 arguments
        for rid, ej in rows:
            try:
                ev = json.loads(ej)
            except ValueError:
                continue  # 坏行不炸迁移
            t = ev.get("type")
            # tool_name 子串匹配：不同时期序列化口径有裸名/带 control__ 前缀两种
            if t in ("observer_control_tool_call", "control_tool_call"):
                if "report_task_outcome" in (ev.get("tool_name") or ""):
                    args = ev.get("arguments") or {}
                    if args.get("task_status") == "fail":
                        last_fail = args
            elif (t == "session_notice" and ev.get("kind") == "failed"
                  and ev.get("reason_code") == "TASK_FAILED_BY_OBSERVER"
                  and last_fail is not None
                  and ev.get("reason_text") in (
                      (last_fail.get("act_recap") or ""), "会话失败")):
                new_text = last_fail.get("task_failure_reason") or _OBSERVER_FAIL_FALLBACK
                if new_text == ev.get("reason_text"):
                    continue  # 判决两字段同文的病理场景：改写无义,不计数
                ev["reason_text"] = new_text
                await db.execute(
                    update(SessionSSEEventModel)
                    .where(SessionSSEEventModel.id == rid)
                    .values(event_json=json.dumps(ev, ensure_ascii=False)))
                changed += 1
    return changed


# 有序注册表：(migration_id, coro)。追加即可，勿改既有 id / 顺序。
# 注：m007/m008 曾登记后撤销（workspace 重登记,见 6050e9c）,id 已烧掉、永不复用。
MIGRATIONS: list[tuple[str, object]] = [
    ("m001_supersede_legacy_terminal_task_raw", _m001_supersede_legacy_terminal_task_raw),
    ("m002_supersede_folded_task_capsules", _m002_supersede_folded_task_capsules),
    ("m003_reanchor_agent_summaries", _m003_reanchor_agent_summaries),
    ("m004_hitl_id_and_form", _m004_hitl_id_and_form),
    ("m005_cancel_stale_legacy_hitl", _m005_cancel_stale_legacy_hitl),
    ("m006_close_stale_tasks", _m006_close_stale_tasks),
    ("m009_backfill_task_metadata", _m009_backfill_task_metadata),
    ("m010_canonical_template_id_prefix", _m010_canonical_template_id_prefix),
    ("m011_repair_observer_notice_reason", _m011_repair_observer_notice_reason),
]


async def run_pending(factory: async_sessionmaker, *, dry_run: bool = False) -> dict[str, int]:
    """按注册顺序跑所有未应用的迁移。返回 {migration_id: affected_rows}（只含本次跑的）。

    dry_run=True：执行迁移的写、读出影响行数后**回滚**，且不落 applied 标记（只报数、不改库）。
    """
    async with factory() as db:
        await db.execute(text(
            "CREATE TABLE IF NOT EXISTS applied_migrations "
            "(id TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)"
        ))
        await db.commit()
        done = {r[0] for r in (await db.execute(text("SELECT id FROM applied_migrations"))).all()}

    results: dict[str, int] = {}
    for mid, fn in MIGRATIONS:
        if mid in done:
            continue
        async with factory() as db:
            if dry_run:
                n = await fn(db)
                await db.rollback()
            else:
                async with db.begin():
                    n = await fn(db)
                    await db.execute(
                        text("INSERT INTO applied_migrations (id) VALUES (:id)"), {"id": mid})
        results[mid] = n
        logger.info(
            "migration %s: %s %d row(s)%s",
            mid, "would affect" if dry_run else "applied,", n,
            " (dry-run, rolled back)" if dry_run else "",
        )
    return results
