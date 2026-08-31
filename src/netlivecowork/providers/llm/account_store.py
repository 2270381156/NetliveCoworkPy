"""LLMAccountStore — JSON file persistence for LLM account configs.

Layout: data/llm_configs/{name}.json
Note: 用户注册的账号 api_key 明文存储（这是用户自己的 key，界面本就不展示，
      无需对用户隐藏；也避免升级兼容/混淆密钥变更带来的读取问题）。
      只有 env 兜底的「默认模型」key 走混淆加密（见 providers/llm/secret.py，
      在 .env 里以 enc:v1:... 形式配置、bootstrap 时解密）。
"""

from __future__ import annotations

import dataclasses
import json
import logging
from pathlib import Path

from ctx_weft.providers.llm import LLMAccount, ModelConfig
from netlivecowork.config import get_settings

logger = logging.getLogger(__name__)

# ModelConfig 的合法字段名。反序列化时按此过滤，丢弃历史/未知键（如已改名的
# max_output_tokens）——旧配置文件不会因多余键 TypeError，未知项被忽略、字段吃默认。
_MODEL_FIELDS = {f.name for f in dataclasses.fields(ModelConfig)}


def _model_from_dict(m: dict) -> ModelConfig:
    return ModelConfig(**{k: v for k, v in m.items() if k in _MODEL_FIELDS})

_PROJECT_ROOT = Path(__file__).parents[4]


def _resolve_resources_dir() -> Path:
    raw = get_settings().resources_dir
    return Path(raw) if raw else _PROJECT_ROOT / "resources"


class LLMAccountStore:
    def __init__(self, data_dir: Path | None = None) -> None:
        self._dir = data_dir if data_dir else _resolve_resources_dir() / "llm_configs"

    def _path(self, name: str) -> Path:
        safe = name.replace("/", "_").replace("\\", "_").replace(":", "_")
        return self._dir / f"{safe}.json"

    def save(self, account: LLMAccount) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._path(account.name)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(dataclasses.asdict(account), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        tmp.replace(path)

    def delete(self, name: str) -> bool:
        path = self._path(name)
        if path.exists():
            path.unlink()
            return True
        return False

    def list_all(self) -> list[LLMAccount]:
        if not self._dir.exists():
            return []
        results = []
        for path in sorted(self._dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                models = [_model_from_dict(m) for m in data.get("models", [])]
                account = LLMAccount(
                    name=data["name"],
                    style=data["style"],
                    api_key=data.get("api_key", ""),
                    base_url=data.get("base_url", ""),
                    models=models,
                    default_model=data.get("default_model", ""),
                    timeout_sec=data.get("timeout_sec", 120),
                )
                results.append(account)
            except Exception:
                logger.exception("LLMAccountStore: failed to load %s", path.name)
        return results
