"""对账的领域逻辑 —— 该有哪几个 × 已装哪几个 → 装什么、跳过什么、删什么。

**纯函数：不碰网络、不碰文件、不记状态。** 这样分是因为需求 C5/C6/C7/C9/C10 那一串
（相等比较、没凭据就不删、失败不动、下载失败不算收回、用包自报的 id 算差集）
**全是纯逻辑，而且每一条错了都不报错**：

    写成"变大才装"       → 管理员回滚了，用户还在用新版
    没凭据当成空清单     → 把人家的套件连同改过的提示词删掉，不可逆
    用清单里的 id 算差集 → 装完立刻删掉，日志还理直气壮写"权限收回"

和 HTTP 缠在一起就只能靠起服务来测，实际结果是没人测。
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from .manifest import MASTER_ID


@dataclass(frozen=True)
class Plan:
    """一次对账算出来的动作。**只描述要做什么，不做。**"""

    #: 要装（或换版本）的：id → 版本
    install: dict[str, str] = field(default_factory=dict)
    #: 版本相同、跳过的：id → 版本
    skip: dict[str, str] = field(default_factory=dict)
    #: 要删的（权限被收回）
    remove: tuple[str, ...] = ()

    @property
    def is_noop(self) -> bool:
        return not self.install and not self.remove


def plan(
    *,
    entitled: frozenset[str] | None,
    installed: Mapping[str, str],
    available: Mapping[str, str],
) -> Plan:
    """算出这次要做什么。

    Args:
        entitled: **该有哪几个**。``None`` 表示"这次没拿到清单"——与"拿到了一张空清单"
            是两件完全不同的事，见下。
        installed: 本机已装的 id → 版本。
        available: 暂存目录里现有的包 id → 版本。**这里的 id 必须是包自己报的**，
            不是授权清单里的字段（需求 C10）。

    Returns:
        要装的、要跳过的、要删的。
    """
    # ── 该删的 ────────────────────────────────────────────────────────────────
    #
    # ⚠ **拿不到清单就一个都不删**（需求 C5/C7）。
    # "没拿到清单"与"拿到了一张空清单"必须区分：把网络故障当成权限被收回，后果是把用户的
    # 套件连同他改过的提示词删掉，**且不可逆**；反过来（该删没删）只是晚一次对账才生效。
    # 两个方向的错不对称，所以往安全的一侧偏。
    if entitled is None:
        remove: tuple[str, ...] = ()
    else:
        # 母版永远保留：它不是 cowork，没有谁的权限能收回它，而历史会话与内部任务都靠它
        # （需求 A8）。删了的表现是一批老会话集体跑不动，且原因完全指不到这里。
        remove = tuple(sorted(
            cid for cid in installed
            if cid != MASTER_ID and cid not in entitled
        ))

    # ── 该装的 ────────────────────────────────────────────────────────────────
    to_install: dict[str, str] = {}
    to_skip: dict[str, str] = {}

    for cid, version in sorted(available.items()):
        if cid == MASTER_ID:
            continue
        # 没授权的包就算摆在目录里也不装。否则开发机上堆着的包会变成"人人都有全量"，
        # 权限就失去意义了（需求 C13）。
        #
        # ⚠ **但"不知道该有哪几个"时照装不误** —— 与上面"不知道就不删"是同一条原则的
        # 两面，因为两个动作的可逆性不同：
        #
        #     装  可撤销（下次对账不在授权里就删掉了）
        #     删  不可逆，还会带走用户改过的提示词
        #
        # ⇒ 往能恢复的那一侧偏。这同时让开发态好用：往假云端目录里丢几个 zip 就能试，
        # 不必先伪造一份凭据文件。
        if entitled is not None and cid not in entitled:
            continue
        # ⚠ **相等比较，绝不能写成"变大才装"**（需求 C6）。
        # 云端下发的版本是递增整数，管理员回滚时它会**变小**；写成大于的现象是
        # "我明明回滚了他还在用新版"，而且不报错。
        if installed.get(cid) == version:
            to_skip[cid] = version
        else:
            to_install[cid] = version

    return Plan(install=to_install, skip=to_skip, remove=remove)


def entitled_from(agents: object) -> frozenset[str] | None:
    """把云端返回的授权清单收成一组 id。**认不出来就返回 None**（＝"没拿到"）。

    契约形状：``[{"agentId": "ipmaster", "version": 3}, ...]``

    ⚠ 返回 ``None`` 而不是空集合，是因为下游据此决定删不删（见 plan 的说明）。
    把解析失败当成"一张空清单"，就等于替对方做了"全部收回"的决定。
    """
    if not isinstance(agents, (list, tuple)):
        return None
    out: set[str] = set()
    for item in agents:
        if isinstance(item, Mapping):
            aid = str(item.get("agentId") or "").strip()
        else:
            aid = str(item or "").strip()
        if aid:
            out.add(aid)
    return frozenset(out)
