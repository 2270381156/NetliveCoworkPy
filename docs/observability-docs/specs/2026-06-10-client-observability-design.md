# 客户端观测与日志上报系统 — 设计 Spec(0.3.x)

> 状态:草案,待 review
> 日期:2026-06-10
> 关联:`2026-05-28-desktop-auto-update-design.md`(更新系统;本系统复用其遥测通道与管理服务)
> 实现分工:客户端(本仓)+ 管理服务端(并行会话,以本 spec 第 6 节契约为准)

## 1. 背景与目标

更新系统已建立客户端 → 管理服务的遥测通道(install-id、事件上报、离线队列),目前仅上报
4 个更新相关事件。内网 beta 运营中暴露两类排障痛点:

1. **被动发现**:客户端崩溃、MCP 超时(如 30s 不够的问题)、LLM 调用失败等,只能等用户报障;
2. **取证困难**:用户报障后,要远程指导用户在 AppData 里找日志文件发过来,摩擦大。

**目标**:
- G1 客户端把"出事了"变成结构化事件自动上报(崩溃、MCP/LLM/skill 失败、性能基线);
- G2 崩溃时自动附带运行日志尾部;
- G3 管理端可对指定安装按需拉取完整运行日志(用户无感);
- G4 用户可主动"上报此会话",把单个会话的人机交互日志连同运行日志上传(用户点击=明确同意);
- G5 后台可按"人"检索(主机名/系统用户名),支撑"张三说挂了→找到他的 install-id→拉日志"的支持流程。

**非目标**:
- 指标/链路追踪(Prometheus/OTel 等)— 不做;
- 交互日志的自动/全量上传 — 不做(仅 G4 的用户主动单会话上报);
- 客户端远程配置下发 — 不做(指令机制仅支持 `upload_logs` 一种);
- 脱敏 — 不做(内网内部工具),但第 8 节作知情声明。

## 2. 总体架构

```
┌─ Python 后端 ──写──► %APPDATA%/IPMaster-Cowork/data/telemetry-spool.jsonl ─┐
├─ 渲染进程(IPC: observability:report)────────────────────────────────────┤
├─ electron 主进程自身事件(崩溃监视/启动耗时)───────────────────────────────┴─►
│                                                                            │
│   electron reporter(现有:离线队列 ≤200 条,telemetry-queue.json 落盘)      │
│        │                                                                   │
│        ├──► POST {base}/events          (现有端点,事件流)                  │
│        ├──► POST {base}/logs            (新:日志包上传)                    │
│        └──► GET  {base}/clients/{install_id}/commands  (新:指令轮询)       │
│                                                                            │
└─ 管理后台:客户端列表(hostname/username/IP/last-seen)、置"拉日志"标记、日志浏览
```

通道配置复用现有三级:env `IPMASTER_COWORK_TELEMETRY_URL` > `update-config.json` > 内置默认
(`http://10.25.228.203:8077`)。

## 3. 用户标识模型

| 字段 | 来源 | 角色 |
|------|------|------|
| `install_id` | 现有,AppData 持久化 GUID | **主键**,永不变 |
| `hostname` | `os.hostname()`,每次上报自动附带 | 人可读标签 |
| `os_username` | `os.userInfo().username`,自动附带 | 人可读标签(内网≈域账号) |
| 来源 IP | 服务端从 HTTP 连接获取,**客户端不上报** | 辅助信息(DHCP/VPN 下不可靠,不作身份) |
| `display_name`(可选,Phase C) | 设置页手填姓名/工号 | 补充标签 |

> 声明:引入 hostname/os_username 后,本遥测体系为**实名的内部支持系统**,不再宣称匿名。

`buildEvent` 的公共字段从现有 `{event_type, install_id, app_version, channel, os, arch, ts}`
扩展为追加 `{hostname, os_username}`。

## 4. 事件流

### 4.1 事件清单

| event_type | 来源 | 附加字段 |
|------------|------|---------|
| `backend_crash` | electron(现有 exit 监视) | `exit_code`, `stderr_tail`(≤4KB) |
| `renderer_crash` | electron `render-process-gone` | `reason`, `exit_code` |
| `mcp_call_failed` | 后端 spool | `server`, `tool`, `error_class`, `duration_ms` |
| `mcp_call_timeout` | 后端 spool | `server`, `tool`, `timeout_s`, `error_class`, `duration_ms` |
| `llm_call_failed` | 后端 spool | `provider`, `model`, `error_class`, `status_code?`, `stream?` |
| `skill_exec_failed` | 后端 spool | `skill`, `script`, `error_class`, `error_code` |
| `backend_start_duration` | electron | `duration_ms` |
| `app_launch` / `update_*` ×3 | 现有 | 不变 |

错误事件只带**错误类别与元数据**,不带用户内容(prompt/文档内容不入事件流)。

### 4.2 spool 文件契约(后端 → electron)

- 路径:`{data_dir}/telemetry-spool.jsonl`(data_dir 即现有 AppData data 目录);
- 格式:一行一个 JSON 对象 `{event_type, ts, ...extra}`(公共上下文由 electron 合并时补全,
  后端不需要知道 install-id/channel);
- 后端职责:仅 append(带文件锁或单写者假设——backend 单进程,成立);写失败静默丢弃,
  **绝不因遥测影响业务**;
- electron drain:启动时 + 每 30s。协议:`rename(spool, spool.draining)` → 逐行解析 →
  合入现有队列(继承 200 条上限) → 删除 `.draining`。rename 原子性保证不丢后端并发写
  (写者持旧 fd 继续写会写入新 inode?——Windows 上 rename 打开中的文件会失败,因此后端
  采用**每次 append 即开-写-关**,不持长 fd);
- 解析失败的行丢弃并计数(`spool_parse_errors` 可观测自身)。

### 4.3 后端埋点位置

- MCP:`_MCPProviderBase._run_sync` 的超时/异常路径(`app/tools/mcp_base.py`);
- LLM:adapter 调用异常路径(`app/llm/*_adapter.py` 公共包装);
- skill:`exec_skill_script` 抛出异常(`app/tools/` 对应工具);非零退出由 source 层吸收为 `ToolResult(is_error=True)`，不进入异常路径。
- 统一经一个轻量 `app/observability/events.py::emit(event_type, **extra)` 写 spool,
  内部 try/except 全吞。

## 5. 日志上报

### 5.1 三种触发

| 触发 | 内容 | 大小限制 | 同意模型 |
|------|------|---------|---------|
| A. 崩溃自动 | electron.log 尾部 + 后端日志尾部 | 每文件 ≤256KB,gzip | 隐式(仅运行日志) |
| B. 管理端按需拉取 | 运行日志**全量**(当天 + 前一天) | gzip 后 ≤10MB | 管理员发起,用户无感 |
| C. 用户"上报此会话" | 该会话交互日志(JSON 导出)+ 运行日志尾部 | gzip 后 ≤10MB | **用户点击=明确同意** |

交互日志**只**经触发 C 出客户端;A/B 永不包含。

### 5.2 指令轮询(触发 B 的机制)

- 客户端:**启动时 + 每 10 分钟**(`setInterval(_, 10*60*1000)`;原拟"与 updater 对齐",但 updater 实测仅启动时 check 一次,故定为固定 10 分钟 —— 见 §9 实现注),
  `GET {base}/clients/{install_id}/commands`;
- 响应:`{"commands": [{"id": "...", "type": "upload_logs"}]}`(空数组=无事);
- 客户端执行后 `POST {base}/clients/{install_id}/commands/{id}/ack`,服务端清标记;
- 失败重试:下个轮询周期自然重试,无需额外机制。

### 5.3 上传契约

`POST {base}/logs`,multipart/form-data:

| 字段 | 类型 | 说明 |
|------|------|------|
| `install_id` / `app_version` / `hostname` / `os_username` | text | 同事件公共字段 |
| `reason` | text | `crash` \| `requested` \| `session_report` |
| `command_id` | text? | reason=requested 时回带 |
| `session_id` / `user_note` | text? | reason=session_report 时:会话 ID + 用户可选备注 |
| `files` | file | **已改为单个 zip(DEFLATE),非逐文件 gzip** —— 见下方注。 |

> **⚠️ 已被取代(2026-06-11):** 本表原写的"`files[]` 多个 `.gz`"已废弃。现为**单个 zip** 部件(字段名 `files`,
> 命名 `logs-crash.zip` / `logs-requested.zip` / `session-report.zip`),内含原始文件名(无 `.gz`)的条目。
> 权威格式见 [`2026-06-11-log-zip-bundle-design.md`](2026-06-11-log-zip-bundle-design.md);session_report 的 zip 内
> data 子目录布局见 [`2026-06-11-phase-c-session-report-design.md`](2026-06-11-phase-c-session-report-design.md)。
> 服务端零改动(仍走 `files` 多部件,只是变成一个文件)。

### 5.4 "上报此会话"(触发 C)客户端实现

- UI:会话界面头部菜单加"上报此会话"项 → 弹确认框(说明将上传该会话全部对话内容 +
  可选备注输入)→ 确认即上传,完成后 toast 提示;
- 数据:后端新增本地端点 `GET /api/v1/sessions/{id}/export`(返回该会话 messages/tool_calls
  的结构化 JSON;复用现有存储读取,不新增持久化);
- electron 经 preload 暴露 `reportSession(sessionId, note)`,主进程取导出 + 日志尾部,打包上传。

## 6. 与现有日志/存储格式的兼容性(零迁移)

本方案**不改变任何现有日志与存储的格式**;客户端零格式迁移。

### 6.1 现有运行日志:格式不变

| 文件 | 现状 | 本方案的改动 |
|------|------|-------------|
| `electron.log` | `[ISO时间] 自由文本` 行 | **仅加轮转**(>2MB 滚动到 `.1`)— 文件管理行为,不改内容格式 |
| `ipmaster-cowork.log`(后端) | Python logging 标准格式,按天滚动 | **完全不动** |

上传即把文件**原样 gzip**;服务端按收到的原文归档。人工查日志的习惯与既有工具不受影响。

### 6.2 事件流:新格式,但是瞬态传输队列,不是日志存储

`telemetry-spool.jsonl` 是新文件(一行一个 JSON),定位为**传输队列**:后端 append →
electron 30s 内 drain → **读完即删**;正常情况下该文件接近空。

**为什么不从运行日志解析事件,而单独走结构化通道**:解析自由文本日志脆弱(格式漂移、
多行堆栈、本地化文案);结构化 emit 字段稳定、永不误判。两者职责不同 —— **日志给人看,
事件给机器聚合**。代价仅是后端失败路径多一行 `emit(...)`,完全不碰 logging 体系。

### 6.3 交互日志:不新建存储,导出时现做

会话的 messages / tool_calls **本来就持久化**于后端 data 目录(现有 JSON 存储)。
`GET /api/v1/sessions/{id}/export` 只是把现有数据**实时序列化**为导出 JSON 直接上传 ——
不落盘、不改变现有 session 存储格式。导出 schema(5.4)是"传输视图",非存储格式。

### 6.4 新存储仅在服务端

真正的新增存储只发生在管理服务端(日志包按 `install_id/日期` 归档、事件入服务端库),
本来就是新建的,不存在兼容问题。将来若把运行日志本身结构化(JSON logs),属独立改造,
本方案不依赖、也不阻碍。

## 7. 服务端契约(并行会话实现)

新增:
1. `POST /logs` — 5.3 契约;存储按 `install_id/日期/` 归档;**保留期 14 天**自动清理;
2. `GET /clients/{install_id}/commands` + `POST .../commands/{id}/ack`;
3. 管理后台:
   - 客户端列表:install_id、hostname、os_username、最近来源 IP、最近活跃时间、版本
     (由 /events 与 /logs 的上报聚合);支持按 hostname/username 模糊搜索;
   - 对单个客户端按钮"请求日志" → 创建 `upload_logs` 指令;
   - 日志包列表/下载;会话上报(reason=session_report)单独标记并展示 user_note。
4. `/events` 兼容新增字段(hostname/os_username 及各事件 extra),无 schema 强校验拒绝。

鉴权沿用现有 admin Bearer;客户端侧端点(/events、/logs、commands)与现状一致**不鉴权**
(内网信任模型,与更新 feed 相同)。

## 8. 前置修缮(随 Phase A 落地)

1. **electron.log 轮转**:现为 `flags:'a'` 无限增长(实测已 938KB)。改为:启动时若 >2MB,
   滚动为 `electron.log.1`(保留 1 代,旧的覆盖);
2. **验证打包态后端文件日志**:代码链路已通(`init_logging(level, log_dir)`,.env 指向
   AppData\logs),但需在安装态确认 `ipmaster-cowork.log` 实际生成——若 .env 模板缺
   `IPMASTER_COWORK_LOG_DIR` 行则补上。

## 9. 隐私与安全声明

- 遥测含设备与账号标识(hostname/os_username),为实名内部支持系统;
- 运行日志可能含文件路径、工作目录名、任务标题;
- 交互日志含完整对话内容,仅经用户主动"上报此会话"上传;
- 所有上传仅发往内网管理服务(默认 `10.25.228.203:8077`),不出内网;
- 以上写入用户可见的发布说明。

## 10. 版本与分支

- 目标线 **0.3.x**;从 `master` 切 `feature/client-observability`;
- 服务端与客户端以本 spec 为契约并行开发,联调后合入;
- 发版遵循 CLAUDE.md 打包原则(每次打包必先 bump 版本号)。

## 11. 分期与验收

**Phase A — 事件流(纯客户端,服务端零改动)**
- spool 契约 + 后端 emit + electron drain + 新事件 + 公共字段扩展 + 前置修缮 1/2;
- 验收:本机触发 MCP 超时/后端 kill,管理后台 /events 可见对应事件,断网期间事件不丢。

**Phase B — 日志上传与指令(需服务端)**
- 崩溃附日志、commands 轮询、POST /logs、管理后台客户端列表与拉取;
- 验收:后台对某 install_id 置标记 → 客户端两个轮询周期内完成上传 → 后台可下载;
  崩溃后自动出现 reason=crash 的日志包。

**Phase C — 会话上报 + 手填标签(可选)**
- "上报此会话" UI + sessions/{id}/export + display_name 设置项;
- 验收:点击上报后后台可见 session_report 包,含完整对话 JSON 与备注。

## 12. Phase B 客户端实现决策(addendum,2026-06-11)

§5/§7 是契约源,以下为客户端实现层的具体决策(brainstorm 定稿,服务端已就绪):

### 12.1 范围
- 本期实现触发 **A(崩溃自动)** + **B(管理端按需,经指令轮询)**;触发 C(会话上报)归 Phase C,不做。

### 12.2 模块划分(沿用 Phase A 纪律:纯逻辑入 `electron/lib/*.js` + node:test 单测,wiring 入 `main.js`)
| 文件 | 职责 | 契约 |
|------|------|------|
| `electron/lib/log-bundler.js` | 文件路径 + 模式 → `[{name, gzipBuf}]` | `tail` 模式每文件尾 256KB(crash);`full` 模式当天 `ipmaster-cowork.log` + 昨天 `.YYYY-MM-DD` backup + `electron.log`,合计 gzip ≤10MB(requested)。**超限截断规则**:逐文件 gzip 累加,超 10MB 时丢弃最旧(昨天 backup 优先丢),仍超则对最后纳入的文件保留尾部。gzip 用 node 内置 `zlib`;命名 `electron.log.gz`/`backend.log.gz`(§5.3) |
| `electron/lib/log-uploader.js` | `POST {base}/logs` multipart | Node18+ 全局 `FormData`/`Blob` + `fetch`;字段按 §5.3。**失败静默,不进事件离线队列**(日志包过大不适合 200 条队列;requested 靠下个轮询周期自然重试,crash 靠下次崩溃) |
| `electron/lib/commands.js` | 解析 `GET /clients/{id}/commands` 响应 + ack URL 构造 | 纯函数:返回待执行 `upload_logs` 指令列表;`POST .../commands/{id}/ack` 的 URL 拼接 |

### 12.3 main.js wiring
- **指令轮询**:启动时 + `setInterval(_, 10*60*1000)`(10 分钟)。fetch commands → 命中 `upload_logs` → bundle(full) → upload(requested) → ack。
  - (spec §5.2 原文"与更新检查同节奏";实测当前 updater 仅启动时 check 一次、无周期 interval,故本期明确采用 启动 + 每 10 分钟。)
- **崩溃自动**:在既有 `backend_crash` / `renderer_crash` 上报点旁,追加 bundle(tail) → upload(reason=crash)。**每 app 会话最多一次**:模块级 `crashUploadDone` 守卫,防 backend 崩溃-重启循环反复传大包(包内日志尾部本就含多次崩溃)。
- 全部经 `shouldReportTelemetry(updateConfig)` 开关;服务端 base 复用 `updateConfig.telemetryUrl`。

### 12.4 测试
- node:test 单测注入 `fetchImpl` / `fsImpl`:bundler(tail/full、≤10MB 截断、命名)、uploader(multipart 字段、失败静默)、commands(解析、ack URL)、crash rate-limit 守卫。
- 对真实服务端(默认 `10.25.228.203:8077`)留**手工 smoke**(非自动化):后台置 `upload_logs` 标记 → 10min 内客户端上传 → 后台可下载;kill backend → 出现 reason=crash 包。

### 12.5 非范围(本期不做)
- 不打包、不 bump 版本(发版属 0.3.0 动作,届时按 CLAUDE.md 原则先 bump)。
- 触发 C(会话上报)、`display_name` 设置项 → Phase C。
