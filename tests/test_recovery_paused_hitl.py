"""重启恢复(事件驱动,端到端;spec/07 §9)。

链路:host 调 `runtime.recover()` → core 据事件决策 → 崩溃前在跑的 session **emit
SessionStatusChanged(INTERRUPTED)** → host 既有订阅者 `ProjectionUpdater` 写持久投影 →
随后 `load_sessions_from_db` 把投影灌回内存缓存。**无回调**。
PAUSED_HITL(有未解决 pending HITL)则由 core 就地 recover_session 重建、状态不变。
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ctx_weft.core import CtxWeftRuntime
from ctx_weft.core.events.types import Event, EventType
from ctx_weft.core.runtime import ProviderRegistry
from ctx_weft.protocols.capability import AgentCapabilityProvider, CapabilityProviderInfo
from netlivecowork.api.models.session import _sessions, load_sessions_from_db
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import SessionModel
from netlivecowork.persistence.postgres.event_store import PostgresEventStore
from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater
from netlivecowork.persistence.postgres.state_store import PostgresStateStore

_TS = datetime(2026, 6, 13, tzinfo=timezone.utc)


class _StubProvider(AgentCapabilityProvider):
    """recover 的中断分支不碰 provider；PAUSED 分支被 monkeypatch,故无需真实模板。"""
    name = "agent"
    async def get_template(self, *a, **k): return None
    async def list(self, *a, **k): return []
    async def describe(self, *a, **k):
        return CapabilityProviderInfo(name=self.name, capability_count=0,
                                      supports_streaming=False, supports_cancel=False,
                                      description="")


def _ev(sid: str, seq: int, type_: EventType, **payload) -> Event:
    return Event(id=f"evt_{sid}_{seq}", run_id="r1", sequence=seq, session_id=sid,
                 type=type_, timestamp=_TS, payload=payload)


async def _make(tmp_path, name):
    factory = await init_db(f"sqlite:///{(tmp_path / name).as_posix()}")
    event_store = PostgresEventStore(factory)
    proj = ProjectionUpdater(factory)
    providers = ProviderRegistry()
    providers.register_capability(_StubProvider())
    runtime = CtxWeftRuntime(providers=providers, event_store=event_store)
    runtime.event_bus.subscribe(None, proj.on_event)        # core emit → 投影更新
    return factory, event_store, proj, runtime


async def _status(factory) -> str | None:
    async with factory() as db:
        row = await db.get(SessionModel, "ses_1")
        return row.status if row else None


async def test_running_session_restart_becomes_interrupted(tmp_path) -> None:
    factory, event_store, proj, runtime = await _make(tmp_path, "r.db")
    # 崩溃前:RUNNING(有 SessionCreated、无终态、无 HITL)
    sc = _ev("ses_1", 1, EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt")
    await event_store.append(sc)        # events 表(供 list_active + has_pending_hitl)
    await proj.on_event(sc)             # sessions 表行 → RUNNING
    assert await _status(factory) == "RUNNING"

    n = await runtime.recover()
    assert n == 1
    # core emit SessionStatusChanged(INTERRUPTED) → 投影持久层已是 INTERRUPTED
    assert await _status(factory) == "INTERRUPTED"

    # recover 之后再灌回内存缓存 → entry 也是 INTERRUPTED(不会停在崩溃前的 RUNNING)
    _sessions.pop("ses_1", None)
    try:
        await load_sessions_from_db(PostgresStateStore(factory))
        assert _sessions["ses_1"].status == "INTERRUPTED"
    finally:
        _sessions.pop("ses_1", None)


async def test_paused_hitl_session_restart_stays_paused(tmp_path, monkeypatch) -> None:
    factory, event_store, proj, runtime = await _make(tmp_path, "p.db")
    sc = _ev("ses_1", 1, EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt")
    hr = _ev("ses_1", 2, EventType.HITL_REQUIRED, hitl_id="h1", form="question", tool_call_id="tc1")
    await event_store.append(sc)
    await event_store.append(hr)
    await proj.on_event(sc)
    await proj.on_event(_ev("ses_1", 3, EventType.SESSION_PAUSED_HITL))
    assert await _status(factory) == "PAUSED_HITL"

    # 启动只重建 HitlManager,不调 recover_session、不 drain（task 重建推迟到应答）
    called: list[str] = []
    async def fail_recover_session(sid, **kw):
        called.append(sid)
    monkeypatch.setattr(runtime, "recover_session", fail_recover_session)

    n = await runtime.recover()
    assert n == 1
    assert called == []                                          # 不 drain
    assert [r.id for r in runtime.hitl_manager.list_pending(session_id="ses_1")] == ["h1"]
    assert await _status(factory) == "PAUSED_HITL"               # 不发 INTERRUPTED,状态不变
