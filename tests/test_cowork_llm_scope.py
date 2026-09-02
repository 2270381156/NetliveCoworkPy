"""LLM 账号按 cowork 归属（llm.allow）。

两层，缺一不可：

    /llms?cowork=   选择器里显示什么   —— 只有它 = **边界只是体验**
    建会话 / 恢复换模型  能不能真用      —— 绕过界面直接调接口走的是这条

只做第一层的后果不报错：用户在界面上确实选不到，但任何直接调接口的路径（脚本、
旧版前端、复制来的 curl）照样能指定任意账号，且一路跑通。
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from netlivecowork.api import cowork_bridge, sessions as sessions_api


class _Policy:
    """假策略：ipmaster 只许 A/B，coremaster 只许 C，别的 cowork 不设限。"""

    ALLOW = {"ipmaster": {"A", "B"}, "coremaster": {"C"}}

    def filter_llm_accounts(self, cowork_id, names):
        allowed = self.ALLOW.get(cowork_id)
        return list(names) if allowed is None else [n for n in names if n in allowed]


@pytest.fixture
def policy(monkeypatch):
    import netlivecowork.cowork.runtime as rt
    monkeypatch.setattr(rt, "get_policy", lambda: _Policy())
    yield


@pytest.fixture
def no_policy(monkeypatch):
    import netlivecowork.cowork.runtime as rt
    monkeypatch.setattr(rt, "get_policy", lambda: None)
    yield


# ── 第一层：列表 ─────────────────────────────────────────────────────────────


def test_the_bridge_filters_by_cowork(policy):
    assert cowork_bridge.allowed_llm_accounts("ipmaster", ["A", "B", "C"]) == ["A", "B"]
    assert cowork_bridge.allowed_llm_accounts("coremaster", ["A", "B", "C"]) == ["C"]


def test_no_cowork_means_no_filtering(policy):
    """配置页问的是"这台机器上有哪些账号"，与归属无关。"""
    assert cowork_bridge.allowed_llm_accounts(None, ["A", "C"]) == ["A", "C"]
    assert cowork_bridge.allowed_llm_accounts("", ["A", "C"]) == ["A", "C"]


def test_an_empty_allow_list_means_unrestricted(policy):
    """**与 mcp.use 的空语义故意相反**（需求 G8）：工具是权限，不写 = 一个都不给；
    模型是资源，不写 = 套件没意见。写反了两边都不报错——一边所有 cowork 都没工具，
    另一边权限形同虚设。"""
    assert cowork_bridge.allowed_llm_accounts("mbb", ["A", "C"]) == ["A", "C"]


def test_no_policy_falls_open(no_policy):
    """启动早期收紧的话，界面会显示"没有可用模型"，而那与"套件里没配"长得一模一样。"""
    assert cowork_bridge.allowed_llm_accounts("ipmaster", ["A", "C"]) == ["A", "C"]


def test_a_broken_policy_falls_open(monkeypatch):
    import netlivecowork.cowork.runtime as rt

    def boom():
        raise RuntimeError("策略还没装好")

    monkeypatch.setattr(rt, "get_policy", boom)
    assert cowork_bridge.allowed_llm_accounts("ipmaster", ["A", "C"]) == ["A", "C"]


# ── 第二层：真正的闸 ─────────────────────────────────────────────────────────


def test_the_bridge_translates_template_id_to_cowork_id(policy):
    """翻译（`agent:ipmaster` → `ipmaster`）必须留在 bridge 这一侧：接口层放一次
    `bare_id` 就等于它认识 cowork 了，而依赖规则挡的正是这个。"""
    assert cowork_bridge.llm_allowed("agent:ipmaster", "A") is True
    assert cowork_bridge.llm_allowed("agent:ipmaster", "C") is False


def test_the_gate_refuses_an_account_this_cowork_cannot_use(policy):
    """看不见 ≠ 用不了。这条挡的是"绕过界面直接调接口"。"""
    with pytest.raises(HTTPException) as ei:
        sessions_api._refuse_llm_not_allowed("agent:coremaster", "A")
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "LLM_NOT_ALLOWED"


def test_the_gate_lets_an_allowed_account_through(policy):
    sessions_api._refuse_llm_not_allowed("agent:coremaster", "C")   # 不抛


def test_the_gate_ignores_sessions_with_no_cowork(policy):
    """母版会话、历史会话、内部任务 —— 没有归属就没有"越权"这回事。"""
    sessions_api._refuse_llm_not_allowed(None, "A")
    sessions_api._refuse_llm_not_allowed("", "A")


def test_the_gate_ignores_a_missing_account(policy):
    """没指定账号 = 用默认的，不是越权。"""
    sessions_api._refuse_llm_not_allowed("agent:coremaster", None)
    sessions_api._refuse_llm_not_allowed("agent:coremaster", "")


def test_the_gate_also_covers_resume(policy):
    """**恢复时换模型也要过闸**：只在建会话时校验的话，建一个合规会话再 resume 换成
    别的账号就整条绕过去了——而那正是"选错模型"最常发生的地方。

    这里钉的是"恢复路径调了同一个闸"，靠源码里那处调用；调用没了这条不会红，
    所以下面那条 test_resume_calls_the_gate 才是真检查。"""
    with pytest.raises(HTTPException):
        sessions_api._refuse_llm_not_allowed("agent:ipmaster", "C")


def test_resume_calls_the_gate():
    """恢复路径里必须真的调了这道闸——删掉那行调用，上面那条测试照样绿。"""
    import inspect
    src = inspect.getsource(sessions_api.resume_session)
    assert "_refuse_llm_not_allowed" in src, (
        "恢复会话时换模型没过归属闸：建一个合规会话再 resume 换账号就绕过去了"
    )


# ── 缺省账号：不给回落的话，某些 cowork 根本建不了会话 ──────────────────────────
#
# 这一组是 Playwright 的 AC-6 当场撞出来的：coremaster 的 llm.allow 里没有全局默认账号，
# 于是"不选模型直接建会话"被自己的归属闸拦成 403 —— 这个 cowork 谁也用不了，
# 而现象（403 LLM_NOT_ALLOWED）看起来像权限配错，不像缺省回落漏了。


class _PolicyWithDefaults(_Policy):
    DEFAULT = {"coremaster": ("C", "model-c")}
    ALLOW_ONLY = {"mbb": ("D",)}

    def default_llm(self, cowork_id):
        if cowork_id in self.DEFAULT:
            return self.DEFAULT[cowork_id]
        if cowork_id in self.ALLOW_ONLY:
            return self.ALLOW_ONLY[cowork_id][0], ""
        return None


@pytest.fixture
def policy_with_defaults(monkeypatch):
    import netlivecowork.cowork.runtime as rt
    monkeypatch.setattr(rt, "get_policy", lambda: _PolicyWithDefaults())
    yield


def test_the_suite_default_is_used_when_the_user_picked_nothing(policy_with_defaults):
    assert cowork_bridge.default_llm("agent:coremaster") == ("C", "model-c")


def test_a_suite_with_only_allow_falls_back_to_the_first_allowed(policy_with_defaults):
    """只写了 allow 没写 default —— 不回落的话这个 cowork 照样建不了会话。"""
    assert cowork_bridge.default_llm("agent:mbb") == ("D", "")


def test_a_cowork_with_no_opinion_leaves_the_global_default_alone(policy_with_defaults):
    assert cowork_bridge.default_llm("agent:ipmaster") is None
    assert cowork_bridge.default_llm(None) is None


def test_create_session_asks_the_cowork_before_falling_back_to_the_global_default():
    """建会话路径必须真的问了这一句——删掉那行，上面几条照样绿。"""
    import inspect
    src = inspect.getsource(sessions_api.create_session)
    assert "default_llm" in src, (
        "建会话没问 cowork 的缺省账号：llm.allow 里没有全局默认账号的 cowork 会直接 403，"
        "整个 cowork 谁都用不了"
    )


def test_the_manifest_reads_both_shapes_of_llm_default():
    """`llm.default` 云端两种写法都可能下发：字符串（只给账号）或对象（账号 + 模型）。
    只认一种的话另一种被静默读成"没有默认"，表现是每次新建会话都得自己选模型。"""
    from netlivecowork.cowork.manifest_parse import parse

    base = {"schema": 1, "id": "x", "version": "1", "branding": {"displayName": "X"}}
    as_str = parse({**base, "llm": {"allow": ["A"], "default": "A"}})
    assert (as_str.llm_default_account, as_str.llm_default_model) == ("A", "")

    as_obj = parse({**base, "llm": {"allow": ["A"], "default": {"account": "A", "model": "m1"}}})
    assert (as_obj.llm_default_account, as_obj.llm_default_model) == ("A", "m1")

    none = parse({**base, "llm": {"allow": ["A"]}})
    assert none.llm_default_account == ""


# ── 套件自带的 LLM 账号（清单 llm.define）──────────────────────────────────────
#
# 云端下发的清单里带这一段：账号名 → style / base_url / api_key(enc:v1:) / 模型表。
# 原先整个不读，后果不是"少个字段"：`llm.allow` 里的名字指的就是这里定义的账号，
# 不注册的话过滤后一个不剩 —— 界面显示「没有可用模型」，而真实原因是账号从没装进来。


def _suite(llm: dict) -> dict:
    return {"schema": 1, "id": "x", "version": "1",
            "branding": {"displayName": "X"}, "llm": llm}


def test_llm_define_is_parsed():
    from netlivecowork.cowork.manifest_parse import parse

    m = parse(_suite({"allow": ["A"], "define": {"A": {
        "style": "openai", "api_key": "enc:v1:XYZ", "base_url": "http://h/v1",
        "default_model": "m1", "timeout_sec": 60,
        "models": [{"model": "m1", "context_limit": 200000, "output_reserve": 8192}],
    }}}))
    (d,) = m.llm_define
    assert (d.name, d.style, d.base_url, d.default_model, d.timeout_sec) == (
        "A", "openai", "http://h/v1", "m1", 60)
    assert d.models[0].context_limit == 200000
    assert d.models[0].output_reserve == 8192


def test_the_api_key_is_passed_through_untouched():
    """**不在这一层解密**：下发的是 enc:v1: 密文，解密归 providers/llm/secret。
    在清单层动它只会多出一处能把密钥读进内存的地方。"""
    from netlivecowork.cowork.manifest_parse import parse

    m = parse(_suite({"define": {"A": {"style": "openai", "api_key": "enc:v1:XYZ"}}}))
    assert m.llm_define[0].api_key == "enc:v1:XYZ"


def test_the_key_never_shows_up_in_repr():
    """dataclass 默认的 repr 会把整个对象打出来，而一条 exc_info=True 的 warning
    就足以把密钥写进日志文件（K7 / NFR-8）。"""
    from netlivecowork.cowork.manifest_parse import parse

    m = parse(_suite({"define": {"A": {"style": "openai", "api_key": "sk-super-secret"}}}))
    text = repr(m.llm_define[0]) + repr(m.llm_define)
    assert "sk-super-secret" not in text
    assert "redacted" in text


def test_an_incomplete_entry_is_skipped_not_fatal():
    """运行期容忍缺字段（A7）：装都装上了才发现清单少个字段，此时拒绝启动的代价
    远大于跳过这一条。"""
    from netlivecowork.cowork.manifest_parse import parse

    m = parse(_suite({"define": {
        "good": {"style": "openai", "api_key": "k"},
        "no-key": {"style": "openai"},
        "no-style": {"api_key": "k"},
        "not-a-dict": "oops",
    }}))
    assert [d.name for d in m.llm_define] == ["good"]


def test_a_default_model_without_a_model_table_still_yields_one():
    """只给 default_model 没给 models 时要补一条 —— 否则这个账号注册出来一个模型都没有，
    界面上选得到账号却选不到模型。"""
    from netlivecowork.cowork.manifest_parse import parse

    m = parse(_suite({"define": {"A": {
        "style": "openai", "api_key": "k", "default_model": "m9"}}}))
    assert [x.model for x in m.llm_define[0].models] == ["m9"]


def test_no_define_section_is_fine():
    from netlivecowork.cowork.manifest_parse import parse

    assert parse(_suite({"allow": ["A"]})).llm_define == ()
    assert parse(_suite({})).llm_define == ()


def test_suite_accounts_are_registered_without_persisting():
    """**不落盘**：这些账号属于 cowork 不属于用户。写进账号库的话，权限收回后账号还留着，
    而它带着可用的凭据 —— 一次实打实的越权，且没有任何现象提示。"""
    from netlivecowork.bootstrap import host_runtime
    from netlivecowork.cowork.manifest import LLMAccountDef, LLMModelDef

    class _Provider:
        def __init__(self):
            self.calls = []
            self.origins = {}

        def drop_accounts_of_origin(self, origin):
            return []

        def is_registered(self, name):
            return name == "already-here"

        def register_account(self, account, *, persist=True):
            self.calls.append((account.name, account.api_key, persist))

        def mark_origin(self, name, origin):
            self.origins[name] = origin

    class _Suite:
        llm_define = (
            LLMAccountDef(name="from-suite", style="openai", api_key="sk-plain",
                          base_url="http://h", default_model="m",
                          models=(LLMModelDef(model="m"),)),
            LLMAccountDef(name="already-here", style="openai", api_key="k"),
        )

    class _Scope:
        def installed_ids(self): return {"c1"}
        def suite(self, cid): return _Suite()

    import netlivecowork.cowork.runtime as rt
    real = rt.get_scope
    rt.get_scope = lambda: _Scope()
    try:
        p = _Provider()
        host_runtime._register_cowork_llm_accounts(p)
    finally:
        rt.get_scope = real

    assert p.calls == [("from-suite", "sk-plain", False)], "必须 persist=False"
    from netlivecowork.providers.llm.llm_provider import ORIGIN_SUITE
    assert p.origins == {"from-suite": ORIGIN_SUITE}, (
        "套件账号必须标来源 —— 它是 `llm.allow` 的判据，也决定锁不锁"
    )


def test_a_locally_configured_account_wins_over_the_suite():
    """同名冲突时本机优先 —— 用户自己配的账号不该被下发覆盖掉。
    上一条里 `already-here` 没被注册，就是这条。"""
    # 断言写在上一条的 p.calls 里（只有 from-suite），此处留作命名说明。


# ── `allow` 只约束统一交付的那批 ───────────────────────────────────────────────
#
# 实测踩到：套件的 allow 把用户**自己配的**账号也过滤掉了，他在两个 cowork 里都选不到
# 自己的模型，而唯一的解法是去求云端改套件。判据是**来源**（出厂 / 套件下发 / 用户自己），
# 不是"锁没锁"、更不是"key 加没加密"。

MANAGED = {"A", "B", "C"}          # 出厂 + 套件下发
MINE = "my-own"                    # 用户自己注册的


def test_a_users_own_account_is_never_filtered_out(policy):
    """云端下发的一份清单没道理没收用户自己机器上配的模型。"""
    out = cowork_bridge.allowed_llm_accounts(
        "ipmaster", ["A", "B", "C", MINE], managed=MANAGED)
    assert MINE in out


def test_delivered_accounts_are_still_scoped(policy):
    """放行用户自己的，不等于不管了：受管那批照旧按 allow 分。"""
    out = cowork_bridge.allowed_llm_accounts(
        "ipmaster", ["A", "B", "C", MINE], managed=MANAGED)
    assert [n for n in out if n in MANAGED] == ["A", "B"]


def test_the_order_is_preserved(policy):
    """选择器里的顺序不该因为过滤而重排 —— 用户会以为自己看错了。"""
    out = cowork_bridge.allowed_llm_accounts(
        "ipmaster", ["C", MINE, "A", "B"], managed=MANAGED)
    assert out == [MINE, "A", "B"], "C 不在 ipmaster 的 allow 里，其余保持原次序"


def test_not_passing_managed_keeps_the_old_strict_behaviour(policy):
    """漏传的地方宁可严一点：放宽是静默的，收紧是看得见的。"""
    out = cowork_bridge.allowed_llm_accounts("ipmaster", ["A", "B", "C", MINE])
    assert MINE not in out


def test_the_gate_uses_the_same_rule_as_the_list(policy):
    """**两处必须同一条规则**：不一致的话会出现"选择器里有、选了却 403"，
    而两处各自看都"正常"。"""
    assert cowork_bridge.llm_allowed("agent:ipmaster", MINE, managed=MANAGED) is True
    assert cowork_bridge.llm_allowed("agent:ipmaster", "C", managed=MANAGED) is False


def test_origin_not_lockedness_is_the_criterion():
    """locked 说的是"界面禁删禁改"（一个行为），今天与来源恰好重合。
    拿它当判据的话，哪天为别的理由锁一个账号，模型可见性会跟着悄悄变，且不报错。"""
    from netlivecowork.providers.llm.llm_provider import (
        ORIGIN_FACTORY, ORIGIN_SUITE, ORIGIN_USER, LLMProvider,
    )

    p = LLMProvider.__new__(LLMProvider)
    p._account_origin = {}
    p._locked_account_names = set()

    p.mark_origin("f", ORIGIN_FACTORY)
    p.mark_origin("s", ORIGIN_SUITE)
    p.mark_origin("u", ORIGIN_USER)

    assert p.managed_account_names() == {"f", "s"}
    assert p.account_origin("never-seen") == ORIGIN_USER, "没记过的一律算用户自己的"
    assert "u" not in p._locked_account_names, "用户自己的账号不该被锁"


# ── 对账之后账号要一并重建（需求 F5）────────────────────────────────────────
#
# 实测踩到：收回一个 cowork 之后，它下发的账号还挂在后端，**且带着可用的凭据**。
# 账号只在开机那条路上登记，运行期对账重建了阵容/归属/市场路由，唯独漏了这一路。
# 重启才干净（账号不落盘），但"要重启才对"本身就是个静默故障。


def test_dropping_by_origin_clears_every_table():
    """四张表要一起清。漏一张的表现各不相同：漏 adapter 会留一个连得上的客户端；
    漏来源会让下次重建时它被当成"用户自己的"，从此再也撤不掉。"""
    from netlivecowork.providers.llm.llm_provider import (
        ORIGIN_FACTORY, ORIGIN_SUITE, LLMProvider,
    )

    p = LLMProvider.__new__(LLMProvider)
    p._accounts = {"f": object(), "s": object()}
    p._adapters = {"f": object(), "s": object()}
    p._account_origin = {"f": ORIGIN_FACTORY, "s": ORIGIN_SUITE}
    p._locked_account_names = {"f", "s"}

    assert p.drop_accounts_of_origin(ORIGIN_SUITE) == ["s"]
    for table in (p._accounts, p._adapters, p._account_origin):
        assert "s" not in table and "f" in table
    assert p._locked_account_names == {"f"}, "锁定名单也要清 —— 否则名字回来时是个幽灵"


def test_rebuilding_drops_the_old_suite_accounts_first():
    """**先撤后装**，不是"只删被收回那一个"：一次对账可能同时装了新套件、改了别的版本，
    逐个算差集要再写一套判断，而那套判断与开机那条路是两份代码，早晚不一致。"""
    from netlivecowork.bootstrap import host_runtime
    from netlivecowork.providers.llm.llm_provider import ORIGIN_SUITE

    dropped = []

    class _Provider:
        def drop_accounts_of_origin(self, origin):
            dropped.append(origin)
            return []

        def is_registered(self, name):
            return False

        def register_account(self, account, *, persist=True):
            pass

        def mark_origin(self, name, origin):
            pass

    class _Scope:
        def installed_ids(self): return set()
        def suite(self, cid): return None

    import netlivecowork.cowork.runtime as rt
    real = rt.get_scope
    rt.get_scope = lambda: _Scope()
    try:
        host_runtime._register_cowork_llm_accounts(_Provider())
    finally:
        rt.get_scope = real

    assert dropped == [ORIGIN_SUITE], "重建之前没先撤掉旧的套件账号"


@pytest.mark.asyncio
async def test_recheck_rebuilds_the_accounts(monkeypatch):
    """对账路径必须真的重建账号 —— 漏了的话，收回一个 cowork 之后它下发的账号还挂着，
    而且凭据可用。

    **钉行为，不钉源码文本。** 这条原先断言 `recheck_coworks` 的源码里出现
    "rebuild_cowork_llm_accounts"——那把测试焊在了"这一步写在哪个函数里"上。
    刷新清单收敛进 apply_cowork_state 之后它就红了，而功能完全正常。
    现在改成：跑一遍对账路径该调的那个函数，看重建有没有真的发生。
    """
    from netlivecowork.bootstrap import host_runtime

    called = []
    monkeypatch.setattr(host_runtime, "rebuild_cowork_llm_accounts",
                        lambda: called.append("llm"))
    monkeypatch.setattr(host_runtime, "_register_suite_mcp_servers", lambda: None)
    await host_runtime.apply_cowork_state()

    assert called == ["llm"], (
        "对账后没重建 LLM 账号：收回一个 cowork 之后，它下发的账号还挂着且凭据可用"
    )
