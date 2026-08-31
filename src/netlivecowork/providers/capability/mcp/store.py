"""MCPServerStore — Claude Desktop 兼容的单文件 JSON 存储。

布局: <NLC_DATA_DIR>/mcp.json
格式:
  {
    "mcpServers": {
      "fs": {
        "command": "uvx",
        "args": ["mcp-server-filesystem", "/tmp"],
        "env": {},
        "default_purposes": ["act"],
        "timeout_per_call_sec": 60
      },
      "github": {
        "url": "http://localhost:3000/mcp",
        "headers": {},
        "default_purposes": ["act"],
        "timeout_per_call_sec": 60
      }
    }
  }

Claude Desktop 可直接读取此文件（会忽略 CtxWeft 扩展字段）。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ctx_weft.providers.capability_mcp.provider import MCPServerConfig
from netlivecowork.config import get_settings

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).parents[5]


def _resolve_resources_dir() -> Path:
    raw = get_settings().resources_dir
    return Path(raw) if raw else _PROJECT_ROOT / "resources"


class MCPServerStore:
    def __init__(self, data_dir: Path | None = None) -> None:
        self._dir = data_dir if data_dir else _resolve_resources_dir()

    @property
    def path(self) -> Path:
        return self._dir / "mcp.json"

    def _load_raw(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"mcpServers": {}}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("MCPServerStore: failed to read %s, treating as empty", self.path)
            return {"mcpServers": {}}

    def _save_raw(self, data: dict[str, Any]) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    # ── public API ────────────────────────────────────────────────────────────

    def load_all(self) -> list[MCPServerConfig]:
        raw = self._load_raw()
        result: list[MCPServerConfig] = []
        for name, entry in raw.get("mcpServers", {}).items():
            cfg = _entry_to_config(name, entry)
            if cfg is not None:
                result.append(cfg)
        return result

    def get(self, name: str) -> MCPServerConfig | None:
        entry = self._load_raw().get("mcpServers", {}).get(name)
        if entry is None:
            return None
        return _entry_to_config(name, entry)

    def exists(self, name: str) -> bool:
        return name in self._load_raw().get("mcpServers", {})

    def add(self, config: MCPServerConfig) -> None:
        raw = self._load_raw()
        raw.setdefault("mcpServers", {})[config.name] = _config_to_entry(config)
        self._save_raw(raw)

    def remove(self, name: str) -> bool:
        raw = self._load_raw()
        servers = raw.setdefault("mcpServers", {})
        if name not in servers:
            return False
        del servers[name]
        self._save_raw(raw)
        return True


# ── format helpers ────────────────────────────────────────────────────────────


def _entry_to_config(name: str, entry: dict[str, Any]) -> MCPServerConfig | None:
    if "command" in entry:
        cmd = [entry["command"]] + list(entry.get("args") or [])
        return MCPServerConfig(
            name=name,
            transport="stdio",
            command=cmd,
            env=entry.get("env") or {},
            default_purposes=entry.get("default_purposes") or ["act"],
            capability_purpose_override=entry.get("capability_purpose_override") or {},
            timeout_per_call_sec=int(entry.get("timeout_per_call_sec") or 60),
            connect_timeout_sec=int(entry.get("connect_timeout_sec") or 10),
        )
    if "url" in entry:
        transport = entry.get("transport", "http")
        return MCPServerConfig(
            name=name,
            transport=transport,  # type: ignore[arg-type]
            url=entry["url"],
            headers=entry.get("headers") or {},
            default_purposes=entry.get("default_purposes") or ["act"],
            capability_purpose_override=entry.get("capability_purpose_override") or {},
            timeout_per_call_sec=int(entry.get("timeout_per_call_sec") or 60),
            connect_timeout_sec=int(entry.get("connect_timeout_sec") or 10),
            # 前向兼容：旧 mcp.json 无此键 → 默认 False（直连，不信任环境代理/证书）。
            trust_env=bool(entry.get("trust_env", False)),
        )
    logger.warning("MCPServerStore: skipping '%s' — no 'command' or 'url'", name)
    return None


def _config_to_entry(config: MCPServerConfig) -> dict[str, Any]:
    if config.transport == "stdio":
        return {
            "command": config.command[0] if config.command else "",
            "args": list(config.command[1:]),
            "env": config.env,
            "default_purposes": config.default_purposes,
            "capability_purpose_override": config.capability_purpose_override,
            "timeout_per_call_sec": config.timeout_per_call_sec,
            "connect_timeout_sec": config.connect_timeout_sec,
        }
    return {
        "url": config.url,
        "headers": config.headers,
        "default_purposes": config.default_purposes,
        "capability_purpose_override": config.capability_purpose_override,
        "timeout_per_call_sec": config.timeout_per_call_sec,
        "connect_timeout_sec": config.connect_timeout_sec,
        "trust_env": config.trust_env,
    }
