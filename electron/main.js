'use strict';

const { app, BrowserWindow, WebContentsView, Menu, dialog, shell, ipcMain, session, net, Notification, nativeImage, Tray, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const osMod = require('os');
const { drainSpool } = require('./lib/spool');
const { MAX_UI_LOAD_RETRIES, shouldRetryLoad, retryDelayMs, watchdogOverslept } = require('./lib/load-recovery');
const {
  buildTokenUsagePayload,
  loadJsonArray,
  saveJsonArrayAtomic,
} = require('./lib/token-usage');
const { createTokenUsageController } = require('./lib/token-usage-controller');
const { zipEntries } = require('./lib/zip');
const { applyBrandingEnv, brandingEnvLines } = require('./lib/env-branding');
const { buildSessionReportZipAsync } = require('./lib/session-report-async');
const { collectTail, collectFull } = require('./lib/log-bundler');
const { uploadLogs } = require('./lib/log-uploader');
const { parseCommands, commandsUrl, ackUrl } = require('./lib/commands');
const { resolveUpdateConfig, shouldCheckForUpdates, shouldReportTelemetry } = require('./lib/update-config');
const { loadingHtml: splashHtml } = require('./lib/splash');
const authFlow = require('./lib/auth');
const { createSubstrate } = require('./lib/substrate');
const { syncCoworkPackages } = require('./lib/cowork-sync');
const { planSeedMigration } = require('./lib/seed-migration');
const { planRetirement } = require('./lib/seed-retirement');
const { planMirror } = require('./lib/seed-mirror');
const { reconcileEnv, buildEnvCanonical, reconcileMarker } = require('./lib/env-reconcile');

// 云端请求一律走 Electron 的 net.fetch（Chromium 网络栈 = 系统证书库），不用 Node 全局
// fetch——后者用自带 CA、不认内网 CA（如华为内网），访问内网 https 会直接 "fetch failed"。
// net.fetch 与浏览器同源信任：http/https、域名/IP 都支持，浏览器能开的它就能连（auth.js 同）。
// 只用于打到云端（netcowork / telemetry）的请求；本地后端（BACKEND_URL, http://127.0.0.1）
// 用 Node fetch 即可，不涉及证书。
const httpFetch = (typeof net !== 'undefined' && net && net.fetch) ? net.fetch.bind(net) : fetch;
const { reconcileAppConfig } = require('./lib/app-config-reconcile');
const { safeUrlForLog } = require('./lib/window-open-policy');
const { createW3LoginView } = require('./lib/w3-login-view');
const { detectPackagedLayout } = require('./lib/packaged-layout');
const { mergeBundledMcpServers } = require('./lib/mcp-merge');
const { createReporter } = require('./telemetry');
const { tailString } = require('./lib/telemetry-core');
const { initUpdater } = require('./updater');
const { rotateIfNeeded } = require('./lib/log-rotate');

// 品牌标识唯一来源（appId / 显示名 / AppData 目录名 / 后端 exe 名）。构建期同一份文件由
// packaging/build_electron.ps1 注入 package.json 的 build 段（appId/productName/…），运行期
// 从这里读——不能读 package.json 的 build 段，electron-builder 打包时会把它整段剥掉。
// 衍生品牌只改 branding.json，勿把这些值硬编码回代码里。
const branding = require('./branding.json');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 端口取值：env > branding.backendPort。**绝不能回落到 15926** —— 那是上一代
// IPMaster-Cowork 的端口，占上它就会与旧版互相复用后端（见 branding.json 里的说明）。
const PORT = parseInt(process.env.NLC_BACKEND_PORT || String(branding.backendPort || ''), 10);
if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error('branding.json 缺少 backendPort —— 端口没有默认值，回落到旧端口会与上一代串台');
}
// 用 127.0.0.1 而非 localhost：后端 uvicorn 绑 0.0.0.0（仅 IPv4），而部分机器上
// localhost 会先解析成 IPv6 ::1 → 连不上 → 白屏。固定走 IPv4 回环避免此类问题。
const BACKEND_URL = `http://127.0.0.1:${PORT}`;
const IS_DEV = !!process.env.ELECTRON_DEV;
// 主程序刻意命名为 electron.exe 时，Electron 会把 app.isPackaged 误报为 false。
// electron-builder 的 app.asar 才是目录布局的可靠信号；源码运行只有 default_app.asar。
const USES_PACKAGED_LAYOUT = detectPackagedLayout({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  existsSync: fs.existsSync,
});
const DEV_VITE_URL = `http://localhost:${process.env.VITE_PORT || '5173'}`;

// 工程级配置（feedUrl / telemetryUrl / channel / netcoworkBaseUrl）唯一来源 = app-config.json，
// 由 readAppConfigFile() 读取：打包态取 packaging/default_data/app-config.json（经 extraResources
// 落到 resources/default_data/），开发态/回退取仓库内 electron/app-config.json。
// 不再支持 env / %APPDATA%/update-config.json 覆盖——配置全部走 app-config.json。
// 值缺失即视为未配置：feedUrl 空 → 不检查更新，telemetryUrl 空 → 不上报。

let mainWindow = null;
let backendProcess = null;
let chromiumSearchBridge = null;
let backendStartedAt = 0;
let backendStopping = false; // set during intentional stopBackend() so the exit handler doesn't report a spurious backend_crash
let crashUploadDone = false; // Phase B: at most one reason=crash log upload per app session
let electronLogStream = null;
let updateConfig = null;     // resolved update config
let telemetry = null;        // telemetry reporter
let autoUpdaterRef = null;   // active autoUpdater or null
let rendererReady = false;   // renderer signalled successful mount
let rendererWatchdog = null; // timer that fires if the renderer never mounts
let rendererWatchdogArmedAt = 0;   // wall clock at arm time — detects a timer that overslept a system suspend
let uiLoadFailed = false;    // main frame is currently sitting on a failed load of BACKEND_URL
let uiLoadAttempt = 0;       // consecutive transient-failure retries of that load
let uiLoadRetryTimer = null;
let tokenUsageController = null;
let tokenUsageAuthReady = false;
let tray = null;             // 托盘图标（最小化驻留 + 有待办时闪动）
let trayBlinkTimer = null;   // 闪动定时器；非 null 即处于闪动中
let authLoginInFlight = null;
let authSessionInFlight = null;
// 兼容异常情况下渲染层重载：正常的内嵌视图登录会直接通过 auth-login IPC 返回错误。
let pendingLoginError = null;

// The token spool/retry files are process-shared paths.  Enforce one Electron
// owner so two desktop instances cannot race the same claim, temp file or JWT.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // 复用 showMainWindow：窗口可能正最小化着，只 focus 是唤不出来的。
  app.on('second-instance', () => showMainWindow());
}

// ── Paths ─────────────────────────────────────────────────────────────────────

function getBackendExePath() {
  // 名字须与 packaging/ipmaster-cowork.spec 的 EXE/COLLECT name 一致——两边同读 branding.json。
  const exeName = `${branding.backendName}.exe`;
  if (USES_PACKAGED_LAYOUT) {
    return path.join(process.resourcesPath, 'backend', exeName);
  }
  return path.join(__dirname, '..', 'build', 'dist', branding.backendName, exeName);
}

function getBundledResourcesPath() {
  if (USES_PACKAGED_LAYOUT) {
    return path.join(process.resourcesPath, 'backend', 'resources');
  }
  return path.join(__dirname, '..', 'resources');
}

function getAppDataDir() {
  return path.join(app.getPath('appData'), branding.appDataDir);
}

// ── 窗口状态记忆 ────────────────────────────────────────────────────────────
// 记住上次关闭时的窗口大小/位置/是否最大化，下次启动恢复。首次启动（无记录）
// 默认最大化——cowork 全屏协作定位下最大化是常态；但记住状态，不强制剥夺
// 少数习惯小窗的用户（同 VS Code / Slack 的行为）。
function windowStatePath() { return path.join(getAppDataDir(), 'window-state.json'); }

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    // 必须有合法的宽高才认；否则（空对象/坏文件）返回 null 走首次逻辑（默认最大化），
    // 避免把没有尺寸的残缺记录误当“上次是小窗”。
    if (s && typeof s === 'object'
        && Number.isFinite(s.width) && s.width > 0
        && Number.isFinite(s.height) && s.height > 0) {
      return s;
    }
  } catch (_) { /* 无记录 / 坏文件 → 首次逻辑 */ }
  return null;
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    // 最大化时 getBounds 返回的是最大化后的尺寸；用 getNormalBounds 拿“还原态”尺寸，
    // 这样下次取消最大化时窗口大小是对的。
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(windowStatePath(), JSON.stringify({ ...bounds, maximized }), 'utf8');
  } catch (e) {
    elog(`saveWindowState failed: ${(e && e.message) || e}`);
  }
}


// One-time migration from the legacy AppData dir (branding.legacyAppDataDir) to the
// current one (rebrand). Runs before anything creates the new dir, so "new dir absent"
// is a reliable signal. Copies all user data and rewrites the migrated .env (env-var
// prefix + embedded paths) so the new backend reads the carried-over config.
// 派生品牌把 branding.legacyAppDataDir 置空即可跳过——不置空会把上一代品牌的数据
// 搬进新品牌目录。
function migrateLegacyAppData() {
  try {
    const legacyDirName = branding.legacyAppDataDir;
    if (!legacyDirName) return;          // 无历史目录可迁移（派生品牌）
    const newDir = getAppDataDir();
    const oldDir = path.join(app.getPath('appData'), legacyDirName);
    if (fs.existsSync(newDir)) return;   // already migrated / fresh new-layout run
    if (!fs.existsSync(oldDir)) return;  // fresh install, nothing to migrate
    fs.cpSync(oldDir, newDir, { recursive: true });
    const envPath = path.join(newDir, '.env');
    if (fs.existsSync(envPath)) {
      const txt = fs.readFileSync(envPath, 'utf8')
        .replace(/NETLIVE_COWORK_/g, 'NLC_')
        .replace(/IPMASTER_COWORK_/g, 'NLC_')
        .replace(new RegExp(escapeRegExp(legacyDirName), 'g'), branding.appDataDir);
      fs.writeFileSync(envPath, txt, 'utf8');
    }
    plog(`Migrated legacy AppData ${oldDir} -> ${newDir}`);
  } catch (e) {
    plog('migrateLegacyAppData failed: ' + e.message);
  }
}

/**
 * 把 Chromium 的 userData 并进业务数据目录。
 *
 * Electron 默认把 userData 放在 `%APPDATA%\<package.json name>`，而业务数据在
 * `%APPDATA%\<branding.appDataDir>` —— 名字不同，于是用户在 AppData 下看到**两个**
 * 目录（NetLIVECowork 与 netlive-cowork），不知道哪个是自己的数据。
 *
 * 改成 `<appDataDir>/chromium`：对外只剩一个目录，对内两类状态仍然分开——
 * Chromium 的缓存/Cookie/LocalStorage 与会话库、日志、套件混在一处的话，
 * "清缓存"和"清数据"就再也分不开了。
 *
 * ⚠ **必须在 app ready 之前调**，ready 之后 session 已经按旧路径建好了。
 * ⚠ 也必须在 migrateLegacyAppData() **之后**：那个函数以"新目录还不存在"为判据，
 *    这里一旦先把 <appDataDir>/chromium 建出来，老数据就再也迁不过来了。
 */
function migrateChromiumUserData() {
  try {
    const name = branding.legacyUserDataDir;
    if (!name) return;                              // 派生品牌没有上一代
    const legacy = path.join(app.getPath('appData'), name);
    const target = getAppDataDir();
    if (!fs.existsSync(legacy)) return;             // 全新安装，没什么可迁
    if (path.resolve(legacy).toLowerCase() === path.resolve(target).toLowerCase()) return;
    // force:false —— 只补目标里没有的，绝不覆盖已有的业务数据。
    fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
    // **拷完要删掉老目录**——留着的话用户在 AppData 下仍然看到两个文件夹，
    // "合成一个"就等于没做。这里删的是 Chromium 的缓存/Cookie/LocalStorage：
    // 已经完整拷到新位置，即便真丢了最坏也只是重登一次。与 migrateLegacyAppData
    // 保留老目录的取舍不同——那边是会话数据，丢不起。
    plog(`Merged Chromium userData ${legacy} -> ${target}`);
    try {
      fs.rmSync(legacy, { recursive: true, force: true });
      plog(`Removed legacy Chromium userData ${legacy}`);
    } catch (e) {
      // 删不掉（被占用等）不影响功能，只是多一个目录。
      plog('Removed legacy Chromium userData failed: ' + e.message);
    }
  } catch (e) {
    plog('migrateChromiumUserData failed: ' + e.message);
  }
}

// 随包出厂的工程级配置（app-config.json）。打包态读 **随包出厂配置**
// packaging/default_data/app-config.json（经 extraResources 落到 resources/default_data/），
// 缺失或开发态回退工程内 electron/app-config.json（随仓库走）。这样云端地址等出厂值可在打包时
// 通过 default_data 单独配置，与开发默认解耦。
function readBundledAppConfig() {
  const candidates = [];
  if (USES_PACKAGED_LAYOUT) {
    candidates.push(path.join(process.resourcesPath, 'default_data', 'app-config.json'));
  }
  candidates.push(path.join(__dirname, 'app-config.json'));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { elog(`readBundledAppConfig failed for ${p}: ${e.message}`); }
  }
  return {};
}

// 工程级配置的**用户副本**：seedAndReconcileAppConfig() 把出厂配置落到
// AppData/app-config.json，并在每次启动把三个 URL 强制刷成出厂值、保留用户的
// channel（见 lib/app-config-reconcile.js）。读取以用户副本为准，缺失时回退随包出厂值。
function getUserAppConfigPath() { return path.join(getAppDataDir(), 'app-config.json'); }

// 套件的**暂存**目录 —— 对账时把 zip 摆进来，后端从这里装（见 lib/cowork-sync.js）。
// 放 AppData 而不是安装目录：NSIS 升级时会清安装目录，而这里存的是"这个人被授权了什么"。
// ⚠ 与**已装**目录（data/coworks）是两个地方：待装 / 已装混用会让这两个状态分不开。
// ⚠ **这两个目录必须与后端完全一致，而且不能各推一遍。**
//
// 出过一次事故：主进程把 7 个套件下到了 <appData>/cowork-packages，后端在
// <appData>/data/cowork-packages 里找，报"没有授权凭据"。两边都"按自己的规则算"，
// 谁也没错，合起来就是错的，而且各自的日志都显示成功。
//
// 现在的做法：主进程算一次，**通过 NLC_* 显式传给后端**（见 spawn 时的 env），
// 后端那边的默认推导就再也用不上了。
function getCoworkStagingDir() {
  return process.env.NLC_COWORK_PACKAGES_DIR
    || path.join(getAppDataDir(), 'data', 'cowork-packages');   // = 后端 data_dir()/cowork-packages
}

/** 已装套件目录（对应后端 paths.coworks_dir()）。 */
function getCoworksDir() {
  return process.env.NLC_COWORKS_DIR
    || path.join(getAppDataDir(), 'coworks');
}

function readAppConfigFile() {
  const userPath = getUserAppConfigPath();
  try {
    if (fs.existsSync(userPath)) return JSON.parse(fs.readFileSync(userPath, 'utf8'));
  } catch (e) { elog(`readAppConfigFile failed for ${userPath}: ${e.message}`); }
  return readBundledAppConfig();
}

// 首启把随包 app-config.json 落到 AppData；每次启动按 force/preserve 规整：三个 URL
// （netcoworkBaseUrl/feedUrl/telemetryUrl）强制取出厂值，channel 及其它用户键保留。
// 每启动跑（而非仅版本门控）——URL 属 force，连用户手改也复位，语义更彻底；幂等无副作用。
function seedAndReconcileAppConfig() {
  try {
    const factory = readBundledAppConfig();
    const appDataDir = getAppDataDir();
    fs.mkdirSync(appDataDir, { recursive: true });
    const dst = getUserAppConfigPath();
    let user = {};
    const prev = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
    if (prev !== null) {
      try { user = JSON.parse(prev); }
      catch (e) { elog(`seedAndReconcileAppConfig: user app-config.json malformed, reseeding: ${e.message}`); user = {}; }
    }
    const merged = reconcileAppConfig(user, factory);
    const text = JSON.stringify(merged, null, 2) + '\n';
    if (prev !== text) { fs.writeFileSync(dst, text, 'utf8'); elog('Seeded/reconciled app-config.json in AppData'); }
  } catch (e) { elog(`seedAndReconcileAppConfig failed: ${e.message}`); }
}

// substrate（云端管理服务）的地址。**取值只走这一处。**
//
// 来源优先级：
//   1. NLC_SUBSTRATE_BASE_URL —— 只给开发用。本地连不通真实 substrate，
//      指向 mock 才自测得了（需求 C12 的同一条思路）。
//   2. app-config.json 的 substrateBaseUrl —— 随包出厂、force 复位（需求 B3）。
//
// **空 = 这个部署没有云端**，不是错误：不对账、不装、不删，应用照常开（需求 C11）。
// 每个调用点都要先判空再走，别在这里抛。
function getSubstrateBaseUrl() {
  const fromEnv = String(process.env.NLC_SUBSTRATE_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const cfg = readAppConfigFile() || {};
  return String(cfg.substrateBaseUrl || '').trim().replace(/\/+$/, '');
}

// substrate 客户端。地址与令牌都**每次现取**：地址在启动时会被 force 复位、
// 令牌在登录/切账号后才有 —— 缓存住会用到旧值，而"用了旧令牌"的表现是 401，
// 看起来像"没权限"。
const substrate = createSubstrate({
  getBaseUrl: () => getSubstrateBaseUrl(),
  getToken: () => authFlow.getToken(getAppDataDir()) || '',
  log: (level, msg) => elog(`[cowork] ${level === 'warn' ? '⚠ ' : ''}${msg}`),
  // ⚠ **必须用 Electron 的 net.fetch，不能用 Node 自带的 globalThis.fetch。**
  //
  // Node 的 fetch（undici）带着自己那份 CA 列表，既不认 Windows 证书库、也不读系统代理。
  // 企业网里出口普遍有 TLS 中间人和代理，于是它握手就失败，抛出来只剩一句"连不上"——
  // 看起来像云端挂了，实际是本机根本没出去。
  //
  // 这个差别曾经把人骗过一次：同一个域名，electron-updater 连得上（它走 Electron 的
  // net，也就是 Chromium 网络栈，两样都认），substrate 连不上。两条日志挨在一起，
  // 结论却相反。
  //
  // net.fetch 必须在 app ready 之后调 —— 取包发生在 startBackend 之后，满足。
  fetchImpl: (url, opts) => net.fetch(url, opts),
});

// 多久去问一次"我被授权了哪几个"。substrate **没有办法主动通知我们**，改了权限要等
// 我们下一次去问才知道 —— 所以这个间隔就是「收回多久之后真的生效」的上限（需求 C2）。
const COWORK_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let coworkRecheckTimer = null;

/**
 * 对一次账：问 substrate 要授权清单 → 把 zip 摆进暂存目录。
 *
 * `applyNow=true` 时还会叫后端立刻装下去。**启动那次不用叫** —— 后端马上就要启动，
 * 它自己会装；这时叫反而是往一个还没起来的端口发请求。
 *
 * 整段包 try：对账挂了不该让应用起不来、也不该让每日那次把定时器炸掉。
 * 没登录 / 没配 substrate 地址都会走到 ok:false —— **那是常态不是异常**（需求 C11）。
 */
async function syncCoworkPackagesOnce({ applyNow = false } = {}) {
  try {
    const r = await syncCoworkPackages({
      substrate,
      stagingDir: getCoworkStagingDir(),
      // ⚠ 必须与后端 paths.coworks_dir() 完全一致（= <appData>/coworks，**不带 data/**）。
      // 不一致时这里永远读到空目录，于是每次启动都把所有包重下一遍——功能不坏，
      // 所以不会有人发现，只是每次开机白下一轮。
      coworksDir: getCoworksDir(),
      log: (level, msg) => elog(`[cowork] ${level === 'warn' ? '⚠ ' : ''}${msg}`),
    });
    if (!r.ok) { elog(`[cowork] 对账未完成：${r.reason} —— 本地保持不变`); return; }
    // 没有任何变化就不打扰后端：装一遍要读磁盘、解 zip，白跑一次没有收益。
    if (!applyNow || (r.downloaded.length === 0 && r.revoked.length === 0)) return;
    const res = await fetch(`${BACKEND_URL}/api/v1/coworks/recheck`, { method: 'POST' });
    elog(`[cowork] 已通知后端装下去：HTTP ${res.status}`);
    // **也要告诉界面**。后端装完了、界面却不知道，用户看到的是"页眉里有这个智能体，
    // 新建会话却说你没有权限"—— 两处读的是同一份清单，只是界面那份是开机那一刻取的。
    // 用户唯一的出路是重启，而重启为什么管用他也不知道。
    if (res.ok) notifyCoworksChanged();
  } catch (e) {
    elog(`[cowork] 对账异常（不影响使用）：${(e && e.message) || e}`);
  }
}

//: 套件变了但窗口还没建好 —— 记下来，等渲染层就绪补发。
//
// 取包跑在 startBackend 之后、createWindow 之前后不定，而全新安装恰恰是"套件刚装好、
// 窗口刚出来"这两件事挨得最近的时候。直接 send 有一半概率发给一个还不存在的窗口，
// 于是界面停在空阵容上，用户只能点重试。
let coworksChangedPending = false;

function notifyCoworksChanged() {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send('coworks-changed');
    coworksChangedPending = false;
  } else {
    coworksChangedPending = true;
  }
}

/** 启动对一次，之后每天再对一次。定时器在退出时清掉。 */
async function syncCoworkPackagesOnStartup() {
  // applyNow:true —— 此刻后端已经起来了，装完立刻生效并通知界面刷新阵容。
  await syncCoworkPackagesOnce({ applyNow: true });
  if (coworkRecheckTimer) clearInterval(coworkRecheckTimer);
  coworkRecheckTimer = setInterval(
    () => { void syncCoworkPackagesOnce({ applyNow: true }); },
    COWORK_RECHECK_INTERVAL_MS,
  );
  // 不 unref：这个定时器该跟着应用活着。
}

function getOrCreateInstallId() {
  const p = path.join(getAppDataDir(), 'install-id');
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    const id = crypto.randomUUID();
    fs.mkdirSync(getAppDataDir(), { recursive: true });
    fs.writeFileSync(p, id, 'utf8');
    return id;
  } catch (e) { elog('getOrCreateInstallId failed: ' + e.message); return 'unknown'; }
}

// Phase B log-upload helpers. Logs live in %APPDATA%\<branding.appDataDir>\logs:
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
      fetchImpl: httpFetch,   // 内网 https 走系统证书库
      fields: clientFields('crash'),
      archive: { name: 'logs-crash.zip', data: zip },
    }).catch(() => {});
  } catch (_) {}
}

// token-usage 上报失败重试队列：每条上报现在都是「这一次 LLM 调用」的独立记录（不再是
// session 累计值，见 token_usage_subscriber.py 的改动说明），所以不能再指望"下一次上报带
// 更新的累计值自动覆盖掉失败的那次"这个自愈机制。队列项会绑定登录 epoch/user/itemId，
// 原子持久化到磁盘后才 POST：既能跨 Electron 重启重试，也不会被下一位登录用户继承。
function tokenUsageRetryQueuePath() { return path.join(getAppDataDir(), 'token-usage-retry.json'); }
function loadTokenUsageRetryQueue() {
  return loadJsonArray(tokenUsageRetryQueuePath());
}
function saveTokenUsageRetryQueue(q) {
  try {
    saveJsonArrayAtomic(tokenUsageRetryQueuePath(), q);
    return true;
  } catch (e) {
    elog('saveTokenUsageRetryQueue failed: ' + e.message);
    return false;
  }
}

function telemetryQueuePath() { return path.join(getAppDataDir(), 'telemetry-queue.json'); }
function loadTelemetryQueue() {
  try { const p = telemetryQueuePath(); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  return [];
}
function saveTelemetryQueue(q) {
  try { fs.writeFileSync(telemetryQueuePath(), JSON.stringify(q), 'utf8'); } catch (e) { elog('saveTelemetryQueue failed: ' + e.message); }
}

// ── Electron-side log file ────────────────────────────────────────────────────
// Captures backend stdout/stderr before Python's own logger starts.
// Written to %APPDATA%\<branding.appDataDir>\logs\electron.log

//: ready 之前产生的日志。**这一段是黑区** —— 目录迁移跑在 openElectronLog() 之前，
//: 而打包态没有控制台，process.stdout.write 写出去就没了。今天"会话没迁过来"、
//: "AppData 下还是两个目录"都发生在这一段里，而日志上一个字都没有，只能靠猜。
const preLogBuffer = [];

function plog(line) {
  preLogBuffer.push(line);
  try { process.stdout.write(line + '\n'); } catch (_) {}
}

function openElectronLog() {
  try {
    const logsDir = path.join(getAppDataDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'electron.log');
    rotateIfNeeded({ logPath });
    electronLogStream = fs.createWriteStream(logPath, { flags: 'a' });
    const ts = new Date().toISOString();
    electronLogStream.write(`\n${'='.repeat(60)}\n[${ts}] ${branding.productName} started\n`);
    // 把 ready 之前攒下的补进来 —— 否则迁移那几步永远查不到。
    for (const line of preLogBuffer.splice(0)) {
      electronLogStream.write(`[${ts}] ${line}\n`);
    }
    return logPath;
  } catch (e) {
    return null;
  }
}

function elog(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}\n`;
  if (electronLogStream) electronLogStream.write(msg);
  process.stdout.write(msg);
}

// ── .env bootstrap (first run) ────────────────────────────────────────────────

function ensureUserEnvFile() {
  const appDataDir = getAppDataDir();
  const envPath = path.join(appDataDir, '.env');

  if (!fs.existsSync(appDataDir)) {
    fs.mkdirSync(appDataDir, { recursive: true });
  }

  if (!fs.existsSync(envPath)) {
    const templatePath = USES_PACKAGED_LAYOUT
      ? path.join(process.resourcesPath, 'backend', '.env.example')
      : path.join(__dirname, '..', '.env.example');

    const toUnix = (p) => p.replace(/\\/g, '/');
    const resourcesPath = toUnix(getBundledResourcesPath());

    const logDir = toUnix(path.join(appDataDir, 'logs'));
    let content = '';
    if (fs.existsSync(templatePath)) {
      content = fs.readFileSync(templatePath, 'utf8');
      content = content.replace(/^NLC_DATA_DIR=.*/m,   `NLC_DATA_DIR=${toUnix(path.join(appDataDir, 'data'))}`);
      content = content.replace(/^NLC_RESOURCES_DIR=.*/m, `NLC_RESOURCES_DIR=${toUnix(path.join(appDataDir, 'resources'))}`);
      content = content.replace(/^NLC_SKILLS_DIR=.*/m, `NLC_SKILLS_DIR=${toUnix(getUserSkillsDir())}`);
      content = content.replace(/^NLC_AGENTS_DIR=.*/m, `NLC_AGENTS_DIR=${toUnix(getUserAgentsDir())}`);
      // Skill 市场地址等「以 branding.json 为准」的项：品牌**写了**才覆盖模板，没写就保持
      // 模板原值——与下面 seedBundledMcpConfig 里 MCP 定义那处的回落口径一致。规则与它踩过
      // 的坑见 lib/env-branding.js。
      content = applyBrandingEnv(content, branding);
      // Backend logs into NLC_LOG_DIR as backend.log; template only has these
      // commented out → append the active values.
      if (!/^NLC_LOG_DIR=/m.test(content)) {
        content += `\nNLC_LOG_DIR=${logDir}\nNLC_LOG_FILENAME=backend.log\n`;
      }
    } else {
      content = [
        `NLC_DATA_DIR=${toUnix(path.join(appDataDir, 'data'))}`,
        `NLC_RESOURCES_DIR=${toUnix(path.join(appDataDir, 'resources'))}`,
        `NLC_SKILLS_DIR=${toUnix(getUserSkillsDir())}`,
        `NLC_AGENTS_DIR=${toUnix(getUserAgentsDir())}`,
        ...brandingEnvLines(branding),
        `NLC_LOG_DIR=${logDir}`,
        `NLC_LOG_FILENAME=backend.log`,
      ].join('\n');
    }
    fs.writeFileSync(envPath, content, 'utf8');
    elog(`Created .env at ${envPath}`);
  }

  return envPath;
}

// ── Default config seeding (first run) ───────────────────────────────────────
// Copies bundled llm_configs / mcp_configs into AppData on first install.
// Only copies a subdir if it doesn't already exist — never overwrites user edits.

function seedDefaultData() {
  const defaultDataDir = USES_PACKAGED_LAYOUT
    ? path.join(process.resourcesPath, 'default_data')
    : path.join(__dirname, '..', 'data');

  if (!fs.existsSync(defaultDataDir)) return;

  const appDataDir = path.join(getAppDataDir(), 'data');

  for (const subdir of ['llm_configs', 'mcp_configs']) {
    const src = path.join(defaultDataDir, subdir);
    const dst = path.join(appDataDir, subdir);

    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) {
      elog(`${subdir} already exists in AppData, skipping seed`);
      continue;
    }

    try {
      fs.mkdirSync(dst, { recursive: true });
      for (const file of fs.readdirSync(src)) {
        if (!file.endsWith('.json')) continue;
        fs.copyFileSync(path.join(src, file), path.join(dst, file));
        elog(`Seeded ${subdir}/${file}`);
      }
    } catch (e) {
      elog(`Failed to seed ${subdir}: ${e.message}`);
    }
  }
}

// Seed bundled resources/mcp.json into AppData/resources/mcp.json, force-overwriting
// on every launch. mcp.json is app-shipped/canonical (internal MCP endpoints), so we
// Merge bundled resources/mcp.json server entries into AppData/resources/mcp.json.
// Bundled (app-shipped, e.g. internal MCP endpoints) servers are refreshed/added on
// every launch; MCP servers the user added through the UI (other keys) are preserved.
// The frozen backend reads resources_dir/mcp.json (= AppData/resources) via MCPServerStore.
/**
 * 展开 mcp.json 里的路径占位符。
 *
 * **这一步以前根本不存在** —— `command` 落到后端手上就是字面量 `${APP_NODE}`，
 * 于是 browser-mcp 每次启动都 WinError 2（系统找不到指定的文件），而日志只说
 * "MCP unavailable"，完全看不出是路径没解析。
 *
 * 两个占位符都指向随包资源，位置由 packaging/build_electron.ps1 决定：
 *   ${APP_NODE}         内置 Node runtime
 *   ${APP_BROWSER_MCP}  随包的 browser-mcp
 */
function expandMcpPlaceholders(text) {
  const backendRoot = USES_PACKAGED_LAYOUT
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..');
  const map = {
    '${APP_NODE}': path.join(backendRoot, 'node-runtime', 'node.exe'),
    '${APP_BROWSER_MCP}': path.join(backendRoot, 'resources', 'browser-mcp'),
  };
  let out = text;
  for (const [k, v] of Object.entries(map)) {
    // 值要落进 JSON 字符串，Windows 路径里的反斜杠必须转义，否则解析就炸。
    out = out.split(k).join(v.replace(/\\/g, '\\\\'));
  }
  return out;
}

function seedBundledMcpConfig() {
  try {
    const src = path.join(getBundledResourcesPath(), 'mcp.json');
    if (!fs.existsSync(src)) { elog('seedBundledMcpConfig: no bundled mcp.json, skipping'); return; }
    const bundledText = expandMcpPlaceholders(fs.readFileSync(src, 'utf8'));
    try { JSON.parse(bundledText); }
    catch (e) { elog('seedBundledMcpConfig: bundled mcp.json is malformed, skipping: ' + e.message); return; }
    const dstDir = path.join(getAppDataDir(), 'resources');
    const dst = path.join(dstDir, 'mcp.json');
    fs.mkdirSync(dstDir, { recursive: true });
    const userText = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    const { text, changed } = mergeBundledMcpServers(userText, bundledText);
    if (changed) { fs.writeFileSync(dst, text, 'utf8'); elog('Merged bundled mcp.json servers into AppData/resources'); }
  } catch (e) { elog(`seedBundledMcpConfig failed: ${e.message}`); }
}

// ── .env upgrade reconciliation ───────────────────────────────────────────────
// Converge an existing user .env toward this build's canonical shape on version
// change. Policy (force/managed/path) lives in lib/env-reconcile.js so it's testable.
// See docs/superpowers/specs/2026-06-25-env-reconcile-on-upgrade-design.md.

// App-computed AppData path values (policy 'path'); merged into the canonical set.
function envPathVals(appDataDir) {
  const toUnix = (p) => p.replace(/\\/g, '/');
  return {
    NLC_DATA_DIR: toUnix(path.join(appDataDir, 'data')),
    NLC_RESOURCES_DIR: toUnix(path.join(appDataDir, 'resources')),
    NLC_SKILLS_DIR: toUnix(getUserSkillsDir()),
    NLC_AGENTS_DIR: toUnix(getUserAgentsDir()),
    NLC_LOG_DIR: toUnix(path.join(appDataDir, 'logs')),
    NLC_LOG_FILENAME: 'backend.log',
  };
}

function reconcileUserEnv() {
  try {
    const appDataDir = getAppDataDir();
    const envPath = path.join(appDataDir, '.env');
    const markerPath = path.join(appDataDir, '.env-reconciled-version');

    // Template must be read up-front: the marker folds in a fingerprint of the
    // canonical, so a rebuilt package with the same version (dev `-test` iterations,
    // or a factory-template change shipped without a version bump) still re-runs.
    const templatePath = USES_PACKAGED_LAYOUT
      ? path.join(process.resourcesPath, 'backend', '.env.example')
      : path.join(__dirname, '..', '.env.example');
    if (!fs.existsSync(templatePath)) { elog('reconcileUserEnv: template missing, skip'); return; }

    const canonical = buildEnvCanonical(fs.readFileSync(templatePath, 'utf8'), envPathVals(appDataDir));
    const stamp = reconcileMarker(app.getVersion(), canonical);

    let marker = null;
    try { if (fs.existsSync(markerPath)) marker = fs.readFileSync(markerPath, 'utf8').trim(); } catch (_) {}
    if (marker === stamp) return;                     // already reconciled this version + canonical

    // Fresh install: ensureUserEnvFile() will create a correct .env; nothing to reconcile.
    if (!fs.existsSync(envPath)) {
      try { fs.writeFileSync(markerPath, stamp, 'utf8'); } catch (_) {}
      return;
    }

    const { text, changed } = reconcileEnv(fs.readFileSync(envPath, 'utf8'), { canonical });
    if (changed) { fs.writeFileSync(envPath, text, 'utf8'); elog('Reconciled .env to current build'); }
    fs.writeFileSync(markerPath, stamp, 'utf8');
  } catch (e) { elog('reconcileUserEnv failed: ' + e.message); }
}

// AppData/installed-version records the app version last seeded. applyVersionAwareSeed
// OVERWRITES it with the current version at its end, so anything that needs the
// pre-upgrade value (e.g. the agents force-mirror) must read it BEFORE that runs.
function getInstalledVersionMarkerPath() { return path.join(getAppDataDir(), 'installed-version'); }
function readInstalledVersion() {
  try {
    const p = getInstalledVersionMarkerPath();
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (_) {}
  return null;
}

function applyVersionAwareSeed() {
  const appDataDir = getAppDataDir();
  const markerPath = getInstalledVersionMarkerPath();
  const installedVersion = readInstalledVersion();
  const currentVersion = app.getVersion();

  const defaultDataDir = USES_PACKAGED_LAYOUT
    ? path.join(process.resourcesPath, 'default_data')
    : path.join(__dirname, '..', 'data');

  for (const subdir of ['llm_configs', 'mcp_configs']) {
    const src = path.join(defaultDataDir, subdir);
    const dst = path.join(appDataDir, 'data', subdir);
    if (!fs.existsSync(src)) continue;
    const bundled = fs.readdirSync(src).filter((f) => f.endsWith('.json'));
    const existing = fs.existsSync(dst) ? fs.readdirSync(dst).filter((f) => f.endsWith('.json')) : [];
    const { versionChanged, filesToCopy } = planSeedMigration({
      installedVersion, currentVersion, bundledConfigFiles: bundled, existingConfigFiles: existing,
    });
    if (!versionChanged) continue;
    fs.mkdirSync(dst, { recursive: true });
    for (const f of filesToCopy) {
      try {
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
        elog(`seed(upgrade): ${subdir}/${f}`);
      } catch (e) { elog(`seed(upgrade): failed to copy ${subdir}/${f}: ${e.message}`); }
    }
  }
  try { fs.writeFileSync(markerPath, currentVersion, 'utf8'); } catch (e) { elog('write installed-version failed: ' + e.message); }
}

// User skills live in AppData (NOT the install dir) so they survive app updates
// (NSIS overwrites the install dir, which would otherwise wipe pulled/imported skills).
function getUserSkillsDir() { return path.join(getAppDataDir(), 'skills'); }
function getUserAgentsDir() { return path.join(getAppDataDir(), 'agents'); }

// Content fingerprint of a folder: a stable sha256 over its relative file paths
// (forward-slash, sorted) and file bytes. Two folders hash equal iff their tree of
// files+contents matches, regardless of OS or traversal order. Used to tell whether
// the user has locally edited a bundled skill/agent since we last wrote it.
function hashDirContent(dir) {
  const h = crypto.createHash('sha256');
  const walk = (cur, rel) => {
    const entries = fs.readdirSync(cur, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        h.update(`D:${relPath}\n`);
        walk(abs, relPath);
      } else if (e.isFile()) {
        h.update(`F:${relPath}\n`);
        h.update(fs.readFileSync(abs));
        h.update('\n');
      }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

// Records the hash of what we last seeded per bundled entry, so a later launch can
// distinguish "user edited this" (dest hash drifted from the recorded one) from
// "still pristine / bundle changed". Shape: { skills: {entry: hash}, agents: {...} }.
function getSeedManifestPath() { return path.join(getAppDataDir(), '.bundled-seed-manifest.json'); }
function readSeedManifest() {
  try {
    const p = getSeedManifestPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { elog('readSeedManifest failed: ' + e.message); }
  return {};
}
function writeSeedManifest(manifest) {
  try { fs.writeFileSync(getSeedManifestPath(), JSON.stringify(manifest, null, 2), 'utf8'); }
  catch (e) { elog('writeSeedManifest failed: ' + e.message); }
}

// 这些内置 skill 已全部改为「云端引用」，本地副本一律删除。
// 直接按固定名单删，不比对签名——不管用户有没有改过、有没有用过（用过会多出 __pycache__
// 等文件，签名比对会误判为「改过」而保留，正是要避免的）。用户自建的 skill 名字不在此列，
// 不受影响。删完顺手从 seed manifest 抹掉残留记录。
//
// 只跑一次：清理成功后在 manifest 里打 retiredBuiltinsCleaned 标记，之后启动直接跳过，
// 避免这几个名字被「永久拉黑」（否则用户以后 pull/import 同名 skill 会被反复删）。标记存
// 在 AppData 的 manifest 里，跨更新保留。若某次删除失败则不打标记，下次启动重试。
const RETIRED_BUILTIN_SKILLS = ['docx', 'pdf', 'pptx', 'skill-creator', 'skill-edit', 'xlsx'];

function removeRetiredBuiltinSkills() {
  const manifest = readSeedManifest();
  if (manifest.retiredBuiltinsCleaned) return;   // 已清理过 → 不再跑

  const skillsDir = getUserSkillsDir();
  let failed = false;
  for (const name of RETIRED_BUILTIN_SKILLS) {
    const d = path.join(skillsDir, name);
    try {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
        elog(`Removed retired built-in skill: ${name}`);
      }
    } catch (e) {
      failed = true;
      elog(`removeRetiredBuiltinSkills: failed ${name}: ${e.message}`);
    }
    if (manifest.skills && name in manifest.skills) delete manifest.skills[name];
  }
  if (!failed) manifest.retiredBuiltinsCleaned = true;   // 全部成功才打标记，否则下次重试
  writeSeedManifest(manifest);
}

// Seed bundled <name> (skills / agents) into its AppData copy so content lives in
// AppData and survives app updates (NSIS overwrites the install dir). In every mode,
// only entries that EXIST in the bundle are touched; user-ADDED/pulled dirs (not in
// the bundle) are left untouched.
// - overwrite=true, detectLocalEdits=false: force-overwrite — the whole stale
//   folder is removed and recopied from the bundle on every launch (app-shipped/
//   canonical templates; local edits to them are intentionally NOT preserved).
// - overwrite=true, detectLocalEdits=true (skills & agents): same refresh, but with LOCAL-
//   MODIFICATION DETECTION — if the user edited a bundled entry since we last wrote it
//   (dest hash != recorded hash), it's preserved; otherwise it's refreshed from the
//   bundle. On the first launch after the manifest is introduced there's no record yet,
//   so a pre-existing entry that differs is treated as unmodified and refreshed (one-
//   time force-overwrite), after which edits are tracked and preserved.
// - overwrite=false: missing-only — copy only when the dest doesn't exist yet.
// - mirror=true (agents, on version upgrade only): FORCE the dest to hold EXACTLY the
//   bundled default entries — remove anything not shipped (user-added/pulled dirs are
//   NOT spared here, unlike the other modes) and force-overwrite every shipped entry.
//   Bundle-missing is treated defensively (see below): it never wipes the dest.
function seedBundledResource(name, { overwrite = false, detectLocalEdits = false, mirror = false } = {}) {
  try {
    const src = path.join(getBundledResourcesPath(), name);
    const dst = path.join(getAppDataDir(), name);
    // bundle 可能已完全不发这类资源（如内置 skill 全改云端引用后 skills 目录为空/不存在）。
    // 这种情况下仍要按记录文件清理掉以前铺过的项，所以不能直接 return —— 只有「既没得铺、
    // 又不需要清理」时才提前退出。mirror 也走这条早退：bundle 缺失时绝不清空用户 AppData
    // （防打包事故把 agents 全删）。
    const srcExists = fs.existsSync(src);
    if (!srcExists && !detectLocalEdits) return;
    fs.mkdirSync(dst, { recursive: true });

    // ── mirror：升级时强制 agents 只留 default data 里的内容 ──
    // 决策交给纯函数 planMirror（见 lib/seed-mirror.js）：删 present 里不在 bundle 的条目。
    if (mirror) {
      const shipped = fs.readdirSync(src).filter((e) => {
        try { return fs.statSync(path.join(src, e)).isDirectory(); } catch (_) { return false; }
      });
      const { toRemove } = planMirror({ shipped, present: fs.readdirSync(dst) });
      for (const entry of toRemove) {
        try {
          fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
          elog(`Mirror ${name}: removed non-default ${entry}`);
        } catch (e) { elog(`mirror ${name}: failed remove ${entry}: ${e.message}`); }
      }
      // 重建 seed manifest 基线：升级后的同版本普通启动走 detectLocalEdits 时，基线=bundle
      // 内容，才不会把「刚镜像回去的 default」误判成「用户改过」而永不刷新。
      const manifest = readSeedManifest();
      const seeded = (manifest[name] = {});
      for (const entry of shipped) {
        const s = path.join(src, entry);
        const d = path.join(dst, entry);
        try {
          if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
          fs.cpSync(s, d, { recursive: true });
          seeded[entry] = hashDirContent(s);
          elog(`Mirror ${name}: refreshed ${entry}`);
        } catch (e) { elog(`mirror ${name}: failed copy ${entry}: ${e.message}`); }
      }
      writeSeedManifest(manifest);
      return;
    }

    const manifest = detectLocalEdits ? readSeedManifest() : null;
    const seeded = detectLocalEdits ? (manifest[name] || (manifest[name] = {})) : null;
    let manifestDirty = false;

    for (const entry of (srcExists ? fs.readdirSync(src) : [])) {
      const s = path.join(src, entry);
      try {
        if (!fs.statSync(s).isDirectory()) continue;
        const d = path.join(dst, entry);

        if (fs.existsSync(d)) {
          if (!overwrite) continue;                            // keep the user's version

          if (detectLocalEdits) {
            const srcHash = hashDirContent(s);
            const destHash = hashDirContent(d);
            const seededHash = seeded[entry];
            // User edited this bundled entry since we last wrote it → preserve their copy.
            if (seededHash !== undefined && destHash !== seededHash) {
              elog(`Skipped bundled ${name}: ${entry} (locally modified)`);
              continue;
            }
            // Unmodified (or no record yet) → refresh from the bundle if it changed.
            if (destHash !== srcHash) {
              fs.rmSync(d, { recursive: true, force: true });  // drop the whole stale folder
              fs.cpSync(s, d, { recursive: true });
              elog(`Refreshed bundled ${name}: ${entry}`);
            }
            if (seeded[entry] !== srcHash) { seeded[entry] = srcHash; manifestDirty = true; }
            continue;
          }

          fs.rmSync(d, { recursive: true, force: true });      // force-refresh bundled template
          fs.cpSync(s, d, { recursive: true });
          elog(`Refreshed bundled ${name}: ${entry}`);
          continue;
        }

        fs.cpSync(s, d, { recursive: true });
        if (detectLocalEdits) { seeded[entry] = hashDirContent(s); manifestDirty = true; }
        elog(`Seeded bundled ${name}: ${entry}`);
      } catch (e) { elog(`seedBundledResource(${name}): failed ${entry}: ${e.message}`); }
    }

    // ── 回收:以前铺过、bundle 已不再发的 entry ──
    // manifest 是归属台账:在册 = 我们装的。在册却已不在 bundle 的,就是退役内置项。
    // 决策交给纯函数 planRetirement(见 lib/seed-retirement.js);这里只采集 dest 状态并落地。
    // 用户自己加的/pull 的目录从未进过 manifest,planRetirement 永远不会输出它们,不可能被误删。
    if (detectLocalEdits) {
      const shipped = srcExists ? fs.readdirSync(src) : [];   // bundle 不发 → 视作空清单
      // 诊断:bundle 不再发这类资源时,记录文件里还剩多少条待清理。若为 0,说明旧版本
      // 从没把它们记进来（无从清理);若 >0 却没删掉,再看下面的 Retired/Released 日志。
      if (!srcExists) elog(`seed ${name}: bundle 无此目录,按记录清理 ${Object.keys(seeded).length} 条`);
      const shippedSet = new Set(shipped);
      const destState = {};
      for (const entry of Object.keys(seeded)) {
        if (shippedSet.has(entry)) continue;               // 还在发,主循环已处理
        const d = path.join(dst, entry);
        const exists = fs.existsSync(d);
        destState[entry] = { exists, hash: exists ? hashDirContent(d) : null };
      }
      const { toDelete, toRelease, toForget } = planRetirement({
        seededHashes: seeded, bundleEntries: shipped, destState,
      });
      for (const entry of toDelete) {
        try {
          fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
          elog(`Retired bundled ${name}: ${entry} (dropped from bundle)`);
        } catch (e) { elog(`retire ${name}: failed ${entry}: ${e.message}`); }
      }
      for (const entry of toRelease) {
        elog(`Released retired ${name}: ${entry} (locally modified, kept & untracked)`);
      }
      for (const entry of toForget) { delete seeded[entry]; manifestDirty = true; }
    }

    if (manifestDirty) writeSeedManifest(manifest);
  } catch (e) { elog(`seedBundledResource(${name}) failed: ${e.message}`); }
}

// ── Backend lifecycle ─────────────────────────────────────────────────────────

// Collected stderr lines for crash dialog
const stderrLines = [];

function startBackend(bridgeInfo = null) {
  const exePath = getBackendExePath();
  elog(`Backend exe: ${exePath}`);
  elog(`Exists: ${fs.existsSync(exePath)}`);

  if (!fs.existsSync(exePath)) {
    dialog.showErrorBox(`${branding.productName} — 启动失败`, `找不到后端程序：\n${exePath}\n\n请重新安装应用。`);
    app.quit();
    return false;
  }

  const envFilePath = ensureUserEnvFile();
  elog(`Env file: ${envFilePath}`);

  backendStopping = false;
  backendStartedAt = Date.now();
  backendProcess = spawn(exePath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(bridgeInfo ? {
        NLC_WEB_CHROMIUM_BRIDGE_URL: bridgeInfo.endpoint,
        NLC_WEB_CHROMIUM_BRIDGE_TOKEN: bridgeInfo.token,
      } : {}),
      // Product identity is injected on every launch so upgraded installs do
      // not depend on whether their persisted .env has already been reconciled.
      element_name: 'On‑Prem CoWork',
      agent_display_name: 'CoWork',
      // Release builds use Playwright's hermetic layout collected inside the
      // PyInstaller bundle. Keep this value path-free; the Browser_Use MCP
      // registration forwards it explicitly to its stdio child process.
      ...(USES_PACKAGED_LAYOUT ? { PLAYWRIGHT_BROWSERS_PATH: '0' } : {}),
      NLC_BACKEND_PORT: String(PORT),
      NLC_APP_ID: branding.appId,          // 见 isBackendAlreadyRunning：复用前要比对它
      NLC_ENV_FILE: envFilePath,
      // Force data/resources/skills/agents to the AppData dirs (survive updates),
      // overriding any .env value. Without DATA_DIR/RESOURCES_DIR the frozen backend
      // (_run.py) falls back to the install dir, which NSIS wipes on update — losing
      // the SQLite DB, llm_configs and mcp.json.
      NLC_DATA_DIR: path.join(getAppDataDir(), 'data'),
      NLC_RESOURCES_DIR: path.join(getAppDataDir(), 'resources'),
      NLC_SKILLS_DIR: getUserSkillsDir(),
      // ⚠ 显式下发，别让后端自己再推一遍（见 getCoworkStagingDir 的说明）。
      NLC_COWORK_PACKAGES_DIR: getCoworkStagingDir(),
      NLC_COWORKS_DIR: getCoworksDir(),
      // 上一代的数据目录，供后端做一次性存量导入。目录名是 branding 的知识，
      // 让后端自己拼一遍就又是一处"两边各推一遍"。老目录不存在就传空。
      NLC_LEGACY_APPDATA_DIR: branding.legacyAppDataDir
        ? path.join(app.getPath('appData'), branding.legacyAppDataDir)
        : '',
      NLC_AGENTS_DIR: getUserAgentsDir(),
      // substrate 地址下发给后端：w3_auth 的白名单预检与 JWT 发放/续期按
      // CLOUD_JWT_MIGRATION 平移到 substrate。取值只走 getSubstrateBaseUrl()
      // （env 优先、否则 app-config，见其说明）。空 = 该部署没有 substrate，
      // 不注入 → 后端回退 netcowork 云端。
      ...(getSubstrateBaseUrl() ? { NLC_SUBSTRATE_BASE_URL: getSubstrateBaseUrl() } : {}),
    },
    cwd: getAppDataDir(),
    windowsHide: true,
  });

  elog(`Backend PID: ${backendProcess.pid ?? 'none'}`);

  backendProcess.stdout.on('data', (d) => elog('[stdout] ' + d.toString().trimEnd()));
  backendProcess.stderr.on('data', (d) => {
    const text = d.toString().trimEnd();
    elog('[stderr] ' + text);
    stderrLines.push(text);
    if (stderrLines.length > 60) stderrLines.shift();
  });

  backendProcess.on('error', (err) => {
    elog(`[spawn-error] ${err.message}`);
    dialog.showErrorBox(
      `${branding.productName} — 无法启动后端`,
      `启动后端进程时出错：\n${err.message}\n\n日志文件：${path.join(getAppDataDir(), 'logs', 'electron.log')}`,
    );
  });

  backendProcess.on('exit', (code, signal) => {
    elog(`[exit] code=${code} signal=${signal}`);
    if (code !== null && code !== 0 && !backendStopping && telemetry) {
      telemetry.report('backend_crash', {
        exit_code: code,
        stderr_tail: tailString(stderrLines.join('\n'), 4096),
      }).catch(() => {});
    }
    if (code !== null && code !== 0 && !backendStopping) uploadCrashLogs();
    if (code !== null && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      const logPath = path.join(getAppDataDir(), 'logs', 'electron.log');
      const lastLines = stderrLines.slice(-20).join('\n');
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: `${branding.productName} — 后端异常退出`,
        message: `后端进程退出（退出码 ${code}）`,
        detail: lastLines
          ? `最近输出：\n${lastLines}\n\n完整日志：${logPath}`
          : `完整日志：${logPath}`,
        buttons: ['打开日志', '关闭'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) shell.openPath(logPath);
      });
    }
  });

  return true;
}

function stopBackend() {
  backendStopping = true;
  return new Promise((resolve) => {
    if (!backendProcess) { resolve(); return; }
    const proc = backendProcess;
    const pid = proc.pid;
    backendProcess = null;
    if (proc.exitCode !== null) { resolve(); return; }

    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once('exit', finish);

    try { proc.kill('SIGTERM'); } catch (_) {}

    // Windows: if it hasn't exited in 5s, force-kill the process tree so the
    // exe file lock is released before NSIS overwrites it.
    setTimeout(() => {
      if (done) return;
      try {
        if (process.platform === 'win32' && pid) {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else { proc.kill('SIGKILL'); }
      } catch (e) { elog('force kill failed: ' + e.message); }
      setTimeout(finish, 1500);
    }, 5000);
  });
}

async function startChromiumSearchBridge() {
  try {
    // Load lazily so a damaged/missing optional bridge never crashes startup.
    const { createChromiumSearchBridge } = require('./lib/chromium-search-bridge');
    const bridge = await createChromiumSearchBridge({
      BrowserWindow,
      session,
      log: (message) => elog(`[web-search] ${message}`),
    });
    elog(`[web-search] Chromium bridge listening on 127.0.0.1:${bridge.port}`);
    return bridge;
  } catch (error) {
    const message = error && error.message ? error.message : 'unknown error';
    elog(`[web-search] Chromium bridge unavailable: ${message}`);
    return null;
  }
}

async function stopChromiumSearchBridge() {
  const bridge = chromiumSearchBridge;
  chromiumSearchBridge = null;
  if (!bridge) return;
  try { await bridge.close(); }
  catch (error) { elog(`[web-search] bridge shutdown failed: ${error.message}`); }
}

// ── Backend readiness poll ────────────────────────────────────────────────────

// Overall deadline, generous on purpose: slow machines (cold start, AV scan,
// first-run unpack) can take minutes, so 10 min rather than the old 30s. But it
// must exist — without it a backend that is alive yet wedged leaves the splash
// spinning forever, with no error and no way to reach the log. We also bail out
// immediately if the backend process itself has exited.
//
// Wall-clock deadline rather than an attempt count: each probe can itself burn
// up to the 1s request timeout, so N attempts × 500ms understates real elapsed
// time by up to 3x.
const BACKEND_READY_TIMEOUT_MS = 10 * 60 * 1000;

function waitForBackend(timeoutMs = BACKEND_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      const req = http.get(`${BACKEND_URL}/health`, { timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };

    const retry = () => {
      // If the backend process has already exited, no point waiting
      if (backendProcess && backendProcess.exitCode !== null) {
        reject(new Error(`后端进程已退出（退出码 ${backendProcess.exitCode}）`));
        return;
      }
      if (Date.now() >= deadline) {
        const logPath = path.join(getAppDataDir(), 'logs', 'electron.log');
        const minutes = Math.round(timeoutMs / 60000);
        reject(new Error(`后端 ${minutes} 分钟内未能启动。\n\n日志：${logPath}`));
        return;
      }
      setTimeout(check, 500);
    };

    check();
  });
}

// ── Window ────────────────────────────────────────────────────────────────────

// Splash shown before the renderer (and its i18n) loads. The main process can't
// read the renderer's saved language choice, so follow the OS locale here.
function loadingHtml() {
  return splashHtml({
    productName: branding.productName,
    zh: app.getLocale().toLowerCase().startsWith('zh'),
  });
}

// White-screen watchdog: after loading the real UI we expect the renderer to
// signal 'renderer-ready' (preload bridge, called from React on mount). If it
// doesn't within the window, the page loaded but nothing rendered — a blocked
// module subresource (the registry-MIME / stale-chunk bugs, which do NOT fire
// did-fail-load) or a JS throw during mount. Surface it instead of a silent
// blank, with a retry that reloads the renderer.
function disarmRendererWatchdog() {
  if (rendererWatchdog) clearTimeout(rendererWatchdog);
  rendererWatchdog = null;
}

function armRendererWatchdog(timeoutMs = 20000) {
  rendererReady = false;
  disarmRendererWatchdog();
  rendererWatchdogArmedAt = Date.now();
  rendererWatchdog = setTimeout(() => {
    rendererWatchdog = null;
    if (rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
    // A suspend freezes the timer, so it fires the instant the machine wakes —
    // see watchdogOverslept(). Re-arm and give the renderer its real window.
    const now = Date.now();
    const elapsed = now - rendererWatchdogArmedAt;
    if (watchdogOverslept(rendererWatchdogArmedAt, now, timeoutMs)) {
      elog(`[watchdog] timer overslept ${elapsed}ms (system suspend?) — re-arming instead of alerting`);
      armRendererWatchdog(timeoutMs);
      return;
    }
    const logPath = path.join(getAppDataDir(), 'logs', 'electron.log');
    elog(`[watchdog] renderer did not signal ready within ${timeoutMs}ms (possible white screen)`);
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: `${branding.productName} — 界面未能加载`,
      message: '界面已打开但未能正常显示',
      detail: `页面已加载但应用未渲染（可能是脚本被拦截或渲染出错）。\n\n完整日志：${logPath}`,
      buttons: ['重试', '打开日志', '关闭'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
        armRendererWatchdog(timeoutMs);
        mainWindow.webContents.reload();
      } else if (response === 1) {
        shell.openPath(logPath);
      }
    });
  }, timeoutMs);
}

function cancelUiLoadRetry() {
  if (uiLoadRetryTimer) clearTimeout(uiLoadRetryTimer);
  uiLoadRetryTimer = null;
}

// Single entry point for putting the real UI in the window, so every path
// (first load, retry, power resume, dialog button) resets the same state.
function loadMainUI({ resetAttempts = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  cancelUiLoadRetry();
  if (resetAttempts) uiLoadAttempt = 0;
  uiLoadFailed = false;
  mainWindow.loadURL(BACKEND_URL);
  armRendererWatchdog();
}

function scheduleUiLoadRetry(reason) {
  if (uiLoadRetryTimer) return;
  const delay = retryDelayMs(uiLoadAttempt);
  uiLoadAttempt += 1;
  elog(`[ui-load] ${reason} — retry ${uiLoadAttempt}/${MAX_UI_LOAD_RETRIES} in ${delay}ms`);
  uiLoadRetryTimer = setTimeout(() => {
    uiLoadRetryTimer = null;
    loadMainUI({ resetAttempts: false });
  }, delay);
}

// The machine that produced the field report slept ~2s after loadURL and stayed
// asleep 14h; the window sat on the splash the whole time because nothing
// retried. Resume is exactly when Chromium's sockets come back, so reload then.
function installPowerRecovery() {
  const onWake = (event) => {
    if (!uiLoadFailed || !mainWindow || mainWindow.isDestroyed()) return;
    elog(`[power] ${event} — reloading UI after failed load`);
    loadMainUI();
  };
  powerMonitor.on('resume', () => onWake('resume'));
  powerMonitor.on('unlock-screen', () => onWake('unlock-screen'));
}

async function createWindow() {
  // 上次窗口状态：有则用其大小/位置初始化；无（首次）则用默认 1280×800，稍后最大化。
  const savedState = loadWindowState();
  mainWindow = new BrowserWindow({
    width: (savedState && savedState.width) || 1280,
    height: (savedState && savedState.height) || 800,
    // 只在有合法坐标时设 x/y，否则交给系统居中（避免 undefined 让窗口跑到 0,0 或屏外）。
    ...(savedState && Number.isInteger(savedState.x) && Number.isInteger(savedState.y)
      ? { x: savedState.x, y: savedState.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: branding.productName,
    // 窗口 / 任务栏图标，与界面内 logo (icon.svg) 同一品牌图
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    // Same color as the React app's body (index.css --bg0) — prevents a
    // black flash before the renderer paints.
    backgroundColor: '#f0f4fa',
    // 隐藏原生标题栏（包含左上角的应用图标）；保留 min/max/close 控件作为 overlay
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f5f8fe',       // 跟顶部条 / 灰色边框 var(--bg2) 一致
      symbolColor: '#3d5a80', // 跟字色 var(--t2) 一致
      height: 36,             // 跟顶部条高度对齐
    },
    // 隐藏 File/Edit/View/Window/Help 原生菜单栏
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Keep rAF/timers running when the window is occluded/minimized. On first
      // launch after install the NSIS finish window often sits on top while the
      // (slow first-run) backend is still starting, so the real UI loads while
      // our window is occluded. With background throttling on, the renderer's
      // requestAnimationFrame is suspended → 'renderer-ready' never fires → the
      // white-screen watchdog falsely reports "界面已打开但未能正常显示".
      backgroundThrottling: false,
      // 应用内浏览器（工作区「网页」tab）用 <webview> 嵌入外部页面 / MCP 自起的 URL。
      // 外部站点常发 X-Frame-Options 拒绝 iframe，webview 顶层加载不受此限；且活在 DOM
      // 里，跟随可拖拽面板自然 resize。安全隔离见下方 will-attach-webview / did-attach-webview。
      webviewTag: true,
    },
  });

  // An active hidden search page must not keep the app alive after the user
  // closes the main window.
  mainWindow.on('close', () => {
    saveWindowState(mainWindow);   // 记住大小/位置/最大化，供下次启动恢复
    if (chromiumSearchBridge) chromiumSearchBridge.closeNow();
  });

  // 用户把窗口切到前台 = 已经看见了，停止任务栏闪烁与托盘闪动。Windows 在窗口进入
  // 前台时本就会停闪，这里显式清一次是为了不依赖平台的隐含行为（也覆盖 Linux）。
  mainWindow.on('focus', () => {
    try { mainWindow.flashFrame(false); } catch (_) {}
    stopTrayAlert();
  });

  // 最小化保持系统原生行为：窗口仍留在任务栏，不隐藏、不摘任务栏按钮。
  // 托盘是「额外」的快捷入口与闪动提示载体，不接管最小化——早先试过
  // preventDefault+hide 与 setSkipTaskbar 两种「收进托盘」，前者会让窗口同时处于
  // 已最小化+已隐藏的双重状态（minimize 根本不是可取消事件），后者则让用户在任务栏
  // 找不到窗口。两者都不值得，故这里对 minimize 不做任何干预。

  // <webview> 安全闸门：任何 webview 挂载前强制剥离 preload、关 node、独立 partition，
  // 绝不让被嵌入的外部页面拿到 electronAPI 或 node 能力。webview 是独立 webContents，
  // 不受主窗口 will-navigate/setWindowOpenHandler 那套硬拦影响——它内部要能自由导航。
  mainWindow.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!params.partition) params.partition = 'persist:inappbrowser';
  });
  // webview 内部的 window.open / target=_blank → 交系统浏览器，不在应用内新开顶层窗口。
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    // 有些企业站点检测到 UA 里的 "Electron"/应用标识会走异常分支导致自身 JS 崩溃（白屏）。
    // 抹掉 Electron 与应用名，只保留标准 Chrome UA（Chromium 版本保持真实），让站点当普通 Chrome。
    try {
      // 应用名取 app.getName()（Electron 拼 UA 时用的就是它），故跟着品牌自动走。
      const cleaned = guest.getUserAgent()
        .replace(/ Electron\/[^ ]+/i, '')
        .replace(new RegExp(` ${escapeRegExp(app.getName())}\\/[^ ]+`, 'i'), '');
      guest.setUserAgent(cleaned);
    } catch { /* 忽略 */ }
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  // 移除应用菜单，连 Alt 键唤起也禁掉
  mainWindow.setMenuBarVisibility(false);

  // Re-register DevTools shortcuts manually — Menu.setApplicationMenu(null) below
  // wipes the default accelerators (F12 / Ctrl+Shift+I), making in-prod debugging
  // impossible without --remote-debugging-port=9222.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isCtrlShiftI) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Renderer-failure safety net. Without these, a renderer that can't load (e.g.
  // a JS module rejected for a bad Content-Type, or a crashed render process)
  // leaves the splash/blank page up with NO message — the "white screen" report.
  // Log it and surface a dialog with the log path instead of failing silently.
  const logPathFor = () => path.join(getAppDataDir(), 'logs', 'electron.log');
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED: fired normally when a pending load is superseded
    // (e.g. splash -> BACKEND_URL). Only the main frame matters for white-screen.
    if (!isMainFrame || errorCode === -3) return;
    const safeFailedUrl = safeUrlForLog(validatedURL);
    elog(`[did-fail-load] ${errorCode} ${errorDescription} url=${safeFailedUrl}`);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // The load is dead, so the renderer will never signal ready — leaving the
    // watchdog armed just stacks a second, misleading box on top of this one.
    disarmRendererWatchdog();
    uiLoadFailed = true;
    if (shouldRetryLoad(errorCode, uiLoadAttempt)) {
      scheduleUiLoadRetry(errorDescription || String(errorCode));
      return;
    }
    const logPath = logPathFor();
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: `${branding.productName} — 界面加载失败`,
      message: `界面加载失败（${errorDescription || errorCode}）`,
      detail: `无法加载 ${safeFailedUrl}\n\n完整日志：${logPath}`,
      buttons: ['重试', '打开日志', '关闭'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) loadMainUI();
      else if (response === 1) shell.openPath(logPath);
    });
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    elog(`[render-process-gone] reason=${details && details.reason} exitCode=${details && details.exitCode}`);
    if (details && details.reason === 'clean-exit') return;
    if (telemetry) {
      telemetry.report('renderer_crash', {
        reason: details && details.reason,
        exit_code: details && details.exitCode,
      }).catch(() => {});
    }
    uploadCrashLogs();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const logPath = logPathFor();
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: `${branding.productName} — 界面进程异常`,
      message: `界面渲染进程已退出（${(details && details.reason) || 'unknown'}）`,
      detail: `完整日志：${logPath}`,
      buttons: ['打开日志', '关闭'],
      defaultId: 0,
    }).then(({ response }) => { if (response === 0) shell.openPath(logPath); });
  });

  mainWindow.loadURL(loadingHtml());
  // 上次最大化 → 恢复最大化；首次启动（无记录）→ 默认最大化（cowork 全屏协作定位）；
  // 上次是小窗 → 保持已按 savedState 设好的大小/位置，不最大化。
  if (!savedState || savedState.maximized) {
    mainWindow.maximize();   // maximize 本身会让窗口可见，下面的 show 是幂等兜底
  }
  mainWindow.show();

  if (IS_DEV) {
    elog(`Dev mode: loading Vite dev server at ${DEV_VITE_URL}`);
    mainWindow.loadURL(DEV_VITE_URL);
    mainWindow.webContents.openDevTools();
    mainWindow.on('closed', () => { mainWindow = null; });
    return;
  }

  try {
    await waitForBackend();
    elog('Backend ready, loading UI');
    if (telemetry && backendStartedAt) {
      telemetry.report('backend_start_duration', {
        duration_ms: Date.now() - backendStartedAt,
      }).catch(() => {});
    }
    loadMainUI();
  } catch (err) {
    elog(`waitForBackend failed: ${err.message}`);
    const logPath = path.join(getAppDataDir(), 'logs', 'electron.log');
    const lastLines = stderrLines.slice(-20).join('\n');
    const detail = lastLines
      ? `最近输出：\n${lastLines}\n\n完整日志：${logPath}`
      : `完整日志：${logPath}`;
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: `${branding.productName} — 启动失败`,
      message: err.message,
      detail,
      buttons: ['打开日志文件', '退出'],
      defaultId: 0,
    });
    if (response === 0) shell.openPath(logPath);
    app.quit();
    return;
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Hard guard against the main frame ever being navigated away from the SPA.
  // The React app routes via pushState and the real UI is (re)loaded with
  // loadURL/reload — none of which emit 'will-navigate'. So every will-navigate
  // here is a stray full-document navigation: a bare <a href="other.md"> in
  // rendered markdown (resolves to our own origin → backend 404 → SPA replaced
  // by {"detail":"not found"} with no menu bar / back button → app looks frozen,
  // user must kill it), a location.href=, or an un-targeted external link.
  // Block them all; send real external http(s) to the OS browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    try {
      const target = new URL(url);
      const base = new URL(BACKEND_URL);
      if (target.origin !== base.origin && (target.protocol === 'http:' || target.protocol === 'https:')) {
        shell.openExternal(url);
      }
    } catch { /* malformed URL — already prevented, nothing to open */ }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  autoUpdaterRef = initUpdater({
    config: updateConfig,
    isPackaged: USES_PACKAGED_LAYOUT,
    nativeIsPackaged: app.isPackaged,
    updateConfigPath: path.join(process.resourcesPath, 'app-update.yml'),
    logger: elog,
    onEvent: (payload) => {
      if (telemetry) {
        if (payload.status === 'available') telemetry.report('update_available', { target_version: payload.version }).catch(() => {});
        if (payload.status === 'downloaded') telemetry.report('update_download_completed', { target_version: payload.version }).catch(() => {});
        if (payload.status === 'error') telemetry.report('update_check_failed', { error: payload.message }).catch(() => {});
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', payload);
    },
  });
  if (autoUpdaterRef && shouldCheckForUpdates(updateConfig)) {
    autoUpdaterRef.checkForUpdates().catch((e) => elog('checkForUpdates failed: ' + e.message));
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

/**
 * 这个端口上已经有**我自己的**后端在跑吗。
 *
 * ⚠ **只看 HTTP 200 是不够的**：端口上可能是同族的另一个品牌（它的后端同样把前端 dist
 * 挂在 /），复用之后界面、数据整条都是对方的，而且一声不吭。所以要比对 app_id。
 * 拿不到 app_id（老版本、或压根不是我们的服务）一律当成"不是我的"——宁可起不来让人看见，
 * 也不能把别人的应用当成自己的打开。
 */
function isBackendAlreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_URL}/health`, { timeout: 800 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app_id === branding.appId);
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

ipcMain.handle('open-path', async (_, p) => {
  await shell.openPath(p);
});

// 用系统默认浏览器打开一个 http(s) URL（应用内浏览器的「外部打开」按钮）。
// 只放行 http/https，挡掉 file:// / 自定义协议等，避免被诱导执行本地程序。
ipcMain.handle('open-external', async (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
});

// Renderer mounted successfully — cancel the white-screen watchdog.
ipcMain.on('renderer-ready', () => {
  // 渲染层刚就绪：把它没赶上的那次阵容变更补上。
  if (coworksChangedPending) {
    coworksChangedPending = false;
    try { mainWindow?.webContents.send('coworks-changed'); } catch (_) {}
  }
  rendererReady = true;
  if (rendererWatchdog) { clearTimeout(rendererWatchdog); rendererWatchdog = null; }
  elog('Renderer signalled ready');
});

// Convert EMF/WMF (Windows vector metafiles, which Chromium cannot render in
// <img>) to PNG using the OS's built-in GDI+ via PowerShell System.Drawing.
// Input:  items = [{ key, b64 }]  (b64 = raw EMF/WMF bytes, base64)
// Output: [{ key, png }]          (png = base64 PNG, or null on failure)
// All items are converted in ONE PowerShell invocation to amortise its ~300ms
// startup. Renderer batches a whole deck's metafiles into a single call.
ipcMain.handle('convert-emf', async (_e, items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const tmpDir = path.join(app.getPath('temp'), 'ipm-emf-' + crypto.randomBytes(6).toString('hex'));
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const jobs = items.map((it, i) => {
      const inPath = path.join(tmpDir, `in${i}.emf`);
      const outPath = path.join(tmpDir, `out${i}.png`);
      try { fs.writeFileSync(inPath, Buffer.from(String(it.b64 || ''), 'base64')); } catch { /* skip */ }
      return { key: it.key, inPath, outPath };
    });
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(jobs.map((j) => ({ inPath: j.inPath, outPath: j.outPath }))), 'utf8');
    // Render each metafile at 2x onto a white background (PPT composites these
    // on the slide, usually white). Per-item try/catch so one bad file doesn't
    // abort the batch.
    const ps = [
      'Add-Type -AssemblyName System.Drawing',
      '$jobs = Get-Content -LiteralPath $env:IPM_EMF_MANIFEST -Raw | ConvertFrom-Json',
      'foreach ($j in $jobs) {',
      '  try {',
      '    $img = [System.Drawing.Image]::FromFile($j.inPath)',
      '    $w = [int]($img.Width * 2); $h = [int]($img.Height * 2)',
      '    if ($w -lt 1) { $w = 1 }; if ($h -lt 1) { $h = 1 }',
      // Clamp the LONGER side to 4000px and scale both by the same factor so
      // the aspect ratio is preserved (clamping w/h independently would squash
      // metafiles that are large in only one dimension).
      '    $mx = [Math]::Max($w, $h)',
      '    if ($mx -gt 4000) { $f = 4000.0 / $mx; $w = [int]($w * $f); $h = [int]($h * $f); if ($w -lt 1) { $w = 1 }; if ($h -lt 1) { $h = 1 } }',
      '    $bmp = New-Object System.Drawing.Bitmap($w, $h)',
      '    $g = [System.Drawing.Graphics]::FromImage($bmp)',
      '    $g.Clear([System.Drawing.Color]::White)',
      '    $g.DrawImage($img, 0, 0, $w, $h)',
      '    $bmp.Save($j.outPath, [System.Drawing.Imaging.ImageFormat]::Png)',
      '    $g.Dispose(); $bmp.Dispose(); $img.Dispose()',
      '  } catch {}',
      '}',
    ].join('\n');
    const scriptPath = path.join(tmpDir, 'convert.ps1');
    fs.writeFileSync(scriptPath, ps, 'utf8');
    await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        env: { ...process.env, IPM_EMF_MANIFEST: manifestPath },
      });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(); }, 30000);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
      child.on('error', () => { clearTimeout(timer); resolve(); });
    });
    return jobs.map((j) => {
      try { return { key: j.key, png: fs.readFileSync(j.outPath).toString('base64') }; }
      catch { return { key: j.key, png: null }; }
    });
  } catch (e) {
    elog('convert-emf error: ' + (e && e.message));
    return items.map((it) => ({ key: it.key, png: null }));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

ipcMain.handle('app-version', () => app.getVersion());

// ── 桌面端浏览器登录（OAuth）────────────────────────────────────────────────
function getCloudBaseUrl() {
  return authFlow.resolveCloudBaseUrl({
    appConfig: readAppConfigFile(),         // app-config.json 是唯一来源（netcoworkBaseUrl）
  });
}

async function beginTokenUsageAuthTransition() {
  if (tokenUsageController) await tokenUsageController.beginAuthTransition();
}

function endTokenUsageAuthTransition({ drain = false } = {}) {
  if (tokenUsageController) tokenUsageController.endAuthTransition({ drain });
}

ipcMain.handle('auth-login', () => {
  // LoginGate disables its button, but keeping a single shared promise also
  // protects against a second renderer invocation while the browser is open.
  if (authLoginInFlight) return authLoginInFlight;
  const run = (async () => {
    const appConfig = readAppConfigFile();
    const useW3 = appConfig?.authMode === 'w3';
    const url = getCloudBaseUrl();
    const pythonBackendUrl = BACKEND_URL;  // 统一使用本地后端地址 (http://127.0.0.1:PORT)
    const devSkipAuth = authFlow.computeDevSkipAuth({
      isPackaged: USES_PACKAGED_LAYOUT,
      appConfig: readBundledAppConfig(),
    });
    elog(`auth-login: 开始登录，authMode=${useW3 ? 'w3' : 'oauth'}, ` +
         `isPackaged=${USES_PACKAGED_LAYOUT}, electronIsPackaged=${app.isPackaged}, ` +
         `cloudBaseUrl=${url || '(未配置)'}, ` +
         `pythonBackendUrl=${pythonBackendUrl}`);
    pendingLoginError = null;
    const wasReady = tokenUsageAuthReady;
    // 登录模式不影响 token-usage 状态机：W3 与 OAuth 走同一套 transition/ready/prune。
    await beginTokenUsageAuthTransition();
    tokenUsageAuthReady = false;
    let succeeded = false;
    try {
      const user = await authFlow.startLogin({
        cloudBaseUrl: url,
        appDataDir: getAppDataDir(),
        useW3,
        w3Config: useW3 ? {
          baseUrl: appConfig?.w3BaseUrl,
          clientId: appConfig?.w3ClientId,
          callbackUrl: appConfig?.w3CallbackUrl,
          scope: appConfig?.w3Scope,
          parentWindow: mainWindow,
          createLoginView: ({ parentWindow, session: sharedSession }) => createW3LoginView({
            WebContentsView,
            parentWindow,
            session: sharedSession,
          }),
        } : undefined,
        pythonBackendUrl,
        devSkipAuth,
        logFn: useW3 ? (message) => elog(`[w3-auth] ${message}`) : undefined,
      });
      tokenUsageAuthReady = true;
      // Remove old-user / old-epoch retry records immediately.  If the atomic
      // write fails, normal drains remain fail-closed and will never POST them.
      const prepared = tokenUsageController
        ? tokenUsageController.pruneRetryForCurrentContext()
        : { discarded: 0 };
      if (prepared.discarded) elog(`auth-login: discarded ${prepared.discarded} pre-login token-usage retry record(s)`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
      elog(`auth-login: 登录成功，user=${(user && user.username) || '(无用户名)'}`);
      // **登录之后必须再对一次账。** 启动那次多半是没令牌的（应用刚开，用户还没登），
      // 而下一次自动对账在 24 小时后——不补这一下，用户登录完看到的就是一个空阵容，
      // 且他没有任何办法让它变出来。
      void syncCoworkPackagesOnce({ applyNow: true });
      succeeded = true;
      return user;
    } catch (e) {
      // 内嵌登录视图不会卸载主渲染层，错误会直接通过当前 IPC 返回；同时暂存一份，
      // 兼容认证期间渲染层发生意外重载的极端情况。
      if (e && e.name === 'NotInWhitelistError') {
        elog(`auth-login: 用户不在白名单中 — ${e.message}`);
        pendingLoginError = e.message;
        return { __notInWhitelist: true, message: e.message };
      }
      elog(`auth-login: 登录失败 — ${(e && e.message) || e}`);
      pendingLoginError = (e && e.message) || '认证失败';
      throw e;
    } finally {
      // If a re-login attempt failed while an older session is still valid,
      // resume that epoch instead of leaving its retry queue idle until timer.
      // getTokenUsageContext covers both OAuth (JWT) and W3 (uid epoch) sessions.
      if (!succeeded) tokenUsageAuthReady = wasReady && !!authFlow.getTokenUsageContext(getAppDataDir());
      endTokenUsageAuthTransition({ drain: tokenUsageAuthReady });
    }
  })();
  authLoginInFlight = run;
  const clear = () => { if (authLoginInFlight === run) authLoginInFlight = null; };
  run.then(clear, clear);
  return run;
});

ipcMain.handle('auth-session', () => {
  if (authSessionInFlight) return authSessionInFlight;
  const run = (async () => {
    const appConfig = readAppConfigFile();
    const useW3 = appConfig?.authMode === 'w3';
    const pythonBackendUrl = BACKEND_URL;
    // devSkipAuth 是 dev-source 开关：必须读「随包/仓库内」配置（dev 态 = electron/app-config.json），
    // 不能读 AppData 用户副本——reconcileAppConfig 是 {...factory,...user}，出厂的 false 一旦 seed 进
    // 用户副本就会反向 shadow 掉开发者对 electron/app-config.json 的 true 改动，导致旁路永不生效。
    const devSkipAuth = authFlow.computeDevSkipAuth({
      isPackaged: USES_PACKAGED_LAYOUT,
      appConfig: readBundledAppConfig(),
    });
    if (devSkipAuth) elog('⚠ AUTH SKIPPED (devSkipAuth) — dev only');

    // 登录模式不影响 token-usage 状态机：W3 与 OAuth 走同一套 transition。
    // transition 自带 in-flight 合并（beginAuthTransition 等 inFlight + trailing），
    // 与 auth-login 并发触发也安全。
    await beginTokenUsageAuthTransition();
    tokenUsageAuthReady = false;
    try {
      const user = await authFlow.getSession({
        cloudBaseUrl: getCloudBaseUrl(),
        appDataDir: getAppDataDir(),
        devSkipAuth,
        // 启动时 /me 吊销校验失败会静默回退本地放行；把失败原因(含证书/连接 cause)记到
        // electron.log，便于排查"证书不被信任"这类问题，而不影响用户继续使用。
        logFn: (m) => elog(`auth-session: ${m}`),
        useW3,
        pythonBackendUrl,
      });
      // getTokenUsageContext 覆盖 OAuth（JWT）与 W3（uid epoch）两种会话：
      // 有上下文即可启用 token-usage 上报，登录模式不再影响该功能。
      if (!devSkipAuth && user && authFlow.getTokenUsageContext(getAppDataDir())) {
        // For a legacy auth.bin this atomically writes the upgrade boundary
        // before startup/SSE/timer are allowed to touch the old local queues.
        tokenUsageAuthReady = true;
        const prepared = tokenUsageController
          ? tokenUsageController.pruneRetryForCurrentContext()
          : { discarded: 0 };
        if (prepared.discarded) elog(`auth-session: discarded ${prepared.discarded} pre-login token-usage retry record(s)`);
      }
      return user;
    } finally {
      endTokenUsageAuthTransition({ drain: tokenUsageAuthReady });
    }
  })();
  authSessionInFlight = run;
  const clear = () => { if (authSessionInFlight === run) authSessionInFlight = null; };
  run.then(clear, clear);
  return run;
});

// 兼容认证期间渲染层意外重载时拉取 W3 登录错误；正常流程直接使用 auth-login 返回值。
ipcMain.handle('auth-login-error', () => {
  const err = pendingLoginError;
  pendingLoginError = null;
  return err;
});

ipcMain.handle('auth-logout', async () => {
  const appConfig = readAppConfigFile();
  const useW3 = appConfig?.authMode === 'w3';
  const wasReady = tokenUsageAuthReady;
  if (!useW3) await beginTokenUsageAuthTransition();
  tokenUsageAuthReady = false;
  let credentialCleared = false;
  try {
    authFlow.clearSession(getAppDataDir());
    credentialCleared = true;
    if (tokenUsageController) tokenUsageController.clearRetry();
    else saveTokenUsageRetryQueue([]);
  } finally {
    // If Windows refused both unlink and overwrite, the renderer keeps showing
    // the authenticated user. Restore that still-valid epoch instead of silently
    // disabling all subsequent usage reporting; clearSession's error still
    // propagates so the user can retry logout.
    if (!credentialCleared) {
      tokenUsageAuthReady = wasReady && !!authFlow.getToken(getAppDataDir());
    }
    if (!useW3) endTokenUsageAuthTransition({ drain: tokenUsageAuthReady });
  }
});

// 取当前 access token（渲染层把它带给 Python，再转发给 cowork → 上传 skill 时写 creator）。
ipcMain.handle('auth-token', () => authFlow.getToken(getAppDataDir()));

// ── 托盘（最小化驻留 + 有待办时闪动）──────────────────────────────────────────
// Electron 的 Tray 没有"闪烁"API，Windows 上的做法是定时在「正常图标」与「空图标」
// 之间来回 setImage——这是 Windows 托盘闪动的通行实现。
function trayIconImage() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  try {
    tray = new Tray(trayIconImage());
    tray.setToolTip(branding.productName);
    // 不放 separator：只有两项，分隔线会把菜单撑出明显的空隙，视觉上不紧凑。
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '退出', click: () => app.quit() },
    ]));
    // 单击托盘 = 呼出窗口（Windows 上的通行习惯）
    tray.on('click', () => showMainWindow());
    return tray;
  } catch (e) {
    elog(`createTray failed: ${(e && e.message) || e}`);
    tray = null;
    return null;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // 最小化流程已不做任何干预，这里只需解最小化再聚焦。isVisible 判断留作兜底：
    // 窗口理论上不会被 hide，但真被 hide 过时只 restore 是唤不出来的。
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  } catch (e) {
    elog(`showMainWindow failed: ${(e && e.message) || e}`);
  }
}

function startTrayAlert() {
  if (!tray || tray.isDestroyed() || trayBlinkTimer) return;
  let on = true;
  const empty = nativeImage.createEmpty();
  const icon = trayIconImage();
  trayBlinkTimer = setInterval(() => {
    if (!tray || tray.isDestroyed()) return stopTrayAlert();
    try { tray.setImage(on ? empty : icon); } catch (_) {}
    on = !on;
  }, 600);
}

function stopTrayAlert() {
  if (trayBlinkTimer) { clearInterval(trayBlinkTimer); trayBlinkTimer = null; }
  if (tray && !tray.isDestroyed()) {
    try { tray.setImage(trayIconImage()); } catch (_) {}   // 复位成正常图标
  }
}

// ── 桌面通知（HITL 待应答 / 任务结束）──────────────────────────────────────────
// 触发判定全在渲染层（它已经在 3s 轮询会话列表，见 useSessionNotifications），
// 这里只负责"怎么提示"：系统 toast + 任务栏闪烁 + 托盘闪动。
//
// 三者并存不是冗余：Windows 的专注助手/勿扰、或用户在系统设置里关掉本应用通知时，
// toast 会被静默吞掉且不报错；任务栏闪烁与托盘闪动都不受通知策略管辖，是可靠兜底。
ipcMain.handle('notify', (_e, payload) => {
  const { title, body, sessionId, flash = true, force = false } = payload || {};
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // 窗口已在眼前就别打扰——除非 force（启动盘点：窗口刚打开必然聚焦，不放行就永远弹不出来）
  if (!force && mainWindow.isFocused()) return false;

  if (flash) {
    try { mainWindow.flashFrame(true); } catch (_) {}
    // 任务栏闪烁在窗口被其它窗口完全遮挡时不够显眼，托盘闪动是并行的第二个可见提示
    if (tray && !tray.isDestroyed()) startTrayAlert();
  }
  if (!Notification.isSupported()) return false;

  try {
    const n = new Notification({ title: String(title || ''), body: String(body || '') });
    n.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      showMainWindow();                       // 含最小化态的还原
      try { mainWindow.flashFrame(false); } catch (_) {}
      stopTrayAlert();
      // sessionId 可能已被删除，渲染层需自行兜底（找不到就只激活窗口，不跳转）
      if (sessionId) mainWindow.webContents.send('notification-click', { sessionId });
    });
    n.show();
    return true;
  } catch (e) {
    elog(`notify failed: ${(e && e.message) || e}`);
    return false;
  }
});

// 待处理数量 → 托盘悬停提示。0 时顺带停闪（已无待办可提醒）。
ipcMain.handle('set-pending', (_e, { count = 0 } = {}) => {
  const n = Number(count) || 0;
  if (tray && !tray.isDestroyed()) {
    try {
      tray.setToolTip(n > 0 ? `${branding.productName} — ${n} 个待处理` : branding.productName);
    } catch (_) {}
  }
  if (n === 0) stopTrayAlert();
  return true;
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('update-check', async () => {
  if (autoUpdaterRef) { try { await autoUpdaterRef.checkForUpdates(); } catch (e) { elog('manual check failed: ' + e.message); } }
});

ipcMain.handle('update-install', async () => {
  if (!autoUpdaterRef) return;   // updater inactive (dev mode or no feed configured)
  // stopBackend() kills the tracked backend by PID, releasing the exe lock so
  // NSIS can overwrite during install.
  //
  // Do NOT taskkill /IM <backendName>.exe here: image-name matching is
  // case-insensitive on Windows, and the backend exe name typically differs from the
  // Electron app exe (productName) only by case/punctuation — so /IM would kill THIS app
  // before quitAndInstall runs, aborting the update. (Orphan backends reused
  // from a prior session are a separate, rarer case to handle by port/PID.)
  await stopBackend();
  await stopChromiumSearchBridge();
  // isSilent=false → 显示 NSIS 安装界面（有可见进度，用户能看到在装什么），而非后台静默安装；
  //   安装类型页/选目录页在更新时由 electron-builder 自动跳过（见 build/installer.nsh + 内建 skipPageIfUpdated）。
  // isForceRunAfter=true → 装完自动重启新版本。
  autoUpdaterRef.quitAndInstall(false, true);
});

// User-initiated "report this session": fetch the per-session SQLite export from
// the local backend, wrap it with a client environment block + FULL run logs
// (electron.log + backend.log + every dated rotation, 20MB cap), zip it, and
// upload to /logs (reason=session_report). Returns {ok, error?} — never throws
// (the renderer shows the status). This is the ONLY path that uploads
// conversation content, and only on the user's explicit click (spec §2).
ipcMain.handle('report-session', async (_e, sessionId, note) => {
  try {
    if (!shouldReportTelemetry(updateConfig)) {
      elog(`report-session: skipped for ${sessionId} — telemetry disabled (telemetryUrl 未配置)`);
      return { ok: false, error: 'telemetry disabled' };
    }
    const res = await fetch(`${BACKEND_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/export`);
    if (!res.ok) {
      elog(`report-session: export failed for ${sessionId} -> HTTP ${res.status}`);
      return { ok: false, error: `export failed (${res.status})` };
    }
    const sqliteBuf = Buffer.from(await res.arrayBuffer());
    const env = {
      app_version: app.getVersion(),
      hostname: osMod.hostname(),
      os_username: (() => { try { return osMod.userInfo().username; } catch (_) { return ''; } })(),
      platform: process.platform,
      arch: process.arch,
    };
    // 收集日志 + 走 skills/agents 目录 + deflate 全在工作线程里做，主进程不卡。
    const zip = await buildSessionReportZipAsync({
      sessionId,
      env,
      sqliteBuf,
      appDataDir: getAppDataDir(),
      skillsDir: getUserSkillsDir(),
      agentsDir: getUserAgentsDir(),
    }, { logFn: (m) => elog(`report-session: ${m}`) });
    const ok = await uploadLogs({
      endpoint: updateConfig.telemetryUrl,
      fetchImpl: httpFetch,   // 内网 https 走系统证书库
      fields: clientFields('session_report', { session_id: sessionId, user_note: note || '' }),
      archive: { name: 'session-report.zip', data: zip },
      logFn: (m) => elog(`report-session: upload failed for ${sessionId} — ${m}`),
    });
    if (ok) elog(`report-session: uploaded ${sessionId} (${zip.length} bytes)`);
    return ok ? { ok: true } : { ok: false, error: 'upload failed' };
  } catch (e) {
    elog(`report-session: error for ${sessionId}: ${(e && e.message) || e}`);
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ── 目录迁移（**必须在 ready 之前**）──────────────────────────────────────────
//
// userData 不再用 setPath 搬：npmName 与 appDataDir 现在只差大小写，
// 而 Windows 路径大小写不敏感 —— Electron 的默认 userData 与业务数据目录本来就是
// 同一个。少一层机关，也就少一个失败模式。
migrateLegacyAppData();
migrateChromiumUserData();

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  // Windows 任务栏图标分组标识：必须与打包写进开始菜单快捷方式的 appId 逐字一致，否则任务栏
  // 图标分组失效、通知中心也认不出发信应用（toast 不显示或显示成 electron.app.Electron）。
  // 两边同源于 branding.json（构建期注入 package.json 的 build.appId）。
  if (process.platform === 'win32') {
    app.setAppUserModelId(branding.appId);
  }

  // 全局移除应用菜单（File/Edit/View/Window/Help）
  Menu.setApplicationMenu(null);

  // Rebrand: carry over data from the legacy NetLIVE-CoWork AppData dir.
  // Must run before openElectronLog (which would create the new dir).
  // migrateLegacyAppData() 已在 ready 之前跑过（userData 重定向依赖它先完成）。
  openElectronLog();
  elog(`Electron version: ${process.versions.electron}`);
  // 路径问题最费劲的就是"以为在这儿、其实在那儿"，直接打出来省得再猜一轮。
  elog(`AppData dir:      ${getAppDataDir()}`);
  elog(`userData dir:     ${app.getPath('userData')}`);
  elog(`Cowork staging:   ${getCoworkStagingDir()}`);
  elog(`Cowork installed: ${getCoworksDir()}`);
  elog(`App path: ${app.getAppPath()}`);
  elog(`Resources: ${process.resourcesPath}`);
  // 升级判定必须在 applyVersionAwareSeed() 之前取——后者会把 installed-version 标记覆盖成当前版本。
  const agentsUpgraded = readInstalledVersion() !== app.getVersion();
  seedDefaultData();
  applyVersionAwareSeed();
  removeRetiredBuiltinSkills();   // 内置 skill 已改云端引用，本地副本一律删（不比签名）
  seedBundledResource('skills', { overwrite: true, detectLocalEdits: true });
  // 升级：强制 agents 只留 default data 里的（删用户自建、覆盖内置）；同版本：保留用户改动。
  seedBundledResource('agents', agentsUpgraded
    ? { overwrite: true, mirror: true }
    : { overwrite: true, detectLocalEdits: true });
  seedBundledMcpConfig();
  seedAndReconcileAppConfig();   // 落 AppData/app-config.json，URL 强制刷新、channel 保留

  updateConfig = resolveUpdateConfig(readAppConfigFile());   // app-config.json 是唯一来源
  if (shouldReportTelemetry(updateConfig)) {
    telemetry = createReporter({
      endpoint: updateConfig.telemetryUrl,
      fetchImpl: httpFetch,   // 内网 https 走系统证书库
      context: {
        installId: getOrCreateInstallId(), appVersion: app.getVersion(),
        channel: updateConfig.channel, os: process.platform, arch: process.arch,
        hostname: osMod.hostname(),
        osUsername: (() => { try { return osMod.userInfo().username; } catch (_) { return ''; } })(),
        now: () => new Date().toISOString(),  // server expects ts as ISO date-time string
      },
      loadQueue: loadTelemetryQueue, saveQueue: saveTelemetryQueue,
    });
    telemetry.report('app_launch').catch(() => {});
  }

  // Drain backend-emitted observability events (spec §5). The backend only appends
  // to the spool; we own the network path. Each spool event carries its own backend
  // ts, which buildEvent lets win over ctx.now(). Spool dir = NLC_DATA_DIR = AppData\...\data.
  function drainSpoolIntoTelemetry() {
    if (!telemetry) return;
    const spoolPath = path.join(getAppDataDir(), 'data', 'telemetry-spool.jsonl');
    for (const ev of drainSpool({ spoolPath })) {
      const { event_type, ...extra } = ev;
      if (!event_type) continue;
      telemetry.report(event_type, extra).catch(() => {});
    }
  }
  drainSpoolIntoTelemetry();
  setInterval(drainSpoolIntoTelemetry, 30_000);

  // Drain backend-emitted token-usage spool → forward to netcowork for cloud-side
  // accounting (netcowork doc: 用户 Token 用量统计). Claims from the backend over HTTP
  // (GET /internal/token-usage-spool/claim, then DELETE ack after durable local save)
  // instead of reading the spool file off disk
  // ourselves: the backend resolves its own data_dir() (NLC_DATA_DIR, defaulting
  // elsewhere when unset), which doesn't always match the %APPDATA%\...\data path we'd
  // otherwise guess — e.g. when a dev runs the backend from source instead of us
  // spawning the packaged exe with NLC_DATA_DIR set. Asking the backend to drain its
  // own file removes that path-matching assumption entirely. This still goes to
  // netcowork with the user's JWT attached, which only Electron holds (see
  // netcowork/doc/DESKTOP_BROWSER_AUTH_DESIGN.md) — the Python backend never sees the
  // token. If the user isn't logged in to netcowork we skip the backend call too. Once
  // a login epoch exists, only records whose own ts is at/after that login boundary are
  // eligible only when its timestamp is strictly after that boundary; pre-login
  // stock is drained locally but deliberately never sent.
  //
  // 每条上报现在是「一次 LLM 调用」的独立记录，不再是 session 累计值（见
  // token_usage_subscriber.py 的改动），所以不能再靠"下一次带更新的累计总量"去自愈失败的
  // 上报——用一个持久化到磁盘的重试队列，失败的记录留到下一轮跟新数据一起重试，不丢。
  const TOKEN_USAGE_RETRY_MAX = 500; // 云端长时间不可达时的上限，防止重试队列无限增长

  async function postTokenUsageEvent(event, token, cloudBase, signal) {
    const res = await httpFetch(`${cloudBase}/api/token-usage/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      signal,
      body: JSON.stringify(buildTokenUsagePayload(event)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`token-usage report failed: HTTP ${res.status}`);
    }
  }

  // 解出 JWT 的 exp（HS256，payload 是第二段 base64url），判断是否临近到期。
  // 解不出（格式怪 / 无 exp）一律当作"该换"——宁可多换一次，也别让它悄悄过期。
  // 用户令牌 7 天，阈值取 1 天：临近到期就提前换，续期窗口足够宽。
  function w3JwtExpiringSoon(token, thresholdSec = 24 * 3600) {
    try {
      const payload = String(token || '').split('.')[1];
      if (!payload) return true;
      const json = Buffer.from(
        payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
      ).toString('utf8');
      const exp = JSON.parse(json).exp;
      if (typeof exp !== 'number') return true;
      return (exp * 1000 - Date.now()) < thresholdSec * 1000;
    } catch { return true; }
  }

  // W3 用户令牌的发放/续期收到 substrate 后，主进程主动驱动续期（方案 §4.2）：
  // 每轮 token-usage drain 调一次，用存的 uid 打 Python 后端 /w3/refresh-token
  // （后端已按 CLOUD_JWT_MIGRATION 指向 substrate），拿字节兼容的新 JWT 写回 auth.bin。
  // 触发条件：无 JWT（补取）或 JWT 剩不足 1 天（主动续）。用户令牌 7 天，drain 是
  // 小时级节奏，续期窗口绰绰有余。不阻塞当前 drain：换到后下一轮正常上报。
  let w3RefreshInFlight = null;
  async function ensureW3JwtIfNeeded() {
    if (w3RefreshInFlight) return w3RefreshInFlight;
    const s = authFlow.loadSession(getAppDataDir());
    if (!s || !s.uid || s.w3 !== true) return;
    if (s.access_token && !w3JwtExpiringSoon(s.access_token)) return;
    const renewing = !!s.access_token;   // 有旧令牌 = 续期；没有 = 补取
    w3RefreshInFlight = (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/w3/refresh-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: s.uid }),
        });
        if (r.ok) {
          const data = await r.json();
          if (data && data.access_token) {
            s.access_token = data.access_token;
            authFlow.saveSession(getAppDataDir(), s);
            elog(`W3 ${renewing ? '主动续期' : '运行时补取'} JWT 成功 (len=${s.access_token.length})`);
          }
        }
      } catch (e) {
        elog(`W3 ${renewing ? '主动续期' : '运行时补取'} JWT 失败 — ${(e && e.message) || e}`);
      } finally {
        w3RefreshInFlight = null;
      }
    })();
    return w3RefreshInFlight;
  }

  tokenUsageController = createTokenUsageController({
    getContext: () => {
      if (!tokenUsageAuthReady) return null;
      const ctx = authFlow.getTokenUsageContext(getAppDataDir());
      // 每轮都查一次：缺 JWT 则补取、临近到期则主动续（见 ensureW3JwtIfNeeded）。
      // 内部有 in-flight 去重与"离到期还早就直接返回"的短路，调用开销可忽略。
      ensureW3JwtIfNeeded();
      return ctx;
    },
    getCloudBaseUrl,
    drainLocal: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const claim = await fetch(`${BACKEND_URL}/internal/token-usage-spool/claim`, {
          signal: controller.signal,
        });
        if (claim.ok) return await claim.json();
        // Do not fall back to the legacy destructive GET. If an older backend is
        // still running during an upgrade, leaving its spool untouched until it
        // restarts is safer than deleting a batch before Electron persists it.
        return [];
      } finally {
        clearTimeout(timeout);
      }
    },
    ackLocal: async (claimId) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(
          `${BACKEND_URL}/internal/token-usage-spool/claim/${encodeURIComponent(claimId)}`,
          { method: 'DELETE', signal: controller.signal },
        );
        return res.ok;
      } finally {
        clearTimeout(timeout);
      }
    },
    loadRetryQueue: loadTokenUsageRetryQueue,
    saveRetryQueue: saveTokenUsageRetryQueue,
    postEvent: (event, context, cloudBase, signal) =>
      postTokenUsageEvent(event, context.token, cloudBase, signal),
    log: elog,
    maxItems: TOKEN_USAGE_RETRY_MAX,
  });

  function drainTokenUsageIntoCloud() {
    return tokenUsageController.requestDrain();
  }

  // 实时提醒：长连一条 SSE，后端每捕获到一条用量就推一声"有新数据"（不带 payload），
  // 收到就立刻 drain，不用等定时器——这是真正意义上的实时，不是"轮询间隔缩短"。SSE 断线
  // （后端还没起来、重启、网络抖动）时短暂重连；期间数据仍然安全地躺在后端 spool 文件里，
  // 不会丢，下面的低频兜底定时器或者重连后的下一次提醒都能补上。
  async function watchTokenUsageStream() {
    for (;;) {
      try {
        const res = await fetch(`${BACKEND_URL}/internal/token-usage-stream`);
        if (!res.ok || !res.body) {
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() || '';
          for (const chunk of chunks) {
            if (chunk.startsWith('data:')) drainTokenUsageIntoCloud().catch(() => {});
          }
        }
      } catch (_) {
        // connection failed/dropped — fall through to reconnect delay below
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  drainTokenUsageIntoCloud().catch(() => {});
  watchTokenUsageStream(); // fire-and-forget: loops forever internally, reconnects on its own
  setInterval(() => { drainTokenUsageIntoCloud().catch(() => {}); }, 60_000); // SSE 掉线时的低频兜底

  // Poll the management server for upload_logs commands (spec §6). Startup + every
  // 10 min. Each command: collect full logs → zip → POST /logs (reason=requested)
  // → ack on success. All failures retry next cycle.
  async function pollCommands() {
    if (!telemetry) return;
    const base = updateConfig.telemetryUrl;
    const installId = getOrCreateInstallId();
    try {
      const res = await httpFetch(commandsUrl(base, installId));
      if (!res.ok) return;
      const body = await res.json();
      const cmds = parseCommands(body);
      if (cmds.length === 0) return;
      // Build the log bundle ONCE per poll (point-in-time snapshot) and reuse it
      // across every command in this batch — avoids O(N) re-reads/re-zips.
      const entries = collectFull({ files: logFilesForFull() });
      const zip = entries.length > 0 ? zipEntries(entries) : null;
      for (const cmd of cmds) {
        try {
          let ok = true;
          if (zip) {
            ok = await uploadLogs({
              endpoint: base,
              fetchImpl: httpFetch,   // 内网 https 走系统证书库
              fields: clientFields('requested', { command_id: cmd.id }),
              archive: { name: 'logs-requested.zip', data: zip },
            });
          }
          // ack on successful upload, or when there was nothing to upload (consume the command)
          if (ok) await httpFetch(ackUrl(base, installId, cmd.id), { method: 'POST' }).catch(() => {});
        } catch (_) {}
      }
    } catch (_) {}
  }
  pollCommands();
  setInterval(pollCommands, 10 * 60 * 1000);

  // Clear renderer chunk cache on every version change. Prevents Chromium from
  // holding onto a stale index.html that references hashed JS chunks no longer
  // on disk after an OTA update (which manifests as "Failed to fetch
  // dynamically imported module" when the user opens any code-split route).
  try {
    const versionFile = path.join(getAppDataDir(), 'last-version');
    const currentVersion = app.getVersion();
    let priorVersion = null;
    try { priorVersion = fs.readFileSync(versionFile, 'utf8').trim(); } catch {}
    if (priorVersion !== currentVersion) {
      try { fs.writeFileSync(versionFile, currentVersion, 'utf8'); }
      catch (e) { elog('persist last-version failed: ' + e.message); }
      // Clear unconditionally on any version change — INCLUDING the first run
      // after upgrading from a version that predates this last-version file
      // (priorVersion === null). That first upgrade is exactly when a stale
      // index.html from the old build is still cached; skipping it (the old
      // `if (priorVersion)` guard) left the very upgrade that introduced this
      // mechanism uncleared. On a genuine fresh install there's no cache to
      // clear, so this is harmless.
      await session.defaultSession.clearCache();
      elog(`Cleared renderer cache on version change ${priorVersion || '(fresh/legacy)'} -> ${currentVersion}`);
    }
  } catch (e) { elog('cache-clear-on-upgrade failed: ' + e.message); }

  reconcileUserEnv();   // version-gated .env reconcile; must run before startBackend

  if (!IS_DEV) {
    const alreadyRunning = await isBackendAlreadyRunning();
    if (alreadyRunning) {
      elog('Port already in use and healthy — reusing existing backend');
    } else {
      chromiumSearchBridge = await startChromiumSearchBridge();
      const bridgeInfo = chromiumSearchBridge
        ? { endpoint: chromiumSearchBridge.endpoint, token: chromiumSearchBridge.token }
        : null;
      if (!startBackend(bridgeInfo)) {
        await stopChromiumSearchBridge();
        return;
      }
    }
  }

  // 套件对账 —— **放在 startBackend 之后**。
  //
  // 原先放在前面，理由是"后端只在启动时装一次"。但 W3 的 JWT 是后端发的
  // （登录走 /w3/auth，恢复走 /w3/refresh-token），后端没起来就必然取不到令牌，
  // 于是 listAgents 直接判"未登录"跳过——日志里那一行出现在启动后 0.15 秒，
  // 那时窗口都还没出来，用户根本没机会登录。跳过之后要等 24 小时才会再试，
  // 表现就是"登录了却一个套件都拉不到，重启也不一定好"。
  //
  // 挪到后端之后就能 applyNow：装完直接叫后端 recheck，不必等下次开应用。
  // 不 await —— 取包要联网，让它在后台跑，窗口该出来就出来。
  void syncCoworkPackagesOnStartup();

  installPowerRecovery();
  createWindow();
  // 托盘常驻：不再由最小化触发创建。它承担两件事——通知到来时闪动（窗口在后台
  // 或被别的窗口挡住时的持续可见提示），以及随时可点开主窗口的快捷入口。
  createTray();
});

app.on('window-all-closed', async () => {
  await stopBackend();
  await stopChromiumSearchBridge();
  app.quit();
});

app.on('before-quit', () => {
  // 托盘先拆：闪动定时器不清会拖着事件循环，图标不 destroy 会在通知区留一个
  // 点不动的幽灵图标（要等鼠标划过才消失）。
  if (trayBlinkTimer) { clearInterval(trayBlinkTimer); trayBlinkTimer = null; }
  // 每日对账的定时器同理：不清会拖着事件循环，应用看起来退不干净。
  if (coworkRecheckTimer) { clearInterval(coworkRecheckTimer); coworkRecheckTimer = null; }
  if (tray && !tray.isDestroyed()) { try { tray.destroy(); } catch (_) {} }
  tray = null;
  // Best-effort synchronous safety net. The graceful, awaited stop happens in
  // window-all-closed and the update-install IPC handler; this only fires a
  // synchronous SIGTERM for quit paths that bypass those, then closes the log.
  if (backendProcess) { try { backendProcess.kill('SIGTERM'); } catch (_) {} }
  if (chromiumSearchBridge) {
    try { chromiumSearchBridge.closeNow(); } catch (_) {}
    chromiumSearchBridge = null;
  }
  if (electronLogStream) electronLogStream.end();
});
