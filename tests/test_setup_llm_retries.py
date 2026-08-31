"""_setup_llm must forward llm_max_http_retries from settings to LLMProvider.

Fix 2 regression guard: before the fix, _setup_llm built LLMProvider without
passing max_http_retries, so NLC_LLM_MAX_HTTP_RETRIES had no effect on the
API-server runtime (only the CLI path injected it).
"""

from __future__ import annotations

import importlib
import os
from types import SimpleNamespace
from unittest.mock import MagicMock

from netlivecowork import config as cfgmod


def _clear_env(monkeypatch):
    for k in list(os.environ):
        if k.startswith("NLC_"):
            monkeypatch.delenv(k, raising=False)


class _FakeProviders:
    """Minimal provider registry stub that records the registered LLM provider."""
    def __init__(self):
        self.registered = None

    def register_llm_provider(self, provider):
        self.registered = provider


def test_setup_llm_forwards_max_http_retries(monkeypatch):
    """_setup_llm propagates llm_max_http_retries from settings into LLMProvider._max_http_retries."""
    _clear_env(monkeypatch)
    monkeypatch.setenv("NLC_LLM_MAX_HTTP_RETRIES", "7")

    # Reload config so get_settings() sees the new env value.
    importlib.reload(cfgmod)

    fake_providers = _FakeProviders()
    runtime_stub = SimpleNamespace(providers=fake_providers)

    from netlivecowork.bootstrap.host_runtime import _register_llm
    _register_llm(runtime_stub)

    provider = fake_providers.registered
    assert provider is not None, "_setup_llm did not register any LLM provider"
    assert provider._max_http_retries == 7, (
        f"Expected _max_http_retries=7, got {provider._max_http_retries}"
    )
