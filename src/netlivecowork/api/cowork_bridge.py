"""接口层与 cowork 之间**唯一的那一处**。

## 为什么收成一个文件

依赖规则（架构设计 §7）只允许接口层有一处认识 cowork。那个"一处"防的不是文件数，
而是**权限判断散开**——散开之后，"绕过界面直接调接口能不能拿到没权限的东西"
就没人能回答了。

所以接口层的各个模块都问这里，不各自去找 cowork：

    登记归属      建会话时（写）
    推导只读      会话响应里那个字段（读）
    可用性校验    建会话前的那道闸

## 三条共同的规矩

**① 绝不因此抛错。** cowork 这一层出问题时，最坏的结果应当是"没做隔离"，
   而不是"接口挂了"。

**② 没有 cowork 这一层时行为如常。** 衍生品牌可能就是单 agent 形态（架构设计 D2）。

**③ 判断只推导，不写状态**（需求 I4）：套件装回来，那些判断自己就变回可用。
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _scope():
    """取会话归属表；没有 cowork 这一层就返回 None。"""
    try:
        from netlivecowork.cowork.runtime import get_scope
        return get_scope()
    except Exception:
        return None


def bind_session(session_id: str, template_id: str | None) -> None:
    """登记这条会话属于哪个 cowork。**绝不因此挡住建会话。**

    ⚠ 这只是缓存：查不到登记时 scope 会回查会话自己的模板。
    正确性不依赖"每条创建路径都记得调这里"——重启后恢复的会话没走过创建路径，
    而漏掉它们的表现是那些会话看得见全部能力，且不报错。
    """
    try:
        s = _scope()
        if s is not None:
            s.bind(session_id, template_id)
    except Exception:
        logger.debug("cowork：登记会话归属失败 %s", session_id, exc_info=True)


def is_readonly(template_id: str | None) -> bool:
    """这条会话还能不能继续。判据：**它的 cowork 此刻在不在已装清单里**。

    母版会话不算只读（留给历史会话与内部任务）。

    ⚠ **只在阵容确知时才判**（需求 I9）："还没对账"与"对账了但一个都没装"
    在数据上都是"清单为空"，但处置相反——前者什么都不判，
    否则一次网络抖动会显示成"你的权限被收回了"，而后端其实好好的。
    """
    try:
        from netlivecowork.cowork.manifest import MASTER_ID, bare_id

        s = _scope()
        if s is None:
            return False
        from netlivecowork.cowork.runtime import lineup_known

        cid = bare_id(str(template_id or "")).strip()
        if not cid:
            return False
        if cid == MASTER_ID:
            # 母版归属（agent:default）= agent 上线**之前**的历史会话。它们实际归属上一代
            # agent（legacy_agent_id，如 ipmaster）——迁移过来时前端也是这么归类的。
            # 此前一律豁免，导致"用户一个 cowork 权限都没有时，这些历史会话仍是正常状态"
            # （用户明确要它们归档）。改为**按 legacy agent 判**：有它的权限就正常、没有就归档。
            from netlivecowork.config import get_settings
            legacy = (get_settings().legacy_agent_id or "").strip()
            if not legacy:
                return False   # 没配 legacy（派生品牌 / 无历史）→ 维持旧豁免，向后兼容
            cid = legacy
        if not lineup_known():
            return False
        return cid not in s.installed_ids()
    except Exception:
        return False


def allowed_llm_accounts(
    cowork_id: str | None,
    names: list[str],
    *,
    managed: set[str] | None = None,
) -> list[str]:
    """这个 cowork 能用哪几个 LLM 账号。

    ## `allow` 只约束**统一交付**的那批（`managed` = 出厂 + 套件下发）

    账号按**来源**分两类（见 providers/llm/llm_provider 的 ORIGIN_*）：

        出厂 / 套件下发    统一交付的，套件说用哪几个就用哪几个
        用户自己注册的     **他自己机器上的东西**

    把 `allow` 套到后者上，等于云端下发的一份清单**没收了用户自己配的模型**：
    他加一个自己的 key 想调试点什么，突然在所有 cowork 里都选不到，
    而唯一的解法是去求云端改套件 —— 完全不成比例。实测踩到过。

    ⚠ 判据是**来源**，不是"锁没锁"、更不是"key 加没加密"。locked 说的是
    界面禁删禁改（一个行为），今天与来源恰好重合，拿它当判据的话，
    哪天为别的理由锁一个账号，模型可见性会跟着悄悄变。

    `managed` **不传 = 全部当受管**（老行为）：漏传的地方宁可严一点，
    因为放宽是静默的、收紧是看得见的。

    ⚠ **不设限时返回全部**，与 MCP 的空语义**故意相反**（需求 G8）：
    `mcp.use` 为空 = 一个都不给（工具是权限）；`llm.allow` 为空 = 不限（模型是资源，
    套件不写就是"没意见"）。两者写反的后果都不报错 —— 一边是所有 cowork 都没工具，
    另一边是权限形同虚设。

    取不到策略一律不过滤：收紧的话启动早期会显示"没有可用模型"，而那与"套件里没配"
    长得一模一样。
    """
    try:
        from netlivecowork.cowork.runtime import get_policy

        policy = get_policy()
        if policy is None:
            return list(names)
        scoped = list(names) if managed is None else [n for n in names if n in managed]
        kept = set(policy.filter_llm_accounts((cowork_id or "").strip() or None, scoped))
        if managed is not None:
            kept |= {n for n in names if n not in managed}     # 用户自己的，一律放行
        # 保持原次序：选择器里的顺序不该因为过滤而重排。
        return [n for n in names if n in kept]
    except Exception:
        logger.debug("cowork：LLM 归属过滤失败，本次不过滤", exc_info=True)
        return list(names)


def default_llm(template_id: str | None) -> tuple[str, str] | None:
    """这条会话该用哪个 LLM 账号 / 模型。`None` = 这个 cowork 没意见，用全局默认。

    **只在用户没自己选的时候问**：他选了就按他的来（选错了自有 `llm_allowed` 去拦）。
    """
    try:
        from netlivecowork.cowork.manifest import bare_id
        from netlivecowork.cowork.runtime import get_policy

        policy = get_policy()
        if policy is None:
            return None
        cid = bare_id(str(template_id or "")).strip()
        return policy.default_llm(cid) if cid else None
    except Exception:
        logger.debug("cowork：取默认模型失败，用全局默认", exc_info=True)
        return None


def llm_allowed(
    template_id: str | None, account: str | None, *, managed: set[str] | None = None,
) -> bool:
    """这条会话的 cowork 允不允许用这个 LLM 账号。

    **翻译（template_id → cowork id）必须留在这一侧**：接口层放一次 `bare_id` 就等于
    它认识 cowork 了，而依赖规则挡的正是这个——散开之后"绕过界面直接调接口能不能拿到
    没权限的东西"就没人能回答了（见本模块开头）。

    没有归属（母版、历史会话、内部任务）或没指定账号 → 一律放行：那不是"越权"，
    是"这件事跟归属无关"。
    """
    try:
        from netlivecowork.cowork.manifest import bare_id

        if not account:
            return True
        cid = bare_id(str(template_id or "")).strip()
        if not cid:
            return True
        # **与列表过滤必须同一条规则**：不一致的话会出现"选择器里有、选了却 403"，
        # 而两处各自看都"正常"。
        return account in allowed_llm_accounts(cid, [account], managed=managed)
    except Exception:
        logger.debug("cowork：LLM 归属判断失败，放行", exc_info=True)
        return True


def is_available(template_id: str | None) -> bool:
    """能不能用这个模板建新会话。

    与 `is_readonly` 是同一件事的两面，但**不能简单取反**：
    母版与"没有 cowork 这一层"时两者都返回"可以"。
    """
    try:
        from netlivecowork.cowork.manifest import MASTER_ID, bare_id

        s = _scope()
        if s is None:
            return True
        cid = bare_id(str(template_id or "")).strip()
        if not cid or cid == MASTER_ID:
            return True
        from netlivecowork.cowork.runtime import lineup_known

        if not lineup_known():
            # 还没对账：此时拦住新建会让"启动早期"看起来像"没权限"，而那是两回事。
            return True
        return cid in s.installed_ids()
    except Exception:
        return True
