"""resolve_hitl 共享服务:会话副作用 + resolve 的单一实现(spec 2026-07-05 /messages 拆分)。"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest

from ctx_weft.core import CtxWeftRuntime
from ctx_weft.core.events.types import Event, EventType
from ctx_weft.core.runtime import ProviderRegistry
from ctx_weft.protocols.capability import AgentCapabilityProvider, CapabilityProviderInfo
from netlivecowork.api import deps
from netlivecowork.api.models import session as _sm

_TS = datetime(2026, 6, 13, tzinfo=timezone.utc)


class _StubProvider(AgentCapabilityProvider):
    name = "agent"
    async def get_template(self, *a, **k): return None
    async def list(self, *a, **k): return []
    async def describe(self, *a, **k):
        return CapabilityProviderInfo(name=self.name, capability_count=0,
                                      supports_streaming=False, supports_cancel=False,
                                      description="")


def _mk_bare_runtime() -> CtxWeftRuntime:
    providers = ProviderRegistry()
    providers.register_capability(_StubProvider())
    return CtxWeftRuntime(providers=providers)


class _Entry:
    def __init__(self, sid: str) -> None:
        self.session_id = sid
        self.status = "PAUSED_HITL"
        self.llm_account = "acct-a"
        self.llm_model = "model-a"
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

    async def append_event(self, ev) -> None:
        pass

    def _session_update_json(self, status: str) -> str:
        return f'{{"type":"session_update","status":"{status}"}}'

    def to_dict(self) -> dict:
        return {"status": self.status}


def _ev(sid: str, seq: int, type_: EventType, **payload) -> Event:
    return Event(id=f"evt_{sid}_{seq}", run_id="r1", sequence=seq, session_id=sid,
                 type=type_, timestamp=_TS, payload=payload)


async def _mk_runtime(sid: str, *, form: str = "question") -> CtxWeftRuntime:
    runtime = _mk_bare_runtime()
    await runtime.event_store.append(_ev(sid, 1, EventType.SESSION_CREATED, template_id="t"))
    await runtime.event_store.append(
        _ev(sid, 2, EventType.HITL_REQUIRED, hitl_id="h1", form=form, tool_call_id="tc1"))
    await runtime.rebuild_hitl(sid)
    return runtime


async def test_answer_full_side_effects_in_order(monkeypatch) -> None:
    """entry 在:transcript 追加→RUNNING→consumer 重启→workspace 重登记→resolve(带 entry LLM)。"""
    from netlivecowork.api import hitl_service

    sid = "ses_svc"
    runtime = await _mk_runtime(sid)

    async def _noop_recover_session(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop_recover_session)

    order: list[str] = []
    async def _spy_ws(rt, session_id):
        order.append(f"ws:{session_id}")
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _spy_ws)

    entry = _Entry(sid)
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        req = await hitl_service.resolve_hitl("h1", "answer", text="use postgres", entry=entry)
        assert req.status == "accepted" and req.message == "use postgres"
        # transcript:user 消息且内容为答复原文
        msg = json.loads(entry.appended[0])
        assert msg["role"] == "user" and msg["content"] == "use postgres"
        # 状态翻转 + SSE
        assert entry.status == "RUNNING"
        assert any("session_update" in s for s in entry.sse_events)
        # consumer token 自增(重启)
        assert entry._consumer_token == 1 and entry.sse_finished is False
        # workspace 重登记发生在 resolve 之前(resolve 后才 append 不了序;以 spy 顺序为证)
        assert order == [f"ws:{sid}"]
        # entry LLM 未被动过(未传 llm)
        assert entry.llm_account == "acct-a" and entry.llm_model == "model-a"
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_empty_answer_rejected_422_no_side_effects(monkeypatch) -> None:
    """answer 空文本（含纯空白）→ 422 拒收：空答案没有可执行内容——事件记不下 message,
    跨重启冷决定查询判不可用还会重问。守卫须在一切会话副作用之前,请求保持 pending。
    approve/reject 的空 message 不受影响（放行/拦下本身就是决定）。"""
    from fastapi import HTTPException

    from netlivecowork.api import hitl_service

    sid = "ses_empty_ans"
    runtime = await _mk_runtime(sid)
    async def _noop(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    entry = _Entry(sid)
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        for bad in ("", "   \n\t"):
            with pytest.raises(HTTPException) as ei:
                await hitl_service.resolve_hitl("h1", "answer", text=bad, entry=entry)
            assert ei.value.status_code == 422
        # 零副作用:无 transcript 气泡、状态未翻转、consumer 未重启、请求仍 pending
        assert entry.appended == []
        assert entry.status == "PAUSED_HITL" and entry._consumer_token == 0
        assert runtime.hitl_manager.get("h1").status == "pending"
        # 有内容的答复照常走通
        req = await hitl_service.resolve_hitl("h1", "answer", text="ok", entry=entry)
        assert req.status == "accepted"
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_approve_reject_echo_defaults(monkeypatch) -> None:
    """approve/reject 的 transcript 缺省回显词与前端旧字面量一致。"""
    from netlivecowork.api import hitl_service

    sid = "ses_echo"
    runtime = await _mk_runtime(sid, form="approval")
    async def _noop(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    entry = _Entry(sid)
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        await hitl_service.resolve_hitl("h1", "reject", message="danger", entry=entry)
        msg = json.loads(entry.appended[0])
        assert msg["content"] == "rejected danger"
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_llm_semantics(monkeypatch) -> None:
    """llm=None 不动 entry;llm=("b","m2") 设置;llm=(None,None) 重置。"""
    from netlivecowork.api import hitl_service

    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    for llm, want in [(None, ("acct-a", "model-a")),
                      (("acct-b", "model-b"), ("acct-b", "model-b")),
                      ((None, None), (None, None))]:
        sid = f"ses_llm_{id(llm)}"
        runtime = await _mk_runtime(sid)
        async def _noop(s, **k): return None
        monkeypatch.setattr(runtime, "recover_session", _noop)
        entry = _Entry(sid)
        deps.set_runtime(runtime)
        deps.set_hitl_manager(runtime.hitl_manager)
        try:
            await hitl_service.resolve_hitl("h1", "answer", text="x", entry=entry, llm=llm)
            assert (entry.llm_account, entry.llm_model) == want
        finally:
            deps.set_runtime(None)
            deps.set_hitl_manager(None)


async def test_entry_miss_resolves_without_session_side_effects(monkeypatch) -> None:
    """entry 不在注册表:跳过会话副作用,resolve 照走,workspace 仍重登记。"""
    from netlivecowork.api import hitl_service

    sid = "ses_nomem"
    runtime = await _mk_runtime(sid)
    async def _noop(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    calls: list[str] = []
    async def _spy_ws(rt, session_id): calls.append(session_id)
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _spy_ws)

    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        req = await hitl_service.resolve_hitl("h1", "answer", text="ok")
        assert req.status == "accepted"
        assert calls == [sid]
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_rest_answer_touches_entry_side_effects(monkeypatch) -> None:
    """/hitl/{id}/answer 经服务:注册表里的 entry 拿到 transcript/RUNNING/consumer 副作用。"""
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api import hitl_service
    from netlivecowork.api.schemas.hitl import AnswerRequest

    sid = "ses_rest_fx"
    runtime = await _mk_runtime(sid)
    async def _noop(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    entry = _Entry(sid)
    _sm._sessions[sid] = entry
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        out = await hitl_api.answer("h1", AnswerRequest(answer="ok"), hitl=runtime.hitl_manager)
        assert out["status"] == "accepted"
        assert entry.status == "RUNNING" and entry._consumer_token == 1
        assert json.loads(entry.appended[0])["content"] == "ok"
        # body 未带 llm → entry LLM 不被动(修复旧 /messages 面板应答重置 bug)
        assert entry.llm_account == "acct-a"
    finally:
        _sm._sessions.pop(sid, None)
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_rest_answer_llm_fields_apply_when_present(monkeypatch) -> None:
    """body 带 llm_account → entry 更新;显式 null → 重置。"""
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api import hitl_service
    from netlivecowork.api.schemas.hitl import AnswerRequest

    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    for body, want in [
        (AnswerRequest(answer="x", llm_account="acct-b", llm_model="model-b"), ("acct-b", "model-b")),
        (AnswerRequest(answer="x", llm_account=None, llm_model=None), (None, None)),
    ]:
        sid = f"ses_rest_llm_{want[0]}"
        runtime = await _mk_runtime(sid)
        async def _noop(s, **k): return None
        monkeypatch.setattr(runtime, "recover_session", _noop)
        entry = _Entry(sid)
        _sm._sessions[sid] = entry
        deps.set_runtime(runtime)
        deps.set_hitl_manager(runtime.hitl_manager)
        try:
            await hitl_api.answer("h1", body, hitl=runtime.hitl_manager)
            assert (entry.llm_account, entry.llm_model) == want
        finally:
            _sm._sessions.pop(sid, None)
            deps.set_runtime(None)
            deps.set_hitl_manager(None)


async def test_double_resolve_replays_no_side_effects(monkeypatch) -> None:
    """已解决请求再次 resolve:不追加 transcript、不重启 consumer、返回原终态(双击安全)。"""
    from netlivecowork.api import hitl_service

    sid = "ses_dup"
    runtime = await _mk_runtime(sid, form="approval")
    async def _noop(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    entry = _Entry(sid)
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        first = await hitl_service.resolve_hitl("h1", "approve", entry=entry)
        assert first.status == "accepted"
        appended, token = len(entry.appended), entry._consumer_token
        # 双击第二发:approve 重放
        again = await hitl_service.resolve_hitl("h1", "approve", entry=entry)
        assert again.status == "accepted"
        # 先批后拒:不得翻转、不得留 rejected 气泡
        crossed = await hitl_service.resolve_hitl("h1", "reject", message="no", entry=entry)
        assert crossed.status == "accepted" and crossed.message != "no"
        assert len(entry.appended) == appended          # 零新增气泡
        assert entry._consumer_token == token           # 零重复重启
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_unknown_id_raises_keyerror() -> None:
    runtime = _mk_bare_runtime()
    await runtime.event_store.append(_ev("s", 1, EventType.SESSION_CREATED, template_id="t"))
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        from netlivecowork.api.hitl_service import resolve_hitl
        with pytest.raises(KeyError):
            await resolve_hitl("nope", "answer", text="x")
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_reply_routes_by_form_per_id(monkeypatch) -> None:
    """/hitl/{id}/reply:服务端按该条 form 跑词表——approval 文本'rejected xxx'→rejected;
    question 任意文本→answer;多 pending 下命中指定 id 而非 pending[0]。"""
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api import hitl_service
    from netlivecowork.api.schemas.hitl import ReplyRequest

    sid = "ses_reply"
    runtime = _mk_bare_runtime()
    await runtime.event_store.append(_ev(sid, 1, EventType.SESSION_CREATED, template_id="t"))
    # 两条 pending:h_old(question,更早) + h_new(approval)——reply 指名 h_new,不得动 h_old
    await runtime.event_store.append(
        _ev(sid, 2, EventType.HITL_REQUIRED, hitl_id="h_old", form="question", tool_call_id="tc1"))
    await runtime.event_store.append(
        _ev(sid, 3, EventType.HITL_REQUIRED, hitl_id="h_new", form="approval", tool_call_id="tc2"))
    await runtime.rebuild_hitl(sid)

    async def _noop(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    entry = _Entry(sid)
    _sm._sessions[sid] = entry
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        # approval + 拒绝词开头 → reject,message=词后余文
        out = await hitl_api.reply("h_new", ReplyRequest(content="rejected too risky"),
                                   hitl=runtime.hitl_manager)
        assert out == {"id": "h_new", "status": "rejected", "action": "reject"}
        assert runtime.hitl_manager.get("h_new").status == "rejected"
        assert runtime.hitl_manager.get("h_old").status == "pending"   # 未误伤 pending[0]
        # transcript 回显用户原文
        assert json.loads(entry.appended[0])["content"] == "rejected too risky"

        # question 任意文本 → answer("no"是否定答复,不是拒绝)
        out2 = await hitl_api.reply("h_old", ReplyRequest(content="no"), hitl=runtime.hitl_manager)
        assert out2["action"] == "answer" and out2["status"] == "accepted"
        assert runtime.hitl_manager.get("h_old").message == "no"
    finally:
        _sm._sessions.pop(sid, None)
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_reply_llm_fields_apply_when_present(monkeypatch) -> None:
    """reply 的 llm 字段语义与其余端点一致:出现才生效。"""
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api import hitl_service
    from netlivecowork.api.schemas.hitl import ReplyRequest

    async def _noop_ws(rt, session_id): return None
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop_ws)

    sid = "ses_reply_llm"
    runtime = await _mk_runtime(sid)              # form=question
    async def _noop(s, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    entry = _Entry(sid)
    _sm._sessions[sid] = entry
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        await hitl_api.reply("h1", ReplyRequest(content="x", llm_account="acct-b", llm_model="model-b"),
                             hitl=runtime.hitl_manager)
        assert (entry.llm_account, entry.llm_model) == ("acct-b", "model-b")
    finally:
        _sm._sessions.pop(sid, None)
        deps.set_runtime(None)
        deps.set_hitl_manager(None)


async def test_reply_unknown_id_404() -> None:
    from fastapi import HTTPException
    from netlivecowork.api import hitl as hitl_api
    from netlivecowork.api.schemas.hitl import ReplyRequest

    runtime = _mk_bare_runtime()
    await runtime.event_store.append(_ev("s", 1, EventType.SESSION_CREATED, template_id="t"))
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    try:
        with pytest.raises(HTTPException) as ei:
            await hitl_api.reply("nope", ReplyRequest(content="x"), hitl=runtime.hitl_manager)
        assert ei.value.status_code == 404
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)
