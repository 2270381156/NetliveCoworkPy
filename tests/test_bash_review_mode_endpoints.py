# tests/test_bash_review_mode_endpoints.py
"""bash-review-mode GET/PUT; call route functions directly (see test_workspace_endpoints)."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from netlivecowork.api import deps
from netlivecowork.api import sessions as sess_api
from netlivecowork.api.models import session as sm
from netlivecowork.api.schemas.sessions import BashReviewModeRequest
from netlivecowork.auth.mode_store import BashReviewModeStore


class _Entry:
    pass


@pytest.fixture
def wired():
    saved = dict(sm._sessions)
    sm._sessions.clear()
    sm._sessions["s1"] = _Entry()
    store = BashReviewModeStore()
    deps.set_bash_review_modes(store)
    yield store
    sm._sessions.clear()
    sm._sessions.update(saved)
    deps.set_bash_review_modes(None)


async def test_get_default_semiauto(wired):
    out = await sess_api.get_bash_review_mode("s1")
    assert out == {"mode": "semiauto"}


async def test_put_sets_manual(wired):
    out = await sess_api.set_bash_review_mode("s1", BashReviewModeRequest(mode="manual"))
    assert out["mode"] == "manual"            # 返回还含 os_low_integrity 标志（切非全自动时为 False）
    assert out.get("os_low_integrity") is False
    assert wired.get("s1") == "manual"


async def test_put_invalid_422(wired):
    with pytest.raises(HTTPException) as e:
        await sess_api.set_bash_review_mode("s1", BashReviewModeRequest(mode="nope"))
    assert e.value.status_code == 422


async def test_unknown_session_404(wired):
    with pytest.raises(HTTPException) as e:
        await sess_api.get_bash_review_mode("ghost")
    assert e.value.status_code == 404
