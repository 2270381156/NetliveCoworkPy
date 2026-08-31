"""低完整性版 run-with-liveness：用 Low 启动器起进程，其余复用内核的存活/杀树/结果原语。

为什么单独写一份而不改内核：约定"不动内核"，provider 在 app 侧子类化。所以这里只重写
**起进程**那一步（Low 令牌，见 windows.spawn_low），存活判定/超时/杀树/结果结构全部 import
内核 `_script_runner` 的纯函数复用——import 不算改内核，逻辑与默认路径逐行一致，只换了启动器。

仅 Windows + strict-auto 会话走这里；其余一律回落内核默认执行（见 low_shell）。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

# 复用内核纯原语（import 不改内核）：存活采样、进度、结果、杀树。
from ctx_weft.providers._encoding import decode_console
from ctx_weft.providers._script_runner import (
    LivenessProgress,
    LivenessSample,
    RunResult,
    collect_tree_metrics,
    made_progress,
    terminate_tree,
)

from netlivecowork.low_integrity import windows

logger = logging.getLogger(__name__)


async def run_low_with_liveness(
    command: str,
    *,
    cwd: str | None,
    env: dict | None,
    idle_timeout_sec: float,
    hard_cap_sec: float,
    output_limit_bytes: int,
    poll_interval_sec: float = 1.0,
    on_output: Callable[[str, str], None] | None = None,
    on_progress: Callable[[LivenessProgress], None] | None = None,
) -> RunResult:
    """与内核 run_with_liveness 同义，但子进程用 Low 令牌启动（写受限、读不限）。

    存活 = stdout 字节 / 树 CPU / 树 IO 三者取或；超时分 idle / hard_cap；结束一律杀树并诚实
    汇报存活者。Job（进程数上限 + KILL_ON_JOB_CLOSE）在 finally 关闭，兜底清树。
    """
    job = windows.make_job()
    proc = await windows.spawn_low(command, cwd=cwd, env=env, job=job)

    stdout_buf: list[str] = []
    stderr_buf: list[str] = []
    counters = {"output_bytes": 0}
    start = time.monotonic()

    async def _reader(stream, name: str, buf: list[str]):
        size = 0
        while True:
            line = await stream.readline()
            if not line:
                break
            counters["output_bytes"] += len(line)
            if size < output_limit_bytes:
                text = decode_console(line)
                buf.append(text)
                size += len(line)
                if on_output is not None:
                    try:
                        on_output(name, text)
                    except Exception:
                        logger.debug("on_output callback raised", exc_info=True)

    readers = [
        asyncio.create_task(_reader(proc.stdout, "stdout", stdout_buf)),
        asyncio.create_task(_reader(proc.stderr, "stderr", stderr_buf)),
    ]

    timeout_kind: str | None = None
    last_alive = time.monotonic()
    prev = LivenessSample(output_bytes=0, cpu_seconds=0.0, io_bytes=0)

    async def _poller():
        nonlocal timeout_kind, last_alive, prev
        while proc.returncode is None:
            await asyncio.sleep(poll_interval_sec)
            now = time.monotonic()
            elapsed = now - start
            sample = collect_tree_metrics(proc.pid, output_bytes=counters["output_bytes"])
            if sample is not None:
                if made_progress(prev, sample):
                    last_alive = now
                prev = sample
            idle_remaining = max(0.0, idle_timeout_sec - (now - last_alive))
            hard_remaining = max(0.0, hard_cap_sec - elapsed)
            if on_progress is not None:
                try:
                    on_progress(LivenessProgress(
                        elapsed_sec=elapsed,
                        output_bytes=counters["output_bytes"],
                        idle_remaining_sec=idle_remaining,
                        hard_cap_remaining_sec=hard_remaining,
                        cpu_seconds=prev.cpu_seconds,
                    ))
                except Exception:
                    logger.debug("on_progress callback raised", exc_info=True)
            if elapsed >= hard_cap_sec:
                timeout_kind = "hard_cap"
                return
            if (now - last_alive) >= idle_timeout_sec:
                timeout_kind = "idle"
                return

    poller = asyncio.create_task(_poller())
    from ctx_weft.providers._script_runner import TerminationResult
    termination = TerminationResult(clean=True, survivors=[])
    try:
        await asyncio.wait(
            {asyncio.create_task(proc.wait()), poller},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if timeout_kind is not None:
            termination = await terminate_tree(proc, None)
        for r in readers:
            try:
                await asyncio.wait_for(r, timeout=2)
            except asyncio.TimeoutError:
                r.cancel()
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except asyncio.TimeoutError:
            pass
    finally:
        poller.cancel()
        if proc.returncode is None:
            termination = await terminate_tree(proc, None)
        # 关 Job：KILL_ON_JOB_CLOSE 兜底清掉任何漏网子进程。
        if job is not None:
            try:
                windows.close_job(job)
            except Exception:
                logger.debug("close_job raised", exc_info=True)

    return RunResult(
        stdout="".join(stdout_buf),
        stderr="".join(stderr_buf),
        exit_code=proc.returncode,
        timed_out=timeout_kind is not None,
        timeout_kind=timeout_kind,
        terminated_clean=termination.clean,
        survivors=termination.survivors,
    )
