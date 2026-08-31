"""Host SSE translation for the LLM self-heal / outage flow.

Two new wire contracts:
  - LLM_RETRY_TRIGGERED  -> {type: "llm_retry", attempt, max_attempts, next_delay_sec}
    (self-heal progress while the session is still RUNNING)
  - SessionStatusChanged(INTERRUPTED, reason="llm_outage") -> session_update carrying
    interrupt_reason, also remembered on the entry so a reconnect re-surfaces it.
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


def _ev(t: str, payload: dict) -> SimpleNamespace:
    return SimpleNamespace(
        type=t,
        payload=payload,
        timestamp=datetime.now(timezone.utc),
        run_id="run_act",
        task_id="tsk_1",
        agent_id="agt_1",
    )


# ── llm_retry progress ───────────────────────────────────────────────────────


def test_llm_retry_triggered_emits_llm_retry():
    e = _entry()
    out = e.translate_event(_ev(EventType.LLM_RETRY_TRIGGERED, {
        "attempt": 2,
        "max_attempts": 8,
        "next_delay_sec": 4.0,
        "error": "Connection reset",
        "error_code": 0,
    }))
    assert out is not None
    msg = json.loads(out)
    assert msg["type"] == "llm_retry"
    assert msg["attempt"] == 2
    assert msg["max_attempts"] == 8
    assert msg["next_delay_sec"] == 4.0
    assert msg["created_at"]


# ── interrupt reason tagging ─────────────────────────────────────────────────


def test_outage_interrupt_emits_session_update_with_reason():
    e = _entry()
    out = e.translate_event(_ev(EventType.SESSION_STATUS_CHANGED, {
        "new_status": "INTERRUPTED",
        "reason": "llm_outage",
    }))
    # INTERRUPTED now also synthesizes a session_notice frame (spec
    # 2026-07-15-session-notice-banner) -> translate_event returns a list.
    msg = json.loads(out[0])
    assert msg["type"] == "session_update"
    assert msg["status"] == "INTERRUPTED"
    assert msg["interrupt_reason"] == "llm_outage"
    # remembered on the entry so a reconnect can re-surface it
    assert e.interrupt_reason == "llm_outage"


def test_session_update_json_carries_remembered_reason_on_reconnect():
    e = _entry()
    e.translate_event(_ev(EventType.SESSION_STATUS_CHANGED, {
        "new_status": "INTERRUPTED",
        "reason": "llm_outage",
    }))
    # what the SSE generator re-pushes on (re)connect
    msg = json.loads(e._session_update_json(e.status))
    assert msg["status"] == "INTERRUPTED"
    assert msg["interrupt_reason"] == "llm_outage"


def test_generic_interrupt_has_no_reason():
    e = _entry()
    out = e.translate_event(_ev(EventType.SESSION_STATUS_CHANGED, {
        "new_status": "INTERRUPTED",
    }))
    # INTERRUPTED now also synthesizes a session_notice frame (spec
    # 2026-07-15-session-notice-banner) -> translate_event returns a list.
    msg = json.loads(out[0])
    assert msg["status"] == "INTERRUPTED"
    assert msg.get("interrupt_reason") is None
    assert e.interrupt_reason is None


def test_reason_cleared_when_leaving_interrupted():
    e = _entry()
    e.translate_event(_ev(EventType.SESSION_STATUS_CHANGED, {
        "new_status": "INTERRUPTED",
        "reason": "llm_outage",
    }))
    assert e.interrupt_reason == "llm_outage"
    e.translate_event(_ev(EventType.SESSION_STATUS_CHANGED, {"new_status": "RUNNING"}))
    assert e.interrupt_reason is None
    msg = json.loads(e._session_update_json(e.status))
    assert msg.get("interrupt_reason") is None
