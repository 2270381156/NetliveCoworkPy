# Phase C：用户主动"上报此会话"（session_report）— Design

**Date:** 2026-06-11
**Status:** Approved
**Context:** 客户端观测三个日志上传触发里，A(崩溃自动)、B(管理端按需)已上线验证。本设计实现最后一个 —— **C：用户在会话界面主动"上报此会话"**。这是**唯一上传对话内容**的路径，必须**用户明确同意**后才发。复用 Phase A/B 已验证的 zip 打包 + `/logs` 上传机制。

## 范围
- **只做"上报此会话"**；`display_name` 设置项(spec §11)延后，不在本期。
- 不做会话的自动/批量上传；只有这一条用户手动触发。

## 上传内容（一个 zip，reason=session_report）
**修订（2026-06-12）：保持后端 `/data` 子目录结构，不再压成单个 composed JSON。** zip 布局：
```
session-report.zip
├── data/sessions/{sid}.json
├── data/agents/{sid}/{agent_id}.json          # agent 状态：working_dir/loop_guard/...
├── data/tasks/{sid}/{task_id}.json            # 含 execution_rounds(上游 context 重构)
├── data/tool_calls/{sid}.jsonl
├── data/event_logs/{sid}.jsonl                # 渲染事件流
├── data/blackboard/{sid}/{topic}.jsonl        # agent 间共享数据
├── data/memory/{agent_id}/messages.jsonl, summaries.json   # 每个 agent 的对话记忆
├── environment.json   # electron 注入：app_version/hostname/os_username/platform/arch
├── electron.log       # 尾部 256KB(collectTail)
└── backend.log        # 尾部 256KB(collectTail，即 ipmaster-cowork.log)
```
- **完整覆盖会话周边信息**（agents/tasks/events/blackboard/memory summaries），不止 messages+tool_calls。
- **排除**全局/含密配置：`llm_configs`(含 api_key!)、`mcp_configs`、`agent_templates`、`resource_summaries.json`。session/agent json 只按名字引用 provider，无密钥。
- 后端无 project 实体；目录上下文即 `session.working_dir`，已含。

## 架构（5 个单元）

### 1. 后端 `GET /api/v1/sessions/{id}/export`（`app/api/v1/routes/sessions.py`）
**修订（2026-06-12）：返回 `{"files": [{"path": <相对 data 的 posix 路径>, "content": <文本>}]}`**，保持 `/data`
子目录结构，由客户端原样打进 zip（替代早先的 `{session, messages, tool_calls}` 组合 JSON）。组合现有 `/data`
读路径，**不新增存储**，逐文件读、单个文件不可读/二进制则跳过（导出绝不因单文件失败）：
- `sessions/{id}.json`（缺则 404）、`tool_calls/{id}.jsonl`、`event_logs/{id}.jsonl`。
- `agents/{id}/`、`tasks/{id}/`、`blackboard/{id}/` 整目录递归（含 task 的 `execution_rounds`、agent 的 working_dir 等）。
- 每个 agent 的对话记忆：`memory/{agent_id}/`（`messages.jsonl` + `summaries.json`）。
- **排除**全局/含密：`llm_configs`(api_key!)、`mcp_configs`、`agent_templates`、`resource_summaries.json`。
- 不含 `environment` —— 那是 electron 注入的客户端信息（见 §2）。约 45 行。

### 2. Electron 主进程 `ipcMain.handle('report-session', ...)`（`main.js`）
入参 `(sessionId, note)`。流程：
- `fetch(\`${BACKEND_URL}/api/v1/sessions/${sessionId}/export\`)` 取后端导出（BACKEND_URL=localhost:15926）。
- 注入 `environment`：`{ app_version: app.getVersion(), hostname, os_username, platform: process.platform, arch: process.arch }`。
- 日志尾部：`collectTail({ files: logFilesForTail() })`（复用，得 electron.log/backend.log 原始尾部 + mtime）。
- 组装 zip 条目：`buildSessionReportEntries({ env, exportObj, logEntries, now })`（**纯函数，入 `electron/lib/session-report.js`，可单测**）→ 把 `exportObj.files` 每项映射为 `{name: 'data/<path>', data, mtime}` 条目（保持 data 子目录结构）+ 一条 `{name:'environment.json', data}` + 追加 `logEntries`。
- `zipEntries(entries)` → Buffer。
- `uploadLogs({ endpoint: updateConfig.telemetryUrl, fields: clientFields('session_report', { session_id: sessionId, user_note: note || '' }), archive: { name: 'session-report.zip', data: zip } })`。
- 返回 `{ ok: boolean, error?: string }`（fetch/upload 失败 → `{ok:false, error}`，不抛）。
- gate：`shouldReportTelemetry(updateConfig)`（无 telemetryUrl → `{ok:false, error:'telemetry disabled'}`）。

### 3. Preload（`electron/preload.js`）
`electronAPI` 加：`reportSession: (sessionId, note) => ipcRenderer.invoke('report-session', sessionId, note)`。

### 4. 渲染端（`frontend-desktop`）
- `ChatPanel.tsx` 会话头部右侧图标簇加一个 `HeaderIconBtn`（`UploadIcon`，`title` 用 i18n "上报此会话"），点击 → 打开确认框。
- 确认框：复用 `SessionList.tsx` 的内联 overlay 模式。内容：**明确同意文案**（"将上传该会话的全部对话内容用于问题排查…"）+ 可选 `note` textarea + 取消/上报按钮。
- 上报：`const r = await window.electronAPI.reportSession(id, note)` → 成功/失败**内联状态文字**（无 toast 库，沿用现有 inline error 风格）。上报中禁用按钮。
- 文案走现有 i18n `t()`（加 zh + en key）。

### 5. 服务端（`:8077`，并行会话）
`POST /logs` 已收 `reason` + `command_id`。新增**可选**表单字段 `session_id`、`user_note`，写进该上传的 `.meta.json`；`reason=session_report` 在看板单独标注并展示 `session_id` + `user_note`。同 `command_id` 的小改动。**本仓不改服务端**，把契约发并行会话。

## 同意 / 隐私
- 仅此路径出对话内容；确认框明确告知、用户点"上报"才发（§9）。
- 上传仍只发内网遥测服务（telemetryUrl）。

## 大小
- 导出 JSON 随会话长度，整包随服务端 20MB/文件 上限（`_MAX_LOG_BYTES`）。典型会话远小于此。**本期不加客户端裁剪**；超大会话 413 是已知边界，将来需要再加裁剪（非目标）。

## 测试
- **后端**（pytest）：`/sessions/{id}/export` 返回 `{files:[{path,content}]}`，path 为相对 data 的 posix 路径（含 `sessions/{id}.json`、agent/task/memory 等）；不存在 → 404。
- **纯逻辑**（node:test）：`buildSessionReportEntries({env, exportObj, logEntries, now})` → 断言把 `exportObj.files` 映射为 `data/<path>` 条目 + 一条 `environment.json`（解析含 app_version/hostname/os_username/platform/arch）+ 追加的日志条目；env 注入正确。
- **手工打包 E2E**：会话点"上报此会话" → 确认 → 代理/服务端见**一个** `session-report.zip` 部件、`reason=session_report` + `session_id` + `user_note`；解压含 `data/sessions/{id}.json` 等子目录结构 + `environment.json` + electron.log + backend.log。

## 非目标
- 不做 `display_name` 设置项（延后）。
- 不做自动/批量会话上传。
- 不加客户端导出大小裁剪。
- 不引入 toast 库（沿用内联状态）。
- 不改服务端代码（契约交并行会话）。
