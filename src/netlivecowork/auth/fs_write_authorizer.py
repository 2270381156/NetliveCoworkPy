"""write_file / edit_file 的工作目录约束授权器（host 侧）。

路径落在工作目录内（含相对路径——会自动锚定到工作目录）→ 放行。
路径在工作目录外：
  - 自主运行(auto)：直接拒绝并回灌错误，告知当前工作目录、要求改用相对路径；
  - 人工审核(manual)：走既有 HITL 人工确认。
工作目录未登记 或 无 path 参数 → 放行（无约束可施）。

与 bash 不同：bash 的越界路径在 auto 下是「确认」，而写文件在 auto 下是「硬拒绝」
（用户要求：自主运行时不在工作目录直接报错，引导 agent 用相对路径）。

前端收尾（关键）：内核对「执行前硬拒绝」是在 _record_invocation/_record_result 之前返回的
（见 capability_gateway.invoke 授权步），故【不发】CAPABILITY_INVOKED/FINISHED 事件——而前端的
tool_call_pending 气泡来自 LLM_RESPONSE_FINISHED（模型一声明就建），于是硬拒后气泡永远等不到
tool_call 终态、卡「执行中…」。shell 因为是「授权放行、执行层才被挡」，走到 _record_result 发了
终态、能正常收尾。为对称，这里硬拒时主动补一条【持久化】tool_call 终态事件（live 广播 + 历史重放
都据 tool_call_id 解析），把气泡收成「已结束(错误)」。
"""
from __future__ import annotations

import dataclasses
import json
import logging
from collections.abc import Callable

from ctx_weft.core.auth import AuthorizationDecision, HumanConfirmationAuthorizer

from netlivecowork.auth.bash_policy import is_outside_workspace
from netlivecowork.auth.mode_store import BashReviewModeStore

logger = logging.getLogger(__name__)


@dataclasses.dataclass
class WorkspaceWriteAuthorizer(HumanConfirmationAuthorizer):
    mode_store: BashReviewModeStore = None  # type: ignore[assignment]
    workspace_lookup: Callable[[str], str | None] = lambda _sid: None
    # 工作区外仍视为「区内」的合法根（如全应用共享 venv）：写其绝对路径不判越界。
    allowed_roots: tuple[str, ...] = ()

    async def authorize(self, capability, agent, task, ctx, arguments=None, *, tool_call_id=""):
        path = (arguments or {}).get("path") or ""
        ws = self.workspace_lookup(agent.session_id)
        if not path or ws is None or not is_outside_workspace(path, ws, self.allowed_roots):
            return AuthorizationDecision(allowed=True)

        mode = self.mode_store.get(agent.session_id)
        if mode == "manual":
            return await super().authorize(
                capability, agent, task, ctx, arguments, tool_call_id=tool_call_id,
            )
        # 自主运行：硬拒绝 + 指导（告知工作目录、要求改用相对路径）
        msg = (
            f"路径 '{path}' 在工作目录之外，已拒绝写入。当前工作目录是 '{ws}'。"
            f"请改用相对路径（相对路径会自动落在当前工作目录内），或把目标放到工作目录下后重试。"
        )
        # 补发终态事件，收掉前端「执行中…」气泡（内核硬拒不发 tool_call 终态，见模块 docstring）。
        await _emit_blocked_tool_call(agent.session_id, tool_call_id, capability, arguments, msg)
        return AuthorizationDecision(allowed=False, message=msg)


async def _emit_blocked_tool_call(session_id, tool_call_id, capability, arguments, message) -> None:
    """往会话 SSE 流补一条 tool_call 终态（is_error），前端据 tool_call_id 把 pending 气泡收成终态。

    走会话 entry 的 _append_json：既实时广播、又持久化 → live 和历史重放都能解析（与 rewind_record
    同一机制）。无 tool_call_id / 找不到会话 / 任何异常都静默跳过——只是少一层收尾，绝不影响拒绝本身。
    """
    if not tool_call_id:
        return
    try:
        from netlivecowork.api.models import session as _sm
        entry = _sm._sessions.get(session_id)
        if entry is None:
            return
        await entry._append_json(json.dumps({
            "type": "tool_call",
            "tool_name": getattr(capability, "name", "write_file"),
            "tool_call_id": tool_call_id,
            "arguments": arguments or {},
            "result": message,
            "is_error": True,
            "created_at": _sm._now(),
        }, ensure_ascii=False))
    except Exception:
        logger.debug("补发 write_file 拦截终态事件失败 session=%s", session_id, exc_info=True)
