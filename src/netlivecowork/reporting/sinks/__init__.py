"""出口注册表 —— **加一个平台就在这里加一行**。

保持它是一张表而不是散在各处的 if：加平台时改一处，且"这个部署有哪几个出口"
一眼能看全。
"""
from __future__ import annotations

from .base import Sink
from .relay import RelaySink

#: 出口名 → 出口。名字要与路由表里写的一致，**拼错的表现是"没有路由匹配"**
#: （routing.resolve 会记一条日志），不是报错。
_SINKS: dict[str, Sink] = {}


def register(sink: Sink) -> None:
    _SINKS[sink.name] = sink


def get(name: str) -> Sink | None:
    return _SINKS.get(name)


def names() -> list[str]:
    return sorted(_SINKS)


def reset() -> None:
    """只给测试用。"""
    _SINKS.clear()


__all__ = ["Sink", "RelaySink", "register", "get", "names", "reset"]
