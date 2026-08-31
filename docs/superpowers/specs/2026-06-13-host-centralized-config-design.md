# Host 集中配置 + 向 core 注入 — 设计

日期：2026-06-13
分支：feat/desktop-contract-llm-input-static

## 目标

后端 host 侧新增一个统一的配置模块，集中管理所有可配置项。配置来源**保持 `.env`/环境变量不变**（不换格式、不引新依赖），但读取集中到一个模块；除 LLM 配置外，所有配置都由 **host 读取、在实例化时注入 loomex-core**，core 不再自己读 `os.environ`。

## 核心原则

1. **单一读取点**：`.env`/env 只在 `loomex_host.config` 读一次，其余代码读 `Settings` 字段，不再散落 `os.environ.get`。
2. **host 读、core 收**：除 LLM 外，core 的所有可配置项改为构造参数，由 host 在实例化（runtime / capability provider / 会话创建）时注入。core 不读 env。
3. **优先级**：CLI 参数 > 环境变量（`.env`）> 默认值。
4. **LLM 例外**：`LoomeX_LLM_*`（凭证/模型）与 LLM 适配器的 `_MAX_HTTP_RETRIES` 保持原样，仍由 core `bootstrap_from_env` 读，本次不动。
5. **行为不变**：所有默认值 = 现状值，使现有测试与直连 core 的调用零改动（唯一例外见 `context_limit`）。

## 配置流

```
.env / env vars
   └─→ loomex_host.config.Settings        (懒加载单例, 启动后读一次, 类型转换)
         ├─ host 代码直接读 settings.*                  (host-only key)
         ├─ 构造 RuntimeConfig → LoomeXRuntime(config=…)  (orchestrator + 会话默认)
         └─ 构造各 capability provider 时传参 → 注册       (provider 运行常量)
```

## 组件

### 1. `src/loomex_host/config.py`（新建）

- `Settings`：`@dataclass(frozen=True)`，字段见下。
- `Settings.from_env()`：在 `.env` 已加载后读 env，做类型转换（int 解析失败回退默认，沿用现有宽松行为）。
- `get_settings()`：懒加载单例（首次调用时 `from_env()`；`.env` 在 `cli.main()` 已先 `load_dotenv`，时机安全）。
- 模块 docstring 列全部 key + 默认值，作为「所有可配置项」的单一文档源。

**字段分组：**

host-only：
| 字段 | env key | 默认 |
|---|---|---|
| resources_dir | LoomeX_RESOURCES_DIR | `<project>/resources` |
| skills_dir | LoomeX_SKILLS_DIR | `<resources>/skills` |
| agents_dir | LoomeX_AGENTS_DIR | `<resources>/agents` |
| data_dir | LoomeX_DATA_DIR | （persistence 用） |
| server_host | （CLI --host） | 0.0.0.0 |
| server_port | （CLI --port） | 8000 |
| watch_interval | LoomeX_WATCH_INTERVAL | 5 |
| log_level | LoomeX_LOG_LEVEL | （logging 现状） |
| log_format | LoomeX_LOG_FORMAT | text |
| log_file | LoomeX_LOG_FILE | None |
| core_log_level | LoomeX_CORE_LOG_LEVEL | （logging 现状） |
| snapshot_every_n | LoomeX_SNAPSHOT_EVERY_N_EVENTS | 50 |
| snapshot_keep | LoomeX_SNAPSHOT_KEEP | 3 |
| database_url | DATABASE_URL | sqlite |
| enable_tools | （CLI --no-tools） | True |

注入 core（见 §2、§3）：hitl_timeout_sec、hitl_max_resolved、task_max_concurrent、task_max_retries、default_token_budget、default_task_timeout_ms、llm_max_http_retries，以及各 provider 运行常量。

### 2. `loomex_core/core/config.py`（新建）— `RuntimeConfig`

`@dataclass(frozen=True)`，默认值 = 现状，使直连 core / 测试零改动：

| 字段 | 默认 | 注入目标 |
|---|---|---|
| hitl_timeout_sec | None | HitlManager |
| hitl_max_resolved | 1000 | HitlManager |
| task_max_concurrent | 4 | TaskManager（3 处实例化点） |
| task_max_retries | 3 | TaskManager |
| default_token_budget | 200_000 | 会话创建默认 |
| default_task_timeout_ms | 60_000 | NormalTaskSettings 默认 |

`LoomeXRuntime.__init__` 增 `config: RuntimeConfig = RuntimeConfig()`（保留默认值兜底，使测试/直连 core 零改动；host 始终注入实际值）。runtime 持有 `self._config`，向下游线程：HitlManager、SessionManager（再到 TaskManager）、runtime 内两处 TaskManager、会话创建默认。

> 注：`default_context_limit` **不**进 RuntimeConfig（见 §4）。

### 3. provider 构造参数（host 注册/构造时注入）

给各 provider `__init__` 加 kwargs，默认 = 现模块常量（常量保留作默认值，core/测试零改动）；host 在 `cli.build_runtime` / `_setup_llm` 用 `settings.*` 构造：

| Provider | 参数（默认） |
|---|---|
| `capability_filesystem` | bash_timeout_sec=30, bash_max_output_bytes=50_000, file_max_read_bytes=500_000, glob_max_results=500 |
| `capability_builtin` | http_timeout_sec=30, http_max_response_bytes=1_000_000 |
| `capability_mcp` | max_reconnect_attempts=3, reconnect_base_delay_sec=1.0 |
| `capability_skill_local` | script_timeout_sec=60, output_limit_chars=65536 |
| LLM `LLMProvider` | max_http_retries=3 |

> capability provider 已由 host 在 `cli.build_runtime` 实例化注册，契合「host 读、注入」。对应 env key 由 `Settings` 新增，命名约定 `LoomeX_<AREA>_<NAME>`（如 `LoomeX_FS_BASH_TIMEOUT_SEC`、`LoomeX_HTTP_TIMEOUT_SEC`、`LoomeX_MCP_MAX_RECONNECT_ATTEMPTS`、`LoomeX_SKILL_SCRIPT_TIMEOUT_SEC`），精确名单在实现计划中敲定，并在 `Settings` docstring 登记。

> **LLM 适配器重试（`_MAX_HTTP_RETRIES`）注入链**：`Settings.llm_max_http_retries`（env `LoomeX_LLM_MAX_HTTP_RETRIES`，默认 3）→ host 构造 `LLMProvider(store, max_http_retries=…)`（`startup._setup_llm` + `cli._init_llm_provider`）→ `LLMProvider._build_adapter` 透传 → `AnthropicAdapter`/`OpenAIAdapter.__init__(max_http_retries=3)` 存 `self._max_http_retries`，重试循环改用实例字段，删除模块级 `_MAX_HTTP_RETRIES` 常量引用（常量可保留作参数默认值）。**注意**：这是 LLM 唯一被纳入集中配置的项；凭证/模型配置仍属例外（§7）。

### 4. `context_limit`：必传、host 据模型构建

- **core**：移除 `Session`/`Agent` model 的 `context_limit = 180_000` 默认；在会话创建契约（`SessionStartParams`）上 `context_limit` 变为**必填**，缺失即报错（`core 创建会话时不允许不传`）。线程：`SessionStartParams.context_limit`（必填）→ `Session.context_limit` → `Agent.loop_guard.context_limit`。assembler / act 的读取点不变。
- **host**：会话创建前解析所选 LLM 账号/模型，取其 `ModelConfig.context_limit`，作为 `SessionStartParams.context_limit` 传入。host API（`POST /sessions`、`/messages` 重跑、resume）与 `cli.cmd_run` 均需提供。
- **其他 core 调用点**（`run_single_task`、测试）：因 `context_limit` 必填，需一并传值（由解析到的模型 context_limit 或显式值提供）。

### 5. core 改动（停止自读 env / 解硬编码）

- `core/orchestrator/task_manager.py`：删 `_env_int` + 两个 env 读取，模块默认改裸 `3` / `4`；构造参数保留。
- `core/runtime.py`：删 `_hitl_timeout_from_env` / `_hitl_max_resolved_from_env`；`__init__` 接 `RuntimeConfig`，据此建 HitlManager、传 TaskManager、传 SessionManager、设会话默认。
- `core/orchestrator/session_manager.py`：增配置字段（runtime 在 `SessionManager(...)` 注入），用于 TaskManager 实例化与 token_budget 默认。
- 4 个 capability provider：模块常量 → 构造参数默认值。
- model/SessionStartParams：`context_limit` 必填（见 §4）。

### 6. host 改动（改读 config + 注入）

- 新增 `config.py`。
- `cli.build_runtime`：`cfg = get_settings()` → 构造 `RuntimeConfig` 与各 provider 参数 → `LoomeXRuntime(config=…)` + 带参注册 provider；CLI 覆盖保留（`args.x or cfg.x`）。
- `api/startup.py`、`observability/logging.py`、`persistence/postgres/__init__.py`、`providers/llm/account_store.py`、`providers/capability/mcp/store.py`：`os.environ.get(...)` → `get_settings().*`。
- host 会话创建路径补 `context_limit`（§4）。

### 7. LLM 凭证/模型：不动（唯一例外）

`bootstrap_from_env()`（core 定义、host 触发）继续读 `LoomeX_LLM_*`（account/style/api_key/model/base_url/context_limit/max_output_tokens/timeout_sec）。

> 例外**仅限**凭证/模型配置。LLM 适配器的 `_MAX_HTTP_RETRIES` 已纳入集中配置（见 §3）。

## 不做 / 排除

- LLM 凭证/模型配置（`bootstrap_from_env` 读 `LoomeX_LLM_*`，唯一例外）。适配器重试 `_MAX_HTTP_RETRIES` **不再排除**，已纳入（§3）。
- dead 旋钮：`Session` model 的 `max_concurrent_tasks` / `max_concurrent_agents`（全仓无人读）——不暴露。
- 子进程 env 透传（MCP stdio、技能脚本的 `{**os.environ}`）——不碰。
- 配置格式不变（仍 `.env`/env var），不引新依赖（int 解析用内置）。

## 测试策略

- `Settings.from_env()`：缺省、显式 env、非法 int 回退 三类用例。
- `RuntimeConfig` 注入：构造 `LoomeXRuntime(config=…)` 后断言 HitlManager / TaskManager 取到注入值。
- provider 参数：构造 provider 传非默认值，断言行为（如 glob_max_results 截断）。
- LLM 重试注入：`LLMProvider(store, max_http_retries=N)` → 断言 `_build_adapter` 出的 adapter `self._max_http_retries == N`（覆盖 anthropic + openai）。
- `context_limit` 必填：不传时会话创建报错；host 据模型 context_limit 正确传入。
- 现有 core 测试：除显式构造会话需补 `context_limit` 外，应全绿。

## 风险

- `context_limit` 改必填会波及 core 内部会话创建调用点与测试（已知、可控；逐点补传）。
- provider 新增 env key 需在 docstring/文档登记，避免「隐形旋钮」二次出现。
