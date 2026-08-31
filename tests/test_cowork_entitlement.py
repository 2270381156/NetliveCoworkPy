"""对账的领域逻辑 —— 该有哪几个 × 已装哪几个 → 装什么、删什么。

**这一组是整块 cowork 里最该被测透的地方。** 它的每一条规则错了都不报错：

    写成"变大才装"       → 管理员回滚了，用户还在用新版
    没凭据当成空清单     → 把人家的套件连同改过的提示词删掉，**不可逆**
    用清单里的 id 算差集 → 装完立刻删掉，日志还理直气壮写"权限收回"

纯函数，所以能把这些情形一个不落地摆出来——这正是把它与 HTTP 分开的理由。
"""
from __future__ import annotations

from netlivecowork.cowork.entitlement import Plan, entitled_from, plan
from netlivecowork.cowork.manifest import MASTER_ID


def E(*ids):
    return frozenset(ids)


# ── 装 ────────────────────────────────────────────────────────────────────────

def test_installs_what_is_entitled_and_available(tmp_path=None):
    p = plan(entitled=E("a", "b"), installed={}, available={"a": "1", "b": "2"})
    assert p.install == {"a": "1", "b": "2"}
    assert p.remove == () and p.skip == {}


def test_skips_when_the_version_is_the_same(tmp_path=None):
    p = plan(entitled=E("a"), installed={"a": "3"}, available={"a": "3"})
    assert p.install == {} and p.skip == {"a": "3"}


def test_reinstalls_when_the_version_differs(tmp_path=None):
    p = plan(entitled=E("a"), installed={"a": "3"}, available={"a": "4"})
    assert p.install == {"a": "4"}


def test_a_rollback_to_a_smaller_version_still_installs():
    """**绝不能写成"变大才装"**（需求 C6）。

    云端下发的版本是递增整数，管理员回滚时它会**变小**。
    写成大于的现象是"我明明回滚了他还在用新版"，而且不报错。
    """
    p = plan(entitled=E("a"), installed={"a": "5"}, available={"a": "3"})
    assert p.install == {"a": "3"}, "回滚必须装回去"


def test_semver_like_strings_are_compared_as_equality_not_order():
    """版本只做相等比较，不解析大小——所以 "1.10.0" / "1.9.0" 这种坑在这里不存在。"""
    p = plan(entitled=E("a"), installed={"a": "1.9.0"}, available={"a": "1.10.0"})
    assert p.install == {"a": "1.10.0"}


def test_an_unentitled_package_sitting_in_the_directory_is_not_installed():
    """开发机上堆着的包不能变成"人人都有全量"，否则权限就没意义了（需求 C13）。"""
    p = plan(entitled=E("a"), installed={}, available={"a": "1", "sneaky": "9"})
    assert p.install == {"a": "1"}


def test_a_package_for_the_master_is_never_installed():
    p = plan(entitled=E(MASTER_ID), installed={}, available={MASTER_ID: "1"})
    assert p.install == {}


# ── 删 ────────────────────────────────────────────────────────────────────────

def test_removes_what_is_no_longer_entitled():
    p = plan(entitled=E("a"), installed={"a": "1", "b": "1"}, available={})
    assert p.remove == ("b",)


def test_removes_nothing_when_the_list_could_not_be_fetched():
    """**这条是整组里最要紧的。**

    "没拿到清单"与"拿到了一张空清单"必须区分。把网络故障当成权限被收回，
    后果是把用户的套件连同他改过的提示词删掉，**且不可逆**；
    反过来（该删没删）只是晚一次对账才生效。
    **两个方向的错不对称，所以往安全的一侧偏。**
    """
    p = plan(entitled=None, installed={"a": "1", "b": "1"}, available={})
    assert p.remove == (), "拿不到清单就一个都不能删"


def test_an_explicitly_empty_list_does_remove_everything():
    """反过来，**确实拿到了一张空清单**就该全删——那是"权限全被收回"。

    与上一条合起来才完整：只做上一条会变成"永远不删"。
    """
    p = plan(entitled=E(), installed={"a": "1", "b": "1"}, available={})
    assert p.remove == ("a", "b")


def test_the_master_is_never_removed():
    """母版不是 cowork，没有谁的权限能收回它（需求 A8）。

    删了的表现是一批老会话集体跑不动，而原因完全指不到这里。
    """
    p = plan(entitled=E(), installed={MASTER_ID: "1", "a": "1"}, available={})
    assert p.remove == ("a",)


def test_nothing_installed_means_nothing_to_remove():
    p = plan(entitled=E(), installed={}, available={})
    assert p.remove == () and p.is_noop


# ── 装与删同时发生 ────────────────────────────────────────────────────────────

def test_install_and_remove_in_one_pass():
    """新开通一个、收回一个——一次对账要能同时表达。"""
    p = plan(
        entitled=E("a", "new"),
        installed={"a": "1", "old": "1"},
        available={"a": "1", "new": "1"},
    )
    assert p.install == {"new": "1"}
    assert p.skip == {"a": "1"}
    assert p.remove == ("old",)
    assert not p.is_noop


def test_entitled_but_the_package_never_arrived_is_not_a_removal():
    """**下载失败的不算被收回**（需求 C9）。

    一次 403 或一次超时不该等于替对方做了收回决定：它仍在授权清单里，
    只是这次没取到包。
    """
    p = plan(entitled=E("a", "b"), installed={"a": "1", "b": "1"}, available={"a": "1"})
    assert p.remove == (), "还在授权里就不能删，哪怕这次没拿到它的包"
    assert p.skip == {"a": "1"}


def test_noop_when_everything_matches():
    p = plan(entitled=E("a"), installed={"a": "1"}, available={"a": "1"})
    assert p.is_noop and p.skip == {"a": "1"}


# ── 解析授权清单 ──────────────────────────────────────────────────────────────

def test_parses_the_contract_shape():
    got = entitled_from([{"agentId": "ipmaster", "version": 3}, {"agentId": "mbb", "version": 1}])
    assert got == E("ipmaster", "mbb")


def test_a_plain_list_of_ids_also_works():
    """暂存目录里那份凭据文件是 `{"agents": ["ipmaster", "mbb"]}` 形状。"""
    assert entitled_from(["ipmaster", "mbb"]) == E("ipmaster", "mbb")


def test_an_empty_list_is_an_empty_set_not_none():
    """**空清单 ≠ 没拿到。** 前者要删，后者不动——两者绝不能混。"""
    assert entitled_from([]) == E()
    assert entitled_from([]) is not None


def test_unparseable_input_is_none_not_an_empty_set():
    """认不出来就是"没拿到"。当成空清单等于替对方做了"全部收回"的决定。"""
    assert entitled_from(None) is None
    assert entitled_from({"agents": []}) is None
    assert entitled_from("oops") is None


def test_entries_without_an_id_are_dropped():
    assert entitled_from([{"agentId": ""}, {"version": 3}, {"agentId": " a "}]) == E("a")


def test_a_missing_list_flows_through_to_no_removal():
    """端到端：解析不出来 → None → 一个都不删。两段规则必须接得上。"""
    p = plan(entitled=entitled_from("garbage"), installed={"a": "1"}, available={})
    assert p.remove == ()


# ── 结果对象 ──────────────────────────────────────────────────────────────────

def test_plan_is_read_only():
    """算出来的动作是快照。可变的话，某处顺手改一下会让实际执行与日志对不上。"""
    import dataclasses

    p = Plan()
    try:
        p.remove = ("x",)  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("Plan 应当是只读的")
