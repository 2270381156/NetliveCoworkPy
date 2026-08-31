"""LLMAccountStore 反序列化对未知/历史键容错：旧配置里的 max_output_tokens 键被丢弃，
不因改名而加载崩溃；新字段 output_reserve 吃默认 None（→ core 按窗口尺寸取默认）。
"""
from __future__ import annotations

import json

from netlivecowork.providers.llm.account_store import LLMAccountStore


def test_load_drops_legacy_max_output_tokens_key(tmp_path):
    # 模拟改名前存下的配置文件：models[].max_output_tokens 现已不是 ModelConfig 字段
    (tmp_path / "acc.json").write_text(json.dumps({
        "name": "acc", "style": "openai", "api_key": "k", "base_url": "https://x/v1",
        "default_model": "m", "timeout_sec": 120,
        "models": [{"name": "m", "context_limit": 200_000,
                    "max_output_tokens": 8192, "output_ceiling": 64_000}],
    }), encoding="utf-8")

    accounts = LLMAccountStore(data_dir=tmp_path).list_all()

    assert len(accounts) == 1                          # 未因未知键 TypeError 被跳过
    m = accounts[0].models[0]
    assert m.context_limit == 200_000
    assert m.output_ceiling == 64_000                  # 已知键正常透传
    assert m.output_reserve is None                    # 旧 max_output_tokens 被丢弃 → 默认 None（auto）
    assert not hasattr(m, "max_output_tokens")
