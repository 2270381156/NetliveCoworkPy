"""两个包装器的 `invoke` 都必须能被 `async for` 直接迭代。

## 现场

工具明明在能力清单里，一调就报

    [Exception: 'async for' requires an object with __aiter__ method, got coroutine]

因为 MCP 那个包装器把 `invoke` 写成了 `async def`。协议里它是**普通 `def`，返回
`AsyncIterator`**（ctx_weft/protocols/capability.py），调用方直接 `async for` 返回值；
写成 `async def` 返回的是 coroutine，`async for` 立刻炸——而且**每一个走这个包装器的
MCP 都会炸**。

它藏了很久：套件自带的 MCP 一直没注册成功，随包那几个又各有各的毛病，于是没人真的
调通过一次。原有的包装器测试只断言"越权会抛 PermissionError"和"放行时会委托"，
从没真的迭代过返回值——所以类型错了也全绿。

这里两条一起钉：签名不是协程函数，以及**真的 `async for` 一遍**。
"""
from __future__ import annotations

import inspect

import pytest

from netlivecowork.cowork.guards import CoworkScopedLocalSkillProvider, CoworkScopedMCPProvider


class _Ctx:
    session_id = "ses_1"


class _Inner:
    """假 provider：invoke 是普通 def，返回异步迭代器 —— 与协议一致。"""

    name = "x"
    description = ""

    def invoke(self, capability_id, arguments, ctx):
        async def gen():
            yield {"event": "start", "capability_id": capability_id}
            yield {"event": "end"}
        return gen()

    async def list(self, ctx): return []
    async def retrieve(self, ctx): return []
    async def describe(self, ctx): return "info"
    async def cancel(self, invocation_id, ctx): return True
    # local_skill 协议多出来的几个
    async def load_definition(self, n, ctx): return ""
    async def list_files(self, n, p, l, ctx): return ""
    async def load_resource(self, n, r, ctx): return ""
    async def exec_script(self, n, s, a, ctx): return ""


def _mcp_guard(allowed=True):
    class _Policy:
        def allows_mcp(self, sid, name): return allowed
    return CoworkScopedMCPProvider(_Inner(), "kb", lambda: _Policy())


def _skill_guard():
    return CoworkScopedLocalSkillProvider(
        _Inner(), owned_labels_fn=lambda sid: None, skill_labels_fn=lambda n: (),
    )


@pytest.mark.parametrize("guard", [_mcp_guard(), _skill_guard()],
                         ids=["mcp", "local_skill"])
def test_invoke_is_not_a_coroutine_function(guard):
    """**签名层面就要挡住。**

    `async def invoke` 返回 coroutine，内核 `async for` 它必炸；而单元测试里
    `await guard.invoke(...)` 反而"看起来能过"——所以光测调用是测不出来的。
    """
    assert not inspect.iscoroutinefunction(type(guard).invoke), (
        "invoke 写成了 async def；协议要求普通 def 返回 AsyncIterator，"
        "写成协程会让每一次调用都报 'async for' requires an object with __aiter__"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("guard", [_mcp_guard(), _skill_guard()],
                         ids=["mcp", "local_skill"])
async def test_the_returned_value_can_actually_be_iterated(guard):
    """真的 `async for` 一遍 —— 内核就是这么用的。"""
    got = [ev async for ev in guard.invoke("mcp:kb:search", {}, _Ctx())]
    assert [e["event"] for e in got] == ["start", "end"]


@pytest.mark.asyncio
async def test_a_denied_call_still_raises_before_any_iteration():
    """挡下来的那条路不能因为改签名而失效：越权必须在拿到迭代器之前就抛。"""
    guard = _mcp_guard(allowed=False)
    with pytest.raises(PermissionError):
        guard.invoke("mcp:kb:search", {}, _Ctx())
