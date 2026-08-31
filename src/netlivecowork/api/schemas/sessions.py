from __future__ import annotations

import re

from pydantic import BaseModel


class CreateSessionRequest(BaseModel):
    template_id: str | None = None
    user_prompt: str
    tenant_id: str = "default"
    token_budget: int | None = None
    llm_account: str | None = None
    llm_model: str | None = None
    initial_task: dict | None = None
    session_id: str | None = None
    workspace: str | None = None  # agent 工作目录（绝对路径）；登记给 fs provider 管理
    user_info: dict | None = None  # 当前登录用户，供 skill 用量上报关联会话
    mode: str | None = None  # 新建时选的工作模式（semiauto/manual/strict-auto）；空=回落默认


class SendMessageRequest(BaseModel):
    content: str | list
    initial_task: dict | None = None
    llm_account: str | None = None
    llm_model: str | None = None
    user_info: dict | None = None  # 用户信息，用于在已存在session上继续对话时传递用户信息


class ResumeSessionRequest(BaseModel):
    """POST /resume 的可选 body：恢复时切换 LLM（如 CONTEXT_OVERFLOW 中断后换大窗口模型续跑）。

    缺省/空 body = 沿用会话既有选择（向后兼容）。语义与 send_message 略异：这里"未传"是
    "不改"，不做 null→默认账号 的重置（恢复动作不应顺带改走默认账号）。
    """
    llm_account: str | None = None
    llm_model: str | None = None


class BashReviewModeRequest(BaseModel):
    mode: str


APPROVE_WORDS = frozenset({"approved", "approve", "yes", "allow", "允许执行"})
REJECT_WORDS = frozenset({"rejected", "reject", "no", "deny", "拒绝"})

_SPLIT = re.compile(r"[\s,，。.!?！？]+")


def route_hitl_reply(form: str, content: str) -> tuple[str, str]:
    """把一条自由文本回复映射为 (action, message)，action ∈ {approve, reject, answer}。

    - ``approval``       ：审批语义 = yes/no。按**首词**判定 approve/reject，其余文本作 message。
    - ``question``/``wait``：整段文字就是答复（``"no"`` 是否定**答复**，不是"拒绝问题"）→ 一律 answer。
                             显式拒答 / 中止不走这里（用 reject 端点 / interrupt）。
    """
    text = content.strip()
    if form != "approval":
        return ("answer", text)
    head = _SPLIT.split(text, maxsplit=1)
    first = head[0].lower()
    rest = head[1].strip() if len(head) > 1 else ""
    if first in REJECT_WORDS:
        return ("reject", rest)
    return ("approve", rest if first in APPROVE_WORDS else text)
