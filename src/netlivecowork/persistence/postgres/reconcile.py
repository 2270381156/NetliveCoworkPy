"""启动期 session 投影对账（据事件真相自愈失真的投影行）。

投影表是可能失真的派生视图：ProjectionUpdater 与 EventPersister 各自独立事务、且都吞异常，
一次 SessionFinished 的投影写若失败，事件已终态而投影停在 RUNNING → 会话永久卡死。事件日志
是唯一真相，故每次启动据事件对账、幂等自愈（不止一次性清历史残留）。须在 runtime.recover()
之后调用：那一步已把「崩溃时真在跑」的会话经事件转成 INTERRUPTED/PAUSED，此刻投影里仍为
RUNNING 的只可能是「投影撒谎」的幽灵行 → 安全校正为其最后一条 SessionFinished 的 final_status。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def reconcile_stranded_running_sessions(state_store, event_store) -> int:
    """把「投影 RUNNING 但事件日志非 active」的会话校正为事件真相里的终态，返回校正条数。

    幂等：库一致时无卡死行 → no-op。事件日志判据（list_active_session_ids：最近开启边界晚于
    最近 SessionFinished）与 recover() 同源，故不会误动真 active 的会话。
    """
    event_active = set(await event_store.list_active_session_ids())
    projection_running = await state_store.list_active_session_ids()  # 投影 status==RUNNING

    reconciled = 0
    for sid in projection_running:
        if sid in event_active:
            continue  # 事件真相也认它 active → 归 recover() 处理，不动
        try:
            finished = await event_store.read_session_events_of_types(sid, ("SessionFinished",))
            # stranded ⟹ 必有 SessionFinished（否则会被判 event-active）；缺失时保守落 SUCCEEDED。
            final_status = finished[-1].payload.get("final_status", "SUCCEEDED") if finished else "SUCCEEDED"
            await state_store.update_session_status(sid, final_status)
            reconciled += 1
            logger.info("Reconcile: stranded session %s RUNNING → %s (event truth)", sid, final_status)
        except Exception:
            logger.exception("Reconcile: failed to reconcile stranded session %s", sid)

    return reconciled
