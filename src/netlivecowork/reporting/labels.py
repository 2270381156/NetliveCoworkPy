"""归属 —— 这条打点数据属于谁。

当初留这一层，是为了让调用点从第一天就带上归属参数：等 cowork 那边的会话归属表建好，
**只要填这一个文件，上游一个调用点都不用改**。现在兑现了——本次改动只动了这里。

反过来（先不带、以后再补）要回头改每一处打点，而打点散在事件订阅、会话处理等好几条
路径上，漏一处不报错——只是那类数据永远没有归属，分账时才发现。

⚠ **不要在这里自己拼归属。** 归属只有一个来源：cowork 那边的会话归属表。
自己拼就有两套判断，而它们必然在某个分支上不一致——现象是"权限对了但账算错了"，
反过来也可能，且两边都不报错。

⚠ **本模块不 import cowork**（架构设计 §7 的依赖规则：reporting/ 不得依赖 cowork）。
装配的地方喂进来一个取值函数；没喂就是"归属未知"，与从前一样。
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Labels:
    """一条数据的归属。空串表示"不知道"，不表示"属于所有人"。

    这个区别在路由里有用：**不知道归属时不该被"发给某个 cowork 的平台"那条规则匹配上**，
    否则数据会流向不该去的平台。
    """

    cowork: str = ""
    account: str = ""

    def is_empty(self) -> bool:
        return not self.cowork and not self.account


EMPTY = Labels()

#: 会话 → 归属。由装配的地方喂进来（bootstrap 里那一处）。
_resolver: "Callable[[str], Labels] | None" = None


def install_resolver(fn: "Callable[[str], Labels] | None") -> None:
    """装配期接上归属来源。不接就是"归属未知"，行为与接之前一样。"""
    global _resolver
    _resolver = fn


def reset() -> None:
    """只给测试用。"""
    install_resolver(None)


def labels_for_session(session_id: str | None) -> Labels:
    """按会话取归属。取不到一律返回空。

    ⚠ **绝不抛**：打点不能影响业务。归属这一步失败最多是"这条数据没有归属"，
    绝不能让它把调用点带下去。
    """
    if not session_id or _resolver is None:
        return EMPTY
    try:
        return _resolver(session_id) or EMPTY
    except Exception:
        logger.debug("打点：取会话 %s 的归属失败，按未知处理", session_id, exc_info=True)
        return EMPTY
