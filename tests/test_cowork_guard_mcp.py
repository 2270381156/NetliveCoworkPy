"""MCP 能力隔离的包装层。

这一组分两半：

**结构**（那两个坑）—— 它们不报错，只是隔离静默失效或能力整个消失；
**行为**（三个入口）—— 尤其是"模型实际拿到什么"，而不是"接口返回什么"。
"""
from __future__ import annotations

import inspect
import json

import pytest

from ctx_weft.protocols.capability import ToolCapabilityProvider
from netlivecowork.cowork.guards import CoworkScopedMCPProvider
from netlivecowork.cowork.policy import CoworkPolicy
from netlivecowork.cowork.scope import CoworkScope


class _Ctx:
    def __init__(self, session_id=None):
        self.session_id = session_id


class _FakeMCP(ToolCapabilityProvider):
    """一个假的 MCP provider：三个入口各记一次调用。"""

    def __init__(self, name="tech-kb"):
        self.name = name
        self.description = "fake"
        self.calls: list[str] = []

    async def retrieve(self, ctx):
        self.calls.append("retrieve")
        return [f"{self.name}:search"]

    async def list(self, ctx):
        self.calls.append("list")
        return [f"{self.name}:search"]

    async def invoke(self, capability_id, arguments, ctx):
        self.calls.append("invoke")
        return "result"

    async def describe(self, ctx):
        self.calls.append("describe")
        return "info"

    async def cancel(self, invocation_id, ctx):
        self.calls.append("cancel")
        return True


def _setup(tmp_path, *, use=("tech-kb",)):
    d = tmp_path / "coworks" / "ipmaster"
    d.mkdir(parents=True)
    (d / "cowork.json").write_text(
        json.dumps({"id": "ipmaster", "version": "1", "mcp": {"use": list(use)}}),
        encoding="utf-8",
    )
    scope = CoworkScope(tmp_path / "coworks")
    scope.bind("ses-own", "ipmaster")
    return scope, CoworkPolicy(scope)


def _guard(inner, policy, **kw):
    return CoworkScopedMCPProvider(inner, inner.name, lambda: policy, **kw)


# ── 结构：那两个坑 ────────────────────────────────────────────────────────────

def test_the_wrapper_is_a_real_subclass():
    """**必须是真子类，不能只是"长得像"。**

    内核建"哪个工具归哪个 provider"的索引时有一道 isinstance 检查，
    而那是 ABC 不是 Protocol —— 鸭子类型在这里不算数。

    写成普通类 + __getattr__ 透传的后果实测过：所有 MCP provider 都没进那个索引，
    任何工具调用直接失败（no provider found），而管理面一切正常。
    表现出来是"看得见、连得上、就是调不动"。
    """
    assert issubclass(CoworkScopedMCPProvider, ToolCapabilityProvider)
    assert not getattr(CoworkScopedMCPProvider, "__abstractmethods__", ())


def test_an_instance_passes_the_isinstance_gate(tmp_path):
    """光是子类还不够——实例也要过得了那道门（抽象方法没实现的话实例化就失败）。"""
    _, policy = _setup(tmp_path)
    g = _guard(_FakeMCP(), policy)
    assert isinstance(g, ToolCapabilityProvider)


def test_the_wrapper_covers_every_public_method_of_the_protocol():
    """**内核长出新方法就会静默漏一个洞。**

    内核以只读 wheel 交付且在持续更新。哪天协议多一个方法而包装器没覆盖，
    调用会直接落到被包的 provider 上——隔离静默失效，没有任何报错。

    ⇒ 拿包装器实际定义的方法集比对协议基类，少一个就红。
    这条测试的价值在升级内核的那一刻才显现，而那正是没人会想起检查的时刻。
    """
    protocol_methods = {
        n for n, _ in inspect.getmembers(ToolCapabilityProvider, callable)
        if not n.startswith("_")
    }
    ours = {
        n for n, _ in inspect.getmembers(CoworkScopedMCPProvider, callable)
        if not n.startswith("_")
    }
    missing = protocol_methods - ours
    assert missing == set(), (
        f"包装器没覆盖协议里的这些方法：{sorted(missing)}\n"
        "漏掉的方法会绕过隔离，且不报错"
    )


def test_the_name_is_passed_through(tmp_path):
    """内核按 name 建索引，包了之后名字不能变——变了等于换了个 provider。"""
    _, policy = _setup(tmp_path)
    g = _guard(_FakeMCP("tech-kb"), policy)
    assert g.name == "tech-kb"


def test_unknown_attributes_fall_through(tmp_path):
    """内核将来新增的方法照样能用（但"要不要过滤"靠上面那条测试管）。"""
    _, policy = _setup(tmp_path)
    inner = _FakeMCP()
    inner.some_new_thing = lambda: "ok"
    assert _guard(inner, policy).some_new_thing() == "ok"


# ── 行为：三个入口 ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_owned_server_is_visible(tmp_path):
    _, policy = _setup(tmp_path, use=("tech-kb",))
    g = _guard(_FakeMCP("tech-kb"), policy)
    assert await g.retrieve(_Ctx("ses-own")) == ["tech-kb:search"]
    assert await g.list(_Ctx("ses-own")) == ["tech-kb:search"]


@pytest.mark.asyncio
async def test_retrieve_is_filtered(tmp_path):
    """**模型手里有什么由 retrieve 说了算。** 漏了它，隔离等于没做。

    实测教训：只改 list 的后果是**两个 cowork 都说自己有全部工具**，
    而验证时看接口返回值是"正确"的——只有看模型手里的工具集才看得出来。
    """
    _, policy = _setup(tmp_path, use=("other",))
    g = _guard(_FakeMCP("tech-kb"), policy)
    assert await g.retrieve(_Ctx("ses-own")) == []


@pytest.mark.asyncio
async def test_list_is_filtered(tmp_path):
    _, policy = _setup(tmp_path, use=("other",))
    g = _guard(_FakeMCP("tech-kb"), policy)
    assert await g.list(_Ctx("ses-own")) == []


@pytest.mark.asyncio
async def test_invoke_is_refused(tmp_path):
    """**能力 id 可猜，看不见不等于拿不到。** 漏了它，边界只是体验不是权限。"""
    _, policy = _setup(tmp_path, use=("other",))
    inner = _FakeMCP("tech-kb")
    g = _guard(inner, policy)

    with pytest.raises(PermissionError, match="tech-kb"):
        await g.invoke("mcp:tech-kb:search", {}, _Ctx("ses-own"))
    assert "invoke" not in inner.calls, "被拦下的调用不该到达内层"


@pytest.mark.asyncio
async def test_a_refused_invoke_is_logged(tmp_path, caplog):
    """越权尝试要留痕——这是排查"这个 agent 为什么变笨了"的唯一线索（需求 K4）。"""
    _, policy = _setup(tmp_path, use=("other",))
    g = _guard(_FakeMCP("tech-kb"), policy)
    with caplog.at_level("INFO"):
        with pytest.raises(PermissionError):
            await g.invoke("x", {}, _Ctx("ses-own"))
    assert "越权" in caplog.text


@pytest.mark.asyncio
async def test_two_coworks_see_different_tools(tmp_path):
    """端到端：同一个 server，两条不同归属的会话看到的不一样。"""
    d = tmp_path / "coworks"
    for cid, use in (("ipmaster", ["tech-kb"]), ("mbb", ["mbb-kb"])):
        (d / cid).mkdir(parents=True)
        (d / cid / "cowork.json").write_text(
            json.dumps({"id": cid, "version": "1", "mcp": {"use": use}}), encoding="utf-8")
    scope = CoworkScope(d)
    scope.bind("ses-ip", "ipmaster")
    scope.bind("ses-mbb", "mbb")
    g = _guard(_FakeMCP("tech-kb"), CoworkPolicy(scope))

    assert await g.retrieve(_Ctx("ses-ip")) == ["tech-kb:search"]
    assert await g.retrieve(_Ctx("ses-mbb")) == [], "别人的工具不该看得到"


# ── 不设限的几种情形 ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_session_with_no_ownership_is_not_restricted(tmp_path):
    """**不知道归属时一律放行**：历史会话、母版会话、内部任务都属于这一类。

    收紧的话它们会突然一个工具都没有，而它们本来跑得好好的——
    那是一次静默的功能倒退，现象是"这个 agent 变笨了"，指不到这里。
    """
    _, policy = _setup(tmp_path, use=("other",))
    g = _guard(_FakeMCP("tech-kb"), policy)
    assert await g.retrieve(_Ctx("unknown-session")) == ["tech-kb:search"]
    assert await g.retrieve(_Ctx(None)) == ["tech-kb:search"]


@pytest.mark.asyncio
async def test_a_client_shipped_server_is_never_scoped(tmp_path):
    """**客户端自带的 MCP 不受套件声明约束**（需求 G6）。

    它随包发布、不需要云端配置，云端管理台里根本不会列出它。
    拿套件声明去卡它的结果是**所有 cowork 都失去这个工具**——实测踩过。
    """
    _, policy = _setup(tmp_path, use=("other",))
    g = _guard(_FakeMCP("browser-mcp"), policy, suite_delivered=False)
    assert await g.retrieve(_Ctx("ses-own")) == ["browser-mcp:search"]
    await g.invoke("browser-mcp:open", {}, _Ctx("ses-own"))     # 不抛


@pytest.mark.asyncio
async def test_no_policy_yet_means_pass_through(tmp_path):
    """策略在启动过程中才装配好，而 provider 可能更早创建。

    这段窗口里收紧的话，启动早期的调用会莫名其妙失败，而那与"没权限"长得一样。
    """
    g = CoworkScopedMCPProvider(_FakeMCP(), "tech-kb", lambda: None)
    assert await g.retrieve(_Ctx("ses")) == ["tech-kb:search"]


# ── 其余方法原样委托 ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_describe_and_cancel_are_delegated(tmp_path):
    """这两个不做过滤：describe 是管理面的元信息，cancel 只对已经发出的调用有意义
    （而那次调用早就过了 invoke 那道闸）。
    """
    _, policy = _setup(tmp_path, use=("other",))
    inner = _FakeMCP("tech-kb")
    g = _guard(inner, policy)
    assert await g.describe(_Ctx("ses-own")) == "info"
    assert await g.cancel("inv-1", _Ctx("ses-own")) is True
