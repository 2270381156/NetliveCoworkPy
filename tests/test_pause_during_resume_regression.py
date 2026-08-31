"""Regression: pausing during a /resume re-drive must not corrupt the session.

Bug: a second /interrupt while the session is already soft-PAUSED used to call
`_cancel_pending_hitl`, which cancelled the parked `wait_for_user` HITL — the only
resume path for the SUSPENDED task — orphaning the task and flipping the projection
back to RUNNING. The session became unrecoverable ("无法继续对话").

This drives the real sessions API endpoints over a sqlite-backed event store with the
ProjectionUpdater, simulating a process restart between the outage and the resume.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

import netlivecowork.api.sessions as sessions_mod
from netlivecowork.api.models.session import (
    SessionEntry, _sessions, session_consumer, load_sessions_from_db,
    set_state_store, set_event_store,
)
from netlivecowork.api.schemas.sessions import SendMessageRequest
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.event_store import PostgresEventStore
from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater
from netlivecowork.persistence.postgres.state_store import PostgresStateStore
from netlivecowork.persistence.event_persister import EventPersister
from netlivecowork.persistence.postgres.models import SessionModel

from ctx_weft.core import CtxWeftRuntime
from ctx_weft.core.config import RuntimeConfig
from ctx_weft.core.runtime import ProviderRegistry, SessionStartParams
from netlivecowork.providers.templates import canonical_template_id
from ctx_weft.protocols import (
    AgentTemplate, IdentityFacet, LoopConfig, MemoryConfig,
    LLMChunk, LLMOutageError, LLMUsage, ToolCall,
)
from ctx_weft.protocols.capability import (
    AgentCapability, AgentCapabilityProvider, CapabilityProviderInfo,
)
from ctx_weft.providers.llm.mock import MockLLMAdapter
from ctx_weft.providers.memory_blackboard import InMemoryMemoryProvider

pytestmark = pytest.mark.asyncio


class _Resolver(AgentCapabilityProvider):
    name = "agent"

    def __init__(self):
        self._t = {}

    def register(self, t):
        self._t[t.id] = t

    async def get_template(self, template_id, version=None, ctx=None):
        return self._t.get(template_id)

    async def list(self, ctx):
        return [AgentCapability(id=f"agent:{t.id}", name=t.id, template_name=t.id,
                                description="", version=t.version)
                for t in self._t.values()]

    async def describe(self, ctx):
        return CapabilityProviderInfo(name=self.name, capability_count=len(self._t),
                                      supports_streaming=False, supports_cancel=False,
                                      description="")


def _echo() -> AgentTemplate:
    return AgentTemplate(
        id="tpl_echo", name="echo", version="0.1.0",
        identity={"act": IdentityFacet(text="echo"), "observe": IdentityFacet(text="eval")},
        description="x", capability_refs=[], memory_config=MemoryConfig(), loop_config=LoopConfig(),
    )


class _ControllableLLM(MockLLMAdapter):
    """act call #1 (pre-restart) raises outage; the resume re-drive blocks until released."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self._act = 0
        self.fail_next = True
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    @staticmethod
    def _is_ri(req):
        return any(getattr(t, "name", "") == "control__update_task_metadata"
                   for t in (getattr(req, "tools", None) or []))

    def complete(self, request, stream=True):
        self.last_request = request
        if self._is_ri(request):
            return self._empty()
        self._act += 1
        if self._act == 1 and self.fail_next:
            return self._outage()
        return self._blocking()

    async def _empty(self) -> AsyncIterator[LLMChunk]:
        yield LLMChunk(kind="usage", usage=LLMUsage(prompt_tokens=1, completion_tokens=0, total_tokens=1))
        yield LLMChunk(kind="done", finish_reason="stop")

    async def _outage(self) -> AsyncIterator[LLMChunk]:
        raise LLMOutageError("transient outage")
        yield  # pragma: no cover

    async def _blocking(self) -> AsyncIterator[LLMChunk]:
        self.entered.set()
        await self.release.wait()
        yield LLMChunk(kind="token", text="hi")
        yield LLMChunk(kind="tool_call", tool_call=ToolCall(
            id="tc1", name="control__finish_task", arguments={"result": "done"}))
        yield LLMChunk(kind="usage", usage=LLMUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15))
        yield LLMChunk(kind="done", finish_reason="tool_use")


def _make_runtime(resolver, event_store, memory, llm):
    config = RuntimeConfig(
        llm_self_heal_max_attempts=1, llm_self_heal_base_delay_sec=0.0,
        llm_self_heal_max_interval_sec=0.0, llm_self_heal_max_duration_sec=0.1,
    )
    providers = ProviderRegistry()
    providers.register_capability(resolver)
    rt = CtxWeftRuntime(providers=providers, event_store=event_store, config=config, llm=llm)
    rt.providers.register_memory(memory)
    return rt


async def _db_status(factory, sid):
    async with factory() as db:
        row = await db.get(SessionModel, sid)
        return row.status if row else None


async def test_double_pause_during_resume_keeps_session_recoverable(tmp_path, monkeypatch):
    factory = await init_db(f"sqlite:///{(tmp_path / 'reg.db').as_posix()}")
    event_store = PostgresEventStore(factory)
    state_store = PostgresStateStore(factory)
    set_state_store(state_store)
    set_event_store(event_store)

    resolver = _Resolver(); resolver.register(_echo())
    memory = InMemoryMemoryProvider()           # shared across the simulated restart
    sid = "ses_reg"

    # ── R1: run → outage → INTERRUPTED ────────────────────────────────────────
    llm1 = _ControllableLLM(responses=[])
    r1 = _make_runtime(resolver, event_store, memory, llm1)
    persist1 = r1.event_bus.subscribe(None, EventPersister(event_store).on_event)
    proj1 = r1.event_bus.subscribe(None, ProjectionUpdater(factory).on_event)

    handle = await r1.start_session(SessionStartParams.create(
        template_id=canonical_template_id("tpl_echo"), user_prompt="hi",
        context_limit=100_000, session_id=sid))
    entry = SessionEntry(session_id=sid, template_id="tpl_echo", user_prompt="hi",
                         tenant_id="default", llm_model=None, llm_account=None)
    entry.root_agent_id = handle.agent_id
    _sessions[sid] = entry
    entry._consumer_token += 1
    asyncio.create_task(session_consumer(entry, r1, entry._consumer_token))
    await handle.wait_for_finish(timeout=5.0)
    await asyncio.sleep(0.1)
    assert entry.status == "INTERRUPTED"

    # ── Simulate process restart ──────────────────────────────────────────────
    await persist1.unsubscribe(); await proj1.unsubscribe()
    entry._consumer_token += 1
    _sessions.pop(sid, None)

    llm2 = _ControllableLLM(responses=[]); llm2.fail_next = False
    r2 = _make_runtime(resolver, event_store, memory, llm2)
    r2.event_bus.subscribe(None, EventPersister(event_store).on_event)
    r2.event_bus.subscribe(None, ProjectionUpdater(factory).on_event)
    monkeypatch.setattr(sessions_mod.deps, "get_runtime_optional", lambda: r2)
    monkeypatch.setattr(sessions_mod.deps, "get_hitl_manager", lambda: r2.hitl_manager)

    await r2.recover()
    await load_sessions_from_db(state_store)
    entry = _sessions[sid]

    # ── Resume, then pause while the re-drive is mid-flight ────────────────────
    await sessions_mod.resume_session(sid, runtime=r2)
    await asyncio.wait_for(llm2.entered.wait(), timeout=5.0)
    await sessions_mod.interrupt_session(sid, runtime=r2)   # first pause → park
    llm2.release.set()
    await asyncio.sleep(0.3)
    assert entry.status == "PAUSED"
    assert await _db_status(factory, sid) == "PAUSED"
    assert r2.hitl_manager.list_pending(session_id=sid), "wait_for_user HITL must exist after pause"

    # ── Second pause while already PAUSED — must be a harmless no-op ───────────
    await sessions_mod.interrupt_session(sid, runtime=r2)
    await asyncio.sleep(0.1)
    assert entry.status == "PAUSED", "2nd pause must not change status"
    assert await _db_status(factory, sid) == "PAUSED", "2nd pause must not flip DB to RUNNING"
    assert r2.hitl_manager.list_pending(session_id=sid), "2nd pause must NOT cancel the resume HITL"

    # ── Continue the conversation — must succeed ──────────────────────────────
    await sessions_mod.send_message(sid, SendMessageRequest(content="继续"), runtime=r2)
    await asyncio.sleep(0.3)
    assert entry.status == "SUCCEEDED", f"continue should drive to completion, got {entry.status}"
    _sessions.pop(sid, None)
