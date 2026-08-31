"""host translate_event 对 compact 事件族的映射：状态 + 持久标记 + 死分支清理。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

from ctx_weft.core.events import EventType
from netlivecowork.api.models import session as sess_mod
from netlivecowork.api.models.session import SessionEntry


def _entry() -> SessionEntry:
    return SessionEntry(
        session_id="s1", template_id="tpl", user_prompt="hi",
        tenant_id="default", llm_model="m", llm_account="acc",
    )


def _ev(t: str, payload: dict) -> SimpleNamespace:
    return SimpleNamespace(
        type=t, payload=payload, timestamp=datetime.now(timezone.utc),
        run_id="r1", task_id="tsk_1", agent_id="agt_1",
    )


def _one(out) -> dict | None:
    if out is None:
        return None
    if isinstance(out, list):
        assert len(out) == 1
        out = out[0]
    return json.loads(out)


def test_started_maps_to_compact_started():
    got = _one(_entry().translate_event(_ev(EventType.MEMORY_COMPACT_STARTED, {
        "trigger": "compact", "token_estimate": 900, "target_tokens": 600})))
    assert got["type"] == "compact_started"
    assert got["trigger"] == "compact"


def test_finished_with_folds_maps_to_context_compacted():
    got = _one(_entry().translate_event(_ev(EventType.MEMORY_COMPACT_FINISHED, {
        "total_superseded": 5, "freed_tokens": 400,
        "levels": ["root_experience"], "trigger": "compact"})))
    assert got["type"] == "context_compacted"
    assert got["total_superseded"] == 5
    assert got["freed_tokens"] == 400
    assert got["levels"] == ["root_experience"]


def test_finished_without_folds_is_silent():
    out = _entry().translate_event(_ev(EventType.MEMORY_COMPACT_FINISHED, {
        "total_superseded": 0, "freed_tokens": 0, "levels": []}))
    assert out is None


def test_memory_compacted_is_telemetry_only():
    out = _entry().translate_event(_ev(EventType.MEMORY_COMPACTED, {
        "superseded_count": 3, "layer": "agent", "source": "root_experience", "freed_tokens": 100}))
    assert out is None


def test_compact_triggered_dead_branch_removed():
    out = _entry().translate_event(_ev(EventType.COMPACT_TRIGGERED, {}))
    assert out is None


def test_persist_and_history_membership():
    assert "compact_started" in SessionEntry._NO_PERSIST
    assert "context_compacted" in sess_mod._HISTORY_TYPES
