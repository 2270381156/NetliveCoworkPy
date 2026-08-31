"""Runtime metadata for cloud skills that report their own Datalink usage.

Referenced skills only exist in a temporary materialized directory while a
skill provider operation is running.  Therefore the reporting decision must be
captured while that directory still exists; a later scan from SkillReporter is
both unreliable and needlessly expensive.

The registry is keyed by session/task/skill so concurrent users cannot affect
each other.  Entries are bounded and expire automatically as a safety net for
tasks which never reach their normal terminal event.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ctx_weft.protocols.context import ProviderContext

logger = logging.getLogger(__name__)

_SOURCE_SUFFIXES = frozenset(
    {
        ".py",
        ".pyw",
        ".js",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".sh",
        ".bash",
        ".ps1",
    }
)
_MAX_SOURCE_BYTES = 2 * 1024 * 1024
_MAX_SOURCE_FILES = 1000

_DATALINK_SERVICE_RE = re.compile(
    r"\b(?:data-api-service|datalinkprobackend)\b",
    re.IGNORECASE,
)
_DATALINK_SIGN_RE = re.compile(r"\bDatalink-Sign\b", re.IGNORECASE)
_DATALINK_CONFIG_RE = re.compile(r"\bDATALINK_[A-Z0-9_]+\b", re.IGNORECASE)
_SAVE_ENTITY_RE = re.compile(r"\bsaveEntity\b", re.IGNORECASE)

_ENTRY_TTL_SECONDS = 6 * 60 * 60
_MAX_ENTRIES = 4096


@dataclass(frozen=True)
class _ReportingEntry:
    has_own_reporting: bool
    observed_at: float


_entries: dict[tuple[str, str, str], _ReportingEntry] = {}
_lock = threading.RLock()


def normalize_skill_name(skill_name: str) -> str:
    """Return the bare skill name used by the underlying provider."""
    value = (skill_name or "").strip()
    while True:
        for prefix in ("cloud_skill__", "local_skill__"):
            if value.startswith(prefix):
                value = value[len(prefix) :]
                break
        else:
            return value


def _key(session_id: str, task_id: str, skill_name: str) -> tuple[str, str, str]:
    return (
        (session_id or "").strip(),
        (task_id or "").strip(),
        normalize_skill_name(skill_name),
    )


def _prune_locked(now: float) -> None:
    expired_before = now - _ENTRY_TTL_SECONDS
    expired = [key for key, entry in _entries.items() if entry.observed_at < expired_before]
    for key in expired:
        _entries.pop(key, None)

    overflow = len(_entries) - _MAX_ENTRIES
    if overflow > 0:
        oldest = sorted(_entries, key=lambda key: _entries[key].observed_at)[:overflow]
        for key in oldest:
            _entries.pop(key, None)


def detect_own_datalink_reporting(skill_root: Path) -> bool:
    """Inspect the *materialized* skill and detect an embedded Datalink client.

    ``saveEntity`` alone is deliberately insufficient because it is a common
    business method name.  Detection requires either the concrete Datalink
    service marker, or both the save endpoint and Datalink signing/config
    markers.  Only executable source files are considered, avoiding examples
    in SKILL.md/references from suppressing host reporting.
    """
    root = Path(skill_root)
    if not root.is_dir():
        return False

    saw_service = False
    saw_save_entity = False
    saw_datalink_client = False
    checked = 0

    try:
        candidates = root.rglob("*")
        for path in candidates:
            if checked >= _MAX_SOURCE_FILES:
                logger.warning(
                    "Cloud skill reporting inspection stopped after %d source files: %s",
                    _MAX_SOURCE_FILES,
                    root,
                )
                break
            if not path.is_file() or path.suffix.lower() not in _SOURCE_SUFFIXES:
                continue
            checked += 1
            try:
                if path.stat().st_size > _MAX_SOURCE_BYTES:
                    continue
                content = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                logger.debug("Cannot inspect cloud skill source file: %s", path, exc_info=True)
                continue

            saw_service = saw_service or bool(_DATALINK_SERVICE_RE.search(content))
            saw_save_entity = saw_save_entity or bool(_SAVE_ENTITY_RE.search(content))
            saw_datalink_client = saw_datalink_client or bool(
                _DATALINK_SIGN_RE.search(content) or _DATALINK_CONFIG_RE.search(content)
            )
            if saw_service or (saw_save_entity and saw_datalink_client):
                return True
    except OSError:
        logger.debug("Cannot inspect materialized cloud skill: %s", root, exc_info=True)

    return False


def capture_referenced_skill_reporting(
    ctx: "ProviderContext",
    skill_name: str,
    skill_root: Path,
) -> bool:
    """Detect once per task and retain the result for ``SkillReporter``.

    Missing task identity is not guessed: doing so could mix concurrent users.
    The detection result is still returned to the caller, but it is not stored.
    """
    session_id = (ctx.session_id or "").strip()
    task_id = (ctx.task_id or "").strip()
    key = _key(session_id, task_id, skill_name)

    if session_id and task_id and key[2]:
        now = time.monotonic()
        with _lock:
            _prune_locked(now)
            existing = _entries.get(key)
            if existing is not None:
                return existing.has_own_reporting

    detected = detect_own_datalink_reporting(skill_root)
    if not session_id or not task_id or not key[2]:
        logger.debug(
            "Cloud skill reporting metadata not retained because context is incomplete: "
            "session_id=%r task_id=%r skill_name=%r",
            session_id,
            task_id,
            skill_name,
        )
        return detected

    with _lock:
        now = time.monotonic()
        _prune_locked(now)
        _entries[key] = _ReportingEntry(detected, now)
    logger.debug(
        "Captured cloud skill reporting metadata: session_id=%s task_id=%s "
        "skill_name=%s has_own_reporting=%s",
        session_id,
        task_id,
        key[2],
        detected,
    )
    return detected


def consume_skill_own_reporting(session_id: str, task_id: str, skill_name: str) -> bool:
    """Consume the task-scoped decision after the host reporting decision."""
    key = _key(session_id, task_id, skill_name)
    if not all(key):
        return False
    with _lock:
        _prune_locked(time.monotonic())
        entry = _entries.pop(key, None)
    return bool(entry and entry.has_own_reporting)


def discard_task_reporting(session_id: str, task_id: str) -> None:
    """Remove all cached skill decisions for a completed/failed task."""
    session = (session_id or "").strip()
    task = (task_id or "").strip()
    if not session or not task:
        return
    with _lock:
        stale = [key for key in _entries if key[0] == session and key[1] == task]
        for key in stale:
            _entries.pop(key, None)


def discard_session_reporting(session_id: str) -> None:
    """Remove cached decisions when a session is deregistered."""
    session = (session_id or "").strip()
    if not session:
        return
    with _lock:
        stale = [key for key in _entries if key[0] == session]
        for key in stale:
            _entries.pop(key, None)
