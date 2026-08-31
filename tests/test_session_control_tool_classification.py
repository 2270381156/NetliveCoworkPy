"""SSE 投影必须按 capability_id 前缀分类 control 工具。

回归：finish_task 等 control 工具的 CAPABILITY_INVOKED 事件里 capability_name 是裸名
（"finish_task"），而 capability_id 才带 "control:" 前缀。早先用 capability_name 判断
startswith("control:") 永不成立，control 工具被错判成普通 tool_call → 桌面前端可见。
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


def _classify(capability_name: str, capability_id: str) -> str:
    """跑一遍 INVOKED→FINISHED，返回前端拿到的 SSE event type。"""
    e = _entry()
    e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_1",
        "capability_name": capability_name,
        "capability_id": capability_id,
        "arguments": {},
    }))
    out = e.translate_event(_ev(EventType.CAPABILITY_FINISHED, {
        "invocation_id": "inv_1",
        "capability_name": capability_name,
        "outcome": "success",
        "result": "ok",
    }))
    return json.loads(out)["type"]


def test_control_tool_classified_as_control_tool_call():
    # 裸名不带前缀，capability_id 才带 "control:" —— 必须按 id 判断。
    assert _classify("finish_task", "control:finish_task") == "control_tool_call"


def test_regular_tool_classified_as_tool_call():
    assert _classify("bash_exec", "fs:bash_exec") == "tool_call"


def test_act_tool_call_not_suppressed_after_recognize_intent_started():
    """回归：recognize_intent 现与 act 并发跑在同一 root task 上（共享 task_id，独立 run_id）。

    RECOGNIZE_INTENT_STARTED 标记的是 daemon 的 run_id，不能再用 task_id 判定 daemon——否则
    同 task 的 act 阶段 control / skill 工具调用会被误判为 daemon 而丢弃（前端看不到）。
    """
    e = _entry()
    # daemon 快照 run（与 act 同 task_id，但 run_id 不同）启动
    e.translate_event(_ev(EventType.RECOGNIZE_INTENT_STARTED,
                          {"task_id": "tsk_1", "target_task_id": "tsk_1"},
                          run_id="run_meta", task_id="tsk_1"))
    # act 阶段在同一 task 上调用 control 工具（run_id 为 act 主 run）
    e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_act",
        "capability_name": "finish_task",
        "capability_id": "control:finish_task",
        "arguments": {},
    }, run_id="run_act", task_id="tsk_1"))
    out = e.translate_event(_ev(EventType.CAPABILITY_FINISHED, {
        "invocation_id": "inv_act",
        "capability_name": "finish_task",
        "outcome": "success",
        "result": "ok",
    }, run_id="run_act", task_id="tsk_1"))
    assert out is not None, "act 工具调用被误当 daemon 丢弃了"
    assert json.loads(out)["type"] == "control_tool_call"


def test_recognize_intent_own_invocation_suppressed():
    """recognize_intent 自身的 update_task_metadata gateway 调用（同 daemon run_id）应被抑制，
    避免与 daemon_control_tool_call 重复渲染。"""
    e = _entry()
    e.translate_event(_ev(EventType.RECOGNIZE_INTENT_STARTED,
                          {"task_id": "tsk_1", "target_task_id": "tsk_1"},
                          run_id="run_meta", task_id="tsk_1"))
    e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_meta",
        "capability_name": "update_task_metadata",
        "capability_id": "control:update_task_metadata",
        "arguments": {},
    }, run_id="run_meta", task_id="tsk_1"))
    out = e.translate_event(_ev(EventType.CAPABILITY_FINISHED, {
        "invocation_id": "inv_meta",
        "capability_name": "update_task_metadata",
        "outcome": "success",
        "result": "ok",
    }, run_id="run_meta", task_id="tsk_1"))
    assert out is None


def test_control_tool_in_observe_round_is_observer_control():
    e = _entry()
    e.translate_event(_ev(EventType.STEP_STARTED, {"step_name": "observe"}))
    e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv_2",
        "capability_name": "report_task_outcome",
        "capability_id": "control:report_task_outcome",
        "arguments": {},
    }))
    out = e.translate_event(_ev(EventType.CAPABILITY_FINISHED, {
        "invocation_id": "inv_2",
        "capability_name": "report_task_outcome",
        "outcome": "success",
        "result": "ok",
    }))
    assert json.loads(out)["type"] == "observer_control_tool_call"
