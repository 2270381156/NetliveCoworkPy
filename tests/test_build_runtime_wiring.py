"""build_host_runtime 接线：注册 agent 适配器 provider + 边界规范化助手（spec 2026-07-22）。"""

from __future__ import annotations

from types import SimpleNamespace

from netlivecowork.bootstrap import build_host_runtime
from netlivecowork.providers.templates import canonical_template_id
from netlivecowork.providers.templates.provider import DirAgentCapabilityProvider


def _args():
    return SimpleNamespace(enable_tools=False, skills_dir=None)


def test_build_host_runtime_registers_agent_provider_and_returns_resolver():
    hr = build_host_runtime(_args())
    provs = [p for p in hr.core.providers.get_capability_providers()
             if isinstance(p, DirAgentCapabilityProvider)]
    assert len(provs) == 1
    assert hr.agent_template_provider is not None  # create_app 经此喂 deps


def test_canonical_template_id():
    assert canonical_template_id("default") == "agent:default"
    assert canonical_template_id("agent:default") == "agent:default"      # 幂等
    assert canonical_template_id("mcp:reg:x") == "mcp:reg:x"              # 已带前缀不动
