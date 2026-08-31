"""能力策略 —— **这条会话能不能用这个东西**。

包装器只问它一句话，不自己判断；判断的依据全部来自套件的声明。
这样"什么算拥有"只有一处实现，加一种能力时不必再想一遍。

## 两条空语义**刻意相反**

    mcp.use  为空  →  一个都不给      能力："明确给了才有"
    llm.allow 为空 →  不限制          资源："没说就是都能用"

统一成一种的话：要么所有 cowork 都没模型可用，要么 MCP 权限形同虚设。
⚠ 这条差异务必保留，且两边注释都要写明 —— 否则下一个人会来"统一"它。
"""
from __future__ import annotations

import logging

from .manifest import Cowork
from .scope import CoworkScope

logger = logging.getLogger(__name__)


class CoworkPolicy:
    """按会话归属回答能力问题。**不碰文件、不碰网络**，只读 scope 里的套件声明。"""

    def __init__(self, scope: CoworkScope) -> None:
        self._scope = scope

    # ── MCP ───────────────────────────────────────────────────────────────────

    def allows_mcp(self, session_id: str | None, server_name: str) -> bool:
        """这条会话能不能用这个 MCP server。

        **不知道归属时一律放行**：可能是历史会话、母版会话或内部任务。
        收紧的话，那些会话会突然一个工具都没有，而它们本来就跑得好好的 ——
        那是一次静默的功能倒退，且现象是"这个 agent 变笨了"，指不到这里。

        ⚠ 与"归属未知不匹配具名路由"（打点那边）**方向相反**，因为后果不同：
        那边多发一份数据不可撤销；这边少给一个工具是可见的功能倒退。
        """
        cowork = self._scope.cowork_of(session_id)
        if cowork is None:
            return True
        return server_name in set(cowork.mcp_use)

    def mcp_of(self, session_id: str | None) -> tuple[str, ...] | None:
        """这条会话拥有哪几个 MCP。`None` = 不知道归属（不设限）。"""
        cowork = self._scope.cowork_of(session_id)
        return cowork.mcp_use if cowork else None

    # ── LLM ───────────────────────────────────────────────────────────────────

    def allowed_llm_accounts(self, cowork_id: str | None) -> set[str] | None:
        """这个 cowork 允许哪些账号。`None` = 不限制。

        **空的 `llm.allow` 就是"不限制"**（与 MCP 相反，见模块说明）。
        """
        cowork = self._scope.suite(cowork_id)
        if cowork is None or not cowork.llm_allow:
            return None
        return set(cowork.llm_allow)

    def default_llm(self, cowork_id: str | None) -> tuple[str, str] | None:
        """这个 cowork 的默认账号与模型。`None` = 它没意见，用全局默认。

        套件写了 `llm.default` 就用它；只写了 `llm.allow` 没写默认 → 取允许列表里的
        第一个。**后者不能省**：不给回落的话，不允许全局默认账号的 cowork 会根本建不了
        会话（用户不选模型时用全局默认，而它过不了归属闸）。
        """
        cowork = self._scope.suite(cowork_id)
        if cowork is None:
            return None
        if cowork.llm_default_account:
            return cowork.llm_default_account, cowork.llm_default_model
        if cowork.llm_allow:
            return cowork.llm_allow[0], ""
        return None

    def filter_llm_accounts(self, cowork_id: str | None, names: list[str]) -> list[str]:
        """按 cowork 过滤账号名。

        **过滤完一个不剩时要记日志说明真实原因**（需求 G13）：界面上只会显示
        "没有可用模型"，而真实原因是套件里写了不存在的账号名。
        """
        allowed = self.allowed_llm_accounts(cowork_id)
        if allowed is None:
            return list(names)
        out = [n for n in names if n in allowed]
        if names and not out:
            logger.warning(
                "cowork %r 的 llm.allow=%s 过滤后一个账号都不剩（现有：%s）；"
                "界面会显示「没有可用模型」，但真实原因是套件里的账号名对不上",
                cowork_id, sorted(allowed), sorted(names),
            )
        return out

    # ── 市场 ──────────────────────────────────────────────────────────────────

    def market_scopes(self) -> list[tuple[str, str, str]]:
        """所有已装 cowork 的市场作用域：(cowork_id, cowork 源地址, mythos 源地址)。

        只列**至少配了一个源**的。两个都没配的 cowork 只用通用市场，
        不该在市场页多出一个空页签。

        ⚠ **次序必须与阵容一致**（`installed.list_all` 的 `(order, id)`）。
        这里曾经按 id 字母序，于是技能中心的页签排列与顶栏下拉里的 cowork 顺序对不上 ——
        同一批东西在两个地方排两种样子，用户会以为自己看错了，而两处各自看都"正常"。
        `order` 是套件自己的属性（需求 A3），字母序等于把产品意图丢掉。
        """
        suites = [self._scope.suite(cid) for cid in self._scope.installed_ids()]
        return [
            (c.id, c.skill_market_url, c.skill_mythos_url)
            for c in sorted(
                (c for c in suites if c and (c.skill_market_url or c.skill_mythos_url)),
                key=lambda c: (c.order, c.id),
            )
        ]

    # ── 可用性（给会话与界面用）──────────────────────────────────────────────

    def is_available(self, template_id: str | None) -> bool:
        """这个模板现在可用吗（＝对应套件装着吗）。

        **推导，不写状态**（需求 I4）：套件装回来，判断自己就变回可用，
        没有任何标记要清。
        """
        from .manifest import bare_id
        cid = bare_id(str(template_id or "")).strip()
        return bool(cid) and cid in self._scope.installed_ids()
