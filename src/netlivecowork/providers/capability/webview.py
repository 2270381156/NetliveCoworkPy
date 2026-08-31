"""应用内浏览器内容 tool（host capability provider，不碰 ctx_weft）。

暴露一个工具 ``view_side_web_page``：读取用户当前在右侧「网页」面板打开的那一页正文。
内容不在后端——经 ``webview_bridge`` 向前端 webview 现取（方案 B round-trip）。

不做 retrieve 门控：list() 直接暴露该 tool，触发时机由 description 明确的使用场景约束。
输出不手动截断——``spillable=True`` 时超长正文由 capability gateway 自动落盘 + 预览。
"""
from __future__ import annotations

from typing import Any, AsyncIterator

from ctx_weft.protocols.capability import (
    Capability,
    CapabilityEvent,
    CapabilityProviderInfo,
    ToolCapability,
    ToolCapabilityProvider,
)
from ctx_weft.protocols.context import ProviderContext

from netlivecowork.api import webview_bridge

WEBVIEW_PROVIDER_NAME = "webview"
VIEW_PAGE_ID = f"{WEBVIEW_PROVIDER_NAME}:view_page"

# 与内核 fs 工具（read_file/write_file）同风格：英文、首句功能 + 何时用/边界 + 时效规则。
_DESCRIPTION = (
    "Read the page the user currently has open in the right-side \"Web\" panel — returns "
    "that one page's title, visible text, headings, and links (it does NOT fetch arbitrary "
    "URLs mentioned in the conversation). Call it whenever the user's question is about, or "
    "depends on, the page they have open on the right, including a page they just navigated "
    "to, clicked into, or otherwise interacted with before asking; when unsure whether they "
    "mean that page, prefer calling it. The page is live and changes as the user browses: "
    "each call returns the CURRENT page, so never answer about it from an earlier read — if "
    "the user may have navigated or changed the page since you last looked, call it again "
    "for the up-to-date content. Returns a note if no page is open or the desktop app can't "
    "be reached."
)


class WebviewCapabilityProvider(ToolCapabilityProvider):
    """单工具 provider：读取前端应用内浏览器当前页面。"""

    name = WEBVIEW_PROVIDER_NAME
    description = "Access the web page the user is viewing in the in-app browser."

    def __init__(self, *, timeout: float = 8.0) -> None:
        self._timeout = timeout
        self._cap = ToolCapability(
            id=VIEW_PAGE_ID,
            name="view_side_web_page",
            kind="tool",
            description=_DESCRIPTION,
            input_schema={"type": "object", "properties": {}},  # 无参：只返回当前打开的那一页
            side_effects=False,
            spillable=True,  # 超长正文交给 gateway 落盘，不手动截断
            purposes=["act"],
        )

    async def list(self, ctx: ProviderContext) -> list[Capability]:
        return [self._cap]

    async def describe(self, ctx: ProviderContext) -> CapabilityProviderInfo:
        return CapabilityProviderInfo(
            name=self.name, capability_count=1, description=self.description,
        )

    async def invoke(
        self,
        capability_id: str,
        arguments: dict[str, Any],
        ctx: ProviderContext,
    ) -> AsyncIterator[CapabilityEvent]:
        content = await webview_bridge.request_content(ctx.session_id, timeout=self._timeout)
        if not content or not str(content.get("text") or "").strip():
            yield CapabilityEvent(kind="result", payload={
                "content": "No web page is currently open in the right-side panel "
                           "(or the desktop app did not respond).",
            })
            return
        yield CapabilityEvent(kind="result", payload={"content": _format(content)})

    async def cancel(self, invocation_id: str, ctx: ProviderContext) -> None:
        pass


def _format(c: dict[str, Any]) -> str:
    """把前端回传的结构化内容拼成一段供 LLM 阅读的文本。"""
    parts: list[str] = []
    if c.get("title"):
        parts.append(f"# {c['title']}")
    if c.get("url"):
        parts.append(f"URL: {c['url']}")
    headings = c.get("headings") or []
    if headings:
        parts.append("Headings:\n" + "\n".join(f"- {h}" for h in headings))
    if c.get("text"):
        parts.append("Page text:\n" + str(c["text"]))
    links = c.get("links") or []
    if links:
        parts.append("Links:\n" + "\n".join(
            f"- {l.get('text', '').strip()}: {l.get('href', '')}" for l in links if l.get("href")
        ))
    return "\n\n".join(parts)
