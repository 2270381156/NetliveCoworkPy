"""API in-memory runtime models."""

from netlivecowork.api.models.session import (
    SessionEntry,
    _sessions,
    _now,
    set_state_store,
    set_event_store,
    session_consumer,
    sse_generator,
    load_sessions_from_db,
    register_session_from_db,
    start_recovery_consumers,
)

# NOTE: _state_store and _event_store are NOT re-exported here.
# They are module-level globals reassigned via set_state_store/set_event_store;
# importing them directly would snapshot None at import time.
# Access them as: from netlivecowork.api.models import session as sm; sm._state_store

__all__ = [
    "SessionEntry",
    "_sessions",
    "_now",
    "set_state_store",
    "set_event_store",
    "session_consumer",
    "sse_generator",
    "load_sessions_from_db",
    "register_session_from_db",
    "start_recovery_consumers",
]
