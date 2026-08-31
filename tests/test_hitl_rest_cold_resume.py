"""/hitl REST 端点的冷 resume（spec/07 §6/§9）。

热/冷分流在 core（HitlManager）内闭环：冷应答自触发其 on_cold_resolve 回调（Runtime 绑定
recover_session）。host 端点只转发回复、不感知 was_hot。本测试验证 REST 端点确实走到会触发
resume 的 resolve 路径——旧实现丢弃 was_hot、冷应答不续跑,即此处钉死。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from netlivecowork.api import deps
from netlivecowork.api import hitl as hitl_api
from netlivecowork.api.schemas.hitl import AnswerRequest, ApproveRequest, RejectRequest
from ctx_weft.core.state.models import HitlRequest
from ctx_weft.core.orchestrator.hitl_manager import HitlManager


class _Recorder:
    """on_cold_resolve 回调收到**已解决的 HitlRequest**；这里只记其 session_id 方便断言。"""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, req) -> None:
        self.calls.append(req.session_id)


def _cold_manager(rec: _Recorder, *, form: str = "question") -> HitlManager:
    """模拟重启后状态：rebuild_pending 重建 pending 请求但不建 future → 应答必走冷。"""
    mgr = HitlManager(on_cold_resolve=rec)
    mgr.rebuild_pending({"hit1": HitlRequest(id="hit1", form=form, session_id="s1", task_id="t1")})
    return mgr


async def test_cold_answer_triggers_resume() -> None:
    rec = _Recorder()
    mgr = _cold_manager(rec, form="question")
    deps.set_hitl_manager(mgr)
    try:
        out = await hitl_api.answer("hit1", AnswerRequest(answer="use postgres"), hitl=mgr)
        assert out["status"] == "accepted"
        assert rec.calls == ["s1"]
        assert mgr.get("hit1").message == "use postgres"
    finally:
        deps.set_hitl_manager(None)


async def test_cold_approve_triggers_resume() -> None:
    rec = _Recorder()
    mgr = _cold_manager(rec, form="approval")
    deps.set_hitl_manager(mgr)
    try:
        out = await hitl_api.approve("hit1", ApproveRequest(modify=None), hitl=mgr)
        assert out["status"] == "accepted"
        assert rec.calls == ["s1"]
    finally:
        deps.set_hitl_manager(None)


async def test_cold_reject_triggers_resume() -> None:
    rec = _Recorder()
    mgr = _cold_manager(rec, form="approval")
    deps.set_hitl_manager(mgr)
    try:
        out = await hitl_api.reject("hit1", RejectRequest(message="run ls first"), hitl=mgr)
        assert out["status"] == "rejected"
        assert rec.calls == ["s1"]
    finally:
        deps.set_hitl_manager(None)


async def test_hot_answer_does_not_resume() -> None:
    rec = _Recorder()
    mgr = HitlManager(on_cold_resolve=rec)
    rid = await mgr.request(form="question", session_id="s1", task_id="t1", tool_call_id="tc1")  # 建 future → 热
    deps.set_hitl_manager(mgr)
    try:
        out = await hitl_api.answer(rid, AnswerRequest(answer="hi"), hitl=mgr)
        assert out["status"] == "accepted"
        assert rec.calls == []                        # 热：就地续跑,不 resume
    finally:
        deps.set_hitl_manager(None)


async def test_unknown_id_404() -> None:
    mgr = HitlManager(on_cold_resolve=_Recorder())
    deps.set_hitl_manager(mgr)
    try:
        with pytest.raises(HTTPException) as ei:
            await hitl_api.answer("nope", AnswerRequest(answer="x"), hitl=mgr)
        assert ei.value.status_code == 404
    finally:
        deps.set_hitl_manager(None)
