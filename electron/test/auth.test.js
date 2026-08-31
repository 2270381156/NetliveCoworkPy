'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getSession,
  DEV_USER,
  computeDevSkipAuth,
  clearSession,
  createTokenUsageEpoch,
  getTokenUsageContext,
  loadSession,
  saveSession,
  sessionWithFreshTokenUsageEpoch,
  w3SessionWithFreshTokenUsageEpoch,
  tokenUsageContextFromSession,
  getSessionW3,
  startLoginW3,
  NotInWhitelistError,
} = require('../lib/auth');

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

test('new login stores JWT and token-usage epoch as one session object', () => {
  const user = { id: 42, username: 'alice', role: 'user' };
  const session = sessionWithFreshTokenUsageEpoch('jwt-new', user, {
    nowMs: 123456,
    epochId: 'epoch-new',
  });

  assert.deepStrictEqual(session, {
    access_token: 'jwt-new',
    user,
    token_usage_epoch: {
      id: 'epoch-new',
      user_id: '42',
      not_before_ms: 123456,
    },
  });
  assert.deepStrictEqual(tokenUsageContextFromSession(session), {
    token: 'jwt-new',
    epochId: 'epoch-new',
    userId: '42',
    notBeforeMs: 123456,
  });
});

test('token-usage context fails closed when epoch is missing or belongs to another user', () => {
  const user = { id: 'user-b', username: 'bob' };
  assert.strictEqual(tokenUsageContextFromSession({ access_token: 'jwt', user }), null);
  assert.strictEqual(tokenUsageContextFromSession({
    access_token: 'jwt',
    user,
    token_usage_epoch: { id: 'epoch-a', user_id: 'user-a', not_before_ms: 100 },
  }), null);
});

test('token-usage epoch validates its durable login boundary', () => {
  assert.throws(
    () => createTokenUsageEpoch({ id: 'u' }, { nowMs: Number.NaN, epochId: 'epoch' }),
    /invalid token-usage login boundary/,
  );
  assert.throws(
    () => createTokenUsageEpoch({ id: 'u' }, { nowMs: 1, epochId: '' }),
    /invalid token-usage epoch id/,
  );
});

test('legacy auto-login creates one durable boundary and reuses it after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-'));
  const payload = Buffer.from(JSON.stringify({ sub: 'user-b' })).toString('base64url');
  const token = `header.${payload}.signature`;
  const user = { id: 'user-b', username: 'bob' };
  saveSession(dir, { access_token: token, user });

  const first = getTokenUsageContext(dir, { nowMs: 5000, epochId: 'upgrade-epoch' });
  const second = getTokenUsageContext(dir, { nowMs: 9999, epochId: 'must-not-replace' });

  assert.deepStrictEqual(first, {
    token,
    epochId: 'upgrade-epoch',
    userId: 'user-b',
    notBeforeMs: 5000,
  });
  assert.deepStrictEqual(second, first);
  assert.strictEqual(loadSession(dir).token_usage_epoch.id, 'upgrade-epoch');
});

test('clearSession invalidates the durable credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-'));
  const payload = Buffer.from(JSON.stringify({ sub: 'user-b' })).toString('base64url');
  saveSession(dir, {
    access_token: `header.${payload}.signature`,
    user: { id: 'user-b', username: 'bob' },
  });

  assert.strictEqual(clearSession(dir), true);
  assert.strictEqual(loadSession(dir), null);
  assert.strictEqual(clearSession(dir), true); // already absent is also success
});

test('a real /me 401 clears the credential instead of using network fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-'));
  const payload = Buffer.from(JSON.stringify({ sub: 'user-b' })).toString('base64url');
  saveSession(dir, {
    access_token: `header.${payload}.signature`,
    user: { id: 'user-b', username: 'bob' },
  });

  const user = await getSession({
    cloudBaseUrl: 'https://cloud.example',
    appDataDir: dir,
    fetchImpl: async () => ({ status: 401 }),
  });

  assert.strictEqual(user, null);
  assert.strictEqual(loadSession(dir), null);
});

// ── W3 认证 ─────────────────────────────────────────────────────────────────

test('W3 登录使用当前主窗口内的共享 Session 视图，主应用页面不发生导航', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-window-'));
  const registeredListeners = new Map();
  const sharedSession = {
    webRequest: {
      onBeforeRequest: (_filter, listener) => {
        if (listener) registeredListeners.set('before-request', listener);
        else registeredListeners.delete('before-request');
      },
    },
  };
  const parentLoadedUrls = [];
  const loginLoadedUrls = [];
  let parentClosed;
  let loginClosed;
  let factoryArgs;

  const parentWindow = {
    isDestroyed: () => false,
    webContents: {
      session: sharedSession,
      getURL: () => 'http://127.0.0.1:15926/',
      getUserAgent: () => 'test-parent-user-agent',
    },
    on: (event, listener) => {
      if (event === 'closed') parentClosed = listener;
    },
    loadURL: async (url) => { parentLoadedUrls.push(url); },
  };
  const loginView = {
    isDestroyed: () => false,
    webContents: {
      session: sharedSession,
      getURL: () => loginLoadedUrls.at(-1) || 'about:blank',
      getUserAgent: () => 'test-login-user-agent',
    },
    on: (event, listener) => {
      if (event === 'closed') loginClosed = listener;
    },
    loadURL: async (url) => { loginLoadedUrls.push(url); },
  };

  const pending = startLoginW3({
    w3Config: {
      baseUrl: 'https://uniportal.example',
      clientId: 'client-id',
      callbackUrl: 'https://app.example/callback',
      parentWindow,
      createLoginView: (args) => {
        factoryArgs = args;
        return loginView;
      },
    },
    pythonBackendUrl: 'http://127.0.0.1:15926',
    appDataDir: dir,
  });

  // startLoginW3 在等待 OAuth 回调前已经完成窗口创建和首次导航。
  await new Promise((resolve) => setImmediate(resolve));
  if (loginClosed) loginClosed();
  else if (parentClosed) parentClosed();
  await assert.rejects(pending, /登录窗口已关闭/);

  assert.ok(factoryArgs, '应创建主窗口内的 W3 登录视图');
  assert.strictEqual(factoryArgs.parentWindow, parentWindow);
  assert.strictEqual(factoryArgs.session, sharedSession, '登录窗口应复用主窗口 Session');
  assert.deepStrictEqual(parentLoadedUrls, [], '主应用窗口不应离开登录页');
  assert.strictEqual(loginLoadedUrls.length, 1);
  assert.match(loginLoadedUrls[0], /^https:\/\/uniportal\.example\/saaslogin1\/oauth2\/authorize\?/);
});

test('W3 内嵌视图回调成功后移除视图、保存会话并直接返回用户', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-success-'));
  let beforeRequestListener = null;
  let callbackResult = null;
  let backendRequest = null;
  let destroyed = false;
  const listeners = new Map();
  const sharedSession = {
    webRequest: {
      onBeforeRequest: (filter, listener) => {
        if (filter === null || listener === null) beforeRequestListener = null;
        else beforeRequestListener = listener;
      },
    },
  };
  const parentLoadedUrls = [];
  const loginLoadedUrls = [];
  const parentWindow = {
    isDestroyed: () => false,
    webContents: {
      session: sharedSession,
      getURL: () => 'http://127.0.0.1:15926/',
      getUserAgent: () => 'test-parent-user-agent',
    },
    loadURL: async (url) => { parentLoadedUrls.push(url); },
  };
  const loginView = {
    isDestroyed: () => destroyed,
    webContents: {
      session: sharedSession,
      getURL: () => loginLoadedUrls.at(-1) || 'about:blank',
      getUserAgent: () => 'test-login-user-agent',
    },
    on: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    destroy: () => {
      destroyed = true;
      const closed = listeners.get('closed');
      if (closed) closed();
    },
    loadURL: async (url) => {
      loginLoadedUrls.push(url);
      if (url.startsWith('https://uniportal.example/')) {
        const state = new URL(url).searchParams.get('state');
        queueMicrotask(() => beforeRequestListener(
          { url: `https://app.example/callback?code=oauth-code&state=${encodeURIComponent(state)}` },
          (result) => { callbackResult = result; },
        ));
      }
    },
  };
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: 9999999999 })).toString('base64url');
  const jwt = `header.${payload}.signature`;

  const result = await startLoginW3({
    w3Config: {
      baseUrl: 'https://uniportal.example',
      clientId: 'client-id',
      callbackUrl: 'https://app.example/callback',
      parentWindow,
      createLoginView: () => loginView,
    },
    pythonBackendUrl: 'http://127.0.0.1:15926',
    appDataDir: dir,
    fetchImpl: async (url, options) => {
      backendRequest = { url, options };
      return {
        status: 200,
        ok: true,
        json: async () => ({ uid: user.id, user, access_token: jwt }),
      };
    },
  });

  assert.deepStrictEqual(result, user);
  assert.deepStrictEqual(parentLoadedUrls, []);
  assert.strictEqual(destroyed, true, '认证结束后应移除 W3 内嵌视图');
  assert.deepStrictEqual(callbackResult, { cancel: true });
  assert.strictEqual(backendRequest.url, 'http://127.0.0.1:15926/w3/auth');
  assert.deepStrictEqual(JSON.parse(backendRequest.options.body), {
    code: 'oauth-code',
    redirect_uri: 'https://app.example/callback',
  });
  assert.strictEqual(beforeRequestListener, null, 'OAuth 回调拦截器应在完成后移除');
  const saved = loadSession(dir);
  assert.strictEqual(saved.uid, user.id);
  assert.strictEqual(saved.access_token, jwt);
  assert.deepStrictEqual(saved.user, user);
});

test('W3 session stores uid + token-usage epoch; loadSession skips JWT exp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-'));
  const user = { id: '00485973', username: '00485973', displayName: 'Li', role: 'user' };
  const session = w3SessionWithFreshTokenUsageEpoch('00485973', user, {
    nowMs: 123456,
    epochId: 'w3-epoch-1',
  });

  assert.deepStrictEqual(session, {
    uid: '00485973',
    user,
    w3: true,
    token_usage_epoch: { id: 'w3-epoch-1', user_id: '00485973', not_before_ms: 123456 },
  });

  saveSession(dir, session);
  // 无 access_token，也不该走 JWT exp 解析——存取往返即验证不误杀。
  assert.deepStrictEqual(loadSession(dir), session);
});

test('token-usage context is null for W3 sessions without JWT — no w3:<uid> fallback', () => {
  const user = { id: '00485973', username: '00485973', role: 'user' };
  const session = w3SessionWithFreshTokenUsageEpoch('00485973', user, {
    nowMs: 5000,
    epochId: 'w3-epoch-2',
  });

  assert.strictEqual(tokenUsageContextFromSession(session), null);
});

test('token-usage context is unchanged for OAuth sessions (regression)', () => {
  const user = { id: 'user-b', username: 'bob' };
  const session = sessionWithFreshTokenUsageEpoch('jwt-a', user, {
    nowMs: 7000,
    epochId: 'oauth-epoch',
  });
  assert.strictEqual(tokenUsageContextFromSession(session).token, 'jwt-a');
});

test('W3 session with JWT (local-token) uses real JWT for token-usage reporting', () => {
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  const session = w3SessionWithFreshTokenUsageEpoch('w30040833', user, {
    nowMs: 8000,
    epochId: 'w3-jwt-epoch',
  }, 'jwt-from-local-token');

  assert.strictEqual(session.access_token, 'jwt-from-local-token');
  assert.strictEqual(session.w3, true);
  assert.strictEqual(session.uid, 'w30040833');
  assert.deepStrictEqual(tokenUsageContextFromSession(session), {
    token: 'jwt-from-local-token',
    epochId: 'w3-jwt-epoch',
    userId: 'w30040833',
    notBeforeMs: 8000,
  });
});

test('W3 session with expired JWT is cleared by loadSession', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-jwt-'));
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  // exp 已过期的 JWT
  const payload = Buffer.from(JSON.stringify({ sub: 'w30040833', exp: 1 })).toString('base64url');
  const expiredJwt = `header.${payload}.signature`;
  saveSession(dir, w3SessionWithFreshTokenUsageEpoch('w30040833', user, undefined, expiredJwt));
  assert.strictEqual(loadSession(dir), null);
});

test('W3 session with valid JWT survives loadSession', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-jwt-'));
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  const payload = Buffer.from(JSON.stringify({ sub: 'w30040833', exp: 9999999999 })).toString('base64url');
  const validJwt = `header.${payload}.signature`;
  saveSession(dir, w3SessionWithFreshTokenUsageEpoch('w30040833', user, undefined, validJwt));
  const loaded = loadSession(dir);
  assert.notStrictEqual(loaded, null);
  assert.strictEqual(loaded.access_token, validJwt);
  assert.strictEqual(loaded.w3, true);
});

test('W3 session with malformed JWT keeps the verified identity and drops only the JWT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-jwt-'));
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  saveSession(dir, w3SessionWithFreshTokenUsageEpoch('w30040833', user, undefined, 'not-a-jwt'));

  const loaded = loadSession(dir);

  assert.notStrictEqual(loaded, null);
  assert.deepStrictEqual(loaded.user, user);
  assert.strictEqual(loaded.uid, 'w30040833');
  assert.strictEqual(loaded.access_token, undefined);
  assert.strictEqual(loadSession(dir).access_token, undefined);
});

test('legacy W3 auth.bin (no epoch, no JWT) → getTokenUsageContext returns null, epoch still upgraded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-'));
  const user = { id: '00485973', username: '00485973', role: 'user' };
  saveSession(dir, { uid: '00485973', user, w3: true });   // 旧版 W3 登录写入的形状

  const ctx = getTokenUsageContext(dir, { nowMs: 9000, epochId: 'w3-upgrade' });
  assert.strictEqual(ctx, null);  // 无 JWT → 不兜底 w3:<uid>，返回 null
  const reloaded = loadSession(dir);
  assert.strictEqual(reloaded.w3, true);
  assert.strictEqual(reloaded.uid, '00485973');
  assert.strictEqual(reloaded.token_usage_epoch.id, 'w3-upgrade');
});

test('getSessionW3: whitelist NEEDS_PASSWORD → pass through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-'));
  const user = { id: '00485973', username: '00485973', role: 'user' };
  saveSession(dir, w3SessionWithFreshTokenUsageEpoch('00485973', user));

  const u = await getSessionW3({
    cloudBaseUrl: 'https://cloud.example',
    appDataDir: dir,
    fetchImpl: async () => ({ json: async () => ({ status: 'NEEDS_PASSWORD' }) }),
  });
  assert.deepStrictEqual(u, user);
  assert.notStrictEqual(loadSession(dir), null);
});

test('getSessionW3: NOT_ALLOWED → clear session and require re-login', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-'));
  const user = { id: '00485973', username: '00485973', role: 'user' };
  saveSession(dir, w3SessionWithFreshTokenUsageEpoch('00485973', user));

  const u = await getSessionW3({
    cloudBaseUrl: 'https://cloud.example',
    appDataDir: dir,
    fetchImpl: async () => ({ json: async () => ({ status: 'NOT_ALLOWED' }) }),
  });
  assert.strictEqual(u, null);
  assert.strictEqual(loadSession(dir), null);
});

test('getSessionW3: cloud unreachable → fall back to local session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-'));
  const user = { id: '00485973', username: '00485973', role: 'user' };
  saveSession(dir, w3SessionWithFreshTokenUsageEpoch('00485973', user));

  const u = await getSessionW3({
    cloudBaseUrl: 'https://cloud.example',
    appDataDir: dir,
    fetchImpl: async () => { throw new Error('fetch failed'); },
  });
  assert.deepStrictEqual(u, user);
  assert.notStrictEqual(loadSession(dir), null);
});

test('getSessionW3: legacy OAuth session (no w3 flag) is not a valid W3 session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-'));
  const payload = Buffer.from(JSON.stringify({ sub: 'user-b' })).toString('base64url');
  saveSession(dir, { access_token: `header.${payload}.signature`, user: { id: 'user-b', username: 'bob' } });

  const u = await getSessionW3({ cloudBaseUrl: '', appDataDir: dir });
  assert.strictEqual(u, null);
});

test('getSessionW3: session without JWT is refreshed from Python backend on restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-refresh-'));
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  // 旧版 session：有 uid 但没有 access_token
  saveSession(dir, { uid: 'w30040833', user, w3: true, token_usage_epoch: { id: 'e1', user_id: 'w30040833', not_before_ms: 100 } });

  // 用合法 JWT 格式（exp 远未来），否则 loadSession 会因 jwtExpired 丢弃
  const payload = Buffer.from(JSON.stringify({ sub: 'w30040833', exp: 9999999999 })).toString('base64url');
  const validJwt = `header.${payload}.signature`;

  let refreshCalled = false;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/w3/refresh-token')) {
      refreshCalled = true;
      return { ok: true, json: async () => ({ access_token: validJwt }) };
    }
    // precheck
    return { json: async () => ({ status: 'NEEDS_PASSWORD' }) };
  };

  const u = await getSessionW3({
    cloudBaseUrl: 'https://cloud.example',
    appDataDir: dir,
    pythonBackendUrl: 'http://127.0.0.1:8080',
    fetchImpl,
  });
  assert.deepStrictEqual(u, user);
  assert.strictEqual(refreshCalled, true);
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = loadSession(dir);
  assert.strictEqual(reloaded.access_token, validJwt);
});

test('getSessionW3: JWT refresh runs in background and does not block verified user restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-refresh-bg-'));
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  saveSession(dir, w3SessionWithFreshTokenUsageEpoch('w30040833', user));

  let resolveRefresh;
  const refreshResponse = new Promise((resolve) => { resolveRefresh = resolve; });
  const fetchImpl = async (url) => {
    if (url.includes('/w3/refresh-token')) return refreshResponse;
    return { json: async () => ({ status: 'NEEDS_PASSWORD' }) };
  };

  const restored = await getSessionW3({
    cloudBaseUrl: 'https://cloud.example',
    appDataDir: dir,
    pythonBackendUrl: 'http://127.0.0.1:8080',
    fetchImpl,
  });

  assert.deepStrictEqual(restored, user);
  resolveRefresh({ ok: true, json: async () => ({ access_token: '' }) });
});

test('getSessionW3: refresh failure does not block session restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-auth-w3-refresh-fail-'));
  const user = { id: 'w30040833', username: 'w30040833', role: 'user' };
  saveSession(dir, { uid: 'w30040833', user, w3: true, token_usage_epoch: { id: 'e1', user_id: 'w30040833', not_before_ms: 100 } });

  const fetchImpl = async (url) => {
    if (url.includes('/w3/refresh-token')) throw new Error('backend down');
    return { json: async () => ({ status: 'NEEDS_PASSWORD' }) };
  };

  const u = await getSessionW3({
    cloudBaseUrl: 'https://cloud.example',
    appDataDir: dir,
    pythonBackendUrl: 'http://127.0.0.1:8080',
    fetchImpl,
  });
  assert.deepStrictEqual(u, user);
  const reloaded = loadSession(dir);
  assert.strictEqual(reloaded.access_token, undefined); // 没补到 JWT，但不阻断
});

test('NotInWhitelistError carries the whitelist contact message', () => {
  const e = new NotInWhitelistError();
  assert.strictEqual(e.name, 'NotInWhitelistError');
  assert.match(e.message, /00485973/);
});
