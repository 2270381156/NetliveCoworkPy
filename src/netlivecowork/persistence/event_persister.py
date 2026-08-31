"""EventPersister — host-layer EventBus subscriber that appends raw events to DB.

Subscribed from main.py lifespan via runtime.event_bus.subscribe().
Only responsibility: append events to EventStore (skip high-frequency deltas).

State projection updates are handled by ProjectionUpdater.
"""

from __future__ import annotations

import logging

from ctx_weft.core.events.types import TRANSIENT_EVENT_TYPES, Event

logger = logging.getLogger(__name__)


class EventPersister:
    """Subscribes to EventBus; appends events to EventStore."""

    def __init__(self, event_store) -> None:
        self._event_store = event_store

    async def on_event(self, event: Event) -> None:
        # 高频流式 delta（每 token 一个）不入库——避免冲垮 events 表。集合由 core 统一维护。
        if event.type in TRANSIENT_EVENT_TYPES:
            return
        try:
            await self._event_store.append(event)
        except Exception:
            logger.exception(
                "EventPersister: failed to append event %s (%s)", event.id, event.type
            )
