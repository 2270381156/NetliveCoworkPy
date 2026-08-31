from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class ApproveRequest(BaseModel):
    modify: dict[str, Any] | None = None
    # 可选:随应答切换会话 LLM(语义与 /messages 同;缺席=不动,见 hitl_service.resolve_hitl)
    llm_account: str | None = None
    llm_model: str | None = None


class AnswerRequest(BaseModel):
    answer: str
    llm_account: str | None = None
    llm_model: str | None = None


class RejectRequest(BaseModel):
    message: str = ""
    llm_account: str | None = None
    llm_model: str | None = None


class HitlPendingItem(BaseModel):
    id: str
    kind: str          # 派生字段(前端契约冻结): approval→按钮 / input→文本框
    status: str
    capability_id: str
    question: str
    task_id: str
    session_id: str
    agent_id: str = ""
    form: str = ""     # 新增: approval | question | wait
    # 追加(additive,多面板渲染用):
    arguments: dict[str, Any] = {}   # approval 门控的调用参数(人工判断放行用)
    questions: list = []             # ask_user 结构化批量问题(options/multi_select)
    created_at: str = ""             # ISO 时间,前端排序用


class ReplyRequest(BaseModel):
    """自由文本应答:服务端按该条 form 跑词表路由(approval 首词判 approve/reject;
    question/wait 一律 answer)——/messages 薄委托的解析逻辑精确化到单条。"""
    content: str
    llm_account: str | None = None
    llm_model: str | None = None
