"""cowork 自带的技能市场：页签、目录按页签取、引用的归属跟着页签走。

这一串的错都是**静默**的：页签少一个、目录下到另一家去、引用的归属落错——三样都不报错，
只表现为"某个 cowork 里多了或少了一个 skill"，而从现象反推回这里很难。所以逐条钉。
"""
from __future__ import annotations

import pytest

from netlivecowork.providers.capability.skills.adapters import registry as reg
from netlivecowork.providers.capability.skills.adapters.base import (
    VISIBILITY_PER_USER,
    MarketContext,
    MarketItem,
    SkillMarketAdapter,
)
from netlivecowork.providers.capability.skills.adapters.scopes import (
    GENERAL_SCOPE,
    build_scopes,
)
from netlivecowork.providers.capability.skills.references.presets import effective_scope_id
from netlivecowork.providers.capability.skills.references.store import (
    ReferenceIdentity,
    SkillReferenceStore,
)
from netlivecowork.providers.capability.skills.services.market import SkillMarketService


class _FakeAdapter(SkillMarketAdapter):
    name = "cowork"
    visibility = "all"

    def __init__(self, tag: str) -> None:
        self.tag = tag

    def list_catalog(self, ctx: MarketContext) -> list[MarketItem]:
        return [MarketItem(id=f"{self.tag}-1", name=f"skill-from-{self.tag}",
                           description="", updater="", create_time="2026-01-01")]

    def download_zip(self, remote_id: str, ctx: MarketContext) -> bytes:
        return f"zip:{self.tag}".encode()

    def import_to_remote(self, data: bytes, filename: str, ctx: MarketContext) -> dict:
        raise NotImplementedError


class _Store:
    """引用库替身：什么都没引用过。归属那几条用下面的 _RefStore。"""

    def __init__(self) -> None:
        self.added: list = []

    def is_referenced(self, source: str, remote_id: str) -> bool:
        return False

    def list_visible(self, username, per_user_sources):
        return []

    def list_owned(self, owned, *, base=None):
        return list(base or [])

    def add_reference(self, ref) -> None:
        self.added.append(ref)


@pytest.fixture
def no_injection():
    """每个用例自己注入，跑完撤掉——注入是进程级的，漏撤会串到别的用例。"""
    yield
    reg.install_cowork_markets(None)


# ── 页签 ─────────────────────────────────────────────────────────────────────


def test_no_injection_means_no_cowork_tabs(no_injection):
    """没有 cowork 这一层的构建：只有通用页签，一切照旧。"""
    assert reg.cowork_markets() == []


def test_tabs_come_from_the_injected_list(no_injection):
    reg.install_cowork_markets(lambda: [
        reg.CoworkMarket("ipmaster", "IPMaster Cowork", "", "https://m.example"),
    ])
    assert [(c.cowork_id, c.display_name) for c in reg.cowork_markets()] == [
        ("ipmaster", "IPMaster Cowork")
    ]


def test_a_broken_supplier_costs_a_tab_not_the_endpoint(no_injection, caplog):
    """名单取不到 → 少一个页签；**不能**让整个技能市场接口 500。"""
    def boom():
        raise RuntimeError("scope 还没装好")

    reg.install_cowork_markets(boom)
    assert reg.cowork_markets() == []


def test_markets_endpoint_puts_general_first(no_injection):
    from netlivecowork.api.skills import list_skill_markets

    reg.install_cowork_markets(lambda: [
        reg.CoworkMarket("ipmaster", "IPMaster Cowork", "https://c.example", ""),
    ])
    tabs = list_skill_markets()
    assert tabs[0].cowork is None                  # 通用恒在且恒第一
    assert [t.cowork for t in tabs] == [None, "ipmaster"]


def test_a_cowork_without_any_market_url_gets_no_tab(no_injection):
    """空页签只能显示一句"它没有专属市场"，白占一格。判据在 policy.market_scopes——
    这里钉的是 build 端：真给了空地址，也不该造出一家来。"""
    from netlivecowork.config import get_settings

    reg.install_cowork_markets(lambda: [reg.CoworkMarket("mbb", "MBB", "", "")])
    assert reg.build_for_cowork("mbb", get_settings()) == []


# ── 目录按页签取 ──────────────────────────────────────────────────────────────


def test_catalog_without_cowork_uses_the_deployment_markets():
    svc = SkillMarketService(
        adapters=[_FakeAdapter("global")], store=_Store(),
        scoped_adapters=lambda cid: [_FakeAdapter("scoped")],
    )
    assert [i["name"] for i in svc.catalog("u")] == ["skill-from-global"]


def test_catalog_with_cowork_uses_that_coworks_markets():
    svc = SkillMarketService(
        adapters=[_FakeAdapter("global")], store=_Store(),
        scoped_adapters=lambda cid: [_FakeAdapter(f"scoped-{cid}")],
    )
    assert [i["name"] for i in svc.catalog("u", "ipmaster")] == ["skill-from-scoped-ipmaster"]


def test_unknown_cowork_yields_an_empty_catalog_not_an_error():
    """权限收回时页签本来就消失了，这里再抛一次只是把"你没这个权限"说成"系统故障"。"""
    svc = SkillMarketService(
        adapters=[_FakeAdapter("global")], store=_Store(), scoped_adapters=lambda cid: [],
    )
    assert svc.catalog("u", "gone") == []


def test_download_follows_the_tab_not_just_the_source():
    """同一个 source 在通用页签和某 cowork 页签下是**不同的服务器**：只按 source 找会下错家。"""
    svc = SkillMarketService(
        adapters=[_FakeAdapter("global")], store=_Store(),
        scoped_adapters=lambda cid: [_FakeAdapter(f"scoped-{cid}")],
    )
    assert svc.download_zip("cowork", "x", "u") == b"zip:global"
    assert svc.download_zip("cowork", "x", "u", "ipmaster") == b"zip:scoped-ipmaster"


# ── 引用的归属跟着页签走 ───────────────────────────────────────────────────────


@pytest.fixture
def stub_extract(monkeypatch):
    """跳过"下载 zip → 解压 → 读 SKILL.md"：这里要钉的是**归属落在哪**，不是解析。"""
    import contextlib

    from netlivecowork.providers.capability.skills.services import market as mod

    @contextlib.contextmanager
    def fake_materialized(zip_bytes, session_id):
        yield "/tmp/whatever"

    class _Meta:
        name = "demo-skill"
        description = "d"
        triggers = ()
        version = "1.0"

    monkeypatch.setattr(mod, "materialized", fake_materialized)
    monkeypatch.setattr(mod, "load_skill_md", lambda work: (_Meta(), None))


def _svc(store):
    return SkillMarketService(
        adapters=[_FakeAdapter("global")], store=store,
        scoped_adapters=lambda cid: [_FakeAdapter(f"scoped-{cid}")],
    )


def test_pull_from_the_general_tab_is_owned_by_everyone(stub_extract):
    store = _Store()
    _svc(store).pull("cowork", "r1", "demo-skill", "u")
    assert store.added[0].labels == ("*",)


def test_pull_from_a_cowork_tab_is_owned_by_that_cowork_only(stub_extract):
    """用户点的那个页签已经表达了意图，不该再弹一个"给谁用"的框让人说第二遍。"""
    store = _Store()
    _svc(store).pull("cowork", "r1", "demo-skill", "u", "ipmaster")
    assert store.added[0].labels == ("ipmaster",)


# ── is_pulled 必须是"精确身份命中"，不是"引用库里有这条 key" ─────────────────────
#
# 实测踩到：一条只归 ipmaster 的引用，在 coremaster 的市场页签里也标着「已引用」，
# 而那个 cowork 的会话里模型根本拿不到它。**界面说有、模型说没有** —— 用户看到的是
# "技能中心里有，可智能体说自己没有"，而两处各自看都"正常"。
#
# v3 起匹配精确到 (market_scope, source, remote_id, principal)：同 source/id 的通用与
# 专属市场条目互不串台；通配归属只扩大可见范围，不改变"这条引用来自哪个市场"。


class _RefStore:
    """带作用域/归属/主体的引用库替身。refs: (scope, source, remote_id, labels, principal)。"""

    def __init__(self, refs):
        self._refs = refs

    def list_visible(self, username, per_user_sources):
        out = []
        for scope, source, remote_id, labels, principal in self._refs:
            if source in per_user_sources and principal != "*" and principal != username:
                continue           # 按人可见：别人引的不算我的
            out.append(_Ref(scope, source, remote_id, labels, principal))
        return out

    def list_owned(self, owned, *, base=None):
        return [r for r in (base or []) if "*" in r.labels or set(r.labels) & owned]

    def add_reference(self, ref):
        pass


class _Ref:
    def __init__(self, scope, source, remote_id, labels, principal="*"):
        self.identity = ReferenceIdentity(scope, source, remote_id, principal)
        self.labels = labels

    @property
    def key(self):
        return self.identity.reference_id


class _MythosAdapter(_FakeAdapter):
    name = "mythos"
    visibility = VISIBILITY_PER_USER

    def list_catalog(self, ctx):
        return [MarketItem(id="1129", name="调用量上报", description="",
                           updater="", create_time="2026-01-01")]


def _svc_with(refs, cowork_adapters=True):
    store = _RefStore(refs)
    return SkillMarketService(
        adapters=[_MythosAdapter("g")], store=store,
        scoped_adapters=(lambda cid: [_MythosAdapter(cid)]) if cowork_adapters else None,
    )


def test_catalog_identity_includes_effective_market_scope():
    """同一条目录项在不同页签下 reference_id 不同，且同一页签内确定。"""
    svc = _svc_with([])
    general = {i["id"]: i for i in svc.catalog("u")}
    scoped = {i["id"]: i for i in svc.catalog("u", "ipmaster")}
    rid_g = general["1129"]["reference_id"]
    rid_s = scoped["1129"]["reference_id"]
    assert rid_g != rid_s
    assert rid_g == ReferenceIdentity("general", "mythos", "1129", "u").reference_id
    assert rid_s == ReferenceIdentity("ipmaster", "mythos", "1129", "u").reference_id
    assert rid_g == {i["id"]: i for i in svc.catalog("u")}["1129"]["reference_id"]


def test_a_reference_owned_by_another_cowork_is_not_marked_pulled():
    """从 ipmaster 专属市场引的条目，在 coremaster 页签里必须是**未引用** ——
    标成已引用的话，用户以为 coremaster 能用它，而模型拿不到。"""
    svc = _svc_with([("ipmaster", "mythos", "1129", ("ipmaster",), "u")])
    got = {i["id"]: i["is_pulled"] for i in svc.catalog("u", "coremaster")}
    assert got["1129"] is False


def test_scoped_reference_marks_only_its_exact_market_as_pulled():
    """反面：作用域、来源、id、主体都对上才标已引用。"永远 False" 也能过上一条。"""
    svc = _svc_with([("ipmaster", "mythos", "1129", ("ipmaster",), "u")])
    assert svc.catalog("u", "ipmaster")[0]["is_pulled"] is True


def test_general_reference_does_not_mark_profile_market_as_pulled():
    """通用市场引的条目不点亮 profile 专属市场的同 ID 条目（反之亦然）：
    两个页签背后是不同服务器，点亮会让用户以为专属版已就绪。"""
    svc = _svc_with([("general", "mythos", "1129", ("*",), "u")])
    assert svc.catalog("u")[0]["is_pulled"] is True
    assert svc.catalog("u", "ipmaster")[0]["is_pulled"] is False


def test_wildcard_label_does_not_cross_market_identity():
    """通配归属只扩大**同一市场内**的可见范围，不改变这条引用来自哪个市场。"""
    svc = _svc_with([("ipmaster", "mythos", "1129", ("*",), "u")])
    assert svc.catalog("u", "ipmaster")[0]["is_pulled"] is True   # 自己的市场照常
    assert svc.catalog("u", "coremaster")[0]["is_pulled"] is False  # 别的市场不串台
    assert svc.catalog("u")[0]["is_pulled"] is False               # 通用页签也不串台


def test_another_users_reference_is_not_pulled():
    """按人可见的市场：别人引的那条，对我应当是未引用 —— 否则我以为自己有，
    点进去却什么都没有。"""
    svc = _svc_with([("ipmaster", "mythos", "1129", ("*",), "a001")])
    assert svc.catalog("b002", "ipmaster")[0]["is_pulled"] is False
    assert svc.catalog("a001", "ipmaster")[0]["is_pulled"] is True


def test_the_general_tab_does_not_filter_by_cowork():
    """通用页签不是某个 cowork 的上下文。那里的「已引用」含义是"你已经引过这条了"
    （再引一次会把归属放宽成通用），不是"通用范围内能用"。"""
    svc = _svc_with([("general", "mythos", "1129", ("ipmaster",), "u")])
    assert svc.catalog("u")[0]["is_pulled"] is True


def test_legacy_v2_reference_marks_only_general_market_as_pulled(tmp_path):
    """v2 迁移引用按 market_scope=general 处理：只点亮通用页签，不点亮专属市场。"""
    import json as _json

    (tmp_path / "skill_references.json").write_text(_json.dumps({
        "version": 2,
        "references": {"mythos:1129": {
            "source": "mythos", "remote_id": "1129", "name": "M", "owner": "u",
        }},
    }), encoding="utf-8")
    svc = SkillMarketService(
        adapters=[_MythosAdapter("g")], store=SkillReferenceStore(tmp_path),
        scoped_adapters=lambda cid: [_MythosAdapter(cid)],
    )
    assert svc.catalog("u")[0]["is_pulled"] is True
    assert svc.catalog("u", "ipmaster")[0]["is_pulled"] is False


# ── 作用域数据模型：合并追踪与预置作用域解析 ───────────────────────────────────


def test_build_scopes_records_merged_profiles():
    """地址相同的 profile 合并进保留页签，profile_ids 记下被合并者。"""
    scopes = build_scopes("https://same", "", [("dup", "https://same", "")])
    assert [s.id for s in scopes] == [GENERAL_SCOPE]
    assert scopes[0].profile_ids == ("dup",)

    # 两个 profile 地址相同、与通用不同 → 合并进先出现的那个
    scopes = build_scopes("https://g", "", [
        ("p1", "https://x", ""), ("p2", "https://x", ""),
    ])
    assert [s.id for s in scopes] == [GENERAL_SCOPE, "p1"]
    assert scopes[1].profile_ids == ("p1", "p2")

    # 没被合并的页签也记自己
    scopes = build_scopes("https://g", "", [("solo", "https://y", "")])
    assert {s.id: s.profile_ids for s in scopes} == {
        GENERAL_SCOPE: (), "solo": ("solo",),
    }


def test_effective_scope_id_resolves_by_h3_rules():
    general_only = build_scopes("https://g", "https://gm", [])
    distinct = build_scopes("https://g", "", [
        ("ipmaster", "https://ip-c", "https://ip-m"),
        ("mbb", "https://mbb", ""),
    ])
    merged_into_general = build_scopes("https://same", "", [("dup", "https://same", "")])
    merged_pair = build_scopes("https://g", "", [
        ("p1", "https://x", ""), ("p2", "https://x", ""),
    ])

    # 没有 profile_id：general 配了该 source 才 general
    assert effective_scope_id(general_only, None, "cowork") == GENERAL_SCOPE
    assert effective_scope_id(general_only, None, "mythos") == GENERAL_SCOPE
    assert effective_scope_id(build_scopes("", "", []), None, "cowork") is None

    # profile 有独立市场但缺这个 source → None，不跨市场回落（H3）
    assert effective_scope_id(distinct, "mbb", "mythos") is None
    assert effective_scope_id(distinct, "ipmaster", "cowork") == "ipmaster"
    assert effective_scope_id(distinct, "ipmaster", "mythos") == "ipmaster"

    # profile 没配市场 → 整体回落 general（要求 general 配了该 source）
    assert effective_scope_id(distinct, "plain", "cowork") == GENERAL_SCOPE
    assert effective_scope_id(build_scopes("", "", []), "plain", "cowork") is None

    # 被合并进 general 的 profile → general
    assert effective_scope_id(merged_into_general, "dup", "cowork") == GENERAL_SCOPE
    # 被合并进另一个 profile 的 → 那个保留页签
    assert effective_scope_id(merged_pair, "p2", "cowork") == "p1"


def test_market_scopes_builds_from_settings_and_injection(no_injection):
    from types import SimpleNamespace

    settings = SimpleNamespace(
        skill_pull_server_url="https://g", skill_mythos_base_url="",
        http_ssl_verify=False,
    )
    reg.install_cowork_markets(lambda: [
        reg.CoworkMarket("ipmaster", "IPMaster", "", "https://ip-m"),
        reg.CoworkMarket("dup", "Dup", "https://g", ""),
    ])
    scopes = reg.market_scopes(settings)
    assert [(s.id, s.cowork_url, s.mythos_url, s.profile_ids) for s in scopes] == [
        (GENERAL_SCOPE, "https://g", "", ("dup",)),
        ("ipmaster", "", "https://ip-m", ("ipmaster",)),
    ]
