'use strict';

// substrate（云端管理服务）客户端 —— **只管两件事**：这个人被授权了哪几个 cowork、
// 把某一个的套件包取回来。
//
// 契约（照 demo/experimental 的同一份形状）：
//
//   GET <base>/api/me/agents                 → [{ agentId, version }]  version 是递增整数
//   GET <base>/api/me/agents/<id>/package    → zip 原文 + X-Package-Sha256 / X-Package-Version
//
// **为什么在主进程**：这两个调用都要带**用户令牌**，而令牌只存在主进程的安全存储里
// （需求 B2）。后端拿不到，所以取包这一步只能在这边做，取完把 zip 摆进暂存目录交给后端
// （需求 C3）。想"统一成后端直发"的话，最后一定会变成把令牌递给后端 —— 那正好破坏
// 令牌不出主进程这条。
//
// **每个入口都不抛**：地址没配 / 没登录 / 网络不通，一律返回 { ok:false, reason }。
// 上层据此"这次不算数、本地不动"（需求 C7）—— 把网络故障当成权限被收回，
// 后果是把用户的套件连同他改过的提示词删掉，且不可逆。

const TIMEOUT_MS = 30_000;

/** 去掉尾部斜杠；拿不到就空串（调用方据此判定"这个部署没有云端"）。 */
function trimUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

/** Content-Disposition 里的文件名。取不到返回空串。 */
function filenameFrom(header) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(header || ''));
  return m ? decodeURIComponent(m[1]).trim() : '';
}

/**
 * 造一个 substrate 客户端。
 *
 * @param {object} deps
 * @param {function} deps.getBaseUrl  () => string   **每次现取** —— 地址来自 app-config，
 *                                    而那份在启动时会被 force 复位，缓存住会用到旧值。
 * @param {function} deps.getToken    () => string   用户令牌；空 = 未登录。
 * @param {function} [deps.log]       (level, msg) => void
 * @param {function} [deps.fetchImpl] 注入用（测试）。
 */
function createSubstrate({ getBaseUrl, getToken, log = () => {}, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;

  /** 共同的前置：地址配了吗、登录了吗。返回 { base, token } 或 { reason }。 */
  function ready(what) {
    const base = trimUrl(getBaseUrl());
    if (!base) {
      // **没配 ≠ 出错**：这个部署就是没有云端，应用照常开（需求 C11）。
      log('info', `${what}：未配置 substrate 地址，跳过`);
      return { reason: '未配置 substrate 地址' };
    }
    const token = String(getToken() || '').trim();
    if (!token) {
      // 未登录与"没有权限"必须分开说（需求 B4）：说成"尚未开通"会把人送去找管理员，
      // 而他只需要登录一下。
      log('info', `${what}：未登录，跳过`);
      return { reason: '未登录' };
    }
    return { base, token };
  }

  async function call(url, token, { binary = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await doFetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!r.ok) {
        let msg = '';
        try { msg = (await r.json())?.message || ''; } catch { /* 不是 json 就算了 */ }
        return { ok: false, status: r.status, reason: msg || `substrate 返回 ${r.status}` };
      }
      if (binary) {
        return { ok: true, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
      }
      return { ok: true, json: await r.json() };
    } catch (e) {
      // 连不上 / DNS / TLS / 超时。**带上 URL** —— 不然"连不上"这三个字帮不了任何人。
      return { ok: false, reason: `${e && e.name === 'AbortError' ? '超时' : '连不上'}：${url}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 这个人被授权了哪几个。`{ ok, agents: [{ agentId, version }] }` */
  async function listAgents() {
    const pre = ready('listAgents');
    if (pre.reason) return { ok: false, reason: pre.reason };

    const url = `${pre.base}/api/me/agents`;
    log('info', `listAgents: GET ${url}`);
    const r = await call(url, pre.token);
    if (!r.ok) return { ok: false, status: r.status, reason: r.reason };
    if (!Array.isArray(r.json)) return { ok: false, reason: '清单不是数组' };

    const agents = [];
    for (const it of r.json) {
      const id = String((it && it.agentId) || '').trim();
      const version = Number(it && it.version);
      if (!id || !Number.isFinite(version)) {
        // **一条写错不该让这个人一个都没有** —— 那与"没授权"长得一模一样。
        log('warn', `清单里有一条读不懂，跳过：${JSON.stringify(it)}`);
        continue;
      }
      agents.push({ agentId: id, version });
    }
    return { ok: true, agents };
  }

  /** 取某个 cowork 当前发布的那一版。`{ ok, buf, version, sha256, filename }` */
  async function downloadAgentPackage(agentId) {
    const pre = ready('downloadAgentPackage');
    if (pre.reason) return { ok: false, reason: pre.reason };

    const url = `${pre.base}/api/me/agents/${encodeURIComponent(agentId)}/package`;
    log('info', `downloadAgentPackage: GET ${url}`);
    const r = await call(url, pre.token, { binary: true });
    if (!r.ok) return { ok: false, status: r.status, reason: r.reason };

    const get = (k) => (r.headers && typeof r.headers.get === 'function' ? r.headers.get(k) : '') || '';
    return {
      ok: true,
      buf: r.buf,
      version: Number(get('x-package-version')) || null,
      // 哈希防的是**传输损坏与截断**。防篡改是签名的事（需求 C8/§D）——
      // 哈希与包走同一条通道，能改包的人也能改哈希。
      sha256: (get('x-package-sha256') || '').trim().toLowerCase() || null,
      filename: filenameFrom(get('content-disposition')) || `${agentId}.zip`,
    };
  }

  return { listAgents, downloadAgentPackage };
}

module.exports = { createSubstrate, trimUrl, filenameFrom };
