# 客户端观测 + 会话 DB 导出上报(IpMasterCoworkPy 适配)— Design

**Date:** 2026-06-25
**Status:** Approved
**Context:** `docs/observability-docs/` 的客户端观测系统(Phase A/B/C)是为**旧的文件存储版**(miniAgentsDemo,会话数据落 `/data/*.json`)设计并实现的。本仓 `IpMasterCoworkPy` 是**事件溯源 + 数据库**架构(SQLAlchemy 模型,dev=SQLite / prod=Postgres),会话数据全在表里。本设计把整套观测能力移植到本仓,**复用同一台管理服务**(`10.25.228.203` 系列,经 `updateConfig.telemetryUrl`),并把唯一受存储影响的部分 —— **Phase C 会话上报 —— 重新设计为"导出该会话的独立 SQLite 文件"**,以便管理员把该文件直接置换进可视化服务、按事件溯源**完整回放**。

## 1. 范围与定位

整套系统分三部分,本仓现状决定工作性质:

| 部分 | 本仓现状 | 工作性质 |
|------|---------|---------|
| 遥测通道(install-id、`POST /events`、200 条离线队列、`update-config`、updater) | **已存在**:`electron/telemetry.js`、`electron/lib/telemetry-core.js`、`electron/lib/update-config.js`、`electron/updater.js` | 复用,不改 |
| Phase A 失败事件流 | 未实现 | spool/drain 机械移植 + **host EventBus 订阅者**(替代 core 逐点 emit,见 §5) |
| Phase B 日志上传 + 指令轮询 + zip 写入器 | 未实现 | 机械移植 |
| **Phase C 会话上报** | 未实现 | **新设计**:导出 SQLite 文件,非打包 `/data` JSON |

**全程适配点**(相对 `docs/observability-docs`):
- 后端路径 `app/` → `src/ipmastercowork/`;
- env 前缀 `IPMASTER_COWORK_*` → `IPMC_*`(数据目录 `IPMC_DATA_DIR`、日志目录 `IPMC_LOG_DIR`);
- 后端日志文件名 `ipmaster-cowork.log` → `ipmastercowork.log`;
- 后端进程名换成本仓打包态的 exe 名(写 plan 时核对);
- 埋点位置换成本仓真实的 MCP / LLM / skill 调用路径(写 plan 时定位)。

**关键简化:DB 内无密钥。** LLM 凭证由 core `bootstrap_from_env` 从 `IPMC_LLM_*` 读取,**不入库**;`mcp_configs` / `llm_configs` 也不是数据库表。因此旧 Phase C "排除含 `api_key` 的配置"的整套顾虑在本仓**不存在**。

**目标**(沿用旧 spec G1–G5):失败结构化自动上报、崩溃附日志、管理端按需拉运行日志、用户主动上报单会话(本仓=会话 SQLite)、按 hostname/os_username 检索。
**非目标**:Prometheus/OTel 风格指标(本仓已有 `observability/` OTel 包,与本系统正交,不动)、会话数据自动/批量上传、客户端远程配置下发、脱敏(内网工具)。

## 2. 用户标识与同意模型

- 主键 `install_id`(现有,AppData 持久化);每次上报附 `hostname` / `os_username`(人可读标签)。
- **会话数据(Phase C)必须用户主动触发**——会话 SQLite 含完整对话内容,只经用户点击"上报此会话"出客户端。Phase A(仅错误元数据)与 Phase B(运行日志文件)**不含**对话内容,可自动/按需。

## 3. 核心新设计:会话导出为 SQLite 文件(方案 A)

### 3.1 导出内容

会话相关、按 `session_id` 过滤(`sessions` 按 `id`)的表:

| 表 | 过滤键 | 作用 |
|----|--------|------|
| `sessions` | `id == sid` | 会话元信息(含 `workspace`/`config_json`) |
| `tasks` | `session_id` | 任务树(含 `outputs_json`) |
| `events` | `session_id` | **事件日志(回放核心)** |
| `snapshots` | `session_id` | 状态快照(加速回放) |
| `memory_events` | `session_id` | agent 对话记忆 |
| `memory_subscriptions` | `session_id` | agent 间订阅 |
| `session_sse_events` | `session_id` | 已翻译的前端回放流 |

**排除** `agent_templates`(全局表、指向磁盘目录、跨会话,无回放价值)。

### 3.2 导出机制:ORM 行拷贝(源无关)

`src/ipmastercowork/observability/session_export.py::export_session_db(session_id) -> bytes`:

1. 建临时文件 `sqlite:///<tmp>.sqlite`(同步引擎即可)。
2. `Base.metadata.create_all(tmp_engine)` —— schema 与本 app **完全一致**,viewer 可直接打开。
3. 逐表把目标会话的行从**实时存储**(SQLite 或 Postgres,经现有 session_factory)查出,bulk-insert 进临时库。逐行用 ORM 模型,字段一一对应。
4. 读临时文件字节返回,删临时文件。
5. `sessions` 行不存在 → 抛 `AppError("SESSION_NOT_FOUND")`,路由层转 404。

源无关是关键:dev 的 SQLite 与 prod 的 Postgres **走同一条 ORM 路径**产出同构 SQLite,无分支。单会话行数有界,拷贝开销可接受。

### 3.3 与上传契约的衔接

产物命名 `session-<id>.sqlite`,与日志一起进**一个 zip**,经现有 `POST /logs`(multipart,reason=`session_report`)上传 —— **服务端零改动**。管理员下载 zip、取出 `.sqlite`、置换进 viewer 回放。

## 4. Phase C 端到端流程

```
[用户点"上报此会话" → 确认框(明确同意文案 + 可选备注)]
        │  window.electronAPI.reportSession(sessionId, note)
        ▼
[electron main: ipcMain.handle('report-session')]   ── 全程 try/catch,返回 {ok, error?},绝不抛
   gate: shouldReportTelemetry(updateConfig) 关 → {ok:false, error:'telemetry disabled'}
   1. fetch GET {BACKEND_URL}/api/v1/sessions/{id}/export  → session-<id>.sqlite 字节
        BACKEND_URL = http://127.0.0.1:15926(IPMC_BACKEND_PORT)
   2. collectTail(logFilesForTail())            → electron.log / backend.log 尾部(原始字节)
   3. environment.json = {app_version, hostname, os_username, platform, arch}
   4. zipEntries([ {name:`session-<id>.sqlite`, data}, {name:'environment.json', data}, ...logTails ])
   5. uploadLogs({ endpoint: updateConfig.telemetryUrl,
                   fields: clientFields('session_report', {session_id, user_note: note||''}),
                   archive: {name:'session-report.zip', data: zip} })
        │
        ▼
[现有 POST /logs(服务端零改动)] → 管理员下载 → 取出 .sqlite 置换进 viewer 回放
```

组件(5 个单元):

1. **后端导出模块** `src/ipmastercowork/observability/session_export.py`:§3.2 的 `export_session_db`。纯数据,可单测。
2. **后端路由** `src/ipmastercowork/api/sessions.py` 加 `GET /{session_id}/export`(挂在现有 `/api/v1/sessions` 路由下),返回 `Response(content=bytes, media_type="application/octet-stream")`;会话缺失 → 404。约 10 行。
3. **electron IPC** `electron/main.js`:`ipcMain.handle('report-session', async (_e, sessionId, note) => {...})`,复用 Phase B 的 `zipEntries`/`collectTail`/`uploadLogs`/`clientFields`/`logFilesForTail`。无单测(wiring)。
4. **preload** `electron/preload.js`:`reportSession: (sessionId, note) => ipcRenderer.invoke('report-session', sessionId, note)`。
5. **前端** `frontend-desktop`:`ReportSessionButton`(会话头部图标 → 确认框 + 明确同意文案 + 可选备注 textarea + 内联状态;i18n zh/en;沿用现有内联 overlay,不引 toast 库)。

## 5. Phase A 适配要点(失败事件流,纯客户端)

**埋点机制(关键修订,源于写 plan 时的实仓勘探):** 本仓失败不是 host 级 `try/except`,而是 **core 的 EventBus 事件**(`StepFailed` / `TaskFailed` 等,payload 含 `error_code=<异常类名>` / `error_message`)。MCP/skill 的 capability 失败当前以 `CapabilityEvent(kind="error")` 吸收进 tool 结果,**未成独立事件**(`CapabilityFailed` 在 core 已定义但未使用)。core 在上游演进,host 改动须落 `src/ipmastercowork/`——因此**不在 core 逐调用点插 `emit()`**,改为:

- 后端 `src/ipmastercowork/observability/events.py::emit(event_type, **extra)`:append 到**实仓数据目录** `paths.data_dir() / "telemetry-spool.jsonl"`(`from ipmastercowork.paths import data_dir`;打包态 = `IPMC_DATA_DIR` = `%APPDATA%\IPMaster-Cowork\data`),每次 open-append-close(不持长 fd,electron 用 rename 接管),写 `{event_type, ts, **extra}`,**异常全吞**(遥测绝不影响业务)。
- 后端 `src/ipmastercowork/observability/telemetry_subscriber.py`:一个 **EventBus 订阅者**(仿 `persistence/event_persister.py` 的 `on_event(event)` 形态),在 `api/main.py` lifespan 经 `runtime.event_bus.subscribe(...)` 注册;过滤失败事件类型(`StepFailed`/`TaskFailed`,后续可扩),映射为 `emit("step_failed"/"task_failed", error_code=…, error_message=…, session_id=…)`。**零 core 改动、集中**。
  - **已知粒度取舍**:MCP/skill 的 capability 失败只能随 step/task 粗粒度捕获,拿不到 `server`/`tool` 明细;若将来要明细,另起一个小 plan 给 core 回灌"真正发 `CapabilityFailed`"的 seam(本期不做)。
  - 事件只带错误类别与元数据(`error_code`/`error_message`/`session_id`/`task_id`),**不带用户内容**(prompt/对话不入事件流)。
- electron 侧生命周期事件:`backend_crash`(后端非 0 退出)/`renderer_crash`(`render-process-gone`)/`backend_start_duration`,在 main.js 既有进程管理处上报。
- electron 通道改造:`buildEvent` 扩展 `hostname`/`os_username`(本仓 `telemetry-core.js` 现无,需加 `const os = require('os')`),加 `tailString`;启动 + 每 30s `rename-then-read` drain spool(`spool.js`,纯逻辑,fs 可注入)合入现有 reporter。`extra` 后展开使后端 `ts` 胜出 `ctx.now()`。
- 前置修缮:`electron.log` 启动轮转(>2MB → `.1`,在 `openElectronLog()` 的 `mkdirSync` 与 `createWriteStream` 之间插入);`.env` 缺 `IPMC_LOG_DIR` 自愈 —— **复用现有 `electron/lib/env-reconcile.js`**:`IPMC_LOG_DIR` 已在 `envPathVals()` 的 canonical 集合里(policy=`path`),`reconcileUserEnv()`(版本门控)已会补缺失键,**无需新建 `env-heal.js`,也无需改 reconcile**。

## 6. Phase B 适配要点(日志上传 + 指令轮询)

移植旧仓 zip-bundle 版(单 zip,非逐文件 gz):
- `electron/lib/zip.js`:零依赖 DEFLATE zip 写入器(`crc32` + `zipEntries` over `zlib.deflateRawSync`);固定 DOS 时间(沙箱禁 `Date.now()`,zip mtime 无业务意义)。
- `electron/lib/log-bundler.js`:`tailFileSync` + `collectTail`(crash,每文件尾 256KB,原始字节)+ `collectFull`(requested,newest-first 累加至 `maxTotalBytes`,溢出文件尾部截断后丢更旧;原始字节上限选得让 zip 稳在服务端 20MB 内)。
- `electron/lib/log-uploader.js`:`uploadLogs({endpoint, fields, archive})` → `POST {endpoint}/logs` multipart,单个 `files` 部件,**失败静默返回 false**(过大不入 200 条队列;requested 靠下个轮询、crash 靠下次崩溃)。
- `electron/lib/commands.js`:`parseCommands`(筛 `upload_logs`)/ `commandsUrl` / `ackUrl`。
- main.js wiring:崩溃自动传日志尾(reason=crash,模块级 `crashUploadDone` 守卫每会话一次);启动 + 每 10 分钟轮询 `GET /clients/{install_id}/commands` → `collectFull` → upload(reason=requested) → `POST .../commands/{id}/ack`。
- 日志文件:`{IPMC_LOG_DIR}/electron.log` + `ipmastercowork.log`(+ 昨日 `.YYYY-MM-DD` backup,按后端 `TimedRotatingFileHandler` 本地日期命名)。

**依赖顺序:Phase C 复用 B 的 `zip.js`/`collectTail`/`uploadLogs`/`clientFields`,故 B 必须先于 C。**

## 7. 上传契约(与服务端,零改动)

`POST {telemetryUrl}/logs`,multipart/form-data,沿用旧 spec §5.3:

| 字段 | reason 取值 | 说明 |
|------|------------|------|
| `install_id`/`app_version`/`hostname`/`os_username` | 全部 | 客户端公共字段 |
| `reason` | `crash` / `requested` / `session_report` | 触发类型 |
| `command_id` | requested | 回带指令 id |
| `session_id` / `user_note` | session_report | 会话 id + 用户备注 |
| `files` | 全部 | **单个 zip**:`logs-crash.zip` / `logs-requested.zip` / `session-report.zip` |

服务端仍按 `files[]` 收一个 blob 存档;`session_report` 的 zip 内含 `session-<id>.sqlite` + `environment.json` + 日志尾。**本仓不改服务端**;若服务端需为 `reason=session_report` 单独标注 `session_id`/`user_note`,把契约发并行会话(同旧仓)。

## 8. 测试策略

- **后端(`uv run pytest`)—— 新设计核心**:`export_session_db` —— 造含多表行的目标会话 + 另一会话的干扰行 → 导出 → 用 `sqlite3`/SQLAlchemy 打开导出文件,断言:(a) 仅含目标会话的行,(b) 七张表 schema 完整,(c) 不含 `agent_templates`,(d) `events` 行可重放(字段齐全);会话不存在 → 404。
- **electron 纯逻辑(`node:test`,依赖注入)**:`zip.js`(crc32 已知向量 + node 往返解压 + win32 `Expand-Archive` 真解压)、`log-bundler`(collectTail/collectFull、缺失跳过、截断)、`log-uploader`(单 archive、失败静默)、`commands`(解析、ack URL)、`telemetry-core`(buildEvent 扩展 hostname/os_username、tailString、后端 ts 胜出)、`spool`(parse、rename-then-read drain、.draining 恢复)。
- **wiring**(drain / 崩溃上传 / 指令轮询 / report-session IPC):无单测,靠 `node --check` + 手工打包 E2E。
- **手工打包 E2E**(需安装态 + 真实服务端):各 reason 的上传可在服务端下载;`session-report.zip` 解压含 `session-<id>.sqlite`,该 sqlite 置换进 viewer 能回放;崩溃自动包、requested 包、正常退出不误传。

## 9. 分解为实施计划

一份本 spec,拆三个独立 plan(各自 spec→plan→实现,与旧仓一致):

1. **Plan A** — Phase A 事件流(后端 `emit()` + host EventBus 订阅者 + spool + electron drain + buildEvent 扩展 + electron 生命周期事件 + 前置修缮)。纯客户端,服务端零改动。
2. **Plan B** — Phase B 日志上传 + 指令轮询 + zip 写入器(`zip.js`/`log-bundler`/`log-uploader`/`commands` + wiring)。
3. **Plan C** — 会话 SQLite 导出 + 上报 UI(`session_export.py` + 路由 + IPC + preload + `ReportSessionButton`)。**依赖 B**。

发版按 CLAUDE.md 打包原则:落地后打包前先 bump 版本号;手工 E2E 在安装态执行。

## 10. 隐私与安全声明

- 遥测含设备与账号标识(hostname/os_username),为实名内部支持系统;
- 运行日志可能含文件路径、工作目录名、任务标题;
- 会话 SQLite 含完整对话内容,**仅经用户主动"上报此会话"上传**;
- 所有上传仅发往内网管理服务(`updateConfig.telemetryUrl`),不出内网;
- 以上写入用户可见的发布说明。
