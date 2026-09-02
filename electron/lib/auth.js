'use strict';

// 桌面端浏览器登录（OAuth Authorization Code + PKCE + Loopback 回环回跳）。
// 设计见 netcowork/doc/DESKTOP_BROWSER_AUTH_DESIGN.md。
// 整个流程跑在 Electron 主进程：起回环服务器接 code → 换 token → safeStorage 加密落盘。

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { shell, safeStorage, net } = require('electron');
const branding = require('../branding.json');   // 品牌显示名唯一来源，见 electron/branding.json
const { safeUrlForLog } = require('./window-open-policy');

// 认证请求一律走 Electron 的 net.fetch（Chromium 网络栈 = 系统证书库），不用 Node 全局
// fetch。Node 的 fetch 只信自己内置的 CA、不读系统信任库，内网 HTTPS（自签/内部 CA）会
// 直接 "fetch failed"；net.fetch 与浏览器同源信任，浏览器能开的它就能连。
const httpFetch = (typeof net !== 'undefined' && net && net.fetch) ? net.fetch.bind(net) : fetch;

const CLIENT_ID = 'ipmaster-desktop';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
// 仅开发态注入的假用户（闸门见 computeDevSkipAuth + main.js）。
// 明显伪造、低权限，绝不冒充 admin；辨识度高、好 grep。
const DEV_USER = { id: 'dev-local', username: 'dev (local)', role: 'dev' };

// W3 认证特有的错误类型：白名单未命中
class NotInWhitelistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotInWhitelistError';
    this.message = message || '用户权限不足，如需开通，请联系：李天宇 00485973';
  }
}

// 安全闸门：旁路只在「未打包」且「app-config 显式 devSkipAuth===true」时生效。
// 打包态恒 false —— 这是整套方案唯一承重行，改它前看 auth.test.js 的守卫回归用例。
function computeDevSkipAuth({ isPackaged, appConfig } = {}) {
  return !isPackaged && appConfig != null && appConfig.devSkipAuth === true;
}

// 云端地址唯一来源 = app-config.json 的 netcoworkBaseUrl（打包态取 packaging/default_data
// 随包出厂值，开发态取 electron/，见 main.js#readAppConfigFile）。无 env / 每机文件覆盖。
function resolveCloudBaseUrl({ appConfig = {} } = {}) {
  const url = appConfig.netcoworkBaseUrl || '';
  return url.replace(/\/+$/, '');   // 去尾部斜杠
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function authFilePath(appDataDir) { return path.join(appDataDir, 'auth.bin'); }

function saveSession(appDataDir, data) {
  const json = JSON.stringify(data);
  const hasSafeStorage = typeof safeStorage !== 'undefined' && safeStorage && safeStorage.isEncryptionAvailable();
  const buf = hasSafeStorage
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');      // 极少数无系统钥匙串的环境兜底（含 Node.js 单元测试）
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.writeFileSync(authFilePath(appDataDir), buf);
}

function loadSession(appDataDir) {
  try {
    const raw = fs.readFileSync(authFilePath(appDataDir));
    const hasSafeStorage = typeof safeStorage !== 'undefined' && safeStorage && safeStorage.isEncryptionAvailable();
    const json = hasSafeStorage
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    const data = JSON.parse(json);
    // ★ W3 模式下存储 { uid, user, w3: true, access_token?, token_usage_epoch }。
    //   有 access_token（local-token 换取的云端 JWT）时按 exp 判断过期；
    //   无 access_token 时跳过 exp（uid 凭证不过期）。
    if (data.w3 === true) {
      if (data.access_token) {
        const state = jwtState(data.access_token);
        if (state === 'expired') return null;
        if (state === 'invalid') {
          delete data.access_token;
          saveSession(appDataDir, data);
        }
      }
      return data;
    }
    if (jwtExpired(data.access_token)) return null;   // 本地 exp 判断
    return data;
  } catch {
    return null;
  }
}

function clearSession(appDataDir) {
  const file = authFilePath(appDataDir);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    // Antivirus/indexers can briefly deny unlink on Windows.  Invalidating the
    // contents is an equally safe logout: loadSession() will fail closed.
    try {
      fs.writeFileSync(file, Buffer.alloc(0));
      return true;
    } catch (overwriteError) {
      const detail = overwriteError && overwriteError.message
        ? overwriteError.message
        : (error && error.message) || 'unknown error';
      throw new Error(`无法清除本地登录凭证: ${detail}`);
    }
  }
}

function authUserId(user) {
  return user && user.id != null ? String(user.id) : '';
}

function createTokenUsageEpoch(user, { nowMs = Date.now(), epochId = crypto.randomUUID() } = {}) {
  const boundary = Number(nowMs);
  if (!Number.isFinite(boundary)) throw new TypeError('invalid token-usage login boundary');
  if (typeof epochId !== 'string' || !epochId.trim()) throw new TypeError('invalid token-usage epoch id');
  return {
    id: epochId,
    user_id: authUserId(user),
    not_before_ms: boundary,
  };
}

function tokenUsageContextFromSession(session) {
  if (!session || typeof session !== 'object') return null;
  // 必须有云端 JWT 才能上报 token-usage；无 JWT 时不兜底 w3:<uid>，
  // 由上层（main.js getContext）触发异步补取，补到后下一轮 drain 正常上报。
  const token = session.access_token || null;
  if (!token) return null;
  const epoch = session.token_usage_epoch;
  if (!epoch || typeof epoch !== 'object') return null;
  const epochId = typeof epoch.id === 'string' ? epoch.id.trim() : '';
  const notBeforeMs = Number(epoch.not_before_ms);
  const userId = authUserId(session.user);
  if (!epochId || !Number.isFinite(notBeforeMs) || String(epoch.user_id ?? '') !== userId) return null;
  return { token, epochId, userId, notBeforeMs };
}

function sessionWithFreshTokenUsageEpoch(accessToken, user, options) {
  return {
    access_token: accessToken,
    user,
    token_usage_epoch: createTokenUsageEpoch(user, options),
  };
}

// W3 会话与 OAuth 会话一样落一条 token-usage 登录纪元：uid 即 userId，
// 让上报归属 / 重试队列 / 登录切换闸门在两种登录模式下按同一套规则运转。
// accessToken（可选）为 local-token 换取的云端 JWT，存入 access_token 后
// getToken / tokenUsageContextFromSession 会优先用它做鉴权与上报。
function w3SessionWithFreshTokenUsageEpoch(uid, user, options, accessToken) {
  const session = {
    uid,
    user,
    w3: true,
    token_usage_epoch: createTokenUsageEpoch(user, options),
  };
  if (accessToken) session.access_token = accessToken;
  return session;
}


// Upgrade path for an auth.bin written by a version without login epochs.  The
// first authenticated startup establishes "now" as the boundary and persists it
// in the same encrypted auth file as the JWT before any drain is enabled.
// Therefore an auto-login after upgrade cannot replay pre-upgrade records.
function getTokenUsageContext(appDataDir, options) {
  let session = loadSession(appDataDir);
  if (!session) return null;
  let context = tokenUsageContextFromSession(session);
  if (!context) {
    session = {
      ...session,
      token_usage_epoch: createTokenUsageEpoch(session.user, options),
    };
    saveSession(appDataDir, session);
    context = tokenUsageContextFromSession(session);
  }
  return context;
}

// 本地解析 JWT 的 exp 字段判断是否过期（不联网）。无 exp 视为不过期；解析失败视为过期。
function jwtState(token) {
  try {
    if (typeof token !== 'string' || token.split('.').length !== 3) return 'invalid';
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    if (!payload.exp) return 'valid';
    return Date.now() / 1000 >= payload.exp ? 'expired' : 'valid';
  } catch {
    return 'invalid';
  }
}

function jwtExpired(token) {
  return jwtState(token) !== 'valid';
}

// 完整登录：起回环服务器 → 打开浏览器 → 收 code → 换 token → 落盘 → 返回 user。
// useW3=true 时走 W3 认证（主窗口内嵌视图 OAuth2 授权码），否则走传统 OAuth PKCE。
async function startLogin({ cloudBaseUrl, appDataDir, pythonBackendUrl,
                            useW3 = false, devSkipAuth = false, w3Config, logFn }) {
  if (devSkipAuth) return DEV_USER;
  if (useW3) {
    return startLoginW3({ w3Config, pythonBackendUrl, appDataDir, devSkipAuth, logFn });
  }
  if (!cloudBaseUrl) throw new Error('未配置云端地址（app-config.json netcoworkBaseUrl）');

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; try { server.close(); } catch {} fn(arg); } };

    const page = (title, msg) =>
      '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:64px">'
      + `<h2>${title}</h2><p>${msg}</p></body>`;

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      // 先判定成败，再决定回什么页面（修：拒绝/出错时不应再显示"登录成功"）
      const ok = !err && gotState === state && !!gotCode;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok
        ? page('✅ 登录成功', `请返回 ${branding.productName} 应用，可关闭此页面。`)
        : page('❌ 授权未完成', `已取消或授权失败，请返回 ${branding.productName} 应用重试，可关闭此页面。`));
      if (err) return finish(reject, new Error('已取消授权：' + err));
      if (gotState !== state) return finish(reject, new Error('state 校验失败'));
      if (!gotCode) return finish(reject, new Error('未收到授权码'));
      finish(resolve, { code: gotCode, redirectUri: server._redirectUri });
    });

    server.on('error', (e) => finish(reject, e));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const ru = `http://127.0.0.1:${port}/callback`;
      server._redirectUri = ru;
      const authUrl = `${cloudBaseUrl}/authorize?client_id=${encodeURIComponent(CLIENT_ID)}`
        + `&redirect_uri=${encodeURIComponent(ru)}`
        + `&state=${encodeURIComponent(state)}`
        + `&code_challenge=${encodeURIComponent(challenge)}`
        + `&code_challenge_method=S256`;
      shell.openExternal(authUrl);
    });
    setTimeout(() => finish(reject, new Error('登录超时')), LOGIN_TIMEOUT_MS);
  });

  // 用 code + PKCE verifier 换 token
  let resp;
  try {
    resp = await httpFetch(`${cloudBaseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grantType: 'authorization_code',
        code,
        codeVerifier: verifier,
        clientId: CLIENT_ID,
        redirectUri,
      }),
    });
  } catch (e) {
    // fetch 本身抛错（连不上/TLS 证书/DNS）时 message 只是笼统的 "fetch failed"，
    // 真正原因在 e.cause（如 DEPTH_ZERO_SELF_SIGNED_CERT / ECONNREFUSED）。透出来便于定位。
    const c = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : (e && e.message);
    throw new Error(`连接认证服务失败: ${c}`);
  }
  if (!resp.ok) {
    let msg = `换取 token 失败 (HTTP ${resp.status})`;
    try { const e = await resp.json(); msg = e.detail || e.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = await resp.json();   // { accessToken, tokenType, expiresIn, user }
  // Capture and persist the reporting boundary together with the new JWT.  There
  // is no intermediate on-disk state in which a new token is visible without its
  // matching epoch, so startup/SSE/timer drains fail closed across a crash here.
  const notBeforeMs = Date.now();
  saveSession(appDataDir, sessionWithFreshTokenUsageEpoch(
    data.accessToken,
    data.user,
    { nowMs: notBeforeMs },
  ));
  return data.user;
}

// W3 认证登录（当前主窗口内覆盖 WebContentsView，OAuth2 授权码流程）。
// 登录视图复用主窗口 Session 以保留 XGate/W3 cookie，但主应用页面始终不发生导航；
// 拦截回调提取 code 后继续调用本地后端换 token + 白名单校验。
async function startLoginW3({ w3Config, pythonBackendUrl, appDataDir, devSkipAuth = false,
                              logFn, fetchImpl = httpFetch }) {
  if (devSkipAuth) return DEV_USER;
  const log = (message) => { if (logFn) logFn(message); };

  const parentWindow = w3Config && w3Config.parentWindow;
  if (!parentWindow || parentWindow.isDestroyed()) throw new Error('主窗口不可用');
  if (!w3Config.clientId || !w3Config.callbackUrl) {
    throw new Error('W3 认证配置不完整，请检查 app-config.json 中的 w3ClientId / w3CallbackUrl');
  }
  if (typeof w3Config.createLoginView !== 'function') {
    throw new Error('W3 登录视图创建器未配置');
  }
  const sharedSession = parentWindow.webContents && parentWindow.webContents.session;
  if (!sharedSession) throw new Error('主窗口会话不可用');

  // 1. 生成 state (随机 16 字节 base64url)
  const state = b64url(crypto.randomBytes(16));

  // 2. 构建授权 URL (baseUrl 先去尾部斜杠，避免 //saaslogin1)
  const baseUrl = (w3Config.baseUrl || 'https://uniportal.huawei.com').replace(/\/+$/, '');
  const authUrl = `${baseUrl}/saaslogin1/oauth2/authorize`
    + `?client_id=${encodeURIComponent(w3Config.clientId)}`
    + `&display=page`
    + `&state=${encodeURIComponent(state)}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(w3Config.callbackUrl)}`
    + `&scope=${encodeURIComponent(w3Config.scope || 'base.profile')}`;
  let loginView;
  try {
    loginView = w3Config.createLoginView({ parentWindow, session: sharedSession });
    if (!loginView || loginView.isDestroyed() || !loginView.webContents) {
      throw new Error('W3 登录视图创建失败');
    }
    log(`准备在主窗口内嵌视图打开 W3，authUrl=${safeUrlForLog(authUrl)}, `
        + `callbackUrl=${safeUrlForLog(w3Config.callbackUrl)}, `
        + `userAgent=${loginView.webContents.getUserAgent()}`);

    // 3. 主窗口内嵌视图加载 W3 登录页，网络层拦截回调 URL（不实际请求回调服务器）。
    const code = await new Promise((resolve, reject) => {
      let settled = false;
      let onClosed;

      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        try { sharedSession.webRequest.onBeforeRequest(null); } catch {}
        try {
          if (onClosed && typeof loginView.removeListener === 'function') {
            loginView.removeListener('closed', onClosed);
          }
        } catch {}
        fn(val);
      };

      sharedSession.webRequest.onBeforeRequest(
        { urls: [`${w3Config.callbackUrl}*`] },
        (details, callback) => {
          const u = new URL(details.url);
          const gotCode = u.searchParams.get('code');
          const gotState = u.searchParams.get('state');
          const err = u.searchParams.get('error');
          log(`捕获 OAuth 回调，url=${safeUrlForLog(details.url)}, hasCode=${!!gotCode}, `
              + `stateMatch=${gotState === state}, hasError=${!!err}`);
          callback({ cancel: true });
          try {
            Promise.resolve(loginView.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
              '<html style="background:#f0f4fa;margin:0"><head><meta charset="utf-8">' +
              '<style>@keyframes s{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}</style></head>' +
              '<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
              '<div style="text-align:center">' +
              '<div style="width:32px;height:32px;margin:0 auto 16px;border:3px solid #d0dce8;' +
              'border-top-color:#3d5a80;border-radius:50%;animation:s .8s linear infinite"></div>' +
              '<p style="color:#8aa3bf;font-family:system-ui,sans-serif;font-size:14px;margin:0">' +
              '正在登录…</p></div></body></html>'
            ))).catch(() => {});
          } catch {}
          if (err) return finish(reject, new Error('W3 授权失败: ' + err));
          if (gotState !== state) return finish(reject, new Error('state 校验失败'));
          if (!gotCode) return finish(reject, new Error('未收到授权码'));
          finish(resolve, gotCode);
        }
      );

      // 用户关闭主窗口 → 取消登录；正常登录结束只移除内嵌视图。
      onClosed = () => finish(reject, new Error('登录窗口已关闭'));
      loginView.on('closed', onClosed);

      log('OAuth 回调监听器已安装，开始加载 W3 页面');
      Promise.resolve(loginView.loadURL(authUrl)).then(
        () => log(`W3 页面 loadURL 完成，currentUrl=${safeUrlForLog(loginView.webContents.getURL())}`),
        (error) => {
          const codeOrName = (error && (error.code || error.errno || error.name)) || 'unknown';
          log(`W3 页面 loadURL 失败，errorCode=${codeOrName}`);
          finish(reject, new Error(`W3 登录页加载失败: ${codeOrName}`));
        },
      );
    });

    // 4. 调用 Python 后端 POST /w3/auth 换 token + userinfo + 白名单校验
    let resp;
    try {
      log(`已取得 OAuth code，调用本地认证接口 ${safeUrlForLog(`${pythonBackendUrl}/w3/auth`)}`);
      resp = await fetchImpl(`${pythonBackendUrl}/w3/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirect_uri: w3Config.callbackUrl }),
      });
    } catch (e) {
      const c = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : (e && e.message);
      throw new Error(`连接认证服务失败: ${c}`);
    }

    log(`本地 /w3/auth 已响应，status=${resp.status}, ok=${resp.ok}`);
    const data = await resp.json();

    // 5. 白名单未命中 (HTTP 200 + error:"not_in_whitelist")
    if (data && data.error === 'not_in_whitelist') {
      throw new NotInWhitelistError(data.message || '用户权限不足，如需开通，请联系：李天宇 00485973');
    }

    if (!resp.ok) {
      if (resp.status === 501) throw new Error('W3 认证未配置，请联系管理员');
      const detail = (data && (data.detail || data.message)) || `HTTP ${resp.status}`;
      throw new Error(`W3 认证失败: ${detail}`);
    }

    // 6. 存储会话 (w3: true 标记; access_token 为 local-token 换取的云端 JWT)。
    // 主页面仍在等待 auth-login IPC，返回 user 后 LoginGate 直接进入首页，无需重新加载。
    saveSession(appDataDir, w3SessionWithFreshTokenUsageEpoch(
      data.uid, data.user, undefined, data.access_token,
    ));
    log(`W3 会话已保存，hasUser=${!!data.user}, hasJwt=${!!data.access_token}`);
    return data.user;
  } finally {
    // OAuth 完成、失败或后端校验异常时都移除 W3 视图；不导航主应用页面。
    try {
      if (loginView && !loginView.isDestroyed()) {
        if (typeof loginView.destroy === 'function') loginView.destroy();
      }
    } catch {}
  }
}

// W3 模式下获取当前用户信息（启动时会话恢复）。
// 调用云端已有的 POST /api/auth/precheck 接口，入参 { username: uid(工号) }，
// 响应 NEEDS_PASSWORD → 在白名单，放行；NOT_ALLOWED → 清除会话，回登录页。
async function getSessionW3({ appDataDir, devSkipAuth, logFn,
                              pythonBackendUrl, fetchImpl = httpFetch }) {
  if (devSkipAuth) return DEV_USER;
  const s = loadSession(appDataDir);
  if (!s) return null;
  // 旧 OAuth 会话没有 uid / w3 标记 → 不是有效的 W3 会话，需要重新登录
  if (!s.uid || s.w3 !== true) return null;

  const refreshJwtInBackground = () => {
    if (s.access_token || !pythonBackendUrl) return;
    void (async () => {
      try {
        const r = await fetchImpl(`${pythonBackendUrl}/w3/refresh-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: s.uid }),
        });
        if (r.ok) {
          const data = await r.json();
          if (data && data.access_token) {
            s.access_token = data.access_token;
            saveSession(appDataDir, s);
            if (logFn) logFn(`W3 会话恢复: 已补取 JWT (len=${s.access_token.length})`);
          }
        }
      } catch (e) {
        if (logFn) logFn(`W3 会话恢复: 补取 JWT 失败，回退 uid 凭证 — ${(e && e.message) || e}`);
      }
    })();
  };

  // 设备级永久访问：本地存在有效 W3 会话即视为"此人授权过"——auth.bin 走 OS 密钥库
  // 加密，只有合法登录过才写得进，会话存在本身就是授权凭据。恢复时**不再回云端重校
  // 白名单**，桌面使用权一旦授权即永久保留（设计：设备级）。agent 权限被收回只让对应
  // 会话变只读（后端 resume/续聊 403 + 前端按可用 cowork 推导只读），历史永远可看。
  // 云端仅用于 best-effort 续取 JWT（供上报/上传），失败不阻断访问。
  refreshJwtInBackground();
  return s.user;
}

// 启动时取 session + 云端吊销检查（401→登出；网络不可达→回退本地 exp）。
// devSkipAuth（仅开发态，由 main.js 算好传入）为真时跳过登录门，注入假用户。
// useW3=true 时走 W3 模式，否则走传统 OAuth 吊销校验。
async function getSession({ cloudBaseUrl, appDataDir, devSkipAuth, logFn,
                            useW3 = false, pythonBackendUrl, fetchImpl = httpFetch }) {
  if (useW3) {
    return getSessionW3({ appDataDir, devSkipAuth, logFn, pythonBackendUrl, fetchImpl });
  }
  if (devSkipAuth) return DEV_USER;
  const s = loadSession(appDataDir);
  if (!s) return null;
  if (!cloudBaseUrl) return s.user;
  let r;
  try {
    r = await fetchImpl(`${cloudBaseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${s.access_token}` },
    });
  } catch (e) {
    // /me 失败(网络/TLS 证书等)→ 回退本地放行；把原因记下来便于排查（cause 里才是真因）。
    if (logFn) {
      const c = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : (e && e.message) || e;
      logFn(`/me 吊销校验失败，回退本地放行: ${c}`);
    }
    return s.user;   // 云端不可达 → 回退本地（loadSession 已判过期）→ 放行
  }
  // A real 401 is not a network fallback.  If the credential cannot be removed,
  // let clearSession throw so the caller keeps token reporting fail-closed.
  if (r.status === 401) { clearSession(appDataDir); return null; }
  return s.user;
}

// 取当前有效的云端 access token（用于桌面把请求"以用户身份"转发给 cowork，
// 如上传 skill 时写入 creator）。过期/未登录返回 null（loadSession 已判 exp）。
// devSkipAuth 假用户没有真实 token → 返回 null，转发方按匿名处理。
// W3 会话若含 local-token 换取的 JWT → 返回该 JWT；无 JWT → 返回 null。
function getToken(appDataDir) {
  const s = loadSession(appDataDir);
  return s && s.access_token ? s.access_token : null;
}

module.exports = {
  resolveCloudBaseUrl, startLogin, getSession, getToken, getTokenUsageContext,
  loadSession, saveSession, clearSession, jwtExpired, authFilePath,
  createTokenUsageEpoch, sessionWithFreshTokenUsageEpoch, tokenUsageContextFromSession,
  w3SessionWithFreshTokenUsageEpoch, getSessionW3, startLoginW3,
  DEV_USER, computeDevSkipAuth, NotInWhitelistError,
};
