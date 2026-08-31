"""SnapshotWriter — 在会话存活期间定期写入状态快照。

订阅 EventBus，在 ``RunFinished`` 这个干净的恢复边界、且距上次快照累计事件数达到阈值时，
把当前事件流 reduce 的结果序列化存储；``SessionFinished`` 时再写最后一张。

为什么要"定期"而不是只在结束时写：崩溃恢复针对的是**没有终态**的 session，若快照只在
``SessionFinished`` 写，恢复时永远没有快照可用，``rebuild_view`` 只能 O(全部事件) 全量回放。
定期写后，恢复退化为「最新快照 + 增量 delta」，回放量被限制在约一个阈值窗口内。

写入路径用 ``rebuild_view``（快照 + 增量），因此每次写快照只读取自上次快照以来的 delta，
是 O(delta) 而非 O(全部事件)——重要，因为 EventBus 的 handler 是在 ``emit`` 里内联执行的，
任何 O(全量) 的读取都会阻塞 loop 主路径。
"""

from __future__ import annotations

import logging

from ctx_weft.core.events.types import TRANSIENT_EVENT_TYPES, Event

logger = logging.getLogger(__name__)

# RunFinished 边界上，距上次快照累计多少事件后写一张快照。
DEFAULT_SNAPSHOT_EVERY_N_EVENTS = 50


class SnapshotWriter:
    """EventBus subscriber：会话存活期间定期 + 结束时写 RunSnapshot。"""

    def __init__(
        self,
        event_store,
        *,
        every_n_events: int = DEFAULT_SNAPSHOT_EVERY_N_EVENTS,
    ) -> None:
        self._event_store = event_store
        self._every_n = max(1, every_n_events)
        # session_id → 距上次快照累计的事件数
        self._since_snapshot: dict[str, int] = {}

    async def on_event(self, event: Event) -> None:
        session_id = event.session_id
        if not session_id:
            return
        # 瞬态 delta 不计入阈值，使"每 N 事件"按有意义的持久化事件计数。
        if event.type in TRANSIENT_EVENT_TYPES:
            return

        try:
            if event.type == "SessionFinished":
                await self._write(session_id, event, reason="session_finished")
                self._since_snapshot.pop(session_id, None)
                return

            n = self._since_snapshot.get(session_id, 0) + 1
            # 只在 RunFinished（一次 loop run 收尾，状态稳定的恢复边界）落快照。
            if event.type == "RunFinished" and n >= self._every_n:
                await self._write(session_id, event, reason="periodic")
                self._since_snapshot[session_id] = 0
            else:
                self._since_snapshot[session_id] = n
        except Exception:
            logger.exception("SnapshotWriter: failed for session %s", session_id)

    async def _write(self, session_id: str, event: Event, reason: str) -> None:
        from ctx_weft.core.control.reducers import rebuild_view, serialize_view
        from ctx_weft.core.state.event_store import RunSnapshot
        from ctx_weft.core.utils import generate_id, now_utc

        # rebuild_view = 上一张快照 + delta（无快照时全量）。本事件此刻已被先注册的
        # EventPersister 落库，故 view 已包含它，last_event_id=event.id 与 view 一致。
        view = await rebuild_view(self._event_store, session_id)
        if not view.session_id:
            return  # 该 session 尚无任何已持久化事件，跳过

        snapshot = RunSnapshot(
            id=generate_id("snp"),
            run_id=event.run_id or "",
            session_id=session_id,
            last_event_id=event.id,
            last_event_sequence=event.sequence,
            state_blob=serialize_view(view),
            snapshot_reason=reason,
            snapshot_at=now_utc(),
        )
        await self._event_store.save_snapshot(snapshot)
        logger.info(
            "SnapshotWriter: snapshot %s written for session %s (reason=%s, seq=%d)",
            snapshot.id, session_id, reason, event.sequence,
        )
