"""进程级的那一份 —— 装配时建好，各处取用。

**只有取值函数，没有逻辑。** 逻辑在 scope / policy 里；这里存在的理由是
provider 可能比策略更早创建（装配顺序所致），所以传给它们的是取值函数而不是实例。
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from .policy import CoworkPolicy
from .scope import CoworkScope

logger = logging.getLogger(__name__)

_scope: CoworkScope | None = None
_policy: CoworkPolicy | None = None
#: 对账跑过了吗。
#:
#: ⚠ **"还没对账"与"对账了但一个都没装"必须分开**（需求 I9）：
#: 两者在数据上都是"清单为空"，但处置相反——
#:   还没对账 → 什么都不判（此时判只读会把一次网络抖动显示成"你的权限被收回了"）
#:   对账过了 → 确实一个都没有，该判就判
_reconciled = False


def setup(coworks_dir: Path, *, reconciled: bool = False) -> CoworkPolicy:
    """装配期建好这一份。重复调用会重建（测试与热更新用）。

    `reconciled` 表示这次装配之前**跑过对账**——见 `_reconciled` 的说明。
    """
    global _scope, _policy, _reconciled
    _reconciled = reconciled
    _scope = CoworkScope(coworks_dir)
    _policy = CoworkPolicy(_scope)
    logger.info("cowork：已装 %d 个 —— %s",
                len(_scope.installed_ids()), sorted(_scope.installed_ids()))
    return _policy


def get_scope() -> CoworkScope | None:
    return _scope


def get_policy() -> CoworkPolicy | None:
    """给包装器用的取值函数。**返回 None 时包装器一律放行** ——
    那是"策略还没装配好"，收紧的话启动早期的调用会莫名其妙失败。
    """
    return _policy


def reset() -> None:
    """只给测试用。"""
    global _scope, _policy, _reconciled
    _scope = _policy = None
    _reconciled = False


def lineup_known() -> bool:
    """阵容确知了吗（对账跑过、或者已经装着东西）。

    装着东西就算确知：那说明至少对过一次账，只是这次可能没连上。
    """
    if _reconciled:
        return True
    return bool(_scope is not None and _scope.installed_ids())


def reload() -> None:
    """套件装/删之后重读。**不调的话能力判断停在旧快照上**（需求 F5）。"""
    if _scope is not None:
        _scope.reload()


def client_shipped_mcp_names() -> frozenset[str]:
    """客户端自带的 MCP 名字 —— 它们**不受套件声明约束**（需求 G6）。

    这些随包发布、不需要云端配置，云端管理台里根本不会列出它们。
    拿套件的 `mcp.use` 去卡它们的结果是**所有 cowork 都失去这些工具** —— 实测踩过。

    名单来源：环境变量（部署可改），缺省是随包那个浏览器工具。
    """
    raw = (os.getenv("NLC_CLIENT_SHIPPED_MCP") or "browser-mcp").strip()
    return frozenset(n.strip() for n in raw.split(",") if n.strip())
