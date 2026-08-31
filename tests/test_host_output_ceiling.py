"""output_ceiling 透传：默认账号种子（A）与用户注册模型的 API 路径（B）。

约束：种子的 output_ceiling 只作用于随包默认账号/模型；用户注册的模型仅取自身配置数据
（API 请求），不拿默认账号补位。未配 → None（core 网关回退 context_limit）。
"""
from __future__ import annotations

import json

from netlivecowork.api.llms import add_model as api_add_model, register_account
from netlivecowork.api.schemas.llms import (
    AddModelRequest,
    ModelConfigRequest,
    RegisterAccountRequest,
)
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


def _seed(tmp_path, **extra):
    """写一份最小默认账号种子，bootstrap 后返回默认模型的 ModelConfig。"""
    entry = {"account": "default", "style": "openai", "api_key": "sk-x",
             "base_url": "", "model": "gpt-4o", **extra}
    f = tmp_path / "seed.json"
    f.write_text(json.dumps([entry]), encoding="utf-8")
    p = LLMProvider(_MemStore())
    p.bootstrap_from_seed(f)
    return p.get_account("default").models[0]


# ── A: 随包默认模型（种子）─────────────────────────────────────────────────────


def test_bootstrap_threads_output_ceiling_from_seed(tmp_path):
    assert _seed(tmp_path, output_ceiling=64000).output_ceiling == 64000


def test_bootstrap_output_ceiling_absent_is_none(tmp_path):
    assert _seed(tmp_path).output_ceiling is None


# ── B: 用户注册模型走自身数据（无默认账号补位）────────────────────────────────


def test_register_account_threads_output_ceiling():
    p = LLMProvider(_MemStore())
    req = RegisterAccountRequest(
        name="acc", style="openai", api_key="k", base_url="https://x/v1",
        models=[ModelConfigRequest(
            name="claude-x", context_limit=200_000, output_reserve=8192, output_ceiling=64_000)],
        default_model="claude-x",
    )
    resp = register_account(req, provider=p)
    assert resp.models[0].output_ceiling == 64_000
    assert p.get_account("acc").models[0].output_ceiling == 64_000


def test_register_account_output_ceiling_defaults_none():
    p = LLMProvider(_MemStore())
    req = RegisterAccountRequest(
        name="acc", style="openai", api_key="k", base_url="https://x/v1",
        models=[ModelConfigRequest(name="gpt-4o", context_limit=128_000)],
        default_model="gpt-4o",
    )
    resp = register_account(req, provider=p)
    assert resp.models[0].output_ceiling is None
    assert p.get_account("acc").models[0].output_ceiling is None


def test_add_model_api_threads_output_ceiling():
    p = LLMProvider(_MemStore())
    p.register_account(
        LLMAccount(name="acc", style="openai", api_key="k", base_url="https://x/v1",
                   models=[], default_model=""),
        persist=False,
    )
    resp = api_add_model(
        "acc",
        AddModelRequest(model="claude-x", context_limit=200_000, output_ceiling=64_000),
        provider=p,
    )
    m = next(m for m in resp.models if m.name == "claude-x")
    assert m.output_ceiling == 64_000
