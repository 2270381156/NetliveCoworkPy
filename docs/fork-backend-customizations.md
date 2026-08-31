# IPMaster‑Cowork Agent 后端 —— fork 定制 case 登记册

> 本文档**统一登记** sunpcn fork 在 **Python agent 后端（`app/`）** 上做过的所有定制
> case，供交接、复核与维护参考。每个 case 都标注**当前相对上游
> （XingLiyin/miniAgentsDemo）的状态**，即使已与上游收敛/已被上游采纳，也保留在册，
> 避免后续合并时「丢失记忆」或重复造轮子。

## 概述

- **基线**：上游 `upstream/master`（最近一次合并点 `0ddecca`，已含上游 *context
  organization redesign* + *HITL continuing‑round* 修复）。
- **当前版本**：`origin/master` @ `a12e1e4`，应用版本 **0.3.4**。
- **范围**：仅 `app/`（Python 后端）。Electron 客户端（更新系统、日志打包上报、
  会话上报按钮、文件预览渲染）与独立的上报服务器（`:8077`）不在本文档内。

### 状态图例

| 状态 | 含义 |
|------|------|
| 🟢 **当前差异** | 本仓 `app/` 现在仍与上游不同，是 fork 独有改动（`git diff upstream/master master` 可见）。 |
| 🔵 **已上游化** | 起源于本 fork，现已被上游采纳，两边**逐字节一致**，净差异里看不到，但仍是「我们的 case」。 |
| ⚪ **上游所有** | 该领域主体由上游维护，本仓仅在其上做了点状增强（已并入对应 case）。 |
| 🟡 **独立分支** | 曾在别的分支实现，**未并入**本 master 线，仅作历史登记。 |

一键复核**当前差异**（🟢 类）：

```bash
git diff --stat upstream/master master -- app/      # 文件级
git diff        upstream/master master -- app/      # 完整 diff
```

判断某文件是否已收敛（🔵）：`git diff upstream/master master -- <path>` 为空即一致。

---

## 汇总表

| # | case | 状态 | 涉及文件 | 关键提交 |
|---|------|------|----------|----------|
| 1 | 客户端观测事件 `emit()`（遥测 Phase A） | 🟢 当前差异 | `app/observability/events.py`（新增）、`app/llm/base.py`、`app/tools/mcp_base.py`、`app/tools/skill_executor.py` | `3181c2e` `cd2c9c5` `df92cc9` `9cb24ff` `01fc57c` |
| 2 | 会话导出 `GET /sessions/{id}/export`（用户主动上报 Phase C） | 🟢 当前差异 | `app/api/v1/routes/sessions.py` | `6c76af0` → `c8e4366` |
| 3 | 超长工具返回落盘（>32k offload） | 🟢 当前差异 | `app/runtime/tool_gateway.py`、`app/config/settings.py` | `367722c` |
| 4 | `bash_exec` OS 命令指引 + 中文编码/路径处理 | 🟢 当前差异 | `app/tools/builtins.py` | `367722c` `f4f3763` `ebe91da` `9f62141` |
| 5 | skill 脚本强制走 `exec_skill_script` | 🟢 当前差异 | `app/runtime/reasoner.py`、`app/tools/skill_executor.py` | `1b87c25` |
| 6 | SSL 企业 CA 信任（三层校验 + AIA 自动补链） | 🔵 已上游化 | `app/common/ssl_verify.py` + 多处调用点 + settings | `a69ea8d` `6d820a7` `12783e7` `af8361c` … |
| 7 | MCP 连接：失败/超时观测 + 超时配置 | 🟢/⚪/🟡 混合 | `app/tools/mcp_base.py`、`mcp_http_provider.py`、`mcp_service.py`、`skills/definition.py` | `cd2c9c5` `01fc57c`（本仓）；超时主体为上游 |
| 8 | skill 脚本活性监测超时 + 可靠终止（进程树 stdout/CPU/IO + idle/hard-cap + Job Object/进程组 + 杀后复核诚实上报，独立于 bash_exec）+ 进度 SSE | 🟢 当前差异 | `app/skills/script_runner.py`（新增）、`app/skills/sources.py`、`app/config/settings.py`、`pyproject.toml` | `4291ddc` `c1417b7` `4c06697` `3c67d2b` `323fd8c` `0e4c786` `3bff212` `fcedb56` `2e10698` |
| 9 | LLM 适配器：OpenAI 兼容供应商 chat 端点推断 + 非标准错误体兼容解析（+ add-model 500 修复） | 🔵 已上游化 | `app/llm/openai_adapter.py`、`app/llm/anthropic_adapter.py` | `963fbc2` |
| 10 | 品牌 + 内网部署配置（IPMaster 改名 + skill/更新服务器内网地址） | 🔵 已上游化 | `app/config/settings.py`、`app/main.py`、`app/observability/logging.py` | `ad89fb9` `06f0608` |
| 11 | 文件预览后端：预览大小上限 10MB→50MB | 🔵 已上游化 | `app/api/v1/routes/workspace.py` | `3381a64` |

> **净差异规模**（🟢 部分）：随 case 8 增加（新增 `app/skills/script_runner.py` + 改 sources/settings/pyproject）。用 `git diff --stat upstream/master master -- app/` 复核当前值。case 6/9/10/11 已收敛、不计入。
>
> **完整复核法（含已收敛项）**：`git log --no-merges --author=sunpcn --format="%h %s" master -- app/` 列出本仓**所有**后端提交（不止当前差异），逐条归入下列 case。

---

## 1. 客户端观测事件 `emit()`（遥测 Phase A）

**背景**：桌面客户端需要把后端运行中的失败事件（LLM 调用失败、MCP 超时/失败、
skill 执行失败）收集起来，由 Electron 统一上报到 `:8077` 服务器。后端本身**不**直接
发 HTTP，只负责把事件**追加写入一个本地 spool 文件**，由 Electron 接管上传。

**涉及文件**

- `app/observability/events.py`（**新增**）——核心 `emit(event_type, **extra)`：
  - 写入 `data_dir/telemetry-spool.jsonl`，**一行一个 JSON**（`{event_type, ts, **extra}`）。
  - **每次 open‑append‑close，不持长 fd**：Electron 用 `rename` 接管文件，Windows 上
    rename 一个被打开的文件会失败，所以后端绝不长期持有该文件句柄。
  - **任何异常静默吞掉**——遥测绝不影响业务流程。
  - 并发安全：NTFS 上单行 append 原子写入，行长远小于内核缓冲区，无需显式锁。
- 埋点调用点（仅在异常路径 `emit` 后 `raise`，不改变原有控制流）：
  - `app/llm/base.py` —— `complete()` 与 `stream_message()` 失败时 `emit("llm_call_failed", provider, model, error_class[, stream])`。流式用内部生成器包裹以捕获迭代期异常。
  - `app/tools/mcp_base.py` —— MCP 调用失败时，按 `error_class` 区分 `mcp_call_timeout`
    （`AppError.code == "MCP_CONNECT_TIMEOUT"`）与 `mcp_call_failed`，并带 `duration_ms`、
    `server`、`tool`、超时阈值 `timeout_s`。
  - `app/tools/skill_executor.py` —— `exec_skill_script` 失败时 `emit("skill_exec_failed", skill, script, error_class, error_code)`。

**契约**：见 `docs/superpowers/specs/2026-06-10-client-observability-design.md` §4.2。

**注意**：spool 文件落在 `data_dir`。安装从 NetLIVE 迁移而来时，`.env` 若缺
`IPMASTER_COWORK_DATA_DIR`，spool 会写到 exe 目录而非 AppData → 事件丢失；该问题由
Electron 侧的 `.env` 自愈逻辑修复（DATA_DIR 一并 heal），属客户端范畴。

---

## 2. 会话导出 `GET /sessions/{id}/export`（用户主动上报 Phase C）

**背景**：用户点击「上报此会话」时，需要把这次会话的**完整 `/data` 足迹**打包上传，
而不仅是一份合成 JSON。后端负责枚举并返回文件清单，Electron 负责打 zip。

**涉及文件**：`app/api/v1/routes/sessions.py` —— 新增 `export_session`：

- 返回 `{"files": [{"path": <相对 data 的 posix 路径>, "content": <文本>}]}`，
  客户端按 `data/<path>` 入 zip，**保持子目录结构**。
- 覆盖：`sessions/{id}.json`、`tool_calls/{id}.jsonl`、`event_logs/{id}.jsonl`、
  `agents|tasks|blackboard/{id}/**`、以及每个 agent 的 `memory/{agent_id}/**`
  （messages/summaries）。
- **安全**：**排除**含密/全局配置 —— `llm_configs`、`mcp_configs`、`agent_templates`
  （`llm_configs/*.json` 里有真实 `api_key`，绝不可外泄）。
- **健壮性**：逐文件 `try/except`，单个文件不可读/二进制则跳过，导出整体绝不因一个
  文件失败；会话不存在返回 404。

---

## 3. 超长工具返回落盘（>32k offload）

**背景**：部分工具（bash、HTTP、MCP 等）单次返回内容过长，会撑爆 LLM 上下文。
原逻辑是按字节**截断**（`http_response_limit_bytes`），信息直接丢失。

**涉及文件**

- `app/runtime/tool_gateway.py` —— 用 `maybe_offload_large_result(...)` 替换原步骤 ⑥ 的截断：
  - 文本结果 `len(content) > threshold` → **全文落盘**到
    `data/tool_outputs/{session_id|shared}/{tool_name}_{call_id}.txt`。
  - 返回一条**指针消息**替换 content：含「已落盘」「总字符数」「存储绝对路径」
    「前 2000 字符预览」，并提示 agent 可用 `read` 工具按需读取（支持绝对路径）。
  - 非字符串内容（多模态 list）或未超限 → 原样返回；落盘失败 → 退回截断并记日志。
  - 保留 `is_error / error_code / metadata`。
- `app/config/settings.py` —— 新增配置项
  `tool_result_offload_threshold_chars: int = 32_768`（环境变量
  `IPMASTER_COWORK_TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS` 可覆盖）。

**测试**：`tests/test_tool_offload.py`。

---

## 4. `bash_exec` 操作系统命令指引

**背景**：`bash_exec` 在 Windows 下经 `subprocess.run(shell=True)` 实际走 **cmd.exe**，
但工具名「bash_exec」+ 模型先验导致它惯性发 `ls/grep/cat`，在 cmd.exe 下报
「is not recognized」。

**涉及文件**：`app/tools/builtins.py` —— 模块加载时按当前 OS 把指引写入**两处**：

- `_bash_os_hint()` → 追加到 `bash_exec.description`。
- `_bash_command_param_hint()` → 追加到 **`command` 参数描述**。这是杠杆最高的提示位
  （随工具 schema 直发模型、且**不会被 `resource_summarizer` 压缩**）。
- Windows：明确指引 `dir/type/findstr/where/del/copy/%VAR%` 或
  `powershell -NoProfile -Command "..."`，并点名 `ls/grep/cat/which/rm` 不可用；
  其他系统：仅声明 `Host OS: <name> (POSIX sh/bash)`。

> 设计权衡：曾考虑在执行端探测 Git Bash/WSL 真 bash，但因目标机不保证安装、且
> `system32\bash.exe` 实为 WSL（Linux VM，Windows 盘符路径不通）有风险，最终选择
> **保持 cmd.exe 执行 + 强提示强制原生命令**。

**0.3.6 补充：中文编码 + 路径处理（提交 `9f62141`）** —— 解决 Windows 下中文乱码与路径转义：

- **中文输出乱码修复**：子进程不再用 `text=True`，改抓 **raw bytes**，按
  `utf-8 → gbk → utf-8(replace)` 顺序试解（Windows 控制台默认 GBK）；并设
  `env["PYTHONIOENCODING"]="utf-8"` 让子 Python 主动吐 UTF-8。（pwsh 7 默认 UTF-8 不受影响；
  **PowerShell 5.1 仍需**在命令里加 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new();`）。
- **路径引导**：`command` 参数描述新增「Windows 路径用单反斜杠 `D:\foo\bar` 或正斜杠
  `D:/foo/bar` 均可，**不要 double-escape**」，并建议调 PowerShell 时开头加上 OutputEncoding 设置。
- **诊断**：`logger.info("bash_exec command (repr): %r", command)` 用 `repr()` 暴露反斜杠数量，
  便于事后 grep 追踪 `\\\\+` 的真实来源。

**测试**：`tests/test_bash_os_hint.py`（含 command 参数的路径/编码引导断言）。

---

## 5. skill 脚本强制走 `exec_skill_script`

**背景**：许多第三方 skill 的 `SKILL.md` 直接写「`python scripts/foo.py`」，但 skill
文件并不在 agent 的 `working_dir`（本地在 AppData、远端根本不在本地磁盘），直接
`python/bash` 跑相对路径必然找不到。系统已提供 `exec_skill_script` 工具（按 skill 根
解析路径、设 `SKILL_DIR` 环境变量），但 `SKILL.md` 正文是**原样注入** prompt 的，没有
任何环节告诉 agent 必须用工具。

**涉及文件**

- `app/runtime/reasoner.py` —— 新增 `_SKILL_SCRIPT_RUNTIME_NOTE` + `_wrap_skill_instructions()`：
  在每个 skill instructions **正文之后**追加运行时说明（recency 最强，覆盖 SKILL.md 里
  的「直接 python」指引）：凡 SKILL.md 提到的脚本，**一律**用
  `exec_skill_script(script_path='scripts/foo.py', args='...')`；读文件用
  `load_skill_reference`，列文件用 `get_skill_files`；不要自行拼绝对路径。
  本地/远端 skill 同样适用，符合「用工具、不暴露路径」的设计。
- `app/tools/skill_executor.py` —— 修正 `exec_skill_script` 工具描述：原文案误称
  「working directory is set to the skill root」，实际 **cwd 是 task 工作目录**，skill 根
  仅通过 `SKILL_DIR` 环境变量暴露；同时强调「任何脚本都用本工具，别直接 python」。
  （另：该文件也含特性 1 的 `skill_exec_failed` 埋点。）

**测试**：`tests/test_skill_script_runtime_note.py`。

---

## 6. SSL 企业 CA 信任（三层校验 + AIA 自动补链）

> **状态：🔵 已上游化** —— `app/common/ssl_verify.py`（811 行）由本 fork（`sunpcn`，
> 12+ 次 `feat(ssl)` 提交）从零实现，现已被上游采纳，两边**逐字节一致**，故不在当前
> 净差异里。仍登记在册：这是「我们的 case」，后续若上游改动需对照本节。

**背景**：内网/企业 SSL 中间人代理的根 CA 往往不在 certifi，且证书 SAN 常不含访问用的
IP，导致 httpx/MCP/skill 拉取全部握手失败。`truststore` 走 Windows Schannel 在缺 EKU
的企业 CA 上会报 `CERT_E_UNTRUSTED_ROOT`，不可用。于是自研一套基于 pyOpenSSL +
`cryptography` 的校验方案。

**入口**：`make_ssl_verify()`（`@lru_cache`，返回 `bool | ssl.SSLContext | str`）+
`with_ssl_retry(do_request, url)`（被动重试补链）。

**三层优先级**（见文件头注释 §Priority）：

1. `http_ssl_verify=false` → 返回 `False`，完全跳过校验（仅调试）。
2. `http_ca_bundle` 已设 → base context + 逐条加载 bundle（**多条目**，`;` 分隔，
   条目可是文件路径**或**可下载 URL；URL 下载后缓存到 AppData）。
3. 默认 → base context 自动装载 **OS / Windows 注册表 / 环境变量 CA bundle
   （`SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE` 等）/ AppData 已缓存 CA**；握手仍失败时由
   `with_ssl_retry` **被动触发 AIA 抓链**：解析证书 AIA CA‑Issuers URL → 下载缺失中间
   /根 CA（支持 DER/PEM/PKCS7）→ 补全到自签根 → 重试。

**关键设计点**

- **抓链取完整链**：未校验探测用 `get_unverified_chain` 拿到对端呈现的完整链。
- **缓存防投毒**：抓到的 CA 先放**内存 overlay**，仅在**重试成功**后才落 AppData 持久
  缓存（cache‑on‑success）；重试失败回滚 overlay，避免伪造 AIA 响应污染缓存。
- **主机名自动放宽**：`http_check_hostname=false` 时仍校验 CA 链，但跳过 host/IP 匹配；
  重试路径在 IP/hostname 不匹配时自动放宽（内网按 IP 访问网关场景）。
- AppData 缓存目录按 CA 的 SHA‑256 指纹命名 `*.der`。

**配置项**（`app/config/settings.py`）：`http_ssl_verify`（默认 `False`）、
`http_ca_bundle`、`http_check_hostname`（默认 `True`）、`use_system_truststore`
（默认 `False`，显式开启才用 truststore）。

**调用点**：`app/llm/transport_httpx.py`、`app/tools/mcp_http_provider.py`、
`app/skills/skill_store_client.py`、`app/domain/services/skill_pull_service.py`、
`app/api/v1/routes/llms.py`、`app/config/settings.py`。

**设计文档**：`docs/superpowers/specs/2026-06-09-ssl-corporate-ca-design.md`。
**关联记忆**：`[[ssl-verify-design]]`。

---

## 7. MCP 连接：失败/超时观测 + 超时配置

> **状态：🟢/⚪/🟡 混合** —— 须分清本仓与上游的边界，避免合并时误判归属。

MCP 连接栈的**主体（连接、重连竞态、stdio 注册、超时参数）由上游（`Codex`）维护**，
本 fork 只在其上做了**观测分类**这一处增强。本节把三块讲清，便于统一管理：

- **🟢 本仓：MCP 失败/超时观测分类**（属 case 1 的一部分）
  `app/tools/mcp_base.py` 在 MCP 调用异常路径 `emit()`：按
  `AppError.code == "MCP_CONNECT_TIMEOUT"` 区分 `mcp_call_timeout` 与
  `mcp_call_failed`，并带 `server`、`tool`、`error_class`、`duration_ms`、超时阈值
  `timeout_s`。提交：`cd2c9c5`、`01fc57c`。这是当前差异，详见 **case 1**。

- **⚪ 上游：超时/连接管理**
  `_MCPProviderBase.__init__(request_timeout=30, connect_timeout=5)`；HTTP/stdio provider
  默认 `timeout=30`（`mcp_http_provider.py` / `mcp_provider.py`）；`mcp_service.py`、
  `app/skills/definition.py`(`mcp_timeout=30`) 均默认 **30s**，且每个 MCP 配置可经
  `timeout` 字段覆盖。HTTP MCP 客户端 `verify=make_ssl_verify()` —— 与 **case 6** 集成。
  这些**不是** fork 改动，登记于此仅为划清边界。

- **🟡 历史：MCP 超时下限 30→60s hotfix**
  曾在**独立分支 `hotfix/0.1.x`** 实现（单一来源 `DEFAULT_MCP_TIMEOUT` +
  `_migrate_timeout_floor` 抬升已持久化配置），**未并入本 master 线**——当前 master 中
  **不存在**该常量/迁移，默认仍是 30s。如需该能力须重新移植。

**复核**：`git grep -n "DEFAULT_MCP_TIMEOUT\|_migrate_timeout" master -- app/` 应为空
（确认未在本线）；`git diff upstream/master master -- app/tools/mcp_base.py` 仅显示观测埋点。

---

## 8. skill 脚本活性监测超时 + 可靠终止

> **状态：🟢 当前差异**

**背景**：本地 skill 脚本原走 `subprocess.run(shell=True, timeout=30)`。两个问题：①固定 30s
墙钟分不清「慢但健康」（大 docx/OCR/转换合法地要几分钟）与「卡死」；②**实测确认**超时只
`kill` cmd.exe，真正干活的 `python script.py` 孙进程**变孤儿继续跑**；③skill 与 `bash_exec`
共用 `bash_exec_timeout_ms`，调一个动两个。

**入口**：`app/skills/script_runner.py`（新增）的
`run_with_liveness(command, *, cwd, env, idle_timeout_sec, hard_cap_sec, output_limit_bytes,
poll_interval_sec=1.0) -> RunResult`；`LocalFileSkillSource.exec_script`
（`app/skills/sources.py`）改调它。

**实现要点**

- **活性 = 三信号 OR**：`made_progress()` 比较两次 `LivenessSample(output_bytes, cpu_seconds,
  io_bytes)`，任一增长即「在干活」。覆盖 打印型(stdout)/静默计算型(CPU)/**写文件型(写盘字节)**。
- **按进程读、遍历进程树**：`collect_tree_metrics(pid)` 只用 `psutil.Process(pid)` 自己的
  `cpu_times()/io_counters()`（绝不读系统全局，隔绝其它应用），并 `children(recursive=True)`
  覆盖脚本 spawn 的 soffice/ffmpeg。
- **可靠终止**：`popen_contained` 用 **Windows Job Object `KILL_ON_JOB_CLOSE`**（ctypes，
  无新依赖）/ **POSIX 进程组**（`start_new_session`+`killpg`）原子杀整树；`terminate_tree`
  再用 psutil **杀后复核 + 重试**，返回 `TerminationResult(clean, survivors)`。
- **只报已核实状态**：`exec_script` 据 `terminated_clean` 如实区分「process tree terminated」
  与「WARNING: N process(es) may still be running…outputs may be partial」，**绝不谎报已杀**。
  `run_with_liveness` 用 `try/finally` 兜底，任何路径不留可达孤儿。
- **解耦**：新增 `skill_exec_idle_timeout_sec=90` / `skill_exec_hard_cap_sec=600`
  （`app/config/settings.py`），`bash_exec_timeout_ms` 不再被 skill 路径使用。
- **保留遥测**：idle/hard_cap 仍 `raise AppError("TOOL_TIMEOUT")`，上层 `exec_skill_script`
  的 `emit("skill_exec_failed")` 不变。

**新依赖**：`psutil>=5.9.0`（`pyproject.toml`）。

**0.3.6 补充：执行进度 SSE（提交 `fcedb56`、`2e10698`）** —— 给前端 ActivityStrip 喂实时进度：

- `run_with_liveness` 新增可选 `on_progress: Callable[[LivenessProgress], None]`，每个 poll tick
  末调用一次，传 `LivenessProgress` 快照（`elapsed_sec`、`output_bytes`、
  `idle_remaining_sec=max(0, idle_timeout-(now-last_alive))`、
  `hard_cap_remaining_sec=max(0, hard_cap-elapsed)` 等）。
- `2e10698` 修正：回调在**杀树那一 tick 也触发**（`idle_remaining`/`hard_cap_remaining` 可报 0），
  让前端能显示倒计时归零的最后一帧。
- `LocalFileSkillSource.exec_script` 把回调接成 `_emit_progress`，经
  `get_sse_bus().push(session_id, {"type": "script_progress", ...})` 推送（回调/推送异常只
  `logger.debug`，绝不影响脚本执行）。前端据此显示「已运行 Xs / 已输出 Y 字节 / idle 倒计时」。

**本质局限（如实登记，非缺陷）**：detach-breakaway 进程、内核态卡死、磁盘半成品副作用、
远端 MCP skill —— 这些杀不掉/管不了的场景由「杀后复核」**如实告警**而非谎报。详见
`docs/superpowers/plans/2026-06-12-skill-script-liveness-timeout.md`「## 已知局限与状态一致性」。

**测试**：`tests/test_script_runner.py`（14）、`tests/test_skill_exec_timeout.py`（4）。
**设计/计划**：`docs/superpowers/plans/2026-06-12-skill-script-liveness-timeout.md`。

---

## 9. LLM 适配器：chat 端点推断 + 错误体兼容解析

> **状态：🔵 已上游化** —— 由本 fork（`sunpcn`，提交 `963fbc2`）实现，现 `app/llm/openai_adapter.py`、
> `app/llm/anthropic_adapter.py` 已与上游**逐字节一致**，不在当前净差异里。仍登记在册。

**背景**：内网接各种 OpenAI 兼容供应商时，原代码硬编码
`f"{base_url}/v1/chat/completions"`，对「base_url 已含版本段」或「已是完整端点」的供应商
会拼出 `.../v4/chat/completions/v1/chat/completions` 这类错误 URL，导致 add-model 时 500 /
聊天 404；且不同供应商错误体格式不一，原解析对「`error` 是字符串」等非标准形态会抛异常。

**实现要点**

- **chat 端点推断** `_resolve_chat_url(base)`（`openai_adapter.py`）：
  - 已含 `/chat/completions`（用户填了完整端点）→ 原样使用；
  - 以 `/vN` 结尾（如 `.../v1`、智谱 `.../paas/v4`）→ 追加 `/chat/completions`；
  - 裸 host（如 `https://api.openai.com`）→ 追加 `/v1/chat/completions`。
  - 避免重复路径段。
- **错误体兼容解析**（openai + anthropic 两个适配器）：`error` 字段按 **dict / 字符串 / 缺失**
  分别处理（`{"error": {"message": …}}`、`{"error": "Not Found"}`、`{"message": …}` 都能解析），
  并 `str()` 兜底，扩展 `except` 捕获 `AttributeError/TypeError`，不再因非标准错误体崩溃。
- 连带修复 add-model 的 500。

---

## 10. 品牌 + 内网部署配置

> **状态：🔵 已上游化**（`app_name`、`skill_pull_server_url` 等当前在 upstream 亦为同值）

- **品牌改名**（`ad89fb9`）：`NetLIVE CoWork` → `IPMaster Cowork` —— 改 `app/config/settings.py`
  的 `app_name = "IPMaster-Cowork"`、`app/main.py`、`app/observability/logging.py` 里的产品名串。
- **内网部署配置**（`06f0608`）：`skill_pull_server_url` 默认指向内网
  `http://10.25.228.203:8080/api`（远端 skill 服务器），更新服务器 `:8077`；并修正
  skill_pull 的环境变量 key。属内网交付的默认值，非通用逻辑。

> 注：这些值现与 upstream 一致（双向 content-merge 的结果），故不在净差异里；仍登记备查。

---

## 11. 文件预览后端：大小上限

> **状态：🔵 已上游化**

`app/api/v1/routes/workspace.py`（`3381a64`）：把预览文件大小上限从 **10MB 提到 50MB**
（`52_428_800`）。理由：`FileResponse` 流式下发对后端零内存压力，但浏览器端
mammoth/xlsx 解析在内存里，50MB 覆盖图片多的 office 文档、同时挡住误开超大二进制
（视频/压缩包）。这是 0.2.x 文件预览/渲染大改造在**后端的唯一落点**（其余在
`frontend-desktop/`，不在本登记册范围）。

---

## 维护提示

- 每次合并上游后，用 `git diff --stat upstream/master master -- app/` 重新核对本清单：
  - 🟢 当前差异 case 的文件若**消失**在净差异里 → 说明已被上游采纳，改标 🔵 已上游化
    （如 case 6 SSL 的演化路径），不要删除登记。
  - 新增 fork 改动 → 追加 case 并补汇总表。
- 上述全部改动随 PyInstaller 后端打包（`packaging/build_electron.ps1`）；纯后端改动
  也必须**全量重打**后端，不能用 `-SkipBackend`。
- 关联测试：`tests/test_tool_offload.py`、`tests/test_bash_os_hint.py`、
  `tests/test_skill_script_runtime_note.py`（以及遥测/导出相关用例）。

_最后更新：2026‑06‑12，对应 `origin/master` @ `a12e1e4`（v0.3.4）。_
