# Unified Script Runner + Console Encoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port six fork customizations onto the LoomeX layered architecture: (a) console-encoding decode (UTF-8→GBK→replace, all OSes) + `PYTHONIOENCODING=utf-8` for both `bash_exec` and skill scripts; (b) a single shared `script_runner` (liveness timeout + reliable tree-kill + honest survivors) backing both paths; (c) an `exec_skill_script` runtime note at the end of skill instructions; (d) OpenAI chat-endpoint inference; (e) corporate-CA SSL trust — the last two done by **host subclasses overriding core adapter seams**, never by modifying core.

**Architecture:** Phases 1–4 add two provider-level modules in `loomex-core` (`_encoding.py`, `_script_runner.py`) shared by the filesystem + skill providers; `bash_exec` streams by bridging runner callbacks through an `asyncio.Queue`, skill `exec_script` consumes the buffered `RunResult`. Phase 5 appends a note in `prepare.py`. Phases 6–7 follow the providers-layer convention: add minimal behavior-preserving **seams** to the core LLM adapters (`_chat_url`, `_make_client`), then a host `LLMProvider` subclass builds host adapter subclasses (`HostOpenAIAdapter`/`HostAnthropicAdapter`) that override those seams for endpoint inference + `verify=make_ssl_verify(settings)`. New settings inject from the host config exactly like existing ones.

**Tech Stack:** Python 3.11, asyncio, `psutil` (new), ctypes (Windows Job Object), `pyopenssl` + `cryptography` (new, SSL), httpx, pytest + pytest-asyncio.

**Shipping order:** Phase 1 (encoding) ships first, independently. Phases 2–3 (runner) reuse `decode_console`. Phase 5 (skill note) is independent and can ship anytime. Phases 6–7 (LLM seams + host subclass) are independent of 1–5. Phase 4 (skill progress SSE) and Tasks 18–19 (MCP SSL, AIA retry) are optional and flagged.

**Prerequisite:** Phase 7 ports the fork's ~811-line `app/common/ssl_verify.py` — requires access to the fork repo source; confirm before starting that phase.

---

## File Structure

**New files (loomex-core):**
- `loomex-core/src/loomex_core/providers/_encoding.py` — `decode_console(bytes) -> str`. UTF-8→GBK→replace cascade.
- `loomex-core/src/loomex_core/providers/_script_runner.py` — `run_with_liveness(...)`, `LivenessSample`, `LivenessProgress`, `RunResult`, `collect_tree_metrics`, `terminate_tree`, containment spawn.
- `loomex-core/tests/unit/test_encoding.py`, `test_script_runner.py`, `test_openai_adapter_seam.py`, `test_llm_client_seam.py`, `test_skill_instructions_note.py`

**New files (host):**
- `src/loomex_host/providers/llm/adapters.py` — `HostOpenAIAdapter` / `HostAnthropicAdapter` (override `_chat_url` + `_make_client`) and `_resolve_chat_url`.
- `src/loomex_host/ssl_verify.py` — ported `make_ssl_verify(settings)` (+ optional `with_ssl_retry`).
- `tests/test_host_llm_adapters.py`, `test_host_llm_provider_build.py`, `test_host_llm_ssl_injection.py`, `test_ssl_verify.py`, `test_host_config_runner_settings.py`

**Modified files (loomex-core):**
- `providers/capability_skill_local/provider.py` — `exec_script` → `decode_console` then `run_with_liveness`; ctor gains `idle_timeout_sec` / `hard_cap_sec`.
- `providers/capability_filesystem/provider.py` — `bash_exec` → `decode_console` + `PYTHONIOENCODING` + `repr` log + path guidance, then `run_with_liveness` via queue bridge; `FilesystemConfig` gains idle/hard-cap fields.
- `core/loop/steps/prepare.py` — `wrap_skill_instructions` note (case 5).
- `providers/llm/openai.py` — `_chat_url` + `_make_client` seams. `providers/llm/anthropic.py` — `_make_client` seam.
- `pyproject.toml` — add `psutil>=5.9.0` to `builtin` + `skills` extras.

**Modified files (host):**
- `providers/llm/llm_provider.py` — shim → `LLMProvider(_CoreLLMProvider)` subclass overriding `_build_adapter`, accepting `ssl_verify`.
- `config.py` — runner settings (`fs_bash_idle_timeout_sec`, `fs_bash_hard_cap_sec`, `skill_idle_timeout_sec`, `skill_hard_cap_sec`) + SSL settings (`http_ssl_verify`, `http_ca_bundle`, `http_check_hostname`, `use_system_truststore`).
- `cli.py` / `api/startup.py` — pass runner settings into `FilesystemConfig` + skill ctor; inject `ssl_verify=make_ssl_verify(get_settings())` into `LLMProvider`.
- root `pyproject.toml` — add `pyopenssl>=24.0`, `cryptography>=42.0`.

**Test layout note:** core tests live in `loomex-core/tests/unit/` (see existing `loomex-core/tests/unit/`). Run from `loomex-core/` with `pytest` (asyncio_mode=auto, so `async def test_*` needs no decorator).

---

## PHASE 1 — Console encoding (independently shippable)

### Task 1: `decode_console` helper

**Files:**
- Create: `loomex-core/src/loomex_core/providers/_encoding.py`
- Test: `loomex-core/tests/unit/test_encoding.py`

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_encoding.py
from loomex_core.providers._encoding import decode_console


def test_decodes_plain_utf8():
    assert decode_console("héllo 世界".encode("utf-8")) == "héllo 世界"


def test_decodes_gbk_when_not_valid_utf8():
    # GBK-encoded Chinese is not valid UTF-8; must fall back to GBK, not mangle.
    data = "命令未找到".encode("gbk")
    assert decode_console(data) == "命令未找到"


def test_ascii_passthrough():
    assert decode_console(b"is not recognized") == "is not recognized"


def test_invalid_bytes_never_raise():
    # Bytes that are neither valid UTF-8 nor valid GBK must not raise.
    data = b"\xff\xfe\x00ok"
    out = decode_console(data)
    assert isinstance(out, str)
    assert "ok" in out


def test_empty():
    assert decode_console(b"") == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_encoding.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'loomex_core.providers._encoding'`

- [ ] **Step 3: Write minimal implementation**

```python
# loomex-core/src/loomex_core/providers/_encoding.py
"""Decode raw subprocess output bytes into text.

Subprocess stdout/stderr on Windows consoles is frequently GBK (the default
OEM codepage for zh-CN), while modern toolchains emit UTF-8. We try UTF-8
first (strict), fall back to GBK (strict), and finally UTF-8 with replacement
so the call can never raise. Applied on every OS: on POSIX the UTF-8 strict
path wins for well-formed output, and the GBK fallback only triggers for bytes
that are already not valid UTF-8.
"""

from __future__ import annotations


def decode_console(data: bytes) -> str:
    """Decode subprocess bytes via UTF-8 → GBK → UTF-8(replace)."""
    if not data:
        return ""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("gbk")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_encoding.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/_encoding.py loomex-core/tests/unit/test_encoding.py
git commit -m "feat(providers): add decode_console UTF-8→GBK→replace helper"
```

---

### Task 2: Wire `decode_console` + `PYTHONIOENCODING` into skill `exec_script`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_skill_local/provider.py:201-219`
- Test: `loomex-core/tests/unit/test_skill_exec_encoding.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_skill_exec_encoding.py
import sys
import textwrap
from pathlib import Path

import pytest

from loomex_core.providers.capability_skill_local.provider import LocalSkillCapabilityProvider
from loomex_core.protocols.context import ProviderContext


def _make_skill(tmp_path: Path, script_body: str) -> Path:
    skill = tmp_path / "enc-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: enc-skill\ndescription: t\n---\nbody\n", encoding="utf-8")
    (skill / "scripts").mkdir()
    (skill / "scripts" / "run.py").write_text(script_body, encoding="utf-8")
    return tmp_path


async def test_exec_script_sets_pythonioencoding(tmp_path, monkeypatch):
    skills_dir = _make_skill(
        tmp_path,
        "import os\nprint(os.environ.get('PYTHONIOENCODING', 'UNSET'))\n",
    )
    captured = {}
    import asyncio
    real = asyncio.create_subprocess_shell

    async def spy(cmd, **kw):
        captured["env"] = kw.get("env")
        return await real(cmd, **kw)

    monkeypatch.setattr(asyncio, "create_subprocess_shell", spy)

    prov = LocalSkillCapabilityProvider(skills_dir)
    ctx = ProviderContext(session_id="s1")
    out = await prov.exec_script("enc-skill", "scripts/run.py", "", ctx)

    assert captured["env"]["PYTHONIOENCODING"] == "utf-8"
    assert out.strip() == "utf-8"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_exec_encoding.py -v`
Expected: FAIL — `KeyError: 'PYTHONIOENCODING'` (env lacks the key).

- [ ] **Step 3: Write minimal implementation**

In `capability_skill_local/provider.py`, add the import near the top (after the existing `import os`):

```python
from loomex_core.providers._encoding import decode_console
```

Change the env dict (currently line 201) from:

```python
        env = {**os.environ, "SKILL_DIR": str(skill_root)}
```

to:

```python
        env = {**os.environ, "SKILL_DIR": str(skill_root), "PYTHONIOENCODING": "utf-8"}
```

Change the decode lines (currently 218-219) from:

```python
        stdout = stdout_b.decode("utf-8", errors="replace")[:self._output_limit_chars]
        stderr = stderr_b.decode("utf-8", errors="replace")[:self._output_limit_chars]
```

to:

```python
        stdout = decode_console(stdout_b)[:self._output_limit_chars]
        stderr = decode_console(stderr_b)[:self._output_limit_chars]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_exec_encoding.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/capability_skill_local/provider.py loomex-core/tests/unit/test_skill_exec_encoding.py
git commit -m "feat(skills): decode_console + PYTHONIOENCODING in exec_script"
```

---

### Task 3: Wire encoding + path guidance into `bash_exec`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_filesystem/provider.py` — description builder (`_bash_exec_description`, lines 60-88) and `bash_exec` body (155-189)
- Test: `loomex-core/tests/unit/test_bash_exec_encoding.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_bash_exec_encoding.py
import asyncio

import pytest

from loomex_core.providers.capability_filesystem import provider as fsprov
from loomex_core.protocols.context import ProviderContext


def _collect(events):
    return [e async for e in events]


async def test_bash_exec_passes_pythonioencoding(monkeypatch):
    captured = {}
    real = asyncio.create_subprocess_shell

    async def spy(cmd, **kw):
        captured["env"] = kw.get("env")
        return await real(cmd, **kw)

    monkeypatch.setattr(asyncio, "create_subprocess_shell", spy)
    ctx = ProviderContext(session_id="s1")
    await _collect(fsprov.bash_exec("echo hi", ctx=ctx))

    assert captured["env"] is not None
    assert captured["env"]["PYTHONIOENCODING"] == "utf-8"


def test_description_has_path_guidance():
    desc = fsprov._bash_exec_description()
    assert "double-escape" in desc.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_bash_exec_encoding.py -v`
Expected: FAIL — env is `None` (no env passed today) and description lacks "double-escape".

- [ ] **Step 3: Write minimal implementation**

Add import near the top of `capability_filesystem/provider.py` (after existing imports, alongside `from loomex_core.providers._tooldecl import make_tool_registry`):

```python
from loomex_core.providers._encoding import decode_console
```

In `_bash_exec_description()`, extend the **Windows** branch (the `return (...)` at lines 74-80) to append path + PowerShell guidance. Replace it with:

```python
    if system == "Windows":
        return (
            f"Execute a shell command and return stdout/stderr. "
            f"Host OS is Windows ({detail}); commands run via cmd.exe. "
            f"Use Windows commands (e.g. dir, type, copy, findstr, where); "
            f"Linux/Unix commands such as ls, cat, grep are NOT available. "
            f"Paths: write 'D:\\foo\\bar' (single backslash) or 'D:/foo/bar' "
            f"(forward slashes) — do NOT double-escape backslashes. "
            f"When you need PowerShell, call "
            f"powershell -NoProfile -Command \"...\"; on Windows PowerShell 5.1 "
            f"prepend [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); so "
            f"Chinese output is not garbled (PowerShell 7 already uses UTF-8). "
            f"{blocked_note}"
        )
```

In `bash_exec`, change the subprocess spawn (line 155-161) to pass an env with `PYTHONIOENCODING`, and add a `repr` diagnostic log right before it. Replace:

```python
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_max_out,
            cwd=cwd,
        )
```

with:

```python
        logger.info("bash_exec command (repr): %r", command)
        _env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_max_out,
            cwd=cwd,
            env=_env,
        )
```

Change the per-line decode (line 170) from:

```python
                    text = line.decode("utf-8", errors="replace")
```

to:

```python
                    text = decode_console(line)
```

(Line boundaries are `\n` = 0x0A, which never appears inside a UTF-8 or GBK multi-byte sequence, so per-line decode is safe.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_bash_exec_encoding.py -v`
Expected: PASS

- [ ] **Step 5: Run the full encoding-related suite + commit**

Run: `cd loomex-core && python -m pytest tests/unit/test_encoding.py tests/unit/test_skill_exec_encoding.py tests/unit/test_bash_exec_encoding.py -v`
Expected: all PASS

```bash
git add loomex-core/src/loomex_core/providers/capability_filesystem/provider.py loomex-core/tests/unit/test_bash_exec_encoding.py
git commit -m "feat(fs): decode_console + PYTHONIOENCODING + path guidance in bash_exec"
```

**✅ Phase 1 complete — encoding fix is shippable here.**

---

## PHASE 2 — Unified `script_runner` core (standalone, no provider wiring yet)

### Task 4: psutil dep + metrics primitives

**Files:**
- Modify: `loomex-core/pyproject.toml` (extras `builtin`, `skills`)
- Create: `loomex-core/src/loomex_core/providers/_script_runner.py`
- Test: `loomex-core/tests/unit/test_script_runner.py`

- [ ] **Step 1: Add psutil to extras**

In `loomex-core/pyproject.toml`, change:

```toml
builtin = ["httpx>=0.27"]
mcp     = ["httpx>=0.27"]
skills  = ["httpx>=0.27"]
```

to:

```toml
builtin = ["httpx>=0.27", "psutil>=5.9.0"]
mcp     = ["httpx>=0.27"]
skills  = ["httpx>=0.27", "psutil>=5.9.0"]
```

Then install: `cd loomex-core && pip install -e ".[builtin,skills,dev]"`

- [ ] **Step 2: Write the failing test**

```python
# loomex-core/tests/unit/test_script_runner.py
from loomex_core.providers._script_runner import (
    LivenessSample,
    made_progress,
)


def test_made_progress_on_output_growth():
    a = LivenessSample(output_bytes=10, cpu_seconds=1.0, io_bytes=0)
    b = LivenessSample(output_bytes=20, cpu_seconds=1.0, io_bytes=0)
    assert made_progress(a, b) is True


def test_made_progress_on_cpu_growth():
    a = LivenessSample(output_bytes=10, cpu_seconds=1.0, io_bytes=0)
    b = LivenessSample(output_bytes=10, cpu_seconds=1.5, io_bytes=0)
    assert made_progress(a, b) is True


def test_made_progress_on_io_growth():
    a = LivenessSample(output_bytes=10, cpu_seconds=1.0, io_bytes=0)
    b = LivenessSample(output_bytes=10, cpu_seconds=1.0, io_bytes=4096)
    assert made_progress(a, b) is True


def test_no_progress_when_all_flat():
    a = LivenessSample(output_bytes=10, cpu_seconds=1.0, io_bytes=4096)
    b = LivenessSample(output_bytes=10, cpu_seconds=1.0, io_bytes=4096)
    assert made_progress(a, b) is False
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 4: Write minimal implementation**

```python
# loomex-core/src/loomex_core/providers/_script_runner.py
"""Run a single child command with liveness-based timeout and reliable kill.

asyncio-native. Liveness = OR of three signals (stdout bytes, summed CPU time,
summed IO bytes) across the whole process tree, so a slow-but-healthy task
(OCR / docx / ffmpeg) is not killed while a genuinely hung one is. Termination
is tree-wide (POSIX process group / Windows Job Object) with kill-then-verify
honest survivor reporting — never claims a clean kill it did not achieve.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LivenessSample:
    output_bytes: int
    cpu_seconds: float
    io_bytes: int


def made_progress(prev: LivenessSample, cur: LivenessSample) -> bool:
    """True if ANY liveness signal grew between two samples."""
    return (
        cur.output_bytes > prev.output_bytes
        or cur.cpu_seconds > prev.cpu_seconds
        or cur.io_bytes > prev.io_bytes
    )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -v`
Expected: PASS (4 passed)

- [ ] **Step 6: Commit**

```bash
git add loomex-core/pyproject.toml loomex-core/src/loomex_core/providers/_script_runner.py loomex-core/tests/unit/test_script_runner.py
git commit -m "feat(providers): script_runner liveness primitives + psutil dep"
```

---

### Task 5: `collect_tree_metrics`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/_script_runner.py`
- Test: `loomex-core/tests/unit/test_script_runner.py`

- [ ] **Step 1: Write the failing test**

```python
# append to tests/unit/test_script_runner.py
import os

from loomex_core.providers._script_runner import collect_tree_metrics


def test_collect_tree_metrics_current_process():
    # The current test process is alive and has consumed CPU; metrics are non-negative.
    s = collect_tree_metrics(os.getpid(), output_bytes=123)
    assert s is not None
    assert s.output_bytes == 123
    assert s.cpu_seconds >= 0.0
    assert s.io_bytes >= 0


def test_collect_tree_metrics_dead_pid():
    # An almost-certainly-invalid pid yields None rather than raising.
    assert collect_tree_metrics(2_000_000_000, output_bytes=0) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -k tree_metrics -v`
Expected: FAIL — `ImportError: cannot import name 'collect_tree_metrics'`.

- [ ] **Step 3: Write minimal implementation**

Add to `_script_runner.py`:

```python
import psutil


def collect_tree_metrics(pid: int, *, output_bytes: int) -> LivenessSample | None:
    """Sum CPU + IO across pid and all descendants. None if the root is gone.

    Reads only this process tree's own counters (never system-global), so other
    apps' activity cannot mask a hung child. io_counters is unavailable on some
    platforms (macOS) — those procs simply contribute 0 IO.
    """
    try:
        root = psutil.Process(pid)
        procs = [root, *root.children(recursive=True)]
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None

    cpu = 0.0
    io = 0
    for pr in procs:
        try:
            t = pr.cpu_times()
            cpu += t.user + t.system
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        try:
            ioc = pr.io_counters()
            io += ioc.read_bytes + ioc.write_bytes
        except (psutil.NoSuchProcess, psutil.AccessDenied, NotImplementedError, AttributeError):
            continue
    return LivenessSample(output_bytes=output_bytes, cpu_seconds=cpu, io_bytes=io)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -k tree_metrics -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/_script_runner.py loomex-core/tests/unit/test_script_runner.py
git commit -m "feat(providers): collect_tree_metrics for liveness sampling"
```

---

### Task 6: Containment spawn + `terminate_tree`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/_script_runner.py`
- Test: `loomex-core/tests/unit/test_script_runner.py`

- [ ] **Step 1: Write the failing test**

```python
# append to tests/unit/test_script_runner.py
import asyncio
import sys

import psutil

from loomex_core.providers._script_runner import spawn_contained, terminate_tree


async def test_terminate_tree_kills_child_and_grandchild():
    # Parent shell spawns a python grandchild that sleeps 60s; terminate_tree
    # must leave no survivors.
    grandchild = f'{sys.executable} -c "import time; time.sleep(60)"'
    proc, handle = await spawn_contained(grandchild, cwd=None, env=None)
    pid = proc.pid
    # Give the grandchild a moment to appear.
    await asyncio.sleep(1.0)
    result = await terminate_tree(proc, handle)
    assert result.clean is True
    assert result.survivors == []
    assert not psutil.pid_exists(pid)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -k terminate_tree -v`
Expected: FAIL — `ImportError: cannot import name 'spawn_contained'`.

- [ ] **Step 3: Write minimal implementation**

Add to `_script_runner.py`:

```python
import asyncio
import os
import sys


@dataclass
class TerminationResult:
    clean: bool
    survivors: list[int] = field(default_factory=list)


def _is_windows() -> bool:
    return sys.platform == "win32"


def _make_windows_job() -> object | None:
    """Create a Job Object with KILL_ON_JOB_CLOSE. None on failure (degrade to psutil)."""
    import ctypes
    from ctypes import wintypes

    JobObjectExtendedLimitInformation = 9
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
            ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    h_job = kernel32.CreateJobObjectW(None, None)
    if not h_job:
        return None
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = kernel32.SetInformationJobObject(
        h_job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info),
    )
    if not ok:
        kernel32.CloseHandle(h_job)
        return None
    return h_job


def _assign_to_job(h_job: object, pid: int) -> None:
    import ctypes
    PROCESS_SET_QUOTA = 0x0100
    PROCESS_TERMINATE = 0x0001
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    h_proc = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
    if h_proc:
        kernel32.AssignProcessToJobObject(h_job, h_proc)
        kernel32.CloseHandle(h_proc)


async def spawn_contained(command: str, *, cwd: str | None, env: dict | None):
    """Spawn a shell command in an OS container (process group / Job Object).

    Returns (proc, handle) where handle is the Windows job object (or None on POSIX).
    """
    if _is_windows():
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
        )
        h_job = _make_windows_job()
        if h_job is not None:
            _assign_to_job(h_job, proc.pid)
        return proc, h_job

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
        start_new_session=True,  # new process group → killpg targets the whole tree
    )
    return proc, None


async def terminate_tree(proc, handle: object | None) -> TerminationResult:
    """Kill the whole tree, then verify. Reports survivors honestly."""
    if proc.returncode is not None:
        return TerminationResult(clean=True, survivors=[])

    pid = proc.pid
    # Snapshot the tree before killing so we can verify afterwards.
    try:
        root = psutil.Process(pid)
        tree = [root, *root.children(recursive=True)]
    except psutil.NoSuchProcess:
        tree = []

    # 1) OS-level container kill.
    if _is_windows():
        if handle is not None:
            import ctypes
            ctypes.WinDLL("kernel32").CloseHandle(handle)  # KILL_ON_JOB_CLOSE
    else:
        try:
            os.killpg(os.getpgid(pid), 15)  # SIGTERM
        except (ProcessLookupError, PermissionError):
            pass

    # 2) psutil belt-and-suspenders: terminate then kill survivors.
    for pr in tree:
        try:
            pr.terminate()
        except psutil.NoSuchProcess:
            continue
    gone, alive = psutil.wait_procs(tree, timeout=3)
    for pr in alive:
        try:
            pr.kill()
        except psutil.NoSuchProcess:
            continue
    if not _is_windows():
        try:
            os.killpg(os.getpgid(pid), 9)  # SIGKILL
        except (ProcessLookupError, PermissionError):
            pass

    # 3) Verify.
    try:
        await asyncio.wait_for(proc.wait(), timeout=3)
    except (asyncio.TimeoutError, ProcessLookupError):
        pass
    _, still_alive = psutil.wait_procs(tree, timeout=1)
    survivors = [pr.pid for pr in still_alive if pr.is_running()]
    return TerminationResult(clean=not survivors, survivors=survivors)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -k terminate_tree -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/_script_runner.py loomex-core/tests/unit/test_script_runner.py
git commit -m "feat(providers): spawn_contained + terminate_tree with honest survivors"
```

---

### Task 7: `run_with_liveness` orchestration

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/_script_runner.py`
- Test: `loomex-core/tests/unit/test_script_runner.py`

- [ ] **Step 1: Write the failing test**

```python
# append to tests/unit/test_script_runner.py
from loomex_core.providers._script_runner import run_with_liveness


async def test_clean_exit_collects_output():
    out_lines = []
    result = await run_with_liveness(
        f'{sys.executable} -c "print(\'hello\'); print(\'world\')"',
        cwd=None, env=None,
        idle_timeout_sec=10, hard_cap_sec=30, output_limit_bytes=100_000,
        poll_interval_sec=0.2,
        on_output=lambda stream, text: out_lines.append((stream, text)),
    )
    assert result.exit_code == 0
    assert result.timed_out is False
    assert result.timeout_kind is None
    assert result.terminated_clean is True
    assert "hello" in result.stdout
    assert "world" in result.stdout
    assert any("hello" in t for _, t in out_lines)


async def test_idle_timeout_kills_silent_sleeper():
    progress = []
    result = await run_with_liveness(
        f'{sys.executable} -c "import time; time.sleep(60)"',
        cwd=None, env=None,
        idle_timeout_sec=1.5, hard_cap_sec=30, output_limit_bytes=100_000,
        poll_interval_sec=0.3,
        on_progress=lambda p: progress.append(p),
    )
    assert result.timed_out is True
    assert result.timeout_kind == "idle"
    assert result.terminated_clean is True
    assert result.survivors == []
    assert len(progress) >= 1
    # last progress frame reports idle countdown reached 0
    assert progress[-1].idle_remaining_sec == 0


async def test_hard_cap_kills_busy_but_overlong():
    # Continuously prints (never idle) but exceeds the hard cap → killed by hard_cap.
    busy = f'{sys.executable} -u -c "import time\nwhile True:\n print(\'x\'); time.sleep(0.1)"'
    result = await run_with_liveness(
        busy, cwd=None, env=None,
        idle_timeout_sec=30, hard_cap_sec=1.5, output_limit_bytes=100_000,
        poll_interval_sec=0.3,
    )
    assert result.timed_out is True
    assert result.timeout_kind == "hard_cap"
    assert result.terminated_clean is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -k "clean_exit or idle_timeout or hard_cap" -v`
Expected: FAIL — `ImportError: cannot import name 'run_with_liveness'`.

- [ ] **Step 3: Write minimal implementation**

Add to `_script_runner.py`:

```python
import time
from collections.abc import Callable


@dataclass
class LivenessProgress:
    elapsed_sec: float
    output_bytes: int
    idle_remaining_sec: float
    hard_cap_remaining_sec: float
    cpu_seconds: float


@dataclass
class RunResult:
    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool
    timeout_kind: str | None        # "idle" | "hard_cap" | None
    terminated_clean: bool
    survivors: list[int] = field(default_factory=list)


async def run_with_liveness(
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
    from loomex_core.providers._encoding import decode_console

    proc, handle = await spawn_contained(command, cwd=cwd, env=env)
    stdout_buf: list[str] = []
    stderr_buf: list[str] = []
    counters = {"output_bytes": 0}
    start = time.monotonic()

    async def _reader(stream, name: str, buf: list[str]):
        assert stream is not None
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
    try:
        done, _pending = await asyncio.wait(
            {asyncio.create_task(proc.wait()), poller},
            return_when=asyncio.FIRST_COMPLETED,
        )
        termination = TerminationResult(clean=True, survivors=[])
        if timeout_kind is not None:
            termination = await terminate_tree(proc, handle)
        # Drain readers and the process.
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
        # Guarantee no reachable orphan on any path.
        if proc.returncode is None:
            termination = await terminate_tree(proc, handle)

    return RunResult(
        stdout="".join(stdout_buf),
        stderr="".join(stderr_buf),
        exit_code=proc.returncode,
        timed_out=timeout_kind is not None,
        timeout_kind=timeout_kind,
        terminated_clean=termination.clean,
        survivors=termination.survivors,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_script_runner.py -v`
Expected: all PASS (allow a few seconds for the timeout tests)

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/_script_runner.py loomex-core/tests/unit/test_script_runner.py
git commit -m "feat(providers): run_with_liveness idle/hard-cap runner"
```

**✅ Phase 2 complete — runner is fully tested in isolation.**

---

## PHASE 3 — Integrate runner into both providers

### Task 8: skill `exec_script` → `run_with_liveness`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_skill_local/provider.py` — ctor (76-87) + `exec_script` (183-226)
- Test: `loomex-core/tests/unit/test_skill_exec_liveness.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_skill_exec_liveness.py
from pathlib import Path

import pytest

from loomex_core.providers.capability_skill_local.provider import LocalSkillCapabilityProvider
from loomex_core.protocols.context import ProviderContext


def _make_skill(tmp_path: Path, body: str) -> Path:
    skill = tmp_path / "live-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: live-skill\ndescription: t\n---\nb\n", encoding="utf-8")
    (skill / "scripts").mkdir()
    (skill / "scripts" / "run.py").write_text(body, encoding="utf-8")
    return tmp_path


async def test_idle_timeout_reports_honestly(tmp_path):
    skills_dir = _make_skill(tmp_path, "import time\ntime.sleep(60)\n")
    prov = LocalSkillCapabilityProvider(skills_dir, idle_timeout_sec=1.0, hard_cap_sec=30)
    ctx = ProviderContext(session_id="s1")
    with pytest.raises(RuntimeError) as exc:
        await prov.exec_script("live-skill", "scripts/run.py", "", ctx)
    assert "idle" in str(exc.value).lower() or "timed out" in str(exc.value).lower()


async def test_normal_script_returns_stdout(tmp_path):
    skills_dir = _make_skill(tmp_path, "print('done-42')\n")
    prov = LocalSkillCapabilityProvider(skills_dir, idle_timeout_sec=10, hard_cap_sec=30)
    ctx = ProviderContext(session_id="s1")
    out = await prov.exec_script("live-skill", "scripts/run.py", "", ctx)
    assert "done-42" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_exec_liveness.py -v`
Expected: FAIL — ctor has no `idle_timeout_sec` / `hard_cap_sec` kwargs → `TypeError`.

- [ ] **Step 3: Write minimal implementation**

Update the ctor (currently 76-87) to add the new params (keep `script_timeout_sec` for backward compat but unused by the new path):

```python
    def __init__(
        self,
        skills_dir: Path,
        *,
        script_timeout_sec: int = 60,
        idle_timeout_sec: float = 90,
        hard_cap_sec: float = 600,
        output_limit_chars: int = 65536,
    ) -> None:
        self._dir = skills_dir
        self._index: dict[str, _SkillEntry] | None = None
        self._script_timeout_sec = script_timeout_sec
        self._idle_timeout_sec = idle_timeout_sec
        self._hard_cap_sec = hard_cap_sec
        self._output_limit_chars = output_limit_chars
```

Add import near the top:

```python
from loomex_core.providers._script_runner import run_with_liveness
```

Replace the subprocess block in `exec_script` (currently 202-226) with:

```python
        env = {**os.environ, "SKILL_DIR": str(skill_root), "PYTHONIOENCODING": "utf-8"}
        result = await run_with_liveness(
            cmd,
            cwd=str(skill_root),
            env=env,
            idle_timeout_sec=self._idle_timeout_sec,
            hard_cap_sec=self._hard_cap_sec,
            output_limit_bytes=self._output_limit_chars,
        )
        stdout = result.stdout[: self._output_limit_chars]
        stderr = result.stderr[: self._output_limit_chars]

        if result.timed_out:
            survivor_note = (
                "" if result.terminated_clean
                else f" WARNING: {len(result.survivors)} process(es) may still be running; "
                     "outputs may be partial."
            )
            raise RuntimeError(
                f"exec_skill_script timed out ({result.timeout_kind}).{survivor_note}\n"
                f"stdout: {stdout}\nstderr: {stderr}"
            )
        if result.exit_code != 0:
            raise RuntimeError(
                f"script exited with code {result.exit_code}\n"
                f"stdout: {stdout}\nstderr: {stderr}"
            )
        return stdout
```

Note: the old `decode_console` decode lines from Task 2 are now gone (the runner decodes internally). The `PYTHONIOENCODING` env from Task 2 is preserved above.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_exec_liveness.py tests/unit/test_skill_exec_encoding.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/capability_skill_local/provider.py loomex-core/tests/unit/test_skill_exec_liveness.py
git commit -m "feat(skills): exec_script uses run_with_liveness + honest timeout reporting"
```

---

### Task 9: `bash_exec` → `run_with_liveness` via queue bridge

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_filesystem/provider.py` — `bash_exec` body (148-189), constants (54-55)
- Test: `loomex-core/tests/unit/test_bash_exec_liveness.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_bash_exec_liveness.py
import sys

import pytest

from loomex_core.providers.capability_filesystem import provider as fsprov
from loomex_core.protocols.context import ProviderContext


async def _collect(events):
    return [e async for e in events]


async def test_bash_exec_streams_and_completes():
    ctx = ProviderContext(session_id="s1")
    cmd = f'{sys.executable} -c "print(\'alpha\'); print(\'beta\')"'
    events = await _collect(fsprov.bash_exec(cmd, ctx=ctx))
    kinds = [e.kind for e in events]
    assert "stdout" in kinds
    result = next(e for e in events if e.kind == "result")
    assert "alpha" in result.payload["content"]
    assert "beta" in result.payload["content"]
    assert result.payload["metadata"]["exit_code"] == 0


async def test_bash_exec_idle_timeout_reports_error(monkeypatch):
    # Force a tiny idle timeout via ctx.extra so the sleeper is killed fast.
    ctx = ProviderContext(session_id="s1", extra={"bash_idle_timeout_sec": 1.0})
    cmd = f'{sys.executable} -c "import time; time.sleep(60)"'
    events = await _collect(fsprov.bash_exec(cmd, ctx=ctx))
    err = next(e for e in events if e.kind == "error")
    assert err.payload["code"] == "TIMEOUT"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_bash_exec_liveness.py -v`
Expected: FAIL — `test_bash_exec_idle_timeout_reports_error` hangs/fails because today's fixed 30s timeout ignores `bash_idle_timeout_sec`. (Run with `--timeout=20` if available, or expect a long sleep.)

- [ ] **Step 3: Write minimal implementation**

Update constants (54-55) — replace the single fixed timeout with idle/hard-cap defaults:

```python
_BASH_IDLE_TIMEOUT_SEC_DEFAULT = 30
_BASH_HARD_CAP_SEC_DEFAULT = 120
_BASH_MAX_OUTPUT_BYTES_DEFAULT = 50_000
```

Add imports near the top:

```python
from loomex_core.providers._script_runner import run_with_liveness
```

Replace the `bash_exec` body from the spawn through the result (the `try:` block at 152-192) with a queue-bridged version that preserves streaming:

```python
    ws = _workspace(ctx)
    cwd = str(ws) if ws else None
    idle = (ctx.extra.get("bash_idle_timeout_sec") if ctx else None) or _BASH_IDLE_TIMEOUT_SEC_DEFAULT
    hard = (ctx.extra.get("bash_hard_cap_sec") if ctx else None) or _BASH_HARD_CAP_SEC_DEFAULT
    max_out = (ctx.extra.get("bash_max_output_bytes") if ctx else None) or _BASH_MAX_OUTPUT_BYTES_DEFAULT

    logger.info("bash_exec command (repr): %r", command)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}

    queue: asyncio.Queue = asyncio.Queue()

    def _on_output(_stream: str, text: str) -> None:
        queue.put_nowait(("out", text))

    async def _run() -> None:
        try:
            result = await run_with_liveness(
                command, cwd=cwd, env=env,
                idle_timeout_sec=idle, hard_cap_sec=hard, output_limit_bytes=max_out,
                on_output=_on_output,
            )
            queue.put_nowait(("done", result))
        except Exception as e:  # noqa: BLE001 — surfaced as an error event below
            queue.put_nowait(("exc", e))

    runner = asyncio.create_task(_run())
    try:
        collected: list[str] = []
        while True:
            kind, payload = await queue.get()
            if kind == "out":
                collected.append(payload)
                yield CapabilityEvent(kind="stdout", payload={"data": payload})
            elif kind == "exc":
                logger.exception("bash_exec failed: %s", command)
                yield CapabilityEvent(kind="error", payload={"code": "EXEC_ERROR", "message": str(payload)})
                return
            elif kind == "done":
                result = payload
                if result.timed_out:
                    survivor = "" if result.terminated_clean else (
                        f" WARNING: {len(result.survivors)} process(es) may still be running."
                    )
                    yield CapabilityEvent(kind="error", payload={
                        "code": "TIMEOUT",
                        "message": f"Command timed out ({result.timeout_kind}).{survivor}",
                    })
                    return
                exit_code = result.exit_code or 0
                yield CapabilityEvent(kind="result", payload={
                    "content": result.stdout,
                    "metadata": {"exit_code": exit_code, "is_error": exit_code != 0},
                })
                return
    finally:
        if not runner.done():
            runner.cancel()
```

Note: `run_with_liveness` keeps stdout/stderr separate; `bash_exec`'s `result.stdout` carries stdout only. To preserve the old merged behavior (stderr folded into stdout), also forward stderr in `_on_output` — it already receives both streams, and both are appended to `collected` is not needed since we use `result.stdout`. To merge, change the `done` branch to use `result.stdout + result.stderr`. Keep this explicit:

```python
                content = result.stdout + result.stderr
                yield CapabilityEvent(kind="result", payload={
                    "content": content,
                    "metadata": {"exit_code": exit_code, "is_error": exit_code != 0},
                })
```

(and the streamed `stdout` events already include both streams via `_on_output`, matching the old `stderr=STDOUT` merge.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_bash_exec_liveness.py tests/unit/test_bash_exec_encoding.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/capability_filesystem/provider.py loomex-core/tests/unit/test_bash_exec_liveness.py
git commit -m "feat(fs): bash_exec uses run_with_liveness (idle/hard-cap, tree kill)"
```

---

### Task 10: Host config wiring for idle/hard-cap settings

**Files:**
- Modify: `src/loomex_host/config.py` (add 4 settings)
- Modify: `loomex-core/src/loomex_core/providers/capability_filesystem/provider.py` — `FilesystemConfig` dataclass (add idle/hard-cap fields) + `bash_exec` reading from ctx.extra (already done in Task 9; ensure the provider seeds ctx.extra or config defaults)
- Modify: `src/loomex_host/cli.py:82-83` and `src/loomex_host/api/startup.py` (~60, ~144)
- Test: `tests/test_host_config_runner_settings.py` (new, host-level)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_host_config_runner_settings.py
from loomex_host.config import Settings


def test_runner_timeout_settings_have_defaults():
    s = Settings()
    assert s.fs_bash_idle_timeout_sec == 30
    assert s.fs_bash_hard_cap_sec == 120
    assert s.skill_idle_timeout_sec == 90
    assert s.skill_hard_cap_sec == 600


def test_runner_settings_overridable_via_env(monkeypatch):
    monkeypatch.setenv("LOOMEX_SKILL_IDLE_TIMEOUT_SEC", "45")
    s = Settings()
    assert s.skill_idle_timeout_sec == 45
```

(Confirm the env-var prefix used by `Settings` — inspect `src/loomex_host/config.py` for the existing `env_prefix` / field aliases and match it; the assert above assumes `LOOMEX_`. Adjust the monkeypatch key to the real prefix.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_config_runner_settings.py -v`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'fs_bash_idle_timeout_sec'`.

- [ ] **Step 3: Write minimal implementation**

In `src/loomex_host/config.py`, add four fields next to the existing `fs_bash_timeout_sec` (match the surrounding field style — `pydantic` `Field` with default, and the file's env prefix):

```python
    fs_bash_idle_timeout_sec: int = 30
    fs_bash_hard_cap_sec: int = 120
    skill_idle_timeout_sec: int = 90
    skill_hard_cap_sec: int = 600
```

In `loomex-core/.../capability_filesystem/provider.py`, add fields to `FilesystemConfig` (find the `@dataclass class FilesystemConfig`) so the host can inject them, and have `bash_exec` fall back to config when `ctx.extra` is absent. Add to the dataclass:

```python
    bash_idle_timeout_sec: int = 30
    bash_hard_cap_sec: int = 120
```

Seed these into `ctx.extra` at the provider's invoke boundary (where the provider already injects `bash_timeout_sec` today — search for `bash_timeout_sec` in this provider's `_dispatch`/`invoke`; mirror that wiring with the two new keys `bash_idle_timeout_sec` / `bash_hard_cap_sec`).

In `src/loomex_host/cli.py:82`, extend the `FilesystemConfig(...)` call:

```python
        providers.register_capability(FilesystemToolsProvider(FilesystemConfig(
            bash_timeout_sec=cfg.fs_bash_timeout_sec,
            bash_idle_timeout_sec=cfg.fs_bash_idle_timeout_sec,
            bash_hard_cap_sec=cfg.fs_bash_hard_cap_sec,
            # ... existing fields ...
        )))
```

In the same file and in `src/loomex_host/api/startup.py` (~144), extend the `LocalSkillCapabilityProvider(...)` construction with:

```python
        LocalSkillCapabilityProvider(
            skills_dir,
            idle_timeout_sec=cfg.skill_idle_timeout_sec,
            hard_cap_sec=cfg.skill_hard_cap_sec,
            # ... existing fields ...
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_config_runner_settings.py -v`
Expected: PASS

- [ ] **Step 5: Run full suites (core + host) + commit**

Run:
```bash
cd loomex-core && python -m pytest -q
cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest -q
```
Expected: green (or only pre-existing unrelated failures — note any).

```bash
git add src/loomex_host/config.py src/loomex_host/cli.py src/loomex_host/api/startup.py loomex-core/src/loomex_core/providers/capability_filesystem/provider.py tests/test_host_config_runner_settings.py
git commit -m "feat(host): wire idle/hard-cap runner settings into fs + skill providers"
```

**✅ Phase 3 complete — both paths run on the unified runner, configured from the host.**

---

## PHASE 4 (OPTIONAL) — Skill execution progress → SSE

**Status: optional, flag before starting.** `bash_exec` already streams `CapabilityEvent`s, so its progress is naturally visible. Skill `exec_script` returns a `str` and is wrapped by `skill_executor_capability._dispatch` into a single result event (`skill_executor_capability.py:106-117`). To surface live progress for skills, `exec_script` must forward `run_with_liveness`'s `on_progress` out through the async-generator boundary.

**Recommended approach (if pursued):** pass an `on_progress` callback into `exec_script` that pushes `LivenessProgress` snapshots onto an `asyncio.Queue`; convert `exec_skill_script` / `_dispatch` to drain that queue and `yield CapabilityEvent(kind="progress", payload={...})` while awaiting the script — same producer/consumer bridge used for `bash_exec` in Task 9. This is a non-trivial refactor of the skill orchestrator's dispatch and should be planned as its own task set after Phase 3 is validated in the real app.

**Decision needed from the user before implementing Phase 4** — defer unless the desktop ActivityStrip needs skill progress now.

---

## PHASE 5 — Force `exec_skill_script` runtime note (case 5)

**Goal:** Append a recency-strongest runtime note at the **end of the loaded SKILL.md instructions** so the agent always uses `exec_skill_script` / `load_skill_reference` / `get_skill_files` instead of running `python scripts/foo.py` directly (skill files are not in the working dir).

**Where:** `prepare.py:_load_skill_instructions` (`loomex-core/.../core/loop/steps/prepare.py:104-127`) returns `defn.instructions`, which flows via `request.extra["skill_instructions"]` → `identity.py` source → composer's "## Instructions for the current task". Appending in `prepare.py` puts the note at the very end of that block.

### Task 11: `wrap_skill_instructions` helper + wiring

**Files:**
- Modify: `loomex-core/src/loomex_core/core/loop/steps/prepare.py`
- Test: `loomex-core/tests/unit/test_skill_instructions_note.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_skill_instructions_note.py
from loomex_core.core.loop.steps.prepare import wrap_skill_instructions


def test_empty_stays_empty():
    assert wrap_skill_instructions("") == ""


def test_note_appended_after_body():
    body = "Run scripts/convert.py to convert the file."
    out = wrap_skill_instructions(body)
    assert out.startswith(body)
    assert "exec_skill_script" in out
    assert "load_skill_reference" in out
    assert "get_skill_files" in out
    # the note must come AFTER the body (recency)
    assert out.index("exec_skill_script") > out.index(body)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_instructions_note.py -v`
Expected: FAIL — `ImportError: cannot import name 'wrap_skill_instructions'`.

- [ ] **Step 3: Write minimal implementation**

Add near the top of `prepare.py` (after imports, module level):

```python
_SKILL_SCRIPT_RUNTIME_NOTE = (
    "---\n"
    "**Runtime note (overrides any 'run python ...' wording above):** "
    "This skill's files are NOT in your working directory. To run ANY script the "
    "instructions reference, you MUST call the `exec_skill_script` tool — e.g. "
    "`exec_skill_script(script_path='scripts/foo.py', args='...')` — never run "
    "`python scripts/foo.py` yourself (the path will not resolve). To read a skill "
    "file use `load_skill_reference`; to list skill files use `get_skill_files`. "
    "Do not build absolute paths by hand. Applies to local and remote skills alike."
)


def wrap_skill_instructions(instructions: str) -> str:
    """Append the exec_skill_script runtime note after a non-empty SKILL.md body."""
    if not instructions:
        return ""
    return f"{instructions}\n\n{_SKILL_SCRIPT_RUNTIME_NOTE}"
```

Change the return at line 124 from:

```python
                return defn.instructions
```

to:

```python
                return wrap_skill_instructions(defn.instructions)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_instructions_note.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/core/loop/steps/prepare.py loomex-core/tests/unit/test_skill_instructions_note.py
git commit -m "feat(skills): append exec_skill_script runtime note to skill instructions"
```

---

## PHASE 6 — OpenAI chat-endpoint inference (case 9), via host subclass

**Goal:** Stop hardcoding `{base_url}/v1/chat/completions`. Infer the chat endpoint from the configured `base_url` (already a full endpoint / already version-suffixed / bare host) so internal OpenAI-compatible providers (e.g. Zhipu `.../paas/v4`) don't get a doubled path → no more add-model 500 / chat 404.

**Architecture directive (from user):** do NOT bake this into core. Add a behavior-preserving **seam** in the core adapter (`_chat_url()`), then have the **host subclass override it**. The host `LLMProvider` already subclasses core (Phase 6 Task 14) and builds host adapters.

**Note on error-body parsing:** the fork's case 9 also added tolerant error parsing. LoomeX's `openai.py` error path only does `err_body = body.decode()` and embeds the raw text (it does not structurally parse `error.message`), so it cannot crash on non-standard error bodies — that half of case 9 is already satisfied. No work needed. The `list_models` endpoint (`/v1/models`) is out of scope for this phase (chat only, as requested).

### Task 12: Core seam — `OpenAIAdapter._chat_url()` (behavior-preserving)

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/llm/openai.py:70` and add a method
- Test: `loomex-core/tests/unit/test_openai_adapter_seam.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_openai_adapter_seam.py
from loomex_core.providers.llm.openai import OpenAIAdapter


def test_chat_url_default_unchanged():
    a = OpenAIAdapter(api_key="k", base_url="https://api.openai.com")
    assert a._chat_url() == "https://api.openai.com/v1/chat/completions"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_openai_adapter_seam.py -v`
Expected: FAIL — `AttributeError: 'OpenAIAdapter' object has no attribute '_chat_url'`.

- [ ] **Step 3: Write minimal implementation**

In `openai.py`, change `_stream` line 70 from:

```python
        url = f"{self._base_url}/v1/chat/completions"
```

to:

```python
        url = self._chat_url()
```

Add a method on `OpenAIAdapter` (next to `_headers`, ~line 195):

```python
    def _chat_url(self) -> str:
        """Chat-completions endpoint. Overridable for endpoint inference."""
        return f"{self._base_url}/v1/chat/completions"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_openai_adapter_seam.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/llm/openai.py loomex-core/tests/unit/test_openai_adapter_seam.py
git commit -m "refactor(llm): extract OpenAIAdapter._chat_url seam (no behavior change)"
```

---

### Task 13: Host adapter `HostOpenAIAdapter` + `_resolve_chat_url`

**Files:**
- Create: `src/loomex_host/providers/llm/adapters.py`
- Test: `tests/test_host_llm_adapters.py` (new, host-level — run from repo root)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_host_llm_adapters.py
import pytest

from loomex_host.providers.llm.adapters import _resolve_chat_url, HostOpenAIAdapter


@pytest.mark.parametrize("base, expected", [
    ("https://api.openai.com", "https://api.openai.com/v1/chat/completions"),
    ("https://api.openai.com/", "https://api.openai.com/v1/chat/completions"),
    ("https://foo.cn/v1", "https://foo.cn/v1/chat/completions"),
    ("https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/chat/completions"),
    ("https://foo.cn/v1/chat/completions", "https://foo.cn/v1/chat/completions"),
])
def test_resolve_chat_url(base, expected):
    assert _resolve_chat_url(base) == expected


def test_host_openai_adapter_uses_inference():
    a = HostOpenAIAdapter(api_key="k", base_url="https://foo.cn/v1")
    assert a._chat_url() == "https://foo.cn/v1/chat/completions"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_llm_adapters.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'loomex_host.providers.llm.adapters'`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/loomex_host/providers/llm/adapters.py
"""Host LLM adapter subclasses.

Override core adapter seams for internal-deployment concerns:
  - OpenAI chat-endpoint inference (_chat_url)
  - corporate-CA SSL (_make_client)  ← added in Phase 7
without modifying loomex_core.
"""

from __future__ import annotations

import re

from loomex_core.providers.llm.openai import OpenAIAdapter

_VERSION_SEG = re.compile(r"v\d+", re.IGNORECASE)


def _resolve_chat_url(base: str) -> str:
    """Infer the chat-completions endpoint from a configured base_url.

    - already a full endpoint (.../chat/completions) → unchanged
    - ends with a version segment (/v1, /paas/v4)     → append /chat/completions
    - bare host (https://api.openai.com)              → append /v1/chat/completions
    """
    b = base.rstrip("/")
    if b.lower().endswith("/chat/completions"):
        return b
    last = b.rsplit("/", 1)[-1]
    if _VERSION_SEG.fullmatch(last):
        return f"{b}/chat/completions"
    return f"{b}/v1/chat/completions"


class HostOpenAIAdapter(OpenAIAdapter):
    def _chat_url(self) -> str:
        return _resolve_chat_url(self._base_url)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_llm_adapters.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/providers/llm/adapters.py tests/test_host_llm_adapters.py
git commit -m "feat(host): HostOpenAIAdapter with chat-endpoint inference"
```

---

### Task 14: Host `LLMProvider` subclass builds host adapters

**Files:**
- Modify: `src/loomex_host/providers/llm/llm_provider.py` (shim → subclass)
- Test: `tests/test_host_llm_provider_build.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_host_llm_provider_build.py
from loomex_host.providers.llm.llm_provider import LLMProvider, LLMAccount
from loomex_host.providers.llm.adapters import HostOpenAIAdapter


class _MemStore:
    def __init__(self): self._d = {}
    def save(self, acc): self._d[acc.name] = acc
    def delete(self, name): self._d.pop(name, None)
    def list_all(self): return list(self._d.values())


def test_openai_account_builds_host_adapter():
    p = LLMProvider(_MemStore())
    acc = LLMAccount(name="zhipu", style="openai", api_key="k", base_url="https://foo.cn/v1")
    p.register_account(acc, persist=True)
    adapter = p._adapters["zhipu"]
    assert isinstance(adapter, HostOpenAIAdapter)
    assert adapter._chat_url() == "https://foo.cn/v1/chat/completions"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_llm_provider_build.py -v`
Expected: FAIL — current shim returns the core `OpenAIAdapter`, not `HostOpenAIAdapter`.

- [ ] **Step 3: Write minimal implementation**

Replace the entire `src/loomex_host/providers/llm/llm_provider.py` with:

```python
"""Host LLMProvider — subclasses the core provider to build host adapters.

Keeps the public name `LLMProvider` (and re-exports the core value types) so
existing host imports keep working; only `_build_adapter` is overridden.
"""

from __future__ import annotations

from loomex_core.protocols import LLMClient
from loomex_core.providers.llm import (  # noqa: F401
    LLMAccount,
    LLMProvider as _CoreLLMProvider,
    ModelConfig,
    SUPPORTED_STYLES,
)


class LLMProvider(_CoreLLMProvider):
    """Host provider: builds host adapter subclasses (endpoint inference + SSL)."""

    def __init__(self, store, *, max_http_retries: int = 3, ssl_verify=None) -> None:
        super().__init__(store, max_http_retries=max_http_retries)
        # ssl_verify is injected by the host edge (Phase 7); None → adapters use default.
        self._ssl_verify = ssl_verify

    def _build_adapter(self, account: LLMAccount) -> LLMClient:
        if account.style == "openai":
            from loomex_host.providers.llm.adapters import HostOpenAIAdapter
            return HostOpenAIAdapter(
                api_key=account.api_key,
                base_url=account.base_url or "https://api.openai.com",
                timeout_sec=account.timeout_sec,
                max_http_retries=self._max_http_retries,
            )
        if account.style == "anthropic":
            from loomex_host.providers.llm.adapters import HostAnthropicAdapter
            return HostAnthropicAdapter(
                api_key=account.api_key,
                base_url=account.base_url or "https://api.anthropic.com",
                timeout_sec=account.timeout_sec,
                max_http_retries=self._max_http_retries,
            )
        return super()._build_adapter(account)
```

**Note:** `HostAnthropicAdapter` and the `ssl_verify` plumbing land in Phase 7. To keep Task 14 self-contained and green now, temporarily define `HostAnthropicAdapter` in `adapters.py` as a bare subclass:

```python
from loomex_core.providers.llm.anthropic import AnthropicAdapter

class HostAnthropicAdapter(AnthropicAdapter):
    pass
```

(Phase 7 Task 17 adds the `_make_client` override to both.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_llm_provider_build.py tests/test_host_llm_adapters.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/providers/llm/llm_provider.py src/loomex_host/providers/llm/adapters.py tests/test_host_llm_provider_build.py
git commit -m "feat(host): LLMProvider subclass builds host adapters"
```

**✅ Phase 6 complete — chat-endpoint inference live; both `startup.py:38` and `cli.py:40` already import this shim, so no call-site change needed.**

---

## PHASE 7 — SSL corporate-CA trust (case 6), via host subclass

**Goal:** Make LLM (and later MCP/skill) HTTPS calls trust enterprise/internal CAs that aren't in certifi, via `verify=make_ssl_verify(settings)` on the httpx clients. Implemented by **host subclasses overriding the adapter's client-construction seam** — core stays unchanged.

**⚠️ PREREQUISITE / RISK:** the SSL engine is the fork's `app/common/ssl_verify.py` (~811 lines, pyOpenSSL + cryptography, 3-tier verify + AIA chain fetch). This phase **ports that file**; it requires access to the fork repo source. If that source is unavailable this becomes a multi-day from-scratch reimplementation — confirm availability before starting. Scope here = the **static** `make_ssl_verify()` (OS/registry/env/bundle CA loading). The **passive AIA retry** (`with_ssl_retry`) is split out as optional Task 19.

### Task 15: Core seam — `_make_client()` on both adapters (behavior-preserving)

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/llm/openai.py:50` + `loomex-core/src/loomex_core/providers/llm/anthropic.py:51`
- Test: `loomex-core/tests/unit/test_llm_client_seam.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# loomex-core/tests/unit/test_llm_client_seam.py
import httpx

from loomex_core.providers.llm.openai import OpenAIAdapter
from loomex_core.providers.llm.anthropic import AnthropicAdapter


def test_openai_make_client_returns_async_client():
    a = OpenAIAdapter(api_key="k")
    assert isinstance(a._make_client(), httpx.AsyncClient)


def test_anthropic_make_client_returns_async_client():
    a = AnthropicAdapter(api_key="k")
    assert isinstance(a._make_client(), httpx.AsyncClient)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd loomex-core && python -m pytest tests/unit/test_llm_client_seam.py -v`
Expected: FAIL — `AttributeError: ... '_make_client'`.

- [ ] **Step 3: Write minimal implementation**

In **both** `openai.py` and `anthropic.py`, change the `__init__` line that builds the client:

```python
        self._client = httpx.AsyncClient(timeout=timeout_sec)
```

to:

```python
        self._client = self._make_client()
```

and add the method (after `__init__`, before the properties):

```python
    def _make_client(self) -> httpx.AsyncClient:
        """Build the httpx client. Overridable to inject SSL verification."""
        return httpx.AsyncClient(timeout=self._timeout)
```

(`self._timeout` is already set before this call in both ctors.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd loomex-core && python -m pytest tests/unit/test_llm_client_seam.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/llm/openai.py loomex-core/src/loomex_core/providers/llm/anthropic.py loomex-core/tests/unit/test_llm_client_seam.py
git commit -m "refactor(llm): extract _make_client seam on both adapters (no behavior change)"
```

---

### Task 16: SSL deps + config fields + port `ssl_verify` module

**Files:**
- Modify: `pyproject.toml` (root — add deps)
- Modify: `src/loomex_host/config.py` (4 settings)
- Create: `src/loomex_host/ssl_verify.py` (ported)
- Test: `tests/test_ssl_verify.py` (new)

- [ ] **Step 1: Add deps**

In root `pyproject.toml` `dependencies`, append:

```toml
    "pyopenssl>=24.0",
    "cryptography>=42.0",
```

Install: `pip install -e .` (or `uv sync`).

- [ ] **Step 2: Add config fields**

In `src/loomex_host/config.py`, add (match the file's existing `Settings` field/prefix style):

```python
    http_ssl_verify: bool = False
    http_ca_bundle: str = ""
    http_check_hostname: bool = True
    use_system_truststore: bool = False
```

- [ ] **Step 3: Write the failing test**

```python
# tests/test_ssl_verify.py
from loomex_host.ssl_verify import make_ssl_verify
from loomex_host.config import Settings


def test_verify_false_disables_when_flag_off():
    s = Settings(http_ssl_verify=False)
    # http_ssl_verify=False → verification disabled (returns False / falsy ssl arg)
    assert make_ssl_verify(s) is False


def test_verify_returns_context_or_bundle_when_enabled():
    s = Settings(http_ssl_verify=True)
    out = make_ssl_verify(s)
    # When enabled: an ssl.SSLContext, a bundle path str, or True — never False.
    assert out is not False
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_ssl_verify.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'loomex_host.ssl_verify'`.

- [ ] **Step 5: Port the module**

Copy the fork's `app/common/ssl_verify.py` to `src/loomex_host/ssl_verify.py` **verbatim**, then apply this adaptation checklist (the only allowed edits):

1. **Signature:** make the public entry points take an explicit `settings` object instead of importing the fork's global settings: `make_ssl_verify(settings) -> bool | ssl.SSLContext | str` and `with_ssl_retry(do_request, url, settings)`. Replace every `settings.http_*` / `settings.use_system_truststore` access with attributes on the passed-in `loomex_host.config.Settings`.
2. **Tier 1:** `if not settings.http_ssl_verify: return False`.
3. **Tier 2:** `settings.http_ca_bundle` (`;`-separated file paths or downloadable URLs; URL downloads cache under the host data dir — use `loomex_host.paths` for the cache dir instead of the fork's AppData path).
4. **Tier 3:** default context + OS/registry/env-var CA bundles + AppData-cached CAs; honor `settings.http_check_hostname` and `settings.use_system_truststore`.
5. **Logging:** swap the fork's logger import for `logging.getLogger(__name__)`.
6. Keep the `@lru_cache` on `make_ssl_verify` **only if** the settings object is hashable; otherwise drop the cache (the host builds adapters rarely) — verify during port.
7. Run the fork's own ssl tests if portable; otherwise rely on `tests/test_ssl_verify.py` + manual internal-network smoke test.

If the fork source is unavailable, STOP and escalate — do not fabricate a crypto verification path.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_ssl_verify.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml src/loomex_host/config.py src/loomex_host/ssl_verify.py tests/test_ssl_verify.py
git commit -m "feat(host): port corporate-CA ssl_verify + config + deps"
```

---

### Task 17: Host adapters inject `verify` via `_make_client`; provider passes `ssl_verify`

**Files:**
- Modify: `src/loomex_host/providers/llm/adapters.py` (override `_make_client` on both; accept `ssl_verify`)
- Modify: `src/loomex_host/providers/llm/llm_provider.py` (pass `ssl_verify` into adapters)
- Modify: `src/loomex_host/api/startup.py:40` + `src/loomex_host/cli.py:42` (inject `ssl_verify=make_ssl_verify(get_settings())`)
- Test: `tests/test_host_llm_ssl_injection.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_host_llm_ssl_injection.py
from loomex_host.providers.llm.adapters import HostOpenAIAdapter, HostAnthropicAdapter


def test_openai_adapter_passes_ssl_verify_to_client():
    sentinel = "/etc/ssl/custom-bundle.pem"
    a = HostOpenAIAdapter(api_key="k", base_url="https://x/v1", ssl_verify=sentinel)
    # the live client must have been built with our verify value
    assert a._ssl_verify == sentinel


def test_anthropic_adapter_accepts_ssl_verify():
    a = HostAnthropicAdapter(api_key="k", ssl_verify=False)
    assert a._ssl_verify is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_llm_ssl_injection.py -v`
Expected: FAIL — adapters don't accept `ssl_verify`.

- [ ] **Step 3: Write minimal implementation**

In `src/loomex_host/providers/llm/adapters.py`, replace the two adapter classes with versions that accept and apply `ssl_verify`. Because the core `__init__` calls `self._make_client()` during construction, set `self._ssl_verify` **before** `super().__init__`:

```python
import httpx
from loomex_core.providers.llm.anthropic import AnthropicAdapter


class HostOpenAIAdapter(OpenAIAdapter):
    def __init__(self, *args, ssl_verify=None, **kwargs):
        self._ssl_verify = ssl_verify
        super().__init__(*args, **kwargs)

    def _chat_url(self) -> str:
        return _resolve_chat_url(self._base_url)

    def _make_client(self) -> httpx.AsyncClient:
        verify = self._ssl_verify if self._ssl_verify is not None else True
        return httpx.AsyncClient(timeout=self._timeout, verify=verify)


class HostAnthropicAdapter(AnthropicAdapter):
    def __init__(self, *args, ssl_verify=None, **kwargs):
        self._ssl_verify = ssl_verify
        super().__init__(*args, **kwargs)

    def _make_client(self) -> httpx.AsyncClient:
        verify = self._ssl_verify if self._ssl_verify is not None else True
        return httpx.AsyncClient(timeout=self._timeout, verify=verify)
```

In `src/loomex_host/providers/llm/llm_provider.py` `_build_adapter`, pass `ssl_verify=self._ssl_verify` into **both** `HostOpenAIAdapter(...)` and `HostAnthropicAdapter(...)` constructor calls.

In `src/loomex_host/api/startup.py:40` and `src/loomex_host/cli.py:42`, change:

```python
    provider = LLMProvider(LLMAccountStore(), max_http_retries=get_settings().llm_max_http_retries)
```

to:

```python
    from loomex_host.ssl_verify import make_ssl_verify
    settings = get_settings()
    provider = LLMProvider(
        LLMAccountStore(),
        max_http_retries=settings.llm_max_http_retries,
        ssl_verify=make_ssl_verify(settings),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest tests/test_host_llm_ssl_injection.py tests/test_host_llm_provider_build.py -v`
Expected: PASS

- [ ] **Step 5: Full suites + commit**

Run:
```bash
cd loomex-core && python -m pytest -q
cd C:/Users/Xing/Documents/codes/LoomeX-00 && python -m pytest -q
```
Expected: green (note any pre-existing unrelated failures).

```bash
git add src/loomex_host/providers/llm/adapters.py src/loomex_host/providers/llm/llm_provider.py src/loomex_host/api/startup.py src/loomex_host/cli.py tests/test_host_llm_ssl_injection.py
git commit -m "feat(host): inject corporate-CA verify into LLM adapters via _make_client"
```

**✅ Phase 7 (static verify) complete.**

### Task 18 (OPTIONAL) — MCP/skill SSL reuse

`make_ssl_verify` also belongs on the MCP HTTP client (`loomex-core/.../capability_mcp/provider.py`) and the remote skill store client. Same pattern: add a `_make_client`/`verify=` seam in core, override/inject from host. Plan separately if internal MCP/remote-skill over HTTPS is needed.

### Task 19 (OPTIONAL) — passive AIA retry (`with_ssl_retry`)

Wrap the adapter request in `with_ssl_retry(do_request, url, settings)` so a handshake failure triggers AIA CA-Issuers fetch + cache-on-success retry. Requires a request-wrapping seam around `self._client.stream(...)` in `_stream`. Higher effort; do only if static bundle loading proves insufficient on the target network.

---

## Self-Review

**Spec coverage:**
- Encoding UTF-8→GBK→replace, all OSes → Task 1 (`decode_console`, no OS gate), wired in Tasks 2 (skill) & 3 (bash). ✓
- `PYTHONIOENCODING=utf-8` both paths → Tasks 2 & 3 (and preserved in Tasks 8/9). ✓
- Path double-escape / PowerShell 5.1 OutputEncoding guidance → Task 3 description. ✓
- `repr` diagnostic log → Task 3 (and Task 9 keeps it). ✓
- Unified `script_runner` covering skill + bash → Tasks 4-7 (module), 8 (skill), 9 (bash). ✓
- Liveness (stdout/CPU/IO OR), idle + hard-cap → Tasks 4-5, 7. ✓
- Reliable tree kill (process group / Job Object) + kill-then-verify honest survivors → Task 6, surfaced in Tasks 8/9. ✓
- Host-injected config for the new timeouts → Task 10. ✓
- Progress SSE → Phase 4 (optional, flagged). ✓
- Force `exec_skill_script`, note at end of skill instruction block → Task 11 (`wrap_skill_instructions` in `prepare.py`, appended after `defn.instructions`). ✓
- OpenAI chat-endpoint inference via host subclass → Tasks 12 (core `_chat_url` seam) + 13 (`HostOpenAIAdapter` + `_resolve_chat_url`) + 14 (host `LLMProvider` builds host adapters). Error-body tolerant parsing already satisfied (LoomeX embeds raw error text, never structurally parses) — noted, no task. ✓
- Corporate-CA SSL via host subclass → Tasks 15 (core `_make_client` seam) + 16 (deps + config + `ssl_verify` port) + 17 (host adapters inject `verify`, call-site wiring). MCP/skill reuse + AIA passive retry → Tasks 18/19 (optional). ✓

**Type consistency:** `LivenessSample(output_bytes, cpu_seconds, io_bytes)`, `RunResult(stdout, stderr, exit_code, timed_out, timeout_kind, terminated_clean, survivors)`, `TerminationResult(clean, survivors)`, `LivenessProgress(elapsed_sec, output_bytes, idle_remaining_sec, hard_cap_remaining_sec, cpu_seconds)`, `run_with_liveness(command, *, cwd, env, idle_timeout_sec, hard_cap_sec, output_limit_bytes, poll_interval_sec, on_output, on_progress)`, `spawn_contained(command, *, cwd, env) -> (proc, handle)`, `terminate_tree(proc, handle) -> TerminationResult`, `collect_tree_metrics(pid, *, output_bytes) -> LivenessSample | None`, `decode_console(bytes) -> str`. Used consistently across Tasks 4-9. ✓

**Type consistency (Phases 5–7):** `wrap_skill_instructions(str) -> str`; `OpenAIAdapter._chat_url() -> str` (core) overridden by `HostOpenAIAdapter._chat_url`; `_resolve_chat_url(str) -> str`; `_make_client() -> httpx.AsyncClient` (both core adapters) overridden by both host adapters; `make_ssl_verify(settings) -> bool | ssl.SSLContext | str`; host `LLMProvider.__init__(store, *, max_http_retries, ssl_verify)`; host adapters `__init__(*args, ssl_verify=None, **kwargs)`. Used consistently across Tasks 11–17. ✓

**Open items to confirm during execution (not blockers):**
1. The exact `Settings` env-var prefix in `src/loomex_host/config.py` (Task 10 test assumes `LOOMEX_` — match the real one).
2. `ProviderContext` constructor signature for `extra=` in tests (Task 9) — confirm `ProviderContext(session_id=..., extra={...})` is valid; adjust if `extra` is a different field.
3. Where the filesystem provider currently injects `bash_timeout_sec` into `ctx.extra` (Task 10) — mirror that exact call site for the two new keys.
4. Windows Job Object struct layout (Task 6) — verify against headers on a Windows run before relying on it; psutil tree-kill is the cross-platform fallback if the job assignment fails.
5. **Fork `app/common/ssl_verify.py` source availability (Task 16)** — hard prerequisite for Phase 7; if missing, escalate (multi-day reimplementation) rather than fabricate.
6. `Settings(...)` accepts keyword overrides in tests (Tasks 16) — if it's a pydantic `BaseSettings`, `Settings(http_ssl_verify=True)` works; confirm.
7. `register_account` builds the adapter eagerly via `_build_adapter` (Task 14 relies on this) — confirmed at `provider.py:116`.
```
