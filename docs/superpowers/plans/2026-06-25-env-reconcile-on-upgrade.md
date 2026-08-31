# .env 升级规整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 升级时（版本变化）对用户 `%APPDATA%\IPMaster-Cowork\.env` 做一次幂等规整：force/managed/path 三类键各按策略更新、补缺失键、删非 `IPMC_` 键（`DATABASE_URL` 例外），绝不误删用户自定义值。

**Architecture:** 纯函数 `electron/lib/env-reconcile.js`（解析 + 规整，无 fs/electron 依赖，单测覆盖）+ `electron/main.js` 薄接线（读模板/算路径/版本门控/读写文件）。运行时路径仍由 `startBackend` 的 spawn env 钉死（fix #1 不动）；本机制只规整 `.env` 文件本身。

**Tech Stack:** Node.js（CommonJS）、`node:test` + `node:assert`、Electron main 进程。无新依赖。

## Global Constraints

- 平台：Windows；测试用 `node --test electron/test/*.test.js`（不引入新测试框架）。
- 纯逻辑放 `electron/lib/`、单测放 `electron/test/`，仿现有 `lib/seed-migration.js` + `test/seed-migration.test.js` 风格（`'use strict'`、`module.exports`）。
- 不改 spawn env 路径钉死；不改 core 的 `IPMC_LLM_*` 读取。
- 非 `IPMC_` 删除白名单恒含 `DATABASE_URL`。
- canonical 值来源：managed/force 取随包模板 `.env.example` 当前激活值；path 取计算的 AppData 绝对路径（forward-slash）。
- 提交信息结尾加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## File Structure

- **Create** `electron/lib/env-reconcile.js` — 纯函数 `parseAssignments(text)` + `reconcileEnv(existingText, {canonical, keepNonIpmc})`。
- **Create** `electron/test/env-reconcile.test.js` — 单测。
- **Modify** `electron/main.js` — 引入纯函数；新增策略注册表 + `buildEnvCanonical()` + `reconcileUserEnv()`；`whenReady` 中 `startBackend` 前调用；`ensureUserEnvFile` 创建分支补 `IPMC_RESOURCES_DIR` 替换。

---

### Task 1: 纯函数 `env-reconcile.js` + 单测

**Files:**
- Create: `electron/lib/env-reconcile.js`
- Test: `electron/test/env-reconcile.test.js`

**Interfaces:**
- Produces:
  - `parseAssignments(text: string) -> Map<string,string>` — 仅未注释的 `KEY=value` 激活赋值，值为 `=` 之后到行尾的原始字符串（未 trim）。
  - `reconcileEnv(existingText: string, { canonical, keepNonIpmc=['DATABASE_URL'] }) -> { text: string, changed: boolean }`
  - `canonical: Array<{ key: string, policy: 'force'|'managed'|'path', value: string, oldDefaults?: string[] }>`

- [ ] **Step 1: 写失败测试**

创建 `electron/test/env-reconcile.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileEnv, parseAssignments } = require('../lib/env-reconcile');

const CANON = [
  { key: 'DATABASE_URL', policy: 'force', value: 'sqlite' },
  { key: 'IPMC_LLM_BASE_URL', policy: 'managed', value: 'http://h:10020/v1', oldDefaults: ['http://h:10020'] },
  { key: 'IPMC_LLM_MODEL', policy: 'managed', value: 'MiniMax-M2.7', oldDefaults: [] },
  { key: 'IPMC_DATA_DIR', policy: 'path', value: 'C:/AppData/IPMaster-Cowork/data' },
];

test('managed: 值=旧默认→更新为模板新值', () => {
  const { text, changed } = reconcileEnv('IPMC_LLM_BASE_URL=http://h:10020\n', { canonical: CANON });
  assert.match(text, /IPMC_LLM_BASE_URL=http:\/\/h:10020\/v1/);
  assert.strictEqual(changed, true);
});

test('managed: 用户自定义值→保留不动', () => {
  const { text } = reconcileEnv('IPMC_LLM_BASE_URL=http://my-own:9999\n', { canonical: CANON });
  assert.match(text, /IPMC_LLM_BASE_URL=http:\/\/my-own:9999/);
  assert.doesNotMatch(text, /10020/);
});

test('managed: 缺失→补模板值', () => {
  const { text } = reconcileEnv('IPMC_LLM_MODEL=MiniMax-M2.7\n', { canonical: CANON });
  assert.match(text, /^IPMC_LLM_BASE_URL=http:\/\/h:10020\/v1$/m);
});

test('force: 总是覆盖（即便用户改成 postgres）', () => {
  const { text, changed } = reconcileEnv('DATABASE_URL=postgresql://u:p@host/db\n', { canonical: CANON });
  assert.match(text, /^DATABASE_URL=sqlite$/m);
  assert.strictEqual(changed, true);
});

test('path: 总是重写成给定 AppData 路径；缺失则补', () => {
  const { text } = reconcileEnv('IPMC_DATA_DIR=D:/old/install/data\n', { canonical: CANON });
  assert.match(text, /^IPMC_DATA_DIR=C:\/AppData\/IPMaster-Cowork\/data$/m);
});

test('删除非 IPMC_ 赋值键；DATABASE_URL 白名单保留', () => {
  const { text } = reconcileEnv('OPENAI_API_KEY=sk-xxx\nDATABASE_URL=sqlite\nIPMC_LLM_MODEL=MiniMax-M2.7\n', { canonical: CANON });
  assert.doesNotMatch(text, /OPENAI_API_KEY/);
  assert.match(text, /^DATABASE_URL=sqlite$/m);
});

test('IPMC_ 但不在 canonical 的键→原样保留', () => {
  const { text } = reconcileEnv('IPMC_CUSTOM_THING=42\nIPMC_LLM_MODEL=MiniMax-M2.7\n', { canonical: CANON });
  assert.match(text, /^IPMC_CUSTOM_THING=42$/m);
});

test('注释与空行保持不动', () => {
  const src = '# header\n\n# IPMC_LOG_LEVEL=INFO\nIPMC_LLM_MODEL=MiniMax-M2.7\n';
  const { text } = reconcileEnv(src, { canonical: CANON });
  assert.match(text, /# header/);
  assert.match(text, /# IPMC_LOG_LEVEL=INFO/);
});

test('幂等：对结果再跑一次 changed=false 且文本不变', () => {
  const once = reconcileEnv('DATABASE_URL=postgresql://x\nOPENAI_API_KEY=y\n', { canonical: CANON }).text;
  const twice = reconcileEnv(once, { canonical: CANON });
  assert.strictEqual(twice.changed, false);
  assert.strictEqual(twice.text, once);
});

test('parseAssignments 只取激活赋值，忽略注释', () => {
  const m = parseAssignments('# A=1\nB=2\nIPMC_X=hello world\n');
  assert.strictEqual(m.get('B'), '2');
  assert.strictEqual(m.get('IPMC_X'), 'hello world');
  assert.ok(!m.has('A'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test electron/test/env-reconcile.test.js`
Expected: FAIL —— `Cannot find module '../lib/env-reconcile'`。

- [ ] **Step 3: 写实现**

创建 `electron/lib/env-reconcile.js`：

```js
'use strict';

// Pure .env reconciliation — no fs/electron access. Used on upgrade to converge a
// user's existing .env toward the current build's canonical shape WITHOUT clobbering
// user-customized values. See docs/superpowers/specs/2026-06-25-env-reconcile-on-upgrade-design.md
//
// policy per canonical key:
//   force   — always set to canonical value (overwrites user)
//   managed — set to canonical value only if current value ∈ oldDefaults (stale shipped
//             default); user-customized values are preserved; missing → add canonical
//   path    — always set to canonical value (app-computed AppData path); missing → add

const ASSIGN_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

// Map of every ACTIVE (uncommented) KEY=value assignment → raw value text (untrimmed).
function parseAssignments(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = ASSIGN_RE.exec(line);
    if (m) out.set(m[2], m[4]);
  }
  return out;
}

function desiredValue(c, curVal) {
  if (c.policy === 'force' || c.policy === 'path') return c.value;
  // managed
  if (curVal === undefined) return c.value;
  return (c.oldDefaults || []).includes(curVal.trim()) ? c.value : curVal;
}

function reconcileEnv(existingText, { canonical, keepNonIpmc = ['DATABASE_URL'] } = {}) {
  const byKey = new Map(canonical.map((c) => [c.key, c]));
  const keep = new Set(keepNonIpmc);
  const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set();
  const out = [];

  for (const line of existingText.split(/\r?\n/)) {
    const m = ASSIGN_RE.exec(line);
    if (!m || line.trimStart().startsWith('#')) { out.push(line); continue; }
    const key = m[2];
    if (!key.startsWith('IPMC_') && !keep.has(key)) continue;   // delete stray non-IPMC_ key
    const c = byKey.get(key);
    if (!c) { out.push(line); seen.add(key); continue; }        // IPMC_ key not managed → keep
    seen.add(key);
    out.push(`${m[1]}${key}${m[3]}${desiredValue(c, m[4])}`);
  }

  // strip a single trailing blank (from the original trailing newline) so appended
  // keys aren't separated by a stray blank line; re-add the final newline below.
  while (out.length && out[out.length - 1] === '') out.pop();
  let appended = false;
  for (const c of canonical) {
    if (seen.has(c.key)) continue;
    out.push(`${c.key}=${desiredValue(c, undefined)}`);
    appended = true;
  }

  let text = out.join(eol);
  if (existingText.endsWith('\n') || appended) text += eol;
  return { text, changed: text !== existingText };
}

module.exports = { reconcileEnv, parseAssignments };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test electron/test/env-reconcile.test.js`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add electron/lib/env-reconcile.js electron/test/env-reconcile.test.js
git commit -m "feat(desktop): pure .env reconcile (force/managed/path + drop non-IPMC_)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `main.js` 接线 + `ensureUserEnvFile` 补 RESOURCES_DIR

**Files:**
- Modify: `electron/main.js`

**Interfaces:**
- Consumes: `reconcileEnv`, `parseAssignments`（Task 1）。
- Produces: `reconcileUserEnv()`（whenReady 中、startBackend 前调用，版本门控）。

- [ ] **Step 1: 引入纯函数**

在 `electron/main.js` 顶部 require 区，紧跟 `seed-retirement` 那行后加：

```js
const { reconcileEnv, parseAssignments } = require('./lib/env-reconcile');
```

- [ ] **Step 2: 加策略注册表 + `buildEnvCanonical()` + `reconcileUserEnv()`**

放在 `seedBundledMcpConfig()` 定义之后（同一区块）：

```js
// ── .env upgrade reconciliation ───────────────────────────────────────────────
// Converge an existing user .env toward this build's canonical shape on version
// change. See docs/superpowers/specs/2026-06-25-env-reconcile-on-upgrade-design.md.
const ENV_FORCE_KEYS = ['DATABASE_URL'];
const ENV_MANAGED_KEYS = [
  'IPMC_LLM_ACCOUNT', 'IPMC_LLM_STYLE', 'IPMC_LLM_API_KEY', 'IPMC_LLM_BASE_URL',
  'IPMC_LLM_MODEL', 'IPMC_LLM_CONTEXT_LIMIT', 'IPMC_LLM_MAX_OUTPUT_TOKENS', 'IPMC_LLM_TIMEOUT_SEC',
  'IPMC_HTTP_SSL_VERIFY', 'IPMC_SKILL_PULL_SERVER_URL',
  'IPMC_TASK_MAX_RETRIES', 'IPMC_TASK_MAX_CONCURRENT', 'IPMC_WATCH_INTERVAL',
];
// Historical shipped defaults per managed key. When a user's current value matches
// one of these (= they never customized it), it's bumped to the template's new value.
// Add the OLD value here whenever a shipped default changes.
const ENV_MANAGED_OLD_DEFAULTS = {
  IPMC_LLM_BASE_URL: ['http://10.244.224.247:10020'],
};

function buildEnvCanonical(templateText, appDataDir) {
  const tv = parseAssignments(templateText);
  const toUnix = (p) => p.replace(/\\/g, '/');
  const canonical = [];
  for (const k of ENV_FORCE_KEYS) {
    if (tv.has(k)) canonical.push({ key: k, policy: 'force', value: tv.get(k) });
  }
  for (const k of ENV_MANAGED_KEYS) {
    if (tv.has(k)) canonical.push({ key: k, policy: 'managed', value: tv.get(k), oldDefaults: ENV_MANAGED_OLD_DEFAULTS[k] || [] });
  }
  const pathVals = {
    IPMC_DATA_DIR: toUnix(path.join(appDataDir, 'data')),
    IPMC_RESOURCES_DIR: toUnix(path.join(appDataDir, 'resources')),
    IPMC_SKILLS_DIR: toUnix(getUserSkillsDir()),
    IPMC_AGENTS_DIR: toUnix(getUserAgentsDir()),
    IPMC_LOG_DIR: toUnix(path.join(appDataDir, 'logs')),
    IPMC_LOG_FILENAME: 'backend.log',
  };
  for (const [k, v] of Object.entries(pathVals)) canonical.push({ key: k, policy: 'path', value: v });
  return canonical;
}

function reconcileUserEnv() {
  try {
    const appDataDir = getAppDataDir();
    const envPath = path.join(appDataDir, '.env');
    const markerPath = path.join(appDataDir, '.env-reconciled-version');
    const currentVersion = app.getVersion();

    let marker = null;
    try { if (fs.existsSync(markerPath)) marker = fs.readFileSync(markerPath, 'utf8').trim(); } catch (_) {}
    if (marker === currentVersion) return;            // already reconciled this version

    // Fresh install: ensureUserEnvFile() will create a correct .env; nothing to reconcile.
    if (!fs.existsSync(envPath)) {
      try { fs.writeFileSync(markerPath, currentVersion, 'utf8'); } catch (_) {}
      return;
    }

    const templatePath = app.isPackaged
      ? path.join(process.resourcesPath, 'backend', '.env.example')
      : path.join(__dirname, '..', '.env.example');
    if (!fs.existsSync(templatePath)) { elog('reconcileUserEnv: template missing, skip'); return; }

    const canonical = buildEnvCanonical(fs.readFileSync(templatePath, 'utf8'), appDataDir);
    const { text, changed } = reconcileEnv(fs.readFileSync(envPath, 'utf8'), { canonical });
    if (changed) { fs.writeFileSync(envPath, text, 'utf8'); elog('Reconciled .env to current version'); }
    fs.writeFileSync(markerPath, currentVersion, 'utf8');
  } catch (e) { elog('reconcileUserEnv failed: ' + e.message); }
}
```

- [ ] **Step 3: whenReady 中调用（startBackend 前）**

在 `app.whenReady().then(async () => { ... })` 里，找到 `if (!IS_DEV) {` 启动后端那段，在它**之前**插入一行：

```js
  reconcileUserEnv();   // 版本变化时规整用户 .env（须在 startBackend 前）

  if (!IS_DEV) {
```

- [ ] **Step 4: `ensureUserEnvFile` 创建分支补 RESOURCES_DIR**

在 `ensureUserEnvFile` 的「有模板」分支，紧跟 `IPMC_DATA_DIR` 替换那行后加 RESOURCES：

```js
      content = content.replace(/^IPMC_DATA_DIR=.*/m,      `IPMC_DATA_DIR=${toUnix(path.join(appDataDir, 'data'))}`);
      content = content.replace(/^IPMC_RESOURCES_DIR=.*/m, `IPMC_RESOURCES_DIR=${toUnix(path.join(appDataDir, 'resources'))}`);
```

并在「无模板」回退分支的数组里补一行（在 DATA_DIR 之后）：

```js
        `IPMC_RESOURCES_DIR=${toUnix(path.join(appDataDir, 'resources'))}`,
```

- [ ] **Step 5: 语法检查 + 全量测试无回归**

Run: `node --check electron/main.js`
Expected: 无输出（语法 OK）。

Run: `node --test electron/test/*.test.js`
Expected: 全部 PASS（原有用例 + Task 1 的 env-reconcile 用例；0 fail）。

- [ ] **Step 6: 提交**

```bash
git add electron/main.js
git commit -m "feat(desktop): reconcile user .env on version upgrade

Gate on .env-reconciled-version marker; force DATABASE_URL=sqlite, bump stale
managed defaults (e.g. IPMC_LLM_BASE_URL), re-correct path keys, drop non-IPMC_
keys. Also fill IPMC_RESOURCES_DIR on fresh .env creation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- 触发时机（marker + 版本门控 + fresh-install 跳过）→ Task 2 Step 2/3 ✓
- force / managed / path 三类策略 → Task 1 实现 + 测试 ✓
- oldDefaults 注册表（仅 IPMC_LLM_BASE_URL 有旧值）→ Task 2 `ENV_MANAGED_OLD_DEFAULTS` ✓
- 删非 IPMC_ + DATABASE_URL 白名单 → Task 1 `reconcileEnv` + 测试 ✓
- 注释/空行不动、幂等 → Task 1 测试 ✓
- 配套：ensureUserEnvFile 补 RESOURCES_DIR → Task 2 Step 4 ✓
- canonical 值来源（模板激活值 / 计算路径）→ Task 2 `buildEnvCanonical` ✓

**Placeholder scan:** 无 TBD/TODO；所有步骤含完整代码与命令。

**Type consistency:** `parseAssignments`/`reconcileEnv` 签名在 Task 1 定义、Task 2 一致使用；canonical 条目结构 `{key,policy,value,oldDefaults}` 两处一致。
