# Host 集中配置 + 向 core 注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** host 侧新增统一配置模块集中读取所有 `.env`/env 配置；除 LLM 凭证/模型外，所有配置由 host 读取并在实例化时注入 loomex-core（core 不再自读 env）；`context_limit` 改为会话创建必传、由 host 据所选模型构建。

**Architecture:** `.env`/env → `loomex_host.config.Settings`（单例读一次）→ host 直接用 `settings.*` / 构造 `RuntimeConfig` 注入 `LoomeXRuntime` / 给 capability provider 与 `LLMProvider` 传构造参数。core 的 env 读取点全部删除，改为构造参数（默认值=现状，保证测试零改动，唯一例外 `context_limit` 必传）。

**Tech Stack:** Python 3.11（stdlib `dataclasses`、`os.environ`，不引新依赖）、pytest、`python-dotenv`（已在用）。

**运行测试：**
- core：`cd loomex-core && python -m pytest <path> -v`
- host：`python -m pytest <path> -v`（仓库根目录）

---

## 配置键总表（实现时以此为准）

**host-only**（`Settings` 直接被 host 读）
| 字段 | env key | 默认 |
|---|---|---|
| resources_dir | LoomeX_RESOURCES_DIR | `<project>/resources` |
| skills_dir | LoomeX_SKILLS_DIR | `<resources>/skills` |
| agents_dir | LoomeX_AGENTS_DIR | `<resources>/agents` |
| data_dir | LoomeX_DATA_DIR | None |
| watch_interval | LoomeX_WATCH_INTERVAL | 5.0 |
| log_level | LoomeX_LOG_LEVEL | None |
| log_format | LoomeX_LOG_FORMAT | "text" |
| log_file | LoomeX_LOG_FILE | None |
| core_log_level | LoomeX_CORE_LOG_LEVEL | None |
| snapshot_every_n | LoomeX_SNAPSHOT_EVERY_N_EVENTS | 50 |
| snapshot_keep | LoomeX_SNAPSHOT_KEEP | 3 |
| database_url | DATABASE_URL | "sqlite" |

**注入 core — RuntimeConfig**
| 字段 | env key | 默认 |
|---|---|---|
| hitl_timeout_sec | LoomeX_HITL_TIMEOUT_SEC | None |
| hitl_max_resolved | LoomeX_HITL_MAX_RESOLVED | 1000 |
| task_max_concurrent | LoomeX_TASK_MAX_CONCURRENT | 4 |
| task_max_retries | LoomeX_TASK_MAX_RETRIES | 3 |
| default_token_budget | LoomeX_DEFAULT_TOKEN_BUDGET | 200000 |
| default_task_timeout_ms | LoomeX_DEFAULT_TASK_TIMEOUT_MS | 60000 |

**注入 core — provider 构造参数**
| 字段 | env key | 默认 |
|---|---|---|
| fs_bash_timeout_sec | LoomeX_FS_BASH_TIMEOUT_SEC | 30 |
| fs_bash_max_output_bytes | LoomeX_FS_BASH_MAX_OUTPUT_BYTES | 50000 |
| fs_file_max_read_bytes | LoomeX_FS_FILE_MAX_READ_BYTES | 500000 |
| fs_glob_max_results | LoomeX_FS_GLOB_MAX_RESULTS | 500 |
| http_timeout_sec | LoomeX_HTTP_TIMEOUT_SEC | 30 |
| http_max_response_bytes | LoomeX_HTTP_MAX_RESPONSE_BYTES | 1000000 |
| mcp_max_reconnect_attempts | LoomeX_MCP_MAX_RECONNECT_ATTEMPTS | 3 |
| mcp_reconnect_base_delay_sec | LoomeX_MCP_RECONNECT_BASE_DELAY_SEC | 1.0 |
| skill_script_timeout_sec | LoomeX_SKILL_SCRIPT_TIMEOUT_SEC | 60 |
| skill_output_limit_chars | LoomeX_SKILL_OUTPUT_LIMIT_CHARS | 65536 |
| llm_max_http_retries | LoomeX_LLM_MAX_HTTP_RETRIES | 3 |

**不动**：`LoomeX_LLM_*`（account/style/api_key/model/base_url/context_limit/max_output_tokens/timeout_sec）由 core `bootstrap_from_env` 读。CLI `--host/--port/--no-tools/--skills-dir/--agents-dir/--db-url` 仍覆盖 env。

---

## File Structure

- **新建** `loomex-core/src/loomex_core/core/config.py` — `RuntimeConfig` dataclass。
- **新建** `src/loomex_host/config.py` — `Settings` dataclass + `get_settings()`。
- **新建** `loomex-core/tests/unit/test_runtime_config.py`、`tests/test_host_config.py`。
- **改 core**：`core/orchestrator/task_manager.py`、`core/runtime.py`、`core/orchestrator/session_manager.py`、`providers/capability_filesystem/provider.py`、`providers/capability_builtin/provider.py`、`providers/capability_mcp/provider.py`、`providers/capability_skill_local/provider.py`、`providers/llm/provider.py`、`providers/llm/anthropic.py`、`providers/llm/openai.py`、`core/state/models.py`、`core/control/types.py`、`core/control/reducers.py`、`core/control/converters.py`。
- **改 host**：`cli.py`、`api/startup.py`、`observability/logging.py`、`persistence/postgres/__init__.py`、`providers/llm/account_store.py`、`providers/capability/mcp/store.py`、`api/sessions.py`。

---

## Phase 0 — core `RuntimeConfig` + 停止读 HITL/TASK env

### Task 0.1: 新建 `RuntimeConfig`

**Files:**
- Create: `loomex-core/src/loomex_core/core/config.py`
- Test: `loomex-core/tests/unit/test_runtime_config.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_runtime_config.py
from loomex_core.core.config import RuntimeConfig


def test_defaults_match_legacy():
    c = RuntimeConfig()
    assert c.hitl_timeout_sec is None
    assert c.hitl_max_resolved == 1000
    assert c.task_max_concurrent == 4
    assert c.task_max_retries == 3
    assert c.default_token_budget == 200_000
    assert c.default_task_timeout_ms == 60_000


def test_overrides():
    c = RuntimeConfig(task_max_concurrent=8, hitl_timeout_sec=30)
    assert c.task_max_concurrent == 8
    assert c.hitl_timeout_sec == 30
```

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_runtime_config.py -v`
Expected: FAIL（`ModuleNotFoundError: loomex_core.core.config`）

- [ ] **Step 3: 实现**

```python
# loomex-core/src/loomex_core/core/config.py
"""RuntimeConfig — core 运行期可调旋钮，由 host 在实例化时注入。

默认值 = 历史行为，使直连 core / 测试零改动。host 始终注入实际值。
core 不再自读 os.environ（LLM 凭证/模型经 bootstrap_from_env 除外）。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeConfig:
    hitl_timeout_sec: int | None = None
    hitl_max_resolved: int = 1000
    task_max_concurrent: int = 4
    task_max_retries: int = 3
    default_token_budget: int = 200_000
    default_task_timeout_ms: int = 60_000
```

- [ ] **Step 4: 运行确认通过**

Run: `cd loomex-core && python -m pytest tests/unit/test_runtime_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/core/config.py loomex-core/tests/unit/test_runtime_config.py
git commit -m "feat(core): add RuntimeConfig dataclass for injected runtime knobs"
```

### Task 0.2: `task_manager.py` 去 env，改裸默认

**Files:**
- Modify: `loomex-core/src/loomex_core/core/orchestrator/task_manager.py:33-40`

- [ ] **Step 1: 改实现（删 `_env_int` 与 env 读取）**

把 33-40 行：
```python
def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except (ValueError, TypeError):
        return default

_DEFAULT_MAX_RETRIES    = _env_int("LoomeX_TASK_MAX_RETRIES",    3)
_DEFAULT_MAX_CONCURRENT = _env_int("LoomeX_TASK_MAX_CONCURRENT", 4)
```
替换为：
```python
# 默认值；实际值由 host 经 RuntimeConfig → TaskManager 构造参数注入。
_DEFAULT_MAX_RETRIES    = 3
_DEFAULT_MAX_CONCURRENT = 4
```
若 `import os` 在本文件已无其他使用，删除该 import（先 `grep -n "os\." task_manager.py` 确认）。

- [ ] **Step 2: 运行现有 task 测试**

Run: `cd loomex-core && python -m pytest tests/unit/test_task_scheduling.py -v`
Expected: PASS（构造参数默认仍为 3/4，行为不变）

- [ ] **Step 3: Commit**

```bash
git add loomex-core/src/loomex_core/core/orchestrator/task_manager.py
git commit -m "refactor(core): TaskManager defaults no longer read env (injected via ctor)"
```

### Task 0.3: `LoomeXRuntime` 接 `RuntimeConfig`，注入 HitlManager + TaskManager + SessionManager

**Files:**
- Modify: `loomex-core/src/loomex_core/core/runtime.py:364-388`（删两个 `_hitl_*_from_env`）
- Modify: `loomex-core/src/loomex_core/core/runtime.py:400-422`（`__init__` 接 config）
- Modify: `loomex-core/src/loomex_core/core/runtime.py:517`、`:846`（TaskManager 传参）
- Modify: `loomex-core/src/loomex_core/core/runtime.py:556`（SessionManager 传参）
- Modify: `loomex-core/src/loomex_core/core/orchestrator/session_manager.py:21-26,141`
- Test: `loomex-core/tests/unit/test_runtime_config_injection.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_runtime_config_injection.py
from loomex_core.core.config import RuntimeConfig
from loomex_core.core.runtime import LoomeXRuntime


class _StubResolver:
    async def get(self, *a, **k): ...


def test_runtime_injects_hitl_knobs():
    cfg = RuntimeConfig(hitl_timeout_sec=42, hitl_max_resolved=7)
    rt = LoomeXRuntime(template_resolver=_StubResolver(), config=cfg)
    assert rt.hitl_manager._timeout_sec == 42
    assert rt.hitl_manager._max_resolved == 7


def test_runtime_default_config():
    rt = LoomeXRuntime(template_resolver=_StubResolver())
    assert rt._config.task_max_concurrent == 4
```

> 注：断言用的 `hitl_manager._timeout_sec` / `_max_resolved` 字段名先 `grep -n "timeout_sec\|max_resolved" loomex-core/src/loomex_core/core/orchestrator/hitl_manager.py` 核对，按实际私有字段名改。

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_runtime_config_injection.py -v`
Expected: FAIL（`__init__` 不接 `config`）

- [ ] **Step 3: 删 `_hitl_*_from_env`（runtime.py:364-388）**

删除整段 `def _hitl_timeout_from_env()` 与 `def _hitl_max_resolved_from_env()`。若 `import os` 在 runtime.py 已无其他使用则删除。

- [ ] **Step 4: 改 `LoomeXRuntime.__init__`（runtime.py:400 起）**

签名加 `config`：
```python
    def __init__(
        self,
        template_resolver: TemplateResolver,
        providers: ProviderRegistry | None = None,
        llm: LLMClient | None = None,
        hitl_manager: HitlManager | None = None,
        event_store: "Any | None" = None,
        config: "RuntimeConfig | None" = None,
    ) -> None:
        from loomex_core.core.config import RuntimeConfig
        self._config = config or RuntimeConfig()
        self._llm = llm
        self._template_resolver = template_resolver
        self.providers = providers or ProviderRegistry()
        self._event_bus = InProcessEventBus()
        self.hitl_manager: HitlManager = hitl_manager or HitlManager(
            timeout_sec=self._config.hitl_timeout_sec,
            event_bus=self._event_bus,
            max_resolved=self._config.hitl_max_resolved,
        )
```
（其余 `__init__` 主体不变。）

- [ ] **Step 5: TaskManager 两处传参（runtime.py:517、:846）**

两处 `TaskManager(session_id=..., event_bus=self._event_bus)` 改为：
```python
        task_manager = TaskManager(
            session_id=sid,  # :846 处为 session.id
            event_bus=self._event_bus,
            max_concurrent=self._config.task_max_concurrent,
            task_max_retries=self._config.task_max_retries,
        )
```

- [ ] **Step 6: SessionManager 传参（runtime.py:556）**

```python
        sm = SessionManager(
            lifecycle_manager=lm,
            event_bus=self._event_bus,
            task_max_concurrent=self._config.task_max_concurrent,
            task_max_retries=self._config.task_max_retries,
            default_task_timeout_ms=self._config.default_task_timeout_ms,
        )
```

- [ ] **Step 7: SessionManager 加字段并用于 TaskManager（session_manager.py:21-26,138-141）**

dataclass 字段：
```python
@dataclass
class SessionManager:
    lifecycle_manager: LifecycleManager
    event_bus: EventBus
    task_max_concurrent: int = 4
    task_max_retries: int = 3
    default_task_timeout_ms: int = 60_000
```
`_make_root_task_manager` 内（141 行）：
```python
        task_manager = TaskManager(
            session_id=session.id,
            event_bus=self.event_bus,
            max_concurrent=self.task_max_concurrent,
            task_max_retries=self.task_max_retries,
        )
```
并把 138 行 `settings=settings or NormalTaskSettings()` 改为：
```python
            settings=settings or NormalTaskSettings(timeout_ms=self.default_task_timeout_ms),
```

- [ ] **Step 8: 运行测试**

Run: `cd loomex-core && python -m pytest tests/unit/test_runtime_config_injection.py tests/unit/test_task_scheduling.py -v`
Expected: PASS

- [ ] **Step 9: 全 core 回归**

Run: `cd loomex-core && python -m pytest -q`
Expected: PASS（行为默认值不变）

- [ ] **Step 10: Commit**

```bash
git add loomex-core/src/loomex_core/core/runtime.py loomex-core/src/loomex_core/core/orchestrator/session_manager.py loomex-core/tests/unit/test_runtime_config_injection.py
git commit -m "refactor(core): inject hitl/task knobs via RuntimeConfig, drop env reads"
```

---

## Phase 1 — capability provider 构造参数

### Task 1.1: Filesystem provider — 常量入 `FilesystemConfig`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_filesystem/provider.py:49-52`（常量）、`:292`（`FilesystemConfig`）、`:141,147,159,204,212,270,279`（用点）
- Test: `loomex-core/tests/unit/test_fs_config.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_fs_config.py
from loomex_core.providers.capability_filesystem.provider import (
    FilesystemConfig, FilesystemToolsProvider,
)


def test_fs_config_defaults():
    c = FilesystemConfig()
    assert c.bash_timeout_sec == 30
    assert c.bash_max_output_bytes == 50_000
    assert c.file_max_read_bytes == 500_000
    assert c.glob_max_results == 500


def test_fs_provider_holds_config():
    p = FilesystemToolsProvider(FilesystemConfig(glob_max_results=5))
    assert p._cfg.glob_max_results == 5
```

> 先 `grep -n "self._cfg\|self\._config\|_cfg =" provider.py` 确认 provider 内持有 config 的字段名（下文按 `self._cfg`，若实际不同则统一替换）。

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_fs_config.py -v`
Expected: FAIL（`FilesystemConfig` 无这些字段）

- [ ] **Step 3: 给 `FilesystemConfig`（:292）加字段**

```python
@dataclass
class FilesystemConfig:
    # ...existing fields (allowed_dirs 等保持原样)...
    bash_timeout_sec: int = 30
    bash_max_output_bytes: int = 50_000
    file_max_read_bytes: int = 500_000
    glob_max_results: int = 500
```

- [ ] **Step 4: 方法体改读 `self._cfg.*`**

逐处替换（确保 provider 方法内 `self._cfg` 可达；构造器为 `self._cfg = config or FilesystemConfig()`，若字段名不同则改）：
- `:141` `limit=_BASH_MAX_OUTPUT_BYTES` → `limit=self._cfg.bash_max_output_bytes`
- `:147` `asyncio.timeout(_BASH_TIMEOUT_SEC)` → `asyncio.timeout(self._cfg.bash_timeout_sec)`
- `:159` 文案 `f"...after {_BASH_TIMEOUT_SEC}s"` → `f"...after {self._cfg.bash_timeout_sec}s"`
- `:204` `[:_FILE_MAX_READ_BYTES]` → `[:self._cfg.file_max_read_bytes]`
- `:212` `len(content) == _FILE_MAX_READ_BYTES` → `== self._cfg.file_max_read_bytes`
- `:270` `[:_GLOB_MAX_RESULTS]` → `[:self._cfg.glob_max_results]`
- `:279` `len(matches) == _GLOB_MAX_RESULTS` → `== self._cfg.glob_max_results`

删除 `:49-52` 的四个模块常量（已无引用；用 `grep -n "_BASH_TIMEOUT_SEC\|_BASH_MAX_OUTPUT_BYTES\|_FILE_MAX_READ_BYTES\|_GLOB_MAX_RESULTS" provider.py` 复核为零）。

- [ ] **Step 5: 运行测试 + fs 回归**

Run: `cd loomex-core && python -m pytest tests/unit/test_fs_config.py -k "fs or filesystem or bash or glob" -v` 然后 `python -m pytest tests/ -k filesystem -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add loomex-core/src/loomex_core/providers/capability_filesystem/provider.py loomex-core/tests/unit/test_fs_config.py
git commit -m "refactor(core/fs): bash/file/glob limits via FilesystemConfig"
```

### Task 1.2: Builtin provider — http 常量入 `BuiltinToolsConfig`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_builtin/provider.py:44-45`（常量）、`:139-141`（config）、http_request 实现 + `_build_invokers`
- Test: `loomex-core/tests/unit/test_builtin_config.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_builtin_config.py
from loomex_core.providers.capability_builtin.provider import (
    BuiltinToolsConfig, BuiltinToolsCapabilityProvider,
)


def test_builtin_config_defaults():
    c = BuiltinToolsConfig()
    assert c.http_timeout_sec == 30
    assert c.http_max_response_bytes == 1_000_000


def test_builtin_provider_holds_config():
    p = BuiltinToolsCapabilityProvider(BuiltinToolsConfig(http_timeout_sec=5))
    assert p._cfg.http_timeout_sec == 5
```

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_builtin_config.py -v`
Expected: FAIL

- [ ] **Step 3: `BuiltinToolsConfig` 加字段（:139）**

```python
@dataclass
class BuiltinToolsConfig:
    """Provider 运行时配置。权限控制由 auth 层负责，不在此处理。"""
    allowed_dirs: list[Path] = field(default_factory=list)
    http_timeout_sec: int = 30
    http_max_response_bytes: int = 1_000_000
```

- [ ] **Step 4: http_request 实现改用注入值**

`http_request` 当前为模块级函数读 `_HTTP_TIMEOUT_SEC`/`_HTTP_MAX_RESPONSE_BYTES`。改为把 config 绑进 invoker：在 `_build_invokers` 内对 http_request 注入 `self._cfg`。最小改法——给 `http_request` 实现增 `*, http_timeout_sec`、`http_max_response_bytes` 关键字参数（默认仍 30 / 1_000_000），并在 `_build_invokers` 里对该工具用 `functools.partial`/闭包注入 `self._cfg.http_timeout_sec`、`self._cfg.http_max_response_bytes`。

实现指引（按文件实际 `_BUILTIN_IMPLS`/`_build_invokers` 结构落地）：
```python
def _build_invokers(self) -> dict[str, Callable]:
    cfg = self._cfg
    def _bind(name, fn):
        if name == "http_request":
            return lambda args, ctx: fn(
                **args, ctx=ctx,
                http_timeout_sec=cfg.http_timeout_sec,
                http_max_response_bytes=cfg.http_max_response_bytes,
            )
        return lambda args, ctx: fn(**args, ctx=ctx)
    return {name: _bind(name, fn) for name, fn in _BUILTIN_IMPLS.items()}
```
`http_request(...)` 签名相应加 `*, http_timeout_sec: int = 30, http_max_response_bytes: int = 1_000_000` 并在体内改用之；删模块常量 `:44-45`（复核无引用）。

- [ ] **Step 5: 运行测试 + builtin 回归**

Run: `cd loomex-core && python -m pytest tests/unit/test_builtin_config.py -v` 然后 `python -m pytest tests/ -k "builtin or http" -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add loomex-core/src/loomex_core/providers/capability_builtin/provider.py loomex-core/tests/unit/test_builtin_config.py
git commit -m "refactor(core/builtin): http timeout/size via BuiltinToolsConfig"
```

### Task 1.3: MCP provider — reconnect 常量入构造参数

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_mcp/provider.py:25-26,48,78-92`
- Test: `loomex-core/tests/unit/test_mcp_reconnect_config.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_mcp_reconnect_config.py
from loomex_core.providers.capability_mcp.provider import MCPCapabilityProvider, MCPServerConfig


def test_mcp_reconnect_params_default_and_override():
    cfg = MCPServerConfig(name="x", ...)  # 按 MCPServerConfig 必填字段补全（grep 其定义）
    p = MCPCapabilityProvider(cfg)
    assert p._max_reconnect_attempts == 3
    assert p._reconnect_base_delay_sec == 1.0
    p2 = MCPCapabilityProvider(cfg, max_reconnect_attempts=5, reconnect_base_delay_sec=0.5)
    assert p2._max_reconnect_attempts == 5
    assert p2._reconnect_base_delay_sec == 0.5
```

> 先 `sed -n '/class MCPServerConfig/,/^class /p' provider.py` 取 `MCPServerConfig` 必填字段补全测试构造。

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_mcp_reconnect_config.py -v`
Expected: FAIL

- [ ] **Step 3: 改 `__init__`（:48）与重连循环（:78-92）**

```python
    def __init__(
        self,
        config: MCPServerConfig,
        *,
        max_reconnect_attempts: int = 3,
        reconnect_base_delay_sec: float = 1.0,
    ) -> None:
        self._cfg = config
        self._max_reconnect_attempts = max_reconnect_attempts
        self._reconnect_base_delay_sec = reconnect_base_delay_sec
        # ...existing init body...
```
循环内 `_MAX_RECONNECT_ATTEMPTS` → `self._max_reconnect_attempts`，`_RECONNECT_BASE_DELAY_SEC` → `self._reconnect_base_delay_sec`（:78,84,85,88,92）。删模块常量 `:25-26`（复核无引用）。

- [ ] **Step 4: 运行测试 + mcp 回归**

Run: `cd loomex-core && python -m pytest tests/unit/test_mcp_reconnect_config.py -v` 然后 `python -m pytest tests/ -k mcp -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/capability_mcp/provider.py loomex-core/tests/unit/test_mcp_reconnect_config.py
git commit -m "refactor(core/mcp): reconnect attempts/delay via ctor params"
```

### Task 1.4: 本地技能 provider — 脚本超时/输出上限入构造参数

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/capability_skill_local/provider.py:37-38`（常量）、`__init__`、`:195` 附近脚本执行处
- Test: `loomex-core/tests/unit/test_skill_local_config.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_skill_local_config.py
from pathlib import Path
from loomex_core.providers.capability_skill_local.provider import LocalSkillCapabilityProvider


def test_skill_exec_params(tmp_path: Path):
    p = LocalSkillCapabilityProvider(tmp_path)
    assert p._script_timeout_sec == 60
    assert p._output_limit_chars == 65536
    p2 = LocalSkillCapabilityProvider(tmp_path, script_timeout_sec=10, output_limit_chars=100)
    assert p2._script_timeout_sec == 10
    assert p2._output_limit_chars == 100
```

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_local_config.py -v`
Expected: FAIL

- [ ] **Step 3: 改 `__init__` 与脚本执行处**

```python
    def __init__(
        self,
        skills_dir: Path,
        *,
        script_timeout_sec: int = 60,
        output_limit_chars: int = 65536,
    ) -> None:
        self._dir = skills_dir
        self._index = None
        self._script_timeout_sec = script_timeout_sec
        self._output_limit_chars = output_limit_chars
```
脚本执行处 `_SCRIPT_TIMEOUT_SEC` → `self._script_timeout_sec`、`_OUTPUT_LIMIT_CHARS` → `self._output_limit_chars`（`grep -n "_SCRIPT_TIMEOUT_SEC\|_OUTPUT_LIMIT_CHARS" provider.py` 找全部点）。删模块常量 `:37-38`。

- [ ] **Step 4: 运行测试 + skill 回归**

Run: `cd loomex-core && python -m pytest tests/unit/test_skill_local_config.py -v` 然后 `python -m pytest tests/ -k skill -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/capability_skill_local/provider.py loomex-core/tests/unit/test_skill_local_config.py
git commit -m "refactor(core/skill): script timeout/output limit via ctor params"
```

---

## Phase 2 — LLM 适配器重试注入

### Task 2.1: 适配器接 `max_http_retries`

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/llm/anthropic.py:29,35-50,72,90,98,190,194`
- Modify: `loomex-core/src/loomex_core/providers/llm/openai.py:28,34-49,71,86,94,174,178`
- Test: `loomex-core/tests/unit/test_llm_retry_config.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_llm_retry_config.py
from loomex_core.providers.llm.anthropic import AnthropicAdapter
from loomex_core.providers.llm.openai import OpenAIAdapter


def test_adapters_hold_retry():
    a = AnthropicAdapter(api_key="x", max_http_retries=5)
    o = OpenAIAdapter(api_key="x", max_http_retries=7)
    assert a._max_http_retries == 5
    assert o._max_http_retries == 7


def test_adapters_retry_default():
    assert AnthropicAdapter(api_key="x")._max_http_retries == 3
    assert OpenAIAdapter(api_key="x")._max_http_retries == 3
```

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_llm_retry_config.py -v`
Expected: FAIL

- [ ] **Step 3: 改两个适配器**

各自 `__init__` 加 `max_http_retries: int = 3`，体内 `self._max_http_retries = max_http_retries`。重试循环里 `_MAX_HTTP_RETRIES` 全部改 `self._max_http_retries`（anthropic:72,90,98,190,194；openai:71,86,94,174,178）。模块常量 `_MAX_HTTP_RETRIES = 3` 可保留作文档/默认，但代码不再引用（亦可删，复核无引用后删）。

- [ ] **Step 4: 运行测试 + LLM 回归**

Run: `cd loomex-core && python -m pytest tests/unit/test_llm_retry_config.py tests/unit/test_llm_adapter_models.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/llm/anthropic.py loomex-core/src/loomex_core/providers/llm/openai.py loomex-core/tests/unit/test_llm_retry_config.py
git commit -m "refactor(core/llm): adapter max_http_retries via ctor param"
```

### Task 2.2: `LLMProvider` 透传 `max_http_retries` → 适配器

**Files:**
- Modify: `loomex-core/src/loomex_core/providers/llm/provider.py:100-103`（`__init__`）、`:290-305`（`_build_adapter`）
- Test: `loomex-core/tests/unit/test_llm_provider_retry.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_llm_provider_retry.py
from loomex_core.providers.llm.provider import LLMProvider
from loomex_core.providers.llm import LLMAccount, ModelConfig


class _MemStore:
    def save(self, *a, **k): ...
    def delete(self, *a, **k): ...
    def load_all(self): return []


def _acct(style):
    return LLMAccount(name="a", style=style, api_key="k",
                      models=[ModelConfig(name="m", context_limit=1000, max_output_tokens=100)],
                      default_model="m")


def test_provider_threads_retry_to_adapter():
    p = LLMProvider(_MemStore(), max_http_retries=9)
    p.register_account(_acct("anthropic"), persist=False)
    assert p._adapters["a"]._max_http_retries == 9
```

> `_MemStore` 按 `LLMAccountStoreProtocol` 实际方法名补全（`grep -n "class LLMAccountStoreProtocol" -A8 provider.py`）。

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_llm_provider_retry.py -v`
Expected: FAIL

- [ ] **Step 3: 改 `__init__` 与 `_build_adapter`**

```python
    def __init__(self, store: LLMAccountStoreProtocol, *, max_http_retries: int = 3) -> None:
        self._accounts = {}
        self._adapters = {}
        self._store = store
        self._max_http_retries = max_http_retries
```
`_build_adapter` 两个分支各加 `max_http_retries=self._max_http_retries`：
```python
            return AnthropicAdapter(
                api_key=account.api_key,
                base_url=account.base_url or "https://api.anthropic.com",
                timeout_sec=account.timeout_sec,
                max_http_retries=self._max_http_retries,
            )
            # OpenAIAdapter 同样加该参数
```

- [ ] **Step 4: 运行测试 + provider 回归**

Run: `cd loomex-core && python -m pytest tests/unit/test_llm_provider_retry.py tests/unit/test_llm_provider_models.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/providers/llm/provider.py loomex-core/tests/unit/test_llm_provider_retry.py
git commit -m "refactor(core/llm): LLMProvider threads max_http_retries to adapters"
```

---

## Phase 3 — `context_limit` 必传 + 修 assembler 一致性

> 模式：完全镜像 `token_budget` 在「SESSION_CREATED payload → SessionProjection → reducers → converters → Session」的链路（见 file 顶部表）。

### Task 3.1: `SessionProjection` 加 `context_limit`

**Files:**
- Modify: `loomex-core/src/loomex_core/core/control/types.py:26` 附近
- Test: `loomex-core/tests/unit/test_session_projection_context_limit.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_session_projection_context_limit.py
from loomex_core.core.control.types import SessionProjection  # 名称按文件实际


def test_projection_has_context_limit_default():
    p = SessionProjection()
    assert p.context_limit == 180_000
```

> `grep -n "class .*Projection" control/types.py` 确认承载 `token_budget` 的投影类名。

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_session_projection_context_limit.py -v`
Expected: FAIL

- [ ] **Step 3: 实现：在 `token_budget` 字段旁加**

```python
    token_budget: int = 200_000
    context_limit: int = 180_000
```

- [ ] **Step 4: 运行通过**

Run: `cd loomex-core && python -m pytest tests/unit/test_session_projection_context_limit.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/core/control/types.py loomex-core/tests/unit/test_session_projection_context_limit.py
git commit -m "feat(core): SessionProjection carries context_limit"
```

### Task 3.2: reducers / converters 镜像 `context_limit`

**Files:**
- Modify: `loomex-core/src/loomex_core/core/control/reducers.py:95,164,330`
- Modify: `loomex-core/src/loomex_core/core/control/converters.py:22`
- Test: `loomex-core/tests/unit/test_context_limit_chain.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_context_limit_chain.py
from loomex_core.core.control.converters import session_from_projection
from loomex_core.core.control.types import SessionProjection


def test_converter_carries_context_limit():
    proj = SessionProjection()
    proj.context_limit = 99_000
    s = session_from_projection(proj)
    assert s.context_limit == 99_000
```

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_context_limit_chain.py -v`
Expected: FAIL（converter 未带 context_limit）

- [ ] **Step 3: 实现**

- `converters.py:22` 在 `token_budget=proj.token_budget,` 旁加 `context_limit=proj.context_limit,`
- `reducers.py:95` 投影 dict 里 `"token_budget": s.token_budget,` 旁加 `"context_limit": s.context_limit,`
- `reducers.py:164` 与 `:330` 在 `token_budget=...get("token_budget", 200_000),` 旁加 `context_limit=p_or_s.get("context_limit", 180_000),`（按各处变量名 `s`/`p`）

- [ ] **Step 4: 运行通过 + reducer 回归**

Run: `cd loomex-core && python -m pytest tests/unit/test_context_limit_chain.py tests/ -k "reduc or project or convert" -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add loomex-core/src/loomex_core/core/control/reducers.py loomex-core/src/loomex_core/core/control/converters.py loomex-core/tests/unit/test_context_limit_chain.py
git commit -m "feat(core): thread context_limit through reducers/converters"
```

### Task 3.3: `SessionStartParams` + `create_session` 必传 context_limit；写入 Session；emit 进 payload

**Files:**
- Modify: `loomex-core/src/loomex_core/core/runtime.py:287-322`（`SessionStartParams` 字段 + `create`）
- Modify: `loomex-core/src/loomex_core/core/orchestrator/session_manager.py:28-...`（`create_session` 签名 + `Session(...)` + payload:68）
- Modify: `loomex-core/src/loomex_core/core/runtime.py:559-...`（`start_session` 传 `context_limit=params.context_limit`）
- Test: `loomex-core/tests/unit/test_session_start_params_context_limit.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_session_start_params_context_limit.py
import pytest
from loomex_core.core.runtime import SessionStartParams


def test_context_limit_required():
    with pytest.raises(TypeError):
        SessionStartParams.create(template_id="t", user_prompt="p")  # 缺 context_limit


def test_context_limit_passed():
    p = SessionStartParams.create(template_id="t", user_prompt="p", context_limit=123)
    assert p.context_limit == 123
```

- [ ] **Step 2: 运行确认失败**

Run: `cd loomex-core && python -m pytest tests/unit/test_session_start_params_context_limit.py -v`
Expected: FAIL

- [ ] **Step 3: `SessionStartParams` 加必填字段**

dataclass（287 起）在 `initial_task_settings: NormalTaskSettings` 之后、默认字段之前插入必填 `context_limit: int`：
```python
    template_id: str
    user_prompt: str
    initial_task_settings: NormalTaskSettings
    context_limit: int
    session_id: str | None = None
    ...
```
`create(...)`（297 起）加 `context_limit: int`（无默认，放 `*` 之后的关键字必填位）：
```python
    @classmethod
    def create(cls, template_id, user_prompt, *, context_limit: int,
               session_id=None, initial_task=None, tenant_id="default",
               llm_account=None, llm_model=None, token_budget=200_000, resume=False):
        ...
        return cls(..., context_limit=context_limit, ...)
```

- [ ] **Step 4: `create_session` 接收并写入 Session + payload**

`session_manager.create_session(...)` 签名加 `context_limit: int`（必填关键字）。`Session(...)` 构造里加 `context_limit=context_limit,`。SESSION_CREATED payload（:68 旁）加 `"context_limit": context_limit,`。

- [ ] **Step 5: `start_session` 传值（runtime.py:559）**

`sm.create_session(...)` 调用加 `context_limit=params.context_limit,`。

- [ ] **Step 6: 运行测试**

Run: `cd loomex-core && python -m pytest tests/unit/test_session_start_params_context_limit.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add loomex-core/src/loomex_core/core/runtime.py loomex-core/src/loomex_core/core/orchestrator/session_manager.py loomex-core/tests/unit/test_session_start_params_context_limit.py
git commit -m "feat(core): context_limit required on session creation, written to Session"
```

### Task 3.4: loop guard 与 assembler 用 Session.context_limit；run_single_task 据 llm 注入

**Files:**
- Modify: `loomex-core/src/loomex_core/core/runtime.py:492,694,719,733,748`（loop_guard 改用 session.context_limit）
- Modify: `loomex-core/src/loomex_core/core/runtime.py:~485-495`（run_single_task 据 resolved llm 设 session.context_limit）
- Test: `loomex-core/tests/unit/test_context_limit_effective.py`

- [ ] **Step 1: 写失败测试**

```python
# loomex-core/tests/unit/test_context_limit_effective.py
# 验证 assembler 用 session.context_limit（之前恒为 180_000 的 bug 修复）。
from loomex_core.core.state.models import Session


def test_session_context_limit_flows_to_assembler_budget():
    s = Session(id="s", user_prompt="p", status="RUNNING", context_limit=64_000)
    # assembler 读 request.session.context_limit
    assert s.context_limit == 64_000
```

> 该断言为契约性占位；若已有 assembler 单测，优先在其中加：构造 `AssemblerRequest(session=Session(context_limit=N))` 后断言 budget 用 N（`grep -rn "context_limit" loomex-core/tests/ | grep -i assembl`）。

- [ ] **Step 2: 运行确认（基线）**

Run: `cd loomex-core && python -m pytest tests/unit/test_context_limit_effective.py -v`
Expected: PASS（Session 字段已存在）—— 本任务重点是改下面的 loop_guard/run_single_task 不回归。

- [ ] **Step 3: loop_guard 改用 session.context_limit**

runtime.py:694,719,733,748 的 `LoopGuard(context_limit=llm_for_limit.context_limit)` → `LoopGuard(context_limit=session.context_limit)`（这些点 `session` 在作用域内；若变量名为别名则按实际）。这样持久化的 session.context_limit 成为 resume 后单一来源。

- [ ] **Step 4: run_single_task（:492）据 resolved llm 设 session.context_limit**

`run_single_task` 不走 SessionStartParams，需在构造 `session` 后、设置 loop_guard 前补：
```python
        llm = self._resolve_llm(llm_account, llm_model)
        session.context_limit = llm.context_limit
        agent = _dc.replace(agent, loop_guard=LoopGuard(context_limit=session.context_limit))
```
（即 :492 行从 `llm.context_limit` 改成先写回 `session.context_limit` 再用之。）

- [ ] **Step 5: 全 core 回归**

Run: `cd loomex-core && python -m pytest -q`
Expected: PASS（如有直接 `SessionStartParams.create(...)` / `create_session(...)` 不传 context_limit 的旧测试报错，按 Step 6 修）

- [ ] **Step 6: 修被 context_limit 必填波及的现有测试**

`grep -rn "SessionStartParams.create(\|create_session(" loomex-core/tests/ src/` 找到所有调用点，逐个补 `context_limit=<模型上限或显式值，如 200_000>`。重跑 `python -m pytest -q` 直至全绿。

- [ ] **Step 7: Commit**

```bash
git add loomex-core/src/loomex_core/core/runtime.py loomex-core/tests/
git commit -m "fix(core): assembler & loop guard use Session.context_limit (single source)"
```

---

## Phase 4 — host `Settings` 模块

### Task 4.1: 新建 `loomex_host.config.Settings`

**Files:**
- Create: `src/loomex_host/config.py`
- Test: `tests/test_host_config.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_host_config.py
import importlib
from loomex_host import config as cfgmod


def _fresh():
    importlib.reload(cfgmod)
    return cfgmod


def test_defaults(monkeypatch):
    for k in list(__import__("os").environ):
        if k.startswith("LoomeX_"):
            monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    s = _fresh().Settings.from_env()
    assert s.watch_interval == 5.0
    assert s.log_format == "text"
    assert s.snapshot_every_n == 50
    assert s.snapshot_keep == 3
    assert s.database_url == "sqlite"
    assert s.hitl_max_resolved == 1000
    assert s.task_max_concurrent == 4
    assert s.llm_max_http_retries == 3
    assert s.fs_glob_max_results == 500


def test_env_override(monkeypatch):
    monkeypatch.setenv("LoomeX_TASK_MAX_CONCURRENT", "16")
    monkeypatch.setenv("LoomeX_FS_GLOB_MAX_RESULTS", "9")
    s = _fresh().Settings.from_env()
    assert s.task_max_concurrent == 16
    assert s.fs_glob_max_results == 9


def test_bad_int_falls_back(monkeypatch):
    monkeypatch.setenv("LoomeX_SNAPSHOT_KEEP", "notanint")
    s = _fresh().Settings.from_env()
    assert s.snapshot_keep == 3


def test_get_settings_singleton():
    m = _fresh()
    assert m.get_settings() is m.get_settings()
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_host_config.py -v`
Expected: FAIL（无 `loomex_host.config`）

- [ ] **Step 3: 实现**

```python
# src/loomex_host/config.py
"""集中配置：所有 .env/环境变量在此读取一次。

来源不变（.env / env var），但读取集中到 Settings。除 LLM 凭证/模型
（LoomeX_LLM_*，由 core bootstrap_from_env 读）外，所有配置由 host 读取，
并在实例化时注入 core（RuntimeConfig / provider 构造参数）。

优先级：CLI 参数 > 环境变量(.env) > 此处默认值。

env keys（默认值见各字段）：
  LoomeX_RESOURCES_DIR / LoomeX_SKILLS_DIR / LoomeX_AGENTS_DIR / LoomeX_DATA_DIR
  LoomeX_WATCH_INTERVAL / LoomeX_LOG_LEVEL / LoomeX_LOG_FORMAT / LoomeX_LOG_FILE
  LoomeX_CORE_LOG_LEVEL / LoomeX_SNAPSHOT_EVERY_N_EVENTS / LoomeX_SNAPSHOT_KEEP
  DATABASE_URL
  LoomeX_HITL_TIMEOUT_SEC / LoomeX_HITL_MAX_RESOLVED
  LoomeX_TASK_MAX_CONCURRENT / LoomeX_TASK_MAX_RETRIES
  LoomeX_DEFAULT_TOKEN_BUDGET / LoomeX_DEFAULT_TASK_TIMEOUT_MS
  LoomeX_FS_BASH_TIMEOUT_SEC / LoomeX_FS_BASH_MAX_OUTPUT_BYTES
  LoomeX_FS_FILE_MAX_READ_BYTES / LoomeX_FS_GLOB_MAX_RESULTS
  LoomeX_HTTP_TIMEOUT_SEC / LoomeX_HTTP_MAX_RESPONSE_BYTES
  LoomeX_MCP_MAX_RECONNECT_ATTEMPTS / LoomeX_MCP_RECONNECT_BASE_DELAY_SEC
  LoomeX_SKILL_SCRIPT_TIMEOUT_SEC / LoomeX_SKILL_OUTPUT_LIMIT_CHARS
  LoomeX_LLM_MAX_HTTP_RETRIES
"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _opt_int(key: str) -> int | None:
    raw = os.environ.get(key)
    if not raw:
        return None
    try:
        v = int(raw)
    except ValueError:
        return None
    return v if v > 0 else None


def _str(key: str, default: str | None) -> str | None:
    raw = os.environ.get(key)
    return raw if raw else default


@dataclass(frozen=True)
class Settings:
    # host-only
    resources_dir: str | None
    skills_dir: str | None
    agents_dir: str | None
    data_dir: str | None
    watch_interval: float
    log_level: str | None
    log_format: str
    log_file: str | None
    core_log_level: str | None
    snapshot_every_n: int
    snapshot_keep: int
    database_url: str
    # 注入 core — RuntimeConfig
    hitl_timeout_sec: int | None
    hitl_max_resolved: int
    task_max_concurrent: int
    task_max_retries: int
    default_token_budget: int
    default_task_timeout_ms: int
    # 注入 core — provider 构造参数
    fs_bash_timeout_sec: int
    fs_bash_max_output_bytes: int
    fs_file_max_read_bytes: int
    fs_glob_max_results: int
    http_timeout_sec: int
    http_max_response_bytes: int
    mcp_max_reconnect_attempts: int
    mcp_reconnect_base_delay_sec: float
    skill_script_timeout_sec: int
    skill_output_limit_chars: int
    llm_max_http_retries: int

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            resources_dir=_str("LoomeX_RESOURCES_DIR", None),
            skills_dir=_str("LoomeX_SKILLS_DIR", None),
            agents_dir=_str("LoomeX_AGENTS_DIR", None),
            data_dir=_str("LoomeX_DATA_DIR", None),
            watch_interval=_float("LoomeX_WATCH_INTERVAL", 5.0),
            log_level=_str("LoomeX_LOG_LEVEL", None),
            log_format=_str("LoomeX_LOG_FORMAT", "text") or "text",
            log_file=_str("LoomeX_LOG_FILE", None),
            core_log_level=_str("LoomeX_CORE_LOG_LEVEL", None),
            snapshot_every_n=_int("LoomeX_SNAPSHOT_EVERY_N_EVENTS", 50),
            snapshot_keep=_int("LoomeX_SNAPSHOT_KEEP", 3),
            database_url=_str("DATABASE_URL", "sqlite") or "sqlite",
            hitl_timeout_sec=_opt_int("LoomeX_HITL_TIMEOUT_SEC"),
            hitl_max_resolved=_int("LoomeX_HITL_MAX_RESOLVED", 1000),
            task_max_concurrent=_int("LoomeX_TASK_MAX_CONCURRENT", 4),
            task_max_retries=_int("LoomeX_TASK_MAX_RETRIES", 3),
            default_token_budget=_int("LoomeX_DEFAULT_TOKEN_BUDGET", 200_000),
            default_task_timeout_ms=_int("LoomeX_DEFAULT_TASK_TIMEOUT_MS", 60_000),
            fs_bash_timeout_sec=_int("LoomeX_FS_BASH_TIMEOUT_SEC", 30),
            fs_bash_max_output_bytes=_int("LoomeX_FS_BASH_MAX_OUTPUT_BYTES", 50_000),
            fs_file_max_read_bytes=_int("LoomeX_FS_FILE_MAX_READ_BYTES", 500_000),
            fs_glob_max_results=_int("LoomeX_FS_GLOB_MAX_RESULTS", 500),
            http_timeout_sec=_int("LoomeX_HTTP_TIMEOUT_SEC", 30),
            http_max_response_bytes=_int("LoomeX_HTTP_MAX_RESPONSE_BYTES", 1_000_000),
            mcp_max_reconnect_attempts=_int("LoomeX_MCP_MAX_RECONNECT_ATTEMPTS", 3),
            mcp_reconnect_base_delay_sec=_float("LoomeX_MCP_RECONNECT_BASE_DELAY_SEC", 1.0),
            skill_script_timeout_sec=_int("LoomeX_SKILL_SCRIPT_TIMEOUT_SEC", 60),
            skill_output_limit_chars=_int("LoomeX_SKILL_OUTPUT_LIMIT_CHARS", 65536),
            llm_max_http_retries=_int("LoomeX_LLM_MAX_HTTP_RETRIES", 3),
        )


_settings: Settings | None = None


def get_settings() -> Settings:
    """懒加载单例；首次调用时读 env（.env 已在 cli.main 先行 load_dotenv）。"""
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings
```

- [ ] **Step 4: 运行通过**

Run: `python -m pytest tests/test_host_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/config.py tests/test_host_config.py
git commit -m "feat(host): centralized Settings config module"
```

### Task 4.2: `RuntimeConfig` 工厂（host 侧从 Settings 构造）

**Files:**
- Modify: `src/loomex_host/config.py`（加 `to_runtime_config()`）
- Test: `tests/test_host_config.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
def test_to_runtime_config(monkeypatch):
    monkeypatch.setenv("LoomeX_TASK_MAX_RETRIES", "9")
    s = _fresh().Settings.from_env()
    rc = s.to_runtime_config()
    assert rc.task_max_retries == 9
    assert rc.default_token_budget == 200_000
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_host_config.py::test_to_runtime_config -v`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `Settings` 内加：
```python
    def to_runtime_config(self):
        from loomex_core.core.config import RuntimeConfig
        return RuntimeConfig(
            hitl_timeout_sec=self.hitl_timeout_sec,
            hitl_max_resolved=self.hitl_max_resolved,
            task_max_concurrent=self.task_max_concurrent,
            task_max_retries=self.task_max_retries,
            default_token_budget=self.default_token_budget,
            default_task_timeout_ms=self.default_task_timeout_ms,
        )
```

- [ ] **Step 4: 运行通过**

Run: `python -m pytest tests/test_host_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/config.py tests/test_host_config.py
git commit -m "feat(host): Settings.to_runtime_config()"
```

---

## Phase 5 — host 接线：读 Settings + 注入

### Task 5.1: `cli.build_runtime` 注入 RuntimeConfig + provider 参数 + LLM retries

**Files:**
- Modify: `src/loomex_host/cli.py:38-45`（`_init_llm_provider`）、`:48-100`（`build_runtime`）

- [ ] **Step 1: 改 `_init_llm_provider`**

```python
def _init_llm_provider():
    from loomex_host.config import get_settings
    from loomex_host.providers.llm.llm_provider import LLMProvider
    from loomex_host.providers.llm.account_store import LLMAccountStore
    provider = LLMProvider(LLMAccountStore(), max_http_retries=get_settings().llm_max_http_retries)
    provider.load_from_store()
    provider.bootstrap_from_env()
    return provider
```

- [ ] **Step 2: 改 `build_runtime`**

- 顶部 `from loomex_host.config import get_settings`；`cfg = get_settings()`。
- `resources_dir`：`Path(cfg.resources_dir) if cfg.resources_dir else Path(__file__).parents[3] / "resources"`。
- `skills_dir`：`Path(getattr(args, "skills_dir", None) or cfg.skills_dir) if (...) else resources_dir / "skills"`（CLI 优先）。
- provider 构造注入：
```python
        from loomex_core.providers.capability_builtin import BuiltinToolsCapabilityProvider, BuiltinToolsConfig
        from loomex_core.providers.capability_filesystem import FilesystemToolsProvider, FilesystemConfig
        providers.register_capability(FilesystemToolsProvider(FilesystemConfig(
            bash_timeout_sec=cfg.fs_bash_timeout_sec,
            bash_max_output_bytes=cfg.fs_bash_max_output_bytes,
            file_max_read_bytes=cfg.fs_file_max_read_bytes,
            glob_max_results=cfg.fs_glob_max_results,
        )))
        providers.register_capability(BuiltinToolsCapabilityProvider(BuiltinToolsConfig(
            http_timeout_sec=cfg.http_timeout_sec,
            http_max_response_bytes=cfg.http_max_response_bytes,
        )))
```
> `FilesystemConfig`/`BuiltinToolsConfig` 的导出路径按各 provider 包 `__init__.py` 实际（`grep -rn "FilesystemConfig\|BuiltinToolsConfig" loomex-core/src/loomex_core/providers/*/__init__.py`）。
- 本地 skill provider 注入：
```python
        providers.register_capability(LocalSkillCapabilityProvider(
            skills_dir,
            script_timeout_sec=cfg.skill_script_timeout_sec,
            output_limit_chars=cfg.skill_output_limit_chars,
        ))
```
- `LoomeXRuntime(...)` 加 `config=cfg.to_runtime_config()`。

- [ ] **Step 3: smoke 验证导入**

Run: `python -c "import loomex_host.cli"`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/loomex_host/cli.py
git commit -m "feat(host): cli.build_runtime injects config into runtime + providers + llm"
```

### Task 5.2: `startup.py` 用 Settings（resources/skills/agents/watch/snapshots）+ 注入

**Files:**
- Modify: `src/loomex_host/api/startup.py:36-59`（路径/`_env_int`）、`:120-121`（snapshots）、`:165`（watch）

- [ ] **Step 1: 改实现**

- `_resources_dir()`/`_resolve_skills_dir()`/`_resolve_agents_dir()` 改为读 `get_settings().resources_dir/skills_dir/agents_dir`（保留 override 形参，CLI 优先）。
- `:120-121` snapshot：`snapshot_every_n = get_settings().snapshot_every_n`、`snapshot_keep = get_settings().snapshot_keep`（删 `_env_int(...)` 调用）。
- `:165` watcher：`poll_interval=get_settings().watch_interval`。
- 顶部 `from loomex_host.config import get_settings`。
> 注：`run_startup` 收到的 `runtime` 已在 `cli.build_runtime` 注入 RuntimeConfig；本文件不再构造 RuntimeConfig。local skills 装载逻辑保持。

- [ ] **Step 2: smoke**

Run: `python -c "import loomex_host.api.startup"`
Expected: 无错误

- [ ] **Step 3: host 测试回归**

Run: `python -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/loomex_host/api/startup.py
git commit -m "refactor(host): startup reads centralized Settings"
```

### Task 5.3: logging / persistence / account_store / mcp store 用 Settings

**Files:**
- Modify: `src/loomex_host/observability/logging.py:53,121,141`
- Modify: `src/loomex_host/persistence/postgres/__init__.py:17`
- Modify: `src/loomex_host/providers/llm/account_store.py:23`
- Modify: `src/loomex_host/providers/capability/mcp/store.py:42`

- [ ] **Step 1: 改实现（逐文件）**

- `logging.py`：`LoomeX_LOG_FORMAT`→`get_settings().log_format`；`LoomeX_LOG_FILE`→`get_settings().log_file`；`:53` 的按 logger env_key（含 `LoomeX_CORE_LOG_LEVEL`/`LoomeX_LOG_LEVEL`）改为读 `get_settings().core_log_level`/`.log_level`（保持原 fallback 语义）。
  > 注意循环导入：`logging.configure_logging()` 在 `cli.main` 很早调用。`get_settings()` 仅依赖 `os`，安全；但确保 `loomex_host.config` 不反向 import logging。
- `persistence/postgres/__init__.py:17`：`os.environ.get("LoomeX_DATA_DIR")`→`get_settings().data_dir`。
- `providers/llm/account_store.py:23` 与 `providers/capability/mcp/store.py:42`：`os.environ.get("LoomeX_RESOURCES_DIR")`→`get_settings().resources_dir`。
- 各文件顶部加 `from loomex_host.config import get_settings`。

- [ ] **Step 2: smoke + 回归**

Run: `python -c "import loomex_host.observability.logging, loomex_host.persistence.postgres, loomex_host.providers.llm.account_store, loomex_host.providers.capability.mcp.store"` 然后 `python -m pytest tests/ -q`
Expected: 无错误；PASS

- [ ] **Step 3: Commit**

```bash
git add src/loomex_host/observability/logging.py src/loomex_host/persistence/postgres/__init__.py src/loomex_host/providers/llm/account_store.py src/loomex_host/providers/capability/mcp/store.py
git commit -m "refactor(host): logging/persistence/stores read centralized Settings"
```

### Task 5.4: MCP 重连参数注入（host MCP manager）+ host 会话创建传 context_limit / token_budget

**Files:**
- Modify: `src/loomex_host/providers/capability/mcp/manager.py`（构造 `MCPCapabilityProvider` 处传 reconnect 参数）
- Modify: `src/loomex_host/api/sessions.py:171-239`（create_session：token_budget 用 cfg，补 context_limit）
- Modify: `src/loomex_host/api/sessions.py:335-407`（messages 重跑：补 context_limit）
- Modify: `src/loomex_host/cli.py:cmd_run`（run_single_task 已据 llm 设 context_limit，无需 host 传；确认）

- [ ] **Step 1: MCP manager 注入 reconnect**

`grep -n "MCPCapabilityProvider(" src/loomex_host/providers/capability/mcp/manager.py`，构造处加：
```python
        from loomex_host.config import get_settings
        cfg = get_settings()
        provider = MCPCapabilityProvider(
            server_config,
            max_reconnect_attempts=cfg.mcp_max_reconnect_attempts,
            reconnect_base_delay_sec=cfg.mcp_reconnect_base_delay_sec,
        )
```

- [ ] **Step 2: host 会话创建传 context_limit + token_budget（sessions.py）**

`POST /sessions` 与 `/messages` 重跑分支构造 `SessionStartParams.create(...)` 时：
- `token_budget=req.token_budget or get_settings().default_token_budget`
- 新增 `context_limit=<resolved>`，其中 `<resolved>` 由所选账号/模型解析：
```python
    def _resolve_context_limit(runtime, llm_account, llm_model) -> int:
        prov = runtime.providers.get_llm_provider()
        client = prov.get_client(llm_account, llm_model)
        return client.context_limit
```
在 `create_session` / `send_message` 调用 `SessionStartParams.create(..., context_limit=_resolve_context_limit(runtime, llm_account, llm_model))`。
> `get_client` 取 adapter，其 `.context_limit` 即模型上下文长度。若 `get_client` 抛（无账号），回退 `get_settings()` 无 context_limit 项——此场景下用一个保守值并记录告警；最终值仍由 host 据模型构建为主路径。

- [ ] **Step 3: host 测试回归**

Run: `python -m pytest tests/ -q`
Expected: PASS（如 host 测试构造 SessionStartParams 也需补 context_limit，按 Phase 3 Task 3.4 Step 6 同法补）

- [ ] **Step 4: Commit**

```bash
git add src/loomex_host/providers/capability/mcp/manager.py src/loomex_host/api/sessions.py
git commit -m "feat(host): inject mcp reconnect + session context_limit/token_budget from config"
```

---

## Phase 6 — 全量验证

### Task 6.1: 端到端回归

- [ ] **Step 1: core 全测**

Run: `cd loomex-core && python -m pytest -q`
Expected: PASS

- [ ] **Step 2: host 全测**

Run: `python -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 3: 残留 env 读取审计**

Run: `grep -rn "os.environ\|getenv" src/loomex_host/ loomex-core/src/loomex_core/ --include=*.py | grep -v "config.py\|bootstrap_from_env\|{\*\*os.environ"`
Expected: 仅剩 LLM bootstrap（`provider.py` 的 `LoomeX_LLM_*`）与子进程 env 透传；其余应为空。逐条确认无遗漏。

- [ ] **Step 4: smoke 启动**

Run: `python -c "from loomex_host.api.main import create_app; from loomex_host.cli import build_runtime; import argparse; ns=argparse.Namespace(skills_dir=None, agents_dir=None, enable_tools=True, db_url=None); rt,sy=build_runtime(ns); print('ok', rt._config.task_max_concurrent)"`
Expected: 打印 `ok 4`（或 env 覆盖值）

- [ ] **Step 5: Commit（如有审计修补）**

```bash
git add -A
git commit -m "test: full regression for centralized config + core injection"
```

---

## Self-Review 注记（实现者必读）

1. **字段名核对**：`hitl_manager._timeout_sec`/`_max_resolved`、provider 内 `self._cfg`、`SessionProjection` 类名、`MCPServerConfig` 必填字段、`LLMAccountStoreProtocol` 方法名 —— 这些在测试里出现，落地前用 `grep` 核对实际名称，不符则统一替换。
2. **context_limit 波及面**：Phase 3 Task 3.4 Step 6 与 Task 5.4 Step 3 必须把所有 `SessionStartParams.create(` / `create_session(` 旧调用补 `context_limit=`，否则必填会触发 `TypeError`。这是本计划唯一会让既有测试需改动之处。
3. **循环导入**：`loomex_host.config` 只 import `os`（+ 延迟 import `RuntimeConfig`）。`logging.py` 早于一切被调用，确保 config 不反向依赖 logging。
4. **CLI 优先级**：`build_runtime` 中 `args.skills_dir or cfg.skills_dir`、`cmd_serve` 的 `--host/--port`、`_get_db_url` 的 `args.db_url or cfg.database_url` 保持 CLI > env。
5. **LLM 例外**：`bootstrap_from_env` 与 `LoomeX_LLM_*` 不动；仅 `_MAX_HTTP_RETRIES` 经 `LLMProvider(max_http_retries=…)` 注入。
