"""市场注册表（重构第 6 步）。

"这个部署有哪几家市场"原先散在 api/deps.py：它自己 new 两个 adapter、自己检查两个 env
键、自己知道 mythos 的 SSL 跟随全局。那是让一个只该"把东西接起来"的地方装了一肚子关于
市场的知识——加第四家时要改它，而它跟市场毫无关系。

现在这些都在 adapters/registry.py 的一张表里。本文件钉住两件事：表驱动确实生效，
以及**行为与重构前一字不差**（没配的那家抛错、消息指向具体 env 键）。
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from netlivecowork.providers.capability.skills.adapters import registry
from netlivecowork.providers.capability.skills.adapters.base import SkillMarketAdapter


@dataclass
class _Settings:
    """只带 registry 用得到的那几个字段。"""

    skill_pull_server_url: str = "http://cowork.test/api"
    skill_mythos_base_url: str = "http://mythos.test"
    http_ssl_verify: bool = False


def test_builds_every_market_in_the_table():
    adapters = registry.build_all(_Settings())
    assert [a.name for a in adapters] == [m.name for m in registry.MARKETS]
    assert all(isinstance(a, SkillMarketAdapter) for a in adapters)


# ── 一家没配不连累其余几家 ────────────────────────────────────────────────────────
#
# 原先 build_all 是"任一家没配就抛"，于是 mythos 少配一行，cowork 也一起用不了、整个市场
# 接口 500。这与 SkillMarketService.catalog 里"一家拉取失败不影响其余几家"是同一条原则，
# 没理由"连不上"能降级、"没配"就全塌。


def test_unconfigured_market_is_skipped_not_fatal():
    adapters = registry.build_all(_Settings(skill_mythos_base_url=""))
    assert [a.name for a in adapters] == ["cowork"], "配好的那家必须照常可用"


def test_all_unconfigured_yields_empty_not_raise():
    """一家都没配 → 空列表。市场页显示"没有市场"，而不是抛给用户一个 500。"""
    adapters = registry.build_all(_Settings(skill_pull_server_url="", skill_mythos_base_url=""))
    assert adapters == []


def test_named_lookup_still_raises_with_the_env_key():
    """指名要某一家时仍严格报错——用户该看到的提示一句不少（对比上面的 build_all）。"""
    with pytest.raises(RuntimeError, match="NLC_SKILL_MYTHOS_BASE_URL"):
        registry.build_adapter("mythos", _Settings(skill_mythos_base_url=""))


# ── 可见性名单：不看配置、不造实例、不会抛 ────────────────────────────────────────


def test_per_user_sources_reads_the_table_not_the_config():
    """**这条是本次修复的核心**：地址没配时它照样答得出来。

    这份名单一度只能从活的 SkillMarketService 上问，而那个对象在任一市场没配时构造即抛
    → "已装 skill 列表"接口连带 500，连跟市场毫无关系的本地 skill 都看不见。
    """
    assert registry.per_user_sources() == {"mythos"}


def test_per_user_sources_takes_no_settings():
    """签名里没有 settings —— 从类型上就不可能因为"配置没读到"而失败。"""
    import inspect
    assert list(inspect.signature(registry.per_user_sources).parameters) == []


def test_unconfigured_market_still_counts_as_per_user():
    """保守方向：某家没配 ≠ 它的 skill 变成人人可见。

    否则 mythos 一停配，别人的 skill 就出现在你的列表里 —— 那是个放宽权限的错。
    名单来自静态表，与配置无关，所以这条天然成立。
    """
    adapters = registry.build_all(_Settings(skill_mythos_base_url=""))
    assert [a.name for a in adapters] == ["cowork"]      # mythos 确实没造出来
    assert "mythos" in registry.per_user_sources()       # 但它仍按人过滤


def test_names_match_the_source_values_used_in_references():
    """adapter.name 同时是引用记录里的 source。表里写错名字 = 用户数据对不上号。"""
    assert {a.name for a in registry.build_all(_Settings())} == {"cowork", "mythos"}


def test_unconfigured_market_points_at_its_env_key():
    """行为与重构前一致：没配就抛，且**消息指向具体那个 env 键**。

    这条是既有的有意设计（见 test_deps_skill_market_guard.py）：主程序照常启动，
    真正要用市场时才失败，且用户看了报错知道该去配哪一个。
    """
    with pytest.raises(RuntimeError, match="NLC_SKILL_MYTHOS_BASE_URL"):
        registry.build_adapter("mythos", _Settings(skill_mythos_base_url=""))

    with pytest.raises(RuntimeError, match="NLC_SKILL_PULL_SERVER_URL"):
        registry.build_adapter("cowork", _Settings(skill_pull_server_url=""))


def test_whitespace_only_url_counts_as_unconfigured():
    """.env 里写成 `NLC_SKILL_MYTHOS_BASE_URL=   ` 时，不该当成配好了。"""
    with pytest.raises(RuntimeError, match="NLC_SKILL_MYTHOS_BASE_URL"):
        registry.build_adapter("mythos", _Settings(skill_mythos_base_url="   "))


def test_unknown_market_name_is_explicit():
    """报错要列出认识哪几家——比一个 KeyError 好查得多。"""
    with pytest.raises(RuntimeError) as e:
        registry.build_adapter("nosuch", _Settings())
    assert "nosuch" in str(e.value)
    assert "cowork" in str(e.value) and "mythos" in str(e.value)


def test_ssl_verify_is_passed_through():
    """两家都跟随全局 http_ssl_verify —— 内网自签证书环境下这是能不能连上的前提。"""
    adapters = registry.build_all(_Settings(http_ssl_verify=True))
    assert all(a._ssl_verify is True for a in adapters)


def test_adding_a_market_is_one_row(monkeypatch):
    """**第 6 步的意义**：加一家市场只改这张表，装配层与市场层都不用动。"""

    class _Fake(SkillMarketAdapter):
        name = "extra"

        def list_catalog(self, ctx):
            return []

        def download_zip(self, remote_id, ctx):
            return b""

    extra = registry._MarketSpec(
        name="extra",
        url_of=lambda s: "http://extra.test",
        env_key="NLC_SKILL_EXTRA_URL",
        label="extra",
        build=lambda url, s: _Fake(),
        adapter_cls=_Fake,
    )
    monkeypatch.setattr(registry, "MARKETS", registry.MARKETS + (extra,))

    adapters = registry.build_all(_Settings())
    assert [a.name for a in adapters] == ["cowork", "mythos", "extra"]

    # 市场层照单全收，不认识 extra 也能用它
    from netlivecowork.providers.capability.skills.services.market import SkillMarketService

    svc = SkillMarketService(adapters=adapters, store=None)
    assert svc._require_adapter("extra") is adapters[-1]
