"""对账的总装 —— 把纯逻辑、暂存目录、装/删接起来。

**这是唯一一处"真的会改变本地状态"的地方。** 上面几层各自都很克制：
`entitlement` 只算不做、`install` 只做被点名的事、`staging` 只读写一个凭据文件。
接起来的地方只有这里，所以要保证的那几条也集中在这里：

    拿不到凭据 → 一个都不删（entitlement.plan 保证）
    版本相等   → 跳过（同上）
    装失败     → 不算被收回（apply 保证）

## 开发期怎么用

`NLC_COWORK_PACKAGES_DIR` 指向一个本地目录当**假云端**（需求 C12）。
它与真下发**共用这同一段代码**，区别只是那个目录里的 zip 从哪来。

⚠ **不配这个变量就一个 cowork 都没有**（需求 C13）：任何"没配就给你全量"的兜底
都会让权限失去意义，本地也就验不出"某人只有两个"这种场景到底对不对。
"""
from __future__ import annotations

import logging
from pathlib import Path

from . import install, staging, installed
from .entitlement import Plan, plan
from .install import InstallResult

logger = logging.getLogger(__name__)


def reconcile(staging_dir: Path, coworks_dir: Path) -> InstallResult:
    """对一次账：读暂存目录 → 算差集 → 装/删。

    调用时机（需求 C2）：启动时一次，之后每天一次。真实取包由客户端主进程完成，
    它取完之后调这里（"光问不装等于白问"）。
    """
    staging_dir, coworks_dir = Path(staging_dir), Path(coworks_dir)

    entitled = staging.read_entitled(staging_dir)
    packages, unreadable = install.scan(staging_dir)
    # 变量名躲开模块名：`installed` 现在是"已装清单"那个模块。
    on_disk = installed.versions(coworks_dir)

    the_plan = plan(
        entitled=entitled,
        installed=on_disk,
        # ⚠ **用包自报的 id**，不是文件名、也不是清单里的字段（需求 C10）。
        # 两者一旦不一致，拿别的字段算差集会装完立刻删掉，
        # 而日志还会理直气壮地写"权限收回"。
        available={cid: ver for cid, (ver, _) in packages.items()},
    )

    result = install.apply(the_plan, packages, coworks_dir)
    if unreadable:
        result.failed.update(unreadable)

    _log(the_plan, result, entitled_known=entitled is not None)
    return result


def _log(the_plan: Plan, result: InstallResult, *, entitled_known: bool) -> None:
    """**"什么都没做"的分支也要留日志**（需求 K2）。

    `对账失败 → 一动不动` 与 `拿到空清单 → 全删` 在文件系统上是天壤之别，
    而在没有日志时它们看起来一模一样（都是"我的 cowork 不见了"或"没变化"）。
    """
    if not entitled_known:
        logger.info("cowork：没有授权凭据，本次不增不删（对账未成功，或是手工摆的目录）")
    if result.installed:
        logger.info("cowork：已安装 %s", result.installed)
    if the_plan.skip:
        # 版本相等而跳过 —— 这是"改了内容却没改版本"时唯一的线索（需求 C7/K1）。
        logger.info("cowork：版本相同已跳过 %s", the_plan.skip)
    if result.removed:
        logger.info("cowork：权限收回，已删除 %s", list(result.removed))
    if result.failed:
        logger.warning("cowork：本次有失败项 %s", result.failed)
    if not (result.installed or result.removed or result.failed):
        logger.info("cowork：本次无变化")
