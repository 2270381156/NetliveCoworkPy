"""按配置装出"这个部署有哪几家技能市场"。

**"有哪几家"这件事只写在这里。** 装配层（``api/deps.py``）原先自己 new 两个 adapter、
自己检查两个 env 键、自己知道 mythos 要 SSL 跟随全局——那是让一个只该负责"把东西接起来"
的地方，装了一肚子关于市场的知识。加第四家市场时要改它，而它跟市场毫无关系。

现在装配层只问这里要一组 adapter。加一家市场 = 往下面的表里加一行。

**指名要某一家而它没配 → 抛 RuntimeError，消息指向具体的 env 键**（``build_adapter``）。
这是既有的有意设计：主程序照常启动，真要用那家时才失败，且用户看了知道该去配哪一个。

**但"把认识的几家都装出来"（``build_all``）不再因为其中一家没配就全军覆没**：没配的那家
跳过并记一条日志，配好的照常工作。原先是只要 mythos 没配，连 cowork 也用不了——整个市场
接口 500。这跟 ``SkillMarketService.catalog`` 里"一家拉取失败不影响其余几家"是同一条原则，
只是那边管"连不上"、这边管"没配"，没理由两种表现。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

from .base import VISIBILITY_PER_USER, SkillMarketAdapter
from .cowork import CoworkMarketAdapter
from .mythos import MythosMarketAdapter
from .scopes import MarketScope, build_scopes

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _MarketSpec:
    """一家市场：怎么从配置里取地址、地址缺了报什么、怎么造出来。"""

    name: str
    #: 从 settings 取地址的方式。取到空串/None 视为未配置。
    url_of: Callable[[Any], str]
    #: 未配置时报错里要指向的环境变量名 —— 用户看了知道该去配哪一个。
    env_key: str
    #: 人话名字，用在报错消息里。
    label: str
    build: Callable[[str, Any], SkillMarketAdapter]
    #: adapter 的类。留着它是为了**不造实例也能读到这家的固有性质**（目前只有可见性）：
    #: 地址没配时实例造不出来，但"这家按不按人分"照样要能回答。见 per_user_sources。
    adapter_cls: type[SkillMarketAdapter]


#: 这个部署认识的所有市场。**加一家就在这里加一行**，别处不用改。
#: 顺序即目录里的默认排列顺序（市场层随后会按时间重排）。
MARKETS: tuple[_MarketSpec, ...] = (
    _MarketSpec(
        name="cowork",
        url_of=lambda s: s.skill_pull_server_url,
        env_key="NLC_SKILL_PULL_SERVER_URL",
        label="cowork",
        build=lambda url, s: CoworkMarketAdapter(server_url=url, ssl_verify=s.http_ssl_verify),
        adapter_cls=CoworkMarketAdapter,
    ),
    _MarketSpec(
        name="mythos",
        url_of=lambda s: s.skill_mythos_base_url,
        env_key="NLC_SKILL_MYTHOS_BASE_URL",
        # mythos 是 HTTPS 内网服务，SSL 校验跟随全局 http_ssl_verify（默认关）。
        label="mythos",
        build=lambda url, s: MythosMarketAdapter(base_url=url, ssl_verify=s.http_ssl_verify),
        adapter_cls=MythosMarketAdapter,
    ),
)


def build_adapter(name: str, settings: Any) -> SkillMarketAdapter:
    """按名字造一家。地址没配 → RuntimeError，消息指向那一家的 env 键。"""
    spec = next((m for m in MARKETS if m.name == name), None)
    if spec is None:
        raise RuntimeError(f"未知的技能市场：{name}（认识的有 {[m.name for m in MARKETS]}）")
    url = (spec.url_of(settings) or "").strip()
    if not url:
        raise RuntimeError(f"{spec.label} 技能市场未配置：请在 .env 设置 {spec.env_key}")
    return spec.build(url, settings)


def build_all(settings: Any) -> list[SkillMarketAdapter]:
    """把**配好的**几家都造出来；没配的跳过并记日志，不连累其余几家。

    别改回"有一家没配就抛"：那样 mythos 空一个字符串，cowork 也一起没了。指名要某一家
    时的严格报错仍在 ``build_adapter``，用户该看到的提示一句不少。
    """
    out: list[SkillMarketAdapter] = []
    for spec in MARKETS:
        if not (spec.url_of(settings) or "").strip():
            logger.info("%s 技能市场未配置（%s 为空），跳过这一家", spec.label, spec.env_key)
            continue
        out.append(spec.build((spec.url_of(settings) or "").strip(), settings))
    return out


# ── 某个 cowork 自带的市场 ────────────────────────────────────────────────────
#
# 上面那张表是**这个部署**的市场（读 env）。除此之外，每个 cowork 套件还能自带市场地址
# （cowork.json 的 skills.pullServerUrl / mythosBaseUrl）——那是"开通了这个 cowork 才看得
# 见的市场"，属于权限，不属于部署配置。
#
# ⚠ **本模块不认识 cowork**（依赖规则：providers 不许 import netlivecowork.cowork）。
# 名单由装配层在启动时注入一个函数，本模块只管把它给的三元组造成 adapter。没注入 = 这个
# 构建没有 cowork 这一层，一切照旧。


@dataclass(frozen=True)
class CoworkMarket:
    """一个 cowork 自带的市场地址。两个 URL 都可能为空串（那一家就不造）。"""

    cowork_id: str
    display_name: str
    pull_server_url: str
    mythos_base_url: str


#: 装配层注入：返回"当前已装且至少配了一个市场地址的 cowork"。
_cowork_markets: Callable[[], list[CoworkMarket]] | None = None


def install_cowork_markets(fn: Callable[[], list[CoworkMarket]] | None) -> None:
    """装配层在启动时调一次。传 None 撤销（测试用）。"""
    global _cowork_markets
    _cowork_markets = fn


def cowork_markets() -> list[CoworkMarket]:
    """当前有自己市场的 cowork。**绝不抛** —— 市场页签少一个，不该让整个接口 500。"""
    if _cowork_markets is None:
        return []
    try:
        return list(_cowork_markets())
    except Exception:
        logger.warning("取 cowork 市场名单失败，按「没有」处理", exc_info=True)
        return []


def build_for_cowork(cowork_id: str, settings: Any) -> list[SkillMarketAdapter]:
    """造出某个 cowork 自带的那几家。

    地址取自套件而非 env，其余（SSL 等）仍跟随部署配置：那些是"这台机器怎么发请求"，
    与"这个 cowork 指向哪个市场"是两件事。

    认不出这个 cowork（没装 / 没配市场）→ 空列表。调用方据此回空目录，而不是报错：
    权限被收回时页签本来就会消失，这里再抛一次只是把同一件事说成故障。
    """
    m = next((c for c in cowork_markets() if c.cowork_id == cowork_id), None)
    if m is None:
        return []
    out: list[SkillMarketAdapter] = []
    for spec in MARKETS:
        url = (m.pull_server_url if spec.name == "cowork" else m.mythos_base_url).strip()
        if url:
            out.append(spec.build(url, settings))
    return out


def per_user_sources() -> set[str]:
    """哪些市场是"按登录用户可见"的。

    **只看表，不看配置** —— 不需要 settings、不造实例、不会抛。这一点是有意的：列表过滤
    在市场不可用时**照样必须正确**。原先这份名单只能从活的 ``SkillMarketService`` 上问，
    于是 mythos 地址一空，"已装 skill 列表"接口连带 500，本地 skill 一起看不见。

    保守方向也对：某家没配 → 它的引用仍按"按人可见"过滤，不会因为市场暂时不可用就把
    别人的 skill 露出来。
    """
    return {m.name for m in MARKETS if m.adapter_cls.visibility == VISIBILITY_PER_USER}


def market_scopes(settings: Any) -> list[MarketScope]:
    """这台机器上有哪几个市场页签 —— **数据，不是 adapter 实例**。

    预置协调器解析作用域只用数据：协调发生在启动期、不访问网络，也不该因为某家
    地址没配/SSL 配置出错而炸掉。``build_scopes`` 只算一遍；地址合并（H2）与
    空页签剔除（H3）的规则与市场页签完全同一份，不会两处漂移。
    """
    def _global_url(name: str) -> str:
        spec = next((m for m in MARKETS if m.name == name), None)
        return (spec.url_of(settings) or "").strip() if spec else ""

    per_cowork = [
        (m.cowork_id, (m.pull_server_url or "").strip(), (m.mythos_base_url or "").strip())
        for m in cowork_markets()
    ]
    return build_scopes(_global_url("cowork"), _global_url("mythos"), per_cowork)
