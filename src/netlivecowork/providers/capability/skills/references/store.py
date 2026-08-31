"""SkillReferenceStore — 云端市场 skill 的「引用」持久化（引用式加载）。

Layout: ``<data_dir>/skill_references.json``
Format::

    {
      "version": 2,
      "references": {
        "<source>:<remote_id>": {
          "source": "cowork" | "mythos",
          "remote_id": "...",
          "name": "...",
          "description": "..." | null,
          "triggers": [ ... ],
          "skill_version": "..." | null,
          "owner": "<username>" | null,   # 仅 mythos：引用者，用于列表按当前用户过滤
          "referenced_at": "<iso>" | null
        }
      }
    }

只存元数据（Level 1）+ source/remote_id + owner，**不存 skill 内容**。内容在运行时
按需下载到临时目录、用完即删（见 ReferencedSkillCapabilityProvider）。

与旧的 ``skill_pull_config.json`` / ``SkillPullStore``（存「已解压的本地文件夹」）是
两个文件、两套机制；旧记录由迁移逻辑一次性转成引用（见 migrate_pulled_to_references）。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

_VERSION = 2

#: 通配标签：这条记录谁都能用。
#:
#: **用通配而不是把当前所有 cowork 枚举进去**：将来新增一个 cowork 时通用 skill 应当
#: 自动对它可用；枚举的话得回头补每一条，而漏补的表现是"新 cowork 少了几个通用 skill"，
#: 没人会立刻发现。
ANY_LABEL = "*"


def _labels_of(v: object) -> tuple[str, ...]:
    """读归属标签。**缺失或为空一律读成通配**（理由见 SkillReference.labels）。"""
    if not isinstance(v, (list, tuple)):
        return (ANY_LABEL,)
    out = tuple(s.strip() for s in (str(x) for x in v) if s.strip())
    return out or (ANY_LABEL,)


def _compose_key(source: str, remote_id: str) -> str:
    return f"{source}:{remote_id}"


@dataclass
class SkillReference:
    source: str                       # "cowork" | "mythos"
    remote_id: str
    name: str
    description: str | None = None
    triggers: list[str] = field(default_factory=list)
    skill_version: str | None = None
    owner: str | None = None          # 仅 mythos：引用者用户名（列表按当前用户过滤用）
    referenced_at: str | None = None
    #: 归属标签。**这一层不认识 cowork** —— 存的是一组不透明字符串，
    #: 由调用方决定它们是什么意思（见 list_owned）。
    #:
    #: 缺省 ``("*",)`` = 谁都能用。存量记录没有这个字段，读成"谁都能用"才是它们此前的
    #: 实际行为；读成"谁都不能用"会让用户已有的 skill 在升级后一夜之间全部消失。
    #: 空数组同样读成 ``("*",)``：那种记录毫无意义，多半是写入侧的 bug 而非用户意图。
    labels: tuple[str, ...] = ("*",)

    @property
    def key(self) -> str:
        return _compose_key(self.source, self.remote_id)

    @staticmethod
    def from_dict(d: dict) -> "SkillReference":
        return SkillReference(
            source=str(d.get("source", "")),
            remote_id=str(d.get("remote_id", "")),
            name=str(d.get("name", "")),
            description=d.get("description"),
            triggers=list(d.get("triggers") or []),
            skill_version=d.get("skill_version"),
            owner=d.get("owner"),
            referenced_at=d.get("referenced_at"),
            labels=_labels_of(d.get("labels")),
        )


class SkillReferenceStore:
    def __init__(self, data_dir: Path) -> None:
        self._dir = Path(data_dir)

    def _path(self) -> Path:
        return self._dir / "skill_references.json"

    def _load(self) -> dict:
        path = self._path()
        if not path.exists():
            return {"version": _VERSION, "references": {}, "seeded_defaults": []}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"version": _VERSION, "references": {}, "seeded_defaults": []}
        data.setdefault("references", {})
        data.setdefault("seeded_defaults", [])
        return data

    def _save(self, data: dict) -> None:
        data["version"] = _VERSION
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path())

    # ── 写 ─────────────────────────────────────────────────────────────────────

    def add_reference(self, ref: SkillReference) -> None:
        """新增/更新一条引用（按 <source>:<remote_id> upsert）。"""
        data = self._load()
        data["references"][ref.key] = asdict(ref)
        self._save(data)

    def remove_reference(self, source: str, remote_id: str) -> None:
        data = self._load()
        key = _compose_key(source, remote_id)
        if key in data["references"]:
            del data["references"][key]
            self._save(data)

    # ── 默认引用 seed 记录（"补一次即止"）─────────────────────────────────────────
    # 记录哪些默认 key 曾被 seed 过。已记录的即使用户删了也不再补（删了=不想要，尊重）；
    # 未记录的（升级带来的新默认项）才补。见 defaults.seed_default_references。

    def was_default_seeded(self, key: str) -> bool:
        return key in self._load().get("seeded_defaults", [])

    def mark_default_seeded(self, key: str) -> None:
        data = self._load()
        seeded = data.setdefault("seeded_defaults", [])
        if key not in seeded:
            seeded.append(key)
            self._save(data)

    # ── 读 ─────────────────────────────────────────────────────────────────────

    def list_references(self) -> list[SkillReference]:
        return [SkillReference.from_dict(v) for v in self._load()["references"].values()]

    def list_visible(self, username: str, per_user_sources: set[str]) -> list[SkillReference]:
        """按「当前登录用户」过滤后的引用列表。

        **哪些市场按人可见由调用方告知**（``per_user_sources``），本类不再自己判断。
        原先这里写死一句 ``if ref.source == "mythos"``，让一个读写 JSON 的类知道了三件
        它不该知道的事：这世上有个叫 mythos 的市场、那家按人分、别家不是。加第三家按人分
        的市场时得回来改它——**而漏改不报错，只是别人的 skill 出现在你的列表里**。

        规则本身没变：属于按人可见的市场、且 owner 非空、且 owner 不是当前用户 → 隐藏。
        owner 为空的老数据不隐藏（迁移遗留；真正取内容时仍用当前用户去下载，由那家按权限
        拦，不会泄露）。
        """
        cur = (username or "").strip()
        return [
            ref for ref in self.list_references()
            if not (ref.source in per_user_sources and ref.owner and ref.owner != cur)
        ]

    def list_owned(self, owned_labels: set[str], *, base: list["SkillReference"] | None = None
                   ) -> list["SkillReference"]:
        """按归属标签过滤。

        **这一层不认识 cowork**：它只做集合运算，不知道标签是 cowork id 还是别的什么。
        调用方把"这条会话拥有哪些标签"算好传进来。

        沿用本仓那次解耦的做法（可见性判断挪出持久化层）：上一版这里写死过一句
        ``if ref.source == "mythos"``，让一个读写 JSON 的类知道了三件它不该知道的事。
        加第三家时要回来改它，**而漏改不报错，只是别人的东西出现在你的列表里**。
        """
        refs = self.list_references() if base is None else base
        return [r for r in refs if ANY_LABEL in r.labels or (set(r.labels) & owned_labels)]

    def set_labels(self, source: str, remote_id: str, labels) -> None:
        """改一条记录的归属。"""
        data = self._load()
        key = _compose_key(source, remote_id)
        if key in data["references"]:
            data["references"][key]["labels"] = list(_labels_of(list(labels)))
            self._save(data)

    def get_reference(self, source: str, remote_id: str) -> SkillReference | None:
        raw = self._load()["references"].get(_compose_key(source, remote_id))
        return SkillReference.from_dict(raw) if raw else None

    def is_referenced(self, source: str, remote_id: str) -> bool:
        return _compose_key(source, remote_id) in self._load()["references"]
