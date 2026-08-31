"""finish_task 反转契约（spec 2026-07-01）：答复即消息正文，finish_task 退化为收尾标记。

前端不再把 finish_task 的输入渲染成总结卡（答复由 text_done 的普通气泡承载），故后端
不再在 finish_task 的 control_tool_call 上附 is_root 标记。这里锁定：事件仍作为
control_tool_call 下发，但**不带** is_root（无论根/子任务）。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

from ctx_weft.core.events import EventType
from netlivecowork.api.models.session import SessionEntry


def _entry() -> SessionEntry:
    return SessionEntry(
        session_id="s1", template_id="tpl", user_prompt="hi",
        tenant_id="default", llm_model="m", llm_account="acc",
    )


def _ev(t: str, payload: dict, run_id: str = "run_act", task_id: str = "tsk_1") -> SimpleNamespace:
    return SimpleNamespace(
        type=t, payload=payload, timestamp=datetime.now(timezone.utc),
        run_id=run_id, task_id=task_id, agent_id="agt_1",
    )


def _create_task(e: SessionEntry, task_id: str, title: str, parent: str = "") -> None:
    e.translate_event(_ev(EventType.TASK_CREATED, {"task": {
        "id": task_id, "title": title, "parent_task_id": parent,
    }}, task_id=task_id))


def _finish(e: SessionEntry, task_id: str) -> str | None:
    inv = f"inv_fin_{task_id}"
    e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": inv, "capability_name": "control__finish_task",
        "capability_id": "control:finish_task", "arguments": {},
    }, task_id=task_id))
    return e.translate_event(_ev(EventType.CAPABILITY_FINISHED, {
        "invocation_id": inv, "capability_name": "control__finish_task",
        "outcome": "success", "result": "Task finished.",
    }, task_id=task_id))


def test_finish_task_emits_control_tool_call_without_is_root():
    e = _entry()
    _create_task(e, "tsk_1", "做个网站", parent="")
    d = json.loads(_finish(e, "tsk_1"))
    assert d["type"] == "control_tool_call"
    assert d["tool_name"] == "control__finish_task"
    # 反转契约：不再附 is_root（前端不再渲染总结卡）
    assert "is_root" not in d


def test_finish_task_subtask_also_no_is_root():
    e = _entry()
    _create_task(e, "tsk_root", "根", parent="")
    _create_task(e, "tsk_sub", "子", parent="tsk_root")
    sub_d = json.loads(_finish(e, "tsk_sub"))
    assert sub_d["type"] == "control_tool_call"
    assert "is_root" not in sub_d
