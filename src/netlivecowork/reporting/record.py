"""统一入口 —— **业务侧只认识这一个函数**。

    record("token_usage", {...}, session_id=sid)

它不认识出口、不认识重试、不认识扇出，也不认识"这条要发给哪个云"。
那些全在路由表与出口里；业务侧只负责说"这件事发生了，数据长这样"。

**为什么要有这一层**：今天上报逻辑和领域逻辑是缠在一起的——一个 903 行的文件里塞着
配置、签名、用户身份、领域语义、HTTP 重试、本地队列六件事，其中五件跟 skill 毫无关系。
要接第二个平台就得把那五件再抄一遍。

⚠ **这个函数绝不抛。** 打点不能影响业务（需求 T1）。分层之后风险反而变大：多了路由与
多个出口，任何一处抛出来都会污染调用点——所以这里兜一道，各出口内部再各自兜一道。

⚠ **它只收运营字段。** 排查细节走日志（需求 K6）：往打点里塞排查细节会让上报量爆掉、
且把本机路径带出去。
"""
from __future__ import annotations

import logging
import threading

from . import sinks
from .labels import Labels, labels_for_session
from .routing import Delivery, Route, resolve

logger = logging.getLogger(__name__)

#: 这个部署的路由表。装配时可覆盖；没覆盖过就在第一次用到时套用出厂默认。
_TABLE: tuple[Route, ...] = ()
#: 是否已被显式覆盖。**用标记而不是"表是不是空的"** —— 否则"我确实不要任何路由"
#: 这个意图表达不出来，每次都会被默认值顶回去。
_INSTALLED = False
_INSTALL_LOCK = threading.RLock()


def install_routes(table: tuple[Route, ...]) -> None:
    """装配期装入路由表，覆盖出厂默认。

    **不在模块里写死** —— 哪个 cowork 的哪类数据发给哪几个平台是部署配置，不是代码。
    传空表 = 明确表示"什么都不发"，此后不会再套用默认值。
    """
    global _TABLE, _INSTALLED
    with _INSTALL_LOCK:
        _TABLE = tuple(table)
        _INSTALLED = True


def routes() -> tuple[Route, ...]:
    _ensure_installed()
    return _TABLE


def reset() -> None:
    """只给测试用：回到"没装过"的状态。"""
    global _TABLE, _INSTALLED
    with _INSTALL_LOCK:
        _TABLE, _INSTALLED = (), False


def _ensure_installed() -> None:
    """没人显式装过就套用出厂默认。

    这一步是**保证与重构前行为一致**的关键：把"装路由表"做成装配期必须记得做的一步的话，
    任何没走到那步的路径都会静默地不再上报，而那和"上报了"在本地看起来一模一样。
    """
    global _TABLE, _INSTALLED
    if _INSTALLED:
        return
    with _INSTALL_LOCK:
        if _INSTALLED:
            return
        from .defaults import DEFAULT_ROUTES, install_default_sinks
        install_default_sinks()
        _TABLE = DEFAULT_ROUTES
        _INSTALLED = True


def record(
    kind: str,
    payload: dict,
    *,
    labels: Labels | None = None,
    session_id: str | None = None,
) -> int:
    """记一条运营数据。返回成功入队的份数（仅供记日志，**不要据此抛错**）。

    ``labels`` 不给就按 ``session_id`` 查；两个都不给就是"归属未知"。
    今天归属恒为空（见 labels.py），但**签名从第一天就带着它**，
    这样 cowork 那块建好之后，改一个文件就够，调用点一个都不用动。
    """
    try:
        _ensure_installed()
        lb = labels if labels is not None else labels_for_session(session_id)
        deliveries = resolve(kind, payload, lb, _TABLE)
        return sum(1 for d in deliveries if _enqueue(d))
    except Exception:
        # 到这里说明路由/归属本身出了问题。记日志，不往上抛。
        logger.exception("打点：record(%r) 失败，已忽略", kind)
        return 0


def _enqueue(delivery: Delivery) -> bool:
    sink = sinks.get(delivery.sink)
    if sink is None:
        # 路由表写了一个不存在的出口名。**这条数据就此消失**，所以必须记日志——
        # 拼错出口名在本地看起来与"正常发走了"一模一样。
        logger.warning(
            "打点：路由指向了不存在的出口 %r（已注册：%s），kind=%r 这条丢弃",
            delivery.sink, sinks.names(), delivery.kind,
        )
        return False
    try:
        return sink.enqueue(delivery)
    except Exception:
        logger.exception("打点：出口 %r 入队失败，kind=%r", delivery.sink, delivery.kind)
        return False
