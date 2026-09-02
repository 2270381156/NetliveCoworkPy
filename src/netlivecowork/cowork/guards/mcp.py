"""按 cowork 归属过滤 MCP 能力的包装层。

**为什么是包装而不是改 provider**：MCP provider 是内核（只读）的类。
好在结构天然合适 —— **一个 MCP server 一个 provider**，"某个 server 对这条会话可不可见"
就等于"这个 provider 返不返回东西"。

# 两个坑，都是实测踩过的

## ① 必须是**真子类**，不能只是"长得像"

内核建"哪个工具归哪个 provider"的索引时有一道 `isinstance(p, ToolCapabilityProvider)`，
而它是 ABC 不是 Protocol —— **鸭子类型在这里不算数**。

写成普通类 + `__getattr__` 透传的后果：所有 MCP provider 都没进那个索引，
任何 MCP 工具调用直接失败：

    [Error: no provider found for 'mcp:tech-kb:search_docs']

而管理面一切正常（列表里 server 都是已连接、工具数也对），因为那条路不经过这个索引。
表现出来就是**"看得见、连得上、就是调不动"**，且与是哪个 cowork、哪个 server 都无关。

## ② 三个入口都要管，缺一个就出怪毛病

    retrieve   **模型手里有什么由它说了算** —— 漏了它，隔离等于没做
    list       管理面与调用路由读它    —— 漏了它，工具找不到归属
    invoke     能力 id 可猜，看不见不等于拿不到 —— 漏了它，边界只是体验

只改 `list` 的实测后果：**两个 cowork 都说自己有全部工具**，
而验证时看接口返回值是"正确"的 —— 只有看模型手里的工具集才看得出来。
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from ctx_weft.protocols.capability import (
    Capability,
    CapabilityProviderInfo,
    ToolCapabilityProvider,
)
from ctx_weft.protocols.context import ProviderContext

logger = logging.getLogger(__name__)


class CoworkScopedMCPProvider(ToolCapabilityProvider):
    """把一个 MCP provider 包起来，按会话归属决定它的能力可不可见。

    除三个入口外一律原样委托；`__getattr__` 兜住内核将来新增的方法，
    免得内核加一个、这里就静默少一个（见 tests 里那条"覆盖协议全部方法"的检查）。
    """

    def __init__(
        self,
        inner: Any,
        server_name: str,
        policy_getter: Callable[[], Any | None],
        *,
        suite_delivered: bool = True,
    ) -> None:
        self._inner = inner
        self._server_name = server_name
        # 传取值函数而不是策略实例：策略在启动过程中才装配好，而 provider 可能更早创建。
        self._policy_getter = policy_getter
        #: 这个 server 是不是**套件下发**的。
        #:
        #: ⚠ **客户端自带的 MCP 不受套件声明约束**（需求 G6）：它随包发布、
        #: 不需要云端配置，云端管理台里根本不会列出它。拿套件声明去卡它的结果是
        #: **所有 cowork 都失去这个工具** —— 实测踩过。
        self._suite_delivered = suite_delivered

    # ── 身份透传：内核按 name 建索引，包了之后名字不能变 ────────────────────────

    @property
    def name(self) -> str:
        return getattr(self._inner, "name", self._server_name)

    @property
    def description(self) -> str:
        return getattr(self._inner, "description", "")

    def _allowed(self, ctx: ProviderContext | None) -> bool:
        if not self._suite_delivered:
            return True
        policy = self._policy_getter()
        if policy is None:
            # 策略还没装配好 —— 放行。收紧的话启动早期的调用会莫名其妙失败，
            # 而那与"没权限"长得一样。
            return True
        return policy.allows_mcp(getattr(ctx, "session_id", None), self._server_name)

    # ── 三个入口 ──────────────────────────────────────────────────────────────

    async def retrieve(self, ctx: ProviderContext) -> list[Capability]:
        """**模型手里有什么由它说了算。** 漏了它，隔离等于没做。"""
        if not self._allowed(ctx):
            return []
        return await self._inner.retrieve(ctx)

    async def list(self, ctx: ProviderContext) -> list[Capability]:
        if not self._allowed(ctx):
            return []
        return await self._inner.list(ctx)

    def invoke(self, capability_id: str, arguments: dict, ctx: ProviderContext):
        """**能力 id 可猜，看不见不等于拿不到。** 漏了它，边界只是体验不是权限。

        ⚠ **必须是普通 `def`，不能是 `async def`。**

        协议里 `invoke` 返回的是 `AsyncIterator`，调用方直接 `async for` 它的返回值
        （见 ctx_weft/protocols/capability.py）。写成 `async def` 的话返回的是 coroutine，
        内核那一句 `async for` 立刻炸：

            'async for' requires an object with __aiter__ method, got coroutine

        而且**每一个走这个包装器的 MCP 都会炸**——现象是"工具在清单里，一调就报错"。
        它藏了很久：套件自带的 MCP 一直没注册成功，随包那些又各有各的毛病，
        于是没人真的调通过一次。旁边 local_skill 那个包装器一直是普通 def，是对的。
        """
        if not self._allowed(ctx):
            logger.info(
                "cowork：拦下越权调用 —— 会话 %s 不拥有 MCP %r（能力 %s）",
                getattr(ctx, "session_id", None), self._server_name, capability_id,
            )
            raise PermissionError(
                f"当前 cowork 没有 {self._server_name} 这个能力"
            )
        return self._inner.invoke(capability_id, arguments, ctx)

    # ── 其余原样委托 ──────────────────────────────────────────────────────────

    async def describe(self, ctx: ProviderContext) -> CapabilityProviderInfo:
        return await self._inner.describe(ctx)

    async def cancel(self, invocation_id: str, ctx: ProviderContext) -> bool:
        return await self._inner.cancel(invocation_id, ctx)

    def __getattr__(self, item: str) -> Any:
        """内核将来新增的方法照样能用。

        ⚠ 但**它兜不住"新方法需要过滤"这件事** —— 那要靠测试比对方法集
        （见 tests/test_cowork_guard_mcp.py）。这里只保证不会因为少一个方法而崩。
        """
        return getattr(self._inner, item)

    def __repr__(self) -> str:  # pragma: no cover - 排查用
        return f"CoworkScopedMCPProvider({self._server_name!r}, suite={self._suite_delivered})"
