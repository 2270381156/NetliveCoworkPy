"""import_session 路由：200 返回新会话 dict；坏文件 400。"""
import pytest
from fastapi import HTTPException

import netlivecowork.api.sessions as sessions_mod
from netlivecowork.api.models import session as sm
from netlivecowork.observability.session_import import InvalidSessionDumpError

pytestmark = pytest.mark.asyncio


class _FakeUpload:
    def __init__(self, data: bytes):
        self._data = data
    async def read(self) -> bytes:
        return self._data


async def test_import_route_returns_session(monkeypatch):
    async def fake_import(data, factory):
        assert data == b"DUMP"
        return "imp_new"
    async def fake_register(store, sid):
        sm._sessions[sid] = sm.SessionEntry(
            session_id=sid, template_id="tpl", user_prompt="go",
            tenant_id="default", llm_model=None, llm_account=None,
        )
    monkeypatch.setattr(sessions_mod, "import_session_db", fake_import)
    monkeypatch.setattr(sessions_mod, "register_session_from_db", fake_register)
    monkeypatch.setattr(sessions_mod, "_session_factory", lambda: object())
    sm._sessions.clear()

    result = await sessions_mod.import_session(_FakeUpload(b"DUMP"))
    assert result["id"] == "imp_new"


async def test_import_route_400_on_bad_file(monkeypatch):
    async def boom(data, factory):
        raise InvalidSessionDumpError("bad")
    monkeypatch.setattr(sessions_mod, "import_session_db", boom)
    monkeypatch.setattr(sessions_mod, "_session_factory", lambda: object())

    with pytest.raises(HTTPException) as ei:
        await sessions_mod.import_session(_FakeUpload(b"xxx"))
    assert ei.value.status_code == 400
