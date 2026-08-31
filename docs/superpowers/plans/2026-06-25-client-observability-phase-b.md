# 客户端观测 Phase B 实现 Plan(日志上传 + 指令轮询,单 zip)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 崩溃时自动上传运行日志尾部(reason=crash,每会话一次),并轮询管理端指令按需上传全量日志(reason=requested),全部打成**一个 zip** 经 `POST /logs` multipart 上传。服务端零改动。

**Architecture:** 四个纯逻辑模块(`zip.js` 零依赖 DEFLATE 写入器、`log-bundler.js` 收集原始日志字节、`log-uploader.js` 单 archive multipart 上传、`commands.js` 指令解析/URL)+ `main.js` wiring(崩溃点旁追加 zip 上传;启动 + 每 10 分钟轮询指令)。单测注入 `fetchImpl`/`fsImpl`/`gzipSync`/`FormDataImpl`/`BlobImpl`;真实服务端留手工 smoke。

**Tech Stack:** Electron main(CommonJS,`node:test`)。Electron ^34 → Node 20:全局 `fetch`/`FormData`/`Blob`、内置 `zlib`。Spec:`docs/superpowers/specs/2026-06-25-client-observability-db-export-design.md`(§6、§7)。

## Global Constraints

- **直接在 `master` 实现**(本轮用户指定;master 上有并发无关 WIP)。
- Electron 测试:`cd electron && npm test`(`node --test test/*.test.js`)。
- **绝不提交**:`uv.lock`、`.gitignore`、`electron/package-lock.json`、`.claire/`、任何 `packaging/`/`src/`/`tests/` 下的并发 WIP。每个任务 **`git add` 仅本任务文件**,绝不 `git add -A`。
- **不打包、不 bump 版本**。
- 代码风格:纯逻辑入 `electron/lib/*.js` 可注入依赖、配 `electron/test/*.test.js`;注释只写"代码看不出来的约束"。
- **日志文件实仓事实**(打包态,经 `electron/main.js` 写入 `.env`):日志目录 = `%APPDATA%\IPMaster-Cowork\logs`;文件 = `electron.log` + `backend.log`(`IPMC_LOG_FILENAME=backend.log`);后端按 `TimedRotatingFileHandler(when=midnight, 本地日期)` 产生 dated backup `backend.log.YYYY-MM-DD`。
- **失败语义**:日志上传**失败静默**(返回 false,不进 200 条事件离线队列)——requested 靠下个轮询周期重试,crash 靠下次崩溃。
- **依赖顺序**:`zip.js`(Task 1)→ `log-bundler`(Task 2)→ `log-uploader`(Task 3)→ `commands`(Task 4)→ wiring(Task 5/6)。Phase C 之后将复用 Task 1/2/3。

## 文件结构

| 文件 | 职责 |
|------|------|
| Create `electron/lib/zip.js` | `crc32` + `zipEntries(entries)` → 单个 DEFLATE zip Buffer(零依赖) |
| Create `electron/lib/log-bundler.js` | `tailFileSync` / `collectTail`(crash,每文件尾 256KB 原始字节)/ `collectFull`(requested,newest-first 累加至上限、溢出尾部截断后丢更旧) |
| Create `electron/lib/log-uploader.js` | `uploadLogs({endpoint, fields, archive})` → `POST {endpoint}/logs` 单 zip 部件,失败静默 |
| Create `electron/lib/commands.js` | `parseCommands`(筛 upload_logs)/ `commandsUrl` / `ackUrl` |
| Modify `electron/main.js` | require 四模块 + `crashUploadDone` 态;`clientFields`/`logFilesForTail`/`logFilesForFull`/`uploadCrashLogs` 辅助;接两个崩溃点;`pollCommands` 启动 + 每 10 分钟 |
| Create `electron/test/{zip,log-bundler,log-uploader,commands}.test.js` | 对应单测 |

---

### Task 0: 基线确认

**Files:** 无代码改动。

- [ ] **Step 1: 分支 + electron 基线**

Run: `git branch --show-current && cd electron && npm test 2>&1 | grep -aE "# tests|# pass|# fail"`
Expected: 分支 `master`;全 PASS(记录用例数,Phase A 收尾态约 58)。若有挂的用例,记录并停下确认,不顺手改。

---

### Task 1: `zip.js` — CRC32 + 最小 DEFLATE zip 写入器

**Files:**
- Create: `electron/lib/zip.js`
- Create: `electron/test/zip.test.js`

**Interfaces:**
- Produces: `crc32(buf:Buffer) -> number`(标准 IEEE CRC32);`zipEntries(entries:[{name,data:Buffer}], {deflate?}) -> Buffer`(单个 DEFLATE zip,无 zip64/无 data descriptor,固定 DOS 时间)。

- [ ] **Step 1: 写失败测试**

`electron/test/zip.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { crc32, zipEntries } = require('../lib/zip');

// minimal zip reader: walk local file headers, inflate, return [{name, data}]
function readZip(buf) {
  const out = [];
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp) });
    p = dataStart + compSize;
  }
  return out;
}

test('crc32 matches known check values', () => {
  assert.strictEqual(crc32(Buffer.from('')), 0);
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926); // standard CRC32 check value
});

test('zipEntries round-trips names and content (DEFLATE)', () => {
  const entries = [
    { name: 'electron.log', data: Buffer.from('e'.repeat(5000)) },
    { name: 'backend.log', data: Buffer.from('hello backend\n') },
  ];
  const zip = zipEntries(entries);
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);            // first local file header
  assert.strictEqual(zip.readUInt32LE(zip.length - 22), 0x06054b50); // EOCD
  assert.strictEqual(zip.readUInt16LE(zip.length - 22 + 10), 2);  // total entries = 2
  const got = readZip(zip);
  assert.deepStrictEqual(got.map((e) => e.name), ['electron.log', 'backend.log']);
  assert.strictEqual(got[0].data.toString(), 'e'.repeat(5000));
  assert.strictEqual(got[1].data.toString(), 'hello backend\n');
});

test('zipEntries on empty list is a valid empty zip', () => {
  const zip = zipEntries([]);
  assert.strictEqual(zip.length, 22);                  // EOCD only
  assert.strictEqual(zip.readUInt32LE(0), 0x06054b50);
  assert.strictEqual(zip.readUInt16LE(10), 0);         // total entries = 0
  assert.deepStrictEqual(readZip(zip), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && node --test test/zip.test.js`
Expected: FAIL,`Cannot find module '../lib/zip'`。

- [ ] **Step 3: 实现**

`electron/lib/zip.js`:
```js
'use strict';
const zlib = require('zlib');

// Standard IEEE CRC32 (zip stores it over the UNcompressed data).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Build a minimal DEFLATE zip (no zip64, no data descriptor) from raw entries.
// entries: [{ name, data: Buffer }]. Deterministic: fixed DOS time (no clock —
// the sandbox forbids Date.now() and the zip mtime carries no meaning here).
function zipEntries(entries, { deflate = zlib.deflateRawSync } = {}) {
  const fileParts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const comp = deflate(data);
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0, 6);          // flags
    lfh.writeUInt16LE(8, 8);          // method = deflate
    lfh.writeUInt16LE(0, 10);         // mod time (fixed)
    lfh.writeUInt16LE(0, 12);         // mod date (fixed)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra length
    fileParts.push(lfh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);  // central directory signature
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);           // flags
    cd.writeUInt16LE(8, 10);          // method
    cd.writeUInt16LE(0, 12);          // mod time
    cd.writeUInt16LE(0, 14);          // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra length
    cd.writeUInt16LE(0, 32);          // comment length
    cd.writeUInt16LE(0, 34);          // disk number start
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs
    cd.writeUInt32LE(offset, 42);     // local header offset
    central.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + comp.length;
  }

  const filesBuf = Buffer.concat(fileParts);
  const centralBuf = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // EOCD signature
  eocd.writeUInt16LE(0, 4);           // disk number
  eocd.writeUInt16LE(0, 6);           // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);  // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(filesBuf.length, 16);   // central dir offset
  eocd.writeUInt16LE(0, 20);          // comment length

  return Buffer.concat([filesBuf, centralBuf, eocd]);
}

module.exports = { crc32, zipEntries };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/zip.test.js`
Expected: 3 PASS。

- [ ] **Step 5: 加 win32 真解压集成测试(证明资源管理器可打开)**

`electron/test/zip.test.js` 末尾追加:
```js
test('zip extracts with PowerShell Expand-Archive (win32)', { skip: process.platform !== 'win32' }, () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ziptest-'));
  const zipPath = path.join(dir, 'logs.zip');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(zipPath, zipEntries([
    { name: 'electron.log', data: Buffer.from('line1\nline2\n') },
    { name: 'backend.log', data: Buffer.from('backend ok\n') },
  ]));
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`]);
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'electron.log'), 'utf8'), 'line1\nline2\n');
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'backend.log'), 'utf8'), 'backend ok\n');
});
```

Run: `node --test test/zip.test.js`
Expected: 4 PASS(win32 上真解压通过)。

- [ ] **Step 6: 全量 + 提交**

Run: `npm test`
Expected: 全 PASS。
```bash
git add electron/lib/zip.js electron/test/zip.test.js
git commit -m "feat(obs): zero-dep DEFLATE zip writer (crc32 + zipEntries)"
```

---

### Task 2: `log-bundler.js` — `tailFileSync` + `collectTail` + `collectFull`(原始字节)

**Files:**
- Create: `electron/lib/log-bundler.js`
- Create: `electron/test/log-bundler.test.js`

**Interfaces:**
- Produces: `tailFileSync(filePath, maxBytes, fsImpl=fs) -> Buffer|null`;`collectTail({files, perFileBytes=256*1024, fsImpl=fs}) -> [{name, data:Buffer}]`(每存在文件尾部原始字节,缺失跳过);`collectFull({files, maxTotalBytes=16*1024*1024, tailBytes=256*1024, fsImpl=fs}) -> [{name, data:Buffer}]`(newest-first 累加原始字节,溢出文件尾部截断后停、丢更旧)。
- 注:`files` 项 `{path, name}`,`name` 为 zip 内文件名(无扩展变换)。`collectFull` 的 `files` **必须 newest-first**(caller 保证)。

- [ ] **Step 1: 写失败测试**

`electron/test/log-bundler.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tailFileSync, collectTail, collectFull } = require('../lib/log-bundler');

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

test('collectTail returns RAW tails, skips missing files', () => {
  const a = tmpFile('electron.log', 'x'.repeat(500));
  const out = collectTail({
    files: [
      { path: a, name: 'electron.log' },
      { path: path.join(os.tmpdir(), 'absent-abc.log'), name: 'backend.log' },
    ],
    perFileBytes: 100,
  });
  assert.deepStrictEqual(out.map((o) => o.name), ['electron.log']);
  assert.strictEqual(out[0].data.length, 100);          // raw tail, not gzipped
  assert.strictEqual(out[0].data.toString(), 'x'.repeat(100));
});

test('collectFull includes whole RAW files within budget', () => {
  const a = tmpFile('electron.log', 'aaaa');
  const b = tmpFile('backend.log', 'bbbbbb');
  const out = collectFull({
    files: [{ path: a, name: 'electron.log' }, { path: b, name: 'backend.log' }],
    maxTotalBytes: 1000, tailBytes: 2,
  });
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.toString()]), [
    ['electron.log', 'aaaa'], ['backend.log', 'bbbbbb'],
  ]);
});

test('collectFull keeps newest, tail-truncates at budget, drops oldest', () => {
  const newest = tmpFile('electron.log', 'N'.repeat(8));
  const older = tmpFile('backend.log', 'O'.repeat(8));
  const oldest = tmpFile('backend.log.2026-06-24', 'X'.repeat(8));
  const out = collectFull({
    files: [
      { path: newest, name: 'electron.log' },
      { path: older, name: 'backend.log' },
      { path: oldest, name: 'backend.log.2026-06-24' },
    ],
    maxTotalBytes: 12, tailBytes: 4,
  });
  // newest whole (8) fits; older would hit 16>12 → tail to 4 (8+4=12) fits; oldest dropped
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.length]), [
    ['electron.log', 8], ['backend.log', 4],
  ]);
});

test('collectFull skips a missing middle file without stopping', () => {
  const a = tmpFile('electron.log', 'aa');
  const c = tmpFile('backend.log.2026-06-24', 'cc');
  const out = collectFull({
    files: [
      { path: a, name: 'electron.log' },
      { path: path.join(os.tmpdir(), 'gone-xyz.log'), name: 'backend.log' },
      { path: c, name: 'backend.log.2026-06-24' },
    ],
    maxTotalBytes: 1000, tailBytes: 2,
  });
  assert.deepStrictEqual(out.map((o) => o.name), ['electron.log', 'backend.log.2026-06-24']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/log-bundler.test.js`
Expected: FAIL,`Cannot find module '../lib/log-bundler'`。

- [ ] **Step 3: 实现**

`electron/lib/log-bundler.js`:
```js
'use strict';
const fs = require('fs');

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

// crash mode: RAW tail (default 256KB) of each present file. Returns
// [{ name, data }] of raw bytes — the caller zips them into one archive.
function collectTail({ files, perFileBytes = 256 * 1024, fsImpl = fs }) {
  const out = [];
  for (const f of files) {
    const tail = tailFileSync(f.path, perFileBytes, fsImpl);
    if (tail === null) continue;
    out.push({ name: f.name, data: tail });
  }
  return out;
}

// requested mode: whole RAW files newest-first until maxTotalBytes (raw bytes).
// The file that would overflow is tail-truncated (tailBytes) if its tail still
// fits, then iteration stops — dropping older files. maxTotalBytes is a RAW cap
// chosen so the resulting zip stays well under the server's 20MB.
// PRECONDITION: `files` MUST be ordered newest-first (caller logFilesForFull()).
function collectFull({ files, maxTotalBytes = 16 * 1024 * 1024, tailBytes = 256 * 1024, fsImpl = fs }) {
  const out = [];
  let total = 0;
  for (const f of files) {
    let raw;
    try { raw = fsImpl.readFileSync(f.path); } catch (_) { continue; }
    if (total + raw.length <= maxTotalBytes) {
      out.push({ name: f.name, data: raw });
      total += raw.length;
      continue;
    }
    const tail = raw.length <= tailBytes ? raw : raw.subarray(raw.length - tailBytes);
    if (total + tail.length <= maxTotalBytes) {
      out.push({ name: f.name, data: tail });
    }
    break;
  }
  return out;
}

module.exports = { tailFileSync, collectTail, collectFull };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/log-bundler.test.js`
Expected: 6 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/lib/log-bundler.js electron/test/log-bundler.test.js
git commit -m "feat(obs): log-bundler collectTail/collectFull (raw bytes)"
```

---

### Task 3: `log-uploader.js` — `uploadLogs`(单 zip archive,multipart POST /logs)

**Files:**
- Create: `electron/lib/log-uploader.js`
- Create: `electron/test/log-uploader.test.js`

**Interfaces:**
- Produces: `async uploadLogs({endpoint, fields, archive, fetchImpl=fetch, FormDataImpl=FormData, BlobImpl=Blob}) -> boolean`(POST `{endpoint}/logs` multipart,文本字段来自 `fields`(undefined/null 跳过),单个 `files` 部件 = `archive {name, data}` 以 `application/zip`;**任何失败返回 false**)。

- [ ] **Step 1: 写失败测试**

`electron/test/log-uploader.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { uploadLogs } = require('../lib/log-uploader');

class FakeForm {
  constructor() { this.entries = []; }
  append(k, v, name) { this.entries.push([k, v, name]); }
}
class FakeBlob {
  constructor(parts, opts) { this.size = parts[0] ? parts[0].length : 0; this.type = opts && opts.type; }
}

test('uploadLogs posts fields + ONE zip archive to /logs, returns true on ok', async () => {
  let calledUrl, calledOpts;
  const fetchImpl = async (url, opts) => { calledUrl = url; calledOpts = opts; return { ok: true }; };
  const ok = await uploadLogs({
    endpoint: 'http://x:8077',
    fields: { install_id: 'i', reason: 'crash', command_id: undefined }, // undefined skipped
    archive: { name: 'logs-crash.zip', data: Buffer.from('PKzz') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calledUrl, 'http://x:8077/logs');
  assert.strictEqual(calledOpts.method, 'POST');
  const form = calledOpts.body;
  const textKeys = form.entries.filter((e) => e[0] !== 'files').map((e) => e[0]).sort();
  assert.deepStrictEqual(textKeys, ['install_id', 'reason']);   // command_id=undefined dropped
  const fileEntries = form.entries.filter((e) => e[0] === 'files');
  assert.strictEqual(fileEntries.length, 1);                    // exactly one archive part
  assert.strictEqual(fileEntries[0][2], 'logs-crash.zip');
  assert.strictEqual(fileEntries[0][1].type, 'application/zip');
});

test('uploadLogs returns false when fetch rejects', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const ok = await uploadLogs({
    endpoint: 'http://x', fields: {}, archive: { name: 'logs.zip', data: Buffer.from('z') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, false);
});

test('uploadLogs returns false on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const ok = await uploadLogs({
    endpoint: 'http://x', fields: {}, archive: { name: 'logs.zip', data: Buffer.from('z') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/log-uploader.test.js`
Expected: FAIL,`Cannot find module '../lib/log-uploader'`。

- [ ] **Step 3: 实现**

`electron/lib/log-uploader.js`:
```js
'use strict';

// POST a single zipped log archive as multipart/form-data to {endpoint}/logs.
// Failures are swallowed (return false): archives are too large for the 200-item
// event queue; requested uploads retry on the next poll, crash uploads on the next
// crash. The file field stays 'files' (server accepts files[], one part is fine).
// FormData/Blob are Node 18+ globals; injected here for tests.
async function uploadLogs({
  endpoint, fields, archive,
  fetchImpl = fetch, FormDataImpl = FormData, BlobImpl = Blob,
}) {
  try {
    const form = new FormDataImpl();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    form.append('files', new BlobImpl([archive.data], { type: 'application/zip' }), archive.name);
    const res = await fetchImpl(`${endpoint}/logs`, { method: 'POST', body: form });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

module.exports = { uploadLogs };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/log-uploader.test.js`
Expected: 3 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/lib/log-uploader.js electron/test/log-uploader.test.js
git commit -m "feat(obs): log-uploader single-zip multipart POST /logs (silent-fail)"
```

---

### Task 4: `commands.js` — 解析与 URL 构造

**Files:**
- Create: `electron/lib/commands.js`
- Create: `electron/test/commands.test.js`

**Interfaces:**
- Produces: `parseCommands(body) -> [{id, type:'upload_logs'}]`(只留含 `id` 且 `type==='upload_logs'` 的项;脏 body 返回 `[]`);`commandsUrl(endpoint, installId) -> string`;`ackUrl(endpoint, installId, commandId) -> string`(两者对 id 段 `encodeURIComponent`)。

- [ ] **Step 1: 写失败测试**

`electron/test/commands.test.js`:
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

Run: `node --test test/commands.test.js`
Expected: FAIL,`Cannot find module '../lib/commands'`。

- [ ] **Step 3: 实现**

`electron/lib/commands.js`:
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

Run: `node --test test/commands.test.js`
Expected: 3 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/lib/commands.js electron/test/commands.test.js
git commit -m "feat(obs): commands parse + commandsUrl/ackUrl builders"
```

---

### Task 5: main.js wiring — 崩溃自动上传(reason=crash,每会话一次)

**Files:**
- Modify: `electron/main.js`

无单测(纯 wiring);Task 7 手工 E2E。**Interfaces consumed:** `collectTail`/`zipEntries`/`uploadLogs`(Task 1/2/3)、`getAppDataDir`/`getOrCreateInstallId`/`osMod`/`updateConfig`/`telemetry`/`backendStopping`(现有)。

- [ ] **Step 1: require 三模块 + 模块态**

`electron/main.js` 顶部 require 区(`const { drainSpool } = require('./lib/spool');` 之后,按内容定位)加:
```js
const { zipEntries } = require('./lib/zip');
const { collectTail, collectFull } = require('./lib/log-bundler');
const { uploadLogs } = require('./lib/log-uploader');
const { parseCommands, commandsUrl, ackUrl } = require('./lib/commands');
```
模块态区(`let backendStopping = false;` 一行附近)加:
```js
let crashUploadDone = false; // Phase B: at most one reason=crash log upload per app session
```

- [ ] **Step 2: 公共辅助(字段 + 文件清单 + 崩溃上传)**

在 `getOrCreateInstallId()` 函数定义之后(按内容定位,任意模块级位置均可)插入:
```js
// Phase B log-upload helpers. Logs live in %APPDATA%\IPMaster-Cowork\logs:
// electron.log + backend.log (+ daily-rotated backend.log.<YYYY-MM-DD> backups,
// named by the backend's TimedRotatingFileHandler using LOCAL date).
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
    { path: path.join(logsDir, 'electron.log'), name: 'electron.log' },
    { path: path.join(logsDir, 'backend.log'), name: 'backend.log' },
  ];
}

function logFilesForFull() {
  const logsDir = path.join(getAppDataDir(), 'logs');
  // LOCAL-date suffix to match the backend's TimedRotatingFileHandler(when=midnight,
  // local time); a UTC date would miss yesterday's backup around local midnight.
  const d = new Date(Date.now() - 86400000);
  const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // newest first — collectFull keeps newest, drops oldest when over budget
  return [
    { path: path.join(logsDir, 'electron.log'), name: 'electron.log' },
    { path: path.join(logsDir, 'backend.log'), name: 'backend.log' },
    { path: path.join(logsDir, `backend.log.${yesterday}`), name: `backend.log.${yesterday}` },
  ];
}

// Fire-and-forget crash log upload, gated behind telemetry opt-in and once per
// app session (avoids spamming bundles in a crash-restart loop; the tail already
// contains the repeated crashes).
function uploadCrashLogs() {
  if (crashUploadDone || !telemetry) return;
  crashUploadDone = true;
  try {
    const entries = collectTail({ files: logFilesForTail() });
    if (entries.length === 0) return;
    const zip = zipEntries(entries);
    uploadLogs({
      endpoint: updateConfig.telemetryUrl,
      fields: clientFields('crash'),
      archive: { name: 'logs-crash.zip', data: zip },
    }).catch(() => {});
  } catch (_) {}
}
```

- [ ] **Step 3: 接入 backend_crash 上报点**

按内容定位后端 `exit` handler 内现有 `telemetry.report('backend_crash', {...})` 块(约 L558-565)。在该 `if (...) { ... }` 块**之后**插入:
```js
      if (code !== null && code !== 0 && !backendStopping) uploadCrashLogs();
```

- [ ] **Step 4: 接入 renderer_crash 上报点**

按内容定位 `render-process-gone` handler 内现有 `telemetry.report('renderer_crash', {...})` 块(约 L770-775)。在该 `if (telemetry) { ... }` 块**之后**插入:
```js
    uploadCrashLogs();
```
(该 handler 顶部已有 `if (details && details.reason === 'clean-exit') return;`,clean-exit 不会到这里。)

- [ ] **Step 5: 语法检查 + 现有测试**

Run: `cd electron && node --check main.js && npm test 2>&1 | grep -aE "# pass|# fail"`
Expected: 语法 OK;全 PASS(无新增单测,旧的不回归)。

- [ ] **Step 6: 提交**

```bash
git add electron/main.js
git commit -m "feat(obs): upload crash log tail as one zip (reason=crash, once per session)"
```

---

### Task 6: main.js wiring — 指令轮询(启动 + 每 10 分钟 → requested 上传 → ack)

**Files:**
- Modify: `electron/main.js`

无单测(纯 wiring);Task 7 手工 E2E。**Interfaces consumed:** `commandsUrl`/`parseCommands`/`ackUrl`(Task 4)、`collectFull`/`zipEntries`/`uploadLogs`(Task 2/1/3)、`clientFields`/`logFilesForFull`(Task 5)。

- [ ] **Step 1: 接入轮询**

按内容定位 `app.whenReady().then(...)` 内 spool drain 的 `setInterval(drainSpoolIntoTelemetry, 30_000);`(约 L1051)**之后**插入:
```js
  // Poll the management server for upload_logs commands (spec §6). Startup + every
  // 10 min. Each command: collect full logs → zip → POST /logs (reason=requested)
  // → ack on success. All failures retry next cycle.
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
          const entries = collectFull({ files: logFilesForFull() });
          let ok = true;
          if (entries.length > 0) {
            const zip = zipEntries(entries);
            ok = await uploadLogs({
              endpoint: base,
              fields: clientFields('requested', { command_id: cmd.id }),
              archive: { name: 'logs-requested.zip', data: zip },
            });
          }
          // ack on successful upload, or when there was nothing to upload (consume the command)
          if (ok) await fetch(ackUrl(base, installId, cmd.id), { method: 'POST' }).catch(() => {});
        } catch (_) {}
      }
    } catch (_) {}
  }
  pollCommands();
  setInterval(pollCommands, 10 * 60 * 1000);
```

- [ ] **Step 2: 语法检查 + 现有测试**

Run: `node --check main.js && npm test 2>&1 | grep -aE "# pass|# fail"`
Expected: 语法 OK;全 PASS。

- [ ] **Step 3: 提交**

```bash
git add electron/main.js
git commit -m "feat(obs): poll upload_logs commands, upload full logs zip + ack"
```

---

### Task 7: 全量回归 + 手工 E2E 清单

**Files:** 无代码改动(最后记录结果时改本 plan)。

- [ ] **Step 1: electron 全量**

Run: `cd electron && npm test 2>&1 | grep -aE "# tests|# pass|# fail"`
Expected: 全 PASS(Phase A 的 58 + 本期 zip 4 + log-bundler 6 + log-uploader 3 + commands 3 = 74)。

- [ ] **Step 2: 手工 E2E(打包安装态执行,需真实服务端;记录每项 PASS/FAIL + 现象)**

1. **指令上传(reason=requested)**:管理后台对本机 install_id 置 `upload_logs` 标记 → 客户端 10 分钟内(或重启即时)`POST /logs` 上传 `logs-requested.zip`,后台出现该包并可下载、资源管理器双击解压含 `electron.log` + `backend.log`(全量)[+ 昨日 `backend.log.<date>` 若存在];上传成功后标记被 ack 清除。
2. **崩溃自动(reason=crash)**:任务管理器结束后端 exe → 后台出现 `logs-crash.zip`、`reason=crash`,含 electron/backend 日志尾部;**再次**结束后端**不应**产生第二个 crash 包(每会话一次守卫)。
3. **正常关闭不误传**:正常退出应用**不应**产生任何 crash 包(backendStopping / clean-exit 抑制)。
4. **离线韧性**:断开服务端、置标记 → 客户端轮询失败不崩;恢复后下个周期完成上传。

- [ ] **Step 3: 记录结果 + 收尾提交**

```bash
git add docs/superpowers/plans/2026-06-25-client-observability-phase-b.md
git commit -m "docs(obs): record Phase B verification results"
```

---

## Self-review 记录

- **Spec 覆盖**:§6 zip 写入器=Task1;collectTail/collectFull=Task2;单 archive 上传=Task3;指令解析/URL=Task4;§6 崩溃自动(每会话一次)=Task5;§6 指令轮询(启动+10min,requested+ack)=Task6;§7 上传契约(字段/单 zip 命名 `logs-crash.zip`/`logs-requested.zip`)=Task3+Task5/6。会话上报(session_report)属 Phase C,不在本 plan。
- **类型一致**:`collectTail`/`collectFull` 返回 `[{name, data:Buffer}]` → `zipEntries(entries)` → `Buffer` → `uploadLogs({archive:{name,data}})`;`parseCommands` 产出含 `.id` 项 → `ackUrl(_,_,cmd.id)` 消费。`clientFields(reason, extra)` 产 §7 文本字段。
- **实仓适配**:后端日志名用 `backend.log`(electron 写 `IPMC_LOG_FILENAME=backend.log`),非旧 spec 的 `ipmastercowork.log`;dated backup `backend.log.<本地日期>`;`logFilesForFull` 用**本地日期**(后端 TimedRotatingFileHandler 本地命名),非 UTC。
- **失败语义**:上传失败静默 false 不入队列;crash 0 条不传;requested 0 条仍 ack;crash 守卫 `crashUploadDone` 模块级、telemetry 关闭即跳过;`zip` 确定性(固定 DOS 时间)。
- **已知延后(非阻塞,沿用旧 Phase B 决策,本期不做,记入最终 review 评估)**:(a) `endpoint` 末尾斜杠未归一化(若 `telemetryUrl` 带 `/` 会产生 `//`);(b) `pollCommands`/`uploadLogs` 的 `fetch` 无超时/AbortSignal。两者 fire-and-forget 下危害有限。
- 不打包、不 bump、不提交 package-lock/.gitignore;每任务 `git add` 仅本任务文件。

---

## Phase B 实施结果(2026-06-25,subagent-driven 执行,落 master)

**全部 6 个代码任务完成,终审(opus 全特性 review)通过(零 Critical)。**

提交链(master):
- `87eb90d` zip.js 零依赖 DEFLATE 写入器(T1,含 win32 `Expand-Archive` 真解压验证)、`dfe48b4` log-bundler collectTail/collectFull(T2)、`5ff7c07` log-uploader 单 zip multipart(T3)、`8dd7649` commands 解析/URL(T4)、`39aa7df` 崩溃自动上传(T5)、`09c226a` 指令轮询 + requested 上传 + ack(T6)、`a7a4443` 终审 follow-up(I-1:bundle 每轮一次而非每命令一次)。

测试:electron `npm test` = **74/74 PASS**(Phase A 58 + 本期 zip 4 / log-bundler 6 / log-uploader 3 / commands 3)。两个 wiring 任务(T5/T6)无单测,靠 `node --check` + 全量回归。

**终审核验的端到端**:`collectTail/collectFull` 返回 `[{name,data:Buffer}]` 原始字节 → `zipEntries` → Buffer → `uploadLogs({archive})` → POST `/logs`,buffer 形状各边界一致(`{path,name}` 仅在输入侧、不入 zip);zip 真有效(win32 Expand-Archive 走的是生产同一 `zipEntries(rawEntries)` 路径);全链路 fire-and-forget(upload/poll 失败不抛进主进程、不入 200 条队列);crash 每会话一次(`crashUploadDone` 在 async 前置)+ intentional-stop 抑制(`backendStopping`);`logFilesForFull` 昨日 backup 用**本地日期**(匹配后端 TimedRotatingFileHandler)。

**终审发现并已修(Important I-1)**:`pollCommands` 原在每命令循环内 `collectFull`+`zipEntries`,N 个命令会重复读+压最多 16MB 日志 N 次。修法:bundle 每轮构建一次、跨命令复用(`a7a4443`)。
**已知延后(终审确认本上下文低危,本期不做)**:`endpoint` 末尾斜杠未归一化;`fetch` 无超时/AbortSignal(可加 ~30s 超时 + interval 重入守卫做 parity)。

### 手工 E2E 清单(打包安装态执行,**尚未跑** —— 需安装态 + 真实服务端)
1. 指令上传(reason=requested):后台置 `upload_logs` 标记 → 10min 内(或重启即时)`logs-requested.zip` 上传,后台可下载、解压含 `electron.log`+`backend.log`[+ 昨日 backup];ack 清标记。
2. 崩溃自动(reason=crash):结束后端 exe → `logs-crash.zip`;**再次**结束不应产生第二个 crash 包(每会话一次)。
3. 正常关闭不误传;断网轮询不崩、恢复后补传。

### 发版提醒
本期**未打包、未 bump 版本**。随发版时按 CLAUDE.md 原则先 bump 再打包;打包态跑上面 E2E。
```
