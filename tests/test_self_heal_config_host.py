"""host Settings 把 NLC_LLM_SELF_HEAL_* env 透传进 RuntimeConfig（镜像上游 loomex_host 同名测试）。"""
from __future__ import annotations

from netlivecowork.config import Settings


def test_settings_threads_self_heal_into_runtime_config(monkeypatch):
    monkeypatch.setenv("NLC_LLM_SELF_HEAL_MAX_ATTEMPTS", "5")
    monkeypatch.setenv("NLC_LLM_SELF_HEAL_MAX_DURATION_SEC", "120")
    monkeypatch.setenv("NLC_LLM_SELF_HEAL_BASE_DELAY_SEC", "1")
    monkeypatch.setenv("NLC_LLM_SELF_HEAL_MAX_INTERVAL_SEC", "30")
    rc = Settings.from_env().to_runtime_config()
    assert rc.llm_self_heal_max_attempts == 5
    assert rc.llm_self_heal_max_duration_sec == 120
    assert rc.llm_self_heal_base_delay_sec == 1
    assert rc.llm_self_heal_max_interval_sec == 30
