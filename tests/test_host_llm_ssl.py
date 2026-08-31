from netlivecowork.providers.llm.adapters import HostAnthropicAdapter, HostOpenAIAdapter
from netlivecowork.providers.llm.llm_provider import LLMAccount, LLMProvider


class _MemStore:
    def __init__(self):
        self._d = {}

    def save(self, acc):
        self._d[acc.name] = acc

    def delete(self, name):
        self._d.pop(name, None)

    def list_all(self):
        return list(self._d.values())


def test_provider_defaults_ssl_verify_false():
    p = LLMProvider(_MemStore())
    acc = LLMAccount(name="x", style="openai", api_key="k", base_url="https://foo/v1")
    p.register_account(acc, persist=True)
    assert p._adapters["x"]._ssl_verify is False


def test_openai_adapter_accepts_explicit_ssl_verify():
    a = HostOpenAIAdapter(api_key="k", base_url="https://x/v1", ssl_verify=True)
    assert a._ssl_verify is True


def test_anthropic_adapter_defaults_ssl_verify_false():
    a = HostAnthropicAdapter(api_key="k")
    assert a._ssl_verify is False
