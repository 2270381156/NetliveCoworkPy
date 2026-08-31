"""Host SSE 翻译层放行「开始」信号，供前端渲染 Agent 当前状态条。

translate_event 此前把 LLM_REQUEST_STARTED / CAPABILITY_INVOKED 全咽掉（return None），
前端只能看到已完成的 tool_call、无法显示「正在推理 / 正在执行 X」+ 时长。本组用例锁定
新增的 llm_request_started / tool_call_started 两条轻量 wire 事件的契约。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

from ctx_weft.core.events import EventType
from netlivecowork.api.models.session import SessionEntry


def _entry() -> SessionEntry:
    return SessionEntry(
        session_id="s1",
        template_id="tpl",
        user_prompt="hi",
        tenant_id="default",
        llm_model="m",
        llm_account="acc",
    )


def _ev(t: str, payload: dict, run_id: str = "run_act", task_id: str = "tsk_1") -> SimpleNamespace:
    return SimpleNamespace(
        type=t,
        payload=payload,
        timestamp=datetime.now(timezone.utc),
        run_id=run_id,
        task_id=task_id,
        agent_id="agt_1",
    )


# ── llm_request_started ──────────────────────────────────────────────────────


def test_llm_request_started_actor():
    e = _entry()
    out = e.translate_event(_ev(EventType.LLM_REQUEST_STARTED, {}))
    assert out is not None
    msg = json.loads(out)
    assert msg["type"] == "llm_request_started"
    assert msg["source"] == "actor"
    assert msg["created_at"]


def test_llm_request_started_observer_in_observe_round():
    e = _entry()
    e.translate_event(_ev(EventType.STEP_STARTED, {"step_name": "observe"}))
    out = e.translate_event(_ev(EventType.LLM_REQUEST_STARTED, {}))
    assert json.loads(out)["source"] == "observer"


# ── tool_call_started ────────────────────────────────────────────────────────


def test_capability_invoked_emits_tool_call_started_regular():
    e = _entry()
    out = e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_1",
        "capability_name": "bash_exec",
        "capability_id": "fs:bash_exec",
        "arguments": {"command": "ls"},
    }))
    assert out is not None
    msg = json.loads(out)
    assert msg["type"] == "tool_call_started"
    assert msg["tool_name"] == "bash_exec"
    assert msg["is_control"] is False
    assert msg["source"] == "actor"
    assert msg["created_at"]


def test_capability_invoked_marks_control_tool():
    e = _entry()
    out = e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_2",
        "capability_name": "finish_task",
        "capability_id": "control:finish_task",
        "arguments": {},
    }))
    msg = json.loads(out)
    assert msg["type"] == "tool_call_started"
    assert msg["is_control"] is True


def test_capability_invoked_observer_source():
    e = _entry()
    e.translate_event(_ev(EventType.STEP_STARTED, {"step_name": "observe"}))
    out = e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_3",
        "capability_name": "bash_exec",
        "capability_id": "fs:bash_exec",
        "arguments": {},
    }))
    assert json.loads(out)["source"] == "observer"


def test_daemon_capability_invoked_not_emitted():
    """daemon（recognize_intent）的活动不进状态条 —— INVOKED 仍返回 None。"""
    e = _entry()
    e.translate_event(_ev(EventType.RECOGNIZE_INTENT_STARTED,
                          {"task_id": "tsk_1", "target_task_id": "tsk_1"},
                          run_id="run_meta", task_id="tsk_1"))
    out = e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_meta",
        "capability_name": "update_task_metadata",
        "capability_id": "control:update_task_metadata",
        "arguments": {},
    }, run_id="run_meta", task_id="tsk_1"))
    assert out is None


def test_tool_call_started_does_not_break_finished_classification():
    """INVOKED 现在有返回值，但 pending 暂存不变：FINISHED 仍正确分类。"""
    e = _entry()
    e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_4",
        "capability_name": "bash_exec",
        "capability_id": "fs:bash_exec",
        "arguments": {"command": "ls"},
    }))
    out = e.translate_event(_ev(EventType.CAPABILITY_FINISHED, {
        "invocation_id": "inv_4",
        "capability_name": "bash_exec",
        "outcome": "success",
        "result": "ok",
    }))
    msg = json.loads(out)
    assert msg["type"] == "tool_call"
    assert msg["tool_name"] == "bash_exec"
    assert msg["arguments"] == {"command": "ls"}


# ── recognize_intent no longer synthesizes a daemon task ─────────────────────


def test_recognize_intent_started_emits_no_daemon_task():
    """recognize_intent 已是普通 step：STARTED 不再合成 daemon_task_created。"""
    e = _entry()
    out = e.translate_event(_ev(EventType.RECOGNIZE_INTENT_STARTED,
                                {"task_id": "tsk_1", "target_task_id": "tsk_1"},
                                run_id="run_meta", task_id="tsk_1"))
    assert out is None


def test_recognize_intent_skipped_emits_no_daemon_task():
    """SKIPPED 不再合成 daemon_task_updated(CANCELED)。"""
    e = _entry()
    out = e.translate_event(_ev(EventType.RECOGNIZE_INTENT_SKIPPED, {"reason": "no_tools"},
                                run_id="run_meta", task_id="tsk_1"))
    assert out is None


async def test_recognize_intent_completed_updates_real_task_not_daemon():
    """COMPLETED 不再返回 daemon_task_updated(FINISHED)，元数据落到真 root task 上。"""
    e = _entry()
    e.tasks["tsk_1"] = {"id": "tsk_1", "session_id": "s1", "title": "", "description": ""}
    e.translate_event(_ev(EventType.RECOGNIZE_INTENT_STARTED,
                          {"task_id": "tsk_1", "target_task_id": "tsk_1"},
                          run_id="run_meta", task_id="tsk_1"))
    out = e.translate_event(_ev(EventType.RECOGNIZE_INTENT_COMPLETED,
                                {"title": "Fix bug", "description": "do it"},
                                run_id="run_meta", task_id="tsk_1"))
    assert out is None
    assert e.tasks["tsk_1"]["title"] == "Fix bug"
    assert e.tasks["tsk_1"]["description"] == "do it"
