# Single-Zip Log Upload Bundle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the client `/logs` upload to send **one DEFLATE `.zip`** per upload (containing electron.log + backend log(s)) instead of 2–3 separate `.gz` files, for both crash and requested triggers.

**Architecture:** New zero-dependency `electron/lib/zip.js` (CRC32 + minimal DEFLATE zip writer over Node's `zlib.deflateRawSync`). Refactor `log-bundler.js` to return **raw** file buffers (`collectTail`/`collectFull`) instead of per-file gzip. `log-uploader.js` posts a single `files[]` archive part. `main.js` zips the collected entries and uploads one `.zip`. Server unchanged.

**Tech Stack:** Electron main (CommonJS, `node:test`), Node 24 (`zlib`, global `FormData`/`Blob`/`fetch`). Spec: `docs/superpowers/specs/2026-06-11-log-zip-bundle-design.md`.

---

## 全局约定

- **工作目录:`D:\20_code\miniAgentsDemo`,分支 `feat/log-zip-bundle`**(已创建,基于 master 58e4c09)。
- Electron 测试:`cd electron && npm test`(node --test test/*.test.js)。
- **绝不提交**:`uv.lock`、`.claire/`、`.gitignore`、`electron/package-lock.json`。
- 不打包(打包/发版单独做)。代码风格:纯逻辑入 `electron/lib/*.js` 可注入依赖、配 `electron/test/*.test.js`;注释只写代码看不出来的约束。

## 文件结构

| 文件 | 职责 |
|------|------|
| Create `electron/lib/zip.js` | `crc32` + `zipEntries(entries)` → 单个 DEFLATE zip Buffer(零依赖) |
| Create `electron/test/zip.test.js` | crc32 向量、zip 结构、node 往返解压、(win32) Expand-Archive 真解压 |
| Modify `electron/lib/log-bundler.js` | `bundleTail`/`bundleFull` → `collectTail`/`collectFull`(返回**原始**字节);保留 `tailFileSync` |
| Modify `electron/test/log-bundler.test.js` | 改测 `collectTail`/`collectFull`(原始字节) |
| Modify `electron/lib/log-uploader.js` | `uploadLogs` 入参 `files[]` → 单个 `archive {name,data}`;Blob type `application/zip` |
| Modify `electron/test/log-uploader.test.js` | 改测单 archive 部件 |
| Modify `electron/main.js` | require zip + collect*;`logFilesForTail/Full` 用 zip 内名;crash/requested 各 zip 成一个包上传 |

---

### Task 0: 基线确认

**Files:** 无代码改动。

- [ ] **Step 1: 分支 + 基线**

```bash
cd /d/20_code/miniAgentsDemo && git branch --show-current && cd electron && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: 分支 `feat/log-zip-bundle`;npm test 全 PASS(47)。

---

### Task 1: `zip.js` — CRC32 + 最小 DEFLATE zip 写入器

**Files:**
- Create: `electron/lib/zip.js`
- Create: `electron/test/zip.test.js`

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
  // signatures present
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

```bash
cd electron && node --test test/zip.test.js
```
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

```bash
node --test test/zip.test.js
```
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

```bash
node --test test/zip.test.js
```
Expected: 4 PASS(win32 上 Expand-Archive 真解压通过)。

- [ ] **Step 6: 提交**

```bash
git add lib/zip.js test/zip.test.js
git commit -m "feat(obs): zero-dep DEFLATE zip writer (crc32 + zipEntries)"
```

---

### Task 2: `log-bundler` 改为返回原始字节(`collectTail`/`collectFull`)

**Files:**
- Modify: `electron/lib/log-bundler.js`
- Modify: `electron/test/log-bundler.test.js`

- [ ] **Step 1: 重写测试**

`electron/test/log-bundler.test.js` 整体替换为:
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
  const b = tmpFile('ipmaster-cowork.log', 'bbbbbb');
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
  const older = tmpFile('ipmaster-cowork.log', 'O'.repeat(8));
  const oldest = tmpFile('ipmaster-cowork.log.2026-06-10', 'X'.repeat(8));
  const out = collectFull({
    files: [
      { path: newest, name: 'electron.log' },
      { path: older, name: 'backend.log' },
      { path: oldest, name: 'backend.log.2026-06-10' },
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
  const c = tmpFile('ipmaster-cowork.log.2026-06-10', 'cc');
  const out = collectFull({
    files: [
      { path: a, name: 'electron.log' },
      { path: path.join(os.tmpdir(), 'gone-xyz.log'), name: 'backend.log' },
      { path: c, name: 'backend.log.2026-06-10' },
    ],
    maxTotalBytes: 1000, tailBytes: 2,
  });
  assert.deepStrictEqual(out.map((o) => o.name), ['electron.log', 'backend.log.2026-06-10']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/log-bundler.test.js
```
Expected: FAIL(`collectTail`/`collectFull` 未导出)。

- [ ] **Step 3: 实现**

`electron/lib/log-bundler.js` 整体替换为:
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
// fits, then iteration stops — dropping older files (spec §架构). maxTotalBytes
// is a RAW cap chosen so the resulting zip stays well under the server's 20MB.
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

```bash
node --test test/log-bundler.test.js
```
Expected: 6 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/log-bundler.js test/log-bundler.test.js
git commit -m "refactor(obs): log-bundler returns raw entries (collectTail/collectFull)"
```

---

### Task 3: `log-uploader` 上传单个 archive

**Files:**
- Modify: `electron/lib/log-uploader.js`
- Modify: `electron/test/log-uploader.test.js`

- [ ] **Step 1: 重写测试**

`electron/test/log-uploader.test.js` 整体替换为:
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
    fields: { install_id: 'i', reason: 'crash', command_id: undefined },
    archive: { name: 'logs-crash.zip', data: Buffer.from('PKzz') },
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

```bash
node --test test/log-uploader.test.js
```
Expected: FAIL(当前实现用 `files` 数组,新测试断言单 `archive`)。

- [ ] **Step 3: 实现**

`electron/lib/log-uploader.js` 整体替换为:
```js
'use strict';

// POST a single gzipped/zipped log archive as multipart/form-data to {endpoint}/logs.
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

```bash
node --test test/log-uploader.test.js
```
Expected: 3 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/log-uploader.js test/log-uploader.test.js
git commit -m "refactor(obs): uploadLogs posts a single zip archive part"
```

---

### Task 4: main.js wiring — zip 成一个包上传

**Files:**
- Modify: `electron/main.js`

无法单测(纯 wiring);Task 5 有手工验证。

- [ ] **Step 1: require**

`electron/main.js` 顶部 require 区:把
```js
const { bundleTail, bundleFull } = require('./lib/log-bundler');
```
改为:
```js
const { collectTail, collectFull } = require('./lib/log-bundler');
const { zipEntries } = require('./lib/zip');
```
(`const zlib = require('zlib');` 若仅被旧 bundler 用法引用可保留——其他地方未用到则一并删除该行。先确认:`grep -n "zlib" electron/main.js`,若除该 require 外无其他引用,删 require 行。)

- [ ] **Step 2: 改 zip 内文件名(去 .gz)**

`logFilesForTail()` 改为:
```js
function logFilesForTail() {
  const logsDir = path.join(getAppDataDir(), 'logs');
  return [
    { path: path.join(logsDir, 'electron.log'), name: 'electron.log' },
    { path: path.join(logsDir, 'ipmaster-cowork.log'), name: 'backend.log' },
  ];
}
```
`logFilesForFull()` 改为:
```js
function logFilesForFull() {
  const logsDir = path.join(getAppDataDir(), 'logs');
  const ymd = (d) => d.toISOString().slice(0, 10);
  const yesterday = ymd(new Date(Date.now() - 86400000));
  // newest first — collectFull keeps newest, drops oldest when over budget
  return [
    { path: path.join(logsDir, 'electron.log'), name: 'electron.log' },
    { path: path.join(logsDir, 'ipmaster-cowork.log'), name: 'backend.log' },
    { path: path.join(logsDir, `ipmaster-cowork.log.${yesterday}`), name: `backend.log.${yesterday}` },
  ];
}
```

- [ ] **Step 3: crash 上传一个 zip**

`uploadCrashLogs()` 的 body(`crashUploadDone = true;` 之后的 try 块)改为:
```js
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
```

- [ ] **Step 4: requested 上传一个 zip**

`pollCommands()` 内命中命令的循环体改为:
```js
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
```

- [ ] **Step 5: 语法 + 现有测试**

```bash
cd /d/20_code/miniAgentsDemo/electron && node --check main.js && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: 语法 OK;全 PASS。

- [ ] **Step 6: 提交**

```bash
git add main.js
git commit -m "feat(obs): upload crash/requested logs as a single zip archive"
```

---

### Task 5: 全量回归 + 手工 E2E

**Files:** 无代码改动(最后记录结果时改 plan)。

- [ ] **Step 1: electron 全量**

```bash
cd /d/20_code/miniAgentsDemo/electron && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: 全 PASS(zip 新增 4 + bundler 6 + uploader 3 + 其余不变)。

- [ ] **Step 2: 手工 E2E(打包态,透明代理抓 /logs)**

记录实际结果:
1. **crash**:启动打包 app(0.3.0)指向 `localhost:8077`(或代理)→ kill backend → 代理出现**一个** `POST /logs` 部件 `logs-crash.zip`;服务端日志列表出现该 zip;资源管理器双击能打开,含 `electron.log` + `backend.log`(尾部)。
2. **requested**:后台/本地 server enqueue `upload_logs` → 客户端轮询 → 代理出现**一个** `POST /logs` 部件 `logs-requested.zip`;下载解压含 `electron.log` + `backend.log`(全量)[+ 昨日 backup 若存在]。
3. **空日志**:若无日志文件,crash 不上传;requested 无内容仍 ack(命令销账)。

- [ ] **Step 3: 记录结果 + 收尾提交**

```bash
git add docs/superpowers/plans/2026-06-11-log-zip-bundle.md
git commit -m "docs(obs): record zip-bundle verification results"
```

---

## Self-review 记录

- **Spec 覆盖**:zip 格式=Task1;raw bundler=Task2;单 archive 上传=Task3;wiring+内名+空处理=Task4;测试(单测+win32 真解压+e2e)=Task1/5。服务端无改动=设计明确。
- **类型一致**:`collectTail`/`collectFull` 返回 `[{name, data:Buffer}]`(raw);`zipEntries(entries)`→`Buffer`;`uploadLogs({archive:{name,data}})` 消费之;main.js 串联一致。`tailFileSync` 保留、复用于 collectTail。
- **无 placeholder**:每步含完整代码与期望输出。
- **失败语义**:上传失败静默 false;crash 0 条不传;requested 0 条仍 ack;zip 确定性(固定 DOS 时间,不用时钟)。
- **不提交** package-lock/.claire/.gitignore;不打包。
