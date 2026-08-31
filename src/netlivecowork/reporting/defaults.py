"""出厂默认：出口与路由 —— **它就是重构前的行为**。

⚠ 这一份存在的唯一理由是**安全**：切到 ``record()`` 之后，一条数据发不发得出去取决于
有没有匹配的路由。若把"装路由表"做成装配期必须记得做的一步，那么任何一条没走到那步的
路径（测试、单跑脚本、将来新加的入口）都会**静默地不再上报**——而"没上报"和"上报了"
在本地看起来一模一样。

⇒ 所以默认值内置在代码里，不配置也照常工作，且与重构前逐字段一致：

    token_usage                    → token-usage-spool.jsonl（主进程代发）
    step_failed / task_failed      → telemetry-spool.jsonl（主进程代发）
    skill_usage                    → Datalink（后端直发）

装配期可以用 ``record.install_routes()`` 覆盖（真正的多平台路由由部署配置决定）；
覆盖过就不会再套用这里的默认值，**包括覆盖成空表**——那是"我确实不要任何路由"。
"""
from __future__ import annotations

from . import sinks
from .routing import Route
from .sinks.relay import RelaySink

#: 主进程正在读的那两个文件。**名字不能改**：两边不是一起发布的，
#: 改了这边，装着旧主进程的机器就再也上报不了，且不报错。
TOKEN_USAGE_SPOOL = "token-usage-spool.jsonl"
TELEMETRY_SPOOL = "telemetry-spool.jsonl"

RELAY_TOKEN_USAGE = "relay:token-usage"
RELAY_TELEMETRY = "relay:telemetry"

#: 与重构前一一对应。加平台不在这里加——这里只负责"不配置也和以前一样"。
SINK_DATALINK = "datalink"

DEFAULT_ROUTES: tuple[Route, ...] = (
    Route(kind="skill_usage", sink=SINK_DATALINK),
    Route(kind="token_usage", sink=RELAY_TOKEN_USAGE),
    Route(kind="step_failed", sink=RELAY_TELEMETRY),
    Route(kind="task_failed", sink=RELAY_TELEMETRY),
)


def install_default_sinks() -> None:
    """注册出厂出口。重复调用无副作用（按名字覆盖同一个）。"""
    sinks.register(RelaySink(RELAY_TOKEN_USAGE, TOKEN_USAGE_SPOOL))
    sinks.register(RelaySink(RELAY_TELEMETRY, TELEMETRY_SPOOL))
    # 后端直发那一类：用这个部署自己的 AK/SK，不需要用户令牌
    from .sinks.datalink import sink as _datalink_sink
    sinks.register(_datalink_sink())
