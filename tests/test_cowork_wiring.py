"""装配接线 —— 隔离**真的接上了**吗。

单元测试证明包装器本身是对的，但**接线漏了同样静默**：
MCP 照常能用、界面照常显示，只是隔离从未生效。所以这里验的是接线本身。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork import runtime as cowork_runtime
from netlivecowork.cowork.guards import CoworkScopedMCPProvider


@pytest.fixture(autouse=True)
def clean():
    cowork_runtime.reset()
    yield
    cowork_runtime.reset()


def install(root, cid, use=()):
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "cowork.json").write_text(
        json.dumps({"id": cid, "version": "1", "mcp": {"use": list(use)}}), encoding="utf-8")


# ── 进程级那一份 ──────────────────────────────────────────────────────────────

def test_setup_builds_the_policy(tmp_path):
    install(tmp_path, "ipmaster", ["tech-kb"])
    policy = cowork_runtime.setup(tmp_path)
    assert policy is cowork_runtime.get_policy()
    assert cowork_runtime.get_scope().installed_ids() == frozenset({"ipmaster"})


def test_policy_is_none_before_setup():
    """**取值函数返回 None 时包装器一律放行** —— 那是"策略还没装配好"。

    收紧的话启动早期的调用会莫名其妙失败，而那与"没权限"长得一样。
    """
    assert cowork_runtime.get_policy() is None


def test_reload_picks_up_newly_installed_suites(tmp_path):
    """**套件装/删之后必须重读**，否则能力判断停在旧快照上（需求 F5）。"""
    install(tmp_path, "a")
    cowork_runtime.setup(tmp_path)
    install(tmp_path, "b")
    assert cowork_runtime.get_scope().suite("b") is None
    cowork_runtime.reload()
    assert cowork_runtime.get_scope().suite("b") is not None


def test_reload_before_setup_is_harmless():
    cowork_runtime.reload()


# ── 客户端自带的 MCP ──────────────────────────────────────────────────────────

def test_client_shipped_names_have_a_default():
    """**默认就要把随包那个浏览器工具排除在外**（需求 G6）。

    不排除的话所有 cowork 都失去它——它随包发布、云端管理台里根本不会列出来，
    所以没有任何套件的 mcp.use 会包含它。
    """
    assert "browser-mcp" in cowork_runtime.client_shipped_mcp_names()


def test_client_shipped_names_are_configurable(monkeypatch):
    monkeypatch.setenv("NLC_CLIENT_SHIPPED_MCP", "a, b ,, c")
    assert cowork_runtime.client_shipped_mcp_names() == frozenset({"a", "b", "c"})


# ── manager 的包装钩子 ────────────────────────────────────────────────────────

def test_the_manager_wraps_providers_before_registering():
    """**注册进内核的必须是包装器**，否则隔离根本没接上。"""
    from netlivecowork.providers.capability.mcp.manager import MCPProviderManager

    registered = []

    class _Registry:
        def register_capability(self, p, **kw):
            registered.append(p)

        def deregister_capability(self, *a, **kw):
            pass

    class _Store:
        def load_all(self):
            return []

    seen = []

    def wrap(provider, name):
        seen.append(name)
        return f"wrapped:{name}"

    m = MCPProviderManager(_Store(), _Registry(), wrap=wrap)
    m._create_and_register(type("C", (), {"name": "tech-kb", "transport": "http"})())

    assert seen == ["tech-kb"]
    assert registered == ["wrapped:tech-kb"], "注册进去的应当是包装器"


def test_without_a_wrapper_the_manager_registers_as_before():
    """**去掉 cowork 这一层，后端仍照常工作**（架构设计 D2）。

    衍生品牌可能就是单 agent 形态；这条保证那种形态不必靠一堆 if 撑着。
    """
    from netlivecowork.providers.capability.mcp.manager import MCPProviderManager

    registered = []

    class _Registry:
        def register_capability(self, p, **kw):
            registered.append(p)

        def deregister_capability(self, *a, **kw):
            pass

    class _Store:
        def load_all(self):
            return []

    m = MCPProviderManager(_Store(), _Registry())
    provider = m._create_and_register(type("C", (), {"name": "x", "transport": "http"})())
    assert registered == [provider], "不给包装器就原样注册"


def test_the_assembly_wrapper_only_gates_suite_defined_servers(tmp_path, monkeypatch):
    """**只有套件 `mcp.define` 声明过的 server 才受 cowork 归属约束。**

    两类一律豁免、所有会话可见:客户端自带(browser-mcp)、以及用户在 mcp.json 手工自加的
    全局 MCP。否则用户自配的 MCP 会在每个 agent 会话里凭空消失(它不属于任何套件的 mcp.use)。
    """
    from netlivecowork import paths
    from netlivecowork.bootstrap.host_runtime import _cowork_mcp_wrapper

    # 一个已装套件，在 mcp.define 里声明了 kb-mcp
    coworks = tmp_path / "coworks"
    d = coworks / "ipmaster"
    d.mkdir(parents=True)
    (d / "cowork.json").write_text(json.dumps({
        "id": "ipmaster", "version": "1",
        "mcp": {"use": ["kb-mcp"], "define": {"kb-mcp": {"url": "http://x/mcp"}}},
    }), encoding="utf-8")
    monkeypatch.setattr(paths, "coworks_dir", lambda: coworks)
    monkeypatch.setenv("NLC_CLIENT_SHIPPED_MCP", "browser-mcp")

    wrap = _cowork_mcp_wrapper()

    suite_defined = wrap(object(), "kb-mcp")      # 套件声明过 → 受约束
    user_added = wrap(object(), "my-own-mcp")     # 用户自加、无人声明 → 豁免
    shipped = wrap(object(), "browser-mcp")       # 客户端自带 → 豁免

    assert isinstance(suite_defined, CoworkScopedMCPProvider)
    assert suite_defined._suite_delivered is True
    assert user_added._suite_delivered is False, "用户手工自加的全局 MCP 不该被当成套件下发"
    assert shipped._suite_delivered is False, "自带的不受套件声明约束"


def test_the_wrapper_degrades_to_none_without_cowork(monkeypatch):
    """**摘掉 cowork 子系统时包装器返回 None（架构设计 D2）。**

    衍生品牌的单 agent 形态整个不带 cowork —— `netlivecowork.cowork.*` import 会 ImportError，
    包装器要捕获后返回 None（manager 据此原样注册），而不是让 MCP 注册连带崩掉。
    """
    import sys
    from netlivecowork.bootstrap.host_runtime import _cowork_mcp_wrapper

    # sys.modules[name] = None → `import name` 抛 ImportError，模拟"没装 cowork 包"
    monkeypatch.setitem(sys.modules, "netlivecowork.cowork.guards", None)
    assert _cowork_mcp_wrapper() is None


# ── 会话登记 ──────────────────────────────────────────────────────────────────

def test_binding_a_session_never_breaks_creation(tmp_path):
    """**登记失败绝不能挡住建会话。** 它只是缓存，回查兜底还在。"""
    from netlivecowork.api.cowork_bridge import bind_session as _bind_cowork

    _bind_cowork("ses-1", "agent:ipmaster")      # 还没 setup，不该抛

    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    _bind_cowork("ses-2", "agent:ipmaster")
    assert cowork_runtime.get_scope().cowork_id_of("ses-2") == "ipmaster"


def test_binding_an_unknown_template_is_silent(tmp_path):
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    from netlivecowork.api.cowork_bridge import bind_session as _bind_cowork

    _bind_cowork("ses-x", "agent:default")
    assert cowork_runtime.get_scope().cowork_of("ses-x") is None


# ── 对账失败不能挡住启动 ──────────────────────────────────────────────────────

def test_setup_cowork_survives_a_broken_staging_dir(tmp_path, monkeypatch):
    """**连不上云端、包全坏了，应用照常打开**（需求 C11/B12）。

    真要对话时自然会失败，不需要再造一道门去拦。
    """
    from netlivecowork import paths
    from netlivecowork.bootstrap.host_runtime import _setup_cowork

    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "junk.zip").write_bytes(b"not a zip")
    monkeypatch.setattr(paths, "cowork_staging_dir", lambda: staging)
    monkeypatch.setattr(paths, "coworks_dir", lambda: tmp_path / "coworks")

    _setup_cowork()                     # 不抛
    assert cowork_runtime.get_policy() is not None


def test_setup_cowork_survives_a_reconcile_explosion(tmp_path, monkeypatch):
    from netlivecowork import paths
    from netlivecowork.bootstrap.host_runtime import _setup_cowork
    from netlivecowork.cowork import reconcile as reconcile_mod

    monkeypatch.setattr(paths, "cowork_staging_dir", lambda: tmp_path / "s")
    monkeypatch.setattr(paths, "coworks_dir", lambda: tmp_path / "c")
    # patch 的是**模块上的属性**：_setup_cowork 里是 `from .reconcile import reconcile`，
    # 它在函数体内 import，所以 patch 模块属性仍然生效。
    monkeypatch.setattr(reconcile_mod, "reconcile",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    _setup_cowork()                     # 不抛
    assert cowork_runtime.get_policy() is not None, "对账炸了，策略照样要建起来"
