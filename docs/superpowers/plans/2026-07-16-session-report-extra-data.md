# 会话上报增强:附带 skills / agents / references / configs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话上报 zip 在现有 `sqlite.gz + environment.json + 日志尾巴` 之外,附带本地 skills/agents 目录、skill references 与 llm/mcp/.env 配置,并写一份 `report-manifest.json` 记录带了什么、跳过了什么。

**Architecture:** 纯 Electron 侧组装(方案 A,后端零改动)。新增一个纯函数模块 `electron/lib/report-collect.js`,把"遍历目录/读配置文件/施加体积安全阀/生成 manifest"全部做成可注入 `fsImpl` 的纯函数;`report-session` handler 只负责把 AppData 路径喂进去、把结果并入现有 zip。既有 `buildSessionReportEntries` 做向后兼容扩展(新参数默认空,老测试不变)。

**Tech Stack:** Node.js (Electron 主进程)、`node:test` + `node:assert`、CommonJS。

## Global Constraints

- 组装全在 Electron 侧;**不改后端 Python**。
- 密钥**原样带上,不脱敏**(用户在两次风险提醒后的明确决定)。见 spec §7。
- 服务端上传包 **20MB 上限**;skills+agents **合计 raw 预算 16MB**、**单文件 2MB** 跳过(spec §5)。config 类小文件不受 16MB 约束(各自独立预算)。
- **不静默截断**:被跳过的文件必须出现在 `report-manifest.json`。
- 任何单点失败(目录缺失、单文件读失败)**不得阻断整体上报**;记入 manifest 后继续。
- 纯函数一律支持注入 `fsImpl`(默认 `require('fs')`),便于单测。
- 所有 zip entry 名用 **正斜杠** 相对路径;目录遍历顺序按相对路径 **排序**(确定性,可测试)。
- Windows 环境:测试用 `node --test`(见既有 `electron/test/*.test.js`),真实临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))`。

**Spec:** `docs/superpowers/specs/2026-07-16-session-report-extra-data-design.md`

## File Structure

- **Create** `electron/lib/report-collect.js` — 纯函数:`collectDirTree`、`collectFiles`、`buildReportManifest`、`gatherExtraReportData`。单一职责:把磁盘上的静态数据收集成 zip entries + manifest。
- **Create** `electron/test/report-collect.test.js` — 上述纯函数的单测。
- **Modify** `electron/lib/session-report.js` — `buildSessionReportEntries` 增加 `extraEntries` / `manifest` 两个可选入参(向后兼容)。
- **Modify** `electron/test/session-report.test.js` — 覆盖新入参。
- **Modify** `electron/main.js` — 顶部 require 新模块;`report-session` handler(1326-1327 一带)接线。

## 配置 allowlist(精确路径,`AppData` 根 = `getAppDataDir()`)

| 来源 | 磁盘路径 | zip entry 名 |
|---|---|---|
| 本地 skills 目录 | `getUserSkillsDir()` = `<AppData>/skills` | `skills/<rel>` |
| 本地 agents 目录 | `getUserAgentsDir()` = `<AppData>/agents` | `agents/<rel>` |
| .env | `<AppData>/.env` | `config/.env` |
| skill references | `<AppData>/data/skill_references.json` | `config/skill_references.json` |
| 旧拉取记录 | `<AppData>/data/skill_pull_config.json` | `config/skill_pull_config.json` |
| 内网 MCP 端点 | `<AppData>/resources/mcp.json` | `config/mcp.json` |
| LLM 配置(含密钥) | `<AppData>/data/llm_configs/*.json` | `config/llm_configs/<rel>` |
| MCP 配置 | `<AppData>/data/mcp_configs/*.json` | `config/mcp_configs/<rel>` |

> **绝不盲扫 `data/` 根**:那里还有 SQLite 库(`ipmc-*.db`)、WAL 等运行态文件,盲扫会与会话 SQLite 重复且体积失控。只走上表 allowlist。

---

### Task 1: `collectDirTree` — 递归目录收集 + 体积安全阀

**Files:**
- Create: `electron/lib/report-collect.js`
- Test: `electron/test/report-collect.test.js`

**Interfaces:**
- Produces:
  - `collectDirTree({ dir, prefix, perFileBytes?, budgetRemaining?, fsImpl? })` →
    `{ entries: Array<{name:string,data:Buffer}>, skipped: Array<{path:string,bytes:number,reason:'file-too-large'|'budget-exceeded'}>, errors: Array<{path:string,reason:string}>, bytesUsed: number, present: boolean }`
  - 常量 `PER_FILE_MAX = 2*1024*1024`、`TREE_BUDGET = 16*1024*1024`
- 语义:目录不存在 → `present:false` 且各数组为空。文件 `size > perFileBytes` → 记 `skipped(file-too-large)`,不影响预算。第一个装不下预算的文件起(含其后所有文件)→ 记 `skipped(budget-exceeded)`。读/stat 异常 → 记 `errors`,继续。entry 名 = `${prefix}/${rel}`(正斜杠),遍历按 `rel` 排序。

- [ ] **Step 1: Write the failing tests**

```js
// electron/test/report-collect.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectDirTree, PER_FILE_MAX, TREE_BUDGET } = require('../lib/report-collect');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')); }
function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

test('collectDirTree: absent dir → present:false, empty', () => {
  const res = collectDirTree({ dir: path.join(os.tmpdir(), 'no-such-rc-xyz'), prefix: 'skills' });
  assert.strictEqual(res.present, false);
  assert.deepStrictEqual(res.entries, []);
  assert.deepStrictEqual(res.skipped, []);
  assert.strictEqual(res.bytesUsed, 0);
});

test('collectDirTree: recurses, sorts, prefixes with forward slashes', () => {
  const d = tmpDir();
  write(d, 'b.md', 'BB');
  write(d, 'sub/a.md', 'A');
  const res = collectDirTree({ dir: d, prefix: 'skills' });
  assert.strictEqual(res.present, true);
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['skills/b.md', 'skills/sub/a.md']);
  assert.strictEqual(res.entries[1].data.toString(), 'A');
  assert.strictEqual(res.bytesUsed, 3);
});

test('collectDirTree: file over per-file cap → skipped(file-too-large), budget intact', () => {
  const d = tmpDir();
  write(d, 'big.bin', Buffer.alloc(11));
  write(d, 'small.md', 'ok');
  const res = collectDirTree({ dir: d, prefix: 'skills', perFileBytes: 10 });
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['skills/small.md']);
  assert.deepStrictEqual(res.skipped, [{ path: 'skills/big.bin', bytes: 11, reason: 'file-too-large' }]);
});

test('collectDirTree: budget overflow latches — file + all later → budget-exceeded', () => {
  const d = tmpDir();
  write(d, 'a.md', 'AAAA');   // 4
  write(d, 'b.md', 'BBBB');   // 4 → would hit budget
  write(d, 'c.md', 'C');      // 1 → still dropped once latched
  const res = collectDirTree({ dir: d, prefix: 'agents', budgetRemaining: 5 });
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['agents/a.md']);
  assert.strictEqual(res.bytesUsed, 4);
  assert.deepStrictEqual(res.skipped, [
    { path: 'agents/b.md', bytes: 4, reason: 'budget-exceeded' },
    { path: 'agents/c.md', bytes: 1, reason: 'budget-exceeded' },
  ]);
});

test('collectDirTree: read error on a file → recorded in errors, continues', () => {
  const d = tmpDir();
  write(d, 'good.md', 'g');
  const fsImpl = {
    statSync: (p) => fs.statSync(p),
    readdirSync: (p, o) => fs.readdirSync(p, o),
    readFileSync: (p) => { if (String(p).endsWith('good.md')) throw new Error('boom'); return fs.readFileSync(p); },
  };
  const res = collectDirTree({ dir: d, prefix: 'skills', fsImpl });
  assert.deepStrictEqual(res.entries, []);
  assert.strictEqual(res.errors.length, 1);
  assert.strictEqual(res.errors[0].path, 'skills/good.md');
  assert.match(res.errors[0].reason, /boom/);
});

test('collectDirTree: constants exported', () => {
  assert.strictEqual(PER_FILE_MAX, 2 * 1024 * 1024);
  assert.strictEqual(TREE_BUDGET, 16 * 1024 * 1024);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd electron && node --test test/report-collect.test.js`
Expected: FAIL — `Cannot find module '../lib/report-collect'`.

- [ ] **Step 3: Write minimal implementation**

```js
// electron/lib/report-collect.js
'use strict';
const fs = require('fs');
const path = require('path');

const PER_FILE_MAX = 2 * 1024 * 1024;   // 单文件 2MB 上限
const TREE_BUDGET = 16 * 1024 * 1024;   // skills+agents 合计 raw 预算 16MB

const errMsg = (e) => String((e && e.message) || e);

// Recursively collect files under `dir` into zip entries named `${prefix}/<relpath>`
// (posix separators), deterministic (relpath-sorted). Enforces a per-file size cap
// and a shared byte budget; over-cap → skipped(file-too-large), first over-budget
// file and all later ones → skipped(budget-exceeded). stat/read failures → errors.
// Absent dir → { present:false, ...empty }. Never throws.
function collectDirTree({ dir, prefix, perFileBytes = PER_FILE_MAX, budgetRemaining = TREE_BUDGET, fsImpl = fs }) {
  const out = { entries: [], skipped: [], errors: [], bytesUsed: 0, present: false };
  try { if (!fsImpl.statSync(dir).isDirectory()) return out; } catch (_) { return out; }
  out.present = true;

  const rels = [];
  (function walk(cur, relBase) {
    let dirents;
    try { dirents = fsImpl.readdirSync(cur, { withFileTypes: true }); }
    catch (e) { out.errors.push({ path: relBase ? `${prefix}/${relBase}` : prefix, reason: errMsg(e) }); return; }
    for (const de of dirents) {
      const rel = relBase ? `${relBase}/${de.name}` : de.name;
      if (de.isDirectory()) walk(path.join(cur, de.name), rel);
      else if (de.isFile()) rels.push(rel);
    }
  })(dir, '');
  rels.sort();

  let remaining = budgetRemaining;
  let budgetHit = false;
  for (const rel of rels) {
    const full = path.join(dir, rel);
    const name = `${prefix}/${rel}`;
    let size;
    try { size = fsImpl.statSync(full).size; } catch (e) { out.errors.push({ path: name, reason: errMsg(e) }); continue; }
    if (size > perFileBytes) { out.skipped.push({ path: name, bytes: size, reason: 'file-too-large' }); continue; }
    if (budgetHit || size > remaining) { budgetHit = true; out.skipped.push({ path: name, bytes: size, reason: 'budget-exceeded' }); continue; }
    let data;
    try { data = fsImpl.readFileSync(full); } catch (e) { out.errors.push({ path: name, reason: errMsg(e) }); continue; }
    out.entries.push({ name, data });
    out.bytesUsed += data.length;
    remaining -= data.length;
  }
  return out;
}

module.exports = { PER_FILE_MAX, TREE_BUDGET, collectDirTree };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd electron && node --test test/report-collect.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/lib/report-collect.js electron/test/report-collect.test.js
git commit -m "feat(session-report): collectDirTree — 递归目录收集+2MB/16MB体积安全阀"
```

---

### Task 2: `collectFiles` — 显式 allowlist 文件收集

**Files:**
- Modify: `electron/lib/report-collect.js`
- Test: `electron/test/report-collect.test.js`

**Interfaces:**
- Produces:
  - `collectFiles({ files, fsImpl? })` where `files: Array<{path:string,name:string}>` →
    `{ entries: Array<{name,data}>, included: string[], absent: string[], errors: Array<{path,reason}> }`
- 语义:文件不存在(`ENOENT`)→ 记 `absent`(用 entry 名);其它读失败 → 记 `errors`;成功 → `entries` + `included`。**不施加体积阀**(config 类小文件)。

- [ ] **Step 1: Write the failing tests**

```js
// append to electron/test/report-collect.test.js
const { collectFiles } = require('../lib/report-collect');

test('collectFiles: present → entry+included, missing → absent', () => {
  const d = tmpDir();
  const p = write(d, 'skill_references.json', '{"v":2}');
  const res = collectFiles({ files: [
    { path: p, name: 'config/skill_references.json' },
    { path: path.join(d, 'nope.json'), name: 'config/nope.json' },
  ] });
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['config/skill_references.json']);
  assert.strictEqual(res.entries[0].data.toString(), '{"v":2}');
  assert.deepStrictEqual(res.included, ['config/skill_references.json']);
  assert.deepStrictEqual(res.absent, ['config/nope.json']);
  assert.deepStrictEqual(res.errors, []);
});

test('collectFiles: non-ENOENT read error → errors, not absent', () => {
  const fsImpl = { readFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } };
  const res = collectFiles({ files: [{ path: '/x', name: 'config/.env' }], fsImpl });
  assert.deepStrictEqual(res.absent, []);
  assert.strictEqual(res.errors.length, 1);
  assert.strictEqual(res.errors[0].path, 'config/.env');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd electron && node --test test/report-collect.test.js`
Expected: FAIL — `collectFiles is not a function` (or undefined).

- [ ] **Step 3: Write minimal implementation**

```js
// electron/lib/report-collect.js — add before module.exports
// Read an explicit allowlist of files into zip entries. No size cap (config-sized).
// Missing file (ENOENT) → absent; other read failure → errors. Never throws.
function collectFiles({ files, fsImpl = fs }) {
  const out = { entries: [], included: [], absent: [], errors: [] };
  for (const f of files) {
    let data;
    try { data = fsImpl.readFileSync(f.path); }
    catch (e) {
      if (e && e.code === 'ENOENT') out.absent.push(f.name);
      else out.errors.push({ path: f.name, reason: errMsg(e) });
      continue;
    }
    out.entries.push({ name: f.name, data });
    out.included.push(f.name);
  }
  return out;
}
```

```js
// update module.exports
module.exports = { PER_FILE_MAX, TREE_BUDGET, collectDirTree, collectFiles };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd electron && node --test test/report-collect.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/lib/report-collect.js electron/test/report-collect.test.js
git commit -m "feat(session-report): collectFiles — 显式配置 allowlist 收集"
```

---

### Task 3: `gatherExtraReportData` + `buildReportManifest` — 汇总 + manifest

**Files:**
- Modify: `electron/lib/report-collect.js`
- Test: `electron/test/report-collect.test.js`

**Interfaces:**
- Consumes: `collectDirTree`, `collectFiles`(Task 1/2)。
- Produces:
  - `gatherExtraReportData({ sessionId, skillsDir, agentsDir, dataDir, resourcesDir, envPath, fsImpl? })` →
    `{ entries: Array<{name,data}>, manifest: object }`
  - `buildReportManifest({ sessionId, skillsDir, agentsDir, skills, agents, cfgFiles, llm, mcp })` → manifest 对象(结构见 spec §6)。
- 语义:skills 用 `TREE_BUDGET`,agents 用 `TREE_BUDGET - skills.bytesUsed`(共享 16MB);`llm_configs`/`mcp_configs` 子目录各用独立 `TREE_BUDGET`(config 不受 skills/agents 预算约束)。config entry 名前缀 `config/`。

- [ ] **Step 1: Write the failing tests**

```js
// append to electron/test/report-collect.test.js
const { gatherExtraReportData } = require('../lib/report-collect');

function fakeAppData() {
  const root = tmpDir();
  write(root, 'skills/foo/SKILL.md', 'skill body');
  write(root, 'agents/bar.md', 'agent body');
  write(root, '.env', 'DATABASE_URL=secret\nIPMC_LLM_KEY=abc');
  write(root, 'data/skill_references.json', '{"version":2}');
  write(root, 'data/llm_configs/anthropic.json', '{"api_key":"sk-xxx"}');
  write(root, 'resources/mcp.json', '{"servers":{}}');
  return root;
}

test('gatherExtraReportData: bundles skills/agents/config with prefixes', () => {
  const root = fakeAppData();
  const { entries, manifest } = gatherExtraReportData({
    sessionId: 'sess-9',
    skillsDir: path.join(root, 'skills'),
    agentsDir: path.join(root, 'agents'),
    dataDir: path.join(root, 'data'),
    resourcesDir: path.join(root, 'resources'),
    envPath: path.join(root, '.env'),
  });
  const names = entries.map((e) => e.name).sort();
  assert.deepStrictEqual(names, [
    'agents/bar.md',
    'config/.env',
    'config/llm_configs/anthropic.json',
    'config/mcp.json',
    'config/skill_references.json',
    'skills/foo/SKILL.md',
  ]);
  // secrets carried RAW (not redacted)
  const env = entries.find((e) => e.name === 'config/.env');
  assert.match(env.data.toString(), /DATABASE_URL=secret/);
  // manifest reflects sources
  assert.strictEqual(manifest.generated_for_session, 'sess-9');
  assert.strictEqual(manifest.sources.skills.status, 'present');
  assert.strictEqual(manifest.sources.agents.status, 'present');
  assert.ok(manifest.sources.config.included.includes('config/.env'));
  assert.ok(manifest.sources.config.absent.includes('config/skill_pull_config.json'));
});

test('gatherExtraReportData: absent skills/agents dirs → status absent, no throw', () => {
  const root = tmpDir();
  write(root, 'data/skill_references.json', '{}');
  const { entries, manifest } = gatherExtraReportData({
    sessionId: 's',
    skillsDir: path.join(root, 'skills'),
    agentsDir: path.join(root, 'agents'),
    dataDir: path.join(root, 'data'),
    resourcesDir: path.join(root, 'resources'),
    envPath: path.join(root, '.env'),
  });
  assert.strictEqual(manifest.sources.skills.status, 'absent');
  assert.strictEqual(manifest.sources.agents.status, 'absent');
  assert.ok(entries.some((e) => e.name === 'config/skill_references.json'));
});

test('gatherExtraReportData: skills+agents share the 16MB budget', () => {
  const root = tmpDir();
  // one 1.5MB skill file uses part of the budget; assert agents budget is reduced
  write(root, 'skills/a.bin', Buffer.alloc(1_500_000, 1));
  write(root, 'agents/b.bin', Buffer.alloc(1_000, 2));
  const { manifest } = gatherExtraReportData({
    sessionId: 's', skillsDir: path.join(root, 'skills'), agentsDir: path.join(root, 'agents'),
    dataDir: path.join(root, 'data'), resourcesDir: path.join(root, 'resources'), envPath: path.join(root, '.env'),
  });
  assert.strictEqual(manifest.sources.skills.bytes, 1_500_000);
  assert.strictEqual(manifest.sources.agents.bytes, 1_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd electron && node --test test/report-collect.test.js`
Expected: FAIL — `gatherExtraReportData is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// electron/lib/report-collect.js — add before module.exports

// Assemble the manifest object (spec §6) from per-source collection results.
function buildReportManifest({ sessionId, skillsDir, agentsDir, skills, agents, cfgFiles, llm, mcp }) {
  return {
    generated_for_session: sessionId || '',
    sources: {
      skills: { status: skills.present ? 'present' : 'absent', dir: skillsDir, included: skills.entries.length, bytes: skills.bytesUsed },
      agents: { status: agents.present ? 'present' : 'absent', dir: agentsDir, included: agents.entries.length, bytes: agents.bytesUsed },
      config: {
        included: [...cfgFiles.included, ...llm.entries.map((e) => e.name), ...mcp.entries.map((e) => e.name)],
        absent: cfgFiles.absent,
      },
    },
    skipped: [...skills.skipped, ...agents.skipped, ...llm.skipped, ...mcp.skipped],
    errors: [...skills.errors, ...agents.errors, ...cfgFiles.errors, ...llm.errors, ...mcp.errors],
  };
}

// Gather all extra report data (skills/agents trees + config allowlist) into zip
// entries + a manifest. skills & agents share the 16MB TREE_BUDGET; llm/mcp config
// subdirs use their own budget (config isn't starved by big skills). Never throws.
function gatherExtraReportData({ sessionId, skillsDir, agentsDir, dataDir, resourcesDir, envPath, fsImpl = fs }) {
  const skills = collectDirTree({ dir: skillsDir, prefix: 'skills', fsImpl });
  const agents = collectDirTree({ dir: agentsDir, prefix: 'agents', budgetRemaining: TREE_BUDGET - skills.bytesUsed, fsImpl });
  const cfgFiles = collectFiles({ fsImpl, files: [
    { path: envPath, name: 'config/.env' },
    { path: path.join(dataDir, 'skill_references.json'), name: 'config/skill_references.json' },
    { path: path.join(dataDir, 'skill_pull_config.json'), name: 'config/skill_pull_config.json' },
    { path: path.join(resourcesDir, 'mcp.json'), name: 'config/mcp.json' },
  ] });
  const llm = collectDirTree({ dir: path.join(dataDir, 'llm_configs'), prefix: 'config/llm_configs', fsImpl });
  const mcp = collectDirTree({ dir: path.join(dataDir, 'mcp_configs'), prefix: 'config/mcp_configs', fsImpl });

  const entries = [...skills.entries, ...agents.entries, ...cfgFiles.entries, ...llm.entries, ...mcp.entries];
  const manifest = buildReportManifest({ sessionId, skillsDir, agentsDir, skills, agents, cfgFiles, llm, mcp });
  return { entries, manifest };
}
```

```js
// update module.exports
module.exports = { PER_FILE_MAX, TREE_BUDGET, collectDirTree, collectFiles, buildReportManifest, gatherExtraReportData };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd electron && node --test test/report-collect.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/lib/report-collect.js electron/test/report-collect.test.js
git commit -m "feat(session-report): gatherExtraReportData + manifest — 汇总 skills/agents/config"
```

---

### Task 4: `buildSessionReportEntries` — 追加 extraEntries + manifest(向后兼容)

**Files:**
- Modify: `electron/lib/session-report.js`
- Test: `electron/test/session-report.test.js`

**Interfaces:**
- Consumes: `gatherExtraReportData` 的返回(`entries`、`manifest`)。
- Produces:
  - `buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries, extraEntries?, manifest? })` → `Array<{name,data}>`
- 语义:顺序 = `sqlite.gz` → `environment.json` → `logEntries` → `extraEntries` → (若有 manifest)`report-manifest.json`(最后一项)。默认 `extraEntries=[]`、`manifest` 未传时不追加 → 与现状逐字节一致(老测试仍过)。

- [ ] **Step 1: Write the failing tests**

```js
// append to electron/test/session-report.test.js
test('appends extraEntries then report-manifest.json last', () => {
  const entries = buildSessionReportEntries({
    sessionId: 'sess-2',
    env: { app_version: '0.4.8' },
    sqliteBuf: Buffer.from('DB'),
    logEntries: [{ name: 'electron.log', data: Buffer.from('e') }],
    extraEntries: [{ name: 'skills/a.md', data: Buffer.from('A') }],
    manifest: { generated_for_session: 'sess-2', sources: {}, skipped: [], errors: [] },
  });
  assert.deepStrictEqual(entries.map((e) => e.name), [
    'session-sess-2.sqlite.gz', 'environment.json', 'electron.log', 'skills/a.md', 'report-manifest.json',
  ]);
  assert.deepStrictEqual(
    JSON.parse(entries[entries.length - 1].data.toString('utf8')).generated_for_session, 'sess-2');
});

test('no manifest / no extraEntries → unchanged 3-entry shape (backward compat)', () => {
  const entries = buildSessionReportEntries({
    sessionId: 's', env: { app_version: '0.4.8' }, sqliteBuf: Buffer.from('z'),
    logEntries: [{ name: 'electron.log', data: Buffer.from('e') }],
  });
  assert.deepStrictEqual(entries.map((e) => e.name), ['session-s.sqlite.gz', 'environment.json', 'electron.log']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd electron && node --test test/session-report.test.js`
Expected: FAIL — first new test: last entry is `electron.log`, not `report-manifest.json` (extraEntries/manifest ignored by old impl).

- [ ] **Step 3: Write minimal implementation**

```js
// electron/lib/session-report.js — replace buildSessionReportEntries
function buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries, extraEntries, manifest }) {
  const entries = [
    { name: `session-${sessionId}.sqlite.gz`, data: sqliteBuf },
    { name: 'environment.json', data: Buffer.from(JSON.stringify(env, null, 2), 'utf8') },
    ...(logEntries || []),
    ...(extraEntries || []),
  ];
  if (manifest) {
    entries.push({ name: 'report-manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  }
  return entries;
}
```

Also extend the module's top comment to mention the appended skills/agents/config entries + `report-manifest.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd electron && node --test test/session-report.test.js`
Expected: PASS — new tests + the 2 original tests (length-3 / missing-logEntries) still pass.

- [ ] **Step 5: Commit**

```bash
git add electron/lib/session-report.js electron/test/session-report.test.js
git commit -m "feat(session-report): buildSessionReportEntries 追加 extraEntries + report-manifest.json"
```

---

### Task 5: 接线 `report-session` handler(main.js)

**Files:**
- Modify: `electron/main.js:18`(require)、`electron/main.js:1326-1327`(handler 组装)

**Interfaces:**
- Consumes: `gatherExtraReportData`(Task 3)、`buildSessionReportEntries`(Task 4)、既有 `getAppDataDir()`(main.js:99)、`getUserSkillsDir()`/`getUserAgentsDir()`(main.js:490-491)、`path`(已 require)。
- 无新 Produces(集成层)。

> **为何无独立单测**:`main.js` 是 Electron 主进程入口,难以在 `node --test` 下实例化;可测逻辑已全部下沉到 Task 1-4 的纯函数。本任务只做接线,验证靠 §Task 6 的 verify 手动跑一次真实上报。

- [ ] **Step 1: 加 require(main.js 顶部,紧邻既有 lib require)**

在 `electron/main.js:18`(`const { buildSessionReportEntries } = require('./lib/session-report');`)之后加一行:

```js
const { gatherExtraReportData } = require('./lib/report-collect');
```

- [ ] **Step 2: 在 handler 里收集并传入(替换 main.js:1326-1327 两行)**

把:

```js
    const logEntries = collectTail({ files: logFilesForTail() });
    const entries = buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries });
```

替换为:

```js
    const logEntries = collectTail({ files: logFilesForTail() });
    const appDataDir = getAppDataDir();
    const { entries: extraEntries, manifest } = gatherExtraReportData({
      sessionId,
      skillsDir: getUserSkillsDir(),
      agentsDir: getUserAgentsDir(),
      dataDir: path.join(appDataDir, 'data'),
      resourcesDir: path.join(appDataDir, 'resources'),
      envPath: path.join(appDataDir, '.env'),
    });
    const entries = buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries, extraEntries, manifest });
```

- [ ] **Step 3: 语法自检(不启动 Electron)**

Run: `cd electron && node -e "require('./lib/report-collect'); require('./lib/session-report'); console.log('requires OK')"`
Expected: 打印 `requires OK`(确认新模块可加载、无语法错)。

> 注:`node -c main.js` 仅解析、不执行,可选。完整验证见 Task 6。

- [ ] **Step 4: 跑全部 electron 测试确保未回归**

Run: `cd electron && node --test`
Expected: 所有测试 PASS(含 report-collect、session-report、log-bundler 等)。

- [ ] **Step 5: Commit**

```bash
git add electron/main.js
git commit -m "feat(session-report): report-session 接线——附带 skills/agents/config + manifest"
```

---

### Task 6: 端到端验证(verify skill)

**Files:** 无改动(纯验证)。

- [ ] **Step 1: 调用 verify skill**

按仓库 `verify` skill 驱动真实上报路径:启动 app → 触发一次"上报此会话"(需本机配置 `telemetryUrl`,否则会被 `shouldReportTelemetry` 门控跳过——见 main.js:1309)。

- [ ] **Step 2: 观察产出**

确认 `report-session: uploaded <sessionId> (<bytes> bytes)` 落进 electron 日志,且上报 zip(可临时把 `uploadLogs` 前的 `zip` dump 到本地检查,或在接收端解压)含:
- `session-<id>.sqlite.gz`、`environment.json`、日志尾巴(现状)
- `skills/…`、`agents/…`(若本机有这些目录)
- `config/.env`、`config/skill_references.json`、`config/llm_configs/*.json` 等
- `report-manifest.json`,其 `sources`/`skipped`/`errors` 与实际磁盘状态一致

- [ ] **Step 3: 缺目录容错抽查**

临时把本机 `<AppData>/skills` 改名后再上报一次,确认:仍上报成功、manifest `sources.skills.status == "absent"`、不报错、不阻断。抽查后改回目录名。

> 若本机未配 `telemetryUrl`:退而验证 `gatherExtraReportData` 在真实 AppData 路径上的输出——写一个一次性脚本 `node -e "console.log(require('./electron/lib/report-collect').gatherExtraReportData({sessionId:'x', skillsDir:..., ...}).manifest)"` 打印 manifest,人工核对与磁盘一致。验证后删除临时脚本。

---

## Self-Review

**1. Spec coverage:**
- spec §2 数据位置 → Task 5 allowlist 精确路径表 ✅
- spec §3 方案 A(Electron 组装,后端零改动)→ 全程无 Python 改动 ✅
- spec §4 zip 布局(skills/ agents/ config/ + manifest)→ Task 3 entry 前缀 + Task 4 追加顺序 ✅
- spec §4 config 用 allowlist 不盲扫 → Task 3 `gatherExtraReportData` 固定 allowlist;计划顶部醒目提示排除 SQLite ✅
- spec §5 体积阀(2MB/16MB、共享预算、不静默截断)→ Task 1 `collectDirTree` + Task 3 预算串联 + skipped 入 manifest ✅
- spec §6 manifest 结构 → Task 3 `buildReportManifest` 逐字段对齐 ✅
- spec §7 密钥原样不脱敏 → 无任何脱敏逻辑;Task 3 测试断言 `.env` RAW 带 `DATABASE_URL=secret` ✅
- spec §8 错误处理不阻断 → collectDirTree/collectFiles/gather 全 try-catch 不抛;Task 6 缺目录抽查 ✅
- spec §9 实现落点 → 文件结构与任务一一对应 ✅
- spec §10 测试项 → Task 1-4 测试覆盖(entry 名/前缀、file-too-large、budget-exceeded、缺目录 absent、config RAW、读错误 errors)✅

**2. Placeholder scan:** 无 TBD/TODO;每个代码步给了完整代码;每个命令给了预期输出。✅

**3. Type consistency:**
- `collectDirTree` 返回 `{entries,skipped,errors,bytesUsed,present}` — Task 3 `gatherExtraReportData`/`buildReportManifest` 消费的字段名一致(`.present`/`.bytesUsed`/`.entries`/`.skipped`/`.errors`)✅
- `collectFiles` 返回 `{entries,included,absent,errors}` — Task 3 消费 `.included`/`.absent`/`.entries`/`.errors` 一致 ✅
- `gatherExtraReportData` 返回 `{entries,manifest}` — Task 5 解构 `{entries: extraEntries, manifest}`、Task 4 `buildSessionReportEntries` 入参 `extraEntries`/`manifest` 一致 ✅
- 常量 `PER_FILE_MAX`/`TREE_BUDGET` — 定义(Task 1)与导出/使用(Task 1/3)一致 ✅

无遗漏、无命名漂移。
