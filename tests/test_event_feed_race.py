"""事件订阅必须在 run 开跑之前完成。

现场：新建会话发第一条消息，界面上只留下半截——一个控制工具调用摆在那儿，回复不见了。
而事件表里那一轮完整无缺（LLMResponseFinished 有正文、token 也算了），重启也补不回来。

原因是 `event_bus.stream()` 是异步生成器：**真正登记订阅要等 `async for` 跑起来那一刻**。
而 `start_session` 在返回之前就调度了 task，中间还隔着写库、拍工作区快照（拷整个工作区，
几秒很正常）。这段时间发出的事件没有订阅者，而总线不回放——永久丢失。

`bus.subscribe()` 是同步的：返回即已在册。这组测试钉的就是这个差别。
"""
from __future__ import annotations

import asyncio

import pytest

from netlivecowork.api.models.session import EventFeed


class _Ev:
    def __init__(self, session_id: str, type_: str = "X") -> None:
        self.session_id = session_id
        self.type = type_


class _FakeBus:
    """只保留与订阅时机有关的那部分行为。"""

    def __init__(self) -> None:
        self._subs: list = []

    def subscribe(self, event_type, handler):          # 同步登记
        self._subs.append(handler)
        outer = self

        class _H:
            async def unsubscribe(self_inner):
                outer._subs.remove(handler)
        return _H()

    async def emit(self, ev):
        for h in list(self._subs):
            await h(ev)


@pytest.mark.asyncio
async def test_subscription_is_live_the_moment_open_returns():
    """**这条是全部要点。** open() 返回之后立刻 emit 的事件必须收得到——
    run 就是在那一瞬间开跑的。"""
    bus = _FakeBus()
    feed = EventFeed(bus, "ses_1")
    await bus.emit(_Ev("ses_1"))              # 没有任何 await 让消费者先跑
    it = feed.__aiter__()
    got = await asyncio.wait_for(it.__anext__(), timeout=1)
    assert got.session_id == "ses_1"
    await feed.close()


@pytest.mark.asyncio
async def test_events_queue_up_before_anyone_consumes():
    """消费者晚起也不该丢：开跑到 create_task 之间正是这段。"""
    bus = _FakeBus()
    feed = EventFeed(bus, "ses_1")
    for _ in range(5):
        await bus.emit(_Ev("ses_1"))
    it = feed.__aiter__()
    for _ in range(5):
        await asyncio.wait_for(it.__anext__(), timeout=1)
    await feed.close()


@pytest.mark.asyncio
async def test_other_sessions_are_not_mixed_in():
    bus = _FakeBus()
    feed = EventFeed(bus, "ses_1")
    await bus.emit(_Ev("ses_other"))
    await bus.emit(_Ev("ses_1", "MINE"))
    it = feed.__aiter__()
    got = await asyncio.wait_for(it.__anext__(), timeout=1)
    assert got.type == "MINE", "别的会话的事件混进来了"
    await feed.close()


@pytest.mark.asyncio
async def test_close_unsubscribes():
    """不退订的话，会话结束之后这条订阅还在收事件，队列只涨不落。"""
    bus = _FakeBus()
    feed = EventFeed(bus, "ses_1")
    assert len(bus._subs) == 1
    await feed.close()
    assert len(bus._subs) == 0
