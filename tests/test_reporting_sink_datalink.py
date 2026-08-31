"""Datalink 出口 —— 配置、签名、HTTP 重试退避、失败分类、发不出去时的本地队列。

**这些用例是从 `test_skill_reporter.py` 原样搬过来的**（代码搬到哪测试跟到哪），
断言一个字没改，只把模块名从 `datalink` 换成 `datalink`。

它们是那次搬运唯一的依据：搬完之后这些必须全绿，才说明行为没变。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from netlivecowork.reporting.sinks import datalink


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

@pytest.mark.parametrize(
    ("pwd", "expected"),
    [
        ("user_alice/C:/workspace", "alice"),
        (r"C:\runtime\user_bob\workspace", "bob"),
        ("user_charlie", "charlie"),
    ],
)
def test_get_user_id_from_pwd_supports_windows_and_terminal_segment(
    monkeypatch: pytest.MonkeyPatch,
    pwd: str,
    expected: str,
) -> None:
    monkeypatch.setenv("PWD", pwd)
    monkeypatch.delenv("OLDPWD", raising=False)

    assert datalink._get_user_id_from_pwd() == expected


@pytest.mark.asyncio
async def test_add_agent_invocation_detail_reports_normalized_payload(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    captured: dict[str, object] = {}

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            captured["client_kwargs"] = kwargs

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            captured["url"] = url
            captured["post_kwargs"] = kwargs
            return _response(200, json_body={"ok": True})

    monkeypatch.setenv("DATALINK_BASE_URL", "https://example.invalid/datalink/")
    monkeypatch.setenv("DATALINK_AK", "sensitive-test-ak")
    monkeypatch.setenv("DATALINK_SK", "sensitive-test-sk")
    monkeypatch.setenv("DATALINK_FIELD_FUNCTION_NAME", "function_name")
    monkeypatch.setenv("DATALINK_FIELD_NE_NUMBER", "ne_number")
    monkeypatch.setenv("DATALINK_FIELD_DURATION", "duration")
    monkeypatch.setenv("DATALINK_FIELD_USER", "user")
    monkeypatch.setenv("DATALINK_FIELD_AGENT_NAME", "agent_name")
    monkeypatch.setenv("DATALINK_FIELD_AGENT_DISPLAY_NAME", "agent_display_name")
    monkeypatch.delenv("element_name", raising=False)
    monkeypatch.delenv("module_name", raising=False)
    monkeypatch.delenv("project_name", raising=False)
    monkeypatch.delenv("agent_display_name", raising=False)
    monkeypatch.setenv("PWD", "user_alice/C:/workspace")
    monkeypatch.delenv("OLDPWD", raising=False)
    monkeypatch.setattr(datalink.httpx, "AsyncClient", FakeAsyncClient)
    caplog.set_level(logging.INFO, logger=datalink.__name__)

    result = await datalink._add_agent_invocation_detail(
        "cloud_skill__document-review",
        ne_number=2,
        duration=1.25,
    )

    assert result == {"ok": True}
    assert captured["client_kwargs"] == {
        "trust_env": False,
        "verify": False,
        "timeout": 10.0,
    }
    assert captured["url"] == "https://example.invalid/datalink/saveEntity"

    post_kwargs = captured["post_kwargs"]
    assert isinstance(post_kwargs, dict)
    payload = post_kwargs["json"]
    assert isinstance(payload, dict)
    entity_data = payload["data"]["entityData"]
    assert entity_data["function_name"] == "document-review"
    assert entity_data["ne_number"] == 2
    assert entity_data["duration"] == 1.25
    assert entity_data["user"] == "alice"
    assert entity_data["agent_name"] == "On‑Prem CoWork"
    assert entity_data["agent_display_name"] == "CoWork"
    assert "function_name=document-review" in caplog.text
    assert "user_id=alice" in caplog.text
    assert "ne_number=2" in caplog.text
    assert "duration=1.25" in caplog.text
    assert "sensitive-test-ak" not in caplog.text
    assert "sensitive-test-sk" not in caplog.text
    assert "user_alice/C:/workspace" not in caplog.text


@pytest.mark.asyncio
async def test_retryable_http_error_is_retried_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    responses = iter(
        [
            _response(503, text="temporarily unavailable", content_type="text/plain"),
            _response(503, json_body={"error": "busy"}),
            _response(200, json_body={"ok": True}),
        ]
    )
    calls = 0

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            nonlocal calls
            calls += 1
            return next(responses)

    monkeypatch.setattr(datalink.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(datalink, "_DATALINK_RETRY_DELAYS", (0.0, 0.0))

    succeeded, result = await datalink._post_datalink_payload(
        url="https://example.invalid/datalink/saveEntity",
        payload={"data": {}},
        function_name="document-review",
    )

    assert succeeded is True
    assert result == {"ok": True}
    assert calls == 3
    assert "status=503" in caplog.text


@pytest.mark.asyncio
async def test_network_failure_is_retried_and_queued(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    spool_path = tmp_path / "skill-usage-retry.jsonl"
    calls = 0

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            nonlocal calls
            calls += 1
            request = httpx.Request("POST", url)
            raise httpx.ConnectError("connection reset", request=request)

    monkeypatch.setattr(datalink.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(datalink, "_DATALINK_RETRY_DELAYS", (0.0, 0.0))
    monkeypatch.setattr(datalink, "_retry_spool_path", lambda: spool_path)

    result = await datalink._add_agent_invocation_detail("document-review")

    assert calls == 3
    assert result["error_type"] == "ConnectError"
    assert result["retryable"] is True
    assert result["queued"] is True
    record = json.loads(spool_path.read_text(encoding="utf-8"))
    assert record["function_name"] == "document-review"


@pytest.mark.asyncio
async def test_non_retryable_http_error_is_not_retried_or_queued(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    spool_path = tmp_path / "skill-usage-retry.jsonl"
    calls = 0

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            nonlocal calls
            calls += 1
            return _response(400, text="invalid form", content_type="text/plain")

    monkeypatch.setattr(datalink.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(datalink, "_retry_spool_path", lambda: spool_path)

    result = await datalink._add_agent_invocation_detail("document-review")

    assert calls == 1
    assert result["status_code"] == 400
    assert result["retryable"] is False
    assert result["queued"] is False
    assert not spool_path.exists()
    assert "status=400" in caplog.text
    assert "invalid form" in caplog.text


@pytest.mark.asyncio
async def test_invalid_json_response_is_retried_and_logged(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    spool_path = tmp_path / "skill-usage-retry.jsonl"
    calls = 0

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            nonlocal calls
            calls += 1
            return _response(200, text="proxy returned an empty body", content_type="text/plain")

    monkeypatch.setattr(datalink.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(datalink, "_DATALINK_RETRY_DELAYS", (0.0, 0.0))
    monkeypatch.setattr(datalink, "_retry_spool_path", lambda: spool_path)

    result = await datalink._add_agent_invocation_detail("document-review")

    assert calls == 3
    assert result["error_type"] == "JSONDecodeError"
    assert result["queued"] is True
    assert "content_type=text/plain" in caplog.text
    assert "proxy returned an empty body" in caplog.text


@pytest.mark.asyncio
async def test_retry_spool_is_drained_after_network_recovers(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    spool_path = tmp_path / "skill-usage-retry.jsonl"
    monkeypatch.setattr(datalink, "_retry_spool_path", lambda: spool_path)
    datalink._enqueue_pending_report(
        function_name="document-review",
        payload={"data": {"entityData": {"skill": "document-review"}}},
    )

    class FakeAsyncClient:
        def __init__(self, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> httpx.Response:
            return _response(200, json_body={"ok": True})

    monkeypatch.setattr(datalink.httpx, "AsyncClient", FakeAsyncClient)

    sent = await datalink._drain_pending_reports()

    assert sent == 1
    assert not spool_path.exists()

@pytest.mark.asyncio
async def test_retry_worker_is_cancelled_on_close(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """关闭时停掉补发任务。

    从领域测试搬来：**补发是出口的队列在自我维护**，跟"什么算一次 skill 调用"无关。
    断言逐条对应，只是从 SkillReporter 改成对着队列本身。
    """
    spool_path = tmp_path / "skill-usage-retry.jsonl"
    spool_path.write_text("{}" + chr(10), encoding="utf-8")
    monkeypatch.setattr(datalink, "_retry_spool_path", lambda: spool_path)

    drainer = datalink._RetryDrainer()
    drainer.schedule(delay_seconds=3600.0)
    task = drainer._task

    assert task is not None
    assert not task.done()
    await drainer.close()
    assert drainer._task is None
    assert task.cancelled()


@pytest.mark.asyncio
async def test_closed_drainer_does_not_start_new_work(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """close 之后不再起新任务——否则应用退出时会留一个跑着的协程。"""
    spool_path = tmp_path / "skill-usage-retry.jsonl"
    spool_path.write_text("{}" + chr(10), encoding="utf-8")
    monkeypatch.setattr(datalink, "_retry_spool_path", lambda: spool_path)

    drainer = datalink._RetryDrainer()
    await drainer.close()
    drainer.schedule()
    assert drainer._task is None


def test_drainer_does_nothing_without_an_event_loop(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """同步上下文里不能抛。

    出厂默认让 skill 用量走这个出口，而 record() 可能在任何地方被调到；
    这里抛出去就会顺着打点污染业务调用点。
    """
    spool_path = tmp_path / "skill-usage-retry.jsonl"
    spool_path.write_text("{}" + chr(10), encoding="utf-8")
    monkeypatch.setattr(datalink, "_retry_spool_path", lambda: spool_path)

    datalink._RetryDrainer().schedule()      # 不抛即通过
