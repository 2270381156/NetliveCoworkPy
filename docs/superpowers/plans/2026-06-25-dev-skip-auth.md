# dev-skip-auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 桌面端加一个仅开发态生效的开关 `devSkipAuth`，启动时跳过 OAuth 登录门、直接进入界面。

**Architecture:** 旁路逻辑放在 `electron/lib/auth.js` 的 `getSession`（标志开时返回低权限假用户 `DEV_USER`，前端 `AuthGate` 因此不显示 `LoginGate`）。安全闸门抽成纯函数 `computeDevSkipAuth({ isPackaged, appConfig })`，由 `main.js` 的 `auth-session` handler 调用——打包态恒返回 `false`，故标志在生产环境天然失效。配置经 `app-config.json` 的 `devSkipAuth` 布尔字段传入。

**Tech Stack:** Node.js / Electron 34；测试用 `node:test` + `node:assert`（`npm test` → `node --test test/*.test.js`，在 `electron/` 目录下跑）。

## Global Constraints

- 工作分支：`feat/dev-skip-auth`（已从 master 拉出）。
- `DEV_USER` 必须符合前端 `AuthUser` 形状 `{ id, username, role }`（见 `frontend-desktop/src/types/index.ts`），且 `role !== 'admin'`。固定值：`{ id: 'dev-local', username: 'dev (local)', role: 'dev' }`。
- 安全闸门唯一承重逻辑 = `!isPackaged && appConfig.devSkipAuth === true`。打包态必须忽略标志。
- **绝不**修改 `packaging/default_data/app-config.json`（随包出厂副本）。只动 dev 回退副本 `electron/app-config.json`。
- 不改动前端、`preload.js`、`app-config-reconcile.js`。
- 测试框架仅用 `node:test` + `node:assert`，不引入新依赖。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: `getSession` devSkipAuth 短路 + `DEV_USER` 常量

**Files:**
- Modify: `electron/lib/auth.js`（新增 `DEV_USER` 常量；`getSession` 签名加 `devSkipAuth` 并短路；`module.exports` 导出 `DEV_USER`）
- Test: `electron/test/auth.test.js`（新建）

**Interfaces:**
- Consumes: 无（auth.js 现有 `loadSession`/`getSession` 已存在）。
- Produces:
  - `DEV_USER = { id: 'dev-local', username: 'dev (local)', role: 'dev' }`（导出）
  - `getSession({ cloudBaseUrl, appDataDir, devSkipAuth })`：当 `devSkipAuth === true` 时同步返回 `DEV_USER`，不读取本地 session；否则维持原有异步逻辑。

> 注：plain `node --test`（非 electron 运行时）下 `require('electron')` 返回的是字符串路径，`{ shell, safeStorage }` 解构得到 `undefined`。`devSkipAuth: true` 分支在触达 `safeStorage` 前就 return，故测试无需 electron 运行时。

- [ ] **Step 1: 写失败测试**

新建 `electron/test/auth.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSession, DEV_USER } = require('../lib/auth');

test('DEV_USER 符合 AuthUser 形状且非 admin', () => {
  assert.deepStrictEqual(Object.keys(DEV_USER).sort(), ['id', 'role', 'username']);
  assert.strictEqual(DEV_USER.role !== 'admin', true);
});

test('devSkipAuth=true 返回 DEV_USER，且不读取本地 session', async () => {
  // 指向一个不存在 auth.bin 的空目录：若旁路失效会返回 null。
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-'));
  const u = await getSession({ cloudBaseUrl: '', appDataDir: emptyDir, devSkipAuth: true });
  assert.deepStrictEqual(u, DEV_USER);
});

test('devSkipAuth 缺省 + 无本地 session + 无云端地址 → null（原有逻辑不变）', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-'));
  const u = await getSession({ cloudBaseUrl: '', appDataDir: emptyDir });
  assert.strictEqual(u, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（在 `electron/` 目录）：`node --test test/auth.test.js`
Expected: FAIL —— `DEV_USER` 为 `undefined`（导出不存在），形状/相等断言报错。

- [ ] **Step 3: 写最小实现**

在 `electron/lib/auth.js` 顶部常量区（`const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;` 之后）新增：

```js
// 仅开发态注入的假用户（闸门见 computeDevSkipAuth + main.js）。
// 明显伪造、低权限，绝不冒充 admin；辨识度高、好 grep。
const DEV_USER = { id: 'dev-local', username: 'dev (local)', role: 'dev' };
```

把 `getSession` 签名与开头改为（仅加 `devSkipAuth` 形参与短路两行，其余不动）：

```js
// 启动时取 session + 云端吊销检查（401→登出；网络不可达→回退本地 exp）。
// devSkipAuth（仅开发态，由 main.js 算好传入）为真时跳过登录门，注入假用户。
async function getSession({ cloudBaseUrl, appDataDir, devSkipAuth }) {
  if (devSkipAuth) return DEV_USER;
  const s = loadSession(appDataDir);
  if (!s) return null;
  // …… 其余原有逻辑保持不变 ……
```

在 `module.exports` 中加入 `DEV_USER`：

```js
module.exports = {
  resolveCloudBaseUrl, startLogin, getSession,
  loadSession, saveSession, clearSession, jwtExpired, authFilePath,
  DEV_USER,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run（在 `electron/` 目录）：`node --test test/auth.test.js`
Expected: PASS（3 个测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add electron/lib/auth.js electron/test/auth.test.js
git commit -m "feat(auth): getSession devSkipAuth 短路 + DEV_USER 常量

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `computeDevSkipAuth` 安全闸门纯函数 + 守卫回归测试

**Files:**
- Modify: `electron/lib/auth.js`（新增 `computeDevSkipAuth` 并导出）
- Test: `electron/test/auth.test.js`（追加守卫回归用例）

**Interfaces:**
- Consumes: 无。
- Produces: `computeDevSkipAuth({ isPackaged, appConfig })` → `boolean`，返回 `!isPackaged && appConfig?.devSkipAuth === true`。这是整套方案唯一承重行；main.js 调用它。

- [ ] **Step 1: 写失败测试**

在 `electron/test/auth.test.js` 顶部 require 处补上 `computeDevSkipAuth`：

```js
const { getSession, DEV_USER, computeDevSkipAuth } = require('../lib/auth');
```

在文件末尾追加：

```js
test('computeDevSkipAuth: 打包态恒为 false（即使 flag 为 true）', () => {
  assert.strictEqual(computeDevSkipAuth({ isPackaged: true, appConfig: { devSkipAuth: true } }), false);
});

test('computeDevSkipAuth: 开发态 + flag true → true', () => {
  assert.strictEqual(computeDevSkipAuth({ isPackaged: false, appConfig: { devSkipAuth: true } }), true);
});

test('computeDevSkipAuth: 开发态 + flag 缺省/非 true → false', () => {
  assert.strictEqual(computeDevSkipAuth({ isPackaged: false, appConfig: {} }), false);
  assert.strictEqual(computeDevSkipAuth({ isPackaged: false, appConfig: { devSkipAuth: 'true' } }), false);
  assert.strictEqual(computeDevSkipAuth({ isPackaged: false, appConfig: undefined }), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（在 `electron/` 目录）：`node --test test/auth.test.js`
Expected: FAIL —— `computeDevSkipAuth is not a function`。

- [ ] **Step 3: 写最小实现**

在 `electron/lib/auth.js` 中（`DEV_USER` 常量之后、`getSession` 附近均可）新增：

```js
// 安全闸门：旁路只在「未打包」且「app-config 显式 devSkipAuth===true」时生效。
// 打包态恒 false —— 这是整套方案唯一承重行，改它前看 auth.test.js 的守卫回归用例。
function computeDevSkipAuth({ isPackaged, appConfig } = {}) {
  return !isPackaged && appConfig != null && appConfig.devSkipAuth === true;
}
```

在 `module.exports` 中加入 `computeDevSkipAuth`：

```js
module.exports = {
  resolveCloudBaseUrl, startLogin, getSession,
  loadSession, saveSession, clearSession, jwtExpired, authFilePath,
  DEV_USER, computeDevSkipAuth,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run（在 `electron/` 目录）：`node --test test/auth.test.js`
Expected: PASS（6 个测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add electron/lib/auth.js electron/test/auth.test.js
git commit -m "feat(auth): computeDevSkipAuth 安全闸门纯函数 + 守卫回归测试

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: main.js 接线 + app-config.json 标志 + 启动告警

**Files:**
- Modify: `electron/main.js`（`auth-session` handler：算闸门、传 `devSkipAuth`、`elog` 告警）
- Modify: `electron/app-config.json`（新增 `"devSkipAuth": false`）

**Interfaces:**
- Consumes: `authFlow.computeDevSkipAuth({ isPackaged, appConfig })`（Task 2）、`authFlow.getSession({ ..., devSkipAuth })`（Task 1）、现有 `readAppConfigFile()` / `getCloudBaseUrl()` / `getAppDataDir()` / `elog()` / `app.isPackaged`。
- Produces: 无（终端接线，前端经既有 `auth-session` IPC 拿到 user）。

> 说明：此 handler 用 `app.isPackaged` 与 `ipcMain`，不便用 `node:test` 单测；闸门逻辑已在 Task 2 以纯函数覆盖。本任务的回归保证 = 既有 electron 测试全绿 + 下方手动验证。

- [ ] **Step 1: 修改 `auth-session` handler**

在 `electron/main.js` 把现有：

```js
ipcMain.handle('auth-session', () =>
  authFlow.getSession({ cloudBaseUrl: getCloudBaseUrl(), appDataDir: getAppDataDir() }));
```

替换为：

```js
ipcMain.handle('auth-session', () => {
  const devSkipAuth = authFlow.computeDevSkipAuth({
    isPackaged: app.isPackaged,
    appConfig: readAppConfigFile(),     // dev 态读 electron/app-config.json 的 devSkipAuth
  });
  if (devSkipAuth) elog('⚠ AUTH SKIPPED (devSkipAuth) — dev only');   // 响亮告警，绝不静默开启
  return authFlow.getSession({
    cloudBaseUrl: getCloudBaseUrl(),
    appDataDir: getAppDataDir(),
    devSkipAuth,
  });
});
```

- [ ] **Step 2: 给 dev 回退配置加标志**

把 `electron/app-config.json` 改为（仅新增最后一个键，URL/channel 不动）：

```json
{
  "netcoworkBaseUrl": "http://172.20.10.2:5174",
  "feedUrl": "",
  "telemetryUrl": "",
  "channel": "stable",
  "devSkipAuth": false
}
```

- [ ] **Step 3: 跑全套 electron 测试确认无回归**

Run（在 `electron/` 目录）：`npm test`
Expected: PASS —— 全部既有测试 + `auth.test.js` 6 个用例全绿，无报错。

- [ ] **Step 4: 手动验证旁路（开发态）**

1. 临时把 `electron/app-config.json` 的 `devSkipAuth` 改为 `true`。
2. 在 `electron/` 目录运行 `npm start`（开发态，`app.isPackaged === false`）。
3. 预期：**不出现登录门**，直接进入界面；终端打印 `⚠ AUTH SKIPPED (devSkipAuth) — dev only`。
4. 把 `devSkipAuth` 改回 `false`，再次 `npm start`，预期：恢复显示登录门（或已有本地 session 则直接进）。

> 若无法实机运行 Electron，记录「未手动验证」并在 PR/汇报中说明，由用户验证。

- [ ] **Step 5: 提交**

```bash
git add electron/main.js electron/app-config.json
git commit -m "feat(auth): main 接线 devSkipAuth 闸门 + 启动告警；app-config 加 flag(false)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 完成后

三个任务完成后：
- `electron/lib/auth.js`：`DEV_USER` + `computeDevSkipAuth` + `getSession` 短路（已导出、已测）
- `electron/main.js`：`auth-session` 算闸门 + 告警
- `electron/app-config.json`：`devSkipAuth: false`
- `electron/test/auth.test.js`：6 个用例（旁路 3 + 守卫回归 3）

按 `feat/dev-skip-auth` 分支工作流，验证通过后 merge 回 master、删特性分支。
