"""应答入口自愈:重启后内存 HitlManager 还没被 recover 填上时,据事件即时重建再应答,避免 404。

复现用户报的「重启后前端显示等待确认,发消息 404」:内存 HitlManager 为空(未 rebuild),但事件流里
有未解决的 HITL。`_submit_hitl_response` 应先 `runtime.rebuild_hitl` 自愈,再正常 resolve。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from ctx_weft.core import CtxWeftRuntime
from ctx_weft.core.events.types import Event, EventType
from ctx_weft.core.runtime import ProviderRegistry
from ctx_weft.protocols.capability import AgentCapabilityProvider, CapabilityProviderInfo
from netlivecowork.api import deps
from netlivecowork.api.sessions import _submit_hitl_response

_TS = datetime(2026, 6, 13, tzinfo=timezone.utc)


class _StubProvider(AgentCapabilityProvider):
    name = "agent"
    async def get_template(self, *a, **k): return None
    async def list(self, *a, **k): return []
    async def describe(self, *a, **k):
        return CapabilityProviderInfo(name=self.name, capability_count=0,
                                      supports_streaming=False, supports_cancel=False,
                                      description="")


def _mk_runtime() -> CtxWeftRuntime:
    providers = ProviderRegistry()
    providers.register_capability(_StubProvider())
    return CtxWeftRuntime(providers=providers)


class _Entry:
    def __init__(self, sid: str) -> None:
        self.session_id = sid
        self.status = "PAUSED_HITL"
        self.llm_account = None
        self.llm_model = None
        self.updated_at = ""
        self.turn_seq = 1
        self.sse_events: list[str] = []
        self.cond = asyncio.Condition()
        self.appended: list[str] = []
        self._consumer_token = 0
        self.sse_finished = False

    async def ensure_hydrated(self) -> None:
        """真 SessionEntry 的按需装载闸门；假对象天生是全的，no-op。"""

    async def _append_json(self, s: str) -> None:
        self.appended.append(s)

    async def append_event(self, ev) -> None:           # session_consumer 用;测试中无事件,空实现
        pass

    def _session_update_json(self, status: str) -> str:
        return f'{{"type":"session_update","status":"{status}"}}'

    def to_dict(self) -> dict:
        return {"status": self.status}


def _ev(sid: str, seq: int, type_: EventType, **payload) -> Event:
    return Event(id=f"evt_{sid}_{seq}", run_id="r1", sequence=seq, session_id=sid,
                 type=type_, timestamp=_TS, payload=payload)


async def test_reply_self_heals_when_hitl_not_in_memory(monkeypatch) -> None:
    sid = "ses_heal"
    runtime = _mk_runtime()
    store = runtime.event_store
    await store.append(_ev(sid, 1, EventType.SESSION_CREATED, template_id="t"))
    await store.append(_ev(sid, 2, EventType.HITL_REQUIRED, hitl_id="h1", form="question", tool_call_id="tc1"))

    # 模拟重启后:内存 HitlManager 为空(recover 没填 / 时序未到)
    assert runtime.hitl_manager.list_pending(session_id=sid) == []

    # 冷 resolve 会触发 _resume_after_cold_hitl → recover_session;此处只测自愈+resolve,屏蔽重活
    async def _noop_recover_session(s, **k):
        return None
    monkeypatch.setattr(runtime, "recover_session", _noop_recover_session)

    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        out = await _submit_hitl_response(_Entry(sid), "use postgres")
        assert out["status"] == "RUNNING"
        # 自愈重建了 pending 并解决了它(不再 404)
        assert runtime.hitl_manager.get("h1").status == "accepted"
        assert runtime.hitl_manager.get("h1").message == "use postgres"
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_reply_reregisters_workspace_before_cold_resume(monkeypatch) -> None:
    """重启后冷应答触发续跑前,必须把 workspace 重新登记给 fs provider。

    复现用户报的「workspace 数据在(DB/前端有)、但开启会话时后端没有」:fs provider 的
    workspace 映射是内存缓存,随重启丢失。`_submit_hitl_response` 走的冷应答会触发
    recover_session 续跑——旧实现不重登记 workspace → agent 在默认目录里续跑。
    """
    import netlivecowork.api.sessions as sess_api

    sid = "ses_ws"
    runtime = _mk_runtime()
    store = runtime.event_store
    await store.append(_ev(sid, 1, EventType.SESSION_CREATED, template_id="t"))
    await store.append(_ev(sid, 2, EventType.HITL_REQUIRED, hitl_id="h1", form="question", tool_call_id="tc1"))

    async def _noop_recover_session(s, **k):
        return None
    monkeypatch.setattr(runtime, "recover_session", _noop_recover_session)

    # spy 重登记入口:断言冷应答 resolve 前已被调用(register 幂等,真实实现读 state store)
    calls: list[str] = []
    async def _spy_ensure(rt, session_id):
        calls.append(session_id)
    from netlivecowork.api import hitl_service
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _spy_ensure)

    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        out = await sess_api._submit_hitl_response(_Entry(sid), "use postgres")
        assert out["status"] == "RUNNING"
        assert calls == [sid]                                  # 续跑前重登记了 workspace
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_rest_answer_self_heals(monkeypatch) -> None:
    """/hitl/{id}/answer 只带 hitl_id:重启后内存为空 → 重建全部 active pending 再命中,不 404。"""
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api.schemas.hitl import AnswerRequest

    sid = "ses_rest"
    runtime = _mk_runtime()
    store = runtime.event_store
    await store.append(_ev(sid, 1, EventType.SESSION_CREATED, template_id="t"))
    await store.append(_ev(sid, 2, EventType.HITL_REQUIRED, hitl_id="h1", form="question", tool_call_id="tc1"))
    assert runtime.hitl_manager.list_pending() == []          # 内存为空(未 recover)

    async def _noop_recover_session(s, **k):
        return None
    monkeypatch.setattr(runtime, "recover_session", _noop_recover_session)

    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        out = await hitl_api.answer("h1", AnswerRequest(answer="use postgres"), hitl=runtime.hitl_manager)
        assert out["status"] == "accepted"
        assert runtime.hitl_manager.get("h1").message == "use postgres"
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_rest_reply_reregisters_workspace_before_cold_resume(monkeypatch) -> None:
    """/hitl/{id}/answer 冷应答 resolve 前也须重登记 workspace（与 /messages 路径同一缺口）。

    端点只带 hitl_id → 据 pending 请求的 session_id 重登记。重启后内存为空时,先自愈重建
    再取 session_id。
    """
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api import hitl_service
    from netlivecowork.api.schemas.hitl import AnswerRequest

    sid = "ses_rest_ws"
    runtime = _mk_runtime()
    store = runtime.event_store
    await store.append(_ev(sid, 1, EventType.SESSION_CREATED, template_id="t"))
    await store.append(_ev(sid, 2, EventType.HITL_REQUIRED, hitl_id="h1", form="question", tool_call_id="tc1"))
    assert runtime.hitl_manager.list_pending() == []          # 内存为空(未 recover)

    async def _noop_recover_session(s, **k):
        return None
    monkeypatch.setattr(runtime, "recover_session", _noop_recover_session)

    calls: list[str] = []
    async def _spy_ensure(rt, session_id):
        calls.append(session_id)
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _spy_ensure)

    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        out = await hitl_api.answer("h1", AnswerRequest(answer="use postgres"), hitl=runtime.hitl_manager)
        assert out["status"] == "accepted"
        assert calls == [sid]                                  # 续跑前重登记了 workspace
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_rest_answer_unknown_id_still_404(monkeypatch) -> None:
    from fastapi import HTTPException
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api.schemas.hitl import AnswerRequest

    runtime = _mk_runtime()
    await runtime.event_store.append(_ev("s", 1, EventType.SESSION_CREATED, template_id="t"))
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        with pytest.raises(HTTPException) as ei:
            await hitl_api.answer("nope", AnswerRequest(answer="x"), hitl=runtime.hitl_manager)
        assert ei.value.status_code == 404
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_reply_still_404_when_no_hitl_event(monkeypatch) -> None:
    """事件流里确实没有 HITL → 自愈也建不出 → 仍 404(语义不变)。"""
    from fastapi import HTTPException
    sid = "ses_none"
    runtime = _mk_runtime()
    await runtime.event_store.append(_ev(sid, 1, EventType.SESSION_CREATED, template_id="t"))

    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        with pytest.raises(HTTPException) as ei:
            await _submit_hitl_response(_Entry(sid), "hi")
        assert ei.value.status_code == 404
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)
