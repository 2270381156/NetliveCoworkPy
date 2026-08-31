"""TelemetrySubscriber 把失败事件映射成一条运营记录。

产出侧（真的落进 telemetry-spool.jsonl、与切换前逐字段一致）在
`test_reporting_subscribers_equivalence.py`。这里只钉映射本身。
"""
import asyncio
from types import SimpleNamespace

import netlivecowork.observability.telemetry_subscriber as sub_mod
from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber


def _ev(type_, **kw):
    return SimpleNamespace(
        id="e1", type=type_, session_id=kw.get("session_id"),
        task_id=kw.get("task_id"), payload=kw.get("payload", {}),
    )


def test_step_failed_emits(monkeypatch):
    calls = []
    monkeypatch.setattr(sub_mod, "record", lambda et, payload, **kw: calls.append((et, payload)))
    ev = _ev("StepFailed", session_id="s1", task_id="t1",
             payload={"step_name": "act", "error_code": "LLMCallError", "error_message": "api down"})
    asyncio.run(TelemetrySubscriber().on_event(ev))
    assert len(calls) == 1
    et, kw = calls[0]
    assert et == "step_failed"
    assert kw["session_id"] == "s1" and kw["task_id"] == "t1"
    assert kw["error_code"] == "LLMCallError" and kw["error_message"] == "api down"


def test_task_failed_emits(monkeypatch):
    calls = []
    monkeypatch.setattr(sub_mod, "record", lambda et, payload, **kw: calls.append((et, payload)))
    ev = _ev("TaskFailed", session_id="s1", payload={"error_code": "TASK_FAILED_AT_RUN", "error_message": "boom"})
    asyncio.run(TelemetrySubscriber().on_event(ev))
    assert calls[0][0] == "task_failed"


def test_non_failure_event_ignored(monkeypatch):
    calls = []
    monkeypatch.setattr(sub_mod, "record", lambda et, payload, **kw: calls.append(et))
    asyncio.run(TelemetrySubscriber().on_event(_ev("TaskCreated", session_id="s1")))
    assert calls == []


def test_on_event_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("record broke")
    monkeypatch.setattr(sub_mod, "record", boom)
    # 不应抛(订阅者绝不影响 EventBus 派发)
    asyncio.run(TelemetrySubscriber().on_event(_ev("StepFailed", session_id="s1")))


def test_task_failed_by_observer_drops_error_message(monkeypatch):
    """TaskFailed with TASK_FAILED_BY_OBSERVER must NOT forward error_message (spec §5:
    that field can echo agent output text). error_code must still be forwarded."""
    calls = []
    monkeypatch.setattr(sub_mod, "record", lambda et, payload, **kw: calls.append((et, payload)))
    ev = _ev(
        "TaskFailed",
        session_id="s1",
        task_id="t1",
        payload={
            "error_code": "TASK_FAILED_BY_OBSERVER",
            "error_message": "<the agent's last words leaked here>",
        },
    )
    asyncio.run(TelemetrySubscriber().on_event(ev))
    assert len(calls) == 1
    et, kw = calls[0]
    assert et == "task_failed"
    assert kw["error_code"] == "TASK_FAILED_BY_OBSERVER"
    assert kw["error_message"] is None  # content dropped — must NOT be forwarded
