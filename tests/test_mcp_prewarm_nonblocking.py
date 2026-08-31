"""MCP 预连接不得挡住 lifespan 启动。

Electron 侧 waitForBackend 只给 30s（electron/main.js:893，60 次 × 500ms 轮询 /health），
而 /health 在 lifespan 跑完前不响应。prewarm_all 里每个 provider 的 start() 最坏挡
connect_timeout_sec + 5（默认 15s，见 core provider.py），内网离线机器上一项就吃掉半个预算。

它对正确性本就不必要：agent 路径有惰性重连（见 manager.prewarm_all 注释），预连接纯粹是预热。
故改成后台任务，并由 teardown 负责回收——必须在 close_all() 之前结算，否则预连接还在
start() 子进程/连接，close_all() 已在拆同一批 provider。
"""

from __future__ import annotations

import asyncio

from netlivecowork.bootstrap.lifecycle import Handles, _start_mcp_prewarm, stop


class _FakeManager:
    """prewarm_all 可控时长/可抛错；记录 close_all 是否被调用及顺序。"""

    def __init__(self, *, delay: float = 60.0, boom: bool = False) -> None:
        self._delay = delay
        self._boom = boom
        self.prewarm_started = asyncio.Event()
        self.prewarm_done = False
        self.closed = False
        self.order: list[str] = []

    async def prewarm_all(self) -> None:
        self.prewarm_started.set()
        if self._boom:
            raise RuntimeError("MCP server 起不来")
        await asyncio.sleep(self._delay)
        self.prewarm_done = True
        self.order.append("prewarm")

    async def close_all(self) -> None:
        self.closed = True
        self.order.append("close_all")


class _FakeWatcher:
    def __init__(self) -> None:
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True


def _handles(manager, task) -> Handles:
    return Handles(
        watcher=_FakeWatcher(), mcp_manager=manager, mcp_prewarm_task=task
    )


async def test_prewarm_returns_immediately_without_awaiting_connect() -> None:
    """启动路径不等 prewarm：一个要跑 60s 的预连接，调用点必须立刻返回。"""
    mgr = _FakeManager(delay=60.0)
    task = _start_mcp_prewarm(mgr)

    assert isinstance(task, asyncio.Task)
    assert not task.done(), "prewarm 必须还在后台跑，不能已经被 await 完"
    assert not mgr.prewarm_done

    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_prewarm_actually_runs_in_background() -> None:
    """不 await 不等于不跑：让出事件循环后它应当真的执行完。"""
    mgr = _FakeManager(delay=0.0)
    task = _start_mcp_prewarm(mgr)
    await task

    assert mgr.prewarm_done


async def test_prewarm_failure_does_not_escalate() -> None:
    """预连接失败不致命：异常不得逃逸成 task 级未捕获异常。"""
    mgr = _FakeManager(boom=True)
    task = _start_mcp_prewarm(mgr)
    await task  # 不抛

    assert task.exception() is None


async def test_teardown_settles_prewarm_before_close_all() -> None:
    """teardown 必须先结算后台预连接，再拆 provider，避免二者并发操作同一批连接。"""
    mgr = _FakeManager(delay=60.0)
    task = _start_mcp_prewarm(mgr)
    await mgr.prewarm_started.wait()

    await stop(_handles(mgr, task))

    assert task.done(), "teardown 后后台预连接不能仍在跑"
    assert mgr.closed
    assert mgr.order == ["close_all"], "prewarm 应被取消（未跑完），close_all 在其之后"


async def test_teardown_tolerates_absent_prewarm_task() -> None:
    """无 MCP 配置时 prewarm 任务可能为 None，teardown 不得炸。"""
    mgr = _FakeManager()
    await stop(_handles(mgr, None))

    assert mgr.closed
