"""skill 用量走完整条新链路：领域映射 → record() → 路由 → Datalink 出口。

拆完之后领域侧不再直接调出口，中间多了路由这一层。**多一层就多一处会静默断掉的地方**：
路由没匹配上、出口没注册、出厂默认没生效——三种情况在本地都表现为"什么都没发生"，
而重构前"什么都没发生"是不可能的（那时是直接 await 一个 HTTP 调用）。

所以这里不 mock 中间层，从事件一路验到出口手里拿到了什么。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.reporting import defaults, record as rec, sinks
from netlivecowork.reporting.sinks.base import Sink
from netlivecowork.providers.capability.skills.runtime import usage


class _Capture(Sink):
    name = defaults.SINK_DATALINK      # 冒充 Datalink 出口，接住送到它手里的东西

    def __init__(self) -> None:
        self.got: list = []

    def enqueue(self, delivery) -> bool:
        self.got.append(delivery)
        return True


@pytest.fixture
def captured(monkeypatch, tmp_path):
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path))
    import netlivecowork.config as cfgmod
    cfgmod._settings = None
    sinks.reset()
    rec.reset()
    rec.routes()                       # 触发出厂默认（含路由与出口注册）
    cap = _Capture()
    sinks.register(cap)                # 覆盖掉真的 Datalink，别真发 HTTP
    monkeypatch.setattr(usage, "consume_skill_own_reporting",
                        lambda session_id, task_id, name: False)
    yield cap
    sinks.reset()
    rec.reset()
    cfgmod._settings = None


def _event(event_type, *, task_id="task-1", session_id="session-1", payload=None):
    return Event(
        id=f"event-{event_type}", run_id="run-1", sequence=1, session_id=session_id,
        type=event_type, timestamp=datetime.now(timezone.utc),
        task_id=task_id, payload=payload or {},
    )


async def _run_one_skill(monkeypatch, skill_name="cloud_skill__document-review"):
    monkeypatch.setattr(usage, "time", type("T", (), {"monotonic": staticmethod(
        iter([100.0, 102.5]).__next__)})())
    r = usage.SkillReporter()
    r._handle_task_created(_event(
        EventType.TASK_CREATED,
        payload={"task": {"id": "task-1", "settings": {"skill_name": skill_name}}},
    ))
    await r._handle_capability_finished(
        _event(EventType.CAPABILITY_FINISHED, payload={"invocation_id": "inv-1"})
    )
    return r


@pytest.mark.asyncio
async def test_a_finished_skill_reaches_the_datalink_sink(captured, monkeypatch):
    """**这条是整次重构的验收**：事件进去，出口手里拿到一条。"""
    await _run_one_skill(monkeypatch)

    assert len(captured.got) == 1, "链路断在路由或出口注册上（本地看起来什么都没发生）"
    d = captured.got[0]
    assert d.kind == "skill_usage"
    assert d.sink == defaults.SINK_DATALINK


@pytest.mark.asyncio
async def test_the_payload_carries_what_datalink_needs(captured, monkeypatch):
    """字段与重构前送进 _add_agent_invocation_detail 的那几个一一对应。"""
    await _run_one_skill(monkeypatch)

    p = captured.got[0].payload
    assert p["function_name"] == "document-review", "前缀要剥掉"
    assert p["duration"] == 2.5
    assert "user_id" in p and "ne_number" in p


@pytest.mark.asyncio
async def test_a_skill_with_its_own_reporting_is_not_reported_again(captured, monkeypatch):
    """自带上报的 skill，宿主不能再报一次——否则那次调用被算两遍。"""
    monkeypatch.setattr(usage, "consume_skill_own_reporting",
                        lambda session_id, task_id, name: True)
    await _run_one_skill(monkeypatch)
    assert captured.got == []


@pytest.mark.asyncio
async def test_a_capability_finished_without_a_start_is_ignored(captured, monkeypatch):
    """没配对的结束事件不产生记录——否则耗时无从算起，会报出一条假数据。"""
    r = usage.SkillReporter()
    await r._handle_capability_finished(
        _event(EventType.CAPABILITY_FINISHED, payload={"invocation_id": "inv-1"})
    )
    assert captured.got == []


@pytest.mark.asyncio
async def test_ownership_is_carried_even_though_it_is_empty_today(captured, monkeypatch):
    """归属字段现在恒为空，但**它必须一路带到出口**。

    等 cowork 那块接上，只改 labels.py 就够——如果这条链路根本没把归属带过来，
    那时要回头改的就不止一个文件了。
    """
    await _run_one_skill(monkeypatch)
    assert captured.got[0].labels is not None
    assert captured.got[0].labels.cowork == ""


@pytest.mark.asyncio
async def test_the_real_sink_is_registered_by_default(monkeypatch, tmp_path):
    """不装配任何东西时，出厂默认里就有 Datalink 出口——与重构前"skill 用量会上报"一致。"""
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path))
    import netlivecowork.config as cfgmod
    cfgmod._settings = None
    sinks.reset()
    rec.reset()
    try:
        kinds = {r.kind: r.sink for r in rec.routes()}
        assert kinds["skill_usage"] == defaults.SINK_DATALINK
        assert sinks.get(defaults.SINK_DATALINK) is not None
    finally:
        sinks.reset()
        rec.reset()
        cfgmod._settings = None
