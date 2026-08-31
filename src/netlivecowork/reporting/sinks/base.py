"""出口的契约 —— 一个平台一个出口。

出口只管"把这一条送出去"，不管它是怎么来的、归属是谁、要不要发给别人。

**两类出口，凭据不同，谁发也不同**：

    后端直发    用这个部署自己的凭据（AK/SK）      后端发
    主进程代发  用**用户令牌**                     Electron 发

⚠ 第二类不是历史包袱：用户令牌只存在主进程的安全存储里，后端拿不到。
任何"统一成后端直发"的方案都会撞上它，而撞上之后的常见做法是把令牌递给后端——
那正好破坏"令牌不出主进程"这条安全要求。
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..routing import Delivery


class Sink(ABC):
    """一个出口。"""

    #: 出口名，路由表里用它指代
    name: str = ""

    @abstractmethod
    def enqueue(self, delivery: Delivery) -> bool:
        """把这一条放进这个出口的队列。**绝不抛** —— 打点不能影响业务。

        返回是否入队成功，仅供上层记日志/计数。
        """
