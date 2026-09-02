"""随包默认引用的 v2→v3 迁移与防复活。

关键保证：**用户删过的随包默认引用，升级后不得复活**。v2 的防复活账本按
``source:remote_id`` 记账，v3 引用键换成不透明 hash 后两边对不上——迁移必须把
旧账本换算成稳定的 bundled-default seed ID，否则 `was_default_seeded` 恒为 False，
每个删过的默认引用都会在升级后的第一次启动被重新播种。
"""
from __future__ import annotations

import json

from netlivecowork.providers.capability.skills.adapters.scopes import GENERAL_SCOPE
from netlivecowork.providers.capability.skills.references.defaults import (
    prune_null_references,
    seed_default_references,
)
from netlivecowork.providers.capability.skills.references.store import (
    ReferenceIdentity,
    SkillReference,
    SkillReferenceStore,
    bundled_default_seed_id,
)


def _write_store(tmp_path, payload: dict) -> SkillReferenceStore:
    (tmp_path / "skill_references.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )
    return SkillReferenceStore(tmp_path)


def _default_file(tmp_path, refs: dict) -> object:
    p = tmp_path / "skill_references.default.json"
    p.write_text(json.dumps({"version": 2, "references": refs}), encoding="utf-8")
    return p


def _bundled(remote_id: str = "9", **over) -> dict:
    d = {
        "source": "cowork",
        "remote_id": remote_id,
        "name": "Bundled",
        "description": "Bundled default",
        "triggers": [],
        "skill_version": "1.0",
        "owner": None,
        "referenced_at": None,
    }
    d.update(over)
    return d


def test_deleted_bundled_default_does_not_reappear_after_v2_to_v3(tmp_path):
    """引用不在（用户删了）但 v2 账本记得 seed 过 → 不复活。"""
    store = _write_store(tmp_path, {
        "version": 2,
        "references": {},
        "seeded_defaults": ["cowork:9"],
    })
    n = seed_default_references(_default_file(tmp_path, {"cowork:9": _bundled()}), store)
    assert store.list_references() == []
    assert n == 0


def test_bundled_default_still_seeds_when_never_seeded(tmp_path):
    """没 seed 过的（升级带来的新默认项）照常补上，记账落成 default:v3 形式。"""
    store = SkillReferenceStore(tmp_path)
    n = seed_default_references(_default_file(tmp_path, {"cowork:9": _bundled()}), store)
    assert n == 1
    refs = store.list_references()
    assert [r.name for r in refs] == ["Bundled"]
    assert refs[0].identity == ReferenceIdentity(GENERAL_SCOPE, "cowork", "9", "*")
    data = json.loads((tmp_path / "skill_references.json").read_text(encoding="utf-8"))
    assert data["seeded_defaults"] == [bundled_default_seed_id("cowork", "9")]


def test_seed_ledger_uses_stable_id_independent_of_reference_hash(tmp_path):
    """seed ID 只由 (source, remote_id) 决定，与引用 hash 解耦：
    引用键换算法不动账本，账本加字段不惊动引用。"""
    sid = bundled_default_seed_id("cowork", "9")
    assert sid.startswith("default:v3:")
    assert sid == bundled_default_seed_id("cowork", "9")
    assert sid != bundled_default_seed_id("cowork", "10")
    assert sid != ReferenceIdentity(GENERAL_SCOPE, "cowork", "9", "*").reference_id


def test_seeding_refreshes_only_the_exact_general_identity(tmp_path):
    """碰撞回归：库里同时有 general 和 scoped 同 source/remote_id 时，
    播种只回填精确的 general 那条——不抛歧义 ValueError、不动 scoped 那条。"""
    scoped = SkillReference(
        identity=ReferenceIdentity("ipmaster", "cowork", "9"),
        name="scoped-copy", description="scoped desc",
    )
    general = SkillReference(
        identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "9"),
        name="old-name", description=None,
    )
    store = SkillReferenceStore(tmp_path)
    store.add_reference(scoped)
    store.add_reference(general)

    n = seed_default_references(_default_file(tmp_path, {"cowork:9": _bundled()}), store)
    assert n == 1  # 只回填了 general 那条的元数据

    by_scope = {r.identity.market_scope: r for r in store.list_references()}
    assert by_scope["general"].description == "Bundled default"
    assert by_scope["ipmaster"].description == "scoped desc"   # scoped 原样


def test_prune_null_references_removes_by_exact_identity(tmp_path):
    """prune 按各自的精确 ID 删除：同名对不炸（不抛歧义）、不误删另一条。"""
    store = SkillReferenceStore(tmp_path)
    store.add_reference(SkillReference(
        identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "9"), name="g", description=None,
    ))
    store.add_reference(SkillReference(
        identity=ReferenceIdentity("ipmaster", "cowork", "9"), name="s", description="keep",
    ))
    n = prune_null_references(store)
    assert n == 1
    left = {r.identity.market_scope: r.name for r in store.list_references()}
    assert left == {"ipmaster": "s"}


def test_v2_seed_ledger_entries_convert_on_load(tmp_path):
    """v2 账本条目读进来就换算成 seed ID；认不出格式的原样保留，不丢账。"""
    store = _write_store(tmp_path, {
        "version": 2,
        "references": {},
        "seeded_defaults": ["cowork:9", "weird-entry", "mythos:3"],
    })
    assert store.was_default_seeded(bundled_default_seed_id("cowork", "9"))
    assert store.was_default_seeded(bundled_default_seed_id("mythos", "3"))
    assert store.was_default_seeded("weird-entry")
