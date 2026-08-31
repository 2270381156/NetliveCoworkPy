"""POST /{id}/tasks/{task_id}/pause — 定向暂停单个在途 task（spec 2026-07-05 §2.3）。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import netlivecowork.api.sessions as sessions_mod
from netlivecowork.api.models.session import SessionEntry


def _entry(sid: str, status: str) -> SessionEntry:
    e = SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                     tenant_id="default", llm_model=None, llm_account=None)
    e.status = status
    return e


class _StubRuntime:
    def __init__(self, ok: bool = True) -> None:
        self.ok = ok
        self.calls: list[tuple[str, str]] = []

    def pause_task(self, sid: str, tid: str) -> bool:
        self.calls.append((sid, tid))
        return self.ok


async def test_pause_task_endpoint_pauses_running_task() -> None:
    sid = "s_pt"
    sessions_mod._sm._sessions[sid] = _entry(sid, "RUNNING")
    runtime = _StubRuntime(ok=True)
    try:
        await sessions_mod.pause_task_endpoint(sid, "t1", runtime=runtime)
        assert runtime.calls == [(sid, "t1")]
    finally:
        sessions_mod._sm._sessions.pop(sid, None)


async def test_pause_task_endpoint_409_when_task_not_running() -> None:
    sid = "s_pt_idle"
    sessions_mod._sm._sessions[sid] = _entry(sid, "RUNNING")
    try:
        with pytest.raises(HTTPException) as exc:
            await sessions_mod.pause_task_endpoint(sid, "t1", runtime=_StubRuntime(ok=False))
        assert exc.value.status_code == 409
    finally:
        sessions_mod._sm._sessions.pop(sid, None)


async def test_pause_task_endpoint_404_unknown_session() -> None:
    with pytest.raises(HTTPException) as exc:
        await sessions_mod.pause_task_endpoint("nope", "t1", runtime=_StubRuntime())
    assert exc.value.status_code == 404
