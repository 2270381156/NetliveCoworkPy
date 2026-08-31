from netlivecowork.providers.llm.llm_provider import LLMProvider, LLMAccount
from netlivecowork.providers.llm.adapters import HostOpenAIAdapter


class _MemStore:
    def __init__(self):
        self._d = {}

    def save(self, acc):
        self._d[acc.name] = acc

    def delete(self, name):
        self._d.pop(name, None)

    def list_all(self):
        return list(self._d.values())


def test_openai_account_builds_host_adapter():
    p = LLMProvider(_MemStore())
    acc = LLMAccount(name="zhipu", style="openai", api_key="k", base_url="https://foo.cn/v1")
    p.register_account(acc, persist=True)
    adapter = p._adapters["zhipu"]
    assert isinstance(adapter, HostOpenAIAdapter)
    assert adapter._chat_url() == "https://foo.cn/v1/chat/completions"
