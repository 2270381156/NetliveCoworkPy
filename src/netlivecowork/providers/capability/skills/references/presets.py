"""ProfileSkillPresetReconciler —— 把 profile 声明的预置 skill 协调进引用库。

协调是**纯的期望状态计算 + 一次原子提交**：先在内存里算出"这些 profile 现在想要
哪些引用绑定"，再和账本里上一次的绑定做差量，最后通过 ``SkillReferenceStore.mutate``
把引用与账本在同一次 ``Path.replace`` 里落盘。协调过程**不访问网络**——profile 携带
完整的 L1 元数据，ZIP 仍是在实际使用时临时下载。

职责边界：

  * 协调器只动 **preset binding**（哪些 profile 把这条引用带进来的），不碰用户的
    ``manual_labels``；有效归属 = manual ∪ preset。
  * 用户删除写 **opt-out**（profile/身份/用户三元组），普通启动不复活；
    重新手工引用清掉匹配的 opt-out。
  * 共享来源（cowork）principal="*"，谁登录都协调同一份；按用户来源（mythos）
    principal=W3 用户名，**未登录不动**——那是别的账号的数据，不是"该回收的"。

账本（``preset_ledger``）与引用同住 ``skill_references.json`` 根对象（见 store），
键为 binding 元组的稳定串。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Iterable, Protocol, Sequence

from ..adapters.scopes import GENERAL_SCOPE
from .store import (
    ANY_LABEL,
    ANY_PRINCIPAL,
    ReferenceIdentity,
    SkillReference,
    SkillReferenceStore,
    _clean_labels,
)

logger = logging.getLogger(__name__)


class PresetSpec(Protocol):
    """一条预置声明的形状（结构化鸭子类型）。

    真实实现是 ``cowork.manifest.SkillPreset``，但本模块**不 import 它**——
    依赖规则 D1：providers 不认识 cowork，装配层把解析好的对象喂进来。
    """

    source: str
    remote_id: str
    name: str
    description: str
    version: str
    triggers: Sequence[str]


class PresetProfile(Protocol):
    """reconcile 入参里"一个已装 profile"的形状（同上，鸭子类型）。"""

    id: str
    skill_presets: Sequence[PresetSpec]


@dataclass(frozen=True)
class ResolvedPreset:
    """一条解析完成的预置：profile、身份与 L1 元数据。"""

    profile_id: str
    identity: ReferenceIdentity
    name: str
    description: str
    version: str
    triggers: tuple[str, ...]


@dataclass(frozen=True)
class ReconcileResult:
    added: int = 0
    updated: int = 0
    removed: int = 0
    changed: bool = False


def _binding_key(profile_id: str, reference_id: str, principal: str) -> str:
    return "\0".join((profile_id, reference_id, principal))


def _binding_record(preset: ResolvedPreset) -> dict:
    return {
        "profile_id": preset.profile_id,
        "reference_id": preset.identity.reference_id,
        "principal": preset.identity.principal,
        "source": preset.identity.source,
    }


class ProfileSkillPresetReconciler:
    """profile 预置 → 引用库的差量协调器（见模块 docstring 的职责边界）。"""

    def __init__(
        self,
        store: SkillReferenceStore,
        scope_resolver: Callable[[str, str], str | None],
        per_user_sources: set[str],
    ) -> None:
        self._store = store
        self._scope_resolver = scope_resolver
        self._per_user_sources = set(per_user_sources)

    # ── 协调 ────────────────────────────────────────────────────────────────────

    def reconcile(self, profiles: Sequence[PresetProfile], username: str = "") -> ReconcileResult:
        """把期望绑定落到引用库。``username`` 为空表示尚未登录：只协调共享来源。

        写入失败（OSError）保持旧状态并返回未变更——启动不许因为这个死掉，
        下一次协调会重试（设计：异常处理）。
        """
        desired = self._resolve(profiles, username)
        try:
            return self._store.mutate(lambda root: self._apply(root, desired, username))
        except OSError:
            logger.warning("profile 预置协调提交失败，保持旧状态，下次协调重试", exc_info=True)
            return ReconcileResult()

    def _resolve(self, profiles: Sequence[PresetProfile], username: str) -> list[ResolvedPreset]:
        """解析期望绑定。**在打开事务之前完成**——解析失败只影响它自己那一条。"""
        out: list[ResolvedPreset] = []
        seen: set[tuple[str, str]] = set()
        for cow in profiles:
            for preset in cow.skill_presets:
                scope = self._resolve_scope(cow.id, preset)
                if scope is None:
                    continue
                if preset.source in self._per_user_sources:
                    if not (username or "").strip():
                        continue   # 按用户来源：等拿到 W3 用户名再协调
                    principal = username.strip()
                else:
                    principal = ANY_PRINCIPAL
                identity = ReferenceIdentity(scope, preset.source, preset.remote_id, principal)
                key = (cow.id, identity.reference_id)
                if key in seen:
                    continue
                seen.add(key)
                out.append(ResolvedPreset(
                    profile_id=cow.id,
                    identity=identity,
                    name=preset.name,
                    description=preset.description,
                    version=preset.version,
                    triggers=preset.triggers,
                ))
        return out

    def _resolve_scope(self, profile_id: str, preset: PresetSpec) -> str | None:
        try:
            scope = self._scope_resolver(profile_id, preset.source)
        except Exception:
            logger.warning(
                "cowork：skills.presets[%s/%s:%s] 市场作用域解析出错，跳过",
                profile_id, preset.source, preset.remote_id, exc_info=True,
            )
            return None
        if scope is None:
            # H3：配了市场的 profile 不跨市场回落；这个来源在它的有效作用域里解析不了。
            logger.warning(
                "cowork：skills.presets[%s/%s:%s] 在有效市场作用域里解析不了，跳过",
                profile_id, preset.source, preset.remote_id,
            )
        return scope

    def _manages(self, binding: dict, username: str) -> bool:
        """这条绑定归不归本次协调管。

        共享来源归每次协调；按用户来源只归**同用户且已登录**的那次——
        没登录就去动按用户的绑定，等于替别的账号回收数据。
        """
        if binding.get("source") in self._per_user_sources:
            u = (username or "").strip()
            return bool(u) and binding.get("principal") == u
        return binding.get("principal") == ANY_PRINCIPAL

    def _apply(self, root: dict, desired: list[ResolvedPreset], username: str) -> ReconcileResult:
        refs: dict = root["references"]
        ledger: dict = root["preset_ledger"]
        active: dict = ledger["active_bindings"]
        opt_outs: list = ledger["opt_outs"]

        def is_opted_out(preset: ResolvedPreset) -> bool:
            rid = preset.identity.reference_id
            return any(
                o.get("reference_id") == rid
                and o.get("profile_id") == preset.profile_id
                and o.get("principal") == preset.identity.principal
                for o in opt_outs
            )

        desired_keys = {_binding_key(p.profile_id, p.identity.reference_id, p.identity.principal)
                        for p in desired}

        added = updated = removed = 0

        # 1) 回收：上次有、这次不想要了（且归本次协调管）的绑定。
        for bkey, binding in list(active.items()):
            if bkey in desired_keys or not self._manages(binding, username):
                continue
            del active[bkey]
            removed += 1
            rid = binding["reference_id"]
            rec = refs.get(rid)
            if rec is None:
                continue
            bindings = [b for b in rec.get("preset_bindings") or [] if b != binding["profile_id"]]
            rec["preset_bindings"] = bindings
            if not bindings and not (rec.get("manual_labels") or []):
                del refs[rid]   # 无人认领（无手工归属、无其他绑定）才删

        # 2) 播种/刷新：这次想要的绑定。
        for preset in desired:
            if is_opted_out(preset):
                continue   # 用户删过 → 不复活
            rid = preset.identity.reference_id
            bkey = _binding_key(preset.profile_id, rid, preset.identity.principal)
            rec = refs.get(rid)
            if rec is None:
                refs[rid] = SkillReference(
                    identity=preset.identity,
                    name=preset.name,
                    description=preset.description,
                    triggers=list(preset.triggers),
                    skill_version=preset.version or None,
                    preset_bindings=(preset.profile_id,),
                ).to_dict()
                active[bkey] = _binding_record(preset)
                added += 1
                continue

            existing = SkillReference.from_dict(rec)
            changed_meta = (
                existing.name != preset.name
                or (existing.description or "") != preset.description
                or (preset.version and (existing.skill_version or "") != preset.version)
                or (preset.triggers and tuple(existing.triggers) != tuple(preset.triggers))
            )
            bindings = list(existing.preset_bindings)
            if preset.profile_id not in bindings:
                bindings.append(preset.profile_id)
            if changed_meta or bindings != list(existing.preset_bindings):
                refs[rid] = SkillReference(
                    identity=existing.identity,
                    name=preset.name or existing.name,
                    description=preset.description or existing.description,
                    triggers=list(preset.triggers or existing.triggers),
                    skill_version=preset.version or existing.skill_version,
                    referenced_at=existing.referenced_at,
                    manual_labels=existing.manual_labels,
                    preset_bindings=tuple(bindings),
                ).to_dict()
                updated += 1
            active[bkey] = _binding_record(preset)

        return ReconcileResult(added=added, updated=updated, removed=removed,
                               changed=bool(added or updated or removed))

    # ── 用户操作（API 与市场服务调用）─────────────────────────────────────────

    def user_delete(self, reference_id: str) -> bool:
        """用户删除一条引用：先为它的 active preset bindings 写 opt-out，再删。

        opt-out 落在 (profile, reference_id, principal) 三元组上——profile 以后
        重新加回这条预置也不会复活，直到用户重新手工引用。
        """
        def fn(root: dict) -> bool:
            refs: dict = root["references"]
            rec = refs.get(reference_id)
            if rec is None:
                return False
            principal = rec.get("principal") or ANY_PRINCIPAL
            source = rec.get("source") or ""
            ledger: dict = root["preset_ledger"]
            opt_outs: list = ledger["opt_outs"]
            for pid in rec.get("preset_bindings") or []:
                entry = {"profile_id": pid, "reference_id": reference_id,
                         "principal": principal, "source": source}
                if not any(
                    o.get("profile_id") == pid
                    and o.get("reference_id") == reference_id
                    and o.get("principal") == principal
                    for o in opt_outs
                ):
                    opt_outs.append(entry)
            del refs[reference_id]
            ledger["active_bindings"] = {
                k: b for k, b in ledger["active_bindings"].items()
                if b.get("reference_id") != reference_id
            }
            return True

        return self._store.mutate(fn)

    def user_reference(self, ref: SkillReference, profile_id: str | None) -> str:
        """用户从市场手工引用：清掉匹配的 opt-out，恢复为用户主动引用。"""
        rid = ref.identity.reference_id

        def fn(root: dict) -> str:
            refs: dict = root["references"]
            ledger: dict = root["preset_ledger"]
            ledger["opt_outs"] = [
                o for o in ledger["opt_outs"]
                if not (o.get("reference_id") == rid
                        and o.get("principal") == ref.identity.principal)
            ]
            existing = refs.get(rid)
            if existing is not None:
                prev = SkillReference.from_dict(existing)
                manual = tuple(set(prev.manual_labels) | set(ref.manual_labels))
                refs[rid] = SkillReference(
                    identity=ref.identity,
                    name=ref.name or prev.name,
                    description=ref.description if ref.description is not None else prev.description,
                    triggers=list(ref.triggers or prev.triggers),
                    skill_version=ref.skill_version or prev.skill_version,
                    referenced_at=ref.referenced_at or prev.referenced_at,
                    manual_labels=manual or (ANY_LABEL,),
                    preset_bindings=prev.preset_bindings,
                ).to_dict()
            else:
                refs[rid] = SkillReference(
                    identity=ref.identity,
                    name=ref.name,
                    description=ref.description,
                    triggers=list(ref.triggers),
                    skill_version=ref.skill_version,
                    referenced_at=ref.referenced_at,
                    manual_labels=ref.manual_labels or (ANY_LABEL,),
                ).to_dict()
            return rid

        return self._store.mutate(fn)

    def user_set_labels(self, reference_id: str, labels: Iterable[str]) -> bool:
        """用户改归属：写 manual_labels；被移除的 preset binding 同步 opt-out，
        下次协调不得悄悄加回——否则并集语义下用户永远移除不掉预置归属。"""
        new_labels = _clean_labels(labels)

        def fn(root: dict) -> bool:
            refs: dict = root["references"]
            rec = refs.get(reference_id)
            if rec is None:
                return False
            existing = SkillReference.from_dict(rec)
            keep = [pid for pid in existing.preset_bindings if pid in new_labels]
            dropped = [pid for pid in existing.preset_bindings if pid not in new_labels]
            ledger: dict = root["preset_ledger"]
            if dropped:
                principal = existing.identity.principal
                for pid in dropped:
                    entry = {"profile_id": pid, "reference_id": reference_id,
                             "principal": principal, "source": existing.identity.source}
                    if not any(
                        o.get("profile_id") == pid
                        and o.get("reference_id") == reference_id
                        and o.get("principal") == principal
                        for o in ledger["opt_outs"]
                    ):
                        ledger["opt_outs"].append(entry)
                ledger["active_bindings"] = {
                    k: b for k, b in ledger["active_bindings"].items()
                    if not (b.get("reference_id") == reference_id
                            and b.get("profile_id") in dropped)
                }
            refs[reference_id] = SkillReference(
                identity=existing.identity,
                name=existing.name,
                description=existing.description,
                triggers=list(existing.triggers),
                skill_version=existing.skill_version,
                referenced_at=existing.referenced_at,
                manual_labels=new_labels,
                preset_bindings=tuple(keep),
            ).to_dict()
            return True

        return self._store.mutate(fn)


def resolve_profile_preset_scope(profile_id: str, source: str, settings: object) -> str | None:
    """预置作用域解析的默认包装：作用域数据来自 ``market_scopes``（Task 4 接入）。"""
    from ..adapters import registry as market_registry
    scopes = market_registry.market_scopes(settings)
    return effective_scope_id(scopes, profile_id, source)


def effective_scope_id(
    scopes: Sequence[object], profile_id: str | None, source: str,
) -> str | None:
    """从已构建的作用域数据里选有效作用域。**只做数据选择，不构造 adapter**。

    规则（H3：配了市场不跨市场回落）：

      * 没有 profile_id → general 配了该 source 才 general，否则 None；
      * profile 有独立作用域 → 配了该 source 才用它；没配这个 source 就 None
        （不许静默回落通用——用户以为引的是专属 skill，实际是通用那一份）；
      * profile 没配市场 → 整体回落 general（同样要求 general 配了该 source）；
      * 地址相同的 profile 被合并进保留作用域（``profile_ids``）→ 解析到那个
        保留作用域的 ID（可能是 general，也可能是另一个 profile）。
    """
    from ..adapters.scopes import MarketScope

    general = next((s for s in scopes if s.id == GENERAL_SCOPE), None)

    def has_source(scope: MarketScope) -> bool:
        if source == "cowork":
            return bool(scope.cowork_url)
        if source == "mythos":
            return bool(scope.mythos_url)
        return False

    if not profile_id:
        return GENERAL_SCOPE if general is not None and has_source(general) else None

    merged = next((s for s in scopes if profile_id in (s.profile_ids or ())), None)
    if merged is not None:
        return merged.id if has_source(merged) else None

    own = next((s for s in scopes if s.id == profile_id), None)
    if own is not None:
        return own.id if has_source(own) else None

    # 没有自己的作用域：整体回落通用（两个源都没配才会走到这）。
    return GENERAL_SCOPE if general is not None and has_source(general) else None
