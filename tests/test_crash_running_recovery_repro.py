"""REPRO: backend process crash while a session is RUNNING → after restart the
session must surface as INTERRUPTED (so the desktop resume bar shows)."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

import netlivecowork.api.sessions as sessions_mod  # noqa: F401  (ensure module import parity)
from netlivecowork.api.models.session import (
    SessionEntry, _sessions, session_consumer, load_sessions_from_db,
    set_state_store, set_event_store,
)
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
    LLMChunk, LLMUsage, ToolCall,
)
from ctx_weft.protocols.capability import (
    AgentCapability, AgentCapabilityProvider, CapabilityProviderInfo,
)
from ctx_weft.providers.llm.mock import MockLLMAdapter
from ctx_weft.providers.memory_blackboard import InMemoryMemoryProvider

pytestmark = pytest.mark.asyncio


class _Resolver(AgentCapabilityProvider):
    name = "agent"

    def __init__(self): self._t = {}
    def register(self, t): self._t[t.id] = t
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


class _BlockingLLM(MockLLMAdapter):
    """First act call blocks forever (simulates a crash while the LLM call is in flight)."""
    def __init__(self, **kw):
        super().__init__(**kw)
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    @staticmethod
    def _is_ri(req):
        return any(getattr(t, "name", "") == "control__update_task_metadata"
                   for t in (getattr(req, "tools", None) or []))

    def complete(self, request, stream=True):
        if self._is_ri(request):
            return self._empty()
        return self._blocking()

    async def _empty(self) -> AsyncIterator[LLMChunk]:
        yield LLMChunk(kind="usage", usage=LLMUsage(prompt_tokens=1, completion_tokens=0, total_tokens=1))
        yield LLMChunk(kind="done", finish_reason="stop")

    async def _blocking(self) -> AsyncIterator[LLMChunk]:
        self.entered.set()
        await self.release.wait()           # never released → simulates crash mid-run
        yield LLMChunk(kind="done", finish_reason="stop")


def _make_runtime(resolver, event_store, memory, llm):
    providers = ProviderRegistry()
    providers.register_capability(resolver)
    rt = CtxWeftRuntime(providers=providers, event_store=event_store,
                        config=RuntimeConfig(), llm=llm)
    rt.providers.register_memory(memory)
    return rt


async def test_crash_while_running_recovers_to_interrupted(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'crash.db').as_posix()}")
    event_store = PostgresEventStore(factory)
    state_store = PostgresStateStore(factory)
    set_state_store(state_store); set_event_store(event_store)

    resolver = _Resolver(); resolver.register(_echo())
    memory = InMemoryMemoryProvider()
    sid = "ses_crash"

    # ── R1: session starts, enters the (blocking) LLM call → RUNNING ───────────
    llm1 = _BlockingLLM(responses=[])
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

    await asyncio.wait_for(llm1.entered.wait(), timeout=5.0)
    await asyncio.sleep(0.1)
    assert entry.status == "RUNNING", f"expected RUNNING mid-call, got {entry.status}"

    # ── Simulate hard crash: drop subscribers + in-memory entry; run is abandoned ──
    await persist1.unsubscribe(); await proj1.unsubscribe()
    entry._consumer_token += 1
    _sessions.pop(sid, None)

    # ── Restart: fresh runtime, recover from events, reload projection ─────────
    llm2 = _BlockingLLM(responses=[])
    r2 = _make_runtime(resolver, event_store, memory, llm2)
    r2.event_bus.subscribe(None, EventPersister(event_store).on_event)
    r2.event_bus.subscribe(None, ProjectionUpdater(factory).on_event)

    await r2.recover()
    await load_sessions_from_db(state_store)

    recovered = _sessions[sid]
    # THE regression check: a crashed RUNNING session must surface as INTERRUPTED.
    assert recovered.status == "INTERRUPTED", (
        f"crashed RUNNING session must recover to INTERRUPTED (drives resume bar), got {recovered.status!r}"
    )
    async with factory() as db:
        row = await db.get(SessionModel, sid)
        assert row.status == "INTERRUPTED", f"DB projection must be INTERRUPTED, got {row.status!r}"
