"""bootstrap_from_seed 读 JSON 种子的 output_reserve；未设/空 → None（core 按窗口自动）。

默认账号已从 env 迁到扁平 JSON 种子（default_llm_accounts.json），字段 output_reserve
对应原 NLC_LLM_OUTPUT_RESERVE。旧键 NLC_LLM_MAX_OUTPUT_TOKENS 早已不读、此处不再涉及。
"""
from __future__ import annotations

import json

from netlivecowork.providers.llm.llm_provider import LLMProvider


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
    """写一份最小种子（可覆盖字段），bootstrap 后返回默认模型的 ModelConfig。"""
    entry = {"account": "default", "style": "openai", "api_key": "sk-x",
             "base_url": "", "model": "gpt-4o", **extra}
    f = tmp_path / "seed.json"
    f.write_text(json.dumps([entry]), encoding="utf-8")
    p = LLMProvider(_MemStore())
    p.bootstrap_from_seed(f)
    return p.get_account("default").models[0]


def test_reads_output_reserve_key(tmp_path):
    assert _seed(tmp_path, output_reserve=64000).output_reserve == 64000


def test_unset_is_auto(tmp_path):
    assert _seed(tmp_path).output_reserve is None                       # 未设


def test_empty_is_auto(tmp_path):
    assert _seed(tmp_path, output_reserve="").output_reserve is None    # 模板空值
