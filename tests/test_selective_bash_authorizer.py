"""SelectiveBashAuthorizer: ALLOW skips HITL, DENY blocks with message,
CONFIRM delegates to HITL, manual mode upgrades ALLOW→CONFIRM."""
from __future__ import annotations

import pytest

from ctx_weft.core.state.models import Agent
from netlivecowork.auth.bash_authorizer import SelectiveBashAuthorizer
from netlivecowork.auth.mode_store import BashReviewModeStore


class _Cap:
    id = "fs:bash_exec"
    name = "bash_exec"
    description = "run a shell command"


class _FakeHitl:
    """Records whether the HITL path was taken; auto-approves."""
    def __init__(self) -> None:
        self.requested = False

    async def request(self, **kw):
        self.requested = True
        self._kw = kw
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


def _authz(hitl, store, ws="C:\\ws"):
    return SelectiveBashAuthorizer(
        hitl_manager=hitl, mode_store=store, workspace_lookup=lambda sid: ws,
    )


async def test_allow_skips_hitl():
    hitl = _FakeHitl(); store = BashReviewModeStore()
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"command": "ls"})
    assert d.allowed is True
    assert hitl.requested is False


async def test_network_allowed_now():
    # 网络硬拒已移除：auto 模式下 curl 视同普通命令 → 直接放行、不弹确认。
    hitl = _FakeHitl(); store = BashReviewModeStore()
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"command": "curl http://x"})
    assert d.allowed is True
    assert hitl.requested is False


async def test_dangerous_goes_to_hitl():
    hitl = _FakeHitl(); store = BashReviewModeStore()
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"command": "rm -rf x"})
    assert hitl.requested is True
    assert d.allowed is True  # fake auto-approves


async def test_manual_mode_upgrades_allow_to_hitl():
    hitl = _FakeHitl(); store = BashReviewModeStore(); store.set("s1", "manual")
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"command": "ls"})
    assert hitl.requested is True


async def test_manual_mode_network_goes_through_hitl():
    # 网络硬拒已移除：manual 模式下 wget 与普通命令一样走人工确认（不再命令级直接拒）。
    hitl = _FakeHitl(); store = BashReviewModeStore(); store.set("s1", "manual")
    d = await _authz(hitl, store).authorize(_Cap(), _agent(), None, None, {"command": "wget http://x"})
    assert hitl.requested is True
    assert d.allowed is True  # _FakeHitl 自动批准
