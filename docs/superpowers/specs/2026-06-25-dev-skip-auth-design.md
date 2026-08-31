# 设计：开发态跳过登录门（devSkipAuth）

日期：2026-06-25
状态：待评审

## 背景与目标

桌面端登录是一套浏览器 OAuth（Authorization Code + PKCE + 本地回环回跳），整条流程跑在 Electron 主进程，见 `electron/lib/auth.js`。在 Electron 下调试时，每次启动都要走一遍 OAuth 才能进界面，拖慢开发。

目标：提供一个**仅开发态生效**的开关，启动时跳过登录门、直接进入界面，且**对生产环境零风险**。

非目标：不改动真实登录/登出流程；不改前端 `AuthGate`/`LoginGate`；不改 `preload`；不改 reconcile 逻辑。

## 现状摘要（为何这样设计是安全的）

经核实，本 app 的登录是一道**客户端 UI 门 + 一次云端吊销 ping**，不授权任何本地操作：

- 本地后端无用户鉴权 —— `src/ipmastercowork/api/deps.py` 无 `get_current_user`、无 token 校验、无中间件，每个接口无凭证可访问。
- 前端从不发送 token —— `frontend-desktop/src/api/client.ts` 调 `/api/v1` 只带 `Content-Type`，`access_token` 从不附到后端请求。
- `access_token` 全仓库只在 `electron/lib/auth.js` 内使用（云端 `/api/oauth/token` 换取、`/api/auth/me` 吊销检查）。
- `user` 对象纯展示 —— `SessionList.tsx` 只用它显示头像/用户名、决定是否显示「登出」。

因此「跳过登录门」去掉的是一道不提供真实授权的门。

## 触发方式

`app-config.json` 中的布尔字段 `devSkipAuth`，默认 `false` / 缺省。

配置读取链（**修正**）：`devSkipAuth` 是 dev-source 开关，闸门必须读「随包/仓库内」配置 `readBundledAppConfig()`（dev 态 = `electron/app-config.json`），**不能**读 `readAppConfigFile()`（AppData 用户副本）。

> 设计纠错：最初以为 `reconcileAppConfig`（`out = {...factory, ...user}`）会让出厂的 `devSkipAuth` 流入用户副本——方向反了。出厂副本固定 ship `false`，首次 dev 启动就把 `false` seed 进 AppData 用户副本；此后 `{...factory,...user}` 中**用户副本的 `false` 反向 shadow 掉**开发者对 `electron/app-config.json` 改的 `true`，导致旁路永不生效（已实测复现）。改读 `readBundledAppConfig()` 让仓库文件成为该 flag 的唯一权威源，且与 reconcile/持久化解耦；打包态另有 `!isPackaged` 守卫兜底，无需改 reconcile。

## 旁路逻辑：`auth.js getSession`

```js
// 明显伪造、低权限的本地开发身份。绝不冒充 admin；辨识度高、好 grep。
const DEV_USER = { id: 'dev-local', username: 'dev (local)', role: 'dev' };

async function getSession({ cloudBaseUrl, appDataDir, devSkipAuth }) {
  if (devSkipAuth) return DEV_USER;   // 跳过登录门，注入假用户
  // …… 原有 loadSession + 云端吊销检查逻辑不变
}
```

- `DEV_USER` 符合 `AuthUser` 形状（`{ id, username, role }`，见 `frontend-desktop/src/types/index.ts`），导出以便测试。
- 返回非空 user 后，`AuthGate`（`App.tsx:64`）不会展示 `LoginGate` —— 前端零改动。
- `auth-login` / `auth-logout` 不动：开关打开时登录门不出现故 login 永不触达；SessionList 的登出会清本地凭证但无实义，下次 `getSession` 又注入 DEV_USER，无副作用。

## 主进程接线：`main.js`

旁路的**安全闸门在主进程计算**，是整套方案唯一的承重行：

```js
ipcMain.handle('auth-session', () => {
  const devSkipAuth = computeDevSkipAuth({ isPackaged: app.isPackaged, appConfig: readBundledAppConfig() });  // 读仓库内配置，仅开发态生效
  if (devSkipAuth) elog('⚠ AUTH SKIPPED (devSkipAuth) — dev only');                  // 响亮启动告警
  return authFlow.getSession({
    cloudBaseUrl: getCloudBaseUrl(),
    appDataDir: getAppDataDir(),
    devSkipAuth,
  });
});
```

## 四条缓解措施（已折叠）

1. **`!app.isPackaged` 守卫** —— 打包态忽略该标志，与任何 `app-config.json` 内容无关。这是唯一承重行。
2. **不注入 `role:'admin'`** —— 用 `{ id:'dev-local', username:'dev (local)', role:'dev' }`，明显伪造、低权限、好 grep。
3. **守卫回归测试** —— 断言打包态下旁路不生效（见下）。
4. **响亮启动告警** —— 旁路激活时 `elog('⚠ AUTH SKIPPED (devSkipAuth) — dev only')`，绝不静默开启。

另：**绝不把 `devSkipAuth` 加进 `packaging/default_data/app-config.json`**（随包出厂副本）。只有 dev 回退 `electron/app-config.json` 加 `"devSkipAuth": false` 作为文档/播种。生产环境在守卫触发前就没东西可读。

## 配置文件改动

- `electron/app-config.json`（dev 回退副本）：新增 `"devSkipAuth": false`。
- `packaging/default_data/app-config.json`（随包出厂副本）：**不动**。

## 测试（`electron/test/`）

`auth.js getSession` 是纯函数（安全闸门在 main.js 算好后以布尔传入），无需 fs/electron：

- `devSkipAuth: true` → 返回 `DEV_USER`，且不读取本地 session（即使无 `auth.bin` 也返回）。
- `devSkipAuth: false` / 缺省 → 走原有逻辑（行为不变）。
- `DEV_USER` 形状断言：`{ id, username, role }` 三键齐备、`role !== 'admin'`。

守卫回归测试（main.js 闸门表达式，或抽成纯函数 `computeDevSkipAuth({ isPackaged, appConfig })` 后单测）：

- `isPackaged: true` + `appConfig.devSkipAuth: true` → `false`（打包态必忽略）。
- `isPackaged: false` + `appConfig.devSkipAuth: true` → `true`。
- `isPackaged: false` + 缺省 → `false`。

> 实现建议：把闸门抽成 `lib/auth.js` 导出的纯函数 `computeDevSkipAuth({ isPackaged, appConfig })`，main.js 调用它，测试直接覆盖三个分支。比内联表达式更好钉死「承重行」。

## 改动清单

- `electron/lib/auth.js`：`DEV_USER` 常量 + 导出；`getSession` 加 `devSkipAuth` 短路；`computeDevSkipAuth` 纯函数 + 导出。
- `electron/main.js`：`auth-session` handler 计算闸门 + 告警。
- `electron/app-config.json`：加 `"devSkipAuth": false`。
- `electron/test/auth.test.js`（或既有测试文件）：getSession 旁路 + computeDevSkipAuth 守卫回归。

不涉及：前端、preload、reconcile、`packaging/default_data/app-config.json`。

## 风险评估结论

生产环境足够安全：旁路去掉的是一道不提供真实授权的门，且在打包构建中基于多重独立理由天然失效（守卫 / 标志不在出厂副本 / DEV_USER 无 token / 本地后端本就无鉴权）。四条缓解针对的是**鉴权系统演进时保持安全**，而非当前漏洞。
