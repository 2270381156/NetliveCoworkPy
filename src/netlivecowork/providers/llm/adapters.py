"""Host LLM adapter subclasses.

Override core adapter seams for internal-deployment concerns without modifying
ctx_weft:
  - OpenAI chat-endpoint inference (_chat_url)
  - corporate-CA SSL (_make_client)  ← added in the SSL phase
"""

from __future__ import annotations

import re

import httpx

from ctx_weft.providers.llm.anthropic import AnthropicAdapter
from ctx_weft.providers.llm.openai import OpenAIAdapter

_VERSION_SEG = re.compile(r"v\d+", re.IGNORECASE)


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
        return httpx.AsyncClient(timeout=self._timeout, trust_env=False, verify=_resolve_verify(self._ssl_verify))


class HostAnthropicAdapter(AnthropicAdapter):
    def __init__(self, *args, ssl_verify: bool | str = False, **kwargs) -> None:
        self._ssl_verify = ssl_verify
        super().__init__(*args, **kwargs)

    def _make_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self._timeout, trust_env=False, verify=_resolve_verify(self._ssl_verify))
