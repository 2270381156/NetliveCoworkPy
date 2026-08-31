"""MCPProviderManager — store + ProviderRegistry 协调层。

职责：
  register()        save → 创建 MCPCapabilityProvider → registry.register_capability
  deregister()      registry.deregister_capability → delete from store
                    （不 close provider：运行中 session 仍可持续使用）
  refresh()         清空 caps cache → 重新 list()
  load_from_store() 启动时从 mcp.json 还原所有 server
  close_all()       shutdown 时统一 close 所有 provider 子进程
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version as _pkg_version

from ctx_weft.core.runtime import ProviderRegistry
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.providers.capability_mcp.provider import MCPCapabilityProvider, MCPServerConfig
from netlivecowork.providers.capability.mcp.provider import SessionAwareMCPProvider
from netlivecowork.providers.capability.mcp.store import MCPServerStore

logger = logging.getLogger(__name__)

# MCP clientInfo：host 向 core 注入产品身份（core 默认是中性的 "ctx-weft"）。
_MCP_CLIENT_NAME = "netlivecowork"
try:
    _MCP_CLIENT_VERSION = _pkg_version("netlivecowork")
except PackageNotFoundError:  # 未安装为分发包时（极少见）回退
    _MCP_CLIENT_VERSION = "0.0.0"

_DUMMY_CTX = ProviderContext(session_id="", tenant_id="default")


@dataclass
class MCPToolInfo:
    name: str
    description: str


@dataclass
class MCPServerInfo:
    name: str
    type: str                           # "stdio" | "http"
    status: str                         # "CONNECTED" | "DISCONNECTED"
    tool_count: int = 0
    tools: list[MCPToolInfo] = field(default_factory=list)
    command: str | None = None
    args: list[str] | None = None
    url: str | None = None
    timeout_per_call_sec: int = 60
    connect_timeout_sec: int = 10
    trust_env: bool = False


class MCPProviderManager:
    def __init__(
        self,
        store: MCPServerStore,
        registry: ProviderRegistry,
        wrap: "Callable[[MCPCapabilityProvider, str], MCPCapabilityProvider] | None" = None,
    ) -> None:
        self._store = store
        self._registry = registry
        #: 注册前过一道的钩子。**本模块不知道它是干什么的** —— 装配的地方传进来
        #: 一个"按 cowork 归属过滤"的包装器，这里只负责在注册前调它一次。
        #: 不传就是原样注册（架构设计 D2：去掉 cowork 后端仍能跑）。
        self._wrap = wrap
        # _active: 当前注册到 registry 的 providers，新 session 可见
        self._active: dict[str, MCPCapabilityProvider] = {}
        # _all: 历史上所有创建的 providers，用于 close_all()
        # deregister 后 provider 移出 _active 但留在 _all，保证运行中 session 不被中断
        self._all: list[MCPCapabilityProvider] = []

    def load_from_store(self) -> None:
        """应用启动时从 mcp.json 还原所有 MCP server。"""
        for cfg in self._store.load_all():
            if cfg.name in self._active:
                continue
            try:
                self._create_and_register(cfg)
                logger.info("MCPProviderManager: restored '%s'", cfg.name)
            except Exception:
                logger.warning("MCPProviderManager: failed to restore '%s'", cfg.name, exc_info=True)

    def register(self, config: MCPServerConfig) -> MCPServerInfo:
        """注册新 MCP server：持久化 + 创建 provider + 加入 registry。"""
        if self._store.exists(config.name):
            raise ValueError(f"MCP server '{config.name}' already registered")
        self._store.add(config)
        provider = self._create_and_register(config)
        return self._to_info(config, provider)

    def deregister(self, name: str) -> None:
        """注销 MCP server：从 registry 和 store 移除。provider 不立即 close。"""
        if name not in self._active:
            raise KeyError(f"MCP server '{name}' not found")
        self._registry.deregister_capability(f"mcp:{name}")
        del self._active[name]
        self._store.remove(name)

    async def refresh(self, name: str) -> MCPServerInfo:
        """清空 capability 快照并重新拉取工具列表。"""
        provider = self._active.get(name)
        if provider is None:
            raise KeyError(f"MCP server '{name}' not found")
        provider._capabilities_cache = None
        await provider.list(_DUMMY_CTX)
        cfg = self._store.get(name)
        if cfg is None:
            raise KeyError(f"MCP server '{name}' not found in store")
        return self._to_info(cfg, provider)

    def get_info(self, name: str) -> MCPServerInfo:
        provider = self._active.get(name)
        if provider is None:
            raise KeyError(f"MCP server '{name}' not found")
        cfg = self._store.get(name)
        if cfg is None:
            raise KeyError(f"MCP server '{name}' not found in store")
        return self._to_info(cfg, provider)

    def list_all_info(self) -> list[MCPServerInfo]:
        result: list[MCPServerInfo] = []
        for cfg in self._store.load_all():
            provider = self._active.get(cfg.name)
            if provider is not None:
                result.append(self._to_info(cfg, provider))
        return result

    async def prewarm_all(self) -> None:
        """服务启动时并发预连接所有已注册的 MCP server。

        非致命：失败仅记日志并进入退避，agent 路径稍后惰性重试，绝不阻塞 agent loop。
        """
        providers = list(self._active.values())
        if not providers:
            return
        results = await asyncio.gather(
            *(p.start() for p in providers), return_exceptions=True
        )
        ok = sum(1 for r in results if r is True)
        logger.info("MCPProviderManager: prewarmed %d/%d MCP server(s)", ok, len(providers))

    async def close_all(self) -> None:
        """shutdown 时关闭所有 provider 子进程。"""
        for provider in self._all:
            try:
                await provider.close()
            except Exception:
                logger.warning("MCPProviderManager: error closing '%s'", provider.name, exc_info=True)
        self._all.clear()
        self._active.clear()

    # ── internal ──────────────────────────────────────────────────────────────

    def _create_and_register(self, config: MCPServerConfig) -> MCPCapabilityProvider:
        from netlivecowork.config import get_settings
        _cfg = get_settings()
        provider = SessionAwareMCPProvider(
            config,
            max_reconnect_attempts=_cfg.mcp_max_reconnect_attempts,
            reconnect_base_delay_sec=_cfg.mcp_reconnect_base_delay_sec,
            client_name=_MCP_CLIENT_NAME,
            client_version=_MCP_CLIENT_VERSION,
        )
        # ⚠ 包装之后注册的是**包装器**，但 _active/_all 里存内层——那两个是用来
        # 管理连接生命周期的（refresh/close），跟"谁看得见"无关。
        self._active[config.name] = provider
        self._all.append(provider)
        self._registry.register_capability(
            self._wrap(provider, config.name) if self._wrap else provider
        )
        return provider

    def _to_info(self, config: MCPServerConfig, provider: MCPCapabilityProvider) -> MCPServerInfo:
        caps = provider._capabilities_cache or []
        tools = [MCPToolInfo(name=c.name, description=c.description) for c in caps]
        is_stdio = config.transport == "stdio"
        return MCPServerInfo(
            name=config.name,
            type="stdio" if is_stdio else "http",
            status=provider.connection_status,
            tool_count=len(tools),
            tools=tools,
            command=config.command[0] if is_stdio and config.command else None,
            args=list(config.command[1:]) if is_stdio and len(config.command) > 1 else None,
            url=config.url if not is_stdio else None,
            timeout_per_call_sec=config.timeout_per_call_sec,
            connect_timeout_sec=config.connect_timeout_sec,
            trust_env=config.trust_env,
        )
