# 客户端观测系统 Phase B 实现 Plan（日志上传与指令轮询，客户端侧）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端 Phase B——崩溃时自动上传运行日志尾部（reason=crash，每会话一次），并轮询管理端指令按需上传全量日志（reason=requested），全部经新的 `POST /logs` multipart 通道。

**Architecture:** 三个纯逻辑模块（`electron/lib/log-bundler.js` gzip 打包、`log-uploader.js` multipart 上传、`commands.js` 指令解析/URL）+ `main.js` wiring（启动+每 10 分钟轮询指令；既有 backend_crash/renderer_crash 上报点旁追加 tail 包上传）。服务端已就绪，单测注入 `fetchImpl`/`fsImpl`/`gzipSync`/`FormDataImpl`，真实服务端留手工 smoke。

**Tech Stack:** Electron main（CommonJS，node:test）。Node 24（全局 `FormData`/`Blob`/`fetch`、内置 `zlib`）。Spec：`docs/superpowers/specs/2026-06-10-client-observability-design.md`（§5、§7、§12）。

---

## 全局约定（每个任务都适用）

- **工作目录：worktree `D:\20_code\miniAgentsDemo-obs`，分支 `feature/client-observability`**（已存在，Phase A 在此）。
- Electron 测试：`cd electron && npm test`（node --test test/*.test.js）。
- **绝不提交**：`uv.lock`、`.claire/`、`.gitignore`、`electron/package-lock.json`。
- 本 plan **不打包、不 bump 版本**（发版属 0.3.0 动作，届时按 CLAUDE.md 原则先 bump）。
- 代码风格：纯逻辑放 `electron/lib/*.js` 可注入依赖、配 `electron/test/*.test.js`；注释只写"代码看不出来的约束"。
- 失败语义：日志上传**失败静默**（不进事件离线队列）——requested 靠下个轮询周期重试，crash 靠下次崩溃（spec §12.2）。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| Create `electron/lib/log-bundler.js` | `tailFileSync` / `bundleTail`（crash，每文件尾 256KB）/ `bundleFull`（requested，≤10MB，超限丢最旧、尾部截断最后纳入文件） |
| Create `electron/lib/log-uploader.js` | `uploadLogs`：`POST {endpoint}/logs` multipart，失败返回 false |
| Create `electron/lib/commands.js` | `parseCommands`（筛 upload_logs）/ `commandsUrl` / `ackUrl` |
| Modify `electron/main.js` | require 三模块 + `crashUploadDone` 模块态；`uploadCrashLogs()` + `clientFields()` + `logFilesForTail/Full()` 辅助；接入两个崩溃点；`pollCommands()` 启动 + 每 10 分钟 |
| Create `electron/test/log-bundler.test.js` / `log-uploader.test.js` / `commands.test.js` | 对应单测 |

---

### Task 0: 基线确认

**Files:** 无代码改动。

- [ ] **Step 1: 确认分支与 HEAD**

```bash
cd /d/20_code/miniAgentsDemo-obs && git branch --show-current && git log --oneline -1
```
Expected: `feature/client-observability`，HEAD = `25569c7`（spec §12 addendum）或其后。

- [ ] **Step 2: 基线测试通过**

```bash
cd /d/20_code/miniAgentsDemo-obs/electron && npm test
```
Expected: 34 PASS（Phase A 收尾态）。若有挂的用例，记录并停下确认，不要顺手改。

---

### Task 1: log-bundler — `tailFileSync` + `bundleTail`

**Files:**
- Create: `electron/lib/log-bundler.js`
- Create: `electron/test/log-bundler.test.js`

- [ ] **Step 1: 写失败测试**

`electron/test/log-bundler.test.js`：
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tailFileSync, bundleTail } = require('../lib/log-bundler');

// identity "gzip" so byte sizes stay predictable in assertions
const idGzip = (buf) => buf;

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('tailFileSync returns last maxBytes of a file', () => {
  const p = tmpFile('a.log', 'abcdefghij');
  assert.strictEqual(tailFileSync(p, 4).toString(), 'ghij');
  assert.strictEqual(tailFileSync(p, 100).toString(), 'abcdefghij');
});

test('tailFileSync returns null for a missing file', () => {
  assert.strictEqual(tailFileSync(path.join(os.tmpdir(), 'nope-xyz-123.log'), 4), null);
});

test('bundleTail gzips each present file tail and skips missing files', () => {
  const a = tmpFile('electron.log', 'x'.repeat(500));
  const files = [
    { path: a, name: 'electron.log.gz' },
    { path: path.join(os.tmpdir(), 'absent-abc.log'), name: 'backend.log.gz' },
  ];
  const out = bundleTail({ files, perFileBytes: 100, gzipSync: idGzip });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'electron.log.gz');
  assert.strictEqual(out[0].data.length, 100); // tail to 100, identity gzip
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /d/20_code/miniAgentsDemo-obs/electron && node --test test/log-bundler.test.js
```
Expected: FAIL，`Cannot find module '../lib/log-bundler'`。

- [ ] **Step 3: 实现**

`electron/lib/log-bundler.js`：
```js
'use strict';
const fs = require('fs');
const zlib = require('zlib');

// Reads the last maxBytes of a file (whole file if smaller). Returns null when
// the file is absent/unreadable so callers can skip it silently.
function tailFileSync(filePath, maxBytes, fsImpl = fs) {
  try {
    const buf = fsImpl.readFileSync(filePath);
    return buf.length <= maxBytes ? buf : buf.subarray(buf.length - maxBytes);
  } catch (_) {
    return null;
  }
}

// crash mode: gzip the tail (default 256KB) of each present file.
// files: [{ path, name }] — name is the gz entry name (spec §5.3).
function bundleTail({ files, perFileBytes = 256 * 1024, fsImpl = fs, gzipSync = zlib.gzipSync }) {
  const out = [];
  for (const f of files) {
    const tail = tailFileSync(f.path, perFileBytes, fsImpl);
    if (tail === null) continue;
    out.push({ name: f.name, data: gzipSync(tail) });
  }
  return out;
}

module.exports = { tailFileSync, bundleTail };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test/log-bundler.test.js
```
Expected: 3 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/log-bundler.js test/log-bundler.test.js
git commit -m "feat(obs): log-bundler tailFileSync + bundleTail (crash mode)"
```

---

### Task 2: log-bundler — `bundleFull`（requested 模式，超限截断）

**Files:**
- Modify: `electron/lib/log-bundler.js`
- Modify: `electron/test/log-bundler.test.js`（追加用例）

- [ ] **Step 1: 追加失败测试**

`electron/test/log-bundler.test.js` 末尾追加（require 行改为同时引入 `bundleFull`）：
```js
// 把文件顶部 require 改为：
// const { tailFileSync, bundleTail, bundleFull } = require('../lib/log-bundler');

test('bundleFull includes whole files when within budget', () => {
  const a = tmpFile('electron.log', 'aaaa');
  const b = tmpFile('ipmaster-cowork.log', 'bbbbbb');
  const out = bundleFull({
    files: [{ path: a, name: 'electron.log.gz' }, { path: b, name: 'backend.log.gz' }],
    maxTotalBytes: 1000, tailBytes: 2, gzipSync: idGzip,
  });
  assert.deepStrictEqual(out.map((o) => o.name), ['electron.log.gz', 'backend.log.gz']);
  assert.strictEqual(out[0].data.length + out[1].data.length, 10);
});

test('bundleFull keeps newest, tail-truncates at budget, drops oldest', () => {
  const newest = tmpFile('electron.log', 'N'.repeat(8));
  const older = tmpFile('ipmaster-cowork.log', 'O'.repeat(8));
  const oldest = tmpFile('ipmaster-cowork.log.2026-06-10', 'X'.repeat(8));
  const out = bundleFull({
    files: [
      { path: newest, name: 'electron.log.gz' },        // newest first
      { path: older, name: 'backend.log.gz' },
      { path: oldest, name: 'backend.log.2026-06-10.gz' },
    ],
    maxTotalBytes: 12, tailBytes: 4, gzipSync: idGzip,
  });
  // newest whole (8) fits; older whole (8) would hit 16>12 → tail to 4 (8+4=12) fits; oldest dropped
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.length]), [
    ['electron.log.gz', 8],
    ['backend.log.gz', 4],
  ]);
});

test('bundleFull skips a missing middle file without stopping', () => {
  const a = tmpFile('electron.log', 'aa');
  const c = tmpFile('ipmaster-cowork.log.2026-06-10', 'cc');
  const out = bundleFull({
    files: [
      { path: a, name: 'electron.log.gz' },
      { path: path.join(os.tmpdir(), 'gone-xyz.log'), name: 'backend.log.gz' },
      { path: c, name: 'backend.log.2026-06-10.gz' },
    ],
    maxTotalBytes: 1000, tailBytes: 2, gzipSync: idGzip,
  });
  assert.deepStrictEqual(out.map((o) => o.name), ['electron.log.gz', 'backend.log.2026-06-10.gz']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/log-bundler.test.js
```
Expected: 新增 3 用例 FAIL（`bundleFull is not a function`）。

- [ ] **Step 3: 实现**

`electron/lib/log-bundler.js`：在 `bundleTail` 之后、`module.exports` 之前插入：
```js
// requested mode: gzip whole files newest-first until maxTotalBytes is reached.
// The file that would overflow the budget is tail-truncated (tailBytes) if its
// gz tail still fits, then iteration stops — dropping any older files (spec §12.2).
function bundleFull({
  files, maxTotalBytes = 10 * 1024 * 1024, tailBytes = 256 * 1024,
  fsImpl = fs, gzipSync = zlib.gzipSync,
}) {
  const out = [];
  let total = 0;
  for (const f of files) {
    let raw;
    try { raw = fsImpl.readFileSync(f.path); } catch (_) { continue; }
    const whole = gzipSync(raw);
    if (total + whole.length <= maxTotalBytes) {
      out.push({ name: f.name, data: whole });
      total += whole.length;
      continue;
    }
    const tail = raw.length <= tailBytes ? raw : raw.subarray(raw.length - tailBytes);
    const tailGz = gzipSync(tail);
    if (total + tailGz.length <= maxTotalBytes) {
      out.push({ name: f.name, data: tailGz });
    }
    break; // budget reached → drop remaining (older) files
  }
  return out;
}
```
并把 `module.exports` 改为：
```js
module.exports = { tailFileSync, bundleTail, bundleFull };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test/log-bundler.test.js
```
Expected: 6 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/log-bundler.js test/log-bundler.test.js
git commit -m "feat(obs): log-bundler bundleFull (requested mode, budget truncation)"
```

---

### Task 3: log-uploader — `uploadLogs`（multipart POST /logs）

**Files:**
- Create: `electron/lib/log-uploader.js`
- Create: `electron/test/log-uploader.test.js`

- [ ] **Step 1: 写失败测试**

`electron/test/log-uploader.test.js`：
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { uploadLogs } = require('../lib/log-uploader');

// Minimal fakes so the test doesn't depend on real multipart wire format.
class FakeForm {
  constructor() { this.entries = []; }
  append(k, v, name) { this.entries.push([k, v, name]); }
}
class FakeBlob {
  constructor(parts) { this.size = parts[0] ? parts[0].length : 0; }
}

test('uploadLogs posts fields + files to /logs and returns true on ok', async () => {
  let calledUrl, calledOpts;
  const fetchImpl = async (url, opts) => { calledUrl = url; calledOpts = opts; return { ok: true }; };
  const ok = await uploadLogs({
    endpoint: 'http://x:8077',
    fields: { install_id: 'i', reason: 'crash', command_id: undefined }, // undefined skipped
    files: [{ name: 'electron.log.gz', data: Buffer.from('zz') }],
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calledUrl, 'http://x:8077/logs');
  assert.strictEqual(calledOpts.method, 'POST');
  const form = calledOpts.body;
  const textKeys = form.entries.filter((e) => e[0] !== 'files').map((e) => e[0]).sort();
  assert.deepStrictEqual(textKeys, ['install_id', 'reason']); // command_id=undefined dropped
  const fileEntry = form.entries.find((e) => e[0] === 'files');
  assert.strictEqual(fileEntry[2], 'electron.log.gz');
});

test('uploadLogs returns false when fetch rejects', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const ok = await uploadLogs({
    endpoint: 'http://x', fields: {}, files: [],
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, false);
});

test('uploadLogs returns false on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const ok = await uploadLogs({
    endpoint: 'http://x', fields: {}, files: [],
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/log-uploader.test.js
```
Expected: FAIL，`Cannot find module '../lib/log-uploader'`。

- [ ] **Step 3: 实现**

`electron/lib/log-uploader.js`：
```js
'use strict';

// POST a gzipped log bundle as multipart/form-data to {endpoint}/logs.
// Failures are swallowed (return false): bundles are too large for the 200-item
// event queue; requested uploads retry on the next poll, crash uploads on the
// next crash. FormData/Blob are Node 18+ globals; injected here for tests.
async function uploadLogs({
  endpoint, fields, files,
  fetchImpl = fetch, FormDataImpl = FormData, BlobImpl = Blob,
}) {
  try {
    const form = new FormDataImpl();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    for (const f of files) {
      form.append('files', new BlobImpl([f.data], { type: 'application/gzip' }), f.name);
    }
    const res = await fetchImpl(`${endpoint}/logs`, { method: 'POST', body: form });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

module.exports = { uploadLogs };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test/log-uploader.test.js
```
Expected: 3 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/log-uploader.js test/log-uploader.test.js
git commit -m "feat(obs): log-uploader multipart POST /logs (silent-fail)"
```

---

### Task 4: commands — 解析与 URL 构造

**Files:**
- Create: `electron/lib/commands.js`
- Create: `electron/test/commands.test.js`

- [ ] **Step 1: 写失败测试**

`electron/test/commands.test.js`：
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCommands, commandsUrl, ackUrl } = require('../lib/commands');

test('parseCommands keeps only valid upload_logs commands', () => {
  const body = { commands: [
    { id: 'c1', type: 'upload_logs' },
    { id: 'c2', type: 'something_else' }, // wrong type → dropped
    { type: 'upload_logs' },              // no id → dropped
    null,                                 // garbage → dropped
  ] };
  assert.deepStrictEqual(parseCommands(body), [{ id: 'c1', type: 'upload_logs' }]);
});

test('parseCommands tolerates missing / garbage body', () => {
  assert.deepStrictEqual(parseCommands(null), []);
  assert.deepStrictEqual(parseCommands({}), []);
  assert.deepStrictEqual(parseCommands({ commands: 'nope' }), []);
});

test('commandsUrl and ackUrl encode ids', () => {
  assert.strictEqual(commandsUrl('http://x:8077', 'inst/1'), 'http://x:8077/clients/inst%2F1/commands');
  assert.strictEqual(ackUrl('http://x:8077', 'i', 'c 1'), 'http://x:8077/clients/i/commands/c%201/ack');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/commands.test.js
```
Expected: FAIL，`Cannot find module '../lib/commands'`。

- [ ] **Step 3: 实现**

`electron/lib/commands.js`：
```js
'use strict';

// Parse GET /clients/{id}/commands response → list of actionable upload_logs
// commands. Only upload_logs is supported (spec non-goal: no remote config).
function parseCommands(body) {
  if (!body || !Array.isArray(body.commands)) return [];
  return body.commands.filter((c) => c && c.type === 'upload_logs' && c.id);
}

function commandsUrl(endpoint, installId) {
  return `${endpoint}/clients/${encodeURIComponent(installId)}/commands`;
}

function ackUrl(endpoint, installId, commandId) {
  return `${endpoint}/clients/${encodeURIComponent(installId)}/commands/${encodeURIComponent(commandId)}/ack`;
}

module.exports = { parseCommands, commandsUrl, ackUrl };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test/commands.test.js
```
Expected: 3 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/commands.js test/commands.test.js
git commit -m "feat(obs): commands parse + commandsUrl/ackUrl builders"
```

---

### Task 5: main.js wiring — 崩溃自动上传（reason=crash，每会话一次）

**Files:**
- Modify: `electron/main.js`

无法单测（纯 wiring，依赖 electron 运行时）；Task 7 有手工验证项。

- [ ] **Step 1: require 三模块 + 模块态**

`electron/main.js` 顶部 require 区（`const { drainSpool } = require('./lib/spool');` 之后）加：
```js
const zlib = require('zlib');
const { bundleTail, bundleFull } = require('./lib/log-bundler');
const { uploadLogs } = require('./lib/log-uploader');
const { parseCommands, commandsUrl, ackUrl } = require('./lib/commands');
```
模块态区（`let telemetry = null;` 一行，约 L36）之后加：
```js
let crashUploadDone = false; // Phase B: at most one reason=crash log upload per app session
```

- [ ] **Step 2: 公共辅助（字段 + 文件清单 + 崩溃上传）**

在 `function getOrCreateInstallId()` 定义之后（约 L100，任意模块级位置均可，紧跟其后便于阅读）插入：
```js
// Phase B log-upload helpers. logs live in %APPDATA%\IPMaster-Cowork\logs
// (electron.log + backend ipmaster-cowork.log, daily-rotated with .YYYY-MM-DD backups).
function clientFields(reason, extra = {}) {
  return {
    install_id: getOrCreateInstallId(),
    app_version: app.getVersion(),
    hostname: osMod.hostname(),
    os_username: (() => { try { return osMod.userInfo().username; } catch (_) { return ''; } })(),
    reason,
    ...extra,
  };
}

function logFilesForTail() {
  const logsDir = path.join(getAppDataDir(), 'logs');
  return [
    { path: path.join(logsDir, 'electron.log'), name: 'electron.log.gz' },
    { path: path.join(logsDir, 'ipmaster-cowork.log'), name: 'backend.log.gz' },
  ];
}

function logFilesForFull() {
  const logsDir = path.join(getAppDataDir(), 'logs');
  const ymd = (d) => d.toISOString().slice(0, 10);
  const yesterday = ymd(new Date(Date.now() - 86400000));
  // newest first — bundleFull keeps newest, drops oldest when over budget
  return [
    { path: path.join(logsDir, 'electron.log'), name: 'electron.log.gz' },
    { path: path.join(logsDir, 'ipmaster-cowork.log'), name: 'backend.log.gz' },
    { path: path.join(logsDir, `ipmaster-cowork.log.${yesterday}`), name: `backend.log.${yesterday}.gz` },
  ];
}

// Fire-and-forget crash log upload, gated behind telemetry opt-in (privacy §9)
// and once per app session (avoids spamming bundles in a crash-restart loop;
// the tail already contains the repeated crashes).
function uploadCrashLogs() {
  if (crashUploadDone || !telemetry) return;
  crashUploadDone = true;
  try {
    const files = bundleTail({ files: logFilesForTail(), gzipSync: zlib.gzipSync });
    if (files.length === 0) return;
    uploadLogs({
      endpoint: updateConfig.telemetryUrl,
      fields: clientFields('crash'),
      files,
    }).catch(() => {});
  } catch (_) {}
}
```

- [ ] **Step 3: 接入 backend_crash 上报点**

锚点：`backendProcess.on('exit', ...)` 内现有 `telemetry.report('backend_crash', {...}).catch(() => {});` 块（约 L348-353）。在该 `if (...) { ... }` 块**之后**插入：
```js
    if (code !== null && code !== 0 && !backendStopping) uploadCrashLogs();
```

- [ ] **Step 4: 接入 renderer_crash 上报点**

锚点：`mainWindow.webContents.on('render-process-gone', ...)` 内现有 `telemetry.report('renderer_crash', {...}).catch(() => {});` 块（约 L493-498）。在该 `if (telemetry) { ... }` 块**之后**插入：
```js
    uploadCrashLogs();
```
（注意：该 handler 顶部已有 `if (details.reason === 'clean-exit') return;`，clean-exit 不会走到这里。）

- [ ] **Step 5: 语法检查 + 现有测试**

```bash
cd /d/20_code/miniAgentsDemo-obs/electron && node --check main.js && npm test
```
Expected: 语法 OK；npm test 全 PASS（无新增单测，旧的不回归）。

- [ ] **Step 6: 提交**

```bash
git add main.js
git commit -m "feat(obs): upload crash log tails (reason=crash, once per session)"
```

---

### Task 6: main.js wiring — 指令轮询（启动 + 每 10 分钟 → requested 上传 → ack）

**Files:**
- Modify: `electron/main.js`

- [ ] **Step 1: 接入轮询**

锚点：`app.whenReady().then(...)` 内 spool drain 的 `setInterval(drainSpoolIntoTelemetry, 30_000);`（约 L749）**之后**插入：
```js
  // Poll the management server for upload_logs commands (spec §5.2, §12.3).
  // Startup + every 10 min. Each command: bundle full logs → POST /logs
  // (reason=requested) → ack on success. All failures retry next cycle.
  async function pollCommands() {
    if (!telemetry) return;
    const base = updateConfig.telemetryUrl;
    const installId = getOrCreateInstallId();
    try {
      const res = await fetch(commandsUrl(base, installId));
      if (!res.ok) return;
      const body = await res.json();
      for (const cmd of parseCommands(body)) {
        try {
          const files = bundleFull({ files: logFilesForFull(), gzipSync: zlib.gzipSync });
          const ok = await uploadLogs({
            endpoint: base,
            fields: clientFields('requested', { command_id: cmd.id }),
            files,
          });
          if (ok) await fetch(ackUrl(base, installId, cmd.id), { method: 'POST' }).catch(() => {});
        } catch (_) {}
      }
    } catch (_) {}
  }
  pollCommands();
  setInterval(pollCommands, 10 * 60 * 1000);
```

- [ ] **Step 2: 语法检查 + 现有测试**

```bash
node --check main.js && npm test
```
Expected: 语法 OK；npm test 全 PASS。

- [ ] **Step 3: 提交**

```bash
git add main.js
git commit -m "feat(obs): poll upload_logs commands, upload full logs + ack"
```

---

### Task 7: 全量回归 + 手工 E2E 清单

**Files:** 无代码改动（最后记录结果时改 plan）。

- [ ] **Step 1: electron 全量测试**

```bash
cd /d/20_code/miniAgentsDemo-obs/electron && npm test
```
Expected: 全 PASS（Phase A 的 34 + 本期 log-bundler 6 + log-uploader 3 + commands 3 = 46）。

- [ ] **Step 2: 手工 E2E（打包安装态执行，需真实服务端 `10.25.228.203:8077`）**

记录每项实际结果（PASS/FAIL + 现象）：

1. **指令上传（reason=requested）**：管理后台对本机 install_id 置 `upload_logs` 标记 → 客户端 10 分钟内（或重启即时）`POST /logs` 上传，后台出现该包并可下载，含 `electron.log.gz` + `backend.log.gz`；上传成功后标记被 ack 清除。
2. **崩溃自动（reason=crash）**：任务管理器结束 `ipmaster-cowork.exe` → 后台出现 `reason=crash` 日志包，含 electron/backend 日志尾部；**再次**结束后端**不应**产生第二个 crash 包（每会话一次守卫）。
3. **正常关闭不误传**：正常退出应用**不应**产生任何 crash 包（backendStopping / clean-exit 抑制）。
4. **离线韧性**：断开服务端，置标记，客户端轮询失败不崩；恢复后下个周期完成上传。

- [ ] **Step 3: 记录验证结果到 plan 末尾，提交收尾**

```bash
git add docs/superpowers/plans/2026-06-11-client-observability-phase-b.md
git commit -m "docs(obs): record Phase B verification results"
```

---

## Self-review 记录

- **Spec 覆盖**：§5.1 触发 A=Task5、触发 B=Task6；§5.2 指令轮询=Task4+Task6；§5.3 上传契约=Task3（字段/命名）+Task6（command_id）；§12.2 模块划分=Task1-4；§12.2 超限截断=Task2；§12.3 每会话一次/10min=Task5/6；§12.3 telemetry 开关 gate=Task5/6。触发 C/会话上报/display_name 明确为 Phase C，不在本 plan。
- **类型一致**：`bundleTail`/`bundleFull` 均返回 `[{name, data:Buffer}]`，`uploadLogs.files` 同形；`clientFields(reason, extra)` 产出 §5.3 文本字段；`parseCommands` 产出含 `.id` 的项，`ackUrl(_,_,cmd.id)` 消费之。命名全程一致。
- **无 placeholder**：每个代码步骤含完整可运行代码与期望输出。
- **失败语义**：上传失败一律静默 false，不入事件队列（§12.2）；crash 守卫 `crashUploadDone` 模块级、telemetry 关闭即跳过。
- **不打包、不 bump 版本、不提交 uv.lock/.claire/.gitignore**。

---

## Phase B 实施结果（2026-06-11，subagent-driven 执行）

**全部 6 个代码任务完成，每个任务两段式 review（spec 合规 + 代码质量）均通过，零 Critical / 零 Important。**

提交链（feature/client-observability，基于 spec addendum `25569c7` / plan `d361c8c`）：
- `37d9e8e` log-bundler tailFileSync+bundleTail（Task1）
- `9ec5ae1` log-bundler bundleFull（Task2）+ `a026659` bundleFull newest-first 前置条件注释（code-review 跟进）
- `d7bb9f3` log-uploader multipart POST /logs（Task3）
- `b026377` commands 解析+URL（Task4）
- `8c906c9` 崩溃自动上传 reason=crash（Task5）+ `d31f7e5` logFilesForFull 改用本地日期匹配后端轮转后缀（code-review 跟进的真实修正：后端 `TimedRotatingFileHandler(when="midnight", utc=False)` 按本地日期命名 backup，原 UTC `toISOString` 在 UTC+8 凌晨会错位一天漏掉昨日日志）
- `08ad51d` 指令轮询 + requested 上传 + ack（Task6）

测试：electron `npm test` = **46/46 PASS**（Phase A 34 + 本期 log-bundler 6 / log-uploader 3 / commands 3）。两个 wiring 任务（Task5/6）无单测，靠 `node --check` + 全量回归不退化（同 Phase A Task 9）。

### 手工 E2E 清单（打包安装态执行，尚未跑 —— 需安装态 + 真实服务端 10.25.228.203:8077）
1. **指令上传（reason=requested）**：后台对本机 install_id 置 `upload_logs` 标记 → 客户端 10min 内（或重启即时）`POST /logs`，后台见包并可下载（含 `electron.log.gz`+`backend.log.gz`），成功后标记被 ack 清除。
2. **崩溃自动（reason=crash）**：结束 `ipmaster-cowork.exe` → 后台出现 reason=crash 包（含日志尾部）；**再次**结束后端**不应**产生第二个 crash 包（每会话一次守卫）。
3. **正常关闭不误传**：正常退出**不应**产生任何 crash 包（backendStopping / clean-exit 抑制）。
4. **离线韧性**：断开服务端置标记 → 客户端轮询失败不崩；恢复后下个周期完成上传。

### 已知延后项（非阻塞，code-review 跟进建议，本期不做）
- **endpoint 末尾斜杠不变量**：三个 Phase B URL 构造（+ 既有 `/events`）均假设 `endpoint` 无末尾斜杠；若 env `IPMASTER_COWORK_TELEMETRY_URL` 带斜杠会产生 `//`。建议在 config 边界（`update-config.js`）归一化一次（带单测）。两位 reviewer 均提到。
- **fetch 无超时**：`pollCommands` 的两处 `fetch` 与 `uploadLogs` 内部 fetch 无 timeout/AbortSignal，与 main.js 既有 `http.get` 健康检查（带 timeout）不一致。fire-and-forget 下危害有限（最坏重复上传一次，服务端本就需容忍 ack 失败的重传），建议加 30–60s 超时做 parity。
- **Phase C**（会话上报 + sessions/{id}/export + display_name）未开始。

### 发版提醒
本期**未打包、未 bump 版本**。Phase B 随 0.3.0 发版时按 CLAUDE.md 原则先 bump 版本号再打包；打包态跑上面 4 项手工 E2E。
