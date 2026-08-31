"""SSE translation: plain-text pause → PAUSED (no waiting_input panel); ask_user → PAUSED_HITL."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.api.models.session import SessionEntry

_TS = datetime(2026, 6, 16, tzinfo=timezone.utc)


def _entry(sid: str) -> SessionEntry:
    return SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                        tenant_id="default", llm_model=None, llm_account=None)


def _ev(sid: str, type_: str, **payload) -> Event:
    return Event(id=f"evt_{type_}", run_id="r1", sequence=1, session_id=sid,
                 type=type_, timestamp=_TS, payload=payload)


def test_plaintext_hitl_required_no_waiting_input() -> None:
    e = _entry("s1")
    out = e.translate_event(_ev("s1", EventType.HITL_REQUIRED,
                                form="wait", capability_id="control:wait_for_user", question=""))
    assert e.status == "PAUSED"
    assert json.loads(out)["type"] != "waiting_input"


def test_ask_user_hitl_required_keeps_waiting_input() -> None:
    e = _entry("s2")
    out = e.translate_event(_ev("s2", EventType.HITL_REQUIRED,
                                form="question", capability_id="control:ask_user",
                                question="Pick one", questions=[{"question": "Pick one"}],
                                hitl_id="h1"))
    parsed = json.loads(out)
    assert e.status == "PAUSED_HITL"
    assert parsed["type"] == "waiting_input"
    assert parsed["hitl_id"] == "h1"
    assert parsed["form"] == "question"


def test_hitl_required_question_form_maps_to_input_kind() -> None:
    """前端契约派生：form="question" → SSE waiting_input 的 kind == "input"（非 HITL 无关判断）。"""
    e = _entry("s5")
    out = e.translate_event(_ev("s5", EventType.HITL_REQUIRED,
                                form="question", capability_id="control:ask_user",
                                question="Pick one", hitl_id="h1"))
    parsed = json.loads(out)
    assert parsed["kind"] == "input"
    assert parsed["hitl_id"] == "h1"
    assert parsed["form"] == "question"


def test_hitl_required_approval_form_maps_to_approval_kind() -> None:
    """前端契约派生：form="approval" → SSE waiting_input 的 kind == "approval"。"""
    e = _entry("s6")
    out = e.translate_event(_ev("s6", EventType.HITL_REQUIRED,
                                form="approval", capability_id="fs:bash_exec",
                                question="Allow this?", hitl_id="h1"))
    parsed = json.loads(out)
    assert parsed["kind"] == "approval"
    assert parsed["hitl_id"] == "h1"
    assert parsed["form"] == "approval"


def test_session_paused_hitl_plaintext_sets_paused() -> None:
    e = _entry("s3")
    out = e.translate_event(_ev("s3", EventType.SESSION_PAUSED_HITL,
                                capability_id="control:wait_for_user", form="wait"))
    assert e.status == "PAUSED"
    assert json.loads(out)["status"] == "PAUSED"


def test_hitl_answered_resets_paused_to_running() -> None:
    e = _entry("s4")
    e.translate_event(_ev("s4", EventType.SESSION_PAUSED_HITL,
                          capability_id="control:wait_for_user", form="wait"))
    assert e.status == "PAUSED"
    e.translate_event(_ev("s4", EventType.HITL_ANSWERED, hitl_id="h1"))
    assert e.status == "RUNNING"
