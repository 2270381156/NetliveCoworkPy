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


# ── is_pulled 必须是"这个页签下真的能用"，不是"引用库里有这条 key" ─────────────
#
# 实测踩到：一条只归 ipmaster 的引用，在 coremaster 的市场页签里也标着「已引用」，
# 而那个 cowork 的会话里模型根本拿不到它。**界面说有、模型说没有** —— 用户看到的是
# "技能中心里有，可智能体说自己没有"，而两处各自看都"正常"。


class _RefStore:
    """带归属与 owner 的引用库替身。形状对齐 SkillReferenceStore 的三个方法。"""

    def __init__(self, refs):
        self._refs = refs          # [(key, labels, owner)]

    def is_referenced(self, source, remote_id):
        return f"{source}:{remote_id}" in {k for k, _, _ in self._refs}

    def list_visible(self, username, per_user_sources):
        out = []
        for key, labels, owner in self._refs:
            src = key.split(":", 1)[0]
            if src in per_user_sources and owner and owner != username:
                continue           # 按人可见：别人引的不算我的
            out.append(_Ref(key, labels))
        return out

    def list_owned(self, owned, *, base=None):
        return [r for r in (base or []) if "*" in r.labels or set(r.labels) & owned]

    def add_reference(self, ref):
        pass


class _Ref:
    def __init__(self, key, labels):
        self.key, self.labels = key, labels


class _MythosAdapter(_FakeAdapter):
    name = "mythos"

    def list_catalog(self, ctx):
        return [MarketItem(id="1129", name="调用量上报", description="",
                           updater="", create_time="2026-01-01")]


def _svc_with(refs, cowork_adapters=True):
    store = _RefStore(refs)
    return SkillMarketService(
        adapters=[_MythosAdapter("g")], store=store,
        scoped_adapters=(lambda cid: [_MythosAdapter(cid)]) if cowork_adapters else None,
    )


def test_a_reference_owned_by_another_cowork_is_not_marked_pulled():
    """归 ipmaster 的引用，在 coremaster 页签里必须是**未引用** ——
    标成已引用的话，用户以为 coremaster 能用它，而模型拿不到。"""
    svc = _svc_with([("mythos:1129", ("ipmaster",), None)])
    got = {i["id"]: i["is_pulled"] for i in svc.catalog("u", "coremaster")}
    assert got["1129"] is False


def test_the_owning_cowork_still_sees_it_as_pulled():
    """反面：归属对得上就该标已引用。只测上一条的话，"永远 False" 也能过。"""
    svc = _svc_with([("mythos:1129", ("ipmaster",), None)])
    assert svc.catalog("u", "ipmaster")[0]["is_pulled"] is True


def test_a_wildcard_reference_is_pulled_everywhere():
    """通配归属谁都能用，每个页签都该标已引用。"""
    svc = _svc_with([("mythos:1129", ("*",), None)])
    for cid in ("ipmaster", "coremaster"):
        assert svc.catalog("u", cid)[0]["is_pulled"] is True, cid


def test_someone_elses_reference_is_not_marked_pulled():
    """按人可见的市场：别人引的那条，对我应当是未引用 —— 否则我以为自己有，
    点进去却什么都没有。"""
    svc = _svc_with([("mythos:1129", ("*",), "a001")])
    assert svc.catalog("b002", "ipmaster")[0]["is_pulled"] is False
    assert svc.catalog("a001", "ipmaster")[0]["is_pulled"] is True


def test_the_general_tab_does_not_filter_by_cowork():
    """通用页签不是某个 cowork 的上下文。那里的「已引用」含义是"你已经引过这条了"
    （再引一次会把归属放宽成通用），不是"通用范围内能用"。"""
    svc = _svc_with([("mythos:1129", ("ipmaster",), None)])
    assert svc.catalog("u")[0]["is_pulled"] is True
