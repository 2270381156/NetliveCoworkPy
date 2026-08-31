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
  // Match trim-tolerant (an old shipped default may have stray surrounding space),
  // but RE-EMIT the user's raw value untouched when preserved, so customized values
  // round-trip byte-for-byte and reconcile stays idempotent.
  return (c.oldDefaults || []).includes(curVal.trim()) ? c.value : curVal;
}

// ── upgrade policy (which canonical key gets which reconcile policy) ───────────
// Kept here (not in main.js) so it's unit-testable without electron. buildEnvCanonical
// turns the shipped .env template into the canonical[] that reconcileEnv consumes.
//
// force   — vendor-controlled factory values that MUST track the build on upgrade
//           (product identity + DATABASE_URL + 厂商服务地址). User .env edits to these are
//           intentionally NOT preserved (the supported customization path is the UI).
// managed — user-tunable knobs: preserved unless the current value is a known stale
//           shipped default (see ENV_MANAGED_OLD_DEFAULTS); missing → added.
//
// 注：LLM 默认账号/模型（原 NLC_LLM_ACCOUNT/STYLE/API_KEY/BASE_URL/MODEL/CONTEXT_LIMIT/
// OUTPUT_RESERVE/TIMEOUT_SEC）已从 .env 迁至随包 JSON 种子（default_llm_accounts.json），
// 不再经 env-reconcile 回写用户 .env——随包即最新，无“凭证轮换触达存量用户”的问题。
// 老用户 .env 里残留的这些键会成为无害孤儿键（后端已不读）。
const ENV_FORCE_KEYS = [
  'DATABASE_URL',
  'element_name', 'agent_display_name',
  'NLC_SKILL_MYTHOS_BASE_URL', 'NLC_SKILL_PULL_SERVER_URL',
  // W3 认证 + 白名单校验地址（厂商控制，升级时强制对齐随包模板）
  'COWORK_CLOUD_BASE_URL',
  'W3_BASE_URL', 'W3_CLIENT_ID', 'W3_CLIENT_SECRET',
  'W3_CALLBACK_URL', 'W3_SCOPE',
];
const ENV_MANAGED_KEYS = [
  'NLC_HTTP_SSL_VERIFY',
  'NLC_TASK_MAX_RETRIES', 'NLC_TASK_MAX_CONCURRENT', 'NLC_WATCH_INTERVAL',
  'NLC_DEFAULT_TOKEN_BUDGET',
  'NLC_PIP_INDEX_URL', 'NLC_PIP_TRUSTED_HOST', 'NLC_PIP_TIMEOUT',
];
// Historical shipped defaults per managed key. When a user's current value matches
// one of these (= they never customized it), it's bumped to the template's new value.
// Add the OLD value here whenever a *managed* shipped default changes.
const ENV_MANAGED_OLD_DEFAULTS = {
  // Shipped default changed 4 → 1 (serial) — installs still on the old 4 migrate; custom values kept.
  NLC_TASK_MAX_CONCURRENT: ['4'],
};

// Build canonical[] from the shipped template text. pathVals maps app-computed AppData
// path keys (NLC_DATA_DIR, …, already unix-slashed) → value, applied with policy 'path'.
function buildEnvCanonical(templateText, pathVals = {}) {
  const tv = parseAssignments(templateText);
  const canonical = [];
  for (const k of ENV_FORCE_KEYS) {
    if (tv.has(k)) canonical.push({ key: k, policy: 'force', value: tv.get(k) });
  }
  for (const k of ENV_MANAGED_KEYS) {
    if (tv.has(k)) canonical.push({ key: k, policy: 'managed', value: tv.get(k), oldDefaults: ENV_MANAGED_OLD_DEFAULTS[k] || [] });
  }
  for (const [k, v] of Object.entries(pathVals)) canonical.push({ key: k, policy: 'path', value: v });
  return canonical;
}

// ── reconcile marker ──────────────────────────────────────────────────────────
// The `<AppData>/.env-reconciled-version` marker gates reconcileUserEnv so it runs
// at most once per (version, canonical) pair. It USED to store the version string
// alone — but AppData survives NSIS upgrades, so a rebuilt package with the SAME
// version (dev `-test` iterations, or a factory-template/policy change shipped
// without a version bump) would find marker === version and skip forever, leaving
// newly-added force values stranded on existing installs. Folding a fingerprint of
// the canonical into the marker makes any template/policy change re-trigger reconcile.
//
// FNV-1a (32-bit) keeps this module dependency-free (no `crypto`) and deterministic
// across platforms. The canonical is serialized order-independently so the stable
// display order from buildEnvCanonical isn't the thing being trusted.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function reconcileMarker(version, canonical) {
  const sig = canonical
    .map((c) => `${c.key}|${c.policy}|${c.value}|${(c.oldDefaults || []).join(',')}`)
    .sort()
    .join('\n');
  return `${version} ${fnv1a32(sig)}`;
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
    const c = byKey.get(key);
    // Canonical product metadata may intentionally use a legacy non-NLC name.
    // Keep those entries while still deleting unrelated non-NLC assignments.
    if (!key.startsWith('NLC_') && !keep.has(key) && !c) continue;
    if (!c) { out.push(line); seen.add(key); continue; }        // allowed key not managed → keep
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

module.exports = {
  reconcileEnv, parseAssignments, buildEnvCanonical, reconcileMarker,
  ENV_FORCE_KEYS, ENV_MANAGED_KEYS, ENV_MANAGED_OLD_DEFAULTS,
};
