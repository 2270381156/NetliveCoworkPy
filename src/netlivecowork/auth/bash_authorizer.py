"""按命令危险度 + 会话模式决定放行/确认/拒绝的 bash 授权器（host 侧）。

继承 ctx_weft 的 HumanConfirmationAuthorizer：CONFIRM 时调用 super().authorize 走既有
HITL 暂停/确认；DENY 直接拒绝并回灌说明；ALLOW 直接放行（semiauto 半自动不打扰）。
"""
from __future__ import annotations

import dataclasses
import json
from collections.abc import Callable

from ctx_weft.core.auth import AuthorizationDecision, HumanConfirmationAuthorizer

from netlivecowork.auth.bash_policy import Verdict, classify
from netlivecowork.auth.mode_store import BashReviewModeStore

# 全自动 = 纯完整性模型：准入层【不看命令文本】做放行/拒绝判断——文件/系统边界全交给 OS
# 完整性②（Low 读 Medium 可以、写 Medium 被系统拒），越界与否、动没动系统，都由运行时的
# OS 强制说了算，而不是猜命令词。path 判断 / 危险动词判断是 semiauto/manual（要人把关）才用的
# 信号，不该出现在全自动（否则既与 OS 层重复，又会把「读工作区外」这类合法操作误杀）。
# 全自动下【一律放行】——不再有任何命令级硬拒（网络限制也已移除，允许模型联网）。
#
# 平台差异（诚实降级）：Windows 有完整性 → 越界写被 OS 拒、读放行；Mac/Linux 无完整性 →
# 全自动的文件边界【真的没有】（写工作区外会真生效），前端已就此弹降级 toast 提示。


@dataclasses.dataclass
class SelectiveBashAuthorizer(HumanConfirmationAuthorizer):
    mode_store: BashReviewModeStore = None  # type: ignore[assignment]
    workspace_lookup: Callable[[str], str | None] = lambda _sid: None
    # 工作区外仍视为「区内」的合法根（如全应用共享 venv）：引用其绝对路径不弹越界确认。
    allowed_roots: tuple[str, ...] = ()

    async def authorize(self, capability, agent, task, ctx, arguments=None, *, tool_call_id=""):
        command = (arguments or {}).get("command", "") or ""
        workspace = self.workspace_lookup(agent.session_id)
        d = classify(command, workspace, self.allowed_roots)

        mode = self.mode_store.get(agent.session_id)
        # 全自动 = 纯完整性：一律放行——文件/系统边界交给 OS 完整性②，准入层不看命令文本（§4）。
        # 在原逻辑【之前】分流，不进 semiauto/manual 的 HITL 分支，故对现有两模式零影响（§4.4）。
        if mode == "strict-auto":
            return AuthorizationDecision(allowed=True)
        manual = mode == "manual"
        # 需要确认：命中风险(CONFIRM) 或 人工审核模式下的普通命令(ALLOW→强制确认)。
        if d.verdict is not Verdict.CONFIRM and not manual:
            return AuthorizationDecision(allowed=True)

        # question 里带「结构化风险数据」而非成品文案——前端据 hits(命令词+代码)/manual 按 i18n
        # 渲染中英文（见 frontend ChatPanel / i18n warn.bash.*）。manual 仅在无具体风险时标注。
        question = json.dumps({
            "t": "bash_risk",
            "hits": [{"cmd": cmd, "code": code} for cmd, code in d.hits],
            "manual": manual and not d.hits,
        }, ensure_ascii=False)
        return await self._confirm_with_warning(
            capability, agent, task, ctx, arguments, tool_call_id, question,
        )

    async def _confirm_with_warning(
        self, capability, agent, task, ctx, arguments, tool_call_id, warning,
    ):
        """走 HITL 人工确认，把结构化风险数据作为 question 传给前端弹窗
        （前端 waiting_input.prompt = HITL.question，见 session.py）。

        逻辑对齐 ctx_weft HumanConfirmationAuthorizer.authorize，唯一区别是把写死的
        question 换成本命令的风险数据；其余（冷决定复用、request→wait、approval 映射）保持一致。
        """
        approval = await self.hitl_manager.find_resolved_for_tool_call(
            agent.session_id, tool_call_id)
        if approval is None:
            hitl_id = await self.hitl_manager.request(
                form="approval",
                session_id=agent.session_id,
                task_id=task.id if task else "",
                agent_id=agent.id,
                capability_id=capability.id,
                arguments=arguments or {},
                question=warning or f"Allow tool '{capability.name}'?",
                context=capability.description,
                tool_call_id=tool_call_id,
            )
            approval = await self.hitl_manager.wait(hitl_id)   # may raise HitlPark on eviction
        if approval.accepted:
            return AuthorizationDecision(
                allowed=True,
                message=approval.message,
                modified_arguments=approval.modified_arguments,
            )
        return AuthorizationDecision(allowed=False, message=approval.message)
