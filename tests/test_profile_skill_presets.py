"""ProfileSkillPresetReconciler —— profile 预置引用的协调生命周期。

协调器是纯的期望状态计算 + 一次原子提交：输入已装 profiles、当前用户与引用库，
输出新状态。这里的用例把设计文档的生命周期规则逐条钉死：

  * 新预置 → 建引用 + 绑定；元数据来自 profile（L1），不访问网络。
  * 用户删除（opt-out）→ 普通启动不复活；重新手工引用 → 清 opt-out。
  * profile 减预置 / 被收回 → 只撤自己的绑定；引用无人认领才删。
  * mythos 按 W3 用户隔离（per-principal），cowork 共享（principal="*"）。
  * 未登录（username=""）不动按用户来源的绑定——那是别的账号的数据。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork.manifest import Cowork, SkillPreset
from netlivecowork.providers.capability.skills.adapters.scopes import GENERAL_SCOPE
from netlivecowork.providers.capability.skills.references.presets import (
    ProfileSkillPresetReconciler,
    ReconcileResult,
)
from netlivecowork.providers.capability.skills.references.store import (
    ANY_LABEL,
    ANY_PRINCIPAL,
    ReferenceIdentity,
    SkillReference,
    SkillReferenceStore,
)


def preset(name: str, *, source: str = "cowork", remote_id: str | None = None) -> SkillPreset:
    return SkillPreset(
        source=source,
        remote_id=remote_id or name,
        name=name,
        description=f"{name} 的预置描述",
        version="1.0",
        triggers=("t1",),
    )


def profile(pid: str, presets=()) -> Cowork:
    return Cowork(
        id=pid, version="1.0.0", order=10, display_name=pid,
        skill_presets=tuple(presets),
    )


def make_reconciler(tmp_path, *, scope_resolver=None, per_user_sources=frozenset()):
    store = SkillReferenceStore(tmp_path)
    resolver = scope_resolver or (lambda pid, source: pid if source == "cowork" else GENERAL_SCOPE)
    return ProfileSkillPresetReconciler(
        store=store, scope_resolver=resolver, per_user_sources=set(per_user_sources),
    ), store


def names(store: SkillReferenceStore) -> set[str]:
    return {r.name for r in store.list_references()}


# ── 新增与合并 ─────────────────────────────────────────────────────────────────

def test_new_preset_creates_binding_and_reference(tmp_path):
    r, store = make_reconciler(tmp_path)
    result = r.reconcile([profile("ipmaster", [preset("A")])])
    assert isinstance(result, ReconcileResult)
    assert (result.added, result.changed) == (1, True)

    refs = store.list_references()
    assert [x.name for x in refs] == ["A"]
    a = refs[0]
    assert a.identity == ReferenceIdentity("ipmaster", "cowork", "A", ANY_PRINCIPAL)
    assert a.preset_bindings == ("ipmaster",)
    assert a.manual_labels == ()
    assert a.effective_labels == ("ipmaster",)
    assert a.description == "A 的预置描述"

    # 账本记下了 active binding，且与引用同一份文件
    data = json.loads((tmp_path / "skill_references.json").read_text(encoding="utf-8"))
    assert len(data["preset_ledger"]["active_bindings"]) == 1

    # 幂等：再协调一次不重复
    again = r.reconcile([profile("ipmaster", [preset("A")])])
    assert (again.added, again.removed, again.changed) == (0, 0, False)
    assert len(store.list_references()) == 1


def test_multi_profile_preset_takes_union_of_bindings(tmp_path):
    r, store = make_reconciler(tmp_path, scope_resolver=lambda pid, source: "shared-scope")
    r.reconcile([profile("p1", [preset("A")]), profile("p2", [preset("A")])])
    a = store.list_references()[0]
    assert sorted(a.preset_bindings) == ["p1", "p2"]

    # p2 更新撤掉预置：只撤自己的绑定，p1 的还在
    r.reconcile([profile("p1", [preset("A")])])
    a = store.list_references()[0]
    assert a.preset_bindings == ("p1",)


def test_metadata_refresh_follows_new_profile_version(tmp_path):
    r, store = make_reconciler(tmp_path)
    r.reconcile([profile("ipmaster", [SkillPreset(
        source="cowork", remote_id="A", name="A", description="旧描述", version="1.0",
    )])])
    v2 = r.reconcile([profile("ipmaster", [SkillPreset(
        source="cowork", remote_id="A", name="A-新名字", description="新描述", version="2.0",
    )])])
    assert (v2.updated, v2.changed) == (1, True)
    a = store.list_references()[0]
    assert (a.name, a.description, a.skill_version) == ("A-新名字", "新描述", "2.0")


# ── opt-out：用户删除优先，普通启动不复活 ─────────────────────────────────────

def test_existing_user_opt_out_is_not_reseeded(tmp_path):
    r, store = make_reconciler(tmp_path)
    r.reconcile([profile("ipmaster", [preset("A")])])
    rid = store.list_references()[0].key

    assert r.user_delete(rid) is True
    assert store.list_references() == []

    # 普通启动（含登录后）不复活
    assert r.reconcile([profile("ipmaster", [preset("A")])]).changed is False
    assert store.list_references() == []


def test_readding_with_no_opt_out_seeds_again(tmp_path):
    """profile 先撤下预置（差量回收、无 opt-out），之后重新加回 → 重新播种。"""
    r, store = make_reconciler(tmp_path)
    r.reconcile([profile("ipmaster", [preset("A"), preset("B")])])
    r.reconcile([profile("ipmaster", [preset("A")])])       # B 被收回，无 opt-out
    assert names(store) == {"A"}

    r.reconcile([profile("ipmaster", [preset("A"), preset("B")])])   # B 回来了
    assert names(store) == {"A", "B"}


def test_manual_pull_clears_matching_opt_out(tmp_path):
    r, store = make_reconciler(tmp_path)
    r.reconcile([profile("ipmaster", [preset("A")])])
    rid = store.list_references()[0].key
    r.user_delete(rid)                                       # 用户删 → opt-out

    # 用户从市场重新手工引用同一身份 → opt-out 清除，恢复为用户主动引用
    identity = ReferenceIdentity("ipmaster", "cowork", "A", ANY_PRINCIPAL)
    manual = SkillReference(
        identity=identity, name="A", description="手工引用的元数据",
        manual_labels=(ANY_LABEL,),
    )
    assert r.user_reference(manual, profile_id=None) == rid
    assert store.get_by_id(rid) is not None

    # 现在 profile 的预置也重新挂上绑定（下次协调恢复）
    r.reconcile([profile("ipmaster", [preset("A")])])
    got = store.get_by_id(rid)
    assert got is not None and got.preset_bindings == ("ipmaster",)
    assert ANY_LABEL in got.manual_labels                    # 用户的手工归属保留


# ── 差量回收 ──────────────────────────────────────────────────────────────────

def test_profile_update_removes_only_its_binding(tmp_path):
    """v1 预置 A+B，v2 只留 A → B 的引用被删（无人认领），A 完好。"""
    r, store = make_reconciler(tmp_path)
    before = profile("ipmaster", [preset("A"), preset("B")])
    after = profile("ipmaster", [preset("A")])
    r.reconcile([before], username="alice")
    result = r.reconcile([after], username="alice")
    assert result.removed == 1
    assert names(store) == {"A"}


def test_profile_removal_keeps_manual_and_other_profile_bindings(tmp_path):
    r, store = make_reconciler(tmp_path, scope_resolver=lambda pid, source: "shared-scope")
    # B 同时被 p1 预置、又有用户手工归属（manual "*"）
    r.reconcile([profile("p1", [preset("A"), preset("B")]), profile("p2", [preset("B")])])
    b = next(x for x in store.list_references() if x.name == "B")
    store.set_manual_labels(b.key, [ANY_LABEL])

    # p1 整个被收回
    r.reconcile([profile("p2", [preset("B")])])
    b = next(x for x in store.list_references() if x.name == "B")
    assert b.preset_bindings == ("p2",)                      # p2 的绑定还在
    assert b.manual_labels == (ANY_LABEL,)                   # 手工归属保留
    assert names(store) == {"B"}                             # A 无人认领被删

    # 再把 B 的手工归属清掉、p2 也撤下 → B 才被删
    store.set_manual_labels(b.key, [])
    r.reconcile([])
    assert names(store) == set()


# ── per-principal 隔离 ────────────────────────────────────────────────────────

def test_mythos_state_is_separate_for_each_principal(tmp_path):
    r, store = make_reconciler(
        tmp_path,
        scope_resolver=lambda pid, source: GENERAL_SCOPE,
        per_user_sources={"mythos"},
    )
    profiles = [profile("ipmaster", [preset("M", source="mythos", remote_id="1129")])]

    # 未登录：不协调按用户来源的数据
    assert r.reconcile(profiles, username="").changed is False
    assert store.list_references() == []

    r.reconcile(profiles, username="alice")
    r.reconcile(profiles, username="bob")
    refs = {(x.identity.principal): x for x in store.list_references()}
    assert set(refs) == {"alice", "bob"}

    # alice 注销后再启动（username=""）→ bob 的数据原样保留
    r.reconcile([], username="")
    assert {x.identity.principal for x in store.list_references()} == {"alice", "bob"}

    # bob 登录、profile 撤下预置 → 只回收 bob 的
    r.reconcile([], username="bob")
    assert {x.identity.principal for x in store.list_references()} == {"alice"}


def test_cowork_state_uses_shared_principal(tmp_path):
    r, store = make_reconciler(
        tmp_path,
        scope_resolver=lambda pid, source: GENERAL_SCOPE,
        per_user_sources={"mythos"},
    )
    profiles = [profile("ipmaster", [preset("C")])]
    # 共享来源不挑用户：没登录也协调，principal="*"
    r.reconcile(profiles, username="")
    refs = store.list_references()
    assert [x.identity.principal for x in refs] == [ANY_PRINCIPAL]
    assert refs[0].identity.market_scope == GENERAL_SCOPE


def test_unresolvable_scope_is_skipped(tmp_path, caplog):
    """来源在 profile 的有效市场作用域里解析不了 → 跳过并记日志（H3：不跨市场回落）。"""
    r, store = make_reconciler(tmp_path, scope_resolver=lambda pid, source: None)
    with caplog.at_level("WARNING"):
        result = r.reconcile([profile("ipmaster", [preset("A")])])
    assert result.changed is False
    assert store.list_references() == []
    assert "preset" in caplog.text.lower()


# ── 原子性 ────────────────────────────────────────────────────────────────────

def test_store_failure_keeps_the_previous_complete_state(tmp_path, monkeypatch):
    r, store = make_reconciler(tmp_path)
    r.reconcile([profile("ipmaster", [preset("A")])])
    before = (tmp_path / "skill_references.json").read_text(encoding="utf-8")

    def boom(data):
        raise OSError("disk full")

    monkeypatch.setattr(store, "_save", boom)
    result = r.reconcile([profile("ipmaster", [preset("A"), preset("B")])])
    assert result.changed is False                          # 失败不算成功协调
    assert (tmp_path / "skill_references.json").read_text(encoding="utf-8") == before


def test_user_set_labels_opts_out_removed_preset_labels(tmp_path):
    """用户从归属里移除某个 preset binding 对应的 profile → 该 binding 写 opt-out，
    下次协调不得悄悄加回（否则并集语义下用户永远移除不掉预置归属）。"""
    r, store = make_reconciler(tmp_path, scope_resolver=lambda pid, source: "shared-scope")
    r.reconcile([profile("ipmaster", [preset("A")]), profile("p2", [preset("A")])])
    rid = store.list_references()[0].key
    assert sorted(store.get_by_id(rid).preset_bindings) == ["ipmaster", "p2"]

    # 用户只留 p2 → ipmaster 的 binding 被移除并 opt-out
    assert r.user_set_labels(rid, ["p2"]) is True
    got = store.get_by_id(rid)
    assert got.preset_bindings == ("p2",)
    assert got.manual_labels == ("p2",)

    # 下次协调不把 ipmaster 加回来
    r.reconcile([profile("ipmaster", [preset("A")]), profile("p2", [preset("A")])])
    got = store.get_by_id(rid)
    assert got.preset_bindings == ("p2",)
