"""SessionEntry.to_dict() 必须回传 workspace（前端 session.workspace 据此渲染工作区根）。"""
from __future__ import annotations

from netlivecowork.api.models.session import SessionEntry


def _entry() -> SessionEntry:
    return SessionEntry(
        session_id="s1",
        template_id="tpl",
        user_prompt="hi",
        tenant_id="default",
        llm_model="m",
        llm_account="acc",
    )


def test_to_dict_includes_workspace_default_none():
    d = _entry().to_dict()
    assert "workspace" in d
    assert d["workspace"] is None


def test_to_dict_reflects_set_workspace():
    e = _entry()
    e.workspace = "C:/ws/demo"
    assert e.to_dict()["workspace"] == "C:/ws/demo"
