"""SkillReferenceStore — 云端市场 skill 的「引用」持久化（引用式加载）。

Layout: ``<data_dir>/skill_references.json``
Format (v3)::

    {
      "version": 3,
      "references": {
        "ref:v3:<sha256>": {
          "market_scope": "general" | "<cowork id>",
          "source": "cowork" | "mythos",
          "remote_id": "...",
          "principal": "*" | "<W3 username>",
          "name": "...",
          "description": "..." | null,
          "triggers": [ ... ],
          "skill_version": "..." | null,
          "referenced_at": "<iso>" | null,
          "manual_labels": [ ... ],     # 用户主动设置的归属
          "preset_bindings": [ ... ]    # profile 预置协调写入的归属
        }
      },
      "seeded_defaults": ["default:v3:<sha256>", ...],
      "preset_ledger": {"active_bindings": {}, "opt_outs": []}
    }

只存元数据（Level 1）+ 引用身份，**不存 skill 内容**。内容在运行时按需下载到
临时目录、用完即删（见 ReferencedSkillCapabilityProvider）。

身份是 ``(market_scope, source, remote_id, principal)`` 四元组：同一个 source 在
通用市场和不同 profile 专属市场指向不同服务器，按人可见的来源还因 W3 用户而异。
对外只暴露不透明 ``reference_id``，调用方不得拆 key 推断来源。

**引用、随包播种账本、profile 预置账本永远是同一个 JSON 根对象、同一次
``Path.replace``**：拆成两个文件就没有原子性可言，回收一半断电会留下
"引用删了、账本没删"的半完成状态。

v2 文件在读取时原地换算（``market_scope=general``、``owner→principal``、
``labels→manual_labels``、播种账本换算成稳定 seed ID），首次成功写入落成 v3。
换算只发生在内存里，迁移失败保留旧文件、用旧数据继续。
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, TypeVar

from ..adapters.scopes import GENERAL_SCOPE

logger = logging.getLogger(__name__)

_VERSION = 3

#: 通配标签：这条记录谁都能用。
#:
#: **用通配而不是把当前所有 cowork 枚举进去**：将来新增一个 cowork 时通用 skill 应当
#: 自动对它可用；枚举的话得回头补每一条，而漏补的表现是"新 cowork 少了几个通用 skill"，
#: 没人会立刻发现。
ANY_LABEL = "*"

#: 共享主体：cowork 这类谁都能用的来源不区分引用者。
ANY_PRINCIPAL = "*"

#: 引用 ID / 播种账本 ID 的前缀。前缀本身不含语义，只是让日志里一眼认得出代。
REF_ID_PREFIX = "ref:v3:"
SEED_ID_PREFIX = "default:v3:"

T = TypeVar("T")


def bundled_default_seed_id(source: str, remote_id: str) -> str:
    """随包默认播种账本的稳定 ID。

    **刻意与引用 hash 解耦**：旧账本编码不了 market_scope/principal，它的职责只是
    记住"某个随包默认项曾经 seed 过"。引用键换个算法不该惊动账本，反过来也一样。
    """
    raw = "\0".join((source, remote_id))
    return f"{SEED_ID_PREFIX}{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def _labels_of(v: object) -> tuple[str, ...]:
    """读归属标签。**缺失或为空一律读成通配**（v2 兼容；理由见 manual_labels）。"""
    if not isinstance(v, (list, tuple)):
        return (ANY_LABEL,)
    out = tuple(s.strip() for s in (str(x) for x in v) if s.strip())
    return out or (ANY_LABEL,)


def _clean_labels(labels: Iterable[str]) -> tuple[str, ...]:
    """清洗标签但**不通配化**：v3 里 manual_labels 为空是合法状态（preset-only 引用）。"""
    return tuple(s.strip() for s in (str(x) for x in labels) if s.strip())


@dataclass(frozen=True)
class ReferenceIdentity:
    """一条引用的身份：从哪个市场页签（scope）、哪家接口（source）、哪条 skill、谁的。

    同一 ``source + remote_id`` 在通用市场和 profile 专属市场是**不同的服务器**；
    按人可见的来源还因 W3 用户而异。四元组任何一个不同就是不同的引用。
    """

    market_scope: str
    source: str
    remote_id: str
    principal: str = ANY_PRINCIPAL

    @property
    def reference_id(self) -> str:
        raw = "\0".join((self.market_scope, self.source, self.remote_id, self.principal))
        return f"{REF_ID_PREFIX}{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


@dataclass
class SkillReference:
    identity: ReferenceIdentity
    name: str
    description: str | None = None
    triggers: list[str] = field(default_factory=list)
    skill_version: str | None = None
    referenced_at: str | None = None
    #: 用户主动设置的归属。**这一层不认识 cowork** —— 存的是一组不透明字符串，
    #: 由调用方决定它们是什么意思（见 list_owned）。
    #:
    #: v2 存量记录没有归属字段时读成 ``("*",)``：那才是它们此前的实际行为；
    #: 读成空会让用户已有的 skill 在升级后一夜之间全部消失。v3 记录里空是合法的
    #: （preset-only 引用），所以通配化只发生在 v2 换算那一处，读取 v3 不再做。
    manual_labels: tuple[str, ...] = ()
    #: profile 预置协调器写入的归属（哪些 profile 的 presets 把它带进来的）。
    #: 有效归属 = manual ∪ preset（见 effective_labels）；协调器只动自己的 binding，
    #: 不碰用户的 manual_labels。
    preset_bindings: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return self.identity.reference_id

    # ── v2 兼容读法（迁移窗口内逐步替换调用方）─────────────────────────────────

    @property
    def source(self) -> str:
        return self.identity.source

    @property
    def remote_id(self) -> str:
        return self.identity.remote_id

    @property
    def market_scope(self) -> str:
        return self.identity.market_scope

    @property
    def owner(self) -> str | None:
        """principal="*" 读成 None：共享来源没有引用者，list_visible 的老语义。"""
        return None if self.identity.principal == ANY_PRINCIPAL else self.identity.principal

    @property
    def labels(self) -> tuple[str, ...]:
        return self.effective_labels

    @property
    def effective_labels(self) -> tuple[str, ...]:
        """有效归属 = manual_labels ∪ preset_bindings；两边都空才回落通配。"""
        merged = set(self.manual_labels) | set(self.preset_bindings)
        return tuple(sorted(merged)) or (ANY_LABEL,)

    def to_dict(self) -> dict:
        return {
            "market_scope": self.identity.market_scope,
            "source": self.identity.source,
            "remote_id": self.identity.remote_id,
            "principal": self.identity.principal,
            "name": self.name,
            "description": self.description,
            "triggers": list(self.triggers),
            "skill_version": self.skill_version,
            "referenced_at": self.referenced_at,
            "manual_labels": list(self.manual_labels),
            "preset_bindings": list(self.preset_bindings),
        }

    @staticmethod
    def from_dict(d: dict) -> "SkillReference":
        if "market_scope" in d or "principal" in d or "manual_labels" in d:
            # v3 记录：字段照读，空 manual_labels 不通配化（preset-only 是合法状态）。
            identity = ReferenceIdentity(
                market_scope=str(d.get("market_scope") or GENERAL_SCOPE),
                source=str(d.get("source", "")),
                remote_id=str(d.get("remote_id", "")),
                principal=str(d.get("principal") or ANY_PRINCIPAL),
            )
            return SkillReference(
                identity=identity,
                name=str(d.get("name", "")),
                description=d.get("description"),
                triggers=list(d.get("triggers") or []),
                skill_version=d.get("skill_version"),
                referenced_at=d.get("referenced_at"),
                manual_labels=_clean_labels(d.get("manual_labels") or ()),
                preset_bindings=_clean_labels(d.get("preset_bindings") or ()),
            )
        # v2 记录：general 作用域；owner→principal；labels 缺失/空读通配（保持既有可见范围）。
        owner = d.get("owner")
        identity = ReferenceIdentity(
            market_scope=GENERAL_SCOPE,
            source=str(d.get("source", "")),
            remote_id=str(d.get("remote_id", "")),
            principal=str(owner) if owner else ANY_PRINCIPAL,
        )
        return SkillReference(
            identity=identity,
            name=str(d.get("name", "")),
            description=d.get("description"),
            triggers=list(d.get("triggers") or []),
            skill_version=d.get("skill_version"),
            referenced_at=d.get("referenced_at"),
            manual_labels=_labels_of(d.get("labels")),
        )


def _empty_ledger() -> dict:
    return {"active_bindings": {}, "opt_outs": []}


def _empty_root() -> dict:
    return {
        "version": _VERSION,
        "references": {},
        "seeded_defaults": [],
        "preset_ledger": _empty_ledger(),
    }


def _migrate_v2_root(data: dict) -> dict:
    """v2 根对象 → v3（内存里换算，不写回）。"""
    raw_refs = data.get("references")
    references: dict[str, dict] = {}
    if isinstance(raw_refs, dict):
        for rec in raw_refs.values():
            if not isinstance(rec, dict):
                continue
            ref = SkillReference.from_dict(rec)   # v2 分支做换算
            references[ref.identity.reference_id] = ref.to_dict()

    seeded: list[str] = []
    for entry in data.get("seeded_defaults") or []:
        s = str(entry)
        if s.startswith(SEED_ID_PREFIX):
            seeded.append(s)
        elif ":" in s:
            src, _, rid = s.partition(":")
            if src and rid:
                seeded.append(bundled_default_seed_id(src, rid))
            else:
                seeded.append(s)
        else:
            seeded.append(s)
        # 认不出的格式原样保留：丢账的表现是删过的默认项复活。
    return {
        "version": _VERSION,
        "references": references,
        "seeded_defaults": seeded,
        "preset_ledger": _empty_ledger(),
    }


class SkillReferenceStore:
    def __init__(self, data_dir: Path) -> None:
        self._dir = Path(data_dir)

    def _path(self) -> Path:
        return self._dir / "skill_references.json"

    def _load(self) -> dict:
        path = self._path()
        if not path.exists():
            return _empty_root()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("引用库 %s 读不了，按空库继续（下次写入会覆盖）", path, exc_info=True)
            return _empty_root()
        if not isinstance(data, dict):
            return _empty_root()
        if not isinstance(data.get("version"), int) or data["version"] < _VERSION:
            data = _migrate_v2_root(data)
        data.setdefault("references", {})
        data.setdefault("seeded_defaults", [])
        ledger = data.setdefault("preset_ledger", {})
        if not isinstance(ledger, dict):
            data["preset_ledger"] = ledger = _empty_ledger()
        ledger.setdefault("active_bindings", {})
        ledger.setdefault("opt_outs", [])
        return data

    def _save(self, data: dict) -> None:
        data["version"] = _VERSION
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path())

    # ── 事务 ────────────────────────────────────────────────────────────────────

    def mutate(self, fn: Callable[[dict], T]) -> T:
        """一次原子事务：整份根（引用 + 两个账本）深拷贝后交给回调，成功才落盘。

        回调中途抛错 → 文件保持旧状态；引用与账本的修改要么都提交、都不提交。
        """
        data = self._load()
        working = copy.deepcopy(data)
        result = fn(working)
        self._save(working)
        return result

    # ── 写（按不透明 ID）───────────────────────────────────────────────────────

    def add_reference(self, ref: SkillReference) -> None:
        """新增/更新一条引用（按 reference_id upsert）。"""
        self.mutate(lambda d: d["references"].__setitem__(ref.key, ref.to_dict()))

    def remove_by_id(self, reference_id: str) -> None:
        self.mutate(lambda d: d["references"].pop(reference_id, None))

    def set_manual_labels(self, reference_id: str, labels: Iterable[str]) -> None:
        """改一条引用的用户归属（preset_bindings 不动）。"""
        def fn(data: dict) -> None:
            rec = data["references"].get(reference_id)
            if rec is not None:
                rec["manual_labels"] = list(_clean_labels(labels))
        self.mutate(fn)

    # ── 默认引用 seed 记录（"补一次即止"）─────────────────────────────────────────
    # 记录哪些随包默认项曾被 seed 过（**按 bundled_default_seed_id，不按引用键**）。
    # 已记录的即使用户删了也不再补（删了=不想要，尊重）；未记录的（升级带来的新默认项）
    # 才补。见 defaults.seed_default_references。

    def was_default_seeded(self, seed_id: str) -> bool:
        return seed_id in self._load().get("seeded_defaults", [])

    def mark_default_seeded(self, seed_id: str) -> None:
        def fn(data: dict) -> None:
            seeded = data.setdefault("seeded_defaults", [])
            if seed_id not in seeded:
                seeded.append(seed_id)
        self.mutate(fn)

    # ── 写（旧式 source+remote_id，迁移窗口内的兼容；遇歧义大声失败）────────────

    def _find_ids(self, source: str, remote_id: str) -> list[str]:
        want = (str(source), str(remote_id))
        return [
            rid for rid, rec in self._load()["references"].items()
            if (rec.get("source"), rec.get("remote_id")) == want
        ]

    def _require_unique(self, source: str, remote_id: str) -> str | None:
        ids = self._find_ids(source, remote_id)
        if len(ids) > 1:
            raise ValueError(
                f"引用 '{source}:{remote_id}' 在 {len(ids)} 个市场作用域里都存在，"
                f"旧式按 source+remote_id 的查找无法区分；请改用 reference_id：{ids}"
            )
        return ids[0] if ids else None

    def remove_reference(self, source: str, remote_id: str) -> None:
        rid = self._require_unique(source, remote_id)
        if rid is not None:
            self.remove_by_id(rid)

    def set_labels(self, source: str, remote_id: str, labels) -> None:
        """改一条记录的归属（旧式入口，兼容期内 API 路由还在用）。"""
        rid = self._require_unique(source, remote_id)
        if rid is not None:
            self.set_manual_labels(rid, labels)

    # ── 读 ─────────────────────────────────────────────────────────────────────

    def list_references(self) -> list[SkillReference]:
        return [SkillReference.from_dict(v) for v in self._load()["references"].values()]

    def get_by_id(self, reference_id: str) -> SkillReference | None:
        raw = self._load()["references"].get(reference_id)
        return SkillReference.from_dict(raw) if raw else None

    def get_reference(self, source: str, remote_id: str) -> SkillReference | None:
        rid = self._require_unique(source, remote_id)
        return self.get_by_id(rid) if rid else None

    def is_referenced(self, source: str, remote_id: str) -> bool:
        return bool(self._find_ids(source, remote_id))

    def list_visible(self, username: str, per_user_sources: set[str]) -> list[SkillReference]:
        """按「当前登录用户」过滤后的引用列表。

        **哪些市场按人可见由调用方告知**（``per_user_sources``），本类不再自己判断。
        原先这里写死一句 ``if ref.source == "mythos"``，让一个读写 JSON 的类知道了三件
        它不该知道的事：这世上有个叫 mythos 的市场、那家按人分、别家不是。加第三家按人分
        的市场时得回来改它——**而漏改不报错，只是别人的 skill 出现在你的列表里**。

        规则本身没变：属于按人可见的市场、且 principal 非通配、且不是当前用户 → 隐藏。
        principal 通配的老数据不隐藏（迁移遗留；真正取内容时仍用当前用户去下载，由那家
        按权限拦，不会泄露）。
        """
        cur = (username or "").strip()
        return [
            ref for ref in self.list_references()
            if not (
                ref.source in per_user_sources
                and ref.identity.principal != ANY_PRINCIPAL
                and ref.identity.principal != cur
            )
        ]

    def list_owned(self, owned_labels: set[str], *, base: list["SkillReference"] | None = None
                   ) -> list["SkillReference"]:
        """按归属标签过滤。

        **这一层不认识 cowork**：它只做集合运算，不知道标签是 cowork id 还是别的什么。
        调用方把"这条会话拥有哪些标签"算好传进来。
        """
        refs = self.list_references() if base is None else base
        return [r for r in refs if ANY_LABEL in r.labels or (set(r.labels) & owned_labels)]
