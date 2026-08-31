"""把 core 的失败事件映射为客户端观测 emit()。

host 侧 EventBus 订阅者(仿 persistence/event_persister.py),在 bootstrap/lifecycle.py 经
runtime.event_bus.subscribe 注册。零 core 改动:只读 EventType 常量,只消费事件。

粒度取舍(spec §5):MCP/skill 的 capability 失败当前以 CapabilityEvent(kind="error")
吸收进 tool 结果、未成独立事件,故只能随 StepFailed/TaskFailed 粗粒度捕获;要 server/tool
明细须另给 core 回灌 CapabilityFailed seam(本期不做)。
"""
from __future__ import annotations

import logging

from ctx_weft.core.events.types import EventType

from netlivecowork.reporting.record import record

logger = logging.getLogger(__name__)

# core 失败事件类型 → 上报 event_type(EventType 是 StrEnum,成员即字符串值)
_FAILURE_MAP = {
    EventType.STEP_FAILED.value: "step_failed",
    EventType.TASK_FAILED.value: "task_failed",
}

_MAX_MSG = 512  # error_message 截断,避免把长堆栈塞进事件

# error_message 在这些 error_code 下是 observer 写的文本(死因/受阻原因),可能回显
# agent 输出文字 — 丢弃 (spec §5: 事件只携带错误分类/元数据,不携带对话内容)
_CONTENT_UNSAFE_ERROR_CODES = frozenset({"TASK_FAILED_BY_OBSERVER",
                                         "TASK_FAILED_RETRY_EXHAUSTED"})


class TelemetrySubscriber:
    """EventBus 订阅者:失败事件 → emit()。绝不抛(不污染派发)。"""

    async def on_event(self, event) -> None:
        try:
            mapped = _FAILURE_MAP.get(getattr(event, "type", None))
            if mapped is None:
                return
            payload = getattr(event, "payload", None) or {}
            error_code = payload.get("error_code")
            if error_code in _CONTENT_UNSAFE_ERROR_CODES:
                safe_error_message = None
            else:
                safe_error_message = (payload.get("error_message") or "")[:_MAX_MSG]
            session_id = getattr(event, "session_id", None)
            record(
                mapped,
                {
                    "session_id": session_id,
                    "task_id": getattr(event, "task_id", None),
                    "error_code": error_code,
                    "error_message": safe_error_message,
                },
                session_id=session_id,
            )
        except Exception:
            logger.exception("TelemetrySubscriber failed for event %s", getattr(event, "id", "?"))
