"""export_session 路由:200 返回字节、404 缺失会话。"""
import pytest
from fastapi import HTTPException

import netlivecowork.api.sessions as sessions_mod
from netlivecowork.observability.session_export import SessionNotFoundError

pytestmark = pytest.mark.asyncio


async def test_export_route_returns_bytes(monkeypatch):
    async def fake_export(session_id, factory):
        assert session_id == "s1"
        return b"SQLITEDATA"
    monkeypatch.setattr(sessions_mod, "export_session_db", fake_export)
    monkeypatch.setattr(sessions_mod, "_session_factory", lambda: object())

    resp = await sessions_mod.export_session("s1")
    assert resp.body == b"SQLITEDATA"
    assert resp.media_type == "application/octet-stream"


async def test_export_route_404_when_missing(monkeypatch):
    async def boom(session_id, factory):
        raise SessionNotFoundError(session_id)
    monkeypatch.setattr(sessions_mod, "export_session_db", boom)
    monkeypatch.setattr(sessions_mod, "_session_factory", lambda: object())

    with pytest.raises(HTTPException) as ei:
        await sessions_mod.export_session("nope")
    assert ei.value.status_code == 404
