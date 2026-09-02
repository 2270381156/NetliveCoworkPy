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
        # 套件下发（transient / 不落盘）且注册成功的 server 名字。启动时的连通性自检
        # 只针对这些——它们的 url/header 来自云端下发的 cowork 套件，最需要在启动日志里
        # 留下"连没连上、抓到哪些工具"的证据（随包 browser-mcp、用户手配的不在此列）。
        self._transient_names: set[str] = set()

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

    def register_transient(self, config: MCPServerConfig) -> bool:
        """注册一个**不落盘**的 MCP server —— 给套件下发的那些用。

        与 `register` 的区别只有一条：不写 mcp.json。套件下发的东西属于 cowork
        不属于用户，套件被收回、重启之后就该消失；写进 mcp.json 的话它会一直留着，
        而云端管理台里根本没有它，用户不知道去哪关掉。同 LLM 账号那边的 persist=False。

        已经有同名的就不动（用户手工配的、或随包的优先）——返回 False 让调用方知道。
        """
        if config.name in self._active:
            return False
        try:
            self._create_and_register(config)
            self._transient_names.add(config.name)
            logger.info("MCPProviderManager: 套件下发的 '%s' 已注册（不落盘）", config.name)
            return True
        except Exception:
            logger.warning("MCPProviderManager: 套件下发的 '%s' 注册失败", config.name, exc_info=True)
            return False

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

    async def probe_transient_and_log(self) -> None:
        """启动连通性自检：对**套件下发**的每个 MCP server 真连一次、拉工具清单，打进日志。

        为什么单独有这一步：套件的 url/header 来自云端下发，装配期只是把它们注册进来
        （register_transient），并不知道那个内网地址到底通不通、header 对不对、后端到底
        暴露了哪些工具。连不上时 agent 侧只会在**用到的时候**才惰性重连并报错，排查时
        既看不到"是哪个 server 连不上"，也看不到"本该有哪些工具"。这里在启动日志里
        一次性把这些落下来。

        纯诊断、best-effort：连不上只记 warning，绝不抛（agent 路径仍会惰性重连，见
        prewarm_all 的注释）。放在后台 prewarm task 里调，不挡 lifespan / /health。
        """
        names = sorted(self._transient_names)
        if not names:
            return
        logger.info("MCP 连通性自检：套件下发的 server 共 %d 个，逐个连接并拉取工具…", len(names))
        for name in names:
            provider = self._active.get(name)
            if provider is None:
                continue
            cfg = getattr(provider, "_cfg", None)
            if cfg is not None and cfg.transport != "stdio":
                endpoint = cfg.url
            elif cfg is not None and cfg.command:
                endpoint = cfg.command[0]
            else:
                endpoint = "?"
            try:
                # ⚠ 必须先 start()：list()/_ensure_connected 是**非阻塞**的（绝不挡 agent loop，
                # 后台连、没连上就优雅降级返回空），冷 provider 上直接 list() 会拿到 0 个工具、
                # status 停在 CONNECTING。start() 会真等到握手完成（至多 connect_timeout+5s）。
                # 对已被 prewarm 连上的 provider，start() 幂等、立即返回 True。
                connected = await provider.start()
                if not connected:
                    logger.warning(
                        "MCP 连通性自检 [%s] 连不上：endpoint=%s status=%s"
                        "（连接超时/被拒，agent 侧会惰性重连）",
                        name, endpoint, provider.connection_status,
                    )
                    continue
                provider._capabilities_cache = None
                await provider.list(_DUMMY_CTX)
                caps = provider._capabilities_cache or []
                tools = [c.name for c in caps]
                logger.info(
                    "MCP 连通性自检 [%s] OK：endpoint=%s status=%s 工具 %d 个：%s",
                    name, endpoint, provider.connection_status, len(tools),
                    ", ".join(tools) if tools else "(无)",
                )
            except Exception as e:
                logger.warning(
                    "MCP 连通性自检 [%s] 失败：endpoint=%s status=%s error=%s",
                    name, endpoint, getattr(provider, "connection_status", "?"), e,
                )

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
