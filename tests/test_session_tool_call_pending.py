"""LLM_RESPONSE_FINISHED 在执行前派生 tool_call_pending（仅非控制能力工具），
并使 tool_call_started / tool_call 携带 tool_call_id 供前端三态合并。"""
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


def _events(out) -> list[dict]:
    """把 translate_event 的返回（str | list[str] | None）规整成 dict 列表。"""
    if out is None:
        return []
    if isinstance(out, str):
        out = [out]
    return [json.loads(s) for s in out]


def _pending(out) -> list[dict]:
    return [e for e in _events(out) if e["type"] == "tool_call_pending"]


async def test_regular_tool_emits_pending_with_args_before_execution() -> None:
    e = _entry()
    out = e.translate_event(_ev(EventType.LLM_RESPONSE_FINISHED, {
        "content": "ok", "reasoning": "", "usage": {}, "turn": 1,
        "tool_calls": [{"id": "tc1", "name": "fs__bash_exec", "arguments": {"cmd": "ls"}}],
    }))
    pend = _pending(out)
    assert len(pend) == 1
    p = pend[0]
    assert p["tool_call_id"] == "tc1"
    assert p["tool_name"] == "bash_exec"          # 去 provider 前缀
    assert p["arguments"] == {"cmd": "ls"}        # 执行前就带命令
    assert p["is_control"] is False
    assert p["source"] == "actor"
    # text_done 仍在
    assert any(ev["type"] == "text_done" for ev in _events(out))


async def test_control_tool_does_not_emit_pending() -> None:
    e = _entry()
    out = e.translate_event(_ev(EventType.LLM_RESPONSE_FINISHED, {
        "content": "", "reasoning": "", "usage": {}, "turn": 1,
        "tool_calls": [{"id": "tcf", "name": "control__finish_task",
                        "arguments": {"result": "done"}}],
    }))
    assert _pending(out) == []                    # 决策 1：控制工具不发 pending


async def test_mixed_tools_only_non_control_pending() -> None:
    e = _entry()
    out = e.translate_event(_ev(EventType.LLM_RESPONSE_FINISHED, {
        "content": "", "reasoning": "", "usage": {}, "turn": 1,
        "tool_calls": [
            {"id": "tc1", "name": "fs__read_file", "arguments": {"path": "a"}},
            {"id": "tcf", "name": "control__finish_task", "arguments": {"result": "x"}},
            {"id": "tc2", "name": "mcp__github__create_issue", "arguments": {"t": "1"}},
        ],
    }))
    pend = _pending(out)
    assert [p["tool_call_id"] for p in pend] == ["tc1", "tc2"]
    assert [p["tool_name"] for p in pend] == ["read_file", "create_issue"]


async def test_observe_round_emits_no_pending() -> None:
    e = _entry()
    e.translate_event(_ev(EventType.STEP_STARTED, {"step_name": "observe"}))
    out = e.translate_event(_ev(EventType.LLM_RESPONSE_FINISHED, {
        "content": "", "reasoning": "", "usage": {}, "round": 2,
        "tool_calls": [{"name": "fs__bash_exec"}],  # observer: name-only, no id/arguments
    }))
    assert _pending(out) == []  # observe 轮不派生 pending（决策 3 推翻）


async def test_no_tool_calls_preserves_scalar_text_done() -> None:
    e = _entry()
    out = e.translate_event(_ev(EventType.LLM_RESPONSE_FINISHED, {
        "content": "hi", "reasoning": "", "usage": {}, "turn": 1, "tool_calls": [],
    }))
    # 无工具时保持原有标量返回（向后兼容）
    assert isinstance(out, str)
    assert json.loads(out)["type"] == "text_done"


def test_tool_call_started_carries_tool_call_id() -> None:
    e = _entry()
    out = e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv1", "capability_name": "bash_exec",
        "capability_id": "fs:bash_exec", "arguments": {}, "tool_call_id": "tc1",
    }))
    d = json.loads(out)
    assert d["type"] == "tool_call_started"
    assert d["tool_call_id"] == "tc1"


def test_tool_call_finished_carries_tool_call_id() -> None:
    e = _entry()
    e.translate_event(_ev(EventType.CAPABILITY_INVOKED, {
        "invocation_id": "inv1", "capability_name": "bash_exec",
        "capability_id": "fs:bash_exec", "arguments": {}, "tool_call_id": "tc1",
    }))
    out = e.translate_event(_ev(EventType.CAPABILITY_FINISHED, {
        "invocation_id": "inv1", "capability_name": "bash_exec",
        "outcome": "success", "result": "ok", "tool_call_id": "tc1",
    }))
    d = json.loads(out)
    assert d["type"] == "tool_call"
    assert d["tool_call_id"] == "tc1"
