"""本地导入 skill 的归属 —— 单独一份表。

市场引来的 skill 归属记在引用库里（那条记录本来就存在）；
**本地导入的没有引用记录**，所以另存一份 `local_skill_owners.json`。

    { "docx": ["*"], "my-tool": ["ipmaster", "mbb"] }

与引用库同一套语义：**存不透明标签，本模块不认识 cowork**；
缺失或为空读成通配（谁都能用）。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .store import ANY_LABEL, _labels_of

logger = logging.getLogger(__name__)

FILE_NAME = "local_skill_owners.json"


class LocalSkillOwners:
    def __init__(self, data_dir: Path) -> None:
        self._dir = Path(data_dir)

    def _path(self) -> Path:
        return self._dir / FILE_NAME

    def _load(self) -> dict[str, list[str]]:
        try:
            raw = json.loads(self._path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _save(self, data: dict) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path())

    def labels_of(self, skill_id: str) -> tuple[str, ...]:
        """这条本地 skill 归谁。**没记过就是通用**。

        存量 skill 一条记录都没有，读成通用才是它们此前的实际行为——
        读成"谁都不能用"会让用户已有的 skill 在升级后一夜之间全部消失。
        """
        return _labels_of(self._load().get(skill_id))

    def set_labels(self, skill_id: str, labels) -> None:
        data = self._load()
        data[skill_id] = list(_labels_of(list(labels)))
        self._save(data)

    def forget(self, skill_id: str) -> None:
        """删 skill 时顺手清掉，别留孤儿记录。"""
        data = self._load()
        if data.pop(skill_id, None) is not None:
            self._save(data)

    def visible_to(self, skill_id: str, owned_labels: set[str] | None) -> bool:
        """这条 skill 对拥有这些标签的会话可见吗。`None` = 不设限。"""
        if owned_labels is None:
            return True
        labels = self.labels_of(skill_id)
        return ANY_LABEL in labels or bool(set(labels) & owned_labels)
