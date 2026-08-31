"""会话归属登记表。

**能力属于 cowork，会话只表明身份。** 这张表就是那张工牌：只回答"这条会话属于谁"，
不承载任何能力语义。

最要紧的一条：**正确性不依赖"每条创建路径都记得登记"** ——
重启后从库里恢复的会话没走过创建路径，漏掉它们的表现是那些会话看得见全部能力，
而且不报错。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork.manifest import MASTER_ID
from netlivecowork.cowork.scope import CoworkScope


def install(root, cid, **over):
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    raw = {"id": cid, "version": "1", "order": 10,
           "mcp": {"use": [f"{cid}-tool"]}, **over}
    (d / "cowork.json").write_text(json.dumps(raw), encoding="utf-8")


@pytest.fixture
def coworks(tmp_path):
    install(tmp_path, "ipmaster")
    install(tmp_path, "mbb")
    return tmp_path


# ── 登记与注销 ────────────────────────────────────────────────────────────────

def test_bind_then_lookup(coworks):
    s = CoworkScope(coworks)
    s.bind("ses-1", "agent:ipmaster")
    assert s.cowork_of("ses-1").id == "ipmaster"


def test_bind_accepts_bare_ids_too(coworks):
    """带不带前缀都行 —— 调用方不必先判断"这个从哪来的"。"""
    s = CoworkScope(coworks)
    s.bind("ses-1", "mbb")
    assert s.cowork_id_of("ses-1") == "mbb"


def test_unbind_forgets_it(coworks):
    """**必须带注销**（需求 G4）：不注销的话这张表会随会话数无限长。"""
    s = CoworkScope(coworks)
    s.bind("ses-1", "ipmaster")
    s.unbind("ses-1")
    assert s.cowork_of("ses-1") is None


def test_unbinding_something_unknown_is_harmless(coworks):
    CoworkScope(coworks).unbind("never-seen")


def test_an_unknown_template_is_not_bound(coworks):
    """**"不登记"与"登记成某个 cowork"必须分开。**

    前者是"不知道"，后者是"知道且是它"。混同的话，历史会话会莫名其妙地
    继承某个 cowork 的能力。
    """
    s = CoworkScope(coworks)
    s.bind("ses-1", "agent:nosuch")
    assert s.cowork_of("ses-1") is None


def test_the_master_template_is_not_bound(coworks):
    """历史会话与内部任务跑的是母版，它不属于任何 cowork。"""
    s = CoworkScope(coworks)
    s.bind("ses-1", f"agent:{MASTER_ID}")
    assert s.cowork_of("ses-1") is None


def test_empty_inputs_are_ignored(coworks):
    s = CoworkScope(coworks)
    s.bind("", "ipmaster")
    s.bind("ses-1", "")
    s.bind("ses-1", None)
    assert s.cowork_of("ses-1") is None
    assert s.cowork_of(None) is None


# ── 回查兜底 ──────────────────────────────────────────────────────────────────

def test_falls_back_to_the_session_template_when_not_bound(coworks):
    """**这条是整组最要紧的。**

    重启后从库里恢复的会话没走过创建路径。漏掉它们的表现是
    那些会话看得见全部能力，**而且不报错**。
    """
    s = CoworkScope(coworks, resolver=lambda sid: "agent:mbb" if sid == "old" else None)
    assert s.cowork_of("old").id == "mbb", "没登记过也要能查出归属"


def test_the_fallback_result_is_cached(coworks):
    """回查一次就记住 —— 登记因此退化成缓存：快，但不是唯一来源。"""
    calls = []

    def resolver(sid):
        calls.append(sid)
        return "ipmaster"

    s = CoworkScope(coworks, resolver=resolver)
    s.cowork_of("x"), s.cowork_of("x"), s.cowork_of("x")
    assert calls == ["x"], "回查只该发生一次"


def test_a_failing_resolver_does_not_blow_up(coworks):
    """回查失败就是"不知道"，不能把能力枚举整条路带塌。"""
    def boom(_):
        raise RuntimeError("db down")

    s = CoworkScope(coworks, resolver=boom)
    assert s.cowork_of("x") is None


def test_a_resolver_pointing_at_an_uninstalled_cowork_yields_nothing(coworks):
    """会话记的模板已经被收回了 —— 这正是"只读会话"的来源。"""
    s = CoworkScope(coworks, resolver=lambda _: "agent:revoked")
    assert s.cowork_of("x") is None


def test_resolver_can_be_installed_later(coworks):
    """会话注册表比 scope 建得晚，所以要能事后装。"""
    s = CoworkScope(coworks)
    assert s.cowork_of("x") is None
    s.set_resolver(lambda _: "mbb")
    assert s.cowork_of("x").id == "mbb"


# ── 套件与重载 ────────────────────────────────────────────────────────────────

def test_lists_installed_ids(coworks):
    assert CoworkScope(coworks).installed_ids() == frozenset({"ipmaster", "mbb"})


def test_suite_by_id(coworks):
    s = CoworkScope(coworks)
    assert s.suite("ipmaster").mcp_use == ("ipmaster-tool",)
    assert s.suite("agent:mbb").id == "mbb", "带前缀也要认"
    assert s.suite("nosuch") is None
    assert s.suite(None) is None


def test_reload_picks_up_a_newly_installed_suite(coworks, tmp_path):
    """**安装/收回之后必须重载**，否则能力判断停在旧快照上。"""
    s = CoworkScope(coworks)
    install(tmp_path, "newone")
    assert s.suite("newone") is None, "重载之前看不到是对的"
    s.reload()
    assert s.suite("newone") is not None


def test_reload_drops_a_revoked_suite(coworks, tmp_path):
    import shutil

    s = CoworkScope(coworks)
    shutil.rmtree(tmp_path / "mbb")
    s.reload()
    assert s.suite("mbb") is None
    assert s.cowork_of("ses") is None


def test_a_binding_to_a_revoked_suite_stops_resolving(coworks, tmp_path):
    """套件被收回之后，原先登记过的会话也查不出归属了 —— 能力随之消失。

    这正是"删的是能力，不是记录"：会话数据一条没动。
    """
    import shutil

    s = CoworkScope(coworks)
    s.bind("ses-1", "mbb")
    assert s.cowork_of("ses-1") is not None

    shutil.rmtree(tmp_path / "mbb")
    s.reload()
    assert s.cowork_of("ses-1") is None


def test_empty_dir_means_nobody_owns_anything(tmp_path):
    s = CoworkScope(tmp_path / "nope")
    assert s.installed_ids() == frozenset()
    assert s.cowork_of("x") is None


# ── 线程安全 ──────────────────────────────────────────────────────────────────

def test_concurrent_bind_and_lookup_do_not_corrupt_the_table(coworks):
    """会话创建走 API 线程、能力枚举走执行循环，两边都碰这张表。"""
    import threading

    s = CoworkScope(coworks)
    errors = []

    def writer():
        for i in range(200):
            s.bind(f"ses-{i}", "ipmaster")
            s.unbind(f"ses-{i}")

    def reader():
        try:
            for i in range(200):
                s.cowork_of(f"ses-{i}")
        except Exception as e:      # pragma: no cover
            errors.append(e)

    ts = [threading.Thread(target=writer), threading.Thread(target=reader)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert errors == []


# ── 回查：没被 bind 过的会话也要能定位归属 ────────────────────────────────────
#
# 实测踩到：`bind_session` 只在**建会话**那条路径上被调，而重启后从库里恢复的会话
# 根本没走过那条路径。回查没装上时它们归属为空 → 能力一律不过滤 →
# **那些会话看得见全部 skill 与 MCP，且不报错**。

def test_an_unbound_session_falls_back_to_its_template(tmp_path):
    """查不到登记就回查会话自己的模板 —— 正确性不该依赖"每条创建路径都记得 bind"。"""
    install(tmp_path, "ipmaster")
    scope = CoworkScope(tmp_path)
    scope.set_resolver(lambda sid: "agent:ipmaster" if sid == "ses-old" else None)

    assert scope.cowork_id_of("ses-old") == "ipmaster", "没 bind 过的会话必须靠回查定位"


def test_the_fallback_result_is_cached(tmp_path):
    """回查要读会话注册表，不该每次能力调用都读一遍。"""
    install(tmp_path, "ipmaster")
    scope = CoworkScope(tmp_path)
    calls = []

    def resolver(sid):
        calls.append(sid)
        return "agent:ipmaster"

    scope.set_resolver(resolver)
    scope.cowork_id_of("ses-old")
    scope.cowork_id_of("ses-old")
    assert calls == ["ses-old"], "回查结果没缓存"


def test_a_broken_resolver_falls_back_to_unknown(tmp_path):
    """回查炸了 → 当作"不知道归属"，回到不过滤；**不能让能力调用整个失败**。"""
    install(tmp_path, "ipmaster")
    scope = CoworkScope(tmp_path)
    scope.set_resolver(lambda sid: (_ for _ in ()).throw(RuntimeError("boom")))
    assert scope.cowork_id_of("ses-old") == ""


def test_a_template_that_is_not_installed_resolves_to_nothing(tmp_path):
    """回查出一个没装的 cowork —— 那不是归属，是"这条会话的套件被收回了"。"""
    install(tmp_path, "ipmaster")
    scope = CoworkScope(tmp_path)
    scope.set_resolver(lambda sid: "agent:gone")
    assert scope.cowork_id_of("ses-old") == ""


def test_bootstrap_actually_installs_the_resolver():
    """**没人调 set_resolver 的话，上面几条全是空谈** —— 回退会是死代码，
    而它死掉的表现就是"老会话看得见全部能力"。删掉装配那行，这条才会红。"""
    import inspect
    from netlivecowork.bootstrap import host_runtime

    assert "set_resolver" in inspect.getsource(host_runtime._install_session_resolver)
    assert "_install_session_resolver()" in inspect.getsource(host_runtime._setup_cowork), (
        "装配期没接回查：重启后恢复的会话归属为空，能力一律不过滤"
    )
