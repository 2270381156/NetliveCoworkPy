"""SessionAwareMCPProvider 把当前 session_id 注入 MCP 请求的 _meta。

host 需要让 MCP server 端能按会话归因/隔离，故 invoke 时把 ProviderContext.session_id
透传到 call_tool 的 meta（即请求的 _meta.session_id）。core 的 invoke 会丢弃 ctx，所以
这必须由 host 子类重写 invoke 完成。
"""

from __future__ import annotations

from types import SimpleNamespace

from ctx_weft.protocols.capability import CapabilityEvent
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.providers.capability_mcp.provider import MCPServerConfig
from netlivecowork.providers.capability.mcp.provider import SessionAwareMCPProvider


class _FakeSession:
    """记录 call_tool 收到的 (name, arguments, meta)。"""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def call_tool(self, name, *, arguments=None, meta=None):
        self.calls.append((name, arguments, meta))
        return SimpleNamespace(content=[SimpleNamespace(text="ok")], isError=False, structuredContent=None)


async def _drain(agen) -> list[CapabilityEvent]:
    return [e async for e in agen]


async def test_invoke_injects_session_id_into_meta() -> None:
    p = SessionAwareMCPProvider(MCPServerConfig(name="web"))
    fake = _FakeSession()
    p._session = fake  # 伪装已连接，绕过 _ensure_connected
    ctx = ProviderContext(session_id="sess-123", tenant_id="default")

    events = await _drain(p.invoke("mcp:web:search", {"q": "x"}, ctx))

    assert fake.calls == [("search", {"q": "x"}, {"session_id": "sess-123"})]
    assert events and events[-1].kind == "result"
    assert events[-1].payload["content"] == "ok"


async def test_invoke_omits_meta_when_no_session_id() -> None:
    p = SessionAwareMCPProvider(MCPServerConfig(name="web"))
    fake = _FakeSession()
    p._session = fake
    ctx = ProviderContext(session_id="", tenant_id="default")

    await _drain(p.invoke("mcp:web:search", {}, ctx))

    assert fake.calls[0][2] is None


async def test_not_connected_yields_error_without_calling_tool() -> None:
    p = SessionAwareMCPProvider(MCPServerConfig(name="web"))
    # 不设置 _session，且处于冷却外——_ensure_connected 会起后台 runner 但本轮仍 None
    p._cooldown_until = float("inf")  # 强制冷却，确保本轮 _session 保持 None
    ctx = ProviderContext(session_id="s", tenant_id="default")

    events = await _drain(p.invoke("mcp:web:search", {}, ctx))

    assert events and events[-1].kind == "error"
    assert events[-1].payload["code"] == "NOT_CONNECTED"
