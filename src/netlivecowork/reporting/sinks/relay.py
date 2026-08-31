"""主进程代发 —— 写进一个本地文件，Electron 来取走再发。

**为什么必须绕这一道**：这条路要用**用户令牌**，而令牌只存在主进程的安全存储里
（系统密钥库的接口只有主进程能调）。后端拿不到，所以它只能把数据摆好，由主进程送出去。

⚠ **文件名与格式不能改**：主进程正在读 ``telemetry-spool.jsonl`` /
``token-usage-spool.jsonl``，一行一个 ``{event_type, ts, …}``。
两边不是一起发布的——改了这边，装着旧主进程的机器就再也上报不了，且不报错。

⇒ 因此一个 spool 文件一个出口实例，注册成不同的名字（``relay:token-usage`` 等），
让"发到哪个文件"由路由表说了算，而不是在出口里判断记录类型。
"""
from __future__ import annotations

from .. import spool
from ..routing import Delivery
from .base import Sink


class RelaySink(Sink):
    """把一条数据追加进指定的 spool 文件，等主进程来取。"""

    def __init__(self, name: str, spool_file: str) -> None:
        self.name = name
        self._spool_file = spool_file

    @property
    def spool_file(self) -> str:
        return self._spool_file

    def enqueue(self, delivery: Delivery) -> bool:
        # 写出的形状必须与历史一致：event_type 取记录类型，其余字段平铺。
        # **不要把 delivery_id / record_id 塞进去** —— 主进程按字段名转发给云端，
        # 多出来的字段会一路传到对端，而对端的字段是有约定的。
        return spool.append(self._spool_file, delivery.kind, delivery.payload)

    def __repr__(self) -> str:  # pragma: no cover - 只为排查好读
        return f"RelaySink(name={self.name!r}, file={self._spool_file!r})"
