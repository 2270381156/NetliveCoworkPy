from __future__ import annotations

import json
from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.api.models.session import _HISTORY_TYPES, SessionEntry


def _entry() -> SessionEntry:
    return SessionEntry(
        session_id="ses_1",
        template_id="tpl",
        user_prompt="original prompt",
        tenant_id="default",
        llm_model=None,
        llm_account=None,
    )


def _event(type_: str, **payload) -> Event:
    return Event(
        id=f"evt_{type_}",
        run_id="run_1",
        sequence=1,
        session_id="ses_1",
        task_id="tsk_1",
        type=type_,
        timestamp=datetime(2026, 8, 26, tzinfo=timezone.utc),
        payload=payload,
    )


def _frames(result: str | list[str] | None) -> list[dict]:
    if result is None:
        return []
    return [json.loads(item) for item in (result if isinstance(result, list) else [result])]


def test_recognize_intent_returns_goal_update_in_order() -> None:
    entry = _entry()

    frames = _frames(entry.translate_event(_event(
        EventType.RECOGNIZE_INTENT_TOOL_CALL,
        title="同步会话标题",
        description="",
        session_goal="保证两个标题同步更新",
    )))

    assert entry.goal == "保证两个标题同步更新"
    assert [frame["type"] for frame in frames] == [
        "session_goal_updated",
        "daemon_control_tool_call",
    ]
    assert frames[0]["goal"] == "保证两个标题同步更新"


def test_same_goal_is_not_emitted_twice() -> None:
    entry = _entry()
    payload = {
        "title": "同步会话标题",
        "description": "",
        "session_goal": "保证两个标题同步更新",
    }

    entry.translate_event(_event(EventType.RECOGNIZE_INTENT_TOOL_CALL, **payload))
    frames = _frames(entry.translate_event(_event(EventType.RECOGNIZE_INTENT_COMPLETED, **payload)))

    assert all(frame["type"] != "session_goal_updated" for frame in frames)


def test_goal_update_is_replayed_in_history() -> None:
    assert "session_goal_updated" in _HISTORY_TYPES
