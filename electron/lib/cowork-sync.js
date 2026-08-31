// 智能体套件对账 —— 「我被授权了哪几个」与本机已装的差在哪，把差的补上。
//
// 契约见运维的《智能体套件下发 —— 最小对接契约》：
//   GET /api/me/agents                    → [{ agentId, version }]   version 是递增整数
//   GET /api/me/agents/<id>/package       → zip 原文 + X-Package-Sha256
//
// **这一段只负责把 zip 摆进一个目录**，装是后端的事（cowork_install.install_from_dir）。
// 分这一刀是因为令牌在这边（用户令牌只有主进程有），而解包/校验/版本比对的逻辑早就在后端
// 且两种部署共用——把它们搬到一起，两边就得各写一份。
//
// 目录里除了 zip 还写一份 entitled.json：
//
//     { "agents": ["ipmaster", "mbb"], "syncedAt": "..." }
//
// **它是"该有哪几个"的唯一凭据**，后端据此删掉多余的（= 权限被收回）。为什么不让后端直接
// 看目录里有几个 zip：版本没变的我们根本不下载，那个 zip 不在目录里——按目录判会把它当成
// 被收回而删掉，于是每次启动都要重下一遍全部套件才能不被误删。
//
// **对账失败就整个不动**：不写 entitled.json、不动已有的 zip。后端看不到新的凭据就沿用上
// 一次的结论。网络抖一下把人家的智能体全删了，比"今天没更新到"严重得多。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENTITLED_FILE = 'entitled.json';

/** 已装版本：<dataDir>/coworks/<id>/cowork.json 的 version。读不到就当没装。 */
function installedVersions(coworksDir) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(coworksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return out; }
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(coworksDir, name, 'cowork.json'), 'utf8');
      const v = JSON.parse(raw).version;
      if (v !== undefined && v !== null) out[name] = String(v);
    } catch { /* 读不出就当没装，下次照常下载覆盖 */ }
  }
  return out;
}

/**
 * 跑一次对账。返回 { ok, downloaded, unchanged, failed, revoked, reason }。
 *
 * `ok:false` 表示这次不算数 —— 调用方不该据此做任何删除。
 */
async function syncCoworkPackages({ substrate, stagingDir, coworksDir, log = () => {} }) {
  const listed = await substrate.listAgents();
  if (!listed.ok) {
    log('warn', `智能体清单取不到：${listed.reason} —— 本地保持不变`);
    return { ok: false, reason: listed.reason, downloaded: [], unchanged: [], failed: [], revoked: [] };
  }

  const installed = installedVersions(coworksDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  const downloaded = [];
  const unchanged = [];
  const failed = [];

  for (const { agentId, version } of listed.agents) {
    // **相等比较，不是"变大才装"**：version 是递增整数，管理员回滚时它会变小，
    // 而回滚同样要装下去。
    if (installed[agentId] === String(version)) {
      unchanged.push(agentId);
      continue;
    }
    const r = await substrate.downloadAgentPackage(agentId);
    if (!r.ok) {
      // 单个失败不拖垮整批：一个坏包让全部装不上，会把"某个包发错了"放大成
      // "这个人一个智能体都没有"，而后者与"他没授权"长得一模一样。
      const why = r.reason || `HTTP ${r.status}`;
      log('warn', `套件下载失败 ${agentId}@${version}：${why}`);
      failed.push({ agentId, reason: why, status: r.status });
      continue;
    }
    if (r.sha256) {
      const got = crypto.createHash('sha256').update(r.buf).digest('hex');
      if (got !== r.sha256) {
        // 装一份"不知道是什么"的套件，比这次不更新危险得多。
        log('warn', `套件校验不过 ${agentId}：头里说 ${r.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…`);
        failed.push({ agentId, reason: 'sha256 对不上' });
        continue;
      }
    }
    // 文件名带上 id 与版本：装的那侧按包内 manifest 判，但人来翻这个目录时得一眼看懂。
    const dest = path.join(stagingDir, `${agentId}-cowork-${version}.zip`);
    writeAtomic(dest, r.buf);
    downloaded.push(agentId);
  }

  // 清掉本次没出现的旧 zip：留着的话，下次它的 id 又出现在目录里，而 entitled.json 里没有
  // ——不影响正确性（判据是 entitled.json），但翻目录的人会以为它还在用。
  const keepFiles = new Set([
    ...downloaded.map((id) => zipNameOf(listed.agents, id)),
    ENTITLED_FILE,
  ]);
  for (const f of safeReaddir(stagingDir)) {
    if (!keepFiles.has(f)) { try { fs.unlinkSync(path.join(stagingDir, f)); } catch { /* 删不掉无所谓 */ } }
  }

  // 下载失败的**照样算"该有"**：一次 404 不该等于替对方做了收回决定。
  const entitled = listed.agents.map((a) => a.agentId);
  writeAtomic(path.join(stagingDir, ENTITLED_FILE), Buffer.from(JSON.stringify({
    agents: entitled.sort(),
    syncedAt: new Date().toISOString(),
  }, null, 2), 'utf8'));

  const revoked = Object.keys(installed).filter((id) => id !== 'default' && !entitled.includes(id));
  log('info', `智能体对账：下载 ${downloaded.length}、未变 ${unchanged.length}`
    + `、失败 ${failed.length}、将被收回 ${revoked.length}`);
  return { ok: true, downloaded, unchanged, failed, revoked };
}

function zipNameOf(agents, agentId) {
  const a = agents.find((x) => x.agentId === agentId);
  return a ? `${agentId}-cowork-${a.version}.zip` : '';
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** 先写临时文件再改名：写到一半崩了不会留下半个 zip 让后端去解。 */
function writeAtomic(dest, buf) {
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

module.exports = { syncCoworkPackages, installedVersions, ENTITLED_FILE };
