"""能力策略 —— "这条会话能不能用这个东西"只有这一处实现。

包装器只问它一句话，不自己判断。所以这里的用例就是那几条判断规则本身。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork import installed
from netlivecowork.cowork.policy import CoworkPolicy
from netlivecowork.cowork.scope import CoworkScope


def install(root, cid, **over):
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "cowork.json").write_text(
        json.dumps({"id": cid, "version": "1", **over}), encoding="utf-8")


@pytest.fixture
def policy(tmp_path):
    install(tmp_path, "ipmaster",
            mcp={"use": ["tech-kb", "kb-net"]},
            llm={"allow": ["DS", "HIS"]},
            skills={"pullServerUrl": "", "mythosBaseUrl": "https://mythos"})
    install(tmp_path, "mbb",
            mcp={"use": []},
            skills={"pullServerUrl": "https://mbb-market"})
    install(tmp_path, "plain")           # 什么都没声明
    scope = CoworkScope(tmp_path)
    scope.bind("ses-ip", "ipmaster")
    scope.bind("ses-mbb", "mbb")
    scope.bind("ses-plain", "plain")
    return CoworkPolicy(scope)


# ── MCP：给了才有 ─────────────────────────────────────────────────────────────

def test_an_owned_server_is_allowed(policy):
    assert policy.allows_mcp("ses-ip", "tech-kb") is True


def test_a_server_owned_by_someone_else_is_denied(policy):
    assert policy.allows_mcp("ses-ip", "mbb-only") is False


def test_an_empty_mcp_use_gives_nothing(policy):
    """**MCP 是能力："明确给了才有"。** 空 = 一个都不给。"""
    assert policy.allows_mcp("ses-mbb", "tech-kb") is False


def test_a_cowork_with_no_mcp_section_gets_nothing(policy):
    assert policy.allows_mcp("ses-plain", "tech-kb") is False


def test_an_unknown_session_is_not_restricted(policy):
    """**不知道归属时一律放行**：历史会话、母版会话、内部任务都属于这一类。

    收紧的话它们会突然一个工具都没有——那是静默的功能倒退，
    现象是"这个 agent 变笨了"，指不到这里。
    """
    assert policy.allows_mcp("never-seen", "anything") is True
    assert policy.allows_mcp(None, "anything") is True


def test_mcp_of_reports_the_owned_set(policy):
    assert policy.mcp_of("ses-ip") == ("tech-kb", "kb-net")
    assert policy.mcp_of("ses-mbb") == ()
    assert policy.mcp_of("unknown") is None, "None 表示不设限，与空元组不同"


# ── LLM：没说就是都能用（与 MCP 刻意相反）────────────────────────────────────

def test_llm_allow_filters(policy):
    assert sorted(policy.filter_llm_accounts("ipmaster", ["DS", "HIS", "OTHER"])) == ["DS", "HIS"]


def test_an_empty_llm_allow_means_no_limit(policy):
    """**LLM 是资源选择："没说就是都能用"。**

    与 MCP 的空语义刻意相反：统一成一种的话，要么所有 cowork 都没模型可用，
    要么 MCP 权限形同虚设。
    """
    assert policy.allowed_llm_accounts("mbb") is None
    assert policy.filter_llm_accounts("mbb", ["A", "B"]) == ["A", "B"]


def test_an_unknown_cowork_is_not_limited(policy):
    assert policy.filter_llm_accounts("nosuch", ["A"]) == ["A"]
    assert policy.filter_llm_accounts(None, ["A"]) == ["A"]


def test_filtering_everything_away_is_logged_with_the_real_reason(policy, caplog):
    """界面上只会显示「没有可用模型」，而真实原因是套件里写了不存在的账号名。

    不记这条日志的话，排查会从"模型服务是不是挂了"开始，方向完全错（需求 G13）。
    """
    with caplog.at_level("WARNING"):
        assert policy.filter_llm_accounts("ipmaster", ["NOPE"]) == []
    assert "一个账号都不剩" in caplog.text
    assert "llm.allow" in caplog.text


def test_no_accounts_at_all_is_not_logged_as_a_config_error(policy, caplog):
    """本来就没有账号 ≠ 被过滤光了。前者不该报"套件配错了"。"""
    with caplog.at_level("WARNING"):
        assert policy.filter_llm_accounts("ipmaster", []) == []
    assert "一个账号都不剩" not in caplog.text


# ── 市场作用域 ────────────────────────────────────────────────────────────────

def test_market_scopes_follow_the_lineup_order_not_the_alphabet(tmp_path):
    """**页签次序必须与顶栏下拉里的 cowork 顺序一致。**

    曾经按 id 字母序：同一批 cowork 在技能中心和顶栏排两种样子，用户会以为自己看错了，
    而两处各自看都"正常"。`order` 是套件自己的属性（需求 A3），字母序等于把产品意图丢掉。

    这里故意让字母序与 order 相反 —— 不这样的话，两种实现都能过。
    """
    install(tmp_path, "zulu", order=10, skills={"mythosBaseUrl": "https://z"})
    install(tmp_path, "alpha", order=20, skills={"mythosBaseUrl": "https://a"})
    scope = CoworkScope(tmp_path)

    got = [s[0] for s in CoworkPolicy(scope).market_scopes()]
    assert got == ["zulu", "alpha"], "按 order 排，不是按名字"
    # 与阵容同一判据 —— 两处不该各排各的
    assert got == [c.id for c in installed.list_all(tmp_path)]


def test_market_scopes_lists_only_those_with_a_market(policy):
    """两个源都没配的 cowork 只用通用市场，**不该在市场页多出一个空页签**。"""
    got = policy.market_scopes()
    assert [s[0] for s in got] == ["ipmaster", "mbb"]


def test_market_scopes_keeps_both_source_kinds(policy):
    """两个源是**两种接口**，不是"公共/个人"之分——哪个挂在哪个 cowork 下由配置说了算。"""
    by_id = {s[0]: s for s in policy.market_scopes()}
    assert by_id["ipmaster"] == ("ipmaster", "", "https://mythos")
    assert by_id["mbb"] == ("mbb", "https://mbb-market", "")


# ── 可用性：推导，不写状态 ────────────────────────────────────────────────────

def test_availability_is_derived(policy, tmp_path):
    """**套件装回来，判断自己就变回可用**，没有任何标记要清（需求 I4）。

    这正是"权限恢复后只读会话自己活过来"的基础。
    """
    import shutil

    assert policy.is_available("agent:mbb") is True
    shutil.rmtree(tmp_path / "mbb")
    policy._scope.reload()
    assert policy.is_available("agent:mbb") is False

    install(tmp_path, "mbb")
    policy._scope.reload()
    assert policy.is_available("agent:mbb") is True, "装回来必须自动可用"


def test_availability_accepts_both_id_forms(policy):
    assert policy.is_available("ipmaster") is True
    assert policy.is_available("agent:ipmaster") is True


def test_an_unknown_template_is_unavailable(policy):
    assert policy.is_available("agent:nosuch") is False
    assert policy.is_available("") is False
    assert policy.is_available(None) is False
