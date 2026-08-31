"""m001 legacy task-layer raw supersession migration.

Verifies the backfill of finalize._supersede_final_raw_segment for pre-existing
(v0.4.12) data: terminal tasks' raw is soft-deleted, capsule kept, in-flight tasks
untouched, and the run is idempotent / dry-run is side-effect-free.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text, update

from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.migrations import run_pending
from netlivecowork.persistence.postgres.models import EventModel, MemoryEventModel, SessionModel, TaskModel

_RAW = ("llm_response", "tool_invocation", "tool_result")
_CAPSULE = ("user_prompt", "task_compact_summary")


async def _factory(tmp_path):
    return await init_db(f"sqlite:///{(tmp_path / 'mig.db').as_posix()}")


async def _seed_task(factory, *, task_id: str, status: str) -> None:
    """One task + a full task-layer body (2 capsule rows + 3 raw rows), all active."""
    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id="ses_1", user_prompt="seed"))  # FK target (idempotent)
            db.add(TaskModel(id=task_id, session_id="ses_1", status=status))
            seq = 0
            for typ in (*_CAPSULE, *_RAW):
                seq += 1
                db.add(MemoryEventModel(
                    id=f"mev_{task_id}_{typ}", session_id="ses_1", task_id=task_id,
                    agent_id="agt_1", layer="task", type=typ, role="user",
                    content=f"{typ} body", seq_no=seq, is_superseded=False,
                ))


async def _superseded(factory, task_id: str) -> dict[str, bool]:
    async with factory() as db:
        rows = (await db.execute(
            select(MemoryEventModel.type, MemoryEventModel.is_superseded)
            .where(MemoryEventModel.task_id == task_id))).all()
    return {t: bool(s) for t, s in rows}


async def test_terminal_raw_superseded_capsule_and_active_untouched(tmp_path):
    factory = await _factory(tmp_path)
    await _seed_task(factory, task_id="tsk_done", status="FINISHED")
    await _seed_task(factory, task_id="tsk_live", status="ACTIVE")

    applied = await run_pending(factory)
    assert applied["m001_supersede_legacy_terminal_task_raw"] == 3  # 3 raw rows of the FINISHED task

    done = await _superseded(factory, "tsk_done")
    assert all(done[t] for t in _RAW), "terminal task raw must be superseded"
    assert not any(done[t] for t in _CAPSULE), "capsule (user_prompt + summary) must survive"

    live = await _superseded(factory, "tsk_live")
    assert not any(live.values()), "in-flight task must be entirely untouched"


async def test_failed_and_canceled_are_terminal(tmp_path):
    factory = await _factory(tmp_path)
    await _seed_task(factory, task_id="tsk_failed", status="FAILED")
    await _seed_task(factory, task_id="tsk_cancel", status="CANCELED")
    await _seed_task(factory, task_id="tsk_susp", status="SUSPENDED")

    n = (await run_pending(factory))["m001_supersede_legacy_terminal_task_raw"]
    assert n == 6  # 3 raw each for FAILED + CANCELED; SUSPENDED excluded

    assert not any((await _superseded(factory, "tsk_susp")).values())


async def test_idempotent(tmp_path):
    factory = await _factory(tmp_path)
    await _seed_task(factory, task_id="tsk_done", status="FINISHED")

    first = await run_pending(factory)
    assert first["m001_supersede_legacy_terminal_task_raw"] == 3
    second = await run_pending(factory)
    assert second == {}  # already applied → not re-run


async def _seed_agent_turns(factory, *, task_id: str, superseded: list[bool]) -> None:
    """Append agent-layer conversation turns to a task (fold state = per-turn is_superseded)."""
    async with factory() as db:
        async with db.begin():
            base = 100
            for i, sup in enumerate(superseded):
                db.add(MemoryEventModel(
                    id=f"mev_turn_{task_id}_{i}", session_id="ses_1", task_id=task_id,
                    agent_id="agt_1", layer="agent", type="agent_conversation_turn",
                    role="assistant", content=f"turn {i}", seq_no=base + i, is_superseded=sup,
                ))


async def test_m002_supersedes_folded_task_capsules(tmp_path):
    factory = await _factory(tmp_path)
    # folded terminal task: all agent turns superseded → capsule (user_prompt) must go
    await _seed_task(factory, task_id="tsk_folded", status="FINISHED")
    await _seed_agent_turns(factory, task_id="tsk_folded", superseded=[True, True, True])
    # kept terminal task: has a live agent turn → capsule stays
    await _seed_task(factory, task_id="tsk_kept", status="FINISHED")
    await _seed_agent_turns(factory, task_id="tsk_kept", superseded=[True, True, False])
    # terminal task with NO agent turns → ambiguous, untouched
    await _seed_task(factory, task_id="tsk_noturn", status="FINISHED")
    # in-flight task → never touched
    await _seed_task(factory, task_id="tsk_live", status="ACTIVE")
    await _seed_agent_turns(factory, task_id="tsk_live", superseded=[True, True])

    applied = await run_pending(factory)
    # m001 supersedes raw of all 3 FINISHED tasks (3×3=9); m002 supersedes 1 capsule type
    # that is still live on the folded task: user_prompt (task_compact_summary already... it's a
    # capsule seeded live too → both user_prompt + task_compact_summary superseded = 2).
    assert applied["m002_supersede_folded_task_capsules"] == 2  # user_prompt + task_compact_summary

    folded = await _superseded(factory, "tsk_folded")
    assert all(folded[t] for t in _CAPSULE), "folded task capsule must be superseded"
    kept = await _superseded(factory, "tsk_kept")
    assert not any(kept[t] for t in _CAPSULE), "kept task (live turn) capsule must survive"
    noturn = await _superseded(factory, "tsk_noturn")
    assert not any(noturn[t] for t in _CAPSULE), "task with no agent turns is untouched"

    # idempotent
    again = await run_pending(factory)
    assert "m002_supersede_folded_task_capsules" not in again


async def _supersede(factory, task_id: str, types: tuple[str, ...]) -> None:
    async with factory() as db:
        async with db.begin():
            await db.execute(update(MemoryEventModel)
                .where(MemoryEventModel.task_id == task_id, MemoryEventModel.type.in_(types))
                .values(is_superseded=True))


async def test_m002_noop_on_healthy_current_code_data(tmp_path):
    """当前代码 fold/demote 时会连 task 层胶囊一并 supersede（compact.py:332-335 / 387-389），故
    「agent 回合全 superseded 且胶囊仍 live」这一状态在健康新数据里根本不存在 → m002 是 no-op。
    这正面回答「m002 会不会误伤新数据」：其判据只匹配 v0.4.12 的不变量违背，健康数据永不命中。"""
    factory = await _factory(tmp_path)
    # 健康的已折 task：agent 回合全 superseded，且胶囊也已 superseded（当前 fold 的原子行为）
    await _seed_task(factory, task_id="tsk_hfold", status="FINISHED")
    await _seed_agent_turns(factory, task_id="tsk_hfold", superseded=[True, True])
    await _supersede(factory, "tsk_hfold", _CAPSULE)
    # 健康的已降级 kept task：user_prompt superseded，tool 槽 live（lean 表示）
    await _seed_task(factory, task_id="tsk_demoted", status="FINISHED")
    await _seed_agent_turns(factory, task_id="tsk_demoted", superseded=[True, False])  # 1 live turn
    await _supersede(factory, "tsk_demoted", ("user_prompt",))

    applied = await run_pending(factory)
    assert applied.get("m002_supersede_folded_task_capsules", 0) == 0  # 健康数据零命中

    # 且 demoted task 的 live tool 槽仍在（未被误折）
    live = await _superseded(factory, "tsk_demoted")
    assert live.get("task_compact_summary") is False, "demoted task's remaining capsule survives"


async def test_m003_reanchors_summary_before_history_excluding_blackboard(tmp_path):
    """m003 把 live fold 摘要锚到该 agent 排序 history 里最早的 live 记录之前——**排除 blackboard**；
    已在最前的摘要跳过（幂等守卫）。"""
    factory = await _factory(tmp_path)
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def ev(i, agent, typ, layer, off, sup=False):
        return MemoryEventModel(
            id=f"mev_{i}", session_id="ses_1", task_id=f"tsk_{agent}", agent_id=agent,
            layer=layer, type=typ, role="user", content=typ, seq_no=i, is_superseded=sup,
            timestamp=base + timedelta(seconds=off))

    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id="ses_1", user_prompt="seed"))
            # agt_1: mis-anchored summary (@130) sits after user_prompt(@100); blackboard(@0) is EARLIER
            # but session-layer → must be ignored (else summary wrongly dragged to 0).
            db.add(ev(1, "agt_1", "blackboard_publish", "session", 0))
            db.add(ev(2, "agt_1", "user_prompt", "task", 100))
            db.add(ev(3, "agt_1", "agent_conversation_turn", "agent", 150))
            db.add(ev(4, "agt_1", "agent_compact_summary", "agent", 130))
            # agt_2: summary(@199) already before its earliest history(@200) → skipped (idempotent).
            db.add(ev(5, "agt_2", "user_prompt", "task", 200))
            db.add(ev(6, "agt_2", "agent_compact_summary", "agent", 199))

    applied = await run_pending(factory)
    assert applied["m003_reanchor_agent_summaries"] == 1  # only agt_1 moved; agt_2 already correct

    async with factory() as db:
        s1 = (await db.execute(select(MemoryEventModel.timestamp)
              .where(MemoryEventModel.id == "mev_4"))).scalar_one()
        s2 = (await db.execute(select(MemoryEventModel.timestamp)
              .where(MemoryEventModel.id == "mev_6"))).scalar_one()
    # SQLite 的 DateTime 往返成 naive；跨后端统一去 tz 再比。
    def naive(dt):
        return dt.replace(tzinfo=None)
    b = naive(base)
    # agt_1 anchored just before user_prompt@100 — NOT blackboard@0
    assert naive(s1) == b + timedelta(seconds=100) - timedelta(microseconds=1)
    assert naive(s1) > b  # definitely not dragged to the blackboard's t=0
    # agt_2 untouched
    assert naive(s2) == b + timedelta(seconds=199)

    # gated: re-run does not re-apply
    assert "m003_reanchor_agent_summaries" not in await run_pending(factory)


async def test_dry_run_reports_but_does_not_write(tmp_path):
    factory = await _factory(tmp_path)
    await _seed_task(factory, task_id="tsk_done", status="FINISHED")

    dry = await run_pending(factory, dry_run=True)
    assert dry["m001_supersede_legacy_terminal_task_raw"] == 3

    # nothing changed …
    done = await _superseded(factory, "tsk_done")
    assert not any(done[t] for t in _RAW)
    # … and no marker was written, so a real run still applies
    async with factory() as db:
        marks = (await db.execute(text("SELECT id FROM applied_migrations"))).all()
    assert marks == []
    real = await run_pending(factory)
    assert real["m001_supersede_legacy_terminal_task_raw"] == 3


async def test_m004_rewrites_hitl_payloads(tmp_path):
    """approval_id→hitl_id 换 key；HitlRequired/SessionPausedHitl 补 form；幂等。"""
    import json

    from netlivecowork.persistence.postgres.migrations import _m004_hitl_id_and_form

    factory = await _factory(tmp_path)

    async with factory() as db:
        async with db.begin():
            db.add_all([
                EventModel(id="e1", session_id="s1", type="HitlRequired", sequence=1,
                           payload_json=json.dumps({"approval_id": "h1", "kind": "input",
                                                    "capability_id": "control:wait_for_user"})),
                EventModel(id="e2", session_id="s1", type="HitlRequired", sequence=2,
                           payload_json=json.dumps({"approval_id": "h2", "kind": "approval",
                                                    "capability_id": "fs:bash_exec"})),
                EventModel(id="e3", session_id="s1", type="SessionPausedHitl", sequence=3,
                           payload_json=json.dumps({"kind": "input", "capability_id": "control:ask_user"})),
                EventModel(id="e4", session_id="s1", type="HitlAnswered", sequence=4,
                           payload_json=json.dumps({"approval_id": "h1"})),
                EventModel(id="e5", session_id="s1", type="TaskStarted", sequence=5,
                           payload_json=json.dumps({"approval_id": "unrelated"})),  # 非 HITL 类型:不碰
                EventModel(id="e6", session_id="s1", type="HitlRequired", sequence=6,
                           payload_json=json.dumps({"approval_id": "h6",
                                                    "capability_id": "control:wait_for_user"})),  # 无 kind
            ])

    applied = await run_pending(factory)
    assert applied["m004_hitl_id_and_form"] == 5  # e1,e2,e3,e4,e6 改写；e5 非 HITL 类型不碰

    async with factory() as db:
        rows = {r.id: json.loads(r.payload_json) for r in
                (await db.execute(select(EventModel))).scalars()}
    assert rows["e1"] == {"hitl_id": "h1", "kind": "input",
                          "capability_id": "control:wait_for_user", "form": "wait"}
    assert rows["e2"]["hitl_id"] == "h2" and rows["e2"]["form"] == "approval"
    assert rows["e3"]["form"] == "question" and "hitl_id" not in rows["e3"]
    assert rows["e4"] == {"hitl_id": "h1"}
    assert rows["e5"] == {"approval_id": "unrelated"}  # 非 HITL 事件不动
    assert rows["e6"]["hitl_id"] == "h6" and rows["e6"]["form"] == "wait"  # 无 kind: wait sentinel 前置生效

    # gated: 重跑不再计入 run_pending
    assert "m004_hitl_id_and_form" not in await run_pending(factory)

    # 幂等：绕开 applied 标记单独调函数也应 0 变更
    async with factory() as db:
        assert await _m004_hitl_id_and_form(db) == 0


async def test_m004_backfills_answer_message_from_sse(tmp_path):
    """HitlAnswered 缺 message → 单 pending 窗口时从 SSE 流回填答复原文；多 pending 不回填。"""
    import json

    from netlivecowork.persistence.postgres.migrations import _m004_hitl_id_and_form
    from netlivecowork.persistence.postgres.models import SessionSSEEventModel

    factory = await _factory(tmp_path)
    t = lambda m: datetime(2026, 7, 3, 10, m, tzinfo=timezone.utc)  # noqa: E731

    def ev(eid, sid, etype, seq, payload, ts):
        e = _hitl_ev(eid, sid, etype, seq, payload)
        e.timestamp = ts
        return e

    def sse(sid, role, content, ts):
        return SessionSSEEventModel(session_id=sid, event_json=json.dumps(
            {"type": "message", "role": role, "content": content,
             "created_at": ts.isoformat()}))

    async with factory() as db:
        async with db.begin():
            db.add_all([
                # s9: 单 pending 窗口,应答缺 message → 回填
                ev("evt_a1", "s9", "HitlRequired", 1,
                   {"approval_id": "hq1", "kind": "input",
                    "capability_id": "control:ask_user"}, t(0)),
                ev("evt_a2", "s9", "HitlAnswered", 2, {"approval_id": "hq1"}, t(5)),
                # s10: 应答时刻双 pending（错配窗口）→ 不回填
                ev("evt_b1", "s10", "HitlRequired", 1,
                   {"approval_id": "hm1", "kind": "input",
                    "capability_id": "control:ask_user"}, t(0)),
                ev("evt_b2", "s10", "HitlRequired", 2,
                   {"approval_id": "hm2", "kind": "input",
                    "capability_id": "control:ask_user"}, t(1)),
                ev("evt_b3", "s10", "HitlAnswered", 3, {"approval_id": "hm1"}, t(5)),
                # s11: 已带 message → 不动
                ev("evt_c1", "s11", "HitlRequired", 1,
                   {"approval_id": "hk1", "kind": "input",
                    "capability_id": "control:ask_user"}, t(0)),
                ev("evt_c2", "s11", "HitlAnswered", 2,
                   {"approval_id": "hk1", "message": "already"}, t(5)),
                # s12: 窗口内无 user 消息 → 找不到答案,不回填
                ev("evt_d1", "s12", "HitlRequired", 1,
                   {"approval_id": "hn1", "kind": "input",
                    "capability_id": "control:ask_user"}, t(0)),
                ev("evt_d2", "s12", "HitlAnswered", 2, {"approval_id": "hn1"}, t(5)),
            ])
            db.add_all([
                sse("s9", "assistant", "question bubble", t(0)),
                sse("s9", "user", "my real answer", t(4)),      # 窗口内最后一条 user 消息
                sse("s9", "user", "later chatter", t(9)),        # 应答之后:不取
                sse("s10", "user", "ambiguous answer", t(4)),
                sse("s12", "user", "too early", t(0)),           # 早于 Required 同刻:不在 (required, answered] 窗口
            ])

    await run_pending(factory)

    async with factory() as db:
        rows = {r.id: json.loads(r.payload_json) for r in
                (await db.execute(select(EventModel).where(
                    EventModel.type == "HitlAnswered"))).scalars()}
    assert rows["evt_a2"]["message"] == "my real answer"
    assert "message" not in rows["evt_b3"]            # 多 pending:宁缺勿错
    assert rows["evt_c2"]["message"] == "already"     # 已有答案不覆盖
    assert "message" not in rows["evt_d2"]            # 窗口无消息:不臆造

    # 幂等：绕开 applied 标记单独再调 → 0 变更
    async with factory() as db:
        assert await _m004_hitl_id_and_form(db) == 0


# ── m005: 存量僵尸 HITL pending 清收 ──────────────────────────────────────────
# 0.4.19 应答入口固定 resolve pending[0]、一次回复只消一条 → 事件库积压"从未被 resolve"
# 的 HitlRequired（用户视觉上已回答）。m005 只对满足三判据的条目补插 HitlCancelled 收口：
# ① legacy 事件（payload 留有旧 kind 键,新代码只写 form）② 仍 pending ③ 其后同 session
# 存在人工应答型 resolve（Answered/Approved/Modified/Rejected —— 证明用户回复过、被错配）。


def _hitl_ev(eid: str, session: str, etype: str, seq: int, payload: dict,
             task_id: str | None = None) -> EventModel:
    import json
    return EventModel(id=eid, session_id=session, task_id=task_id,
                      type=etype, sequence=seq, payload_json=json.dumps(payload))


async def test_m005_cancels_stale_legacy_pendings(tmp_path):
    """有后续人工应答的 legacy 僵尸被补 HitlCancelled；其后无应答的真悬挂保留。"""
    import json

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                # 原始 0.4.19 形状（approval_id+kind）——同一次 run_pending 里 m004 先迁移
                _hitl_ev("evt_0001", "s1", "HitlRequired", 1,
                         {"approval_id": "h1", "kind": "input",
                          "capability_id": "control:ask_user", "question": "Q1"},
                         task_id="tsk_a"),
                _hitl_ev("evt_0002", "s1", "HitlRequired", 2,
                         {"approval_id": "h2", "kind": "approval",
                          "capability_id": "fs:bash_exec"}),
                # 用户在 h1 之后回复过（h2 被 resolve）→ h1 属错配僵尸
                _hitl_ev("evt_0003", "s1", "HitlAnswered", 3, {"approval_id": "h2"}),
                # h4 之后再无人工应答 → 真悬而未决，保留
                _hitl_ev("evt_0004", "s1", "HitlRequired", 4,
                         {"approval_id": "h4", "kind": "input",
                          "capability_id": "control:ask_user"}),
            ])

    applied = await run_pending(factory)
    assert applied["m005_cancel_stale_legacy_hitl"] == 1  # 只有 h1

    async with factory() as db:
        cancels = (await db.execute(
            select(EventModel).where(EventModel.type == "HitlCancelled"))).scalars().all()
    assert len(cancels) == 1
    c = cancels[0]
    p = json.loads(c.payload_json)
    assert p["hitl_id"] == "h1"
    assert p["reason"] == "m005_stale_legacy_cleanup"
    assert c.session_id == "s1"
    assert c.task_id == "tsk_a"          # 从 Required 行拷贝
    assert c.causation_id == "evt_0001"  # 指回被收口的 Required
    assert c.id > "evt_0004"             # ULID 排序在存量事件之后 → fold 时才生效


async def test_m005_keeps_new_era_pendings(tmp_path):
    """新代码产生的 pending（无 kind 键）不动——即使悬挂且其后有应答。"""
    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                _hitl_ev("evt_0101", "s2", "HitlRequired", 1,
                         {"hitl_id": "n1", "form": "question"}),
                _hitl_ev("evt_0102", "s2", "HitlRequired", 2,
                         {"hitl_id": "n2", "form": "question"}),
                _hitl_ev("evt_0103", "s2", "HitlAnswered", 3, {"hitl_id": "n2"}),
            ])

    applied = await run_pending(factory)
    assert applied["m005_cancel_stale_legacy_hitl"] == 0

    async with factory() as db:
        cancels = (await db.execute(
            select(EventModel.id).where(EventModel.type == "HitlCancelled"))).all()
    assert cancels == []


async def test_m005_closes_zombies_in_sessions_with_finished_turns(tmp_path):
    """回归：SessionFinished 是**每轮结束**都发的（TaskManager._fire_session_done），不是
    "会话永久关闭"标记。僵尸场景（用户回答过→对话继续→轮次完成）必然带 SessionFinished，
    首版 m005 据此整会话跳过 → 真实数据上零收口。会话有 SessionFinished 也必须照常清收。"""
    import json

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                # 第一轮：h1 展示给用户,用户回答,0.4.19 却 resolve 了 pending[0]=h0 → h1 成僵尸
                _hitl_ev("evt_0041", "s5", "HitlRequired", 1,
                         {"approval_id": "h0", "kind": "input",
                          "capability_id": "control:wait_for_user"}),
                _hitl_ev("evt_0042", "s5", "HitlRequired", 2,
                         {"approval_id": "h1", "kind": "input",
                          "capability_id": "control:ask_user", "question": "Q1"}),
                _hitl_ev("evt_0043", "s5", "HitlAnswered", 3, {"approval_id": "h0"}),
                # 轮次正常完成 → SessionFinished（每轮都发）
                _hitl_ev("evt_0044", "s5", "SessionFinished", 4, {"final_status": "SUCCEEDED"}),
                # 用户又开新轮
                _hitl_ev("evt_0045", "s5", "SessionResumed", 5, {"user_prompt": "next"}),
            ])

    applied = await run_pending(factory)
    assert applied["m005_cancel_stale_legacy_hitl"] == 1  # h1 必须被收口

    async with factory() as db:
        cancels = (await db.execute(
            select(EventModel).where(EventModel.type == "HitlCancelled"))).scalars().all()
    assert len(cancels) == 1
    assert json.loads(cancels[0].payload_json)["hitl_id"] == "h1"
    assert cancels[0].causation_id == "evt_0042"


async def test_m005_idempotent_own_cancels_are_not_reply_evidence(tmp_path):
    """重跑 0 变更：自己插入的 HitlCancelled 既折掉已收口者，也不得当作"人工应答证据"
    误伤仍悬挂的邻条（HitlCancelled 不在应答型 resolve 集合里）。"""
    from netlivecowork.persistence.postgres.migrations import _m005_cancel_stale_legacy_hitl

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                _hitl_ev("evt_0031", "s4", "HitlRequired", 1,
                         {"approval_id": "h1", "kind": "input",
                          "capability_id": "control:ask_user"}),
                _hitl_ev("evt_0032", "s4", "HitlAnswered", 2, {"approval_id": "hx"}),
                # h3 其后无人工应答 → 首跑保留；首跑插入的 h1-cancel 排序在 h3 之后,
                # 二跑不得因此把 h3 判为 stale
                _hitl_ev("evt_0033", "s4", "HitlRequired", 3,
                         {"approval_id": "h3", "kind": "input",
                          "capability_id": "control:ask_user"}),
            ])

    applied = await run_pending(factory)
    assert applied["m005_cancel_stale_legacy_hitl"] == 1  # 只收 h1

    # gated：重跑 run_pending 不再执行
    assert "m005_cancel_stale_legacy_hitl" not in await run_pending(factory)

    # 幂等：绕开 applied 标记单独调函数,0 变更（h1 已折掉、h3 不被自插 cancel 误伤）
    async with factory() as db:
        assert await _m005_cancel_stale_legacy_hitl(db) == 0
    async with factory() as db:
        cancels = (await db.execute(
            select(EventModel.id).where(EventModel.type == "HitlCancelled"))).all()
    assert len(cancels) == 1


async def test_m005_cancels_reask_duplicates_after_reply(tmp_path):
    """回归：判据③（其后有应答）的盲区——0.4.19 冷应答后重跑,ReconcileStep 以**原
    tool_call_id** 重新 invoke dangling ask_user,而 find_for_tool_call 决定缓存是纯内存
    （重启只重建 pending、不重建已解决）→ 未命中即重新登记 → **同一问题以新 hitl_id 重发
    HitlRequired**。重问副本落在用户最后一次应答之后,③不成立,首版按"真悬挂"保留 →
    PAUSED_HITL 会话重现"已答复过的 HITL"。同 (session,task,tool_call_id) 已被人工应答
    → 后续 pending 副本必须收口;新 tool_call_id 的尾部悬挂仍是真悬挂,保留。"""
    import json

    from netlivecowork.persistence.postgres.migrations import _m005_cancel_stale_legacy_hitl

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                # 原问 + 用户已应答
                _hitl_ev("evt_0061", "s6", "HitlRequired", 1,
                         {"approval_id": "h_a", "kind": "input",
                          "capability_id": "control:ask_user",
                          "tool_call_id": "tc_77", "question": "Q"},
                         task_id="tsk_r"),
                _hitl_ev("evt_0062", "s6", "HitlAnswered", 2, {"approval_id": "h_a"}),
                # 重启后 reconcile 重问：同 tool_call_id、新 hitl_id,落在应答之后 → 副本,须收口
                _hitl_ev("evt_0063", "s6", "HitlRequired", 3,
                         {"approval_id": "h_b", "kind": "input",
                          "capability_id": "control:ask_user",
                          "tool_call_id": "tc_77", "question": "Q"},
                         task_id="tsk_r"),
                # 尾部真悬挂：不同 tool_call_id、从未被应答 → 保留
                _hitl_ev("evt_0064", "s6", "HitlRequired", 4,
                         {"approval_id": "h_c", "kind": "input",
                          "capability_id": "control:ask_user",
                          "tool_call_id": "tc_88", "question": "Q2"},
                         task_id="tsk_r"),
                # 空 tool_call_id 不参与匹配（wait 气泡无 tcid,不得因"另一条空 tcid 被答"误伤）
                _hitl_ev("evt_0071", "s7", "HitlRequired", 1,
                         {"approval_id": "h_w1", "kind": "input",
                          "capability_id": "control:wait_for_user"}),
                _hitl_ev("evt_0072", "s7", "HitlAnswered", 2, {"approval_id": "h_w1"}),
                _hitl_ev("evt_0073", "s7", "HitlRequired", 3,
                         {"approval_id": "h_w2", "kind": "input",
                          "capability_id": "control:wait_for_user"}),
            ])

    applied = await run_pending(factory)
    assert applied["m005_cancel_stale_legacy_hitl"] == 1  # 只有 h_b（重问副本）

    async with factory() as db:
        cancels = (await db.execute(
            select(EventModel).where(EventModel.type == "HitlCancelled"))).scalars().all()
    assert len(cancels) == 1
    c = cancels[0]
    p = json.loads(c.payload_json)
    assert p["hitl_id"] == "h_b"
    assert p["reason"] == "m005_stale_reask_duplicate"
    assert c.causation_id == "evt_0063"  # 指回重问副本的 Required

    # 幂等：副本已被自插 cancel 折掉;h_c/h_w2 不被误伤
    async with factory() as db:
        assert await _m005_cancel_stale_legacy_hitl(db) == 0


# ── m006: 存量滞留非终态 task 收口 ────────────────────────────────────────────
# 历史发射缺口（运行崩溃只发 RunFinished 不发 TaskFailed[修于 2026-06-18]、老 interrupt
# 不补 TaskCanceled）使"用户眼中已完成"的 task 在事件里滞留非终态；recover_session 的
# restore 对非终态任务无条件重排成 PENDING 重跑（误复活）。m006 补插对应终态事件收口：
# 判据 a=该 task 自身事件序的最后一条是"死亡 run"（RunFinished.final_status≠SUSPENDED
# 且其后无任何该 task 生命周期事件）→ 按 final_status 补同名终态；
# 判据 b=其后有代际证据（SESSION_RESUMED=用户已开新一轮 / SESSION_FINISHED=该轮已走完
# 收尾,滞留者已被 TM 遗弃）→ 补 TaskCanceled。parked（仍有未决 HITL）/ 已终态不动。
# 注意 SessionFinished 每轮结束都发（_fire_session_done）,绝不能当"会话终结"跳过标记。


async def test_m006_closes_task_after_dead_run(tmp_path):
    """判据 a：最后一条是死亡 RunFinished 的非终态 task 按 final_status 补终态；
    park 型 RunFinished(SUSPENDED) 与已终态 task 不动。投影行同步改写。"""
    import json

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id="s1", user_prompt="seed"))
            db.add_all([
                TaskModel(id="t1", session_id="s1", status="ACTIVE"),   # 投影停在 ACTIVE（历史缺口）
                TaskModel(id="t2", session_id="s1", status="SUSPENDED"),
            ])
            db.add_all([
                # t1：崩溃死亡 run（只发 RunFinished(FAILED)、无 TaskFailed）→ 补 TaskFailed
                _hitl_ev("evt_0001", "s1", "TaskCreated", 1,
                         {"task": {"id": "t1", "status": "PENDING"}}),
                _hitl_ev("evt_0002", "s1", "TaskStarted", 2, {}, task_id="t1"),
                _hitl_ev("evt_0003", "s1", "RunFinished", 3,
                         {"final_status": "FAILED", "error": "boom"}, task_id="t1"),
                # t2：park 型挂起（RunFinished(SUSPENDED)）→ 不动
                _hitl_ev("evt_0004", "s1", "TaskCreated", 4,
                         {"task": {"id": "t2", "status": "PENDING"}}),
                _hitl_ev("evt_0005", "s1", "TaskStarted", 5, {}, task_id="t2"),
                _hitl_ev("evt_0006", "s1", "TaskSuspended", 6, {}, task_id="t2"),
                _hitl_ev("evt_0007", "s1", "RunFinished", 7,
                         {"final_status": "SUSPENDED"}, task_id="t2"),
                # t3：健康完成（TaskFinished 在）→ 不动
                _hitl_ev("evt_0008", "s1", "TaskCreated", 8,
                         {"task": {"id": "t3", "status": "PENDING"}}),
                _hitl_ev("evt_0009", "s1", "TaskStarted", 9, {}, task_id="t3"),
                _hitl_ev("evt_0010", "s1", "TaskFinished", 10, {"outcome": "success"}, task_id="t3"),
                _hitl_ev("evt_0011", "s1", "RunFinished", 11,
                         {"final_status": "FINISHED"}, task_id="t3"),
            ])

    applied = await run_pending(factory)
    assert applied["m006_close_stale_tasks"] == 1  # 只有 t1

    async with factory() as db:
        inserted = (await db.execute(
            select(EventModel).where(EventModel.type == "TaskFailed"))).scalars().all()
        t1_row = (await db.execute(
            select(TaskModel.status).where(TaskModel.id == "t1"))).scalar_one()
        t2_row = (await db.execute(
            select(TaskModel.status).where(TaskModel.id == "t2"))).scalar_one()
    assert len(inserted) == 1
    c = inserted[0]
    assert c.task_id == "t1" and c.session_id == "s1"
    assert json.loads(c.payload_json)["reason"] == "m006_dead_run_backfill"
    assert c.causation_id == "evt_0003"       # 指回死亡 RunFinished
    assert t1_row == "FAILED"                 # 投影行同步
    assert t2_row == "SUSPENDED"              # park 型不动


async def test_m006_closes_abandoned_turn_keeps_parked_and_current(tmp_path):
    """判据 b：其后有 SESSION_RESUMED 的滞留 task 补 TaskCanceled；
    parked（未决 HITL）与新一轮（RESUMED 之后）的 task 不动。"""
    import json

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                # t1：旧轮次滞留 SUSPENDED、无未决 HITL（僵尸已被 m005 收口的形态）
                _hitl_ev("evt_0101", "s2", "TaskCreated", 1,
                         {"task": {"id": "t1", "status": "PENDING"}}),
                _hitl_ev("evt_0102", "s2", "TaskStarted", 2, {}, task_id="t1"),
                _hitl_ev("evt_0103", "s2", "TaskSuspended", 3, {}, task_id="t1"),
                # t2：旧轮次滞留但仍有未决 HITL → parked,不动
                _hitl_ev("evt_0104", "s2", "TaskCreated", 4,
                         {"task": {"id": "t2", "status": "PENDING"}}),
                _hitl_ev("evt_0105", "s2", "TaskStarted", 5, {}, task_id="t2"),
                _hitl_ev("evt_0106", "s2", "HitlRequired", 6,
                         {"hitl_id": "h1", "form": "question"}, task_id="t2"),
                _hitl_ev("evt_0107", "s2", "TaskSuspended", 7, {}, task_id="t2"),
                # 用户开启新一轮
                _hitl_ev("evt_0108", "s2", "SessionResumed", 8, {"user_prompt": "next"}),
                # t3：新一轮在跑（RESUMED 之后）→ 不动（合法崩溃恢复对象）
                _hitl_ev("evt_0109", "s2", "TaskCreated", 9,
                         {"task": {"id": "t3", "status": "PENDING"}}),
                _hitl_ev("evt_0110", "s2", "TaskStarted", 10, {}, task_id="t3"),
            ])

    applied = await run_pending(factory)
    assert applied["m006_close_stale_tasks"] == 1  # 只有 t1

    async with factory() as db:
        cancels = (await db.execute(
            select(EventModel).where(EventModel.type == "TaskCanceled"))).scalars().all()
    assert len(cancels) == 1
    c = cancels[0]
    assert c.task_id == "t1"
    assert json.loads(c.payload_json)["reason"] == "m006_stale_turn_backfill"
    assert c.causation_id == "evt_0108"       # 指回代际证据 SESSION_RESUMED


async def test_m006_session_finished_is_closure_evidence_not_skip(tmp_path):
    """回归：SessionFinished 每轮都发,不是"会话终结"标记——它必须当**代际证据**用
    （轮次已走完收尾,滞留非终态 task 已被 TM 遗弃）而不是整会话跳过。"""
    import json

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                # s3：滞留 task,其后既有 SessionResumed 也有 SessionFinished → 收口,
                #     causation 指向最后一条代际证据（SessionFinished）
                _hitl_ev("evt_0021", "s3", "TaskCreated", 1,
                         {"task": {"id": "g1", "status": "PENDING"}}),
                _hitl_ev("evt_0022", "s3", "TaskStarted", 2, {}, task_id="g1"),
                _hitl_ev("evt_0023", "s3", "SessionResumed", 3, {}),
                _hitl_ev("evt_0024", "s3", "SessionFinished", 4, {"final_status": "SUCCEEDED"}),
                # s5：滞留 task,其后只有 SessionFinished（轮次完成,用户没再开新轮）→ 也收口
                _hitl_ev("evt_0051", "s5", "TaskCreated", 1,
                         {"task": {"id": "g3", "status": "PENDING"}}),
                _hitl_ev("evt_0052", "s5", "TaskStarted", 2, {}, task_id="g3"),
                _hitl_ev("evt_0053", "s5", "SessionFinished", 3, {"final_status": "SUCCEEDED"}),
                # s5 最新一轮的滞留 task：其后无任何代际证据 → 合法崩溃恢复对象,不动
                _hitl_ev("evt_0055", "s5", "TaskCreated", 4,
                         {"task": {"id": "g4", "status": "PENDING"}}),
                _hitl_ev("evt_0056", "s5", "TaskStarted", 5, {}, task_id="g4"),
            ])

    applied = await run_pending(factory)
    assert applied["m006_close_stale_tasks"] == 2  # g1 + g3；g4 保留

    async with factory() as db:
        cancels = {c.task_id: c for c in (await db.execute(
            select(EventModel).where(EventModel.type == "TaskCanceled"))).scalars().all()}
    assert set(cancels) == {"g1", "g3"}
    assert cancels["g1"].causation_id == "evt_0024"  # 最后一条代际证据（Finished > Resumed）
    assert cancels["g3"].causation_id == "evt_0053"
    assert json.loads(cancels["g3"].payload_json)["reason"] == "m006_stale_turn_backfill"


async def test_m006_idempotent(tmp_path):
    """重跑 0 变更（补插的终态使 task 折为 terminal）。"""
    from netlivecowork.persistence.postgres.migrations import _m006_close_stale_tasks

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                _hitl_ev("evt_0025", "s4", "TaskCreated", 1,
                         {"task": {"id": "g2", "status": "PENDING"}}),
                _hitl_ev("evt_0026", "s4", "TaskStarted", 2, {}, task_id="g2"),
                _hitl_ev("evt_0027", "s4", "SessionResumed", 3, {}),
            ])

    applied = await run_pending(factory)
    assert applied["m006_close_stale_tasks"] == 1

    # gated：重跑 run_pending 不再执行
    assert "m006_close_stale_tasks" not in await run_pending(factory)

    # 幂等：绕开标记单独调函数,0 变更（g2 已被补插的 TaskCanceled 折为终态）
    async with factory() as db:
        assert await _m006_close_stale_tasks(db) == 0


async def test_m005_then_m006_chain_closes_zombie_and_its_parked_task(tmp_path):
    """m005→m006 顺序依赖：m005 先取消僵尸 pending,该 task 失去 parked 豁免后
    m006 的代际证据判据才能把它一并收口（同一次 run_pending 内完成）。"""
    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            db.add_all([
                _hitl_ev("evt_0060", "s6", "TaskCreated", 0,
                         {"task": {"id": "t_z", "status": "PENDING"}}),
                # 僵尸 HITL 挂在 t_z 上（原始 0.4.19 形状,m004 同批先迁移）
                _hitl_ev("evt_0061", "s6", "HitlRequired", 1,
                         {"approval_id": "z1", "kind": "input",
                          "capability_id": "control:ask_user"}, task_id="t_z"),
                _hitl_ev("evt_0062", "s6", "HitlAnswered", 2, {"approval_id": "z0"}),
                _hitl_ev("evt_0063", "s6", "SessionFinished", 3, {"final_status": "SUCCEEDED"}),
            ])

    applied = await run_pending(factory)
    assert applied["m005_cancel_stale_legacy_hitl"] == 1  # z1 收口
    assert applied["m006_close_stale_tasks"] == 1         # t_z 失去 parked 豁免后被收口


# ── m009: RecognizeIntentToolCall → tasks.title/description 回填 ──────────────
# 修复前 ProjectionUpdater 不消费该事件的 title/description（只取 session_goal），
# tasks 表 root task 的元数据列永远空。m009 从事件 payload 回填存量行；
# 空字段才填（不覆盖手工/后续代码写入的值），同 task 多条事件取最后一条（ULID 序）。


async def _title_desc(factory, task_id: str) -> tuple[str, str]:
    async with factory() as db:
        row = (await db.execute(
            select(TaskModel.title, TaskModel.description)
            .where(TaskModel.id == task_id))).one()
    return row[0] or "", row[1] or ""


async def test_m009_backfills_empty_metadata_last_event_wins(tmp_path):
    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id="s9", user_prompt="seed"))
            db.add_all([
                TaskModel(id="t_empty", session_id="s9", status="FINISHED",
                          title="", description=""),
                TaskModel(id="t_filled", session_id="s9", status="FINISHED",
                          title="手填标题", description="手填描述"),
                TaskModel(id="t_noev", session_id="s9", status="FINISHED",
                          title="", description=""),
            ])
            db.add_all([
                # t_empty：两条事件 → 最后一条（ULID 更大）胜出
                _hitl_ev("evt_0901", "s9", "RecognizeIntentToolCall", 1,
                         {"title": "首次标题", "description": "首次描述", "session_goal": ""},
                         task_id="t_empty"),
                _hitl_ev("evt_0902", "s9", "RecognizeIntentToolCall", 2,
                         {"title": "重试标题", "description": "重试描述", "session_goal": ""},
                         task_id="t_empty"),
                # t_filled：已有值 → 不覆盖、不计数
                _hitl_ev("evt_0903", "s9", "RecognizeIntentToolCall", 3,
                         {"title": "别的标题", "description": "别的描述", "session_goal": ""},
                         task_id="t_filled"),
                # 空 payload（LLM 未产出）→ 不写、不计数
                _hitl_ev("evt_0904", "s9", "RecognizeIntentToolCall", 4,
                         {"title": "", "description": "", "session_goal": ""},
                         task_id="t_noev"),
            ])

    applied = await run_pending(factory)
    assert applied["m009_backfill_task_metadata"] == 1  # 只有 t_empty

    assert await _title_desc(factory, "t_empty") == ("重试标题", "重试描述")
    assert await _title_desc(factory, "t_filled") == ("手填标题", "手填描述")
    assert await _title_desc(factory, "t_noev") == ("", "")


async def test_m009_fills_only_empty_fields(tmp_path):
    """按字段独立回填：title 已有则保留，只补空的 description（反之亦然）。"""
    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id="s9", user_prompt="seed"))
            db.add(TaskModel(id="t_half", session_id="s9", status="FINISHED",
                             title="已有标题", description=""))
            db.add(_hitl_ev("evt_0911", "s9", "RecognizeIntentToolCall", 1,
                            {"title": "事件标题", "description": "事件描述", "session_goal": ""},
                            task_id="t_half"))

    applied = await run_pending(factory)
    assert applied["m009_backfill_task_metadata"] == 1

    assert await _title_desc(factory, "t_half") == ("已有标题", "事件描述")


async def test_m009_idempotent(tmp_path):
    from netlivecowork.persistence.postgres.migrations import _m009_backfill_task_metadata

    factory = await _factory(tmp_path)
    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id="s9", user_prompt="seed"))
            db.add(TaskModel(id="t_e", session_id="s9", status="FINISHED",
                             title="", description=""))
            db.add(_hitl_ev("evt_0921", "s9", "RecognizeIntentToolCall", 1,
                            {"title": "标题", "description": "描述", "session_goal": ""},
                            task_id="t_e"))

    applied = await run_pending(factory)
    assert applied["m009_backfill_task_metadata"] == 1

    # gated：重跑 run_pending 不再执行
    assert "m009_backfill_task_metadata" not in await run_pending(factory)

    # 幂等：绕开标记单独调函数，0 变更（字段已非空）
    async with factory() as db:
        assert await _m009_backfill_task_metadata(db) == 0


# ── m010: 存量事件/快照裸 template_id 规范化为 agent: 前缀 ──────────────────────
import json as _json

from netlivecowork.persistence.postgres.models import SnapshotModel


async def _seed_template_id_rows(factory) -> None:
    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id="ses_m10", user_prompt="seed"))
            db.add(EventModel(
                id="evt_m10_bare", session_id="ses_m10", type="SESSION_CREATED",
                sequence=1,
                payload_json=_json.dumps({"template_id": "default", "user_prompt": "hi"}),
            ))
            db.add(EventModel(
                id="evt_m10_canon", session_id="ses_m10", type="SESSION_CREATED",
                sequence=2,
                payload_json=_json.dumps({"template_id": "agent:default"}),
            ))
            db.add(EventModel(
                id="evt_m10_none", session_id="ses_m10", type="TASK_CREATED",
                sequence=3, payload_json=_json.dumps({"title": "no tid"}),
            ))
            db.add(SnapshotModel(
                id="snp_m10", session_id="ses_m10", last_event_id="evt_m10_bare",
                last_event_sequence=1,
                state_blob_json=_json.dumps({"sessions": {
                    "ses_m10": {"id": "ses_m10", "template_id": "default"},
                    "ses_ok": {"id": "ses_ok", "template_id": "agent:default"},
                }}),
            ))


async def _payload(factory, event_id: str) -> dict:
    async with factory() as db:
        row = (await db.execute(
            select(EventModel.payload_json).where(EventModel.id == event_id))).scalar_one()
    return _json.loads(row)


async def test_m010_prefixes_bare_template_ids(tmp_path):
    factory = await _factory(tmp_path)
    await _seed_template_id_rows(factory)

    applied = await run_pending(factory)
    # 1 条裸事件 + 1 条含裸 id 的快照 = 2 行（已规范化的不计）
    assert applied["m010_canonical_template_id_prefix"] == 2

    assert (await _payload(factory, "evt_m10_bare"))["template_id"] == "agent:default"
    assert (await _payload(factory, "evt_m10_bare"))["user_prompt"] == "hi"  # 其余键不动
    assert (await _payload(factory, "evt_m10_canon"))["template_id"] == "agent:default"
    assert "template_id" not in (await _payload(factory, "evt_m10_none"))

    async with factory() as db:
        blob = (await db.execute(
            select(SnapshotModel.state_blob_json).where(SnapshotModel.id == "snp_m10"))).scalar_one()
    sessions = _json.loads(blob)["sessions"]
    assert sessions["ses_m10"]["template_id"] == "agent:default"
    assert sessions["ses_ok"]["template_id"] == "agent:default"


async def test_m010_idempotent_rerun_zero(tmp_path):
    factory = await _factory(tmp_path)
    await _seed_template_id_rows(factory)
    await run_pending(factory)
    # 抹掉标记强制重跑，验证第二次命中 0 行
    async with factory() as db:
        await db.execute(text("DELETE FROM applied_migrations WHERE id = 'm010_canonical_template_id_prefix'"))
        await db.commit()
    applied = await run_pending(factory)
    assert applied["m010_canonical_template_id_prefix"] == 0


# ── m011: observer 判死 notice 的 reason_text 修补 ─────────────────────────────
# 旧版帧把 act_recap（过程复述）/裸「会话失败」当死因展示；素材（report_task_outcome
# 的 task_failure_reason）就躺在同流的 observer_control_tool_call 帧里。指纹判定：
# reason_text == 前方最近 fail 判决的 act_recap，或 == "会话失败"；新帧永不命中。


def _m011_verdict(act_recap: str, reason: str) -> dict:
    return {"type": "observer_control_tool_call", "tool_name": "report_task_outcome",
            "arguments": {"task_status": "fail", "act_recap": act_recap,
                          "task_failure_reason": reason},
            "result": "", "created_at": "t"}


def _m011_notice(reason_text: str, code: str = "TASK_FAILED_BY_OBSERVER") -> dict:
    return {"type": "session_notice", "kind": "failed", "reason_code": code,
            "reason_text": reason_text, "failures": [], "created_at": "t"}


async def _m011_seed(factory, sid: str, frames: list[dict]) -> None:
    import json
    from netlivecowork.persistence.postgres.models import SessionSSEEventModel
    async with factory() as db:
        async with db.begin():
            await db.merge(SessionModel(id=sid, user_prompt="seed"))
            for f in frames:
                db.add(SessionSSEEventModel(
                    session_id=sid, event_json=json.dumps(f, ensure_ascii=False)))


async def _m011_notices(factory, sid: str) -> list[dict]:
    import json
    from netlivecowork.persistence.postgres.models import SessionSSEEventModel
    async with factory() as db:
        rows = (await db.execute(
            select(SessionSSEEventModel.event_json)
            .where(SessionSSEEventModel.session_id == sid)
            .order_by(SessionSSEEventModel.id))).all()
    return [f for f in (json.loads(r[0]) for r in rows)
            if f.get("type") == "session_notice"]


async def test_m011_rewrites_act_recap_notice_to_failure_reason(tmp_path):
    factory = await _factory(tmp_path)
    await _m011_seed(factory, "ses_m11a", [
        _m011_verdict("我调了 A、B 两个工具", "第 2 步 API 调用 403：凭据无权限"),
        _m011_notice("我调了 A、B 两个工具"),
    ])
    applied = await run_pending(factory)
    assert applied["m011_repair_observer_notice_reason"] == 1
    n = (await _m011_notices(factory, "ses_m11a"))[0]
    assert n["reason_text"] == "第 2 步 API 调用 403：凭据无权限"
    assert n["reason_code"] == "TASK_FAILED_BY_OBSERVER"  # 其余键不动


async def test_m011_generic_text_without_reason_gets_fixed_hint(tmp_path):
    from netlivecowork.api.models.session import _OBSERVER_FAIL_FALLBACK
    factory = await _factory(tmp_path)
    # 旧版 act_recap 为空 → notice 落裸「会话失败」；判决也没写 task_failure_reason
    await _m011_seed(factory, "ses_m11b", [
        _m011_verdict("", ""),
        _m011_notice("会话失败"),
    ])
    applied = await run_pending(factory)
    assert applied["m011_repair_observer_notice_reason"] == 1
    assert (await _m011_notices(factory, "ses_m11b"))[0]["reason_text"] == _OBSERVER_FAIL_FALLBACK


async def test_m011_leaves_good_threshold_and_orphan_notices(tmp_path):
    factory = await _factory(tmp_path)
    # 新帧（reason_text 已是真死因，不等于 act_recap）→ 不动
    await _m011_seed(factory, "ses_m11c", [
        _m011_verdict("过程复述", "真死因"),
        _m011_notice("真死因"),
    ])
    # 熔断通告（reason_code 不同）→ 不动
    await _m011_seed(factory, "ses_m11d", [
        _m011_verdict("过程复述", "真死因"),
        _m011_notice("连续 3 次子任务失败，达到熔断阈值（3），会话已终止",
                     code="TASK_FAILED_BY_THRESHOLD"),
    ])
    # 前方无 fail 判决帧（规则 observe 判死等）→ 无素材，不动
    await _m011_seed(factory, "ses_m11e", [_m011_notice("会话失败")])
    applied = await run_pending(factory)
    assert applied["m011_repair_observer_notice_reason"] == 0


async def test_m011_idempotent_rerun_zero(tmp_path):
    factory = await _factory(tmp_path)
    await _m011_seed(factory, "ses_m11f", [
        _m011_verdict("过程复述", "真死因"),
        _m011_notice("过程复述"),
    ])
    await run_pending(factory)
    async with factory() as db:
        await db.execute(text(
            "DELETE FROM applied_migrations WHERE id = 'm011_repair_observer_notice_reason'"))
        await db.commit()
    applied = await run_pending(factory)
    assert applied["m011_repair_observer_notice_reason"] == 0
