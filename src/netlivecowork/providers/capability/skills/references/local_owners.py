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
    """本地 skill 的归属表。

    ## 为什么要认两个 key

    记录按 `skill_id` 存，而 `skill_id` 是**目录名**（services/local.py 那句
    `"skill_id": skill_dir.name`）。可运行期问过来的是**能力名**，也就是
    SKILL.md frontmatter 里的 `name`（`meta.name or 目录名`）。

    多数 skill 两者相同，直查就命中。但目录叫 a、文件里写 `name: b` 的那些，
    两边永远对不上：用户在技能中心明明勾了某个 cowork，agent 那边查不到记录，
    当成"通用"或"没有"——**而两边都不报错**。

    所以这里认两个 key：先直查（O(1)，覆盖绝大多数），对不上才建一次别名表。
    别名表按 skills 目录的 mtime 缓存——建它要解析每个 SKILL.md，
    放在热路径上每次都扫是不能接受的（能力清单每轮对话都要问一遍）。
    """

    def __init__(self, data_dir: Path, skills_dir: Path | None = None) -> None:
        self._dir = Path(data_dir)
        #: 解析别名用。不给就退化成"只认目录名"——老行为，不会更差。
        self._skills_dir = Path(skills_dir) if skills_dir else None
        self._alias: dict[str, str] = {}
        self._alias_stamp: object = None

    def _alias_map(self) -> dict[str, str]:
        """SKILL.md 里的 name → 目录名。按 skills 目录 mtime 缓存。"""
        if self._skills_dir is None:
            return {}
        try:
            stamp = self._skills_dir.stat().st_mtime_ns
        except OSError:
            return {}
        if stamp == self._alias_stamp:
            return self._alias
        out: dict[str, str] = {}
        try:
            from ctx_weft.providers.capability_skill_local._parser import load_skill_md

            for d in self._skills_dir.iterdir():
                if not d.is_dir() or not (d / "SKILL.md").exists():
                    continue
                try:
                    meta, _ = load_skill_md(d)
                except Exception:
                    continue
                name = (getattr(meta, "name", "") or "").strip()
                if name and name != d.name:
                    out[name] = d.name
        except OSError:
            return self._alias
        self._alias, self._alias_stamp = out, stamp
        return out

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
        data = self._load()
        if skill_id in data:                       # 绝大多数：目录名与 name 相同
            return _labels_of(data[skill_id])
        alias = self._alias_map().get(skill_id)    # 仅在对不上时才建表
        return _labels_of(data.get(alias)) if alias else ()

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
