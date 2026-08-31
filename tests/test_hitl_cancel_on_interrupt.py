"""interrupt / delete 收口该 session 的悬挂 pending HITL（spec/07 §3 + §12 ④）。

HitlManager.cancel() 的触发面：session 显式 interrupt / delete 时,把该 session 仍 pending 的
HITL 请求收口为 cancelled（发 HitlCancelled）。对热-park 的请求,cancel 会 set Future,
顺带唤醒悬在 await 上的协程,使协作式中断能真正生效。
"""

from __future__ import annotations

import pytest

from netlivecowork.api import deps
from netlivecowork.api.sessions import _cancel_pending_hitl
from ctx_weft.core.orchestrator.hitl_manager import HitlManager


async def test_cancel_pending_hitl_collects_session_requests() -> None:
    mgr = HitlManager()
    deps.set_hitl_manager(mgr)
    try:
        a = await mgr.request(form="question", session_id="s1", task_id="t1", tool_call_id="tcA")
        b = await mgr.request(form="approval", session_id="s1", task_id="t2", tool_call_id="tcB")
        other = await mgr.request(form="question", session_id="s2", task_id="t3", tool_call_id="tcC")

        await _cancel_pending_hitl("s1")

        assert mgr.get(a).status == "cancelled"
        assert mgr.get(b).status == "cancelled"
        assert mgr.get(other).status == "pending"        # 别的 session 不受影响
        assert mgr.list_pending(session_id="s1") == []
    finally:
        deps.set_hitl_manager(None)


async def test_cancel_pending_hitl_no_manager_is_noop() -> None:
    deps.set_hitl_manager(None)
    await _cancel_pending_hitl("s1")                       # 不抛


async def test_cancel_unblocks_hot_waiter() -> None:
    import asyncio
    mgr = HitlManager()
    deps.set_hitl_manager(mgr)
    try:
        rid = await mgr.request(form="question", session_id="s1", task_id="t1", tool_call_id="tcA")
        waiter = asyncio.create_task(mgr.wait(rid))        # 热阻塞在 Future 上
        await asyncio.sleep(0)
        await _cancel_pending_hitl("s1")                   # cancel set Future → 唤醒
        resolved = await asyncio.wait_for(waiter, timeout=1.0)
        assert resolved.status == "cancelled"
    finally:
        deps.set_hitl_manager(None)
