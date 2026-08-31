# 日志上传打包为单个 zip — Design

**Date:** 2026-06-11
**Status:** Approved
**Context:** 客户端 Phase B 的 `/logs` 上传当前每次发送 2–3 个独立的 `.gz` 文件（`electron.log.gz` + `backend.log.gz` [+ `backend.log.<date>.gz`]）。希望改为**每次上传一个压缩包**，便于后台一项下载、Windows 资源管理器直接双击打开。

## 决策

- **格式：zip**（DEFLATE）。Windows 双击即开；服务端零改动（仍走 `files[]`，只是一个文件）。
- **仅客户端改动**，crash + requested **两个触发都改**。
- **零新依赖**：手写一个最小 zip 写入器（CRC32 + local file header + central directory + EOCD），每条目数据用 node 内置 `zlib.deflateRawSync`。契合现有 `electron/lib/*.js` 纯逻辑、可注入、可单测的风格。

## 架构 / 组件

### `electron/lib/log-bundler.js`（重构）
当前返回 `[{name, data: gzipBuf}]`（每文件单独 gzip）。改为返回**原始**缓冲 `[{name, data: rawBuf}]`，`name` 为 zip 内文件名（无 `.gz` 后缀）：
- `collectTail({ files, perFileBytes=256*1024, fsImpl })` → 每个存在文件的尾部 256KB，原始字节，`{name, data}`；缺失跳过。（crash 模式）
- `collectFull({ files, maxTotalBytes, tailBytes=256*1024, fsImpl })` → newest-first 累加**原始**字节直到 `maxTotalBytes`，溢出文件保留尾部、其后丢弃（同现有 bundleFull 规则，只是基于原始字节而非 gzip 字节）。（requested 模式）
  - `maxTotalBytes` 取一个让最终 zip 稳在服务端 20MB 限内的原始上限（日志文本压缩比高；设 `16*1024*1024` 原始 → zip 远小于 20MB）。
- `files` 项的 `name` 用 zip 内名：`electron.log` / `backend.log` / `backend.log.<date>`。

### `electron/lib/zip.js`（新建，纯逻辑）
- `zipEntries(entries, { deflate=zlib.deflateRawSync, crc32=<内置实现> })` → `Buffer`
  - entries：`[{name, data: Buffer}]`
  - 每条目：DEFLATE 压缩（method 8）；CRC32 用未压缩原始数据；写 local file header（签名 `PK\x03\x04`）+ 文件名 + 压缩数据。
  - 末尾写 central directory（每条目 `PK\x01\x02`）+ EOCD（`PK\x05\x06`），偏移/计数正确。
  - 时间戳：用固定 DOS 时间（如 0），避免不可重现（环境禁 `Date.now()`，且 zip 内时间无业务意义）。
- `crc32(buf)`：标准 IEEE CRC32（256 项查表）。

### `electron/lib/log-uploader.js`（微调）
- `uploadLogs` 不再 append 多个 `files` 部件；改为 append **一个** `files` 部件：`logs-<reason>.zip`（`reason` 已作为表单字段单独传；服务端会加自己的时间戳前缀去重）。
- 入参从 `files: [{name, data}]` 改为 `archive: { name, data }`（单个），或保留 `files` 但约定单元素——实现时取**单个 archive** 更清晰。

### main.js wiring
- `uploadCrashLogs`：`zipEntries(collectTail(logFilesForTail()))` → upload `{name:'logs-crash.zip', data: zip}`。
- `pollCommands`（requested）：`zipEntries(collectFull(logFilesForFull()))` → upload `{name:'logs-requested.zip', data: zip}`。
- `logFilesForTail/Full()` 的 `name` 改为 zip 内名（去 `.gz`）。

## 服务端
**无需改动**：仍按 `files[]` 收一个文件存档；列表/下载照常（一项 = 一个 zip）。需告知并行服务端会话：requested/crash 现在是单个 `.zip`，看板可选地把它标注为"压缩包"。**代价：看板不再每文件一行**——一次上传 = 一个可下载 zip，解压后看 electron / backend。

## 测试
- **单测（node:test，注入依赖）**：
  - `zip.js`：`crc32` 已知向量；`zipEntries` 输出含正确签名（PK\x03\x04 / PK\x01\x02 / PK\x05\x06）、条目数、每条目 CRC/sizes、central dir 偏移自洽；空 entries → 合法空 zip。
  - `log-bundler`：`collectTail`/`collectFull` 返回原始字节、缺失跳过、full 的 newest-first 截断（注入 fsImpl）。
  - `log-uploader`：单 `files` 部件、文件名 `logs-<reason>.zip`、失败静默（注入 FormData/fetch）。
- **集成测试（证明 zip 真合法）**：把 `zipEntries` 输出写盘，用 PowerShell `Expand-Archive` 解压，断言解出的文件名与内容与输入一致。
- **打包态 e2e（收尾手工）**：触发 crash + requested → 代理抓到 `POST /logs` 单个 zip 部件 → 服务端列表出现该 zip → 资源管理器双击能打开、含 electron.log + backend.log。

## 非目标
- 不改服务端代码（只是收到的文件变成一个 zip）。
- 不保留看板每文件一行（明确接受单 zip 列表项）。
- 不引入 zip 第三方库（手写 + zlib 内置）。
