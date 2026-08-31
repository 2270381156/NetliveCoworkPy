"""/messages 弃轮禁止：core 拒绝开新轮（仍有未终结任务）→ host 409 + 会话翻 INTERRUPTED。

投影状态可能撒谎（终态状态但事件里滞留非终态任务）,闸门以 core 事件真相为准；
翻 INTERRUPTED 是为了让 /resume 可走（其闸门只认该状态）,用户从恢复路径续跑而非弃轮。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import netlivecowork.api.sessions as sessions_mod
from ctx_weft.core.errors import UnfinishedTasksError
from netlivecowork.api.models.session import SessionEntry
from netlivecowork.api.schemas.sessions import SendMessageRequest


class _StubStore:
    def __init__(self) -> None:
        self.status_updates: list[tuple[str, str]] = []

    async def update_session_status(self, sid: str, status: str) -> None:
        self.status_updates.append((sid, status))


class _RefusingRuntime:
    async def start_session(self, params):
        raise UnfinishedTasksError(params.session_id, ["t_stale"])


async def test_messages_maps_unfinished_to_409_and_interrupted(monkeypatch) -> None:
    sid = "s_unfinished"
    entry = SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                         tenant_id="default", llm_model=None, llm_account=None)
    entry.status = "COMPLETED"   # 投影撒谎：终态,但事件里还有未终结任务
    sessions_mod._sm._sessions[sid] = entry
    store = _StubStore()
    monkeypatch.setattr(sessions_mod._sm, "_state_store", store)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(sessions_mod, "_ensure_workspace_registered", _noop)
    monkeypatch.setattr(sessions_mod._sm, "session_consumer", _noop)
    monkeypatch.setattr(sessions_mod, "_resolve_context_limit", lambda *a, **k: 180_000)
    monkeypatch.setattr(sessions_mod, "_resolve_output_reserve", lambda *a, **k: 8192)

    try:
        with pytest.raises(HTTPException) as ei:
            await sessions_mod.send_message(
                sid, SendMessageRequest(content="next turn"), runtime=_RefusingRuntime(),
            )
        assert ei.value.status_code == 409
        assert "resume" in ei.value.detail.lower()
        assert entry.status == "INTERRUPTED"                      # 可走 /resume
        assert (sid, "INTERRUPTED") in store.status_updates       # 持久化同步
    finally:
        sessions_mod._sm._sessions.pop(sid, None)
