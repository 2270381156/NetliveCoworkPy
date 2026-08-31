from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.providers.capability.skills.runtime import usage as skill_reporter


def _response(
    status_code: int,
    *,
    json_body: Any | None = None,
    text: str | None = None,
    content_type: str = "application/json",
) -> httpx.Response:
    request = httpx.Request("POST", "https://example.invalid/datalink/saveEntity")
    kwargs: dict[str, Any] = {
        "request": request,
        "headers": {"content-type": content_type},
    }
    if json_body is not None:
        kwargs["json"] = json_body
    else:
        kwargs["text"] = text or ""
    return httpx.Response(status_code, **kwargs)


def _event(
    event_type: EventType,
    *,
    task_id: str = "task-1",
    session_id: str = "session-1",
    payload: dict[str, Any] | None = None,
) -> Event:
    return Event(
        id=f"event-{event_type}",
        run_id="run-1",
        sequence=1,
        session_id=session_id,
        type=event_type,
        timestamp=datetime.now(timezone.utc),
        task_id=task_id,
        payload=payload or {},
    )


@pytest.mark.parametrize(
    ("raw_name", "expected"),
    [
        ("document-review", "document-review"),
        ("local_skill__document-review", "document-review"),
        ("cloud_skill__document-review", "document-review"),
        ("cloud_skill__local_skill__document-review", "document-review"),
    ],
)
def test_normalize_skill_name_removes_provider_prefixes(
    raw_name: str,
    expected: str,
) -> None:
    assert skill_reporter._normalize_skill_name(raw_name) == expected



def test_session_user_pwd_falls_back_to_authenticated_desktop_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        skill_reporter,
        "_sessions_store",
        {"session-1": SimpleNamespace(user_info=None, workspace=r"E:\workspace")},
    )
    monkeypatch.setattr(
        skill_reporter.current_user,
        "get_current_username",
        lambda: "bob",
    )

    assert skill_reporter._session_user_pwd("session-1") == (
        r"user_bob/E:\workspace",
        "current-user",
    )



@pytest.mark.asyncio
async def test_cloud_skill_name_is_reported_without_prefix_and_uses_monotonic_time(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monotonic_values = iter([100.0, 102.3456])
    reported: dict[str, Any] = {}

    def fake_report(kind: str, payload: dict, **_: Any) -> int:
        reported.update(function_name=payload["function_name"], duration=payload["duration"])
        return 1

    monkeypatch.setattr(
        skill_reporter,
        "time",
        SimpleNamespace(monotonic=lambda: next(monotonic_values)),
    )
    monkeypatch.setattr(
        skill_reporter,
        "consume_skill_own_reporting",
        lambda session_id, task_id, name: False,
    )
    monkeypatch.setattr(skill_reporter, "record", fake_report)

    reporter = skill_reporter.SkillReporter()
    reporter._handle_task_created(
        _event(
            EventType.TASK_CREATED,
            payload={
                "task": {
                    "id": "task-1",
                    "settings": {"skill_name": "cloud_skill__document-review"},
                }
            },
        )
    )
    await reporter._handle_capability_finished(
        _event(
            EventType.CAPABILITY_FINISHED,
            payload={"invocation_id": "invocation-1"},
        )
    )

    assert reported == {
        "function_name": "document-review",
        "duration": 2.346,
    }


@pytest.mark.asyncio
async def test_task_pwd_is_available_during_skill_and_kept_after_capability_finished(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monotonic_values = iter([100.0, 101.0])
    reported: dict[str, Any] = {}

    def fake_report(kind: str, payload: dict, **_: Any) -> int:
        function_name, user_id = payload["function_name"], payload["user_id"]
        reported.update(
            function_name=function_name,
            user_id=user_id,
            pwd_at_delivery=os.environ.get("PWD"),
        )
        return 1

    monkeypatch.setenv("PWD", r"E:\app-data")
    monkeypatch.delenv("OLDPWD", raising=False)
    monkeypatch.setattr(
        skill_reporter,
        "time",
        SimpleNamespace(monotonic=lambda: next(monotonic_values)),
    )
    monkeypatch.setattr(
        skill_reporter,
        "_sessions_store",
        {
            "session-1": SimpleNamespace(
                user_info={"id": "user-1", "username": "alice", "role": "USER"},
                workspace=None,
            )
        },
    )
    monkeypatch.setattr(
        skill_reporter,
        "consume_skill_own_reporting",
        lambda session_id, task_id, name: False,
    )
    monkeypatch.setattr(skill_reporter, "record", fake_report)

    reporter = skill_reporter.SkillReporter()
    reporter._handle_task_created(
        _event(
            EventType.TASK_CREATED,
            payload={
                "task": {
                    "id": "task-1",
                    "settings": {"skill_name": "local_skill__document-review"},
                }
            },
        )
    )
    await reporter.on_event(_event(EventType.TASK_STARTED))

    # Skill 内部执行发生在 TASK_STARTED 与 CAPABILITY_FINISHED 之间，此时必须能读到用户。
    assert os.environ["PWD"] == "user_alice/"
    assert skill_reporter._get_user_id_from_pwd() == "alice"

    await reporter._handle_capability_finished(
        _event(EventType.CAPABILITY_FINISHED)
    )

    assert reported == {
        "function_name": "document-review",
        "user_id": "alice",
        "pwd_at_delivery": "user_alice/",
    }
    assert os.environ["PWD"] == "user_alice/"


@pytest.mark.asyncio
async def test_next_task_started_replaces_then_clears_managed_pwd(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    reported: list[tuple[str, str | None]] = []

    def fake_report(kind: str, payload: dict, **_: Any) -> int:
        reported.append((payload["function_name"], payload["user_id"]))
        return 1

    monkeypatch.setenv("PWD", r"E:\app-data")
    monkeypatch.delenv("OLDPWD", raising=False)
    monkeypatch.setattr(
        skill_reporter,
        "_sessions_store",
        {
            "session-1": SimpleNamespace(
                user_info={"username": "alice"}, workspace=None,
            ),
            "session-2": SimpleNamespace(
                user_info={"username": "bob"}, workspace=r"F:\workspace",
            ),
        },
    )
    monkeypatch.setattr(
        skill_reporter.current_user,
        "get_current_username",
        lambda: "",
    )
    monkeypatch.setattr(
        skill_reporter,
        "consume_skill_own_reporting",
        lambda session_id, task_id, name: False,
    )
    monkeypatch.setattr(skill_reporter, "record", fake_report)

    reporter = skill_reporter.SkillReporter()
    reporter._handle_task_created(
        _event(
            EventType.TASK_CREATED,
            task_id="task-empty",
            session_id="session-empty",
            payload={
                "task": {
                    "id": "task-empty",
                    "settings": {"skill_name": "local_skill__empty"},
                }
            },
        )
    )
    await reporter.on_event(
        _event(
            EventType.TASK_STARTED,
            task_id="task-empty",
            session_id="session-empty",
        )
    )
    assert reporter._task_start_time["task-empty"]["user_id"] == ""

    reporter._handle_task_created(
        _event(
            EventType.TASK_CREATED,
            task_id="task-1",
            session_id="session-1",
            payload={
                "task": {
                    "id": "task-1",
                    "settings": {"skill_name": "local_skill__first"},
                }
            },
        )
    )
    await reporter.on_event(
        _event(EventType.TASK_STARTED, task_id="task-1", session_id="session-1")
    )
    assert os.environ["PWD"] == "user_alice/"

    # 无用户任务迟到完成时，不能继承下一任务刚设置的 alice。
    await reporter._handle_capability_finished(
        _event(
            EventType.CAPABILITY_FINISHED,
            task_id="task-empty",
            session_id="session-empty",
        )
    )
    assert reported == [("empty", "")]
    assert os.environ["PWD"] == "user_alice/"

    reporter._handle_task_created(
        _event(
            EventType.TASK_CREATED,
            task_id="task-2",
            session_id="session-2",
            payload={
                "task": {
                    "id": "task-2",
                    "settings": {"skill_name": "cloud_skill__second"},
                }
            },
        )
    )
    await reporter.on_event(
        _event(EventType.TASK_STARTED, task_id="task-2", session_id="session-2")
    )
    assert os.environ["PWD"] == r"user_bob/F:\workspace"

    # task-2 已把进程 PWD 换成 bob；task-1 的迟到完成仍必须使用启动时保存的 alice。
    await reporter._handle_capability_finished(
        _event(
            EventType.CAPABILITY_FINISHED,
            task_id="task-1",
            session_id="session-1",
        )
    )
    assert reported == [("empty", ""), ("first", "alice")]
    assert os.environ["PWD"] == r"user_bob/F:\workspace"

    # 下一次启动的是普通任务：只清理上一 skill 的 PWD，不再设置新值。
    await reporter.on_event(
        _event(EventType.TASK_STARTED, task_id="plain-task", session_id="session-2")
    )
    assert os.environ["PWD"] == r"E:\app-data"


@pytest.mark.asyncio
async def test_skill_with_own_reporting_can_read_pwd_and_host_does_not_clear_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("PWD", raising=False)
    monkeypatch.delenv("OLDPWD", raising=False)
    monkeypatch.setattr(
        skill_reporter,
        "_sessions_store",
        {
            "session-1": SimpleNamespace(
                user_info={"username": "alice"}, workspace=None,
            )
        },
    )
    monkeypatch.setattr(
        skill_reporter,
        "consume_skill_own_reporting",
        lambda session_id, task_id, name: True,
    )

    def unexpected_host_report(*args: Any, **kwargs: Any) -> int:
        pytest.fail("skill with own reporting must not be reported by the host")

    monkeypatch.setattr(skill_reporter, "record", unexpected_host_report)

    reporter = skill_reporter.SkillReporter()
    reporter._handle_task_created(
        _event(
            EventType.TASK_CREATED,
            payload={
                "task": {
                    "id": "task-1",
                    "settings": {"skill_name": "cloud_skill__document-review"},
                }
            },
        )
    )
    await reporter.on_event(_event(EventType.TASK_STARTED))
    assert skill_reporter._get_user_id_from_pwd() == "alice"

    await reporter._handle_capability_finished(
        _event(EventType.CAPABILITY_FINISHED)
    )
    assert os.environ["PWD"] == "user_alice/"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "terminal_event",
    [
        EventType.TASK_FINISHED,
        EventType.TASK_FAILED,
        EventType.TASK_CANCELED,
        EventType.TASK_FINALIZED,
    ],
)
async def test_terminal_task_event_cleans_tracking_state(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    terminal_event: EventType,
) -> None:
    reporter = skill_reporter.SkillReporter()
    reporter._task_start_time["task-1"] = {
        "skill_name": "document-review",
        "start_time": 1.0,
        "session_id": "session-1",
    }

    await reporter.on_event(_event(terminal_event))

    assert "task-1" not in reporter._task_start_time
