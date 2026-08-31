"""HITL API endpoints。应答经 resolve_hitl 共享服务:会话副作用(transcript/RUNNING/consumer/
workspace)与 resolve 一体,是前端应答的第一公民入口(spec 2026-07-05 /messages 拆分)。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from . import deps
from .hitl_service import resolve_hitl
from .schemas.hitl import AnswerRequest, ApproveRequest, HitlPendingItem, RejectRequest, ReplyRequest
from .schemas.sessions import route_hitl_reply

router = APIRouter(prefix="/hitl", tags=["hitl"])


def _llm_of(req: Any) -> tuple[str | None, str | None] | None:
    """body 里**出现** llm 字段才生效(缺席=不动 entry,面板应答不误重置)。"""
    if "llm_account" in req.model_fields_set or "llm_model" in req.model_fields_set:
        return (req.llm_account, req.llm_model)
    return None


@router.get("/pending", response_model=list[HitlPendingItem])
async def list_pending(
    session_id: str | None = None,
    hitl=Depends(deps.require_hitl_manager),
):
    pending = hitl.list_pending(session_id=session_id)
    if not pending:
        # 自愈:重启后内存可能还没被 recover 填上 → 据事件重建再列。
        runtime = deps.get_runtime_optional()
        if runtime is not None:
            try:
                if session_id:
                    await runtime.rebuild_hitl(session_id)
                else:
                    await runtime.rebuild_all_pending_hitl()
            except Exception:
                pass
            pending = hitl.list_pending(session_id=session_id)
    return [
        HitlPendingItem(
            id=a.id, kind=("approval" if a.form == "approval" else "input"),
            status=a.status, capability_id=a.capability_id,
            question=a.question, task_id=a.task_id, session_id=a.session_id,
            agent_id=a.agent_id, form=a.form,
            arguments=a.arguments, questions=a.questions,
            created_at=(a.created_at.isoformat() if a.created_at else ""),
        )
        for a in pending
    ]


@router.post("/{hitl_id}/approve")
async def approve(
    hitl_id: str,
    req: ApproveRequest,
    hitl=Depends(deps.require_hitl_manager),
):
    """放行 approval-form 请求（工具门控）。冷应答的 session resume 由 HitlManager 处理。"""
    try:
        resolved = await resolve_hitl(hitl_id, "approve", modify=req.modify, llm=_llm_of(req))
        return {"id": resolved.id, "status": resolved.status}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"HITL request {hitl_id} not found")


@router.post("/{hitl_id}/answer")
async def answer(
    hitl_id: str,
    req: AnswerRequest,
    hitl=Depends(deps.require_hitl_manager),
):
    """应答 question/wait form 请求（向人提问/纯文本暂停），文字答复回灌给 LLM。"""
    try:
        resolved = await resolve_hitl(hitl_id, "answer", text=req.answer, llm=_llm_of(req))
        return {"id": resolved.id, "status": resolved.status}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"HITL request {hitl_id} not found")


@router.post("/{hitl_id}/reject")
async def reject(
    hitl_id: str,
    req: RejectRequest | None = None,
    hitl=Depends(deps.require_hitl_manager),
):
    """拒绝（approval 与 question/wait 通用）；可带 message 作为指导反馈回灌给 agent。"""
    try:
        resolved = await resolve_hitl(
            hitl_id, "reject",
            message=req.message if req else "",
            llm=_llm_of(req) if req else None,
        )
        return {"id": resolved.id, "status": resolved.status}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"HITL request {hitl_id} not found")


@router.post("/{hitl_id}/reply")
async def reply(
    hitl_id: str,
    req: ReplyRequest,
    hitl=Depends(deps.require_hitl_manager),
):
    """自由文本精确应答:按**该条**的 form 跑词表路由再 resolve(修复 approval 文本回复
    被误记为 answer 的回归;词表 canonical 在服务端)。响应含实际执行的 action。"""
    request = hitl.get(hitl_id)
    if request is None:
        # 与 resolve_hitl 同款自愈:重启后内存未 recover → 重建再取
        runtime = deps.get_runtime_optional()
        if runtime is not None:
            try:
                await runtime.rebuild_all_pending_hitl()
            except Exception:
                pass
            request = hitl.get(hitl_id)
    if request is None:
        raise HTTPException(status_code=404, detail=f"HITL request {hitl_id} not found")
    action, message = route_hitl_reply(request.form, req.content)
    try:
        resolved = await resolve_hitl(
            hitl_id, action,
            text=message if action == "answer" else "",
            message=message if action != "answer" else "",
            echo_text=req.content, llm=_llm_of(req),
        )
        return {"id": resolved.id, "status": resolved.status, "action": action}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"HITL request {hitl_id} not found")
