'use strict';

const crypto = require('crypto');
const http = require('http');

const HOST = '127.0.0.1';
const SEARCH_PATH = '/v1/search';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESULTS = 10;
const MAX_CANDIDATE_RESULTS = 30;
const FIRST_PROVIDER_TIMEOUT_MS = 12_000;
const FALLBACK_PROVIDER_TIMEOUT_MS = 10_000;
const RESULT_POLL_ATTEMPTS = 9;
const RESULT_POLL_INTERVAL_MS = 500;
const RESULT_STABLE_SAMPLES = 4;
const RESULT_MIN_SETTLE_ATTEMPT = 4;
const ALLOWED_FIELDS = new Set(['query', 'max_results', 'language']);

const PROVIDER_CONFIGS = {
  baidu: {
    label: 'Baidu',
    baseUrl: 'https://www.baidu.com/s',
    queryParam: 'wd',
    roots: ['baidu.com'],
    searchPaths: ['/s', '/s/'],
    configureUrl(url, { maxResults }) {
      url.searchParams.set('rn', String(maxResults));
      url.searchParams.set('ie', 'utf-8');
    },
    extractor: `(() => ({
      pageQuery: document.querySelector('#kw, input[name="wd"]')?.value || '',
      challenge: location.hostname === 'wappass.baidu.com'
        || location.pathname.includes('/captcha/')
        || Boolean(document.querySelector('[class*="captcha"], [id*="captcha"]')),
      results: Array.from(document.querySelectorAll('#content_left .result, #content_left .result-op')).map((item) => {
        const link = item.querySelector('h3 a');
        const landing = item.getAttribute('mu') || link?.getAttribute('data-landurl') || '';
        const snippet = item.querySelector('.c-abstract, [class*="summary"], [class*="content-right"]');
        return {
          title: link?.textContent,
          url: /^https?:\/\//i.test(landing) ? landing : link?.href,
          snippet: snippet?.textContent || item.textContent,
        };
      }),
    }))()`,
  },
  bing: {
    label: 'Bing',
    baseUrl: 'https://www.bing.com/search',
    queryParam: 'q',
    roots: ['bing.com'],
    searchPaths: ['/search', '/search/'],
    configureUrl(url, { maxResults, language }) {
      url.searchParams.set('count', String(maxResults));
      url.searchParams.set('setlang', language);
      if (/^[A-Za-z]{2,3}-[A-Za-z]{2}$/.test(language)) url.searchParams.set('mkt', language);
    },
    extractor: `(() => ({
    pageQuery: document.querySelector('#sb_form_q, input[name="q"]')?.value || '',
    challenge: Boolean(document.querySelector('#b_captcha, .b_captcha, [id*="captcha"]')),
    results: Array.from(document.querySelectorAll('li.b_algo')).map((item) => {
      const link = item.querySelector('h2 a');
      const snippet = item.querySelector('.b_caption p, .b_snippet, p');
      return { title: link?.textContent, url: link?.href, snippet: snippet?.textContent };
    }),
    }))()`,
  },
  sogou: {
    label: 'Sogou',
    baseUrl: 'https://www.sogou.com/web',
    queryParam: 'query',
    roots: ['sogou.com'],
    searchPaths: ['/web', '/web/'],
    configureUrl(url) {
      url.searchParams.set('ie', 'utf8');
    },
    extractor: `(() => ({
      pageQuery: document.querySelector('#upquery, #query, input.query[name="query"]')?.value || '',
      challenge: location.pathname.startsWith('/antispider/')
        || Boolean(document.querySelector('#seccodeInput, [class*="antispider"]')),
      results: Array.from(document.querySelectorAll('.results .vrwrap, .results .rb')).map((item) => {
        const link = item.querySelector('h3 a');
        const landing = link?.getAttribute('data-url')
          || item.querySelector('[data-url]')?.getAttribute('data-url') || '';
        const snippet = item.querySelector('.str-text-info, .str_info, [class*="text-info"], p');
        return {
          title: link?.textContent,
          url: /^https?:\/\//i.test(landing) ? landing : link?.href,
          snippet: snippet?.textContent || item.textContent,
        };
      }),
    }))()`,
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    baseUrl: 'https://html.duckduckgo.com/html/',
    queryParam: 'q',
    roots: ['duckduckgo.com'],
    searchPaths: ['/html', '/html/'],
    extractor: `(() => ({
    pageQuery: document.querySelector('#search_form_input, input[name="q"]')?.value || '',
    challenge: Boolean(document.querySelector('.anomaly-modal, [class*="challenge"]')),
    results: Array.from(document.querySelectorAll('.result, .web-result')).map((item) => {
      const link = item.querySelector('.result__a, h2 a');
      const snippet = item.querySelector('.result__snippet, .result__body, p');
      return { title: link?.textContent, url: link?.href, snippet: snippet?.textContent };
    }),
    }))()`,
  },
  google: {
    label: 'Google',
    baseUrl: 'https://www.google.com/search',
    queryParam: 'q',
    roots: ['google.com', 'google.com.hk', 'google.com.sg'],
    searchPaths: ['/search', '/search/'],
    configureUrl(url, { maxResults, language }) {
      url.searchParams.set('num', String(maxResults));
      url.searchParams.set('hl', language);
      url.searchParams.set('pws', '0');
    },
    extractor: `(() => ({
      pageQuery: document.querySelector('textarea[name="q"], input[name="q"]')?.value || '',
      challenge: location.pathname.startsWith('/sorry/')
        || Boolean(document.querySelector('#captcha-form, iframe[src*="recaptcha"]')),
      results: Array.from(document.querySelectorAll('#search a')).filter((link) => link.querySelector('h3')).map((link) => {
        const item = link.closest('.MjjYud, .g') || link.parentElement;
        const snippet = item?.querySelector('.VwiC3b, [data-sncf], .IsZvec');
        return { title: link.querySelector('h3')?.textContent, url: link.href, snippet: snippet?.textContent };
      }),
    }))()`,
  },
};

const CHINESE_PROVIDER_ORDER = ['baidu', 'bing', 'sogou', 'duckduckgo', 'google'];
const DEFAULT_PROVIDER_ORDER = ['bing', 'duckduckgo', 'google', 'baidu', 'sogou'];

const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'for', 'from', 'how', 'in', 'is', 'of', 'on', 'or',
  'please', 'search', 'the', 'to', 'what', 'web', 'with',
]);

function errorWithCode(code, message) {
  return Object.assign(new Error(message), { code });
}

function cleanText(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanUrl(value) {
  try {
    let url = new URL(String(value || ''));
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (target) url = new URL(target);
    }
    if (url.hostname.endsWith('bing.com') && url.pathname === '/ck/a') {
      const encoded = String(url.searchParams.get('u') || '').replace(/^a1/, '');
      if (encoded) {
        const target = Buffer.from(encoded, 'base64url').toString('utf8');
        if (/^https?:\/\//i.test(target)) url = new URL(target);
      }
    }
    if (url.hostname.includes('google.') && url.pathname === '/url') {
      const target = url.searchParams.get('q') || url.searchParams.get('url');
      if (target) url = new URL(target);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return '';
    if ((host === 'www.baidu.com' || host === 'baidu.com') && url.pathname === '/link') return '';
    if ((host === 'www.sogou.com' || host === 'sogou.com') && url.pathname === '/link') return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    return url.toString();
  } catch (_) {
    return '';
  }
}

function cleanResults(raw, limit) {
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const title = cleanText(item && item.title, 300);
    const url = cleanUrl(item && item.url);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: cleanText(item.snippet, 1000) });
    if (results.length >= limit) break;
  }
  return results;
}

function normalizeQuery(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/\s+/g, ' ').trim();
}

function querySignals(value) {
  const normalized = normalizeQuery(value);
  const words = (normalized.replace(/\p{Script=Han}+/gu, ' ').match(/[\p{L}\p{N}]+/gu) || [])
    .filter((word) => !QUERY_STOP_WORDS.has(word));
  const hasWords = words.length > 0;
  const han = [];
  for (let run of normalized.match(/\p{Script=Han}+/gu) || []) {
    if (hasWords) run = run.replace(/^[的与和及]+/u, '');
    const characters = [...run];
    if (characters.length === 0) continue;
    if (characters.length <= 2) han.push(run);
    else {
      for (let index = 0; index < characters.length - 1; index += 1) {
        han.push(characters.slice(index, index + 2).join(''));
      }
    }
  }
  return { han: [...new Set(han)], words: [...new Set(words)] };
}

function filterResultsByQuery(results, query) {
  const signals = querySignals(query);
  const hasSignals = signals.han.length > 0 || signals.words.length > 0;
  if (!hasSignals) return [];
  const compactQuery = normalizeQuery(query).replace(/[^\p{L}\p{N}]+/gu, '');
  const requiredHan = signals.han.length <= 1
    ? signals.han.length
    : Math.max(2, Math.ceil(signals.han.length * 0.4));
  const requiredWords = signals.words.length <= 1
    ? signals.words.length
    : Math.max(2, Math.ceil(signals.words.length / 2));
  return results.filter((item) => {
    const text = normalizeQuery(`${item.title || ''} ${item.snippet || ''}`);
    if (!text) return false;
    if (compactQuery && text.replace(/[^\p{L}\p{N}]+/gu, '').includes(compactQuery)) return true;
    const hanHits = signals.han.filter((term) => text.includes(term)).length;
    const textWords = new Set(
      text.replace(/\p{Script=Han}+/gu, ' ').match(/[\p{L}\p{N}]+/gu) || [],
    );
    const wordHits = signals.words.filter((term) => textWords.has(term)).length;
    return hanHits >= requiredHan && wordHits >= requiredWords;
  });
}

function resultSetSignature(results) {
  if (results.length === 0) return '';
  return JSON.stringify(results.map((item) => [item.title, item.url]));
}

function pageMatchesQuery(provider, raw, query) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const config = PROVIDER_CONFIGS[provider];
  if (!config) return false;
  const actualUrl = cleanUrl(raw.searchPage && raw.searchPage.url);
  if (!actualUrl || !allowedNavigation(actualUrl, provider)) return false;
  const parsed = new URL(actualUrl);
  if (!config.searchPaths.includes(parsed.pathname)) return false;
  const expected = normalizeQuery(query);
  const observed = [parsed.searchParams.get(config.queryParam), raw.pageQuery]
    .map(normalizeQuery)
    .filter(Boolean);
  return observed.length > 0 && observed.every((value) => value === expected);
}

function providerOrder(language, query) {
  const text = String(query || '');
  if (/\p{Script=Han}/u.test(text)) return CHINESE_PROVIDER_ORDER;
  if (/[\p{L}\p{N}]/u.test(text)) return DEFAULT_PROVIDER_ORDER;
  return normalizeQuery(language).startsWith('zh') ? CHINESE_PROVIDER_ORDER : DEFAULT_PROVIDER_ORDER;
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw errorWithCode('INVALID_REQUEST', 'request body must be a JSON object');
  }
  if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw errorWithCode('INVALID_REQUEST', 'request contains an unsupported field');
  }
  const query = String(body.query || '').replace(/\s+/g, ' ').trim();
  if (!query || query.length > 500) {
    throw errorWithCode('INVALID_REQUEST', 'query must contain 1-500 characters');
  }
  const maxResults = body.max_results === undefined ? 8 : body.max_results;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw errorWithCode('INVALID_REQUEST', `max_results must be an integer between 1 and ${MAX_RESULTS}`);
  }
  const language = String(body.language || 'zh-CN').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw errorWithCode('INVALID_REQUEST', 'language must be a valid language tag');
  }
  return { query, maxResults, language };
}

function searchUrl(provider, { query, maxResults, language }) {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) throw errorWithCode('SEARCH_UNAVAILABLE', 'unknown search provider');
  const url = new URL(config.baseUrl);
  url.searchParams.set(config.queryParam, query);
  config.configureUrl?.(url, { query, maxResults, language });
  return url.toString();
}

function cleanSearchPage(provider, raw, params) {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) return null;
  const actualUrl = cleanUrl(raw && raw.url);
  if (!actualUrl || !allowedNavigation(actualUrl, provider)) return null;
  return {
    // Never expose a provider-generated URL carrying session/click identifiers to
    // the persistent in-app browser. Rebuild the same semantic search request so
    // opening the source performs a fresh search for the complete query.
    url: searchUrl(provider, params),
    title: cleanText(`${config.label} 搜索：${params.query}`, 300),
  };
}

function allowedNavigation(value, provider) {
  try {
    const config = PROVIDER_CONFIGS[provider];
    if (!config) return false;
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return config.roots.some((root) => host === root || host.endsWith(`.${root}`));
  } catch (_) {
    return false;
  }
}

function abortRace(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

function delay(ms, signal) {
  return abortRace(new Promise((resolve) => setTimeout(resolve, ms)), signal);
}

async function electronExecutor({ BrowserWindow, session, log }) {
  if (typeof BrowserWindow !== 'function' || !session?.fromPartition) {
    throw new TypeError('BrowserWindow and session are required');
  }
  const isolated = session.fromPartition(`ipmc-web-search-${crypto.randomUUID()}`, { cache: false });
  await isolated.setProxy({ mode: 'system' });
  isolated.allowNTLMCredentialsForDomains('*');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (isolated.setPermissionCheckHandler) isolated.setPermissionCheckHandler(() => false);
  const denyDownload = (event) => event.preventDefault();
  isolated.on('will-download', denyDownload);

  let activeWindow = null;
  const execute = async ({ provider, url, query, maxResults, signal }) => {
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1000,
      height: 800,
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    activeWindow = win;
    const contents = win.webContents;
    const chrome = process.versions.chrome || '126.0.0.0';
    contents.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/${chrome} Safari/537.36`,
    );
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, target) => { if (!allowedNavigation(target, provider)) event.preventDefault(); };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    const stop = () => { try { contents.stop(); } catch (_) {} };
    signal.addEventListener('abort', stop, { once: true });
    try {
      await abortRace(contents.loadURL(url), signal);
      let previousSignature = '';
      let stableSamples = 0;
      for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
        const found = await abortRace(
          contents.executeJavaScript(PROVIDER_CONFIGS[provider].extractor, true),
          signal,
        );
        const results = Array.isArray(found) ? found : found && found.results;
        if (!Array.isArray(found) && found && found.challenge) {
          return {
            challenge: true,
            results: [],
            pageQuery: cleanText(found.pageQuery, 500),
            searchPage: { url: contents.getURL(), title: contents.getTitle() },
          };
        }
        if (Array.isArray(results) && results.length) {
          const pageQuery = Array.isArray(found) ? '' : cleanText(found.pageQuery, 500);
          const candidate = {
            results,
            pageQuery,
            searchPage: { url: contents.getURL(), title: contents.getTitle() },
          };
          const relevant = pageMatchesQuery(provider, candidate, query)
            ? filterResultsByQuery(cleanResults(results, MAX_CANDIDATE_RESULTS), query)
              .slice(0, maxResults)
            : [];
          const signature = resultSetSignature(relevant);
          if (signature) {
            stableSamples = signature === previousSignature ? stableSamples + 1 : 1;
            previousSignature = signature;
          } else {
            previousSignature = '';
            stableSamples = 0;
          }
          if (
            attempt >= RESULT_MIN_SETTLE_ATTEMPT
            && stableSamples >= RESULT_STABLE_SAMPLES
          ) {
            return {
              results: relevant,
              pageQuery,
              searchPage: candidate.searchPage,
            };
          }
        } else {
          previousSignature = '';
          stableSamples = 0;
        }
        if (attempt + 1 < RESULT_POLL_ATTEMPTS) {
          await delay(RESULT_POLL_INTERVAL_MS, signal);
        }
      }
      return [];
    } finally {
      signal.removeEventListener('abort', stop);
      if (!win.isDestroyed()) win.destroy();
      if (activeWindow === win) activeWindow = null;
    }
  };
  execute.cancelActive = () => {
    try { activeWindow?.webContents.stop(); } catch (_) {}
  };
  execute.closeNow = () => {
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
    activeWindow = null;
    isolated.removeListener('will-download', denyDownload);
  };
  execute.close = async () => execute.closeNow();
  log('Chromium search session initialised');
  return execute;
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
        reject(errorWithCode('INVALID_REQUEST', 'request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); }
      catch (_) { reject(errorWithCode('INVALID_REQUEST', 'request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

function send(response, status, payload) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  response.end(body);
}

function authenticated(request, token) {
  const actual = Buffer.from(String(request.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function createChromiumSearchBridge(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 25_000);
  const firstProviderTimeoutMs = Math.max(
    1,
    Number(options.firstProviderTimeoutMs) || FIRST_PROVIDER_TIMEOUT_MS,
  );
  const fallbackProviderTimeoutMs = Math.max(
    1,
    Number(options.providerTimeoutMs) || FALLBACK_PROVIDER_TIMEOUT_MS,
  );
  const executor = options.searchExecutor || await electronExecutor({
    BrowserWindow: options.BrowserWindow,
    session: options.session,
    log,
  });
  if (typeof executor !== 'function') throw new TypeError('searchExecutor must be a function');

  const token = crypto.randomBytes(32).toString('base64url');
  let active = null;
  let queue = Promise.resolve();
  let closed = false;
  let closeStarted = false;
  let closePromise = null;
  let port = 0;

  async function run(params, deadline) {
    if (closed) throw errorWithCode('BRIDGE_CLOSED', 'bridge is closed');
    const providers = providerOrder(params.language, params.query);
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      if (closed) throw errorWithCode('BRIDGE_CLOSED', 'bridge is closed');
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw errorWithCode('SEARCH_TIMEOUT', 'search timed out');
      const controller = new AbortController();
      active = controller;
      const timer = setTimeout(
        () => controller.abort(errorWithCode('PROVIDER_TIMEOUT', 'search provider timed out')),
        Math.min(index === 0 ? firstProviderTimeoutMs : fallbackProviderTimeoutMs, remainingMs),
      );
      try {
        const url = searchUrl(provider, params);
        const raw = await abortRace(executor({
          provider,
          url,
          ...params,
          signal: controller.signal,
        }), controller.signal);
        if (!Array.isArray(raw) && raw && raw.challenge) {
          log(`Chromium search provider ${provider} returned a challenge page`);
          continue;
        }
        const rawResults = Array.isArray(raw) ? raw : raw && raw.results;
        const cleanedResults = cleanResults(rawResults, MAX_CANDIDATE_RESULTS);
        if (cleanedResults.length) {
          if (!pageMatchesQuery(provider, raw, params.query)) {
            log(`Chromium search provider ${provider} returned a mismatched query page`);
            continue;
          }
          const results = filterResultsByQuery(cleanedResults, params.query)
            .slice(0, params.maxResults);
          if (!results.length) {
            log(`Chromium search provider ${provider} returned unrelated results`);
            continue;
          }
          const page = cleanSearchPage(provider, raw && raw.searchPage, params);
          return {
            provider,
            ...(page ? { searchPage: page } : {}),
            results,
          };
        }
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        if (reason?.code === 'PROVIDER_TIMEOUT') {
          log(`Chromium search provider ${provider} timed out`);
          continue;
        }
        if (controller.signal.aborted) throw reason;
        log(`Chromium search provider ${provider} failed`);
      } finally {
        clearTimeout(timer);
        if (active === controller) active = null;
      }
    }
    if (deadline <= Date.now()) throw errorWithCode('SEARCH_TIMEOUT', 'search timed out');
    throw errorWithCode('SEARCH_UNAVAILABLE', 'search providers returned no usable results');
  }

  function enqueue(params) {
    const deadline = Date.now() + timeoutMs;
    const job = queue.catch(() => {}).then(() => run(params, deadline));
    queue = job.catch(() => {});
    return job;
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (!authenticated(request, token)) return send(response, 401, { ok: false, error: 'unauthorised' });
      if (request.headers.host !== `${HOST}:${port}` || request.headers.origin) {
        return send(response, 403, { ok: false, error: 'forbidden' });
      }
      if (request.url !== SEARCH_PATH) return send(response, 404, { ok: false, error: 'not found' });
      if (request.method !== 'POST') return send(response, 405, { ok: false, error: 'POST required' });
      const params = validateRequest(await parseBody(request));
      const result = await enqueue(params);
      return send(response, 200, {
        ok: true,
        provider: result.provider,
        search_page: result.searchPage,
        results: result.results,
      });
    } catch (error) {
      const code = error?.code || 'SEARCH_UNAVAILABLE';
      const status = code === 'INVALID_REQUEST' ? 400
        : code === 'SEARCH_TIMEOUT' ? 504
          : ['SEARCH_CANCELLED', 'BRIDGE_CLOSED'].includes(code) ? 503 : 502;
      return send(response, status, { ok: false, error: { code, message: error?.message || 'search failed' } });
    }
  });
  server.requestTimeout = timeoutMs + 5_000;
  server.headersTimeout = 5_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  port = server.address().port;
  server.unref();

  function cancelActive() {
    if (!active || active.signal.aborted) return false;
    active.abort(errorWithCode('SEARCH_CANCELLED', 'search was cancelled'));
    executor.cancelActive?.();
    return true;
  }

  function closeNow() {
    if (closeStarted) return;
    closeStarted = true;
    closed = true;
    cancelActive();
    executor.closeNow?.();
    try { server.close(); } catch (_) {}
    server.closeAllConnections?.();
  }

  function close() {
    if (closePromise) return closePromise;
    closeNow();
    closePromise = (async () => {
      await queue.catch(() => {});
      await executor.close?.();
    })();
    return closePromise;
  }

  return {
    endpoint: `http://${HOST}:${port}`,
    token,
    port,
    cancelActive,
    close,
    closeNow,
  };
}

module.exports = { createChromiumSearchBridge };
