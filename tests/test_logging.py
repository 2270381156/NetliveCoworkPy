"""Tests for netlivecowork.observability.logging.

Focus on the file-logging robustness contract:
  - NLC_LOG_DIR names a directory; it is created if missing and the named
    file (NLC_LOG_FILENAME, default netlivecowork.log) is written inside it.
  - The file handler rotates daily and honours NLC_LOG_BACKUP_DAYS.
  - An unwritable dir degrades to stdout with a warning, never crashes.
  - No NLC_LOG_DIR => no file handler.
"""
import logging
from logging.handlers import TimedRotatingFileHandler

import pytest

from netlivecowork.observability import logging as log_mod


@pytest.fixture(autouse=True)
def _restore_root_logging():
    """Snapshot/restore the root logger so tests don't leak handlers."""
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    try:
        yield
    finally:
        for h in root.handlers[:]:
            root.removeHandler(h)
            try:
                h.close()
            except Exception:
                pass
        for h in saved_handlers:
            root.addHandler(h)
        root.setLevel(saved_level)


def _file_handlers():
    return [
        h for h in logging.getLogger().handlers
        if isinstance(h, logging.FileHandler)
    ]


def test_creates_dir_and_writes_named_file(tmp_path):
    log_dir = tmp_path / "sub" / "nested"  # does not exist yet
    log_mod.configure_logging(log_dir=str(log_dir), log_backup_days=3)

    logging.getLogger("netlivecowork.test").info("host-line")
    logging.getLogger("ctx_weft.test").info("core-line")

    log_path = log_dir / "netlivecowork.log"  # default filename
    assert log_path.exists()
    contents = log_path.read_text(encoding="utf-8")
    assert "host-line" in contents
    assert "core-line" in contents


def test_custom_filename(tmp_path):
    log_mod.configure_logging(log_dir=str(tmp_path), log_filename="backend.log")
    logging.getLogger("netlivecowork.test").info("x")
    assert (tmp_path / "backend.log").exists()


def test_file_handler_is_daily_rotating_with_backup_count(tmp_path):
    log_mod.configure_logging(log_dir=str(tmp_path), log_backup_days=5)

    handlers = [
        h for h in logging.getLogger().handlers
        if isinstance(h, TimedRotatingFileHandler)
    ]
    assert len(handlers) == 1
    assert handlers[0].backupCount == 5
    assert handlers[0].when == "MIDNIGHT"


def test_unwritable_dir_degrades_without_crashing(tmp_path, capsys):
    # A file where a directory is expected: mkdir on it fails.
    # (caplog can't see this: configure_logging clears root handlers, dropping
    # caplog's capture handler — so assert on the stdout StreamHandler output.)
    not_a_dir = tmp_path / "iam_a_file"
    not_a_dir.write_text("x", encoding="utf-8")

    log_mod.configure_logging(log_dir=str(not_a_dir))  # must not raise

    assert not _file_handlers()  # file sink not attached
    assert any(
        isinstance(h, logging.StreamHandler) for h in logging.getLogger().handlers
    )
    assert "file logging disabled" in capsys.readouterr().out


def test_no_log_dir_means_no_file_handler(monkeypatch):
    monkeypatch.delenv("NLC_LOG_DIR", raising=False)
    import netlivecowork.config as cfgmod
    monkeypatch.setattr(cfgmod, "_settings", None)  # drop cached singleton

    log_mod.configure_logging()

    assert not _file_handlers()


def test_env_driven_dir_filename_and_backup(tmp_path, monkeypatch):
    monkeypatch.setenv("NLC_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("NLC_LOG_FILENAME", "svc.log")
    monkeypatch.setenv("NLC_LOG_BACKUP_DAYS", "11")
    import netlivecowork.config as cfgmod
    monkeypatch.setattr(cfgmod, "_settings", None)  # force re-read of env

    log_mod.configure_logging()  # no explicit args -> env-driven

    handlers = [
        h for h in logging.getLogger().handlers
        if isinstance(h, TimedRotatingFileHandler)
    ]
    assert len(handlers) == 1
    assert handlers[0].backupCount == 11
    assert (tmp_path / "logs" / "svc.log").exists()
