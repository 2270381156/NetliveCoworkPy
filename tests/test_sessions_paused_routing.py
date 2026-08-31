"""PAUSED is treated like PAUSED_HITL by /messages (resolve HITL) and /interrupt (allowed)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import netlivecowork.api.sessions as sessions_mod
from netlivecowork.api.models.session import SessionEntry
from netlivecowork.api.schemas.sessions import SendMessageRequest


def _entry(sid: str, status: str) -> SessionEntry:
    e = SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                     tenant_id="default", llm_model=None, llm_account=None)
    e.status = status
    return e


class _StubRuntime:
    def __init__(self) -> None:
        self.paused: list[str] = []

    async def pause_session(self, sid: str) -> bool:
        self.paused.append(sid)
        return True


async def test_messages_in_paused_routes_to_hitl(monkeypatch) -> None:
    sid = "s_paused_msg"
    entry = _entry(sid, "PAUSED")
    sessions_mod._sm._sessions[sid] = entry
    called = {}

    async def fake_submit(e, content):
        called["entry"] = e
        called["content"] = content
        return {"ok": True}

    monkeypatch.setattr(sessions_mod, "_submit_hitl_response", fake_submit)
    try:
        result = await sessions_mod.send_message(
            sid,
            SendMessageRequest(
                content="hello",
                user_info={"id": "user-1", "username": "alice", "role": "USER"},
            ),
            runtime=None,
        )
        assert called["content"] == "hello"
        assert called["entry"] is entry
        assert entry.user_info == {
            "id": "user-1",
            "username": "alice",
            "role": "USER",
        }
        assert result == {"ok": True}
    finally:
        sessions_mod._sm._sessions.pop(sid, None)


async def test_rejected_message_does_not_replace_running_session_user() -> None:
    sid = "s_running_user"
    entry = _entry(sid, "RUNNING")
    entry.user_info = {"id": "user-1", "username": "alice", "role": "USER"}
    sessions_mod._sm._sessions[sid] = entry
    try:
        with pytest.raises(HTTPException) as exc_info:
            await sessions_mod.send_message(
                sid,
                SendMessageRequest(
                    content="hello",
                    user_info={"id": "user-2", "username": "bob", "role": "USER"},
                ),
                runtime=None,
            )

        assert exc_info.value.status_code == 409
        assert entry.user_info == {
            "id": "user-1",
            "username": "alice",
            "role": "USER",
        }
    finally:
        sessions_mod._sm._sessions.pop(sid, None)


async def test_interrupt_in_paused_is_noop(monkeypatch) -> None:
    """暂停一个已软暂停(PAUSED)的会话必须是 no-op：不再软打断、且**绝不**取消 pending HITL。

    取消那条 wait_for_user HITL 会摧毁 parked 任务唯一的续跑入口、把会话卡死（回归用例）。
    """
    sid = "s_paused_int"
    entry = _entry(sid, "PAUSED")
    sessions_mod._sm._sessions[sid] = entry
    runtime = _StubRuntime()

    cancelled: list[str] = []

    async def fake_cancel(session_id):
        cancelled.append(session_id)

    monkeypatch.setattr(sessions_mod, "_cancel_pending_hitl", fake_cancel)
    try:
        result = await sessions_mod.interrupt_session(sid, runtime=runtime)
        assert sid not in runtime.paused          # 不对已暂停会话再软打断
        assert cancelled == []                     # 不取消 pending HITL（关键）
        assert result["status"] == "PAUSED"        # 状态保持
    finally:
        sessions_mod._sm._sessions.pop(sid, None)


async def test_interrupt_in_running_pauses(monkeypatch) -> None:
    sid = "s_running_int"
    entry = _entry(sid, "RUNNING")
    sessions_mod._sm._sessions[sid] = entry
    runtime = _StubRuntime()

    cancelled: list[str] = []

    async def fake_cancel(session_id):
        cancelled.append(session_id)

    monkeypatch.setattr(sessions_mod, "_cancel_pending_hitl", fake_cancel)
    try:
        await sessions_mod.interrupt_session(sid, runtime=runtime)
        assert sid in runtime.paused              # RUNNING → 软打断
        assert cancelled == []                     # 即便 RUNNING 也不应取消 HITL
    finally:
        sessions_mod._sm._sessions.pop(sid, None)


async def test_interrupt_rejected_in_terminal(monkeypatch) -> None:
    sid = "s_done_int"
    entry = _entry(sid, "SUCCEEDED")
    sessions_mod._sm._sessions[sid] = entry
    runtime = _StubRuntime()

    async def fake_cancel(session_id):
        return None

    monkeypatch.setattr(sessions_mod, "_cancel_pending_hitl", fake_cancel)
    try:
        with pytest.raises(HTTPException) as exc:
            await sessions_mod.interrupt_session(sid, runtime=runtime)
        assert exc.value.status_code == 409
    finally:
        sessions_mod._sm._sessions.pop(sid, None)
