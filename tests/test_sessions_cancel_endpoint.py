"""POST /{id}/cancel — hard cancel-all, session record kept (not deleted)."""

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
    def __init__(self) -> None:
        self.cancelled: list[str] = []

    async def cancel_session(self, sid: str) -> bool:
        self.cancelled.append(sid)
        return True


async def test_cancel_endpoint_cancels_without_deleting(monkeypatch) -> None:
    sid = "s_cancel"
    entry = _entry(sid, "RUNNING")
    sessions_mod._sm._sessions[sid] = entry
    runtime = _StubRuntime()

    async def fake_cancel_hitl(session_id):
        return None

    monkeypatch.setattr(sessions_mod, "_cancel_pending_hitl", fake_cancel_hitl)
    try:
        await sessions_mod.cancel_session_endpoint(sid, runtime=runtime)
        assert sid in runtime.cancelled
        assert sid in sessions_mod._sm._sessions      # record NOT deleted
    finally:
        sessions_mod._sm._sessions.pop(sid, None)


async def test_cancel_endpoint_rejected_in_terminal(monkeypatch) -> None:
    sid = "s_cancel_done"
    entry = _entry(sid, "SUCCEEDED")
    sessions_mod._sm._sessions[sid] = entry
    runtime = _StubRuntime()
    try:
        with pytest.raises(HTTPException) as exc:
            await sessions_mod.cancel_session_endpoint(sid, runtime=runtime)
        assert exc.value.status_code == 409
    finally:
        sessions_mod._sm._sessions.pop(sid, None)
