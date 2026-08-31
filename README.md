# netlivecowork

**ctx-weft 的完整服务外壳**——把纯引擎包成一个开箱即用的服务：LLM 账号管理、HTTP/SSE API、
SQLite/Postgres 持久化、Agent 模板/MCP/Skill 注册中心、崩溃恢复与可观测性。

> 本文是**使用参考**。想了解服务外壳的**内部实现**（启动时序、持久化流水线、SSE 事件翻译、崩溃恢复），
> 见 [ARCHITECTURE.md](./ARCHITECTURE.md)。ctx-weft 引擎以 vendored 源码 wheel 交付，
> 更新流程见 [更新 ctx-weft 引擎](#更新-ctx-weft-引擎vendored-wheel)。

---

## 目录

- [netlivecowork](#netlivecowork)
  - [目录](#目录)
  - [安装](#安装)
  - [更新 ctx-weft 引擎（vendored wheel）](#更新-ctx-weft-引擎vendored-wheel)
  - [快速上手](#快速上手)
    - [1. 配置 LLM 账号](#1-配置-llm-账号)
    - [2. 启动服务](#2-启动服务)
    - [3. 发起一次对话](#3-发起一次对话)
    - [命令行单跑（不起 HTTP）](#命令行单跑不起-http)
  - [CLI 参考](#cli-参考)
    - [`netlivecowork serve` — 启动 HTTP/SSE 服务](#netlivecowork-serve--启动-httpsse-服务)
    - [`netlivecowork run` — 单次任务](#netlivecowork-run--单次任务)
  - [配置（环境变量 + resources 目录）](#配置环境变量--resources-目录)
  - [编写 Agent 模板](#编写-agent-模板)
    - [SOUL.md](#soulmd)
    - [ROLE.md（可选）](#rolemd可选)
    - [配置项默认值](#配置项默认值)
  - [REST API 参考](#rest-api-参考)
    - [Sessions — `/sessions`](#sessions--sessions)
    - [其它资源](#其它资源)
    - [GET /health](#get-health)
  - [SSE 事件流](#sse-事件流)
  - [LLM 账号管理](#llm-账号管理)
  - [MCP / Skill / Template 管理](#mcp--skill--template-管理)
    - [MCP server — `/mcp-servers`](#mcp-server--mcp-servers)
    - [远程 Skill 源 — `/skill-sources`](#远程-skill-源--skill-sources)
    - [Agent 模板 — `/templates`（= `/agent-templates`）](#agent-模板--templates-agent-templates)
  - [HITL 人工审批](#hitl-人工审批)
  - [持久化](#持久化)
  - [可观测性](#可观测性)
  - [Docker 部署](#docker-部署)
  - [环境变量速查](#环境变量速查)

---

## 安装

```bash
# 用 uv（推荐，仓库自带 uv.lock + vendored ctx-weft wheel）
uv sync
```

Python ≥ 3.11。安装后提供 `netlivecowork` 命令（见 `pyproject.toml [project.scripts]`）。
ctx-weft 引擎作为 vendored 源码 wheel（`vendor/ctx_weft-*.whl`）随仓库一起交付，`uv sync` 会自动装上——无需单独安装。

---

## 更新 ctx-weft 引擎（vendored wheel）

ctx-weft 引擎不在本仓库里编辑——它作为一个 **vendored 源码 wheel** 交付：`vendor/ctx_weft-*.whl`，
由 `pyproject.toml` 的 `[tool.uv.sources]` 指向具体文件名。wheel 里含 `.py` 源码，`uv sync` 后可直接在
IDE 里跳转 / 断点调试；打包 app 时 PyInstaller 会把它冻成 PYZ 字节码，不泄源。

**版本号变了**：`git pull` 后看到 `vendor/*.whl` 换了文件名、`uv.lock`（可能还有 `pyproject.toml`）有改动，
你只需重新同步依赖：

```bash
uv sync
# 验证引擎已从新 wheel 装好——路径应落在 .venv 里
uv run python -c "import ctx_weft; print(ctx_weft.__file__)"
```

**版本号没变、但代码改过**：wheel 文件名一样（`ctx_weft-0.1.0-...` 这类版本号未动），
`uv sync` 会认为版本没变、不重装，装的还是旧代码。此时必须**强制重装**该包：

```bash
uv sync --reinstall-package ctx-weft
# 同样验证一下装的是新代码
uv run python -c "import ctx_weft; print(ctx_weft.__file__)"
```


## 快速上手

### 1. 配置 LLM 账号

默认账号由随包**扁平 JSON 种子**提供（`packaging/default_data/default_llm_accounts.json`，可配多账号 / 多 provider）：

```json
[
  {
    "account": "claude",
    "style": "anthropic",
    "api_key": "enc:v1:...",
    "base_url": "",
    "model": "claude-sonnet-4-6",
    "context_limit": 200000,
    "timeout_sec": 120
  }
]
```

`api_key` 可填明文（dev）或混淆密文 `enc:v1:...`（`python -m netlivecowork.providers.llm.secret encrypt "sk-..."`）。本地开发可设 `IPMC_LLM_ACCOUNTS_FILE` 指向一个 gitignored 本地文件覆盖（放真实 key、不入库）。启动时自动注册这些账号（可见但锁定，不可在 UI 删改）；也可在运行后通过 `POST /api/v1/llms` 增删**自己的**账号（见 [LLM 账号管理](#llm-账号管理)）。

### 2. 启动服务

```bash
netlivecowork serve                     # 默认 0.0.0.0:8000，SQLite 落盘，加载 resources/agents
```

服务启动后会自动加载 `resources/agents/` 下的模板（内置 `default` / `planner` 等）。

### 3. 发起一次对话

```bash
# 创建并启动 session（template_id 省略时取第一个可用模板）
curl -X POST http://localhost:8000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"template_id": "default", "user_prompt": "列出当前目录下所有 Python 文件"}'

# 返回 session 记录：{"id":"ses_...","status":"RUNNING","goal":"...", ...}

# 实时订阅执行过程（SSE）
curl -N http://localhost:8000/api/v1/sessions/ses_.../stream
```

### 命令行单跑（不起 HTTP）

```bash
netlivecowork run --template default --prompt "总结 README 的要点"
# === Result ===
# Outcome: success
# Summary: ...
```

---

## CLI 参考

### `netlivecowork serve` — 启动 HTTP/SSE 服务

```
netlivecowork serve [选项]

  --host TEXT          绑定地址（默认 0.0.0.0）
  --port INT           端口（默认 8000）
  --no-tools           禁用内置工具（bash / http / file / glob）
  --skills-dir PATH    本地 skill 目录（覆盖 IPMC_SKILLS_DIR）
  --db-url TEXT        数据库 URL（覆盖 DATABASE_URL；默认 sqlite）
  --agents-dir PATH    预留参数；Agent 模板目录请用 IPMC_AGENTS_DIR 环境变量
```

> 启用工具时，`builtin:bash_exec` 默认挂了人工审批——agent 每次执行 shell 都会触发一次 HITL 暂停，
> 需通过 [HITL](#hitl-人工审批) 放行。

### `netlivecowork run` — 单次任务

```
netlivecowork run --template TEMPLATE_ID --prompt PROMPT [--db-url TEXT]
```

`run` 会等任务跑完并打印 Observer 总结，适合脚本 / 调试。

---

## 配置（环境变量 + resources 目录）

所有用户编写的资源与运行时配置都集中在 `resources/`（可用 `IPMC_RESOURCES_DIR` 整体迁移）：

```
resources/
  agents/           Agent 模板目录（每个子目录一个模板，含 SOUL.md / ROLE.md）
  skills/           本地 skill 目录（每个子目录含 SKILL.md）
  templates/        模板元数据 JSON（TemplateStore，内存模式下不落盘）
  llm_configs/      LLM 账号 JSON（POST /llms 写入；明文存 api_key，仅本地用）
  skill_sources/    远程 git skill 源配置
  skill_caches/     git 同步下来的远程 skill 文件
  mcp.json          MCP server 配置
```

数据库文件单独放 `data/`（`IPMC_DATA_DIR`），默认 SQLite 文件 `data/ipmc-dev.db`。

模板与 skill 目录支持**热更新**：编辑 `resources/agents/*` 或 `resources/skills/*` 后无需重启，
文件监视器（轮询间隔 `IPMC_WATCH_INTERVAL` 秒）会自动重新加载。

完整变量见 [环境变量速查](#环境变量速查)。

---

## 编写 Agent 模板

一个模板是 `resources/agents/` 下的一个目录，至少包含 `SOUL.md`（Actor 人格），可选 `ROLE.md`（Observer 评估标准）。
目录名即默认模板名；`template_id` 取 frontmatter `id`（缺省用 `name`）。

### SOUL.md

```markdown
---
name: default                  # 显示名 / 默认 id
version: 1.3.0                  # semver
description: 默认通用执行代理
tools:                         # Actor（act 阶段）可用工具
  required:
    - submit_task
    - request_human_input
    - get_tracked_task_output
  forbidden: []
loop_config:                   # 可选，缺省见下表
  max_turns_per_act: 10
  max_spawn_depth: 4
memory_config:                 # 可选
  short_window_size: 20
  summary_threshold: 20
---

你是一个能力全面的通用 AI 代理……
（这段正文即 Actor 的 SOUL —— 描述人格、价值观、行为风格）
```

`tools` 也兼容扁平写法（等价于全部 `required`）：

```yaml
tools:
  - submit_task
  - request_human_input
```

### ROLE.md（可选）

```markdown
---
tools:                         # Observer（observe 阶段）可用工具
  required:
    - submit_task_assessment
    - replan
---

你是执行循环中的观察者……
（这段正文即 Observer 评估标准；缺失时 fallback 到 SOUL）
```

### 配置项默认值

| `loop_config` | 默认 | 说明 |
|---|---|---|
| `max_turns_per_act` | 10 | 单个 act 阶段最多多少轮 LLM 调用 |
| `max_turns_per_observe` | 5 | observe 阶段最多轮数 |
| `max_turns_per_agent` | 20 | 单 agent 总轮数上限 |
| `timeout_per_step_sec` | 120 | 单 Step 超时 |
| `failure_threshold` | 3 | 失败计数阈值 |
| `max_spawn_depth` | 4 | 子 agent 最大嵌套深度 |
| `compact_token_ratio` | 0.8 | token 占 context 比例超过则压缩 |
| `compact_message_delta` | 20 | 距上次压缩累计多少条再触发 |
| `compact_keep_last` | 6 | 压缩后保留最近条数 |

| `memory_config` | 默认 | 说明 |
|---|---|---|
| `short_window_size` | 20 | 进 prompt 的最近消息数 |
| `summary_threshold` | 20 | 超过多少条触发压缩 |
| `use_long_term` | true | 是否启用长期记忆检索 |
| `subscribed_blackboard_topics` | `[]` | 订阅的 blackboard topic |

> 工具 ID、capability 协议、控制工具（submit_task / replan 等）的完整语义由引擎定义，
> 见 ctx-weft [源码仓](https://github.com/XingLiyin/ctx-weft)。

---

## REST API 参考

Base URL：`http://localhost:8000/api/v1`。所有路由也可在 `/docs`（Swagger）查看。

### Sessions — `/sessions`

| 方法 & 路径 | 说明 |
|---|---|
| `POST /sessions` | 创建并启动 session，返回 session 记录 |
| `GET /sessions` | 列出所有 session（按创建时间倒序） |
| `GET /sessions/{id}` | 获取单个 session |
| `DELETE /sessions/{id}` | 删除 session 记录（运行中会先中断） |
| `GET /sessions/{id}/tasks` | 列出该 session 的任务树 |
| `POST /sessions/{id}/messages` | 发送消息：回应 HITL，或对已结束 session 发起新一轮 |
| `POST /sessions/{id}/interrupt` | 协作式中断正在运行的 session |
| `POST /sessions/{id}/resume` | 续跑被重启打断（INTERRUPTED）的 session |
| `GET /sessions/{id}/stream` | 订阅 SSE 事件流 |

**POST /sessions** 请求体：

```jsonc
{
  "user_prompt": "任务描述",        // 必填
  "template_id": "default",         // 省略 → 取第一个可用模板
  "tenant_id": "default",
  "llm_account": null,              // 省略 → 用默认账号
  "llm_model": null,                // 省略 → 账号默认模型
  "token_budget": 200000,
  "initial_task": null,             // 可选，TaskSettings dict（见 ctx-weft 文档）
  "session_id": null                // 可选，自定义 id
}
```

响应即 session 记录：

```json
{
  "id": "ses_01JXXX", "status": "RUNNING", "goal": "任务描述",
  "template_id": "default", "root_agent_id": "agt_...",
  "token_budget": 200000, "input_tokens_used": 0, "output_tokens_used": 0,
  "llm_account": "claude", "llm_model": "claude-sonnet-4-6",
  "created_at": "...", "updated_at": "..."
}
```

**POST /sessions/{id}/messages** 请求体（`content` 必填）：

```jsonc
{ "content": "继续/批准/拒绝 或新的任务描述", "llm_account": null, "llm_model": null }
```

- session 处于 `PAUSED_HITL` 时：`content` 为 `approve`/`yes`/`允许执行` 等放行，`reject`/`no`/`拒绝` 等驳回，其余作为人工回复内容。
- session 处于终态时：以 `content` 作为新一轮 `user_prompt` 续跑。
- session 处于 `RUNNING` / `INTERRUPTED` 时：分别返回 409（请改用 `/resume`）。

### 其它资源

| 前缀 | 用途 | 详见 |
|------|------|------|
| `/hitl` | 人工审批 | [HITL](#hitl-人工审批) |
| `/llms` | LLM 账号 | [LLM 账号管理](#llm-账号管理) |
| `/mcp-servers` | MCP server 注册 | [MCP / Skill / Template](#mcp--skill--template-管理) |
| `/skill-sources` | 远程 git skill 源 | 同上 |
| `/templates` 与 `/agent-templates` | Agent 模板（两个别名等价） | 同上 |

### GET /health

```bash
curl http://localhost:8000/health
# {"status": "ok", "runtime": true}
```

---

## SSE 事件流

`GET /sessions/{id}/stream` 返回 `text/event-stream`。每条消息形如 `data: {json}`，部分带 `id:`
（用于断线重连：客户端在 `Last-Event-ID` 头回传最后收到的 id 即可续传）。每 3 秒无事件会发一条 `ping`。

JavaScript 客户端示例：

```javascript
const es = new EventSource(`/api/v1/sessions/${sessionId}/stream`);
es.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  switch (ev.type) {
    case "init":            /* ev.session, ev.tasks */ break;
    case "text_delta":      process.stdout.write(ev.delta); break;       // Actor 流式文本
    case "text_done":       console.log("\n", ev.text); break;
    case "tool_call":       console.log(`[tool] ${ev.tool_name}`, ev.arguments, "→", ev.result); break;
    case "task_created":    console.log("new task:", ev.task.title); break;
    case "waiting_input":   console.log("需要人工输入:", ev.prompt); break; // HITL
    case "done":            console.log("结束:", ev.final_status); es.close(); break;
  }
};
```

常用事件类型：

| 类型 | 关键字段 | 含义 |
|------|---------|------|
| `init` | `session`, `tasks` | 连接建立时的当前快照 |
| `session_update` | `status` | 会话状态变更（RUNNING / PAUSED_HITL / ...） |
| `message` | `role`, `content` | 用户消息回显 |
| `text_delta` / `reasoning_delta` | `delta` | Actor 流式正文 / 思维 |
| `text_done` / `reasoning_done` | `text` | Actor 一轮完成 |
| `observer_text_delta` / `observer_text_done` | `delta` / `text` | Observer 对应版本 |
| `tool_call` / `control_tool_call` | `tool_name`, `arguments`, `result`, `is_error` | 工具调用结果 |
| `observer_tool_call` / `observer_control_tool_call` | 同上 | Observer 阶段工具 |
| `token_update` | `input_tokens_used`, `output_tokens_used`, `context_tokens` | token 计数 |
| `task_created` / `task_updated` | `task` | 任务树变化 |
| `daemon_task_created` / `daemon_task_updated` / `daemon_control_tool_call` | `task` / ... | metadata-filler 守护任务 |
| `llm_prompt` / `daemon_llm_prompt` | `system_prompt`, `messages`, `tool_names` | 实际发给 LLM 的 prompt（调试用） |
| `waiting_input` | `input_type`, `prompt` | 等待人工输入（HITL） |
| `compact_triggered` / `memory_compacted` | `before_count`, `after_count` | 记忆压缩 |
| `task_failed` | `error`, `error_type`, `will_retry` | 任务失败 |
| `interrupted` | — | 被中断 |
| `ping` | — | 心跳保活 |
| `done` | `final_status` | 流结束 |

---

## LLM 账号管理

账号可来自三处（优先级：REST 注册 > JSON 文件 > 环境变量兜底）：

- **环境变量**：启动时用 `IPMC_LLM_*` 兜底一个默认账号。
- **JSON 文件**：`resources/llm_configs/*.json`，启动时自动加载（通过 REST 注册的账号会写到这里）。
- **REST**：运行时增删改。

`style` 仅支持 `anthropic` 与 `openai`（OpenAI 风格可通过 `base_url` 接任意兼容端点，如本地 ollama）。

```bash
# 列出账号
curl http://localhost:8000/api/v1/llms

# 注册账号
curl -X POST http://localhost:8000/api/v1/llms \
  -H "Content-Type: application/json" \
  -d '{
    "name": "openai", "style": "openai", "api_key": "sk-...",
    "base_url": "",
    "models": [{"name": "gpt-4o", "context_limit": 128000, "output_reserve": null}],
    "default_model": "gpt-4o", "timeout_sec": 120
  }'

# 账号下增删模型 / 设默认模型 / 删除账号
curl -X POST   http://localhost:8000/api/v1/llms/openai/models -d '{"model":"gpt-4o-mini"}'
curl -X DELETE http://localhost:8000/api/v1/llms/openai/models -d '{"model":"gpt-4o-mini"}'
curl -X PUT    http://localhost:8000/api/v1/llms/openai/default_model -d '{"model":"gpt-4o"}'
curl -X DELETE http://localhost:8000/api/v1/llms/openai
```

创建 session 时通过 `llm_account` / `llm_model` 选择具体账号与模型；省略则用默认账号的默认模型。

---

## MCP / Skill / Template 管理

### MCP server — `/mcp-servers`

把任意 MCP server 注册为 agent 可用的 capability，配置持久化在 `resources/mcp.json`，重启自动恢复。

```bash
# stdio（启动子进程）
curl -X POST http://localhost:8000/api/v1/mcp-servers/stdio \
  -H "Content-Type: application/json" \
  -d '{"name":"filesystem","command":"npx",
       "args":["-y","@modelcontextprotocol/server-filesystem","/workspace"],
       "default_purposes":["act"]}'

# http
curl -X POST http://localhost:8000/api/v1/mcp-servers/http \
  -d '{"name":"my_service","url":"http://localhost:3000","headers":{"Authorization":"Bearer x"}}'

curl http://localhost:8000/api/v1/mcp-servers              # 列出（含连接状态与工具清单）
curl -X POST http://localhost:8000/api/v1/mcp-servers/filesystem/refresh   # 重连
curl -X DELETE http://localhost:8000/api/v1/mcp-servers/filesystem
```

### 远程 Skill 源 — `/skill-sources`

从 git 仓库同步 `SKILL.md`，配置存 `resources/skill_sources/`，文件缓存到 `resources/skill_caches/`。

```bash
curl -X POST http://localhost:8000/api/v1/skill-sources/git \
  -d '{"source_name":"github","repo_url":"https://github.com/org/skills","branch":"main"}'
curl http://localhost:8000/api/v1/skill-sources
curl -X DELETE http://localhost:8000/api/v1/skill-sources/github
```

> 本地 skill 直接放 `resources/skills/<name>/SKILL.md` 即可（启动自动加载、热更新），无需走 REST。

### Agent 模板 — `/templates`（= `/agent-templates`）

```bash
curl http://localhost:8000/api/v1/templates                 # 列出
curl http://localhost:8000/api/v1/templates/default         # 详情

# 注册一个模板目录（须含 SOUL.md）
curl -X POST http://localhost:8000/api/v1/templates/register \
  -d '{"template_dir":"/abs/path/to/agents/my_agent"}'

curl -X DELETE http://localhost:8000/api/v1/templates/my_agent
```

---

## HITL 人工审批

当 agent 触发人工介入（如默认对 `builtin:bash_exec` 的审批、或调用 `request_human_input`），
session 进入 `PAUSED_HITL`，SSE 推 `waiting_input`。两种应答方式：

**方式 A：HITL 专用端点**

```bash
curl "http://localhost:8000/api/v1/hitl/pending?session_id=ses_..."   # 列出待审批
curl -X POST http://localhost:8000/api/v1/hitl/{approval_id}/approve -d '{}'
# 修改参数后放行：
curl -X POST http://localhost:8000/api/v1/hitl/{approval_id}/approve -d '{"modify":{"command":"ls"}}'
curl -X POST http://localhost:8000/api/v1/hitl/{approval_id}/reject
```

**方式 B：直接发消息**（更贴合聊天 UI）

```bash
curl -X POST http://localhost:8000/api/v1/sessions/ses_.../messages -d '{"content":"approve"}'
# content 为 approve/yes/允许执行... → 放行；reject/no/拒绝... → 驳回；其它文本 → 作为人工回复
```

---

## 持久化

| `DATABASE_URL` | 后端 | 适用 |
|---|---|---|
| 未设置 / `sqlite` | SQLite（`data/ipmc-dev.db`，WAL） | 本地开发（serve 默认即此） |
| `sqlite:///./path.db` | 指定路径的 SQLite | 开发 |
| `postgresql://user:pw@host/db` | Postgres（自动转 asyncpg） | 生产 |

落盘内容：append-only 事件表（单一事实源）、session/task/SSE 投影表（供列表查询与重启恢复）、
事件快照、以及 `PostgresMemoryProvider` 的记忆。建表幂等，启动自动完成。

**崩溃恢复**：进程重启后，未结束的 session 会被标记为 `INTERRUPTED`；通过
`POST /sessions/{id}/resume` 回放事件续跑。详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 可观测性

```python
from netlivecowork.observability.logging import configure_logging
from netlivecowork.observability.metrics import start_metrics_server

# 日志：CLI 启动时自动调用；同时捕获 netlivecowork.* 与 ctx_weft.* 引擎日志。
configure_logging(level="INFO", fmt="text")
configure_logging(level="INFO", fmt="json", core_level="DEBUG")  # 仅引擎 DEBUG
# 环境变量（参数留空时生效）：
#   IPMC_LOG_LEVEL / IPMC_LOG_FORMAT(text|json) / IPMC_CORE_LOG_LEVEL
#   IPMC_LOG_DIR / IPMC_LOG_FILENAME / IPMC_LOG_BACKUP_DAYS（文件日志：目录+文件名+保留天数，按天轮转）

# Prometheus（需 pip install prometheus-client）
start_metrics_server(port=9090)
```

关键指标：`IPMC_sessions_total` / `IPMC_tasks_total` / `IPMC_step_duration_seconds` /
`IPMC_llm_tokens_total` / `IPMC_capability_invocations_total`。
OpenTelemetry tracing 见 `netlivecowork/observability/tracing.py`。

---

## Docker 部署

仓库提供 `docker-compose.yml`（Postgres 16 + host）：

```bash
# 在 .env 里配置 LLM 凭据（compose 会透传 ANTHROPIC_API_KEY / OPENAI_API_KEY）
docker compose up -d
docker compose logs -f netlivecowork
```

容器内通过 `DATABASE_URL` 连接 Postgres。如需自定义 LLM 账号，启动后用 `POST /api/v1/llms` 注册，
或在 compose 中注入 `IPMC_LLM_*` 环境变量。

---

## 环境变量速查

| 变量 | 默认 | 说明 |
|------|------|------|
| `IPMC_LLM_ACCOUNTS_FILE` | (随包模板) | 覆盖默认账号种子路径（dev 用；不设则用随包 `default_llm_accounts.json`）。账号字段（account/style/api_key/base_url/model/context_limit/output_reserve/timeout_sec）写在 JSON 里，不再用 `IPMC_LLM_*` 环境变量 |
| `DATABASE_URL` | `sqlite` | `sqlite` / `sqlite:///...` / `postgresql://...` |
| `IPMC_RESOURCES_DIR` | `<repo>/resources` | 资源根目录 |
| `IPMC_AGENTS_DIR` | `resources/agents` | Agent 模板目录 |
| `IPMC_SKILLS_DIR` | `resources/skills` | 本地 skill 目录 |
| `IPMC_DATA_DIR` | `<repo>/data` | 数据库文件目录 |
| `IPMC_TASK_MAX_RETRIES` | 3 | 单任务最大重试次数 |
| `IPMC_TASK_MAX_CONCURRENT` | 1 | session 内任务最大并发（1=串行；>1 允许并行） |
| `IPMC_WATCH_INTERVAL` | 5 | 模板/skill 热更新轮询间隔（秒） |
| `IPMC_LOG_LEVEL` / `IPMC_LOG_FORMAT` / `IPMC_CORE_LOG_LEVEL` | — | 日志级别/格式 |
| `IPMC_LOG_DIR` / `IPMC_LOG_FILENAME` / `IPMC_LOG_BACKUP_DAYS` | — / `netlivecowork.log` / `7` | 文件日志：目录（自动创建）+ 文件名 + 按天轮转保留天数 |

---

> 服务外壳内部实现见 [ARCHITECTURE.md](./ARCHITECTURE.md)；ctx-weft 引擎以 vendored wheel 交付，
> 更新流程见 [更新 ctx-weft 引擎](#更新-ctx-weft-引擎vendored-wheel)。
