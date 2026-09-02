"""市场作用域 —— **市场页上的一个页签**。

一个作用域底下最多挂两个源。两个源不是"公共 vs 个人"之分，**只是两套接口**：

    cowork 形态   全量、无鉴权
    mythos 形态   分页、带用户头、按人可见

谁挂在哪个作用域下**由配置说了算**，代码里不对"哪个源该属于谁"做任何假设 ——
业务侧确认过一次：按名字猜正好猜反了（`netlivecowork` 是**通用**市场，
`ipmastermythos` 才是 IPMaster 的市场）。

## 与 registry 那张表的区别

    registry.MARKETS   这个**部署**认识哪几种市场接口（两种）
    本模块             这台机器上有哪几个**页签**（通用 + 每个有独立市场的 cowork）

两个维度，所以分开。混在一张表里的话，加一个 cowork 就要动"有哪几种接口"那份声明。

## 地址为什么随套件走、不进环境变量

一个用户可能同时开通好几个 cowork，每个各有各的市场。放环境变量则每新开通一个就要
改一次部署配置，改漏一处就是阵容不同（需求 H1）。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, replace

logger = logging.getLogger(__name__)

#: 固定的第一个页签。它的地址来自部署配置，不属于任何 cowork。
GENERAL_SCOPE = "general"


@dataclass(frozen=True)
class MarketScope:
    """市场页上的一个页签。"""

    #: 作用域 id。通用页签是 ``general``，其余是 cowork id。
    id: str
    #: 从这里引来的 skill 归给谁。通用页签给通配（谁都能用）。
    label: str
    cowork_url: str = ""
    mythos_url: str = ""
    #: 地址相同而被**合并进**这个页签的 profile id（含页签自己的 id）。
    #: 预置作用域解析靠它把"被合并的 profile"映射到保留页签，而不是一律退回 general。
    profile_ids: tuple[str, ...] = ()

    @property
    def has_source(self) -> bool:
        return bool(self.cowork_url or self.mythos_url)


def build_scopes(
    general_cowork_url: str,
    general_mythos_url: str,
    per_cowork: list[tuple[str, str, str]],
) -> list[MarketScope]:
    """算出市场页有哪几个页签。

    Args:
        general_cowork_url / general_mythos_url: 通用页签的两个源（来自部署配置）。
        per_cowork: 每个已装 cowork 的 (id, cowork 源, mythos 源)。

    **地址相同的合并成一个页签**（需求 H2）：否则用户看到两个一模一样的。
    合并时保留通用页签那一个 —— 它是固定存在的那个；被合并的 cowork id 记进
    保留页签的 ``profile_ids``，预置作用域解析据此把它的预置算到这个页签头上。
    """
    general = MarketScope(
        id=GENERAL_SCOPE,
        label="*",              # 通用页签引来的 skill 谁都能用
        cowork_url=(general_cowork_url or "").strip(),
        mythos_url=(general_mythos_url or "").strip(),
    )
    out = [general]
    seen: dict[tuple[str, str], int] = {(general.cowork_url, general.mythos_url): 0}

    for cid, cowork_url, mythos_url in per_cowork:
        key = ((cowork_url or "").strip(), (mythos_url or "").strip())
        if key == ("", ""):
            # 两个源都没配的 cowork 只用通用市场，**不该多出一个空页签**（需求 H3）。
            continue
        if key in seen:
            retained = out[seen[key]]
            out[seen[key]] = replace(
                retained, profile_ids=retained.profile_ids + (cid,),
            )
            logger.info("skills：cowork %r 的市场地址与已有页签相同，合并", cid)
            continue
        seen[key] = len(out)
        out.append(MarketScope(
            id=cid, label=cid, cowork_url=key[0], mythos_url=key[1], profile_ids=(cid,),
        ))

    return out


def label_of(scopes: list[MarketScope], scope_id: str) -> str:
    """从某个页签引来的 skill 归给谁。

    **归属由"从哪个页签引的"决定，不再弹框追问**（需求 H5）：
    用户点的那个页签已经表达了意图，再问一次只会让人对着两处描述同一件事。
    """
    for s in scopes:
        if s.id == scope_id:
            return s.label
    return "*"
