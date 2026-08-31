import pytest

from netlivecowork.providers.llm.adapters import _resolve_chat_url, HostOpenAIAdapter


@pytest.mark.parametrize("base, expected", [
    ("https://api.openai.com", "https://api.openai.com/v1/chat/completions"),
    ("https://api.openai.com/", "https://api.openai.com/v1/chat/completions"),
    ("https://foo.cn/v1", "https://foo.cn/v1/chat/completions"),
    ("https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/chat/completions"),
    ("https://foo.cn/v1/chat/completions", "https://foo.cn/v1/chat/completions"),
])
def test_resolve_chat_url(base, expected):
    assert _resolve_chat_url(base) == expected


def test_host_openai_adapter_uses_inference():
    a = HostOpenAIAdapter(api_key="k", base_url="https://foo.cn/v1")
    assert a._chat_url() == "https://foo.cn/v1/chat/completions"
