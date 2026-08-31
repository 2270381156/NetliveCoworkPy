"""WorkspaceWriteAuthorizer: workspace constraint for write_file/edit_file.

Inside-workspace (incl. relative) → ALLOW (both modes, no HITL).
Outside-workspace → auto: hard DENY with cwd + relative-path guidance (no HITL);
                    manual: HITL confirm.
Workspace unregistered or no path arg → ALLOW.
"""
from __future__ import annotations

import sys

import pytest

from ctx_weft.core.state.models import Agent
from netlivecowork.auth.fs_write_authorizer import WorkspaceWriteAuthorizer
from netlivecowork.auth.mode_store import BashReviewModeStore

WS = "C:\\work\\ws"

# 断言 Windows 绝对路径/反斜杠 traversal 语义（C:\work\ws、..\..）。判定靠 os.path，非 Windows
# 把反斜杠当普通字符 → 结果不同，故仅 Windows 有意义。
_win_only = pytest.mark.skipif(sys.platform != "win32", reason="Windows 路径语义，仅 Windows 有效")


class _Cap:
    id = "fs:write_file"
    name = "write_file"
    description = "write a file"


class _FakeHitl:
    def __init__(self) -> None:
        self.requested = False

    async def request(self, **kw):
        self.requested = True
        return "appr_1"

    def find_for_tool_call(self, tool_call_id):
        return None

    async def find_resolved_for_tool_call(self, session_id, tool_call_id):
        return None  # 无既有决定（内存/事件日志均未命中）→ 走 request 求批

    async def wait(self, hitl_id):
        class _A:
            accepted = True
            status = "accepted"
            message = ""
            modified_arguments = None
        return _A()


def _agent():
    return Agent(id="ag1", session_id="s1", template_id="t", template_version="1", status="RUNNING")


def _authz(hitl, store, ws=WS):
    return WorkspaceWriteAuthorizer(
        hitl_manager=hitl, mode_store=store, workspace_lookup=lambda sid: ws,
    )


async def test_relative_path_allows_no_hitl():
    hitl = _FakeHitl(); store = BashReviewModeStore()
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"path": "out/result.txt"})
    assert d.allowed is True
    assert hitl.requested is False


@_win_only
async def test_absolute_path_inside_workspace_allows():
    hitl = _FakeHitl(); store = BashReviewModeStore()
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"path": "C:\\work\\ws\\sub\\a.txt"})
    assert d.allowed is True
    assert hitl.requested is False


async def test_outside_workspace_auto_hard_denies_with_guidance():
    hitl = _FakeHitl(); store = BashReviewModeStore()  # default auto
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"path": "C:\\Windows\\x.txt"})
    assert d.allowed is False
    assert WS in d.message            # current working directory surfaced
    assert "相对路径" in d.message     # tells agent to use a relative path
    assert hitl.requested is False    # auto mode does NOT pop HITL


async def test_outside_workspace_manual_goes_to_hitl():
    hitl = _FakeHitl(); store = BashReviewModeStore(); store.set("s1", "manual")
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"path": "C:\\Windows\\x.txt"})
    assert hitl.requested is True


@_win_only
async def test_parent_traversal_outside_auto_denies():
    hitl = _FakeHitl(); store = BashReviewModeStore()
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"path": "..\\..\\secret.txt"})
    assert d.allowed is False
    assert hitl.requested is False


async def test_no_workspace_registered_allows():
    hitl = _FakeHitl(); store = BashReviewModeStore()
    authz = WorkspaceWriteAuthorizer(hitl_manager=hitl, mode_store=store, workspace_lookup=lambda sid: None)
    d = await authz.authorize(_Cap(), _agent(), None, None, {"path": "C:\\Windows\\x.txt"})
    assert d.allowed is True
    assert hitl.requested is False


async def test_missing_path_allows():
    hitl = _FakeHitl(); store = BashReviewModeStore()
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {})
    assert d.allowed is True


async def test_blocked_write_emits_terminal_tool_call_event():
    """硬拒时补发一条持久化 tool_call 终态（is_error），收掉前端「执行中」气泡（按 tool_call_id 匹配）。

    内核对执行前硬拒不发 CAPABILITY_FINISHED → 前端 pending 气泡收不到终态、卡执行中；这里补发解决。"""
    import json as _json
    from netlivecowork.api.models import session as _sm

    captured: list[dict] = []

    class _Entry:
        async def _append_json(self, s):
            captured.append(_json.loads(s))

    _sm._sessions["s1"] = _Entry()  # type: ignore[assignment]
    try:
        hitl = _FakeHitl(); store = BashReviewModeStore()  # default auto → 硬拒
        d = await _authz(hitl, store).authorize(
            _Cap(), _agent(), None, None, {"path": "C:\\Windows\\x.txt"}, tool_call_id="tc-42")
        assert d.allowed is False
        assert len(captured) == 1
        ev = captured[0]
        assert ev["type"] == "tool_call"
        assert ev["tool_call_id"] == "tc-42"     # 与 pending 同 id → 前端据此收尾
        assert ev["is_error"] is True
        assert WS in ev["result"]                 # 结果里带拒绝说明
    finally:
        _sm._sessions.pop("s1", None)


async def test_blocked_write_without_tool_call_id_skips_emit():
    from netlivecowork.api.models import session as _sm

    captured: list[str] = []

    class _Entry:
        async def _append_json(self, s):
            captured.append(s)

    _sm._sessions["s1"] = _Entry()  # type: ignore[assignment]
    try:
        hitl = _FakeHitl(); store = BashReviewModeStore()
        d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"path": "C:\\Windows\\x.txt"})
        assert d.allowed is False
        assert captured == []   # 无 tool_call_id → 不补发（无从匹配气泡）
    finally:
        _sm._sessions.pop("s1", None)
