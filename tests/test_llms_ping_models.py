"""host LLM ping / available-models 端点。直接调用路由函数 + 假 provider（不起 app）。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from netlivecowork.api import llms as llms_api
from netlivecowork.api.schemas.llms import ListModelsRequest, PingRequest


class _FakeProvider:
    def __init__(self, models=None, fail=False) -> None:
        self._models = models if models is not None else ["a", "b"]
        self._fail = fail

    async def ping(self, style, api_key, base_url=""):
        if self._fail:
            raise RuntimeError("boom")
        return 12.3

    async def ping_account(self, name):
        if name == "missing":
            raise KeyError(name)
        if self._fail:
            raise RuntimeError("boom")
        return 5.0

    async def fetch_models(self, style, api_key, base_url=""):
        if self._fail:
            raise RuntimeError("boom")
        return self._models

    async def fetch_models_for_account(self, name):
        if name == "missing":
            raise KeyError(name)
        return self._models

    async def verify_model(self, style, api_key, base_url="", model=""):
        if self._fail or model == "bad-model":
            raise RuntimeError("API error 404: model not found")
        return 9.9

    async def verify_model_for_account(self, name, model):
        if name == "missing":
            raise KeyError(name)
        if model == "bad-model":
            raise RuntimeError("API error 404: model not found")
        return 7.0


async def test_ping_ok():
    out = await llms_api.ping(PingRequest(style="openai", api_key="k"), provider=_FakeProvider())
    assert out.ok is True
    assert out.latency_ms == 12.3


async def test_ping_failure_returns_ok_false():
    out = await llms_api.ping(PingRequest(style="openai", api_key="bad"), provider=_FakeProvider(fail=True))
    assert out.ok is False
    assert out.latency_ms == 0.0


async def test_ping_with_model_verifies():
    out = await llms_api.ping(PingRequest(style="openai", api_key="k", model="gpt-4o"), provider=_FakeProvider())
    assert out.ok is True
    assert out.latency_ms == 9.9  # verify_model 的延迟，而非 ping() 的 12.3


async def test_ping_without_model_falls_back_to_connectivity():
    out = await llms_api.ping(PingRequest(style="openai", api_key="k"), provider=_FakeProvider())
    assert out.ok is True
    assert out.latency_ms == 12.3  # 退回 ping()，不做补全


async def test_ping_bad_model_returns_error_reason():
    out = await llms_api.ping(PingRequest(style="openai", api_key="k", model="bad-model"), provider=_FakeProvider())
    assert out.ok is False
    assert out.error  # 失败原因非空，前端可展示


async def test_ping_account_with_model_verifies():
    out = await llms_api.ping_account("acc", model="gpt-4o", provider=_FakeProvider())
    assert out.ok is True
    assert out.latency_ms == 7.0


async def test_ping_account_without_model_uses_connectivity():
    out = await llms_api.ping_account("acc", model=None, provider=_FakeProvider())
    assert out.ok is True
    assert out.latency_ms == 5.0


async def test_ping_account_bad_model_returns_error_reason():
    out = await llms_api.ping_account("acc", model="bad-model", provider=_FakeProvider())
    assert out.ok is False
    assert out.error


async def test_ping_account_missing_404():
    with pytest.raises(HTTPException) as ei:
        await llms_api.ping_account("missing", model=None, provider=_FakeProvider())
    assert ei.value.status_code == 404


async def test_available_models_ok():
    out = await llms_api.available_models(
        ListModelsRequest(style="anthropic", api_key="k"), provider=_FakeProvider(models=["m1", "m2"])
    )
    assert out.models == ["m1", "m2"]


async def test_available_models_failure_400():
    with pytest.raises(HTTPException) as ei:
        await llms_api.available_models(ListModelsRequest(style="x", api_key="k"), provider=_FakeProvider(fail=True))
    assert ei.value.status_code == 400


async def test_available_models_of_account():
    out = await llms_api.available_models_of("acc", provider=_FakeProvider(models=["z"]))
    assert out.models == ["z"]


async def test_available_models_of_missing_404():
    with pytest.raises(HTTPException) as ei:
        await llms_api.available_models_of("missing", provider=_FakeProvider())
    assert ei.value.status_code == 404
