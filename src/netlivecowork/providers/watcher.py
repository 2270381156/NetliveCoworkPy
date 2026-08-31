"""DirectoryWatcher — 后台轮询目录 mtime，变化时触发回调。

设计：
  - daemon 线程，不阻塞 event loop
  - 每个被监控目录关联一个 async 回调（coroutine function）
  - 变化检测到后，通过 asyncio.run_coroutine_threadsafe 投递到主 event loop
  - 支持多目录监控，每个目录独立跟踪 mtime
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

AsyncCallback = Callable[[], Coroutine[Any, Any, None]]


class DirectoryWatcher:
    """轮询一组目录的 mtime，有变化时触发注册的 async 回调。"""

    def __init__(self, poll_interval: float = 5.0) -> None:
        self._interval = poll_interval
        self._entries: list[tuple[Path, AsyncCallback]] = []   # (dir, async_callback)
        self._last_mtimes: dict[str, int] = {}
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def watch(self, directory: Path, callback: AsyncCallback) -> None:
        """注册一个目录及其变化时的 async 回调。可多次调用添加多个监控项。"""
        self._entries.append((directory, callback))

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """启动后台监控线程。loop 为主 event loop，用于投递回调。"""
        if self._thread and self._thread.is_alive():
            return
        self._loop = loop
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="directory-watcher",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            "DirectoryWatcher: started (interval=%.1fs, watching %d dir(s))",
            self._interval, len(self._entries),
        )

    def stop(self) -> None:
        """停止监控线程（lifespan 退出时调用）。"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=self._interval + 1)
        logger.info("DirectoryWatcher: stopped")

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _mtime(self, path: Path) -> int:
        try:
            return path.stat().st_mtime_ns
        except OSError:
            return 0

    def _run(self) -> None:
        while not self._stop_event.is_set():
            for directory, callback in self._entries:
                key = str(directory)
                current = self._mtime(directory)
                if current != self._last_mtimes.get(key):
                    prev = self._last_mtimes.get(key)
                    self._last_mtimes[key] = current
                    if prev is not None and current != 0:   # 跳过首次记录
                        logger.debug("DirectoryWatcher: change detected in '%s'", directory)
                        self._fire(callback)
                    elif prev is None:
                        self._last_mtimes[key] = current   # 初始化基线，不触发
            self._stop_event.wait(self._interval)

    def _fire(self, callback: AsyncCallback) -> None:
        if self._loop is None or not self._loop.is_running():
            return
        future = asyncio.run_coroutine_threadsafe(callback(), self._loop)
        future.add_done_callback(
            lambda f: logger.exception("DirectoryWatcher: callback error")
            if f.exception() else None
        )
