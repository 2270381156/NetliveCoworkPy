"""HITL 应答共享服务:会话副作用 + resolve 的单一实现(spec 2026-07-05 /messages 拆分)。

`/hitl/{id}/*` 端点与 `/messages` 薄委托(PAUSED* 分支)都经由 resolve_hitl,消除双份副作用逻辑。
副作用顺序有意义(提炼自旧 _submit_hitl_response,勿重排):
  transcript 追加 user 消息 → entry 置 RUNNING+session_update → 重启 session_consumer
  (resolve 前,先订阅 bus 再产生事件) → workspace 重登记 → resolve(带 entry 当前 LLM)。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from netlivecowork.api import deps
from netlivecowork.api.models import session as _sm

logger = logging.getLogger(__name__)


async def _ensure_workspace_registered(runtime: Any, session_id: str) -> None:
    """resume / 重跑前确保 fs provider 持有该 session 的 workspace。

    fs provider 的映射是内存缓存：session 结束（_on_done）或进程重启都会丢失，而 sessions 行的
    workspace 列是真值来源。这里从存储读回并重新登记（register 幂等），覆盖跨进程 resume 与
    同进程 terminal→重跑两种情况。无存储/无记录/无 fs provider 时静默跳过。
    """
    if _sm._state_store is None:
        return
    workspace = await _sm._state_store.get_workspace(session_id)
    if not workspace:
        return
    from ctx_weft.providers.capability_filesystem import FilesystemToolsProvider
    fs = next(
        (p for p in runtime.providers.get_capability_providers()
         if isinstance(p, FilesystemToolsProvider)),
        None,
    )
    if fs is None:
        return
    try:
        fs.register_session(session_id, workspace)
    except Exception:
        logger.warning("Workspace re-register failed for session %s (path %r)", session_id, workspace)
        return
    # 工作区重新登记后，据【持久化的】模式重建低完整性：strict-auto 会话重启/resume 后必须重激活
    # Low 边界（低完整性登记表是内存的、重启即丢），否则会"显示自动模式但实际没边界"。
    modes = deps.get_bash_review_modes()
    if modes is not None:
        from netlivecowork.paths import data_dir
        from netlivecowork.low_integrity.activation import apply_mode_low_integrity
        try:
            status = await apply_mode_low_integrity(runtime, session_id, modes.get(session_id), data_dir=data_dir())
            # resume 一个自动模式会话，但此刻工作区打标建不起边界（无权限/取消 UAC）→ 落回半自动，
            # 不让它在"假自动"里继续跑。
            if status == "no_permission":
                modes.set(session_id, "semiauto")
                logger.warning("session %s resume 时自动模式工作区无法打标(无权限/取消) → 落回半自动", session_id)
        except Exception:
            logger.warning("session %s 低完整性重同步失败（据持久化模式）", session_id, exc_info=True)


async def _locate_request(hitl: Any, hitl_id: str) -> Any:
    """按 id 取请求;miss(重启后内存未 recover)→ 据事件重建全部 active pending 再取(spec/07 §9 自愈);
    仍 miss → KeyError(调用方转 404)。"""
    req = hitl.get(hitl_id)
    if req is not None:
        return req
    runtime = deps.get_runtime_optional()
    if runtime is not None:
        try:
            await runtime.rebuild_all_pending_hitl()
        except Exception:
            pass
        req = hitl.get(hitl_id)
    if req is None:
        raise KeyError(f"No HITL request found: {hitl_id}")
    return req


def _default_echo(action: str, *, text: str, message: str) -> str:
    """transcript 回显缺省:answer=答复原文;approve/reject=旧前端按钮字面量(+可选备注),气泡配对不破。"""
    if action == "answer":
        return text
    word = "approved" if action == "approve" else "rejected"
    return f"{word} {message}".strip() if message else word


async def resolve_hitl(
    hitl_id: str,
    action: str,
    *,
    text: str = "",
    message: str = "",
    modify: dict[str, Any] | None = None,
    echo_text: str | None = None,
    entry: Any | None = None,
    llm: tuple[str | None, str | None] | None = None,
) -> Any:
    """resolve 一条 HITL 请求,并补齐前端可见的全部会话副作用。

    action ∈ {"answer","approve","reject"}。``echo_text``=transcript 展示的 user 消息(None→按
    action 缺省)。``entry``:/messages 薄委托传入其 entry;None → 按请求的 session_id 查注册表。
    ``llm``:(account, model)——truthy account→设 entry 两值;None account→重置为 None(与 /messages
    语义同);整个参数为 None→不动 entry(面板应答不再误重置)。entry 不在(纯 API 调用、无前端
    会话)→ 跳过会话副作用,resolve 照走。未知 hitl_id → KeyError。
    """
    if action == "answer" and not text.strip():
        # 空答案没有可执行内容：热路径只能拿占位内容凑数,事件也记不下 message——跨重启后
        # 冷决定查询判不可用、问题会被重问。一处拒收罩住 /hitl/{id}/answer 与 /messages 两入口;
        # approve/reject 的空 message 合法（放行/拦下本身就是决定）,不在此列。
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail="Answer must not be empty")

    hitl = deps.get_hitl_manager()
    if hitl is None:
        raise RuntimeError("HitlManager not initialized")
    req = await _locate_request(hitl, hitl_id)
    if req.status != "pending":
        # 已解决(双击/陈旧页签重放):副作用绝不重放——重复 transcript 气泡/consumer 重启都是伤害;
        # 交给底部幂等 resolve 原样返回终态(不改 message、不覆盖决定)。
        return req

    if entry is None:
        entry = _sm._sessions.get(req.session_id)
    runtime = deps.get_runtime_optional()

    if entry is not None:
        # 下面 this_turn 读 turn_seq 时还没发生任何追加，_append_json 的闸门来不及。
        # 这个值既是应答帧里的回退锚点、又是 snapshot_turn 的档号，冷 entry 不先补会
        # 少算一回合，回滚就打到上一回合的工作区快照上。
        await entry.ensure_hydrated()
        if llm is not None:
            account, model = llm
            if account:
                entry.llm_account = account
                entry.llm_model = model or None
            else:
                entry.llm_account = None
                entry.llm_model = None
        shown = echo_text if echo_text is not None else _default_echo(action, text=text, message=message)
        this_turn = entry.turn_seq + 1   # 与下方 turn_seq += 1 对齐（emit 在自增之前）
        _rw = deps.get_rewind_manager()
        _msg = {
            "type": "message", "role": "user",
            "content": shown, "created_at": _sm._now(),
        }
        if _rw is not None:              # rewind 开着才带 turn_seq，供前端挂回退按钮
            _msg["turn_seq"] = this_turn
        await entry._append_json(json.dumps(_msg))
        # rewind：本回合（续答同一挂起任务）动手前拍工作区快照。无工作区则跳过（没东西可拍）。
        _ws = getattr(entry, "workspace", None)
        if _rw is not None and _ws:
            await _rw.snapshot_turn(entry.session_id, this_turn, _ws)
        async with entry.cond:
            entry.status = "RUNNING"
            entry.updated_at = _sm._now()
            entry.turn_seq += 1
            entry.sse_events.append(entry._session_update_json("RUNNING"))
            entry.cond.notify_all()
        if runtime is not None:
            # 重启 consumer:重启后原 consumer 已随进程消失,冷恢复续跑事件到不了前端即"卡住"。
            entry._consumer_token += 1
            entry.sse_finished = False
            asyncio.create_task(_sm.session_consumer(entry, runtime, entry._consumer_token))
            # 冷应答触发 recover_session 续跑前,从存储重新登记 workspace(内存映射随重启丢失)。
            await _ensure_workspace_registered(runtime, req.session_id)
        llm_kw: dict[str, Any] = {"llm_account": entry.llm_account, "llm_model": entry.llm_model}
    else:
        logger.warning(
            "resolve_hitl: no session entry for %s (session %s) — resolving without session side effects",
            hitl_id, req.session_id)
        if runtime is not None:
            await _ensure_workspace_registered(runtime, req.session_id)
        llm_kw = {}

    if action == "reject":
        return await hitl.reject(hitl_id, message=message, **llm_kw)
    if action == "approve":
        return await hitl.approve(hitl_id, message=message, modified_arguments=modify, **llm_kw)
    return await hitl.answer(hitl_id, text, **llm_kw)
