"""SkillPullStore — records which marketplace skills have been pulled locally.

Layout: <data_dir>/skill_pull_config.json
Format: {"pulled": {"<source>:<remote_id>": "<local_folder>", ...}}

The key is namespaced by source ("cowork" / "mythos") because the two markets
can hand out colliding remote ids. Legacy entries written before multi-source
support had no prefix; they are migrated to the "cowork:" namespace on load
(cowork was the only source back then).
"""

from __future__ import annotations

import json
from pathlib import Path

_LEGACY_SOURCE = "cowork"


def _compose_key(source: str, remote_id: str) -> str:
    return f"{source}:{remote_id}"


class SkillPullStore:
    def __init__(self, data_dir: Path) -> None:
        self._dir = Path(data_dir)

    def _path(self) -> Path:
        return self._dir / "skill_pull_config.json"

    def _load(self) -> dict:
        path = self._path()
        if not path.exists():
            return {"pulled": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"pulled": {}}
        data.setdefault("pulled", {})
        # 迁移：无 "source:" 前缀的旧 key（多源支持之前写的）→ 归到 cowork 命名空间。
        migrated = {}
        for key, folder in data["pulled"].items():
            migrated[key if ":" in key else _compose_key(_LEGACY_SOURCE, key)] = folder
        data["pulled"] = migrated
        return data

    def _save(self, data: dict) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path())

    def record_pulled(self, source: str, remote_id: str, local_folder: str) -> None:
        data = self._load()
        data["pulled"][_compose_key(source, remote_id)] = local_folder
        self._save(data)

    def remove_pulled_by_folder(self, local_folder: str) -> None:
        data = self._load()
        to_delete = [k for k, v in data["pulled"].items() if v == local_folder]
        if not to_delete:
            return
        for k in to_delete:
            del data["pulled"][k]
        self._save(data)

    def get_pulled_map(self) -> dict[str, str]:
        """{"<source>:<remote_id>": "<local_folder>"} — keys are namespaced."""
        return self._load()["pulled"]

    def is_pulled(self, source: str, remote_id: str) -> bool:
        return _compose_key(source, remote_id) in self._load()["pulled"]
