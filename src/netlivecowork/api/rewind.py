"""rewind 端点：列会话的工作区检查点 + 回滚到某检查点。

只回滚**工作区文件**，不动对话/上下文（《全自动模式安全设计》§6）。
回滚是破坏性操作，前端须二次确认；后端在回滚前自动存一张"回滚前"检查点，故本身可撤。
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import asdict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from netlivecowork.api import deps

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rewind", tags=["rewind"])


class RestoreRequest(BaseModel):
    checkpoint_id: str


class RestoreTurnRequest(BaseModel):
    turn: int


class UndoRequest(BaseModel):
    """撤销回滚：把工作区恢复到某次回滚之前的安全档。turn 仅用于把 rewind_undone 事件挂回对应回合。"""
    safety_checkpoint_id: str
    turn: int


def _mgr():
    m = deps.get_rewind_manager()
    if m is None:
        raise HTTPException(status_code=503, detail="rewind 未启用")
    return m


@router.get("/{session_id}/checkpoints")
def list_checkpoints(session_id: str) -> dict:
    """按创建顺序返回该会话的所有检查点元数据（不含文件内容）。"""
    return {"checkpoints": [asdict(c) for c in _mgr().list(session_id)]}


def _entry_of(session_id: str):
    from netlivecowork.api.models import session as _sm
    return _sm._sessions.get(session_id)


async def _emit_rewind_record(session_id: str, turn: int, res) -> None:
    """回滚成功后，向会话流写一条持久化的 rewind_record 事件——历史重放时前端把它
    挂到对应回合消息下方（比前端临时状态可靠，刷新/重连仍在）。"""
    from netlivecowork.api.models import session as _sm
    entry = _entry_of(session_id)
    if entry is None:
        return
    await entry._append_json(json.dumps({
        "type": "rewind_record", "turn_seq": turn,
        "restored": res.restored, "deleted": res.deleted,
        # 撤销回滚要恢复到的点（回滚前的工作区安全档 id）。前端据此对【最近一条】记录提供「撤销」。
        "safety_checkpoint_id": res.safety_checkpoint_id,
        "created_at": _sm._now(),
    }))


async def _emit_rewind_undone(session_id: str, turn: int) -> None:
    """撤销回滚成功后写一条持久化事件——历史重放时前端把对应回合的那条回滚记录标成"已撤销"，
    并关闭其「撤销」入口（窗口只开一次）。"""
    from netlivecowork.api.models import session as _sm
    entry = _entry_of(session_id)
    if entry is None:
        return
    await entry._append_json(json.dumps({
        "type": "rewind_undone", "turn_seq": turn, "created_at": _sm._now(),
    }))


@router.post("/{session_id}/restore-to-turn")
async def restore_to_turn(session_id: str, req: RestoreTurnRequest) -> dict:
    """回滚到某用户回合动手之前的工作区状态（前端在对话里按 turn_seq 触发）。"""
    entry = _entry_of(session_id)
    ws = getattr(entry, "workspace", None) if entry else None
    # 回滚是破坏性操作（覆盖工作区文件），无人复核 → 关键审计点，记请求。
    logger.info("rewind 回滚请求 session=%s turn=%s workspace=%s", session_id, req.turn, ws)
    try:
        # 文件遍历/写盘放线程池，不阻塞事件循环
        res = await asyncio.to_thread(_mgr().restore_turn, session_id, req.turn, ws)
    except KeyError as e:
        logger.warning("rewind 回滚失败(未找到) session=%s turn=%s: %s", session_id, req.turn, e)
        raise HTTPException(status_code=404, detail=str(e)) from e
    except RuntimeError as e:
        logger.warning("rewind 回滚失败(前置条件) session=%s turn=%s: %s", session_id, req.turn, e)
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001 — 把真实原因透给前端，便于定位
        logger.exception("rewind 回滚异常 session=%s turn=%s", session_id, req.turn)
        raise HTTPException(status_code=500, detail=f"回滚失败: {e}") from e
    logger.info("rewind 回滚完成 session=%s turn=%s 写回=%d 删除=%d",
                session_id, req.turn, res.restored, res.deleted)
    await _emit_rewind_record(session_id, req.turn, res)
    return asdict(res)


@router.post("/{session_id}/undo")
async def undo(session_id: str, req: UndoRequest) -> dict:
    """撤销最近一次回滚：把工作区恢复到那次回滚之前的安全档。撤销即最终（不做 redo → snapshot_before=False）。

    「只可撤最近一次、发新消息即失效」由前端据事件流控制入口显隐；后端只负责把安全档回滚回去。
    安全档已被 GC（超保留上限）→ KeyError → 404，前端据此提示窗口已失效。"""
    entry = _entry_of(session_id)
    ws = getattr(entry, "workspace", None) if entry else None
    logger.info("rewind 撤销回滚请求 session=%s turn=%s safety=%s workspace=%s",
                session_id, req.turn, req.safety_checkpoint_id, ws)
    try:
        res = await asyncio.to_thread(_mgr().restore, session_id, req.safety_checkpoint_id, ws)
    except KeyError as e:
        logger.warning("rewind 撤销失败(安全档不存在/已回收) session=%s safety=%s: %s",
                       session_id, req.safety_checkpoint_id, e)
        raise HTTPException(status_code=404, detail=str(e)) from e
    except RuntimeError as e:
        logger.warning("rewind 撤销失败(前置条件) session=%s: %s", session_id, e)
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001 — 把真实原因透给前端
        logger.exception("rewind 撤销异常 session=%s", session_id)
        raise HTTPException(status_code=500, detail=f"撤销失败: {e}") from e
    logger.info("rewind 撤销完成 session=%s turn=%s 写回=%d 删除=%d",
                session_id, req.turn, res.restored, res.deleted)
    await _emit_rewind_undone(session_id, req.turn)
    return asdict(res)


@router.post("/{session_id}/restore")
def restore(session_id: str, req: RestoreRequest) -> dict:
    """按检查点 id 回滚（内部/兜底）。返回写回/删除/未变计数 + 回滚前安全档 id。"""
    logger.info("rewind 回滚请求(按 id) session=%s checkpoint=%s", session_id, req.checkpoint_id)
    try:
        res = _mgr().restore(session_id, req.checkpoint_id)
    except KeyError as e:
        logger.warning("rewind 回滚失败(未找到) session=%s checkpoint=%s: %s", session_id, req.checkpoint_id, e)
        raise HTTPException(status_code=404, detail=str(e)) from e
    except RuntimeError as e:
        logger.warning("rewind 回滚失败(前置条件) session=%s checkpoint=%s: %s", session_id, req.checkpoint_id, e)
        raise HTTPException(status_code=400, detail=str(e)) from e
    logger.info("rewind 回滚完成(按 id) session=%s checkpoint=%s 写回=%d 删除=%d",
                session_id, req.checkpoint_id, res.restored, res.deleted)
    return asdict(res)
