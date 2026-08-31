"""路由与扇出 —— 这条数据要发给哪几个平台，各自看得到哪些字段。

**一个 cowork 的数据可能要发给几个平台**，所以路由的结果是**一组**，不是一个。

扇出发生在**入队之前**：一条记录按路由复制成 N 条待发项，此后各走各的重试、
各有各的失败计数。为什么不能"一条记录发给多个平台"再统一记状态：

    发给 A 成功、发给 B 失败  →  整条重试  →  **A 收到重复**

代价是存储放大 N 倍——打点数据量小，可接受。

**字段投影不只是挑字段，也是脱敏。** 同一条数据发给不同平台，可见字段可能不同
（比如某个平台不该看到用户名）。⚠ **这必须写在路由表里，不能靠各发送器自觉** ——
自觉的失效方式是"多发了一个字段"，而它不报错。
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

from .labels import Labels

logger = logging.getLogger(__name__)

#: 通配：匹配任意值。
ANY = "*"


@dataclass(frozen=True)
class Route:
    """一条路由规则：什么样的数据、发给哪个出口、给它看哪些字段。"""

    #: 记录类型（``token_usage`` / ``skill_usage`` / …）。``*`` 匹配全部
    kind: str
    #: 出口名，见 sinks 注册表
    sink: str
    #: 按归属筛。``*`` 匹配全部；**空串只匹配"归属为空"**，不匹配任意
    cowork: str = ANY
    #: 字段投影：只发这几个字段。``None`` = 全发
    #: **这是脱敏点**，不是性能优化——列出来的才发得出去
    fields: tuple[str, ...] | None = None


@dataclass(frozen=True)
class Delivery:
    """一条待发项 = 一条记录发给一个平台。"""

    #: 同一条记录扇出的几条共享它 —— 跨平台对账时靠它认出"同一件事"
    record_id: str
    #: 这一条独有 —— 出口重试时下游靠它去重
    delivery_id: str
    kind: str
    sink: str
    labels: Labels
    payload: dict = field(default_factory=dict)


def _matches(route: Route, kind: str, labels: Labels) -> bool:
    if route.kind != ANY and route.kind != kind:
        return False
    if route.cowork == ANY:
        return True
    return route.cowork == labels.cowork


def _project(payload: dict, fields: tuple[str, ...] | None) -> dict:
    """按投影裁剪。缺失的字段直接不出现，**不补空值**。

    补空值会让下游分不清"没这个字段"和"这个字段是空的"。
    """
    if fields is None:
        return dict(payload)
    return {k: payload[k] for k in fields if k in payload}


def resolve(
    kind: str,
    payload: dict,
    labels: Labels,
    table: tuple[Route, ...],
    *,
    record_id: str | None = None,
) -> list[Delivery]:
    """把一条记录扇出成若干待发项。

    没有任何路由匹配时返回空列表**并记一条日志** —— 否则这条数据静默消失，
    而"没配路由"与"发出去了"在本地看起来一模一样。
    """
    rid = record_id or uuid.uuid4().hex
    out = [
        Delivery(
            record_id=rid,
            delivery_id=uuid.uuid4().hex,
            kind=kind,
            sink=r.sink,
            labels=labels,
            payload=_project(payload, r.fields),
        )
        for r in table
        if _matches(r, kind, labels)
    ]
    if not out:
        logger.warning(
            "打点：没有路由匹配 kind=%r cowork=%r，这条数据不会被发出去", kind, labels.cowork
        )
    return out
