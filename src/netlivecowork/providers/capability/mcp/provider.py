"""SessionAwareMCPProvider — host 子类：调用 MCP 工具时把 session_id 注入请求 _meta。

继承 core 的 `MCPCapabilityProvider`，只重写 `invoke`。core 的 `invoke(cap, args, ctx)`
会丢弃 `ctx`（其 `_invoke_impl` 不接收 ctx），而 host 需要把当前会话标识透传给 MCP
server——写进请求的 `_meta.session_id`，让 server 端能按会话归因/隔离/限流。连接、退避、
结果解析等逻辑全部复用父类，这里只在调用 `call_tool` 时多带一个 `meta`。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import truststore
from ctx_weft.protocols.capability import CapabilityEvent
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.providers.capability_mcp.provider import (
    MCPCapabilityProvider,
    _parse_tool_result,
)

# 让本模块创建的 ssl.SSLContext（即下面 httpx.AsyncClient 用到的那个）走 Windows/macOS/Linux
# 系统信任库校验证书，而不是 Python 内置的 certifi 列表——与 Electron net.fetch 的证书信任行为
# 对齐。全局 monkeypatch、幂等，模块导入时执行一次即可。详见 HANDOFF_MCP_TLS_TRUSTSTORE.md。
truststore.inject_into_ssl()


class SessionAwareMCPProvider(MCPCapabilityProvider):
    """MCPCapabilityProvider，但每次工具调用都把 session_id 放进请求 `_meta`。

    另外覆写 `_transport_cm`：streamable_http transport 默认用 httpx 的 trust_env=True，
    会读取环境里的 HTTP_PROXY/HTTPS_PROXY/NO_PROXY、SSL_CERT_FILE、NETRC 等——内网部署
    时这些代理/证书设置往往把直连内网 MCP server 的请求绕坏。这里按该 server 的持久化配置
    `MCPServerConfig.trust_env`（默认 False）决定是否信任环境变量。stdio transport 不受影响。
    """

    def _transport_cm(self) -> Any:
        # stdio 与证书/代理无关，沿用父类（含 command/env 校验）。
        if self._cfg.transport == "stdio":
            return super()._transport_cm()

        import httpx
        from mcp.client.streamable_http import streamable_http_client

        # getattr 兜底：core/host 跨仓同步时若临时碰上无该字段的旧 MCPServerConfig，按 False 处理。
        trust_env = getattr(self._cfg, "trust_env", False)
        cfg = self._cfg

        @asynccontextmanager
        async def _cm() -> AsyncIterator[Any]:
            # 自建 httpx 客户端。follow_redirects/timeout 复刻 SDK 自建客户端
            # （mcp.shared._httpx_utils.create_mcp_http_client）的默认：follow_redirects=True、
            # 连接/常规超时取 connect_timeout_sec、SSE 读超时 300s。
            # 而 trust_env 是有意偏离：SDK 不设此项 → 落到 httpx 默认 True（信任环境代理/证书）；
            # 这里改由该 server 的持久化配置决定，默认 False＝内网直连、忽略环境代理/证书。
            # 关键：streamable_http_client 不接管「外部传入」客户端的生命周期（仅当它自建时才
            # 关闭），故由本 CM 用 `async with client` 负责关闭，避免每次重连泄漏连接。
            client = httpx.AsyncClient(
                follow_redirects=True,
                trust_env=trust_env,
                timeout=httpx.Timeout(cfg.connect_timeout_sec, read=300.0),
                headers=cfg.headers or None,
            )
            async with client:
                async with streamable_http_client(
                    cfg.url, http_client=client, terminate_on_close=True
                ) as transport:
                    yield transport

        return _cm()

    def invoke(
        self, capability_id: str, arguments: dict[str, Any], ctx: ProviderContext
    ) -> AsyncIterator[CapabilityEvent]:
        return self._invoke_with_session(capability_id, arguments, ctx)

    async def _invoke_with_session(
        self, capability_id: str, arguments: dict[str, Any], ctx: ProviderContext
    ) -> AsyncIterator[CapabilityEvent]:
        # 与父类 _invoke_impl 同构，唯一区别是把 _build_call_meta(ctx) 透传给 call_tool。
        await self._ensure_connected()
        if self._session is None:
            yield CapabilityEvent(kind="error", payload={
                "code": "NOT_CONNECTED",
                "message": f"MCP server '{self._cfg.name}' is not connected (status={self.connection_status})",
            })
            return
        tool_name = capability_id.rsplit(":", 1)[-1]
        meta = self._build_call_meta(ctx)
        try:
            result = await asyncio.wait_for(
                self._session.call_tool(tool_name, arguments=arguments, meta=meta),
                timeout=self._cfg.timeout_per_call_sec,
            )
            text = _parse_tool_result(result)
            yield CapabilityEvent(
                kind="result",
                payload={"content": text, "metadata": {"is_error": bool(result.isError)}},
            )
        except TimeoutError:
            yield CapabilityEvent(kind="error", payload={"code": "TIMEOUT", "message": "MCP call timed out"})
        except Exception as e:
            yield CapabilityEvent(kind="error", payload={"code": "INVOKE_ERROR", "message": str(e)})

    @staticmethod
    def _build_call_meta(ctx: ProviderContext | None) -> dict[str, Any] | None:
        """构造请求 `_meta`：携带 session_id；无 session 时返回 None（不写 _meta）。"""
        if ctx is None or not ctx.session_id:
            return None
        return {"session_id": ctx.session_id}
