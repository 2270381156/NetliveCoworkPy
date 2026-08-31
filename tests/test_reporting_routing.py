"""路由与扇出。

这一层的价值全在**一条数据要发给几个平台**这件事上——原来的设计是"归属 → 一个出口"，
隐含了只挑一个，接第二个平台就不够用了。
"""
from __future__ import annotations

from netlivecowork.reporting.labels import Labels
from netlivecowork.reporting.routing import ANY, Route, resolve

T_TOKEN = "token_usage"


def _r(**kw):
    return Route(**{"kind": T_TOKEN, "sink": "a", **kw})


# ── 扇出 ──────────────────────────────────────────────────────────────────────

def test_one_record_can_go_to_several_platforms():
    """**这条是本层存在的理由。**"""
    table = (_r(sink="a"), _r(sink="b"), _r(sink="c"))
    out = resolve(T_TOKEN, {"x": 1}, Labels(), table)
    assert [d.sink for d in out] == ["a", "b", "c"]


def test_fanned_out_copies_share_a_record_id_but_have_their_own_delivery_id():
    """共享的那个用来跨平台对账（"这是同一件事"）；各自那个给下游去重用。"""
    out = resolve(T_TOKEN, {}, Labels(), (_r(sink="a"), _r(sink="b")))
    assert out[0].record_id == out[1].record_id
    assert out[0].delivery_id != out[1].delivery_id


def test_no_matching_route_yields_nothing(caplog):
    """没配路由 = 这条数据不会被发出去。**必须留下日志**，否则它与"发走了"看起来一样。"""
    with caplog.at_level("WARNING"):
        assert resolve("nosuch", {}, Labels(), (_r(),)) == []
    assert "没有路由匹配" in caplog.text


def test_empty_table_yields_nothing(caplog):
    with caplog.at_level("WARNING"):
        assert resolve(T_TOKEN, {}, Labels(), ()) == []
    assert "没有路由匹配" in caplog.text


# ── 按记录类型筛 ──────────────────────────────────────────────────────────────

def test_kind_must_match():
    table = (_r(kind="skill_usage", sink="s"), _r(kind=T_TOKEN, sink="t"))
    assert [d.sink for d in resolve(T_TOKEN, {}, Labels(), table)] == ["t"]


def test_wildcard_kind_matches_everything():
    table = (_r(kind=ANY, sink="all"),)
    assert len(resolve("anything", {}, Labels(), table)) == 1


# ── 按归属筛 ──────────────────────────────────────────────────────────────────

def test_cowork_must_match_when_the_route_names_one():
    table = (_r(cowork="ipmaster", sink="ip"), _r(cowork="mbb", sink="mbb"))
    got = resolve(T_TOKEN, {}, Labels(cowork="mbb"), table)
    assert [d.sink for d in got] == ["mbb"]


def test_wildcard_cowork_matches_any_including_unknown():
    table = (_r(cowork=ANY, sink="all"),)
    assert len(resolve(T_TOKEN, {}, Labels(), table)) == 1
    assert len(resolve(T_TOKEN, {}, Labels(cowork="ipmaster"), table)) == 1


def test_unknown_ownership_does_not_match_a_named_cowork():
    """**归属未知 ≠ 属于所有人。**

    今天归属恒为空（cowork 那块还没建）。若"空"能匹配上具名规则，
    数据会在归属接通之前就流向本不该去的平台——而那是不可撤销的。
    """
    table = (_r(cowork="ipmaster", sink="ip"),)
    assert resolve(T_TOKEN, {}, Labels(), table) == []


def test_empty_string_route_matches_only_unknown_ownership():
    """反过来也要能表达："归属未知的数据发到某个兜底平台"。"""
    table = (_r(cowork="", sink="fallback"),)
    assert len(resolve(T_TOKEN, {}, Labels(), table)) == 1
    assert resolve(T_TOKEN, {}, Labels(cowork="ipmaster"), table) == []


# ── 字段投影（脱敏） ──────────────────────────────────────────────────────────

def test_projection_keeps_only_the_listed_fields():
    """**这是脱敏点，不是性能优化。** 没列出来的字段发不出去。"""
    table = (_r(sink="a", fields=("input_tokens",)),)
    out = resolve(T_TOKEN, {"input_tokens": 1, "username": "zhang"}, Labels(), table)
    assert out[0].payload == {"input_tokens": 1}


def test_no_projection_means_everything():
    table = (_r(sink="a", fields=None),)
    out = resolve(T_TOKEN, {"a": 1, "b": 2}, Labels(), table)
    assert out[0].payload == {"a": 1, "b": 2}


def test_each_platform_gets_its_own_projection():
    """同一条数据，A 看得到用户名、B 看不到——这必须由路由表决定，不能靠出口自觉。"""
    table = (
        _r(sink="a", fields=("tokens", "username")),
        _r(sink="b", fields=("tokens",)),
    )
    out = resolve(T_TOKEN, {"tokens": 9, "username": "zhang"}, Labels(), table)
    assert out[0].payload == {"tokens": 9, "username": "zhang"}
    assert out[1].payload == {"tokens": 9}


def test_missing_projected_field_is_omitted_not_nulled():
    """缺失的字段直接不出现——补空值会让下游分不清"没有"和"是空的"。"""
    table = (_r(sink="a", fields=("tokens", "absent")),)
    out = resolve(T_TOKEN, {"tokens": 1}, Labels(), table)
    assert out[0].payload == {"tokens": 1}


def test_payload_is_copied_not_shared():
    """扇出的几份互不影响，也不影响调用方手里那个 dict。"""
    src = {"a": 1}
    out = resolve(T_TOKEN, src, Labels(), (_r(sink="x"), _r(sink="y")))
    out[0].payload["a"] = 999
    assert src == {"a": 1}
    assert out[1].payload == {"a": 1}
