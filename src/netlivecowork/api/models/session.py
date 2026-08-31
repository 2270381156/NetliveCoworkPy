    """In-memory session model, registry, SSE consumer and startup utilities."""

from __future__ import annotations

import asyncio
import json

from netlivecowork.api import cowork_bridge
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from ctx_weft.core.events import TASK_STATUS_BY_EVENT, EventType
from netlivecowork.evidence import EvidenceStore, get_evidence_store, normalize_evidence
from netlivecowork.providers.templates import canonical_template_id

if TYPE_CHECKING:
    from netlivecowork.persistence.postgres.state_store import PostgresStateStore
    from netlivecowork.persistence.postgres.event_store import PostgresEventStore

logger = logging.getLogger(__name__)

# ── Globals ───────────────────────────────────────────────────────────────────

_sessions: dict[str, SessionEntry] = {}
_state_store: PostgresStateStore | None = None
_event_store: PostgresEventStore | None = None


def set_state_store(store) -> None:
    global _state_store
    _state_store = store


def set_event_store(store) -> None:
    global _event_store
    _event_store = store


# ── Helpers ───────────────────────────────────────────────────────────────────

# observer 判死但没给 task_failure_reason（core 发空 error_message）时的 notice 兜底文案：
# 说明是 Cowork 的判定而非系统错误。任务已停止，不再引导"是否继续"（歧义）。
_OBSERVER_FAIL_FALLBACK = "该任务由 Cowork 判定为失败，但未给出具体原因。"


def _retry_exhausted_text(lf: dict[str, Any]) -> str:
    """retry 耗尽熔断（TASK_FAILED_RETRY_EXHAUSTED）的 notice 文案：
    上限说明 + 最后一轮 retry 判决的受阻原因（core 经 error_message 带出）；
    无受阻原因（旧 core / 机械退出轮）则只给上限说明。"""
    n = lf.get("retry_count")
    base = (f"任务重试 {n} 次仍未完成，已达重试上限被终止。" if n
            else "任务多次重试仍未完成，已达重试上限被终止。")
    msg = lf.get("message")
    # 有受阻原因就给原因；无（旧 core / 机械退出轮）则引导用户回看执行过程自行判断卡点。
    return base + (f"最后一次受阻于：{msg}" if msg else "可回看上方执行过程了解具体卡在哪。")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_isoformat(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _join_pending(base: list[str], pending: list[str]) -> str | list[str]:
    """把 pending 事件接到基础事件（text_done/reasoning_done）之后。

    无 pending 且只有单条基础事件时返回标量（保持既有返回形态、向后兼容）；
    否则返回列表。
    """
    out = base + pending
    return out if len(out) > 1 else out[0]


# ── SessionEntry ──────────────────────────────────────────────────────────────


class SessionEntry:
    """Host-layer in-memory session state: SSE buffer + event translation."""

    def __init__(
        self,
        session_id: str,
        template_id: str,
        user_prompt: str,
        tenant_id: str,
        llm_model: str | None,
        llm_account: str | None,
        user_info: dict | None = None,
        evidence_store: EvidenceStore | None = None,
    ) -> None:
        self.session_id = session_id
        self.template_id = template_id
        self.user_prompt = user_prompt
        self.tenant_id = tenant_id
        self.llm_model = llm_model
        self.llm_account = llm_account
        self.created_at = _now()
        self.updated_at = _now()

        self.status: str = "RUNNING"
        self.goal: str = user_prompt[:200]
        self.root_agent_id: str | None = None

        self.token_budget: int = 200_000
        self.input_tokens: int = 0        # 累计实际未缓存输入（usage.input_tokens 口径）
        self.output_tokens: int = 0
        self.context_tokens: int = 0
        self.cache_read_used: int = 0     # 累计缓存命中
        self.cache_write_used: int = 0    # 累计缓存写入
        self.failure_counter: int = 0

        self.sse_events: list[str] = []
        self.cond: asyncio.Condition = asyncio.Condition()
        self.sse_finished: bool = False

        # children（tasks / sse_events）是否已从库里装上。新建会话天生是全的；
        # 从投影冷装载的 entry 由 _entry_from_record 置 False，待 ensure_hydrated 补。
        self._hydrated: bool = True
        self._hydrate_lock: asyncio.Lock = asyncio.Lock()

        self.pending_invocations: dict[str, dict[str, Any]] = {}
        # Capability-neutral answer references collected during the current user
        # turn.  Providers hand them off by invocation id through EvidenceStore;
        # Session never needs to know which tool produced them.
        # EvidenceStore implements ``__len__`` and an empty instance is falsey;
        # use an explicit None check so injected stores remain injectable.
        self._evidence_store = evidence_store if evidence_store is not None else get_evidence_store()
        self._answer_evidence: list[dict[str, Any]] = []
        self._in_observe_round: bool = False
        self._daemon_meta_target_task_id: str | None = None
        self._daemon_meta_actual_task_id: str | None = None
        self._daemon_meta_run_id: str | None = None

        self.tasks: dict[str, dict[str, Any]] = {}
        self._consumer_token: int = 0

        # 「一来一回的对话」计数：每接到一条新的用户输入（无论是开新 task，还是应答一个
        # 让 interactive root task 暂停的 HITL）就 +1；同一轮里 actor + background observe
        # 触发的多次真实 LLM 调用共享同一个值。ctx-weft 的 task_id/run_id 在 interactive
        # 模式下会跨多轮暂停/续跑保持不变（root task 只在真正终结后才会换新的），不能拿来
        # 当轮次边界，所以在 host 层自己维护这个计数——见 token_usage_subscriber.py 里的用法。
        # 这里的初值 1 只对"刚创建的新会话"成立；从 DB 冷装载已有会话时会被
        # _load_entry_children 按持久化历史重新算出正确值，见该函数注释。
        self.turn_seq: int = 1

        self.workspace: str | None = None
        # 中断成因（如 "llm_outage"）；仅 INTERRUPTED 态有意义,供前端区分 LLM 故障 vs 通用中断。
        self.interrupt_reason: str | None = None

        # ── session_notice 素材暂存（spec 2026-07-15 session-notice-banner）──
        # _last_task_failure: 最近一次真实任务失败的 {code, message[, retry_count]}。TASK_FAILED
        # （非熔断聚合码）覆盖、TASK_FINISHED 清空——与 failure_counter 折叠同判据，
        # 保证会话判 FAILED 时它就是「导致失败的那次」。
        # _threshold_failures: 熔断连败清单，FAILURE_THRESHOLD_HIT 时整包记下。
        self._last_task_failure: dict[str, Any] | None = None
        self._threshold_failures: dict[str, Any] | None = None

        self.user_info: dict | None = user_info

    def begin_user_turn(self) -> None:
        """Reset transient evidence when a genuinely new user turn starts.

        HITL replies resume the same turn and intentionally do not call this
        method.  Persisted ``text_done.sources`` frames are unaffected.
        """

        self._answer_evidence.clear()
        self._evidence_store.discard_session(self.session_id)

    def _collect_invocation_evidence(self, invocation_id: str, *, accepted: bool) -> None:
        """Consume one provider handoff and, on success, retain it for the answer."""

        references = self._evidence_store.take(self.session_id, invocation_id)
        if accepted and references:
            self._answer_evidence = normalize_evidence(
                [*self._answer_evidence, *references]
            )

    def _take_answer_evidence(self) -> list[dict[str, Any]]:
        references = normalize_evidence(self._answer_evidence)
        self._answer_evidence.clear()
        return references

    # ── Serialisation ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.session_id,
            "user_prompt": self.user_prompt,
            "goal": self.goal,
            "status": self.status,
            "template_id": self.template_id,
            "root_agent_id": self.root_agent_id,
            "token_budget": self.token_budget,
            "input_tokens_used": self.input_tokens,
            "output_tokens_used": self.output_tokens,
            "context_tokens": self.context_tokens,
            "cache_read_tokens_used": self.cache_read_used,
            "cache_write_tokens_used": self.cache_write_used,
            "failure_counter": self.failure_counter,
            "llm_account": self.llm_account,
            "llm_model": self.llm_model,
            "workspace": self.workspace,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            # 只读 = 这条会话的 cowork 此刻不在已装清单里（需求 I4）。
            #
            # **每次请求现算，不入库**：加字段就得在权限恢复时把它清掉，
            # 而"该清没清"是个静默故障——用户权限回来了，会话却永远停在只读。
            # 推导式没有状态要维护：套件装回来，这里自己就变回 False。
            #
            # **由后端给出而不是前端自己算**（架构设计 Q4）：同一条规则两侧各写一遍
            # 必然在某个分支上分岔，而分岔的现象是"界面让你输入，一发就 403"。
            # 后端还永远知道已装清单，不存在前端那个"阵容还没拉到就别判"的时间窗口。
            "readonly": cowork_bridge.is_readonly(self.template_id),
        }

    # ── SSE event builders ──────────────────────────────────────────────────────

    def _session_update_json(self, status: str) -> str:
        """``session_update`` event carries the running token counts.

        INTERRUPTED 态附带 interrupt_reason(如 "llm_outage")——重连时由 SSE 生成器重推,
        让前端在 init/history 之后仍能据此渲染 LLM 故障专属提示。
        """
        return json.dumps({
            "type": "session_update",
            "session_id": self.session_id,
            "status": status,
            "input_tokens_used": self.input_tokens,
            "output_tokens_used": self.output_tokens,
            "cache_read_tokens_used": self.cache_read_used,
            "cache_write_tokens_used": self.cache_write_used,
            "interrupt_reason": self.interrupt_reason if status == "INTERRUPTED" else None,
        })

    def _session_notice_json(self, *, kind: str, reason_code: str,
                             reason_text: str, failures: list, ts: str,
                             reason_data: dict[str, Any] | None = None) -> str:
        """会话通告帧：FAILED 死因 / INTERRUPTED 成因直达前端底部框。
        进 _HISTORY_TYPES（落库 + history 快照 + 重启重灌），前端取最后一条、
        仅当 kind 与当前 session 状态匹配时显示。
        reason_text 是后端预生成的中文兜底；agent 判定类死因（retry 耗尽 / observer
        判死）另带 reason_data 结构化字段（retry_count / message），交前端按 reason_code
        本地化拼文案，reason_text 仅作旧前端 / 日志兜底。"""
        return json.dumps({
            "type": "session_notice",
            "kind": kind,
            "reason_code": reason_code,
            "reason_text": reason_text,
            "reason_data": reason_data or {},
            "failures": failures,
            "created_at": ts,
        })

    def _build_pending_events(self, p: dict, ts: str, task_id: str = "") -> list[str]:
        """从 LLM_RESPONSE_FINISHED 的 tool_calls 派生执行前 tool_call_pending。

        仅非控制能力工具（决策 1）：控制工具名以 "control__" 开头（qualify 用 __ 分隔），跳过。
        observe 轮不派生 pending（决策 3 推翻）：观察者 tool_calls 仅含 name，无 id/arguments，
        其完成事件为 observer_tool_call 类型，不被前端三态合并消费，pending 会永久卡死。
        tool_name 还原 __→: 后取末段裸名，与 tool_call_started 的展示口径对齐。
        """
        if self._in_observe_round:
            return []
        out: list[str] = []
        for tc in p.get("tool_calls", []):
            name = tc.get("name", "")
            if name.startswith("control__"):
                continue
            out.append(json.dumps({
                "type": "tool_call_pending",
                "tool_call_id": tc.get("id", ""),
                "tool_name": name.replace("__", ":").rsplit(":", 1)[-1],
                "arguments": tc.get("arguments", {}),
                "is_control": False,
                "source": "actor",
                "task_id": task_id,                # 见 text_done 处说明：前端按 task 折叠用
                "created_at": ts,
            }))
        return out

    def _resolve_reported_llm(self) -> tuple[str, str]:
        """把"默认账号/模型"（self.llm_account/llm_model 为 None——用户没有明确选择，
        由运行时按 sessions.py send_message 里的既定语义解析成"当前注册的第一个账号"/
        "该账号自己的 default_model"）解析成真实的名字，专门给云端上报用。

        不改 self.llm_account/llm_model 本身——那两个字段在别处（比如桌面端界面自己
        展示"当前用的什么账号"）还要保留 None 表示"跟随默认"这个语义，这里只是在
        上报这一刻单独解析一份真实值，不影响其它地方的行为。解析逻辑照抄
        sessions.py 的 `_runtime_llm_info()`：账号选了具体的就查它自己的
        default_model 补全模型；账号没选（None）就取当前注册的第一个账号。查不到
        （runtime 还没就绪、没有配置任何账号等）就退回空字符串，跟以前的行为一致，
        不会因为这里失败就影响上报主流程。
        """
        try:
            from netlivecowork.api import cowork_bridge, deps

            runtime = deps.get_runtime_optional()
            if runtime is None or not runtime.providers.has_llm_provider():
                return self.llm_account or "", self.llm_model or ""
            provider = runtime.providers.get_llm_provider()
            if self.llm_account:
                if not provider.is_registered(self.llm_account):
                    return self.llm_account, self.llm_model or ""
                acc = provider.get_account(self.llm_account)
            else:
                accounts = provider.list_accounts()
                if not accounts:
                    return "", self.llm_model or ""
                acc = accounts[0]
            return acc.name, self.llm_model or acc.default_model or ""
        except Exception:
            return self.llm_account or "", self.llm_model or ""

    def _report_token_usage(
        self, usage: dict[str, Any],
        event_account: str | None = None, event_model: str | None = None,
    ) -> None:
        """云端 token 用量上报（见 observability/token_usage_subscriber.py 顶部对
        分组粒度演变的说明）；只从 translate_event 处理 LLM_RESPONSE_FINISHED 时
        同步调用，不做网络调用——真正的云端 HTTP 请求由 Electron 完成，这里只落本地
        spool。惰性 import 避免模块加载顺序问题；这里失败也绝不能影响主流程。

        event_account/event_model：事件 payload 携带的「该次调用实际使用的账号/模型」
        （core 2026-07-16 起随 LLMResponseFinished 下发）。优先按它计账——响应处理时读
        「当前会话账号」与「该次调用实际账号」在切换账号时存在竞态，会把账记到错的
        账号头上；replay 旧事件（无此键）回退既有 resolver 行为。
        """
        try:
            from netlivecowork.observability.token_usage_subscriber import report_token_usage

            # "mock" 是 core 的未解析哨兵，不是真模型名：2026-07-16 至 core 回填修复间的
            # 存量事件写死了它，truthy 会压过下面本来正确的回退解析——视同缺失。
            if event_model == "mock":
                event_model = None
            llm_account, llm_model = self._resolve_reported_llm()
            llm_account = event_account or llm_account
            llm_model = event_model or llm_model
            report_token_usage(
                session_id=self.session_id,
                turn_seq=self.turn_seq,
                # 上报口径 = 实际未缓存输入（usage.input_tokens；旧事件回退 prompt_tokens）。
                # 上报量小于旧口径属预期的高估修正（spec 2026-07-16 §8.2），云端消费端已知会。
                prompt_tokens=int(usage.get("input_tokens", usage.get("prompt_tokens") or 0) or 0),
                completion_tokens=int(usage.get("completion_tokens") or 0),
                llm_account=llm_account,
                llm_model=llm_model,
            )
        except Exception:
            logger.exception("Token usage report failed for session %s", self.session_id)

    # ── Event translation ─────────────────────────────────────────────────────

    def translate_event(self, ev: Any) -> str | list[str] | None:  # noqa: C901
        t: str = ev.type
        p: dict = ev.payload
        ts: str = ev.timestamp.isoformat() if ev.timestamp else _now()

        if t == EventType.STEP_STARTED:
            if p.get("step_name") == "observe":
                self._in_observe_round = True
            elif p.get("step_name") == "act":
                self._in_observe_round = False
            return None

        if t in (EventType.STEP_COMPLETED, EventType.STEP_FAILED):
            if p.get("step_name") == "observe":
                self._in_observe_round = False
            return None

        if t == EventType.OBSERVE_COMPLETED:
            # 观察者裁决不再在会话中间展示卡片（retry/fail 都不推）。会话真正失败由底部
            # session_notice 提示条呈现（observer 判死 / 重试耗尽），与此事件解耦。
            return None

        if t == EventType.LLM_REQUEST_STARTED:
            # 放行「LLM 开始」给前端状态条（不产生聊天气泡）。source 用 observe 轮判定。
            source = "observer" if self._in_observe_round else "actor"
            return json.dumps({"type": "llm_request_started", "source": source, "created_at": ts})

        if t == EventType.LLM_RETRY_TRIGGERED:
            # 自愈退避进度（session 仍 RUNNING）→ 前端内联「LLM 连接不稳,重试中(第 N/M 次)」提示。
            # 瞬时进度,不持久化(_NO_PERSIST)、不进 history。
            return json.dumps({
                "type": "llm_retry",
                "attempt": p.get("attempt", 0),
                "max_attempts": p.get("max_attempts", 0),
                "next_delay_sec": p.get("next_delay_sec", 0),
                "created_at": ts,
            })

        if t == EventType.LLM_PROMPT_SENT:
            if self._in_observe_round:
                source, round_label = "observer", f"round_{p.get('round', 0)}"
            else:
                source, round_label = "actor", f"turn_{p.get('turn', 0)}"
            return json.dumps({
                "type": "llm_prompt",
                "source": source,
                "round_label": round_label,
                "task_id": ev.task_id or "",
                "agent_id": ev.agent_id or "",
                "system_prompt": p.get("system", ""),
                "messages": p.get("messages", []),
                "tool_names": p.get("tool_names", []),
                "created_at": ts,
            })

        if t == EventType.LLM_TOKEN_STREAMED:
            delta = p.get("delta", "")
            if not delta:
                return None
            if self._in_observe_round:
                return json.dumps({"type": "observer_text_delta", "delta": delta,
                                   "round_label": f"round_{p.get('round', 0)}"})
            return json.dumps({"type": "text_delta", "delta": delta, "round": p.get("turn", 0)})

        if t == EventType.LLM_REASONING_STREAMED:
            delta = p.get("delta", "")
            if not delta:
                return None
            if self._in_observe_round:
                return json.dumps({"type": "observer_reasoning_delta", "delta": delta,
                                   "round_label": f"round_{p.get('round', 0)}"})
            return json.dumps({"type": "reasoning_delta", "delta": delta, "round": p.get("turn", 0)})

        if t == EventType.LLM_RESPONSE_FINISHED:
            content = p.get("content", "")
            reasoning = p.get("reasoning", "")
            usage = p.get("usage", {})
            # 「累计输入」= 实际未缓存输入（usage.input_tokens；replay 旧事件回退
            # prompt_tokens）。总输入口径每轮把整个上下文重复累加，严重高估真实成本
            # （spec 2026-07-16 llm-usage-cache-split §8.1）。
            self.input_tokens += usage.get("input_tokens", usage.get("prompt_tokens", 0))
            self.output_tokens += usage.get("completion_tokens", 0)
            self.cache_read_used += usage.get("cache_read_tokens", 0)
            self.cache_write_used += usage.get("cache_write_tokens", 0)
            # 当前窗口仍取 prompt 总输入：窗口规模与缓存无关
            self.context_tokens = usage.get("prompt_tokens", 0) or self.context_tokens
            # 云端 token 用量上报挂在这里（而不是独立的 EventBus 订阅者）：这条路径由
            # session_consumer 对同一 session 严格顺序消费，turn_seq 只有等这一轮的暂停
            # 事件也处理完、用户能发下一条消息时才会 +1，此刻读到的必然是这一轮自己的
            # turn_seq，不会有别的分发路径异步延迟导致读到下一轮的值（详见
            # observability/token_usage_subscriber.py 顶部的坑 d)）。
            self._report_token_usage(usage, p.get("llm_account"), p.get("llm_model"))
            asyncio.ensure_future(self._append_json(json.dumps({
                "type": "token_update",
                "input_tokens_used": self.input_tokens,
                "output_tokens_used": self.output_tokens,
                "cache_read_tokens_used": self.cache_read_used,
                "cache_write_tokens_used": self.cache_write_used,
                "context_tokens": self.context_tokens,
            })))
            pending = self._build_pending_events(p, ts, ev.task_id or "")
            if self._in_observe_round:
                round_label = f"round_{p.get('round', 0)}"
                base = []
                if reasoning:
                    base.append(json.dumps({"type": "observer_reasoning_done", "text": reasoning, "created_at": ts}))
                base.append(json.dumps({"type": "observer_text_done", "text": content, "round_label": round_label, "created_at": ts}))
                return _join_pending(base, pending)
            turn = p.get("turn", 0)
            text_payload: dict[str, Any] = {
                "type": "text_done",
                "text": content,
                "round": turn,
                "context_tokens": self.context_tokens,
                # 前端按 task 折叠会话（一个 task 的回复+工具调用收成一个胶囊）需要归属信息。
                # 并发 task 交错推送时，只有它能把各自的事件流分开、不串成一坨。
                "task_id": ev.task_id or "",
                "created_at": ts,
            }
            # References belong only to the root agent's user-visible final
            # response. ``finish_task`` is a terminal marker emitted alongside
            # the final text, while any other tool call means the response is
            # still an intermediate planning step and must not consume them.
            is_root_response = (
                self.root_agent_id is None
                or getattr(ev, "agent_id", None) == self.root_agent_id
            )
            tool_calls = p.get("tool_calls") or []
            has_follow_up_tool_calls = any(
                not isinstance(tool_call, dict)
                or tool_call.get("name") not in {"control__finish_task", "finish_task"}
                for tool_call in tool_calls
            )
            if content and not has_follow_up_tool_calls and is_root_response:
                sources = self._take_answer_evidence()
                if sources:
                    text_payload["sources"] = sources
            text_done = json.dumps(text_payload)
            base = []
            if reasoning:
                base.append(json.dumps({"type": "reasoning_done", "text": reasoning, "round": turn, "created_at": ts}))
            base.append(text_done)
            return _join_pending(base, pending)

        if t == EventType.CAPABILITY_INVOKED:
            inv_id = p.get("invocation_id", "")
            cap_id = p.get("capability_id", "")
            raw_tool_name = p.get("capability_name", "")
            # ctx-weft exposes qualified names such as web__web_fetch. Keep other
            # providers unchanged and remove only the Web provider prefix for UI.
            tool_name = (
                raw_tool_name.removeprefix("web__")
                if cap_id.startswith("web:")
                else raw_tool_name
            )
            # recognize_intent 现与 act 并发跑在同一 root task 上，task_id 不再能区分两者；
            # 改用 run_id 判定：daemon 快照有独立 run_id（见 launch_recognize_intent）。
            is_daemon = bool(
                self._daemon_meta_run_id
                and getattr(ev, "run_id", None) == self._daemon_meta_run_id
            )
            self.pending_invocations[inv_id] = {
                "tool_name": tool_name,
                # capability_id（带 provider 前缀，如 "control:finish_task"）才是判断
                # control 工具的依据；capability_name 是裸名，startswith("control:") 永不成立。
                "capability_id": p.get("capability_id", ""),
                "arguments": p.get("arguments", {}),
                "_is_daemon": is_daemon,
                "_is_observe": self._in_observe_round,
            }
            if is_daemon:
                # daemon（recognize_intent）的活动不进状态条。
                return None
            # 放行「工具开始」给前端状态条（不产生聊天气泡）。is_control 用 capability_id 前缀判定。
            return json.dumps({
                "type": "tool_call_started",
                "invocation_id": inv_id,
                "tool_call_id": p.get("tool_call_id", ""),
                "tool_name": tool_name,
                "is_control": cap_id.startswith("control:"),
                "source": "observer" if self._in_observe_round else "actor",
                "created_at": ts,
            })

        if t == EventType.CAPABILITY_FINISHED:
            inv_id = p.get("invocation_id", "")
            pending = self.pending_invocations.pop(inv_id, {})
            self._collect_invocation_evidence(
                inv_id,
                accepted=(p.get("outcome") != "error" and not pending.get("_is_daemon")),
            )
            if pending.get("_is_daemon"):
                return None
            tool_name = pending.get("tool_name", p.get("capability_name", ""))
            # 按 capability_id 的 provider 前缀判断是否 control 工具（CAPABILITY_FINISHED
            # 不带 capability_id，用 INVOKED 时存下的 pending）。
            cap_id = pending.get("capability_id", "")
            is_control = cap_id.startswith("control:")
            is_observe = pending.get("_is_observe", False)
            payload = {
                "tool_name": tool_name,
                "tool_call_id": p.get("tool_call_id", ""),
                "arguments": pending.get("arguments", p.get("arguments", {})),
                "result": p.get("result", ""),
                "is_error": p.get("outcome") == "error",
                "task_id": ev.task_id or "",       # 见 text_done 处说明：前端按 task 折叠用
                "created_at": ts,
            }
            if is_observe:
                kind = "observer_control_tool_call" if is_control else "observer_tool_call"
            else:
                kind = "control_tool_call" if is_control else "tool_call"
            # finish_task 反转契约（spec 2026-07-01）：答复即消息正文（正常 message 气泡），
            # finish_task 退化为收尾标记 → 前端不再把它渲染成总结卡，故不需 is_root 标记。
            return json.dumps({"type": kind, **payload})

        if t == EventType.HITL_REQUIRED:
            form = p.get("form", "question")
            # 纯文本暂停(form=wait): 软待命,不弹 HITL 面板 → 前端回落普通输入框。
            if form == "wait":
                self.status = "PAUSED"
                self.updated_at = _now()
                return self._session_update_json("PAUSED")
            self.status = "PAUSED_HITL"
            self.updated_at = _now()
            return json.dumps({
                "type": "waiting_input",
                # input_type=user_input → 前端渲染文本输入框
                "input_type": "user_input",
                # kind=approval → 前端渲染 Approve/Reject 按钮;input → 文本框（契约冻结,由 form 派生）
                "kind": "approval" if form == "approval" else "input",
                # 精确应答所需:前端据 hitl_id 调 /hitl/{id}/answer|approve|reject(additive 字段)
                "hitl_id": p.get("hitl_id", ""),
                "form": form,
                "prompt": p.get("question", "HITL approval required"),
                # approval 审批门控时把调用参数透传给前端,供人工判断是否放行
                "arguments": p.get("arguments") or {},
                # ask_user 的结构化批量问题(含 options/multi_select),前端据此渲染选项面板
                "questions": p.get("questions") or [],
                "task_title": p.get("capability_id", ""),
                "created_at": ts,
            })

        if t in (EventType.HITL_APPROVED, EventType.HITL_REJECTED,
                 EventType.HITL_MODIFIED, EventType.HITL_ANSWERED):
            if self.status in ("PAUSED_HITL", "PAUSED"):
                self.status = "RUNNING"
                self.updated_at = _now()
            return self._session_update_json(self.status)

        if t == EventType.SESSION_STATUS_CHANGED:
            new_status = p.get("new_status") or p.get("status", "")
            if new_status:
                self.status = new_status
                self.updated_at = _now()
                # 仅 INTERRUPTED 记成因;离开中断态(如 resume→RUNNING)清空,避免旧成因泄漏。
                self.interrupt_reason = p.get("reason") if new_status == "INTERRUPTED" else None
                update = self._session_update_json(new_status)
                # ── session_notice 合成 ──
                # FAILED 素材优先级：熔断（已在 FAILURE_THRESHOLD_HIT 处合成，跳过）
                # > 最近真实失败（observer 判决摘要）> 通用兜底。
                # INTERRUPTED：reason_code 透传，展示文案由前端按 code 映射。
                if new_status == "FAILED" and p.get("reason") != "failure_threshold":
                    lf = self._last_task_failure or {}
                    code = lf.get("code") or "SESSION_FAILED"
                    # retry 耗尽熔断另有专属文案（上限说明 + 受阻原因）；其余无死因分两档：
                    # observer 判死（有素材、message 空）→ 固定提示文案（agent 判定 +
                    # 引导回看执行过程）；连素材都没有 → 通用兜底。
                    # reason_text 保留中文兜底，另带 reason_data 供前端本地化拼文案。
                    reason_data: dict[str, Any] = {}
                    if code == "TASK_FAILED_RETRY_EXHAUSTED":
                        reason_text = _retry_exhausted_text(lf)
                        reason_data = {"retry_count": lf.get("retry_count"),
                                       "message": lf.get("message") or ""}
                    elif code == "TASK_FAILED_BY_OBSERVER":
                        reason_text = lf.get("message") or _OBSERVER_FAIL_FALLBACK
                        reason_data = {"message": lf.get("message") or ""}
                    else:
                        reason_text = lf.get("message") or "会话失败"
                    return [update, self._session_notice_json(
                        kind="failed",
                        reason_code=code,
                        reason_text=reason_text,
                        reason_data=reason_data,
                        failures=[],
                        ts=ts,
                    )]
                if new_status == "INTERRUPTED":
                    return [update, self._session_notice_json(
                        kind="interrupted",
                        reason_code=p.get("reason") or "",
                        reason_text="任务被中断",
                        failures=[],
                        ts=ts,
                    )]
                return update
            return None

        if t == EventType.SESSION_PAUSED_HITL:
            self.status = "PAUSED" if p.get("form") == "wait" else "PAUSED_HITL"
            self.updated_at = _now()
            return self._session_update_json(self.status)

        if t == EventType.RUN_CANCELED:
            self.updated_at = _now()
            return json.dumps({"type": "interrupted", "created_at": ts})

        if t == EventType.SESSION_FINISHED:
            self.sse_finished = True
            self.updated_at = _now()
            return json.dumps({"type": "done", "final_status": self.status})

        if t == EventType.RUN_FINISHED:
            will_retry = p.get("will_retry", False)
            final_status = p.get("final_status")
            # 崩溃挂起（core 新语义：运行层崩溃不再终态 FAILED，final_status=SUSPENDED 且带 error）：
            # 错误文案仍要冒泡给用户，并标 recoverable 提示可 /resume（可换模型）续跑。
            # 干净挂起（HITL park / 委派等子 / LLM outage）error 为 None，不冒泡。
            # 排除 will_retry：自动重试中的 run 不是可 /resume 的挂起——重试由 core 自驱，
            # 气泡只标 will_retry 不标 recoverable，避免会话仍是 RUNNING 时误现 resume 入口。
            crashed_suspend = (
                final_status == "SUSPENDED" and bool(p.get("error")) and not will_retry
            )
            if final_status == "FAILED" or will_retry or crashed_suspend:
                self.updated_at = _now()
                return json.dumps({
                    "type": "task_failed",
                    # observer 判死时 run_error 为 None（run 正常收尾、死因在 verdict 里）——
                    # 回落到 TASK_FAILED 暂存的判决摘要：气泡与持久化帧都带真实死因，
                    # restore 回填（_load_entry_children）据此跨重启保持精确。
                    "error": (p.get("error")
                              or (self._last_task_failure or {}).get("message")
                              or "Task failed"),
                    "error_type": p.get("error_type", ""),
                    "will_retry": will_retry,
                    "recoverable": crashed_suspend,
                    "created_at": ts,
                })
            return None

        if t == EventType.FAILURE_THRESHOLD_HIT:
            # failure_counter 真折叠（与 core reducer / postgres 投影三处同义）：
            # 熔断补标的聚合失败（TASK_FAILED_BY_THRESHOLD）不是「新的一次失败」，不计数；
            # 计数改由下方 TASK_STATUS_BY_EVENT 分支里的 TASK_FAILED/TASK_FINISHED 承担。
            # 熔断必然走到 SESSION_STATUS_CHANGED(FAILED)（trip 序列步骤 2→8 无条件），
            # failed notice 在此即刻合成：素材（连败清单）在手且立刻持久化，崩在
            # 步骤 2~8 之间也不丢死因；STATUS_CHANGED(reason=failure_threshold) 不再重复合成。
            self._threshold_failures = {
                "failures": p.get("failures") or [],
                "counter": p.get("failure_counter", 0),
                "threshold": p.get("threshold", 0),
            }
            self.updated_at = _now()
            return self._session_notice_json(
                kind="failed",
                reason_code="TASK_FAILED_BY_THRESHOLD",
                reason_text=(
                    f"连续 {self._threshold_failures['counter']} 次子任务失败，"
                    f"达到熔断阈值（{self._threshold_failures['threshold']}），会话已终止"
                ),
                failures=self._threshold_failures["failures"],
                ts=ts,
            )

        if t == EventType.MEMORY_COMPACT_STARTED:
            # 压缩开始 → 前端状态条 'compacting'（瞬时，不持久、不进 history）。
            return json.dumps({"type": "compact_started",
                               "trigger": p.get("trigger", "compact"),
                               "created_at": ts})

        if t == EventType.MEMORY_COMPACT_FINISHED:
            # 压缩收尾：仅当确有折叠才落一条持久标记；未折叠则静默不留痕。
            if p.get("total_superseded", 0) <= 0:
                return None
            return json.dumps({"type": "context_compacted",
                               "total_superseded": p.get("total_superseded", 0),
                               "freed_tokens": p.get("freed_tokens", 0),
                               "levels": p.get("levels", []),
                               "trigger": p.get("trigger", "compact"),
                               "created_at": ts})

        # 注：MEMORY_COMPACTED（每级折叠）仅作 telemetry，不再翻成前端事件（旧 before/after 0/0
        # bug 分支已移除）；COMPACT_TRIGGERED 是旧派发式压缩遗留、核心已不 emit，死分支已删。二者
        # 均落到本函数末尾 `return None`。

        if t == EventType.TASK_CREATED:
            task_data = p.get("task") or {
                "id": ev.task_id or "",
                "session_id": self.session_id,
                "status": "ACTIVE",
                "title": p.get("title", "Task"),
                "description": p.get("description", ""),
                "creator_agent_id": ev.agent_id or "",
                "assigned_agent_id": ev.agent_id or "",
                "user_prompt": "",
                "settings": {},
                "result": None,
                "outputs": {},
                "error": None,
                "created_at": ts,
                "updated_at": ts,
            }
            if (task_data.get("settings") or {}).get("_type") == "MetadataFillerTaskSettings":
                return None
            task_id = task_data.get("id") or ev.task_id or ""
            if task_id:
                self.tasks[task_id] = task_data
            return json.dumps({"type": "task_created", "task": task_data})

        if t == EventType.RECOGNIZE_INTENT_STARTED:
            task_id = p.get("task_id", ev.task_id or "")
            self._daemon_meta_actual_task_id = ev.task_id or task_id or None
            self._daemon_meta_target_task_id = p.get("target_task_id") or task_id or None
            # 并发快照 run 的标识——act 主 run 用不同 run_id，据此把 daemon 工具调用与 act 区分开。
            self._daemon_meta_run_id = getattr(ev, "run_id", None)
            # recognize_intent 已不是真 task：只保留上面三个记账字段（状态条过滤 + 真 root task
            # 更新用），不再向前端合成 daemon task 的创建/完成生命周期。元数据结果改由 COMPLETED
            # 的真 task_updated 体现。
            return None

        if t == EventType.RECOGNIZE_INTENT_LLM_PROMPT:
            return json.dumps({
                "type": "daemon_prompt",
                "source": "recognize_intent",
                "task_id": ev.task_id or "",
                "agent_id": ev.agent_id or "",
                "system_prompt": p.get("system", ""),
                "messages": p.get("messages", []),
                "tool_names": p.get("tool_names", []),
                "created_at": ts,
            })

        if t == EventType.RECOGNIZE_INTENT_TOOL_CALL:
            session_goal = p.get("session_goal", "")
            goal_frame = None
            if session_goal and session_goal != self.goal:
                self.goal = session_goal
                self.updated_at = _now()
                goal_frame = json.dumps({"type": "session_goal_updated", "goal": session_goal})
            tool_frame = json.dumps({
                "type": "daemon_control_tool_call",
                "tool_name": "update_task_metadata",
                "arguments": {
                    "title": p.get("title", ""),
                    "description": p.get("description", ""),
                    "session_goal": session_goal,
                },
                "result": f"title={p.get('title', '')!r}",
                "is_error": False,
                "created_at": ts,
            })
            return [goal_frame, tool_frame] if goal_frame else tool_frame

        if t == EventType.RECOGNIZE_INTENT_COMPLETED:
            session_goal = p.get("session_goal", "")
            goal_frame = None
            if session_goal and session_goal != self.goal:
                self.goal = session_goal
                self.updated_at = _now()
                goal_frame = json.dumps({"type": "session_goal_updated", "goal": session_goal})
            target_id = self._daemon_meta_target_task_id
            title, description = p.get("title", ""), p.get("description", "")
            if target_id and target_id in self.tasks and (title or description):
                task = self.tasks[target_id]
                if title:
                    task["title"] = title
                if description:
                    task["description"] = description
                task["updated_at"] = ts
                asyncio.ensure_future(self._append_json(
                    json.dumps({"type": "task_updated", "task": dict(task)})
                ))
            # 真 root task 的 title/description 已通过上面的 task_updated 体现；不再合成 daemon task。
            return goal_frame

        if t == EventType.RECOGNIZE_INTENT_SKIPPED:
            # 无真 task 生命周期可收尾——跳过即静默，不向前端合成 daemon task 取消事件。
            return None

        if t in TASK_STATUS_BY_EVENT:
            # ── failure_counter 折叠（Task 11/12，与 core reducer 同义）──
            # TASK_FAILED：普通失败 +1（熔断聚合失败 TASK_FAILED_BY_THRESHOLD 不计——
            # 它是聚合结果非新失败）；TASK_FINISHED：成功清零（连败语义）。
            if t == EventType.TASK_FAILED:
                if (p or {}).get("error_code") != "TASK_FAILED_BY_THRESHOLD":
                    self.failure_counter += 1
                    # notice 素材：与计数同判据同生命周期（FINISHED 一并清空）。
                    self._last_task_failure = {
                        "code": (p or {}).get("error_code") or "TASK_FAILED",
                        "message": (p or {}).get("error_message") or (p or {}).get("error") or "",
                    }
                    # retry 耗尽熔断的文案要报次数；仅在 payload 携带时存，别扰动老素材形状。
                    if (p or {}).get("retry_count") is not None:
                        self._last_task_failure["retry_count"] = (p or {}).get("retry_count")
            elif t == EventType.TASK_FINISHED:
                self.failure_counter = 0
                self._last_task_failure = None

            task_id = ev.task_id or ""
            if task_id and task_id in self.tasks:
                self.tasks[task_id]["status"] = TASK_STATUS_BY_EVENT[t]
                self.tasks[task_id]["updated_at"] = ts
                return json.dumps({"type": "task_updated", "task": self.tasks[task_id]})
            return None

        return None

    # ── Lazy hydration ────────────────────────────────────────────────────────

    async def ensure_hydrated(self) -> None:
        """按需把 children（tasks / sse_events + 两个派生值）从库里装上。幂等、可并发调用。

        启动时只灌元数据（见 load_sessions_from_db），children 推迟到这里，因为列表页的
        to_dict() 一个字段都不用它们，而全量装载的成本是 O(全部会话的历史总字节)。

        并发要单飞：两个协程同时装会把历史 extend 两遍，SSE 的 `id:`（就是 sse_events 下标）
        随之整体错位，前端按 Last-Event-ID 续点会读到错的位置。
        """
        if self._hydrated:
            return
        async with self._hydrate_lock:
            if self._hydrated:      # 等锁期间已被别人装好
                return
            if _state_store is not None:
                await _load_entry_children(self, _state_store)
            self._hydrated = True

    # ── SSE buffer ────────────────────────────────────────────────────────────

    _NO_PERSIST = frozenset({"text_delta", "reasoning_delta", "llm_retry", "compact_started", "webview_content_request"})

    async def _append_json(self, json_str: str) -> None:
        # 追加前必须先补齐历史：否则新帧落在空 list 的 0 号位，既丢历史又让 SSE 下标错位。
        # 闸门放在这里（而不是散在各调用方）才能保证漏不掉——rewind / webview_bridge /
        # fs_write_authorizer 都是绕过 API 层直接往流里写的。
        await self.ensure_hydrated()
        async with self.cond:
            self.sse_events.append(json_str)
            self.cond.notify_all()
        if _state_store is not None:
            try:
                ev_type = json.loads(json_str).get("type", "")
                if ev_type not in self._NO_PERSIST:
                    await _state_store.append_sse_event(self.session_id, json_str)
            except Exception:
                logger.exception("SSE persist failed for session %s", self.session_id)

    async def append_event(self, ev: Any) -> None:
        # 必须在 translate_event 之前：它要读 turn_seq 和 _last_task_failure，
        # 这两个值都是 hydrate 时按持久化历史算出来的。
        await self.ensure_hydrated()
        translated = self.translate_event(ev)
        items: list[str] = translated if isinstance(translated, list) else ([translated] if translated else [])
        async with self.cond:
            self.sse_events.extend(items)
            self.updated_at = _now()
            self.cond.notify_all()
        if _state_store is not None:
            for item in items:
                try:
                    ev_type = json.loads(item).get("type", "")
                    if ev_type not in self._NO_PERSIST:
                        await _state_store.append_sse_event(self.session_id, item)
                except Exception:
                    logger.exception("SSE persist failed for session %s", self.session_id)


# ── Event consumer ────────────────────────────────────────────────────────────


class EventFeed:
    """一条**已经订阅上**的事件流。

    存在的理由只有一个：`event_bus.stream()` 是异步生成器，真正登记订阅要等
    `async for` 跑起来那一刻。而 run 在 `start_session` 返回之前就已经开跑了，
    中间还隔着写库、拍工作区快照这些 await（快照要拷整个工作区，几秒很正常）。
    这段时间里发出的事件**没有任何订阅者，而总线不回放** —— 永久丢失。

    表现：新建会话的第一轮，界面上只留下半截（比如一个控制工具调用），回复不见了；
    而事件表里一切完整，重启也补不回来 —— history 读的是持久化的帧日志，
    不是从事件重放。

    `bus.subscribe()` 是**同步**的：函数返回时订阅已在册。所以在 `start_session`
    之前 `open()` 一次，那个窗口就彻底不存在了。

    handler 里只做一次 `put_nowait`（它是在 emit 里同步调的，不能干重活）；
    写库那些留在消费者自己的 task 里。队列不设上限：丢事件正是要修的问题本身。
    """

    def __init__(self, bus: Any, session_id: str) -> None:
        self._bus = bus
        self._session_id = session_id
        self._queue: asyncio.Queue = asyncio.Queue()
        self._handle = bus.subscribe(None, self._push)   # 同步登记，返回即已订阅

    async def _push(self, ev: Any) -> None:
        if getattr(ev, "session_id", None) == self._session_id:
            self._queue.put_nowait(ev)

    async def __aiter__(self):
        while True:
            yield await self._queue.get()

    async def close(self) -> None:
        try:
            await self._handle.unsubscribe()
        except Exception:
            logger.exception("EventFeed unsubscribe failed for %s", self._session_id)


def open_event_feed(runtime: Any, session_id: str) -> "EventFeed | None":
    """在 run 开跑**之前**把订阅挂上。失败返回 None —— 消费者会自己再开一条。"""
    try:
        return EventFeed(runtime.event_bus, session_id)
    except Exception:
        logger.exception("open_event_feed failed for %s", session_id)
        return None


async def session_consumer(entry: SessionEntry, runtime: Any, token: int,
                           feed: "EventFeed | None" = None) -> None:
    if feed is None:
        feed = EventFeed(runtime.event_bus, entry.session_id)
    try:
        async for ev in feed:
            if entry._consumer_token != token:
                break
            await entry.append_event(ev)
            if ev.type == "SessionFinished":
                break
    except Exception:
        logger.exception("Session consumer error for %s", entry.session_id)
        async with entry.cond:
            if entry.status == "RUNNING":
                entry.status = "FAILED"
            entry.cond.notify_all()
    finally:
        await feed.close()


# ── SSE generator ─────────────────────────────────────────────────────────────


_HEARTBEAT_INTERVAL = 3.0  # seconds between keepalive pings

# 进入历史快照（history 事件）的时间线类型——消息、模型输出、工具调用、prompt 调试帧。
# 不含流式 delta（未持久化）、token_update/session_update/ping 等瞬时控制事件。
#
# tool_call_pending 也纳入：否则「还在执行中」的工具调用在重连/切回时（历史全量重放）
# 会从 UI 消失——它本就存在 sse_events 里（不在 _NO_PERSIST），只是历史白名单漏了它。
# 前端按 tool_call_id 幂等合并（toolCallMerge）：已完成的工具 pending+result 会并成一条
# 「已完成」，不会重复；还在跑的只有 pending → 显示「执行中」直到结果回来。
_HISTORY_TYPES = frozenset({
    "message",
    "session_goal_updated",
    "llm_prompt", "daemon_prompt",
    "text_done", "reasoning_done",
    "observer_text_done", "observer_reasoning_done",
    "tool_call_pending",
    "tool_call", "control_tool_call",
    "observer_tool_call", "observer_control_tool_call",
    "daemon_control_tool_call",
    "image",
    "session_notice",
    "context_compacted",
    "rewind_record",   # rewind：回滚记录（持久化 + 历史重放，前端挂到对应回合消息下方）
    "rewind_undone",   # rewind：撤销回滚事件（同样要历史重放，否则继续对话后"已撤销"标记会丢、退回正常记录）
})

# 精简版（?lean=1）history 额外剔除的类型：llm_prompt / daemon_prompt 是每轮发给模型的完整
# prompt（系统提示+全上下文+工具定义），随对话平方级膨胀（实测长会话可达 20MB+，占首帧 98%）。
# 桌面前端不消费它们，故请求精简版跳过以加速首屏。
_LEAN_EXCLUDE = frozenset({"llm_prompt", "daemon_prompt"})

# 存根版（?prompts=stub）：调试前端(frontend/)靠 prompt 卡片吃饭，不能像 lean 那样整类剔除，
# 但也扛不住把 62MB prompt 塞进一个 history frame（浏览器缓冲 + JSON.parse 直接卡死）。
# 折中——只留卡片折叠态要显示的头部字段 + event_index，正文(system_prompt/messages)留空，
# 展开时前端按 event_index 走 GET /sessions/{id}/events/{i} 单条回取全文。
_PROMPT_TYPES = frozenset({"llm_prompt", "daemon_prompt"})
_STUB_KEEP = ("type", "source", "round_label", "task_id", "agent_id", "tool_names", "created_at")


def _prompt_stub_json(obj: dict, index: int, raw_len: int) -> str:
    """把已解析的 prompt 帧压成存根串。bytes 供调试前端显示这条有多大。"""
    stub = {k: obj[k] for k in _STUB_KEEP if k in obj}
    stub["stub"] = True
    stub["event_index"] = index
    stub["bytes"] = raw_len
    return json.dumps(stub)


async def get_sse_event(session_id: str, index: int) -> str | None:
    """按 sse_events 下标取单条原始事件串（存根卡片展开时回取全文）。越界/无会话 → None。

    下标口径与增量补发的 `id:` 一致：sse_events 是 append-only，下标在 entry 生命周期内稳定。
    """
    entry = _sessions.get(session_id)
    if entry is None or index < 0:
        return None
    await entry.ensure_hydrated()
    if index >= len(entry.sse_events):
        return None
    return entry.sse_events[index]


def _pending_hitl_of(session_id: str) -> list:
    """该 session 的 pending HITL 真值（created_at 升序;form=wait 无面板,滤掉）。

    manager 未配置/查询异常 → 空表,调用方回退存量帧重放。惰性 import 避免 api.deps 循环依赖。
    """
    try:
        from netlivecowork.api import deps as _deps
        hitl = _deps.get_hitl_manager()
        if hitl is None:
            return []
        pending = [r for r in hitl.list_pending(session_id=session_id) if r.form != "wait"]
        pending.sort(key=lambda r: (r.created_at is None, r.created_at))
        return pending
    except Exception:
        logger.exception("sse_generator: pending HITL lookup failed for %s", session_id)
        return []


def _waiting_input_json(req) -> str:
    """从 HitlRequest 合成 waiting_input SSE 帧——与 translate_event 的 HITL_REQUIRED 分支同形。"""
    return json.dumps({
        "type": "waiting_input",
        "input_type": "user_input",
        "kind": "approval" if req.form == "approval" else "input",
        "hitl_id": req.id,
        "form": req.form,
        "prompt": req.question or ("HITL approval required" if req.form == "approval" else ""),
        "arguments": req.arguments or {},
        "questions": req.questions or [],
        "task_title": req.capability_id,
        "created_at": req.created_at.isoformat() if req.created_at else _now(),
    })


async def sse_generator(session_id: str, last_event_id: int | None = None, lean: bool = False,
                        prompts: str = "full"):
    entry = _sessions.get(session_id)
    if entry is None:
        yield f"data: {json.dumps({'type': 'error', 'message': 'Session not found'})}\n\n"
        return

    # 冷装载的 entry 在这里补齐 children：下面的 init 帧要 tasks、history/续点要 sse_events。
    # 必须在取 snapshot 之前，否则首屏是空历史（静默错误，比 404 更难查）。
    await entry.ensure_hydrated()

    # 存根模式对 history / 断点补发 / 实时推送三条路径一律生效：只压 history 的话，长会话
    # 边跑边攒的 prompt 仍会把前端内存顶爆（每条 ~200KB）。lean 已整类剔除，两者不叠加。
    stub_prompts = prompts == "stub" and not lean

    # Reconnect hint: browser should retry after 3s
    yield "retry: 3000\n\n"

    # Always send init with the current session state (including INTERRUPTED after restart)
    yield f"data: {json.dumps({'type': 'init', 'session': entry.to_dict(), 'tasks': list(entry.tasks.values()), 'messages': [], 'daemon_tasks': []})}\n\n"

    async with entry.cond:
        snapshot = list(entry.sse_events)
        idx = len(entry.sse_events)

    if last_event_id is None:
        # Fresh connect — 一次性下发完整历史快照（含消息和工具调用），
        # 而非逐条 replay，避免前端重复渲染。
        # lean（桌面端 ?lean=1）额外剔除 llm_prompt/daemon_prompt，砍掉占首帧 98% 的 prompt 大 payload。
        # 过滤要解析（只为拿 type），但下发的是**原始串**、不再 json.dumps 回去：
        # 存进来的每条本就是 json.dumps 的产物，重新序列化一遍纯属白干，而最大的会话
        # 首屏有 66MB，这一遍的开销和解析同量级。拼接格式与 json.dumps 的默认分隔符一致。
        allow = _HISTORY_TYPES - _LEAN_EXCLUDE if lean else _HISTORY_TYPES
        kept: list[str] = []
        for i, evt_json in enumerate(snapshot):
            try:
                obj = json.loads(evt_json)
            except Exception:
                continue
            t = obj.get("type")
            if t not in allow:
                continue
            # 存根模式：prompt 帧只下发头部（lean 已整类剔除，走不到这）。
            if stub_prompts and t in _PROMPT_TYPES:
                kept.append(_prompt_stub_json(obj, i, len(evt_json)))
            else:
                kept.append(evt_json)
        yield f'data: {{"type": "history", "events": [{", ".join(kept)}]}}\n\n'
    else:
        # Reconnect with Last-Event-ID — 增量补发客户端尚未收到的事件
        for i in range(last_event_id + 1, len(snapshot)):
            evt_json = snapshot[i]
            try:
                obj = json.loads(evt_json)
                if obj.get("type") == "done":
                    continue
                if stub_prompts and obj.get("type") in _PROMPT_TYPES:
                    evt_json = _prompt_stub_json(obj, i, len(evt_json))
            except Exception:
                pass
            yield f"id: {i}\n"
            yield f"data: {evt_json}\n\n"

    # Always push current status so the client catches INTERRUPTED even after a gap
    yield f"data: {entry._session_update_json(entry.status)}\n\n"

    # PAUSED_HITL：waiting_input 是瞬时控制事件,不进 history（_HISTORY_TYPES）,且 init 会清空
    # waitingInput → 重连/重启后提问框会消失。据当前 PAUSED 态补发 waiting_input,让前端重渲染。
    # 仅当确实暂停时补发,故不会复活已解决的旧框。
    # 仅 PAUSED_HITL 补发 waiting_input 面板;PAUSED(纯文本软待命)无面板,跳过。
    #
    # 补发以 HitlManager 的 pending 真值**合成**（帧带 hitl_id）,不原样重放存量帧：旧版本落库的
    # waiting_input 帧无 hitl_id,前端去重键退化为 local:*,与 /hitl/pending 的 hit_* 键对不上 →
    # 同一问题双卡。多 pending 全量补发（created_at 升序）,与 /hitl/pending 同口径,前端按
    # hitl_id 幂等 upsert。内存无 pending（未 recover / 无 manager）→ 回退重放最近一条存量帧。
    if entry.status == "PAUSED_HITL":
        sent = False
        for req in _pending_hitl_of(session_id):
            yield f"data: {_waiting_input_json(req)}\n\n"
            sent = True
        if not sent:
            for evt_json in reversed(snapshot):
                try:
                    if json.loads(evt_json).get("type") == "waiting_input":
                        yield f"data: {evt_json}\n\n"
                        break
                except Exception:
                    continue

    while True:
        timed_out = False
        async with entry.cond:
            while len(entry.sse_events) <= idx and not entry.sse_finished:
                try:
                    # 用 asyncio.timeout（3.11+）而非 wait_for 包 cond.wait()：
                    # wait_for 会把 cond.wait() 包成独立 task 并在超时时 cancel 它，
                    # 3.11 下该取消时序与 notify_all 存在竞态，可能让 wait() 返回时
                    # 未重新 acquire 锁 → 下一圈 cond.wait() 报 “cannot wait on
                    # un-acquired lock”。timeout 不另起 task，对当前 task 投递取消，
                    # cond.wait() 在持锁 task 内运行，finally 能稳定重新 acquire 锁。
                    async with asyncio.timeout(_HEARTBEAT_INTERVAL):
                        await entry.cond.wait()
                except (asyncio.TimeoutError, TimeoutError):
                    timed_out = True
                    break
            new_batch = entry.sse_events[idx:]
            batch_start = idx
            idx = len(entry.sse_events)

        if timed_out and not new_batch:
            yield f"data: {json.dumps({'type': 'ping'})}\n\n"
            continue

        for i, evt_json in enumerate(new_batch, start=batch_start):
            try:
                obj = json.loads(evt_json)
                if obj.get("type") == "done":
                    continue
                if stub_prompts and obj.get("type") in _PROMPT_TYPES:
                    evt_json = _prompt_stub_json(obj, i, len(evt_json))
            except Exception:
                pass
            yield f"id: {i}\n"
            yield f"data: {evt_json}\n\n"

        if entry.sse_finished:
            break

    yield f"data: {json.dumps({'type': 'done', 'final_status': entry.status})}\n\n"


# ── Startup utilities ─────────────────────────────────────────────────────────


def _entry_from_record(rec) -> SessionEntry:
    """据一条 SessionRecord 建 SessionEntry（不含 tasks / sse_events，标记待 hydrate）。"""
    raw_tid = (rec.config or {}).get("template_id", "")
    # 存量 host 行是裸 id：载入即规范，与新建会话（create_session 已规范）展示一致。
    # 空值守卫：canonical_template_id("") 会产出 "agent:"，不可直包。
    template_id = canonical_template_id(raw_tid) if raw_tid else ""
    entry = SessionEntry(
        session_id=rec.id,
        template_id=template_id,
        user_prompt=rec.user_prompt,
        tenant_id=rec.tenant_id,
        llm_model=rec.llm_model,
        llm_account=rec.llm_provider,
    )
    entry.status = rec.status
    entry.goal = rec.goal or ""
    entry.root_agent_id = rec.root_agent_id
    entry.token_budget = rec.token_budget
    entry.failure_counter = rec.failure_counter
    entry.workspace = rec.workspace
    if rec.created_at:
        entry.created_at = _utc_isoformat(rec.created_at)
    if rec.updated_at:
        entry.updated_at = _utc_isoformat(rec.updated_at)
    entry._hydrated = False   # children 待 ensure_hydrated 按需装
    return entry


def _scan_history(sse_events: list[str]) -> tuple[int, dict[str, str] | None]:
    """单遍扫描持久化历史，一次算出 (turn_seq, 最后一条终态失败气泡)。

    这两个值原来各扫一遍（正序数 user 消息 + 逆序找失败气泡），意味着同一份历史要
    json.loads 两次。最大的会话有 16086 帧 / 66MB，解析成本是这条路径的大头，故合并。

    turn_seq：数有多少条用户输入（type=message, role=user）。session 创建时的初始
    user_prompt、之后每条 send_message / resolve_hitl（不管走哪个入口）都会各自 append
    恰好一条这样的记录（见 sessions.py send_message、hitl_service.py resolve_hitl），
    跟内存里 SessionEntry.turn_seq 的递增时机完全对应，可以拿来在冷装载时精确复原，
    不用额外加表/加列。查不到（历史为空的边界情况）就退回 1。

    失败气泡：只为「崩溃后恢复收尾判死」（runtime finalize_idle_session）兜底取材——
    那条路的 SESSION_STATUS_CHANGED(FAILED) 发生在重启后的新进程里，内存素材已丢。
    取最后一条终态失败气泡作素材：与活体折叠（TASK_FINISHED 清空）不完全等价——若失败
    后又有任务成功，此处仍会带回旧失败原因。作为兜底可接受：它展示的是一次真实发生过
    的失败，且仅在「判 FAILED 却无新 TASK_FAILED」的窄路径被读到。跳过 will_retry
    （自动重试非终态）与 recoverable（崩溃挂起非失败）气泡。正序扫描时后来者覆盖前者，
    与原来的逆序取首个等价。
    """
    turns = 0
    last_failure: dict[str, str] | None = None
    for raw in sse_events:
        try:
            ev = json.loads(raw)
        except Exception:
            continue
        kind = ev.get("type")
        if kind == "message":
            if ev.get("role") == "user":
                turns += 1
        elif kind == "task_failed" and not ev.get("will_retry") and not ev.get("recoverable"):
            last_failure = {"code": ev.get("error_type") or "TASK_FAILED",
                            "message": ev.get("error") or ""}
    return turns or 1, last_failure


async def _load_entry_children(entry: SessionEntry, state_store) -> None:
    """把 tasks（滤 daemon）与 sse_events 装进 entry。

    turn_seq 不落库（没加表/加列），每次从 DB 冷装载 entry 时都会被 SessionEntry.__init__
    重置成 1——之前只在进程刚启动时全量 load_sessions_from_db 才会触发，容易被忽略；
    但「切到一个之前就有的会话继续聊」一样会经这条路径重新装载 entry（不在内存里的
    session 都要靠这个函数从 DB 补回来），reset 到 1 后再上报，就会跟这个会话自己
    早前（切走之前）已经报过的 turn_seq=1,2,3... 撞车，云端 upsert 是累加式的，
    撞上哪一行就把这次的 token 摞加到那一行旧值上——数值就会明显偏大。装完
    sse_events 之后立刻按持久化历史补回正确的 turn_seq，从根上堵住这个撞车。
    """
    for task_dict in await state_store.load_tasks(entry.session_id):
        if task_dict.pop("is_daemon"):
            continue
        entry.tasks[task_dict["id"]] = task_dict
    entry.sse_events = await state_store.load_sse_events(entry.session_id)
    # 单遍扫出 turn_seq 与 notice 素材（跨重启回填死因），见 _scan_history。
    entry.turn_seq, entry._last_task_failure = _scan_history(entry.sse_events)


async def register_session_from_db(state_store, session_id: str) -> None:
    """从实时 DB 把单个会话装进内存 _sessions（导入后调用）。id 不存在则 no-op。"""
    rec = await state_store.get_session_record(session_id)
    if rec is None:
        return
    _sessions[session_id] = _entry_from_record(rec)   # children 同样按需装


async def load_sessions_from_db(state_store) -> None:
    """把 sessions 投影灌回内存注册表。**只装元数据**，children 由 ensure_hydrated 按需补。

    这里曾对每个会话都跑 _load_entry_children，成本 O(全部会话的历史总字节)：本机
    80 会话 / 27813 帧 / 177MB 要 1.9s，而 Electron 的 waitForBackend 总共只给 30s
    且 /health 在 lifespan 跑完前不响应。列表页要的 to_dict() 一个字段都不来自 children，
    其中绝大多数会话用户当次根本不会打开。
    """
    sessions = await state_store.list_sessions()
    for sess in sessions:
        _sessions[sess.id] = _entry_from_record(sess)
    logger.info("Session registry: restored %d session(s) from DB (children lazy)", len(sessions))


def start_recovery_consumers(runtime: Any) -> int:
    count = 0
    for entry in _sessions.values():
        if entry.status == "RUNNING":
            entry._consumer_token += 1
            asyncio.create_task(session_consumer(entry, runtime, entry._consumer_token))
            count += 1
    if count:
        logger.info("Recovery: started %d SSE consumer(s)", count)
    return count
