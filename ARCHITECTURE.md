# netlivecowork 内部实现逻辑

> 本文讲 **服务外壳内部如何运转**：应用组装、lifespan 启动/停止时序、Provider 装配、持久化流水线、
> SSE 事件翻译、会话注册表、崩溃恢复、热更新与各类 Manager。
>
> 想知道**怎么部署和调用 netlivecowork**，见 [README.md](./README.md)。
> 想了解底层**引擎**（Loop / Step / Assembler / 任务编排）如何工作，见
> ctx-weft [源码仓](https://github.com/XingLiyin/ctx-weft)的 `ARCHITECTURE.md`。
> 引擎以 vendored 源码 wheel（`vendor/ctx_weft-*.whl`）交付，更新流程见
> [README.md §更新 ctx-weft 引擎](./README.md#更新-ctx-weft-引擎vendored-wheel)。

---

## 目录

1. [分层与职责](#1-分层与职责)
2. [应用组装（create_app）](#2-应用组装create_app)
3. [启动时序（run_startup）](#3-启动时序run_startup)
4. [Provider 装配](#4-provider-装配)
5. [持久化流水线](#5-持久化流水线)
6. [会话注册表与 SSE 事件翻译](#6-会话注册表与-sse-事件翻译)
7. [崩溃恢复与续跑](#7-崩溃恢复与续跑)
8. [热更新（DirectoryWatcher）](#8-热更新directorywatcher)
9. [Manager 层（MCP / Remote Skill / Template）](#9-manager-层mcp--remote-skill--template)
10. [模板解析（SOUL.md / ROLE.md → AgentTemplate）](#10-模板解析soulmd--rolemd--agenttemplate)

> 路径均相对仓库根；行号对应当前 `master`。

---

## 1. 分层与职责

```
                    HTTP / SSE 客户端（含 frontend/）
                                 │
                                 ▼
   ┌──────────────────────  netlivecowork  ──────────────────────┐
   │  api/            FastAPI 路由 + Pydantic schema + SSE       │
   │  api/models/     SessionEntry：进程内会话状态 + 事件翻译     │
   │  providers/      LLM / Template / MCP / Skill 装配与 Store   │
   │  persistence/    SQLite/Postgres：事件落盘 / 投影 / 快照      │
   │  observability/  logging / metrics / tracing                │
   └───────────────────────────┬────────────────────────────────┘
                               │ import & 注入
                               ▼
                          ctx-weft
            （CtxWeftRuntime / Loop Engine / EventBus）
```

**一句话**：`ctx-weft` 是纯引擎（无 I/O、无 HTTP、无 DB）；`netlivecowork` 把它包成一个可部署服务——
注入真实的 LLM adapter、把 `EventBus` 的事件落盘并翻译成前端协议、提供 REST API 管理 session / 账号 /
MCP / skill / template，并在进程重启后恢复会话。

源码主入口：

| 文件 | 职责 |
|------|------|
| `src/netlivecowork/cli.py` | CLI 入口（`serve` / `run`），组装 `CtxWeftRuntime` |
| `src/netlivecowork/api/main.py` | `create_app()`：挂路由、CORS、lifespan |
| `src/netlivecowork/api/startup.py` | lifespan 的 `run_startup()` / `teardown()` |
| `src/netlivecowork/api/models/session.py` | `SessionEntry` + SSE 生成器 + 事件翻译 |
| `src/netlivecowork/persistence/` | DB 引擎、event/state store、persister、投影、快照 |
| `src/netlivecowork/providers/` | LLM / template / MCP / skill 装配 |

---

## 2. 应用组装（create_app）

`create_app(runtime, agent_template_provider, template_syncer, hitl_manager, cors_origins, db_url, skills_dir)`
（`src/netlivecowork/api/main.py:17`）：

1. 把 `runtime` / `agent_template_provider` / `template_syncer` / `hitl_manager` 写进 `api/deps.py` 的进程级单例
   （路由通过 `Depends(deps.get_*)` 取用）。
2. 注册 lifespan：进入时 `run_startup(...)`，退出时 `teardown(handles)`。
3. 挂 CORS（默认 `*`）。
4. 挂路由，全部前缀 `/api/v1`：
   - `sessions_router` → `/api/v1/sessions`
   - `hitl_router` → `/api/v1/hitl`
   - `llms_router` → `/api/v1/llms`
   - `mcp_router` → `/api/v1/mcp-servers`
   - `skills_router` → `/api/v1/skill-sources`
   - `templates_router` **挂两次**：`/api/v1/agent-templates` 与 `/api/v1/templates`（别名兼容）
5. 加 `GET /health`。

`cli.cmd_serve`（`src/netlivecowork/cli.py:100`）负责在调用 `create_app` 之前用 `build_runtime(args)`
组装好 runtime，并把解析后的 DB URL 传进去；最后 `uvicorn.run(app, log_config=None)`
——`log_config=None` 是为了不让 uvicorn 覆盖我们在 `main()` 里配置好的 root logging。

---

## 3. 启动时序（run_startup）

`run_startup(runtime, template_syncer, db_url, skills_dir_override)`
（`src/netlivecowork/api/startup.py:190`）按固定顺序执行，返回 `StartupHandles` 供 teardown 注销：

```
1. _setup_llm           从 LLMAccountStore(JSON) 恢复用户账号 + bootstrap_from_seed(随包默认账号种子)，注册 llm provider
2. _setup_mcp           MCPProviderManager.load_from_store()，把已存 MCP server 重新注册为 capability
3. _setup_local_skills  若 skills_dir 存在 → 注册 LocalSkillCapabilityProvider
4. _setup_remote_skills RemoteSkillSourceManager.restore_all()，恢复 git skill 源
5. (db_url 非空) _setup_db   见 §5：建表、装持久化订阅者、恢复 session 注册表
   (db_url 为空) 记一行日志，纯内存运行
6. _setup_templates     template_syncer.sync(agents_dir)：扫描 resources/agents/* 同步元数据
7. _setup_watcher       对 agents_dir / skills_dir 启动轮询式热更新（见 §8）
8. (db_url 非空) _setup_recovery   runtime.recover(...)：把无终态的旧 session 标记 INTERRUPTED（见 §7）
```

路径解析（`startup.py:37`）：
- `resources_dir` = `IPMC_RESOURCES_DIR` 或 `<repo>/resources`
- `skills_dir` = `--skills-dir` / `IPMC_SKILLS_DIR` 或 `resources/skills`
- `agents_dir` = `IPMC_AGENTS_DIR` 或 `resources/agents`

`teardown(handles)`（`startup.py:228`）：停 watcher、关所有 MCP 连接、注销三个持久化订阅 handle。

---

## 4. Provider 装配

`build_runtime(args)`（`src/netlivecowork/cli.py:44`，同步、不碰 DB/LLM）：

- 建 `TemplateStore` / `TemplateSyncer`；通过 `ProviderRegistry` 注册 `DirAgentCapabilityProvider`（模块路径 `providers/templates/provider.py`，生产解析器）。
- 建 `ProviderRegistry`，先注册 `InMemoryMemoryProvider`（lifespan 里若启用 DB 会被
  `PostgresMemoryProvider` 覆盖）。
- 除非 `--no-tools`，注册 `BuiltinToolsCapabilityProvider`（bash / http / file / glob）。
- 若 skills 目录存在，注册 `LocalSkillCapabilityProvider`。
- 用上述拼出 `CtxWeftRuntime(template_resolver=resolver, providers=providers)`。
- 给 `builtin:bash_exec` 挂 `HumanConfirmationAuthorizer`——**默认 bash 执行必须经过 HITL 人工放行**。

> `cmd_run`（`cli.py:113`）走单独路径：注册 LLM provider + `PostgresMemoryProvider`（默认 SQLite），
> 直接 `runtime.run_single_task(...)` 并打印结果，不起 HTTP。

LLM provider 的恢复逻辑（`_setup_llm` / `cli._init_llm_provider`）：
`LLMProvider(LLMAccountStore()).load_from_store()` 先从 `resources/llm_configs/*.json` 读回用户账号，
再 `bootstrap_from_seed(paths.llm_accounts_seed_path())` 从随包扁平 JSON 种子
（`default_llm_accounts.json`；dev 可用 `IPMC_LLM_ACCOUNTS_FILE` 覆盖）注册默认账号——
可见但锁定（禁删禁改），fail-fast。`LLMProvider` 本身来自 `ctx_weft.providers.llm`，
host 侧是 re-export shim（`providers/llm/llm_provider.py`）。

---

## 5. 持久化流水线

`_setup_db(runtime, db_url, template_syncer)`（`src/netlivecowork/api/startup.py:91`）：

```
init_db(db_url)                       解析 URL（见下）→ 建表 → 返回 async_sessionmaker
  ├─ PostgresStateStore(factory)      session/task/sse 投影表（供 REST 列表 + 重启恢复）
  └─ PostgresEventStore(factory)      append-only 事件表（单一事实源）

runtime.event_store = PostgresEventStore        覆盖默认 InMemoryEventStore
runtime.providers.register_memory(PostgresMemoryProvider(factory))   记忆落库

# 三个 EventBus 订阅者（全部订阅 filter=None，即全量事件）
event_bus.subscribe(None, EventPersister(event_store).on_event)      事件 → events 表
event_bus.subscribe(None, ProjectionUpdater(factory).on_event)       事件 → 投影表
event_bus.subscribe(None, SnapshotWriter(event_store).on_event)      定期写 event_snapshots

set_state_store / set_event_store                注入 api/models/session 的模块级单例
load_sessions_from_db(state_store)               把投影里的 session 重建成内存 SessionEntry
template_syncer._store.set_session_factory(...)  让 template 元数据也走 DB
```

**URL 解析**（`src/netlivecowork/persistence/postgres/__init__.py:22`，`resolve_db_url`）：

| 输入 | 归一化为 |
|------|----------|
| `sqlite` / `sqlite://` | `sqlite+aiosqlite:///<IPMC_DATA_DIR>/ipmc-dev.db` |
| `sqlite:///./foo.db` | `sqlite+aiosqlite:///./foo.db` |
| `postgresql://...` | `postgresql+asyncpg://...` |

SQLite 引擎做了单连接 + WAL 调优（`_make_engine` `:40` / `_apply_sqlite_pragmas` `:59`），避免
并发写的 "database is locked"。`init_db` 一步搞定解析 + 建表 + 返回 factory。

> 数据库为空（未配置 `DATABASE_URL`）时整条流水线跳过，事件只进默认的 `InMemoryEventStore`，
> 进程退出即丢——仅适合开发。注意：`serve` 的 CLI 默认值即 `sqlite`，所以默认是落盘的。

---

## 6. 会话注册表与 SSE 事件翻译

host 不直接把 core 的原始事件丢给前端，而是经 `SessionEntry`
（`src/netlivecowork/api/models/session.py:50`）翻译成一套面向 UI 的协议。

### 数据结构

- 全局 `_sessions: dict[str, SessionEntry]`（进程内会话表）。
- 每个 `SessionEntry` 持有：会话元数据、token 计数、`sse_events: list[str]`（已翻译事件的缓冲）、
  `cond: asyncio.Condition`（唤醒 SSE 生成器）、`pending_invocations`（拼合 tool 调用与结果）、
  以及 metadata-filler 守护任务的追踪字段。

### 链路

```
runtime.start_session(params)              core 后台 drain，事件进 EventBus
        │
session_consumer(entry, runtime, token)    订阅 EventFilter(session_id=...)（models/session.py:455）
        │  每条 core 事件
        ▼
entry.append_event(ev) → translate_event(ev)   原始事件 → 0/1/N 条前端事件（models/session.py:117）
        │  写入 entry.sse_events + notify cond（并按需 append_sse_event 落 state_store）
        ▼
sse_generator(session_id)                  GET /sessions/{id}/stream 的响应体（models/session.py:478）
        │  发 init → 回放缓冲 → 实时增量；3s 无事件发 ping；Last-Event-ID 续传
        ▼
                            text/event-stream
```

### 翻译要点（`translate_event`）

- **观察者/执行者分流**：靠 `StepStarted(step_name=observe|act)` 维护 `_in_observe_round`，
  把同样的 LLM 事件分别标成 `text_delta` 与 `observer_text_delta` 等。
- **token 计数**：`LLMResponseFinished` 累加 prompt/completion，额外发一条 `token_update`。
- **工具调用拼合**：`CapabilityInvoked` 暂存进 `pending_invocations`，`CapabilityFinished` 取出拼成
  `tool_call` / `control_tool_call`（`control:` 前缀的归为控制工具）。
- **metadata-filler 守护任务**：`MetadataFiller*` 系列翻译成 `daemon_task_*` 与 `daemon_llm_prompt`，
  并在完成时回填目标任务的 title/description、更新 session `goal`。
- **HITL**：`HitlRequired` → `waiting_input(input_type=hitl)` 并置 `status=PAUSED_HITL`；
  `HitlApproved/Rejected/Modified` 恢复 `RUNNING`。
- **终止**：`SessionFinished` → `done` 且 `sse_finished=True`，生成器据此收尾。

前端协议事件清单见 [README.md §SSE 事件流](./README.md#sse-事件流)。

---

## 7. 崩溃恢复与续跑

两条路径，都建立在「事件流即单一事实源」之上。

### 进程重启自动恢复（`_setup_recovery` `startup.py:171`）

启动末尾调 `runtime.recover(on_session_interrupted=...)`——core 通过
`event_store.list_active_session_ids()` 找出没有终态事件的 session，逐个回调。host 的回调把对应
`SessionEntry.status` 置 `INTERRUPTED`、推一条 `session_update`，并更新 state_store。
**此时不自动续跑**，只标记；前端看到 INTERRUPTED 后由用户决定。

### 用户触发续跑（`POST /sessions/{id}/resume`，`api/sessions.py:132`）

仅当 `status == INTERRUPTED` 时允许：置 `RUNNING` → `runtime.recover_session(id)`（core 回放事件
重建 Session/Task/Agent 并重新 drain）→ 起一个新的 `session_consumer`（`_consumer_token` 自增，旧消费者自然退出）。
失败则回滚为 INTERRUPTED 并返回 422。

### 消费者令牌（`_consumer_token`）

每次新建/续跑 session 都自增 `entry._consumer_token` 并启动新的 `session_consumer(entry, runtime, token)`；
消费者每轮比对 `entry._consumer_token != token` 即退出——保证同一 session 永远只有一个活跃事件消费者。

---

## 8. 热更新（DirectoryWatcher）

`_setup_watcher`（`src/netlivecowork/api/startup.py:135`）用轮询式
`DirectoryWatcher`（`providers/watcher.py`，间隔 `IPMC_WATCH_INTERVAL` 秒）监视：

- **agents 目录变化** → `template_syncer.sync(agents_dir)` 重新同步模板元数据。
  因为 `DirAgentCapabilityProvider` 每次都从磁盘读、无缓存，所以改完 SOUL.md/ROLE.md 立即生效。
- **skills 目录变化** → 让 `LocalSkillCapabilityProvider.invalidate_cache()` +
  `SkillExecutorCapabilityProvider.mark_dirty()` 重建 skill 索引。

只有当确实注册了监视项时才 `start()`。

---

## 9. Manager 层（MCP / Remote Skill / Template）

这些 Manager 把「REST 增删改」与「core 的 ProviderRegistry 注册」桥接起来，并负责 JSON 持久化。

| Manager | 源码 | Store | 作用 |
|---------|------|-------|------|
| `MCPProviderManager` | `providers/capability/mcp/manager.py` | `MCPServerStore`（`resources/mcp.json`） | 注册/注销 `MCPCapabilityProvider`，维护连接状态与工具清单，`refresh()` 重连 |
| `RemoteSkillSourceManager` | `providers/capability/skills/manager.py` | `RemoteSkillSourceStore`（`resources/skill_sources/`） | 注册 git skill 源 → `RemoteSkillCapabilityProvider`，`restore_all()` 重建 |
| `TemplateSyncer` + `TemplateStore` | `providers/templates/` | DB 或内存 | 扫描 `agents/*` upsert 元数据，删除已消失的条目 |

REST 层（`api/mcp.py` / `api/skills.py` / `api/llms.py` / `api/templates.py`）只是这些 Manager / Provider
的薄包装：把 Pydantic 请求转成配置对象、调用 Manager、把结果转成响应 schema。

LLM 账号同理：`api/llms.py` 直接操作 `runtime.providers.get_llm_provider()`（即 core 的 `LLMProvider`），
账号变更通过 `LLMAccountStore` 落 `resources/llm_configs/*.json`。

---

## 10. 模板解析（SOUL.md / ROLE.md → AgentTemplate）

loader 已上移 core（`ctx_weft.providers.agent_template_local`）；本项目不再内置 `TemplateLoader`。
仅保留 `TemplateSyncer` 负责扫描 `agents/*` 元数据到 store，模板加载由 `DirAgentCapabilityProvider`（`providers/templates/provider.py`）通过 core 的 loader 完成。

解析 agent 目录（`agents/<name>/SOUL.md` + 可选 `ROLE.md`）成 core 的 `AgentTemplate` 时：

```
agents/<name>/
  SOUL.md   必需。frontmatter(name/version/description/tools/loop_config/memory_config) + body(actor 人格)
  ROLE.md   可选。frontmatter(tools) + body(observer 评估标准)
```

详见 ctx-weft 的 `agent_template_local` provider 实现。

`DirAgentCapabilityProvider.get_agent(...)` 每次按 `template_id`（或 name）从 `TemplateStore` 找到目录，
再通过 core 的 loader 加载 ——**不缓存**，配合 §8 的 watcher 实现热更新。
`TemplateSyncer.scan/sync` 负责把目录元数据登记进 store。

