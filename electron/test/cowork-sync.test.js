'use strict';
// 套件对账（lib/cowork-sync.js + lib/substrate.js）。
//
// 契约见 netcowork 仓 doc/DESKTOP_AGENT_PACKAGE_API.md：
//   GET /api/me/agents               → [{ agentId, version }]  version 是**递增整数**
//   GET /api/me/agents/<id>/package  → zip + X-Package-Sha256 / X-Package-Version
//
// 这一组钉的全是"写反了也不报错"的地方：对账失败时动了本地、把一次下载失败当成收回、
// 把回滚当成"不用装"。它们的共同表现是**用户的智能体莫名其妙少了几个**。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { syncCoworkPackages, installedVersions, ENTITLED_FILE } = require('../lib/cowork-sync');
const { createSubstrate, trimUrl, filenameFrom } = require('../lib/substrate');

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `nlc-${name}-`));
  return d;
}

/** 造一个已装目录：{ id: version }。 */
function installed(dirs) {
  const root = tmp('coworks');
  for (const [id, version] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'cowork.json'),
      JSON.stringify({ id, version }), 'utf8');
  }
  return root;
}

/** 假 substrate：给什么清单、哪些下载会失败。 */
function fakeSubstrate({ agents, fail = {}, bytes = Buffer.from('zip') }) {
  return {
    async listAgents() {
      return agents ? { ok: true, agents } : { ok: false, reason: '未登录' };
    },
    async downloadAgentPackage(id) {
      if (fail[id]) return { ok: false, reason: fail[id], status: 502 };
      return { ok: true, buf: bytes, version: null, sha256: null, filename: `${id}.zip` };
    },
  };
}

const quiet = () => {};

// ── 对账失败 = 一动不动 ───────────────────────────────────────────────────────

test('清单取不到时不写 entitled、不动暂存目录', async () => {
  // **这一条是整组里最重要的。** 把网络故障当成权限被收回，后果是把用户的套件连同
  // 他改过的提示词删掉，且不可逆；反过来（该删没删）只是晚一天生效。两个方向的错
  // 不对称，所以往安全的一侧偏。
  const staging = tmp('staging');
  const r = await syncCoworkPackages({
    substrate: fakeSubstrate({ agents: null }),
    stagingDir: staging, coworksDir: installed({ ipmaster: 3 }), log: quiet,
  });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(fs.readdirSync(staging), [], '失败时碰了暂存目录');
});

// ── 版本相等就跳过；回滚要装 ──────────────────────────────────────────────────

test('版本相同的不下载', async () => {
  const r = await syncCoworkPackages({
    substrate: fakeSubstrate({ agents: [{ agentId: 'ipmaster', version: 3 }] }),
    stagingDir: tmp('staging'), coworksDir: installed({ ipmaster: 3 }), log: quiet,
  });
  assert.deepStrictEqual(r.unchanged, ['ipmaster']);
  assert.deepStrictEqual(r.downloaded, []);
});

test('版本变小（管理员回滚）照样要下载', async () => {
  // version 是递增整数，回滚时会变小。写成"变大才装"的现象是
  // "我明明回滚了他还在用新版"，而且不报错。
  const r = await syncCoworkPackages({
    substrate: fakeSubstrate({ agents: [{ agentId: 'ipmaster', version: 2 }] }),
    stagingDir: tmp('staging'), coworksDir: installed({ ipmaster: 5 }), log: quiet,
  });
  assert.deepStrictEqual(r.downloaded, ['ipmaster'], '回滚没下载');
});

// ── 一次失败 ≠ 被收回 ─────────────────────────────────────────────────────────

test('下载失败的那个仍然算「该有」，不进收回名单', async () => {
  // 一次 502 不该等于替对方做了收回决定（需求 C9）。
  const staging = tmp('staging');
  const r = await syncCoworkPackages({
    substrate: fakeSubstrate({
      agents: [{ agentId: 'ipmaster', version: 9 }, { agentId: 'mbb', version: 1 }],
      fail: { ipmaster: '发不出去' },
    }),
    stagingDir: staging, coworksDir: installed({ ipmaster: 3 }), log: quiet,
  });
  assert.strictEqual(r.ok, true, '一个坏包不该让整批不算数');
  assert.deepStrictEqual(r.failed.map(f => f.agentId), ['ipmaster']);
  assert.deepStrictEqual(r.revoked, [], '下载失败被当成了收回');

  const e = JSON.parse(fs.readFileSync(path.join(staging, ENTITLED_FILE), 'utf8'));
  assert.ok(e.agents.includes('ipmaster'), 'entitled 里必须还有它 —— 后端据此判要不要删');
});

test('清单里没有的才算收回', async () => {
  const r = await syncCoworkPackages({
    substrate: fakeSubstrate({ agents: [{ agentId: 'mbb', version: 1 }] }),
    stagingDir: tmp('staging'), coworksDir: installed({ ipmaster: 3, mbb: 1 }), log: quiet,
  });
  assert.deepStrictEqual(r.revoked, ['ipmaster']);
});

test('母版不算被收回', async () => {
  // default 是模板继承的母版，不是 cowork —— 它永远不在授权清单里。
  const r = await syncCoworkPackages({
    substrate: fakeSubstrate({ agents: [] }),
    stagingDir: tmp('staging'), coworksDir: installed({ default: 1 }), log: quiet,
  });
  assert.deepStrictEqual(r.revoked, []);
});

// ── 完整性校验 ────────────────────────────────────────────────────────────────

test('sha256 对不上就不落盘', async () => {
  // 装一份"不知道是什么"的套件，比这次不更新危险得多。
  const staging = tmp('staging');
  const bad = {
    async listAgents() { return { ok: true, agents: [{ agentId: 'ipmaster', version: 1 }] }; },
    async downloadAgentPackage() {
      return { ok: true, buf: Buffer.from('zip'), sha256: 'f'.repeat(64), version: 1 };
    },
  };
  const r = await syncCoworkPackages({
    substrate: bad, stagingDir: staging, coworksDir: installed({}), log: quiet,
  });
  assert.deepStrictEqual(r.downloaded, []);
  assert.strictEqual(r.failed[0].reason, 'sha256 对不上');
  assert.deepStrictEqual(fs.readdirSync(staging), [ENTITLED_FILE], '半个坏包落盘了');
});

// ── installedVersions ─────────────────────────────────────────────────────────

test('读不出 cowork.json 的目录当作没装', async () => {
  // 当作没装 → 下次照常下载覆盖。当作"装了未知版本"会永远跳过，那才要命。
  const root = installed({ good: 3 });
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(path.join(root, 'broken', 'cowork.json'), '{ 坏的', 'utf8');
  assert.deepStrictEqual(installedVersions(root), { good: '3' });
});

// ── substrate 客户端 ──────────────────────────────────────────────────────────

test('没配地址 / 没登录都返回 ok:false，且不发请求', async () => {
  // **没配 ≠ 出错**：这个部署就是没有云端，应用照常开（需求 C11）。
  let called = 0;
  const mk = (base, token) => createSubstrate({
    getBaseUrl: () => base, getToken: () => token, log: quiet,
    fetchImpl: async () => { called += 1; return new Response('[]'); },
  });
  assert.strictEqual((await mk('', 'tok').listAgents()).reason, '未配置 substrate 地址');
  assert.strictEqual((await mk('http://x', '').listAgents()).reason, '未登录');
  assert.strictEqual(called, 0, '前置条件不满足时不该发请求');
});

test('清单里读不懂的那一条跳过，其余照常', async () => {
  // 一条写错不该让这个人一个智能体都没有 —— 那与"没授权"长得一模一样。
  const s = createSubstrate({
    getBaseUrl: () => 'http://x', getToken: () => 'tok', log: quiet,
    fetchImpl: async () => new Response(JSON.stringify([
      { agentId: 'ok', version: 3 },
      { agentId: '', version: 1 },
      { agentId: 'bad', version: 'not-a-number' },
    ]), { headers: { 'content-type': 'application/json' } }),
  });
  const r = await s.listAgents();
  assert.deepStrictEqual(r.agents, [{ agentId: 'ok', version: 3 }]);
});

test('带上 Bearer 令牌', async () => {
  let seen = null;
  const s = createSubstrate({
    getBaseUrl: () => 'http://x', getToken: () => 'tok', log: quiet,
    fetchImpl: async (_u, opts) => { seen = opts.headers.Authorization; return new Response('[]'); },
  });
  await s.listAgents();
  assert.strictEqual(seen, 'Bearer tok');
});

test('下载读的是响应头里的三个字段', async () => {
  const s = createSubstrate({
    getBaseUrl: () => 'http://x/', getToken: () => 'tok', log: quiet,
    fetchImpl: async () => new Response(Buffer.from('zipbytes'), {
      headers: {
        'x-package-version': '7',
        'x-package-sha256': 'ABCDEF',
        'content-disposition': 'attachment; filename="ipmaster-agent-v7.zip"',
      },
    }),
  });
  const r = await s.downloadAgentPackage('ipmaster');
  assert.strictEqual(r.version, 7);
  assert.strictEqual(r.sha256, 'abcdef', 'sha 要归一成小写，否则比对永远不等');
  assert.strictEqual(r.filename, 'ipmaster-agent-v7.zip');
});

test('地址尾部斜杠不会拼出双斜杠', () => {
  assert.strictEqual(trimUrl('http://x/substrate/'), 'http://x/substrate');
});

test('取不到文件名时返回空串（调用方回落到 <id>.zip）', () => {
  assert.strictEqual(filenameFrom(''), '');
  assert.strictEqual(filenameFrom('attachment; filename="a.zip"'), 'a.zip');
});
