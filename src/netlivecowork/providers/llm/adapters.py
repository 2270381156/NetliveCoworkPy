"""Host LLM adapter subclasses.

Override core adapter seams for internal-deployment concerns without modifying
ctx_weft:
  - OpenAI chat-endpoint inference (_chat_url)
  - OpenAI-compatible reasoning dialect normalization
  - corporate-CA SSL (_make_client)  ← added in the SSL phase
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from ctx_weft.providers.llm.anthropic import AnthropicAdapter
from ctx_weft.providers.llm.openai import OpenAIAdapter

_VERSION_SEG = re.compile(r"v\d+", re.IGNORECASE)
_SSE_DATA_PREFIX = "data: "


def _normalize_reasoning_sse_line(line: str) -> str:
    """Map vLLM ``delta.reasoning`` to the dialect understood by ctx_weft.

    The host owns compatibility with deployed OpenAI-compatible endpoints.  Keep
    the vendored SDK unchanged and normalize only its SSE input boundary.  When
    both fields are present, ``reasoning_content`` keeps precedence, matching the
    SDK's existing DeepSeek behavior.
    """
    if not line.startswith(_SSE_DATA_PREFIX) or '"reasoning"' not in line:
        return line

    raw_event = line[len(_SSE_DATA_PREFIX):]
    try:
        event = json.loads(raw_event)
    except json.JSONDecodeError:
        return line

    choices = event.get("choices") if isinstance(event, dict) else None
    choice = choices[0] if isinstance(choices, list) and choices else None
    delta = choice.get("delta") if isinstance(choice, dict) else None
    if not isinstance(delta, dict):
        return line

    reasoning = delta.get("reasoning")
    if not reasoning or delta.get("reasoning_content"):
        return line
    delta["reasoning_content"] = reasoning
    return _SSE_DATA_PREFIX + json.dumps(event, ensure_ascii=False, separators=(",", ":"))


class _ReasoningCompatResponse:
    """Response facade that changes only OpenAI-compatible SSE data lines."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)

    async def aiter_lines(self) -> AsyncIterator[str]:
        async for line in self._response.aiter_lines():
            yield _normalize_reasoning_sse_line(line)


class _ReasoningCompatClient(httpx.AsyncClient):
    """httpx client that normalizes only streamed reasoning events."""

    @asynccontextmanager
    async def stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[_ReasoningCompatResponse]:
        async with super().stream(*args, **kwargs) as response:
            yield _ReasoningCompatResponse(response)


def _resolve_chat_url(base: str) -> str:
    """Infer the chat-completions endpoint from a configured base_url.

    - already a full endpoint (.../chat/completions) → unchanged
    - ends with a version segment (/v1, /paas/v4)     → append /chat/completions
    - bare host (https://api.openai.com)              → append /v1/chat/completions
    """
    b = base.rstrip("/")
    if b.lower().endswith("/chat/completions"):
        return b
    last = b.rsplit("/", 1)[-1]
    if _VERSION_SEG.fullmatch(last):
        return f"{b}/chat/completions"
    return f"{b}/v1/chat/completions"


def _resolve_verify(ssl_verify):
    """httpx verify arg: bool / ssl.SSLContext / CA-bundle path.

    Defaults to True (secure) only when ssl_verify is None; an explicit False
    disables verification (internal/self-signed endpoints).
    """
    return ssl_verify if ssl_verify is not None else True


class HostOpenAIAdapter(OpenAIAdapter):
    def __init__(self, *args, ssl_verify: bool | str = False, **kwargs) -> None:
        # Set before super().__init__: the core ctor calls self._make_client().
        self._ssl_verify = ssl_verify
        super().__init__(*args, **kwargs)

    def _chat_url(self) -> str:
        return _resolve_chat_url(self._base_url)

    def _make_client(self) -> httpx.AsyncClient:
        return _ReasoningCompatClient(
            timeout=self._timeout,
            trust_env=False,
            verify=_resolve_verify(self._ssl_verify),
        )


class HostAnthropicAdapter(AnthropicAdapter):
    def __init__(self, *args, ssl_verify: bool | str = False, **kwargs) -> None:
        self._ssl_verify = ssl_verify
        super().__init__(*args, **kwargs)

    def _make_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self._timeout, trust_env=False, verify=_resolve_verify(self._ssl_verify))
