"""skill 归属 —— **写路径那一半**。

架构设计 §9bis.2 ① 说得明白：这块不是"加个字段"，而是改一整条链路。
读路径（能不能看见）与写路径（归属记到哪）在这里交汇。

⚠ 持久化层**不认识 cowork**：它只存一组不透明标签、只做集合运算。
上一版这里写死过一句 `if ref.source == "mythos"`，让一个读写 JSON 的类知道了
三件它不该知道的事——加第三家时要回来改它，而**漏改不报错**，
只是别人的东西出现在你的列表里。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork import runtime as cowork_runtime
from netlivecowork.providers.capability.skills.adapters.scopes import (
    GENERAL_SCOPE,
    build_scopes,
    label_of,
)
from netlivecowork.providers.capability.skills.references.store import (
    ANY_LABEL,
    ReferenceIdentity,
    SkillReference,
    SkillReferenceStore,
)


@pytest.fixture(autouse=True)
def clean():
    cowork_runtime.reset()
    yield
    cowork_runtime.reset()


def ref(name, *, source="cowork", labels=None, owner=None, **kw):
    identity = ReferenceIdentity(GENERAL_SCOPE, source, name, owner or "*")
    d = dict(identity=identity, name=name, **kw)
    if labels is not None:
        d["manual_labels"] = tuple(labels)
    return SkillReference(**d)


# ── 缺省：通配 ────────────────────────────────────────────────────────────────

def test_a_record_without_labels_is_usable_by_everyone(tmp_path):
    """**存量记录没有这个字段，读成"谁都能用"才是它们此前的实际行为。**

    读成"谁都不能用"会让用户已有的 skill 在升级后一夜之间全部消失（需求 H4）。
    """
    s = SkillReferenceStore(tmp_path)
    raw = {"version": 2, "references": {"cowork:a": {
        "source": "cowork", "remote_id": "a", "name": "a"}}}
    (tmp_path / "skill_references.json").write_text(json.dumps(raw), encoding="utf-8")

    assert s.list_references()[0].labels == (ANY_LABEL,)
    assert [r.name for r in s.list_owned({"ipmaster"})] == ["a"]


def test_an_empty_label_list_also_reads_as_wildcard(tmp_path):
    """空数组同样读成通配：那种记录毫无意义，多半是写入侧的 bug 而非用户意图。"""
    s = SkillReferenceStore(tmp_path)
    raw = {"version": 2, "references": {"cowork:a": {
        "source": "cowork", "remote_id": "a", "name": "a", "labels": []}}}
    (tmp_path / "skill_references.json").write_text(json.dumps(raw), encoding="utf-8")
    assert s.list_references()[0].labels == (ANY_LABEL,)


def test_a_new_reference_defaults_to_wildcard():
    assert ref("x").labels == (ANY_LABEL,)


# ── 按标签过滤 ────────────────────────────────────────────────────────────────

def test_filters_by_label(tmp_path):
    s = SkillReferenceStore(tmp_path)
    s.add_reference(ref("shared", labels=["*"]))
    s.add_reference(ref("ip-only", labels=["ipmaster"]))
    s.add_reference(ref("mbb-only", labels=["mbb"]))

    assert sorted(r.name for r in s.list_owned({"ipmaster"})) == ["ip-only", "shared"]
    assert sorted(r.name for r in s.list_owned({"mbb"})) == ["mbb-only", "shared"]


def test_the_wildcard_matches_every_owner(tmp_path):
    """**用通配而不是把当前所有 cowork 枚举进去**（需求 H4）。

    将来新增一个 cowork 时通用 skill 应当**自动**对它可用；
    枚举的话得回头补每一条，而漏补的表现是"新 cowork 少了几个通用 skill"，
    没人会立刻发现。
    """
    s = SkillReferenceStore(tmp_path)
    s.add_reference(ref("shared", labels=["*"]))
    assert [r.name for r in s.list_owned({"a-brand-new-cowork"})] == ["shared"]


def test_a_record_can_belong_to_several(tmp_path):
    """**归属本来就是一组** —— 同一条 skill 可以归几个 cowork。"""
    s = SkillReferenceStore(tmp_path)
    s.add_reference(ref("both", labels=["ipmaster", "mbb"]))
    assert [r.name for r in s.list_owned({"mbb"})] == ["both"]
    assert [r.name for r in s.list_owned({"other"})] == []


def test_the_store_does_not_know_what_a_label_means(tmp_path):
    """**持久化层只做集合运算。**

    标签是 cowork id 还是别的什么，它不知道也不该知道 ——
    这正是上一版那句 `if ref.source == "mythos"` 的教训。
    """
    s = SkillReferenceStore(tmp_path)
    s.add_reference(ref("x", labels=["tenant:42", "project-alpha"]))
    assert [r.name for r in s.list_owned({"project-alpha"})] == ["x"]


def test_set_labels_updates_an_existing_record(tmp_path):
    """事后改归属（卡片里那个勾选清单）。"""
    s = SkillReferenceStore(tmp_path)
    s.add_reference(ref("x", labels=["ipmaster"]))
    s.set_labels("cowork", "x", ["mbb", "ipmaster"])
    assert sorted(s.get_reference("cowork", "x").labels) == ["ipmaster", "mbb"]


def test_setting_empty_labels_falls_back_to_wildcard(tmp_path):
    """一个都不勾 = 通用，与后端缺省一致（需求 H6）。"""
    s = SkillReferenceStore(tmp_path)
    s.add_reference(ref("x", labels=["ipmaster"]))
    s.set_labels("cowork", "x", [])
    assert s.get_reference("cowork", "x").labels == (ANY_LABEL,)


def test_filtering_composes_with_the_per_user_filter(tmp_path):
    """两道过滤叠加：**先按登录用户，再按归属**。

    只做一道的话，另一道的泄露就出现了——而两种泄露的表现都是
    "我看到了不该看到的 skill"。
    """
    s = SkillReferenceStore(tmp_path)
    s.add_reference(ref("mine", source="mythos", owner="zhang", labels=["ipmaster"]))
    s.add_reference(ref("others", source="mythos", owner="li", labels=["ipmaster"]))

    by_user = s.list_visible("zhang", {"mythos"})
    assert sorted(r.name for r in s.list_owned({"ipmaster"}, base=by_user)) == ["mine"]


# ── 市场作用域 ────────────────────────────────────────────────────────────────

def test_the_general_scope_always_exists():
    scopes = build_scopes("https://general", "", [])
    assert [s.id for s in scopes] == [GENERAL_SCOPE]
    assert scopes[0].label == "*", "通用页签引来的谁都能用"


def test_each_cowork_with_a_market_gets_a_tab():
    scopes = build_scopes("https://general", "", [
        ("ipmaster", "", "https://mythos"),
        ("mbb", "https://mbb", ""),
    ])
    assert [s.id for s in scopes] == [GENERAL_SCOPE, "ipmaster", "mbb"]


def test_a_cowork_without_a_market_gets_no_tab():
    """两个源都没配的 cowork 只用通用市场，**不该多出一个空页签**（需求 H3）。"""
    scopes = build_scopes("https://general", "", [("plain", "", "")])
    assert [s.id for s in scopes] == [GENERAL_SCOPE]


def test_identical_addresses_are_merged():
    """**地址相同的合并成一个页签**（需求 H2），否则用户看到两个一模一样的。"""
    scopes = build_scopes("https://same", "", [("dup", "https://same", "")])
    assert [s.id for s in scopes] == [GENERAL_SCOPE]


def test_the_two_source_kinds_are_kept_apart():
    """两个源是**两种接口**，不是"公共/个人"之分。

    代码里不对"哪个源该属于谁"做任何假设——业务侧确认过一次，
    按名字猜正好猜反了。
    """
    scopes = build_scopes("", "https://general-mythos", [("ip", "https://ip-cowork", "")])
    by_id = {s.id: s for s in scopes}
    assert by_id[GENERAL_SCOPE].mythos_url == "https://general-mythos"
    assert by_id["ip"].cowork_url == "https://ip-cowork"


def test_ownership_comes_from_the_tab_not_a_prompt():
    """**归属由"从哪个页签引的"决定，不再弹框追问**（需求 H5）。

    用户点的那个页签已经表达了意图，再问一次只会让人对着两处描述同一件事。
    """
    scopes = build_scopes("https://g", "", [("ipmaster", "https://ip", "")])
    assert label_of(scopes, GENERAL_SCOPE) == "*"
    assert label_of(scopes, "ipmaster") == "ipmaster"
    assert label_of(scopes, "unknown") == "*", "认不出就给通用，不要让 skill 凭空消失"


# ── 端到端：能力清单按归属过滤 ────────────────────────────────────────────────

def _install_cowork(root, cid):
    d = root / "coworks" / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "cowork.json").write_text(json.dumps({"id": cid, "version": "1"}), encoding="utf-8")


class _Ctx:
    def __init__(self, session_id=None):
        self.session_id = session_id


def _labels_of_session(session_id):
    """装配的地方会喂给 provider 的那个函数（见 bootstrap._cowork_owned_labels）。

    provider 自己**不认识 cowork**——它只拿到一组不透明标签（架构设计 §7）。
    """
    scope = cowork_runtime.get_scope()
    if scope is None:
        return None
    cid = scope.cowork_id_of(session_id)
    return {cid} if cid else None


@pytest.mark.asyncio
async def test_the_capability_list_is_filtered_by_ownership(tmp_path, monkeypatch):
    """端到端：两条不同归属的会话，模型看到的 skill 不一样。"""
    from netlivecowork.providers.capability.skills import provider as prov

    _install_cowork(tmp_path, "ipmaster")
    _install_cowork(tmp_path, "mbb")
    cowork_runtime.setup(tmp_path / "coworks")
    scope = cowork_runtime.get_scope()
    scope.bind("ses-ip", "ipmaster")
    scope.bind("ses-mbb", "mbb")

    store = SkillReferenceStore(tmp_path)
    store.add_reference(ref("shared", labels=["*"]))
    store.add_reference(ref("ip-only", labels=["ipmaster"]))

    monkeypatch.setattr(prov, "market_registry",
                        type("R", (), {"per_user_sources": staticmethod(set)})())
    p = prov.ReferencedSkillCapabilityProvider(
        store, market=None, current_username_fn=lambda: "",
        owned_labels_fn=_labels_of_session,
    )

    ip = [c.name for c in await p.list(_Ctx("ses-ip"))]
    mbb = [c.name for c in await p.list(_Ctx("ses-mbb"))]
    assert sorted(ip) == ["ip-only", "shared"]
    assert sorted(mbb) == ["shared"], "别人的专属 skill 不该出现"


@pytest.mark.asyncio
async def test_reading_a_file_by_name_is_also_filtered(tmp_path, monkeypatch):
    """**只拦列表是不够的**（需求 G9）。

    按名字取内容/执行那条路不经过 list，而是走一张全局建一次、跨会话复用的索引。
    只拦 list 的话，A 会话先把索引建起来，B 会话就能按名字读到 A 那个 skill 的文件。
    """
    from netlivecowork.providers.capability.skills import provider as prov

    _install_cowork(tmp_path, "ipmaster")
    _install_cowork(tmp_path, "mbb")
    cowork_runtime.setup(tmp_path / "coworks")
    scope = cowork_runtime.get_scope()
    scope.bind("ses-mbb", "mbb")
    scope.bind("ses-ip", "ipmaster")

    store = SkillReferenceStore(tmp_path)
    store.add_reference(ref("ip-only", labels=["ipmaster"]))

    monkeypatch.setattr(prov, "market_registry",
                        type("R", (), {"per_user_sources": staticmethod(set)})())
    p = prov.ReferencedSkillCapabilityProvider(
        store, market=None, current_username_fn=lambda: "",
        owned_labels_fn=_labels_of_session,
    )

    assert p._resolve("ip-only", "ses-mbb") is None, "别人的 skill 按名字也不该拿得到"
    assert p._resolve("ip-only", "ses-ip") is not None, "自己的照常拿得到"


@pytest.mark.asyncio
async def test_a_session_without_ownership_sees_everything(tmp_path, monkeypatch):
    """历史会话、母版会话、内部任务——**收紧的话它们会突然少掉一批 skill**，
    而那是静默的功能倒退。
    """
    from netlivecowork.providers.capability.skills import provider as prov

    _install_cowork(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path / "coworks")

    store = SkillReferenceStore(tmp_path)
    store.add_reference(ref("ip-only", labels=["ipmaster"]))

    monkeypatch.setattr(prov, "market_registry",
                        type("R", (), {"per_user_sources": staticmethod(set)})())
    p = prov.ReferencedSkillCapabilityProvider(
        store, market=None, current_username_fn=lambda: "",
        owned_labels_fn=_labels_of_session,
    )

    assert [c.name for c in await p.list(_Ctx("unknown-session"))] == ["ip-only"]
    assert [c.name for c in await p.list(_Ctx(None))] == ["ip-only"]
