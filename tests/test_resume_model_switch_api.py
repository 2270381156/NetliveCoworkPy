"""Task 7: /resume 可选模型字段 + 崩溃挂起 run 的 SSE 错误透传（recoverable 标记）。

三点覆盖：
1. POST /resume 带 body {"llm_account", "llm_model"} → 写回 entry，且透传给 runtime.recover_session。
2. POST /resume 无 body → 完全兼容现状（entry 原值不变）。
3. SessionEntry.translate_event 对 RUN_FINISHED 的翻译：崩溃挂起（final_status=SUSPENDED 且
   error 非空）冒泡 task_failed 并带 recoverable=true；干净挂起（error=None）不冒泡。
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ctx_weft.core.events.types import Event, EventType

from netlivecowork.api import deps
from netlivecowork.api import sessions as sess_api
from netlivecowork.api.models import session as sm
from netlivecowork.api.models.session import SessionEntry
from netlivecowork.api.schemas.sessions import ResumeSessionRequest

_TS = datetime(2026, 7, 15, tzinfo=timezone.utc)


class _StubEventBus:
    async def stream(self, _filter):
        return
        yield  # pragma: no cover  (空异步生成器：session_consumer 立即结束，不触碰 entry.status)


class _StubRuntime:
    def __init__(self):
        self.event_bus = _StubEventBus()
        self.recover_calls: list[tuple[str, str | None, str | None]] = []

    async def recover_session(self, session_id, llm_account=None, llm_model=None):
        self.recover_calls.append((session_id, llm_account, llm_model))


def _interrupted_entry(session_id: str) -> SessionEntry:
    entry = SessionEntry(
        session_id=session_id, template_id="tpl", user_prompt="hi",
        tenant_id="default", llm_model="old-model", llm_account="old-acc",
    )
    entry.status = "INTERRUPTED"
    return entry


@pytest.fixture
def wired():
    saved_sessions = dict(sm._sessions)
    saved_state_store = sm._state_store
    sm._sessions.clear()
    sm.set_state_store(None)  # 确保 _ensure_workspace_registered 静默跳过，无需 DB
    yield
    sm._sessions.clear()
    sm._sessions.update(saved_sessions)
    sm.set_state_store(saved_state_store)


@pytest.mark.asyncio
async def test_resume_with_body_switches_model_and_forwards_to_runtime(wired):
    sid = "ses_switch"
    entry = _interrupted_entry(sid)
    sm._sessions[sid] = entry
    runtime = _StubRuntime()

    await sess_api.resume_session(
        sid, req=ResumeSessionRequest(llm_account="acc2", llm_model="big-model"), runtime=runtime,
    )

    assert entry.llm_account == "acc2"
    assert entry.llm_model == "big-model"
    assert runtime.recover_calls == [(sid, "acc2", "big-model")]


@pytest.mark.asyncio
async def test_resume_without_body_is_backward_compatible(wired):
    sid = "ses_nobody"
    entry = _interrupted_entry(sid)
    sm._sessions[sid] = entry
    runtime = _StubRuntime()

    await sess_api.resume_session(sid, req=None, runtime=runtime)

    # 无 body：entry 原值透传，行为与现状一致（不做重置）。
    assert entry.llm_account == "old-acc"
    assert entry.llm_model == "old-model"
    assert runtime.recover_calls == [(sid, "old-acc", "old-model")]


def test_resume_without_body_is_backward_compatible_over_http(wired):
    """Wire-level check: POST /resume with literally no body must not 422 and
    must behave exactly like req=None (entry values pass through unchanged)."""
    sid = "ses_nobody_http"
    entry = _interrupted_entry(sid)
    sm._sessions[sid] = entry
    runtime = _StubRuntime()

    app = FastAPI()
    app.include_router(sess_api.router)
    app.dependency_overrides[deps.get_runtime] = lambda: runtime
    client = TestClient(app)

    resp = client.post(f"/sessions/{sid}/resume")  # no json= at all

    assert resp.status_code == 200, resp.text
    assert entry.llm_account == "old-acc"
    assert entry.llm_model == "old-model"
    assert runtime.recover_calls == [(sid, "old-acc", "old-model")]


def _run_finished(**payload) -> Event:
    return Event(id="evt_rf", run_id="r1", sequence=1, session_id="ses_x",
                 type=EventType.RUN_FINISHED, timestamp=_TS, payload=payload)


def test_crashed_suspend_bubbles_task_failed_recoverable():
    entry = SessionEntry(session_id="ses_x", template_id="tpl", user_prompt="hi",
                         tenant_id="default", llm_model=None, llm_account=None)
    ev = _run_finished(final_status="SUSPENDED", error="boom", will_retry=False, error_type="CONTEXT_OVERFLOW")

    out = entry.translate_event(ev)

    assert out is not None
    import json
    data = json.loads(out)
    assert data["type"] == "task_failed"
    assert data["recoverable"] is True
    assert data["error"] == "boom"
    assert data["error_type"] == "CONTEXT_OVERFLOW"
    assert data["will_retry"] is False


def test_retriable_crash_bubbles_but_not_recoverable():
    """崩溃挂起若带 will_retry=True（core 将自动重投递，run 仍处于 RUNNING，不是可 /resume
    的挂起）：气泡仍要冒泡（走既有 will_retry 分支），但 recoverable 必须为 False——
    否则前端会在会话还在 RUNNING 时误现 resume 入口。"""
    entry = SessionEntry(session_id="ses_x", template_id="tpl", user_prompt="hi",
                         tenant_id="default", llm_model=None, llm_account=None)
    ev = _run_finished(final_status="SUSPENDED", error="boom", will_retry=True)

    out = entry.translate_event(ev)

    assert out is not None
    import json
    data = json.loads(out)
    assert data["type"] == "task_failed"
    assert data["will_retry"] is True
    assert data["recoverable"] is False


def test_clean_suspend_does_not_bubble():
    entry = SessionEntry(session_id="ses_x", template_id="tpl", user_prompt="hi",
                         tenant_id="default", llm_model=None, llm_account=None)
    ev = _run_finished(final_status="SUSPENDED", error=None, will_retry=False)

    out = entry.translate_event(ev)

    assert out is None


def test_failed_still_bubbles_not_recoverable():
    """回归：既有 FAILED 分支（非崩溃挂起）不受影响——recoverable 应为 False。"""
    entry = SessionEntry(session_id="ses_x", template_id="tpl", user_prompt="hi",
                         tenant_id="default", llm_model=None, llm_account=None)
    ev = _run_finished(final_status="FAILED", error="boom", will_retry=False)

    out = entry.translate_event(ev)

    import json
    data = json.loads(out)
    assert data["type"] == "task_failed"
    assert data["recoverable"] is False
