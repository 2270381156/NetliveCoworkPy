"""Sessions API.

Endpoints
---------
POST   /sessions                   create + start session
GET    /sessions                   list all sessions
GET    /sessions/{id}              get session
PUT    /sessions/{id}/title        set a persistent manual title
DELETE /sessions/{id}              delete session record
GET    /sessions/{id}/tasks        list tasks
POST   /sessions/{id}/messages     send message (HITL response or new run)
POST   /sessions/{id}/interrupt    cooperative interrupt
POST   /sessions/{id}/tasks/{task_id}/pause  定向暂停单个在途 task
POST   /sessions/{id}/resume       resume INTERRUPTED session via event replay
GET    /sessions/{id}/stream       SSE event stream
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

from netlivecowork.api import cowork_bridge, deps
from netlivecowork.api.models import session as _sm
from netlivecowork.providers.templates import canonical_template_id
from netlivecowork.observability.session_export import export_session_db, SessionNotFoundError
from netlivecowork.observability.session_import import import_session_db, InvalidSessionDumpError
from netlivecowork.api.models.session import register_session_from_db
from netlivecowork.api.schemas.sessions import (
    BashReviewModeRequest,
    CreateSessionRequest,
    ResumeSessionRequest,
    SendMessageRequest,
    SessionTitleRequest,
    route_hitl_reply,
)
from netlivecowork.api.hitl_service import _ensure_workspace_registered  # noqa: F401  (本模块 3 处调用 + 既有测试 monkeypatch 目标)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])


# ── Helpers ───────────────────────────────────────────────────────────────────


def _refuse_llm_not_allowed(template_id: str | None, account: str | None) -> None:
    """这个 cowork 不许用这个 LLM 账号 → 403。

    **列表过滤挡不住这件事**：`/llms?cowork=` 只决定选择器里显示什么，绕过界面直接调
    接口照样能指定任意账号。看不见 ≠ 用不了 —— 与 MCP 的 invoke 那道闸同型（需求 G3）。

    `llm.allow` 为空 = 不限（与 `mcp.use` 的空语义**故意相反**），所以不配的套件不受影响。
    """
    if cowork_bridge.llm_allowed(template_id, account, managed=_managed_llm_names()):
        return
    logger.info("cowork：拦下越权模型 —— %s 不允许账号 %r", template_id, account)
    raise HTTPException(
        status_code=403,
        detail={"code": "LLM_NOT_ALLOWED",
                "message": f"当前 cowork 不允许使用模型账号 {account}"},
    )


def _managed_llm_names() -> set[str] | None:
    """统一交付的账号名（出厂 + 套件下发）。`None` = 问不到。

    **问不到时返回 None 而不是空集合**：空集合的意思是"一个都不受管"，
    这道闸就整个失效了，而失效是静默的。问不到时宁可严一点（按全部受管处理）。
    """
    try:
        from netlivecowork.api import deps

        return set(deps.get_llm_provider().managed_account_names())
    except Exception:
        logger.debug("cowork：取受管账号名单失败，本次按全部受管处理", exc_info=True)
        return None


def _refuse_if_revoked(entry: Any) -> None:
    """这条会话的 cowork 被收回了 → 拒绝**继续**它。

    **403 而不是 404**（需求 I6）：会话在、也读得了，缺的是继续它的权限；
    404 会让人以为记录没了。

    **也不能是 500**：实测过——被收回的 cowork 去 resume，模板找不到会一路抛成
    500 Internal Server Error，而 500 看起来像"系统坏了"，用户会去重试、
    去报故障，而不是去申请权限。

    ⚠ 只拦"继续"这一类。**读会话详情、任务、导出都要照常**（需求 I5）：
    只读实现成"打开就报错"等于变相删除，用户会认为记录丢了。
    """
    if cowork_bridge.is_readonly(getattr(entry, "template_id", None)):
        raise HTTPException(
            status_code=403,
            detail={"code": "COWORK_REVOKED",
                    "message": "这个 Cowork 的权限已被收回，历史记录仍可查看，但不能继续"},
        )


def _register_workspace(runtime: Any, session_id: str, workspace: str) -> None:
    """把 host 指定的工作目录（绝对路径）登记给 fs provider，须在 start_session 之前。

    找不到 fs provider 时报 503；workspace 非绝对路径由 provider 抛 ValueError → 400。
    register_session 是 provider 自有方法（不在协议内），host 直接按具体类型查找。
    """
    from ctx_weft.providers.capability_filesystem import FilesystemToolsProvider
    fs = next(
        (p for p in runtime.providers.get_capability_providers()
         if isinstance(p, FilesystemToolsProvider)),
        None,
    )
    if fs is None:
        raise HTTPException(status_code=503, detail="No filesystem provider to register workspace")
    try:
        fs.register_session(session_id, workspace)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _resolve_context_limit(runtime: Any, llm_account: str | None, llm_model: str | None) -> int:
    """据所选 LLM 模型的上下文长度构建 session 的 context_limit。
    无 LLM provider / 解析失败时回退到保守默认 200_000 并告警。"""
    try:
        if runtime is not None and runtime.providers.has_llm_provider():
            client = runtime.providers.get_llm_provider().get_client(llm_account, llm_model)
            return client.context_limit
    except Exception:
        logger.warning("context_limit: failed to resolve from model (account=%r model=%r); using fallback",
                       llm_account, llm_model)
    return 180_000


def _resolve_output_reserve(runtime: Any, llm_account: str | None, llm_model: str | None) -> int:
    """据所选 LLM 模型解析 output_reserve（输入侧输出预留）；失败回退 8192。

    client.output_reserve 已由 get_client 把 None 解析成按窗口尺寸的默认值，此处拿到的恒为具体值。
    """
    try:
        if runtime is not None and runtime.providers.has_llm_provider():
            client = runtime.providers.get_llm_provider().get_client(llm_account, llm_model)
            return client.output_reserve
    except Exception:
        logger.warning("output_reserve: resolve failed (account=%r model=%r); fallback 8192",
                       llm_account, llm_model)
    return 8192


def _runtime_llm_info(runtime: Any) -> tuple[str | None, str | None]:
    if runtime is None:
        return None, None
    if runtime.providers.has_llm_provider():
        accounts = runtime.providers.get_llm_provider().list_accounts()
        if accounts:
            first = accounts[0]
            return first.name, first.default_model or None
        return None, None
    llm = getattr(runtime, "_llm", None)
    return None, getattr(llm, "_model", None) if llm else None


async def _submit_hitl_response(entry: Any, content: str) -> dict:
    """[DEPRECATED] /messages 的 HITL 应答薄委托——聊天框回复的兼容通道。

    固定解决 pending[0](最老一条):多 pending 时有歧义,精确应答请走 /hitl/{id}/answer|approve|reject
    (前端正常流量已迁移,本分支仅剩兜底)。副作用与 resolve 统一在 hitl_service.resolve_hitl。
    文本按 route_hitl_reply 词表解析:approval form 首词判 approve/reject;question/wait 一律 answer。
    """
    from netlivecowork.api.hitl_service import resolve_hitl

    hitl = deps.get_hitl_manager()
    if hitl is None:
        raise HTTPException(status_code=503, detail="HitlManager not initialized")
    pending = hitl.list_pending(session_id=entry.session_id)
    if not pending:
        # 自愈:重启后内存 HitlManager 可能还没被 recover 填上 → 据事件即时重建再试,避免误 404。
        runtime = deps.get_runtime_optional()
        if runtime is not None:
            try:
                await runtime.rebuild_hitl(entry.session_id)
            except Exception:
                pass
            pending = hitl.list_pending(session_id=entry.session_id)
    if not pending:
        raise HTTPException(status_code=404, detail="No pending HITL for this session")

    req = pending[0]
    action, message = route_hitl_reply(req.form, content)
    try:
        # llm=None:send_message 的 PAUSED 分支已按 body 更新过 entry,这里不重复;
        # echo_text=原文:transcript 展示用户敲的字,气泡配对不变。
        await resolve_hitl(
            req.id, action,
            text=message if action == "answer" else "",
            message=message if action != "answer" else "",
            echo_text=content, entry=entry,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="No pending HITL for this session")
    return entry.to_dict()


async def _cancel_pending_hitl(session_id: str) -> None:
    """收口该 session 仍 pending 的 HITL 请求（interrupt / delete 时调用；spec/07 §3）。

    cancel() 发 HitlCancelled（reducer/投影据此把 session 移出暂停态）；对热-park 的请求
    还会 set Future、唤醒悬在 await 上的协程,使协作式中断真正生效。无 HitlManager 时静默跳过。
    """
    hitl = deps.get_hitl_manager()
    if hitl is None:
        return
    for req in hitl.list_pending(session_id=session_id):
        await hitl.cancel(req.id)


# ── Endpoints ─────────────────────────────────────────────────────────────────


async def _resolve_default_template_id(store) -> str:
    """create_session 未指定模板时的默认选择。

    优先 NLC_DEFAULT_TEMPLATE_ID（cfg.default_template_id）——store 中存在才用
    （get → find_by_name，与 provider 加载口径一致）；配置的模板不存在则 log warning
    后回落列表首个（维持既有行为，配置错不阻断建会话）。"""
    from netlivecowork.config import get_settings
    configured = get_settings().default_template_id
    if configured:
        meta = await store.get(configured)
        if meta is None:
            meta = await store.find_by_name(configured)
        if meta is not None:
            return meta["id"]
        logger.warning(
            "create_session: configured default template %r not found in store; "
            "falling back to the first listed template", configured,
        )
    rows = await store.list_all()
    return rows[0]["id"] if rows else "echo"


@router.post("", response_model=dict)
async def create_session(
    req: CreateSessionRequest,
    runtime=Depends(deps.get_runtime),
) -> dict:
    from ctx_weft import SessionStartParams
    from ctx_weft.core.utils import generate_id

    logger.info("create_session: received user_info=%s, user_prompt=%s", req.user_info, req.user_prompt[:50] if req.user_prompt else "")

    template_id = req.template_id
    if not template_id:
        store = deps._template_store
        template_id = (
            await _resolve_default_template_id(store) if store is not None else "tpl_echo"
        )

    # 缺省账号：**先问这个 cowork**，再回落全局默认。
    # 不问的话，`llm.allow` 里没有全局默认账号的 cowork 会根本建不了会话 ——
    # 用户不选模型时用的就是全局默认，而它过不了下面那道归属闸，直接 403。
    default_account, default_model = _runtime_llm_info(runtime)
    suite_default = cowork_bridge.default_llm(template_id)
    if suite_default and not req.llm_account:
        default_account = suite_default[0]
        default_model = suite_default[1] or default_model
    llm_account = req.llm_account or default_account
    llm_model = req.llm_model or default_model

    # 求值即规范（spec 2026-07-22 host-canonical）：params 与 SessionEntry 共用同一
    # 规范值，host 记录从出生就是 agent:<id>，与重启后 _entry_from_record 载入形态一致。
    template_id = canonical_template_id(template_id)

    # 权限是执行边界，不只是展示：**绕过界面直接调接口也拿不到没权限的 cowork**（需求 G3）。
    # ⚠ 给出明确原因，而不是让它一路跑到装配阶段炸成 500——500 看起来像"系统坏了"，
    # 与真实原因（没这个 cowork 的权限、或套件没装上）完全不搭边，
    # 用户会去重试、去报故障，而不是去申请权限（需求 F4）。
    if not cowork_bridge.is_available(template_id):
        raise HTTPException(
            status_code=404,
            detail={"code": "COWORK_UNAVAILABLE",
                    "message": f"{template_id} 不可用：未安装或你没有它的权限"},
        )

    _refuse_llm_not_allowed(template_id, llm_account)

    # 预生成 session_id，使 host 能在执行开始前把工作目录登记给 fs provider（内存态，执行依赖）。
    session_id = req.session_id or generate_id("ses")
    # 同一处再登记一次 cowork 归属：能力属于 cowork，会话只表明身份（架构设计 §3.2）。
    # 认不出的模板（母版、历史会话）不登记——"不知道"与"知道且是它"必须分开。
    cowork_bridge.bind_session(session_id, template_id)
    # 新建会话时用户在输入框选的工作模式：先落库，使首个 run 及低完整性激活都用这个模式；
    # 未选（req.mode 为空）则不动，get() 回落默认 semiauto。非法值忽略。
    _modes = deps.get_bash_review_modes()
    if _modes is not None and req.mode:
        try:
            _modes.set(session_id, req.mode)
        except ValueError:
            logger.warning("create_session: 忽略非法工作模式 %r", req.mode)
    if req.workspace:
        _register_workspace(runtime, session_id, req.workspace)
        # 按（用户刚选的 / 已持久化的）模式同步低完整性：若为全自动，此刻就激活 Low 边界。
        if _modes is not None:
            from netlivecowork.paths import data_dir
            from netlivecowork.low_integrity.activation import apply_mode_low_integrity
            status = await apply_mode_low_integrity(runtime, session_id, _modes.get(session_id), data_dir=data_dir())
            # 新建就选了全自动、但工作区打标建不起边界（无权限/取消 UAC）→ 落回半自动，
            # 不阻断建会话，但绝不让首个 run 跑在"假自动"里（无边界还不打扰）。
            if status == "no_permission":
                _modes.set(session_id, "semiauto")
                logger.warning("session %s 新建选了自动模式但工作区无法打标(无权限/取消) → 落回半自动", session_id)

    from netlivecowork.config import get_settings
    params = SessionStartParams.create(
        template_id=template_id,
        user_prompt=req.user_prompt,
        session_id=session_id,       # 新 session 用 host 指定的 id（resume=False）
        initial_task=req.initial_task,
        tenant_id=req.tenant_id,
        llm_account=llm_account,
        llm_model=llm_model,
        token_budget=req.token_budget or get_settings().default_token_budget,
        context_limit=_resolve_context_limit(runtime, llm_account, llm_model),
        reserved_output_tokens=_resolve_output_reserve(runtime, llm_account, llm_model),
    )

    handle = await runtime.start_session(params)

    # start_session 在返回前已经调度执行 task。先把登录用户写进内存 session，再进行任何
    # 会让出事件循环的数据库操作，避免极快 skill 在 save_workspace 期间结束、Reporter
    # 尚查不到 user_info。
    entry = _sm.SessionEntry(
        session_id=handle.session_id,
        template_id=template_id,
        user_prompt=req.user_prompt,
        tenant_id=req.tenant_id,
        llm_model=llm_model,
        llm_account=llm_account,
        user_info=req.user_info,
    )
    if req.token_budget:
        entry.token_budget = req.token_budget
    entry.root_agent_id = handle.agent_id
    entry.workspace = req.workspace
    _sm._sessions[handle.session_id] = entry
    logger.info("create_session: session_id=%s, user_info=%s stored in _sessions", handle.session_id, entry.user_info)

    # 持久化 workspace 到 sessions 行（供进程重启后 resume 重新登记）。须在 start_session 之后：
    # 此刻 SESSION_CREATED 已被 ProjectionUpdater 同步处理、sessions 行已存在。
    if req.workspace and _sm._state_store is not None:
        await _sm._state_store.save_workspace(handle.session_id, req.workspace)

    _rw = deps.get_rewind_manager()
    _msg = {
        "type": "message", "role": "user",
        "content": req.user_prompt, "created_at": _sm._now(),
    }
    if _rw is not None:               # rewind 开着才带 turn_seq（关掉时前端就不显示回退按钮）
        _msg["turn_seq"] = entry.turn_seq
    await entry._append_json(json.dumps(_msg))

    # rewind：首轮动手前拍工作区初始状态（回滚到此 = 撤销全部改动，回到会话开始时）。无工作区则跳过。
    _ws = getattr(entry, "workspace", None)
    if _rw is not None and _ws:
        await _rw.snapshot_turn(handle.session_id, entry.turn_seq, _ws)

    entry._consumer_token += 1
    asyncio.create_task(_sm.session_consumer(entry, runtime, entry._consumer_token))

    return entry.to_dict()


@router.get("", response_model=list)
async def list_sessions() -> list[dict]:
    sessions = sorted(_sm._sessions.values(), key=lambda e: e.created_at, reverse=True)
    out = [e.to_dict() for e in sessions]
    # last_activity_at：会话「最后真实活动」时间，供前端排序/展示。updated_at 是行写入时间，
    # 会被崩溃恢复的记帐事件刷成启动时刻（重启后会话集体跳「现在」），故不能拿它当活动时间。
    # 直接取事件日志（event_store）里最后一条真实事件的时间戳——不可变追加流，不受恢复污染。
    acts: dict[str, str] = {}
    store = _sm._event_store
    if store is not None:
        try:
            acts = await store.last_activity_times()
        except Exception:
            logger.exception("list_sessions: last_activity_times failed; falling back to updated_at")
    for d in out:
        d["last_activity_at"] = acts.get(d["id"]) or d.get("updated_at") or d.get("created_at")
    return out


@router.get("/{session_id}", response_model=dict)
async def get_session(session_id: str) -> dict:
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return entry.to_dict()


@router.put("/{session_id}/title", response_model=dict)
async def update_session_title(session_id: str, req: SessionTitleRequest) -> dict:
    """设置用户手动标题；不改 AI 自动维护的 goal。"""
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    title = req.title.strip()
    if not title or len(title) > 200:
        raise HTTPException(status_code=422, detail="title must contain 1-200 characters")
    if _sm._state_store is None:
        raise HTTPException(status_code=503, detail="persistence not ready")
    saved = await _sm._state_store.save_session_title(session_id, title)
    if saved is False:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    entry.title = title
    return entry.to_dict()


def _session_factory():
    """The live async_sessionmaker, reached via the registered state store.
    Wrapped in a module-level fn so tests can monkeypatch it."""
    store = _sm._state_store
    if store is None:
        raise HTTPException(status_code=503, detail="persistence not ready")
    return store._factory


@router.get("/{session_id}/export")
async def export_session(session_id: str) -> Response:
    """导出该会话为独立 SQLite 文件,供用户主动"上报此会话"。"""
    try:
        data = await export_session_db(session_id, _session_factory())
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return Response(content=data, media_type="application/octet-stream")


@router.post("/import", response_model=dict)
async def import_session(file: UploadFile = File(...)) -> dict:
    """导入一个会话 SQLite dump（id 重映射为 imp_ 前缀），供 Web 前端回放调试。"""
    data = await file.read()
    try:
        new_id = await import_session_db(data, _session_factory())
    except InvalidSessionDumpError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await register_session_from_db(_sm._state_store, new_id)
    return _sm._sessions[new_id].to_dict()


@router.get("/{session_id}/bash-review-mode", response_model=dict)
async def get_bash_review_mode(session_id: str) -> dict:
    if session_id not in _sm._sessions:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    store = deps.get_bash_review_modes()
    if store is None:
        raise HTTPException(status_code=503, detail="Bash review mode store not initialized")
    return {"mode": store.get(session_id)}


@router.put("/{session_id}/bash-review-mode", response_model=dict)
async def set_bash_review_mode(session_id: str, req: BashReviewModeRequest) -> dict:
    if session_id not in _sm._sessions:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    store = deps.get_bash_review_modes()
    if store is None:
        raise HTTPException(status_code=503, detail="Bash review mode store not initialized")
    prev_mode = store.get(session_id)   # 拒绝切换时回滚用
    try:
        store.set(session_id, req.mode)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    # 模式切换是关键状态变更（尤其进/出全自动）→ 记一条，便于回溯"何时进的自动模式"。
    logger.info("bash 审核模式切换 session=%s → %s", session_id, req.mode)

    # strict-auto ⇄ 其它切换：同步低完整性边界激活/停用。
    runtime = deps.get_runtime_optional()
    # 返回给前端的 os_low_integrity 表示【本平台是否支持 OS 边界】，据此决定要不要弹降级 toast——
    # 只有非 Windows/无 pywin32 才是真降级。平台支持但工作区暂未登记（切模式切早了）不算降级：
    # 稍后建会话/发消息的钩子会激活（见 create_session / _ensure_workspace_registered）。
    li_supported = False
    if runtime is not None:
        from netlivecowork.low_integrity import windows
        from netlivecowork.low_integrity.activation import apply_mode_low_integrity
        from netlivecowork.paths import data_dir
        status = await apply_mode_low_integrity(runtime, session_id, req.mode, data_dir=data_dir())
        if req.mode == "strict-auto":
            # 边界建不起来（工作区打标要管理员、用户取消/提权失败）→ 【拒绝切到自动模式】、回滚，
            # 绝不让用户停在"显示自动但其实没保护"的假自动里。
            if status == "no_permission":
                store.set(session_id, prev_mode)
                raise HTTPException(status_code=409, detail={
                    "code": "AUTO_MODE_NO_PERMISSION",
                    "message": (
                        "无法切换到自动模式：没有权限给当前工作区开启文件保护（管理员授权被取消或失败）。"
                        "请把工作区换到你有完全控制的目录后重试，或使用半自动模式。"),
                })
            li_supported = windows.available()
            if status == "unsupported":
                logger.warning("session %s 进入全自动，但本平台不支持 OS 边界（非 Windows/无 pywin32）→ 无文件边界降级", session_id)
            elif status == "no_workspace":
                logger.info("session %s 进入全自动：平台支持，工作区暂未登记 → 稍后由钩子激活（不弹降级）", session_id)
    return {"mode": store.get(session_id), "os_low_integrity": li_supported}


@router.post("/{session_id}/resume", response_model=dict)
async def resume_session(
    session_id: str,
    req: ResumeSessionRequest | None = None,
    runtime=Depends(deps.get_runtime),
) -> dict:
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    _refuse_if_revoked(entry)
    if entry.status != "INTERRUPTED":
        raise HTTPException(status_code=409, detail=f"Session is not interrupted (status={entry.status})")

    # 恢复时切换模型（可选）：写回 entry（会话记忆当前选择），随下方 recover_session 生效；
    # core 侧会据非 None 覆盖同步 context_limit/reserved_output_tokens（换大窗口模型解溢出）。
    if req is not None:
        if req.llm_account:
            # 换模型也要过闸：只在建会话时校验的话，建一个合规会话再 resume 换成别的账号，
            # 就整条绕过去了 —— 而这条路径正是"选错模型"最常发生的地方。
            _refuse_llm_not_allowed(getattr(entry, "template_id", None), req.llm_account)
            entry.llm_account = req.llm_account
            entry.llm_model = req.llm_model or None
        elif req.llm_model:
            entry.llm_model = req.llm_model

    entry.status = "RUNNING"
    entry.sse_finished = False
    entry.updated_at = _sm._now()
    if _sm._state_store is not None:
        await _sm._state_store.update_session_status(session_id, "RUNNING")

    await entry._append_json(entry._session_update_json("RUNNING"))

    # 进程可能已重启 / session 结束时已注销 → 从持久化存储重新登记 workspace
    await _ensure_workspace_registered(runtime, session_id)

    try:
        # 传入 entry 上当前所选 LLM：用户改 model 后续跑须用新 model，而非投影里的旧 model。
        await runtime.recover_session(
            session_id, llm_account=entry.llm_account, llm_model=entry.llm_model,
        )
    except RuntimeError as exc:
        entry.status = "INTERRUPTED"
        entry.updated_at = _sm._now()
        if _sm._state_store is not None:
            await _sm._state_store.update_session_status(session_id, "INTERRUPTED")
        raise HTTPException(status_code=422, detail=str(exc))

    entry._consumer_token += 1
    asyncio.create_task(_sm.session_consumer(entry, runtime, entry._consumer_token))

    return entry.to_dict()


@router.post("/{session_id}/interrupt", response_model=dict)
async def interrupt_session(
    session_id: str,
    runtime=Depends(deps.get_runtime),
) -> dict:
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if entry.status not in ("RUNNING", "PAUSED_HITL", "PAUSED", "INTERRUPTED"):
        raise HTTPException(status_code=409, detail=f"Session is not running (status={entry.status})")
    # 软打断只对 RUNNING 生效：运行中任务在 act checkpoint 处 park → 会话转 PAUSED，待下一条
    # /messages 续接（不杀任务）。已处暂停/中断态（PAUSED/PAUSED_HITL/INTERRUPTED）会话本就在
    # 等待，再点暂停是 no-op——**绝不能**在此 _cancel_pending_hitl：软暂停 park 出来的 wait_for_user
    # HITL 是该 SUSPENDED 任务唯一的续跑入口（且为 cold，cancel 不触发续跑），取消它会永久孤立任务、
    # 并经 HitlCancelled 投影把会话翻回 RUNNING，导致会话卡死、无法继续。放弃/停止会话走 /cancel。
    if entry.status == "RUNNING":
        await runtime.pause_session(session_id)
    return entry.to_dict()


@router.post("/{session_id}/tasks/{task_id}/pause", response_model=dict)
async def pause_task_endpoint(
    session_id: str,
    task_id: str,
    runtime=Depends(deps.get_runtime),
) -> dict:
    """定向暂停指定在途 task（spec 2026-07-05 §2.3）：该 run 在检查点 park 自己的 wait
    气泡，经多 pending 面板回复续跑。task 不在跑（已 park / 已终态 / 不存在）→ 409。"""
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if not runtime.pause_task(session_id, task_id):
        raise HTTPException(status_code=409, detail=f"Task {task_id} is not running")
    return entry.to_dict()


@router.post("/{session_id}/cancel", response_model=dict)
async def cancel_session_endpoint(
    session_id: str,
    runtime=Depends(deps.get_runtime),
) -> dict:
    """硬取消：终止当前 + 后续 task（会话 CANCELED、memory 保留），**不删** session 记录。

    供前端「停止对话」入口；开新对话走既有 /messages（terminal → new run，同 session_id + agent_id）。
    """
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if entry.status not in ("RUNNING", "PAUSED_HITL", "PAUSED", "INTERRUPTED"):
        raise HTTPException(status_code=409, detail=f"Session is not active (status={entry.status})")
    await runtime.cancel_session(session_id)
    await _cancel_pending_hitl(session_id)
    return entry.to_dict()


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    runtime=Depends(deps.get_runtime),
) -> dict:
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    if entry.status not in ("SUCCEEDED", "FAILED", "CANCELED", "INTERRUPTED"):
        await runtime.cancel_session(session_id)   # 硬取消：删除前终止整个任务
    # 收口该 session 仍悬挂的 HITL（永久删除，不留内存/投影残留；spec/07 §3/§12）
    await _cancel_pending_hitl(session_id)
    del _sm._sessions[session_id]
    if _sm._state_store is not None:
        await _sm._state_store.delete_session(session_id)
    return {}


@router.get("/{session_id}/tasks", response_model=list)
async def list_tasks(session_id: str) -> list[dict]:
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    await entry.ensure_hydrated()   # 冷 entry 的 tasks 还没装，否则返回空列表
    return list(entry.tasks.values())


@router.post("/{session_id}/messages", response_model=dict)
async def send_message(
    session_id: str,
    req: SendMessageRequest,
    runtime=Depends(deps.get_runtime),
) -> dict:
    logger.info("send_message called: session_id=%s, req.user_info=%s, req.content=%s", session_id, req.user_info, str(req.content)[:100] if req.content else None)
    entry = _sm._sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    # 下方 turn_seq += 1 发生在任何追加之前，_append_json 的闸门来不及；冷 entry 不先补
    # 就会从 1 起算，与这个会话早前已上报过的回合号撞车（云端 upsert 是累加式的）。
    await entry.ensure_hydrated()

    _refuse_if_revoked(entry)

    if entry.status == "RUNNING":
        raise HTTPException(status_code=409, detail="Session is currently running")

    if entry.status == "INTERRUPTED":
        raise HTTPException(
            status_code=409,
            detail="Session was interrupted by a service restart. Use POST /resume to continue.",
        )

    # PAUSED/PAUSED_HITL 会在下方提前返回，所以必须在该分支前刷新登录用户；但要放在
    # RUNNING/INTERRUPTED 的 409 闸门之后，避免一个被拒绝的请求篡改在途任务归属。
    if req.user_info:
        entry.user_info = req.user_info
        logger.info(
            "send_message: updated entry.user_info for session_id=%s, username=%s",
            session_id,
            req.user_info.get("username", "") if isinstance(req.user_info, dict) else "",
        )

    # ── PAUSED_HITL / PAUSED ──────────────────────────────────────────────────
    # 两者都持有一个 pending HITL(ask_user/审批 或 纯文本 wait_for_user),回复同路解析。
    if entry.status in ("PAUSED_HITL", "PAUSED"):
        content = req.content if isinstance(req.content, str) else str(req.content)
        # 同续聊：选了具体账号用它，选了"默认"(null) → 切到 None（= env 默认账号）。
        if req.llm_account:
            entry.llm_account = req.llm_account
            entry.llm_model = req.llm_model or None
        else:
            entry.llm_account = None
            entry.llm_model = None
        return await _submit_hitl_response(entry, content)

    # ── terminal → new run ────────────────────────────────────────────────────
    from ctx_weft import SessionStartParams

    user_prompt = req.content if isinstance(req.content, str) else str(req.content)
    # This is a genuinely new user turn.  Drop any transient references left by
    # the previous run.  The PAUSED/HITL continuation branch above deliberately
    # returns before this point so an approval/answer cannot lose in-turn evidence.
    entry.begin_user_turn()
    # 选了具体账号就用它；选了"默认"(llm_account=null) → 切到 None（运行时解析为 env 默认账号），
    # 不再退回会话上次用的账号。会话记录一并更新，避免一直钉着旧账号。
    if req.llm_account:
        entry.llm_account = req.llm_account
        entry.llm_model = req.llm_model or None
    else:
        entry.llm_account = None
        entry.llm_model = None
    llm_account = entry.llm_account
    llm_model = entry.llm_model

    entry.user_prompt = user_prompt
    entry.status = "RUNNING"
    entry.updated_at = _sm._now()
    entry.turn_seq += 1

    if _sm._state_store is not None:
        await _sm._state_store.update_session_status(session_id, "RUNNING")

    # 投影 RUNNING 由 core 的 SessionResumed 事件驱动（ProjectionUpdater），host 不在此带外
    # 手写：否则若在 core emit SessionResumed 之前崩溃，会留下「投影 RUNNING 但事件日志仍终态」
    # 的状态，崩溃恢复的 list_active_session_ids 看不见它 → 会话永久滞留 RUNNING。内存 entry.status
    # 与下方 SSE 更新仍即时反映（管 409 闸门 + 前端），二者随进程崩溃一并丢失、不污染持久投影。
    await entry._append_json(entry._session_update_json("RUNNING"))
    _rw = deps.get_rewind_manager()
    _msg = {
        "type": "message", "role": "user",
        "content": user_prompt, "created_at": _sm._now(),
    }
    if _rw is not None:               # rewind 开着才带 turn_seq，供前端挂回退按钮
        _msg["turn_seq"] = entry.turn_seq
    await entry._append_json(json.dumps(_msg))

    # rewind：本回合动手【之前】拍一张工作区快照（回滚到此 = 撤销这条消息及其之后的文件改动）。
    # 放在启动 consumer 之前、await 完成，保证快照是回合前的一致状态。无工作区则跳过。
    _ws = getattr(entry, "workspace", None)
    if _rw is not None and _ws:
        await _rw.snapshot_turn(session_id, entry.turn_seq, _ws)

    entry._consumer_token += 1
    entry.sse_finished = False
    asyncio.create_task(_sm.session_consumer(entry, runtime, entry._consumer_token))

    # session 上次结束时 workspace 已从 fs map 注销 → 重跑前从持久化存储重新登记
    await _ensure_workspace_registered(runtime, session_id)

    params = SessionStartParams.create(
        template_id=canonical_template_id(entry.template_id),
        user_prompt=user_prompt,
        session_id=session_id,
        initial_task=req.initial_task,
        tenant_id=entry.tenant_id,
        llm_account=llm_account,
        llm_model=llm_model,
        resume=True,
        context_limit=_resolve_context_limit(runtime, llm_account, llm_model),
        reserved_output_tokens=_resolve_output_reserve(runtime, llm_account, llm_model),
    )
    from ctx_weft.core.errors import UnfinishedTasksError
    try:
        handle = await runtime.start_session(params)
    except UnfinishedTasksError as exc:
        # 弃轮禁止（core 事件真相否决投影状态）：仍有未终结任务 → 不许开新轮,否则滞留
        # 任务被无声遗弃、下次全量重建复活重跑。翻 INTERRUPTED 使 /resume 可走（其闸门
        # 只认该状态）,用户从恢复路径续跑。
        entry.status = "INTERRUPTED"
        entry.updated_at = _sm._now()
        if _sm._state_store is not None:
            await _sm._state_store.update_session_status(session_id, "INTERRUPTED")
        await entry._append_json(entry._session_update_json("INTERRUPTED"))
        raise HTTPException(
            status_code=409,
            detail=f"{exc.message} Use POST /resume to continue.",
        )
    entry.root_agent_id = handle.agent_id

    return entry.to_dict()


@router.post("/{session_id}/webview-content")
async def submit_webview_content(session_id: str, request: Request) -> Response:
    """前端回传应用内浏览器当前页面内容，完成 view_side_web_page 工具的 round-trip。
    body: { request_id, url?, title?, text?, headings?, links? }。找不到 request_id
    （已超时清理）→ 200 no-op。"""
    from netlivecowork.api import webview_bridge
    body = await request.json()
    request_id = body.get("request_id")
    if not request_id:
        raise HTTPException(status_code=400, detail="request_id is required")
    webview_bridge.resolve(request_id, {
        "url": body.get("url", ""),
        "title": body.get("title", ""),
        "text": body.get("text", ""),
        "headings": body.get("headings", []),
        "links": body.get("links", []),
    })
    return Response(status_code=204)


@router.get("/{session_id}/stream")
async def stream_session(session_id: str, request: Request) -> StreamingResponse:
    if session_id not in _sm._sessions:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    raw_id = request.headers.get("last-event-id")
    last_event_id = int(raw_id) if raw_id and raw_id.isdigit() else None
    # ?lean=1：桌面前端要精简版 history（剔除 llm_prompt/daemon_prompt 大 payload）。
    lean = request.query_params.get("lean") in ("1", "true", "yes")
    # ?prompts=stub：调试前端 frontend/ 要 prompt 卡片但扛不住全量 payload，
    # 只发头部 + event_index，展开时走 /events/{i} 回取全文。默认 full=照旧全量。
    prompts = request.query_params.get("prompts") or "full"
    return StreamingResponse(
        _sm.sse_generator(session_id, last_event_id=last_event_id, lean=lean, prompts=prompts),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{session_id}/events/{event_index}")
async def get_session_event(session_id: str, event_index: int) -> Response:
    """按 sse_events 下标取单条原始事件（存根 prompt 卡片展开时回取全文）。

    直接回原始串、不重新序列化：这条本就是 json.dumps 的产物，且单条可达数百 KB。
    """
    raw = await _sm.get_sse_event(session_id, event_index)
    if raw is None:
        raise HTTPException(status_code=404, detail=f"Event {event_index} not found in session {session_id}")
    return Response(content=raw, media_type="application/json")
