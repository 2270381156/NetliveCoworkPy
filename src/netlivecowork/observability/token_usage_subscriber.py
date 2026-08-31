"""
现在的方案：不再单独订阅 EventBus，改成由 D:\\IpMasterCoworkPy\\src\\
netlivecowork\\api\\models\\session.py 的 SessionEntry.translate_event() 在处理
LLM_RESPONSE_FINISHED 事件、更新 self.input_tokens/output_tokens 的同一行代码
路径里，同步调用本模块的 report_token_usage()。这条路径是单 session 严格顺序消费
的（session_consumer 里 `async for ev in event_bus.stream(...)` 逐个 await），
且下一条用户消息能被接受（进而让 turn_seq +1）严格发生在这次 LLM_RESPONSE_FINISHED
处理完、暂停事件（HITL_REQUIRED）也处理完之后——不存在"读到下一轮 turn_seq"的
时间窗口。

上报 session_id 拼成 `desktop:{ctx-weft session_id}:{turn_seq}`。
"""
from __future__ import annotations

import logging

from netlivecowork.reporting.record import record

logger = logging.getLogger(__name__)

#: 记录类型。出口与文件由路由表决定（reporting/defaults.py），不再写在这里——
#: 这一层只负责说"发生了一次用量"，不负责说"发给谁"。
_KIND = "token_usage"


def report_token_usage(
    *,
    session_id: str,
    turn_seq: int | str,
    prompt_tokens: int,
    completion_tokens: int,
    llm_account: str | None,
    llm_model: str | None,
) -> None:
    """由 SessionEntry.translate_event() 同步调用（不是 EventBus 订阅回调）。绝不抛。

    prompt_tokens 自 2026-07-16 起为「实际未缓存输入」口径（usage.input_tokens），
    不再是含缓存命中的总输入——见 spec llm-usage-cache-split §8.2。
    """
    try:
        if prompt_tokens <= 0 and completion_tokens <= 0:
            return
        record(
            _KIND,
            {
                # 载荷里这个 session_id 是**拼出来的上报标识**（带 desktop: 前缀与轮次），
                # 不是原始会话 id。归属查的是原始那个，见下面的 session_id= 参数。
                "session_id": f"desktop:{session_id}:{turn_seq}",
                "input_tokens": prompt_tokens,
                "output_tokens": completion_tokens,
                "llm_account": llm_account or "",
                "llm_model": llm_model or "",
            },
            session_id=session_id,
        )
        _notify()
    except Exception:
        logger.exception("report_token_usage failed for session %s turn %s", session_id, turn_seq)


def _notify() -> None:
    """唤醒正在监听 /internal/token-usage-stream 的 Electron，让它立刻来 drain，
    不必等定时器。延迟导入避免模块加载顺序问题；这里失败也绝不能影响主流程。
    """
    try:
        from netlivecowork.api.spool import notify_token_usage

        notify_token_usage()
    except Exception:
        pass
