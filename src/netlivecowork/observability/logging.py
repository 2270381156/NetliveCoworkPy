"""Structured logging setup for netlivecowork.

Phase 10 §10.7.

This configures the **root** logger so that records from every namespace
propagate into a single handler — most importantly ``ctx_weft.*`` (the
engine) alongside ``netlivecowork.*`` (the service shell). Both libraries use the
stdlib ``logging.getLogger(__name__)`` pattern, so capturing them is a matter of
owning the root handler and leaving propagation intact.

Usage:
    from netlivecowork.observability.logging import configure_logging
    configure_logging()                       # env-driven defaults
    configure_logging(level="DEBUG", fmt="json")
    configure_logging(level="INFO", core_level="DEBUG")  # verbose engine only

Environment overrides (used when the matching argument is left as ``None``):
    NLC_LOG_LEVEL    root level                       (default INFO)
    NLC_LOG_FORMAT   "text" | "json"                  (default text)
    NLC_LOG_DIR      directory to also write logs to   (default none)
    NLC_LOG_FILENAME log file name within NLC_LOG_DIR (default netlivecowork.log)
    NLC_LOG_BACKUP_DAYS  days of rotated logs to keep  (default 7)
    NLC_CORE_LOG_LEVEL  level for the ctx_weft.* tree (default = root)

When ``NLC_LOG_DIR`` is set, the directory is created if missing and logs are
written to ``<NLC_LOG_DIR>/<NLC_LOG_FILENAME>``. The file rotates at midnight,
keeping ``NLC_LOG_BACKUP_DAYS`` dated backups (``netlivecowork.log.2026-06-20``,
...). An unwritable directory disables file logging with a warning instead of
crashing.
"""

from __future__ import annotations

import json
import logging
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Literal

from netlivecowork.config import get_settings

# Third-party loggers we never want at INFO — they drown out application logs.
_NOISY_LOGGERS = {
    "httpx": logging.WARNING,
    "httpcore": logging.WARNING,
    "sqlalchemy.engine": logging.WARNING,
    "asyncio": logging.WARNING,
    "uvicorn.access": logging.WARNING,
}

# uvicorn installs its own handlers with propagate=False; we re-route them
# through the root handler so everything lands in one place / one format.
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

# Standard LogRecord attributes — anything else is treated as structured `extra`.
_RESERVED_RECORD_ATTRS = frozenset(
    logging.makeLogRecord({}).__dict__
) | {"message", "asctime", "taskName"}


def _resolve_level(level: str | int | None, env_key: str, default: int) -> int:
    if level is None:
        _settings_map = {
            "NLC_LOG_LEVEL": get_settings().log_level,
            "NLC_CORE_LOG_LEVEL": get_settings().core_log_level,
        }
        level = _settings_map.get(env_key)
    if level is None:
        return default
    if isinstance(level, int):
        return level
    return getattr(logging, str(level).upper(), default)


class _JsonFormatter(logging.Formatter):
    """Render each record as a single-line JSON object (pure stdlib).

    Includes structured fields passed via ``logger.info("msg", extra={...})``
    so callers can attach ``session_id``/``task_id``/etc. without string
    formatting.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Promote any extra={...} fields to top level.
        for key, value in record.__dict__.items():
            if key not in _RESERVED_RECORD_ATTRS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack_info"] = self.stack_info_to_string(record.stack_info)  # type: ignore[attr-defined]
        return json.dumps(payload, default=str, ensure_ascii=False)


def _build_formatter(fmt: str) -> logging.Formatter:
    if fmt == "json":
        return _JsonFormatter()
    return logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )


def configure_logging(
    level: str | int | None = None,
    fmt: Literal["json", "text"] | None = None,
    *,
    log_dir: str | None = None,
    log_filename: str | None = None,
    log_backup_days: int | None = None,
    core_level: str | int | None = None,
) -> None:
    """Configure root logging for the whole process (host + core).

    Idempotent: replaces any handlers a previous call (or a library such as
    uvicorn) installed on the root logger.

    Args:
        level: root log level. Falls back to ``NLC_LOG_LEVEL`` then ``INFO``.
        fmt: ``"text"`` or ``"json"``. Falls back to ``NLC_LOG_FORMAT`` then
            ``"text"``.
        log_dir: optional directory to additionally write logs to. Falls back
            to ``NLC_LOG_DIR``. Created if missing.
        log_filename: log file name within ``log_dir``. Falls back to
            ``NLC_LOG_FILENAME`` then ``netlivecowork.log``. The handler
            rotates at midnight.
        log_backup_days: number of dated backups the rotating file handler
            keeps. Falls back to ``NLC_LOG_BACKUP_DAYS`` then ``7``.
        core_level: level for the ``ctx_weft`` logger tree only. Falls back
            to ``NLC_CORE_LOG_LEVEL`` then the root ``level``. Use this to
            turn the engine verbose (DEBUG) without flooding from third parties.
    """
    root_level = _resolve_level(level, "NLC_LOG_LEVEL", logging.INFO)

    if fmt is None:
        fmt = get_settings().log_format or "text"  # type: ignore[assignment]
    fmt = "json" if str(fmt).lower() == "json" else "text"

    formatter = _build_formatter(fmt)

    root = logging.getLogger()
    root.setLevel(root_level)

    # Drop existing handlers so re-configuration / uvicorn doesn't duplicate output.
    for handler in list(root.handlers):
        root.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass

    stream_handler = logging.StreamHandler(stream=sys.stdout)
    stream_handler.setFormatter(formatter)
    root.addHandler(stream_handler)

    log_dir = log_dir or get_settings().log_dir
    log_file: str | None = None
    if log_dir:
        if log_filename is None:
            log_filename = get_settings().log_filename
        if log_backup_days is None:
            log_backup_days = get_settings().log_backup_days
        try:
            # Ensure the log directory exists, then write the named file into it;
            # rotate at midnight keeping `log_backup_days` dated backups.
            dir_path = Path(log_dir)
            dir_path.mkdir(parents=True, exist_ok=True)
            log_file = str(dir_path / log_filename)
            file_handler = TimedRotatingFileHandler(
                log_file,
                when="midnight",
                backupCount=log_backup_days,
                encoding="utf-8",
            )
            file_handler.setFormatter(_build_formatter(fmt))
            root.addHandler(file_handler)
        except OSError as exc:
            # Unwritable dir / bad name: keep stdout logging, don't take down
            # the process just because the file sink is unavailable.
            log_file = None
            root.warning(
                "file logging disabled: cannot use dir %s (%s)", log_dir, exc
            )

    # Engine (ctx_weft.*) verbosity, independent of root.
    core_resolved = _resolve_level(core_level, "NLC_CORE_LOG_LEVEL", root_level)
    logging.getLogger("ctx_weft").setLevel(core_resolved)
    logging.getLogger("netlivecowork").setLevel(root_level)

    # Quiet chatty third-party libraries.
    for name, lvl in _NOISY_LOGGERS.items():
        logging.getLogger(name).setLevel(lvl)

    # Funnel uvicorn through our root handler instead of its private ones.
    for name in _UVICORN_LOGGERS:
        uv_logger = logging.getLogger(name)
        uv_logger.handlers.clear()
        uv_logger.propagate = True

    root.debug(
        "logging configured (level=%s, fmt=%s, core_level=%s, file=%s)",
        logging.getLevelName(root_level),
        fmt,
        logging.getLevelName(core_resolved),
        log_file or "-",
    )
