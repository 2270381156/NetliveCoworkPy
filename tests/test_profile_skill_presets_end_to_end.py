"""profile 预置生命周期的端到端回归：真实清单解析 → 引用库 → 协调 → 列表 → 市场路由。

前面的测试各自钉一层（解析、存储、协调器、路由、接线）；这里把整条链串起来，
专测**层与层交界处**才会暴露的问题：profile 升级减预置时谁保留谁删除、
同名条目跨作用域的下载路由、随包默认播种与预置协调两套机制互不干扰。
"""
from __future__ import annotations

import asyncio
import io
import json
import zipfile
from pathlib import Path

from ctx_weft.protocols.context import ProviderContext

from netlivecowork.cowork.manifest_parse import read
from netlivecowork.providers.capability.skills.adapters.base import (
    MarketContext,
    MarketItem,
    SkillMarketAdapter,
)
from netlivecowork.providers.capability.skills.adapters.scopes import (
    GENERAL_SCOPE,
    build_scopes,
)
from netlivecowork.providers.capability.skills.provider import (
    ReferencedSkillCapabilityProvider,
)
from netlivecowork.providers.capability.skills.references.defaults import (
    seed_default_references,
)
from netlivecowork.providers.capability.skills.references.presets import (
    ProfileSkillPresetReconciler,
    effective_scope_id,
)
from netlivecowork.providers.capability.skills.references.store import (
    ReferenceIdentity,
    SkillReference,
    SkillReferenceStore,
)
from netlivecowork.providers.capability.skills.services.market import SkillMarketService


def _reconciler(tmp_path, per_cowork, general=("https://g", "")):
    """真实作用域解析（build_scopes + effective_scope_id）+ 真实引用库。"""
    store = SkillReferenceStore(tmp_path / "data")
    scopes = build_scopes(general[0], general[1], list(per_cowork))
    return ProfileSkillPresetReconciler(
        store=store,
        scope_resolver=lambda pid, source: effective_scope_id(scopes, pid, source),
        per_user_sources={"mythos"},
    ), store


def _write_profile(works: Path, cid: str, presets: list[dict]):
    d = works / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "cowork.json").write_text(json.dumps({
        "schema": 1, "id": cid, "version": "1.0.0",
        "branding": {"displayName": cid},
        "skills": {"pullServerUrl": "https://ip", "presets": presets},
    }, ensure_ascii=False), encoding="utf-8")
    parsed = read(d / "cowork.json")
    assert parsed is not None
    return parsed


def test_profile_v1_to_v2_reduces_presets_without_removing_user_owned_refs(tmp_path):
    """v1 预置 A+B → v2 只留 A：A 保持 profile 绑定；B 看归属——有手工归属就保留，
    手工归属也清掉才删除。整条链走真实的清单解析与引用库。"""
    r, store = _reconciler(tmp_path, [("ipmaster", "https://ip", "")])
    works = tmp_path / "coworks"
    preset_a = {"source": "cowork", "remoteId": "A", "name": "A", "description": "a"}
    preset_b = {"source": "cowork", "remoteId": "B", "name": "B", "description": "b"}

    v1 = _write_profile(works, "ipmaster", [preset_a, preset_b])
    assert r.reconcile([v1]).changed is True
    by_name = {x.name: x for x in store.list_references()}
    assert set(by_name) == {"A", "B"}
    assert by_name["A"].preset_bindings == ("ipmaster",)
    assert by_name["A"].identity.market_scope == "ipmaster"

    # 用户给 B 加了手工通配归属（存储层写法；UI 的勾选清单最终落在这里）
    store.set_manual_labels(by_name["B"].key, ["*"])

    v2 = _write_profile(works, "ipmaster", [preset_a])
    r.reconcile([v2])
    by_name = {x.name: x for x in store.list_references()}
    assert set(by_name) == {"A", "B"}, "B 有手工归属，profile 撤下预置不得连带删除"
    assert by_name["A"].preset_bindings == ("ipmaster",)
    assert by_name["B"].preset_bindings == ()

    # 用户把 B 的手工归属清空 → 按 H6 读作"通用"（一个都不勾 = 通用），引用保留
    store.set_manual_labels(by_name_key(store, "B").key, [])
    r.reconcile([v2])
    assert by_name_key(store, "B") is not None
    assert by_name_key(store, "B").effective_labels == ("*",)

    # 用户彻底删除这条**手工**引用（绑定已随 v2 退役，无 opt-out）→ 引用消失；
    # profile 后来重新加回预置时，按设计重新播种（没有 opt-out 就重新加入）。
    assert r.user_delete(by_name_key(store, "B").key) is True
    assert by_name_key(store, "B") is None
    r.reconcile([_write_profile(works, "ipmaster", [preset_a, preset_b])])
    b_again = by_name_key(store, "B")
    assert b_again is not None and b_again.preset_bindings == ("ipmaster",)

    # 删除**正在被预置绑定**的引用 → 写 opt-out，此后 profile 再怎么加也不复活。
    assert r.user_delete(b_again.key) is True
    r.reconcile([_write_profile(works, "ipmaster", [preset_a, preset_b])])
    assert {x.name for x in store.list_references()} == {"A"}


def by_name_key(store: SkillReferenceStore, name: str):
    return next((x for x in store.list_references() if x.name == name), None)


def test_same_remote_id_in_general_and_profile_market_routes_correctly(tmp_path):
    """同 source/remote_id 在通用与专属市场各是一条引用：两条并存、身份不同，
    运行时下载各回各的服务器（引用保存的 market_scope 是路由凭据）。"""
    r, store = _reconciler(
        tmp_path,
        [("ipmaster", "https://ip", "https://ip-m")],
        general=("https://g", "https://g-m"),
    )
    # 通用市场的手工引用（alice 引的）
    store.add_reference(SkillReference(
        identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "1129", "alice"),
        name="duo-general", description="from the general market",
        manual_labels=("*",),
    ))
    # profile 预置同一条目 → 专属作用域的另一条引用
    works = tmp_path / "coworks"
    v1 = _write_profile(works, "ipmaster", [{
        "source": "mythos", "remoteId": "1129",
        "name": "duo-scoped", "description": "from the ipmaster market",
    }])
    r.reconcile([v1], username="alice")

    refs = {x.identity.market_scope: x for x in store.list_references()}
    assert set(refs) == {GENERAL_SCOPE, "ipmaster"}
    assert refs[GENERAL_SCOPE].name == "duo-general"
    assert refs["ipmaster"].preset_bindings == ("ipmaster",)

    # 下载路由：两条内容不同，各自从自己的服务器下
    def _zip_named(name: str) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("SKILL.md", f"---\nname: {name}\ndescription: d\n---\n# zip-of-{name}\n")
        return buf.getvalue()

    class _Mythos(SkillMarketAdapter):
        name = "mythos"

        def __init__(self, payload: bytes):
            self.payload = payload

        def list_catalog(self, ctx: MarketContext) -> list[MarketItem]:
            return []

        def download_zip(self, remote_id: str, ctx: MarketContext) -> bytes:
            return self.payload

    svc = SkillMarketService(
        adapters=[_Mythos(_zip_named("duo-general"))], store=store,
        scoped_adapters=lambda cid: [_Mythos(_zip_named("duo-scoped"))],
    )
    provider = ReferencedSkillCapabilityProvider(
        store, svc, current_username_fn=lambda: "alice",
    )
    ctx = ProviderContext(session_id="e2e-scope")

    async def go():
        general_def = await provider.load_definition("duo-general", ctx)
        scoped_def = await provider.load_definition("duo-scoped", ctx)
        assert general_def is not None and "zip-of-duo-general" in general_def.instructions
        assert scoped_def is not None and "zip-of-duo-scoped" in scoped_def.instructions

    asyncio.run(go())


def test_deleted_bundled_default_stays_deleted_after_store_upgrade(tmp_path):
    """v2 账本记着 seed 过、引用不在（用户删了）→ 升级 + 正常播种 + 顺带跑一次预置协调，
    都不得让它复活。随包默认播种与 profile 预置协调是两套独立机制。"""
    data = tmp_path / "data"
    data.mkdir(parents=True)
    (data / "skill_references.json").write_text(json.dumps({
        "version": 2,
        "references": {},
        "seeded_defaults": ["cowork:9"],
    }), encoding="utf-8")
    default_file = tmp_path / "defaults.json"
    default_file.write_text(json.dumps({
        "version": 2,
        "references": {"cowork:9": {
            "source": "cowork", "remote_id": "9", "name": "Bundled",
            "description": "bundled default",
        }},
    }), encoding="utf-8")

    store = SkillReferenceStore(data)
    assert seed_default_references(default_file, store) == 0   # 不复活

    # 预置协调照常跑（机制独立），再播种一次仍不复活
    r, _ = _reconciler(tmp_path, [("ipmaster", "https://ip", "")])
    works = tmp_path / "coworks"
    r.reconcile([_write_profile(works, "ipmaster", [
        {"source": "cowork", "remoteId": "X", "name": "X", "description": "x"},
    ])])
    assert seed_default_references(default_file, store) == 0
    assert {x.name for x in store.list_references()} == {"X"}
