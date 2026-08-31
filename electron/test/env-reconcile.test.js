'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  reconcileEnv, parseAssignments, buildEnvCanonical, ENV_FORCE_KEYS, reconcileMarker,
} = require('../lib/env-reconcile');

const FACTORY_TEMPLATE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'packaging', 'default_data', '.env.example'),
    'utf8',
);

// 合成夹具（示例键，非真实策略清单——真实清单见 env-reconcile.js 的 ENV_FORCE/MANAGED_KEYS）。
// 用 NLC_PIP_* 作 managed 样例（LLM 账号已迁 JSON、不再经 reconcile）。
const CANON = [
  { key: 'DATABASE_URL', policy: 'force', value: 'sqlite' },
  { key: 'NLC_PIP_INDEX_URL', policy: 'managed', value: 'http://mirror/new', oldDefaults: ['http://mirror/old'] },
  { key: 'NLC_PIP_TRUSTED_HOST', policy: 'managed', value: 'mirror.local', oldDefaults: [] },
  { key: 'NLC_DATA_DIR', policy: 'path', value: 'C:/AppData/IPMaster-Cowork/data' },
];

test('managed: value equals old default -> updated to template new value', () => {
  const { text, changed } = reconcileEnv('NLC_PIP_INDEX_URL=http://mirror/old\n', { canonical: CANON });
  assert.match(text, /NLC_PIP_INDEX_URL=http:\/\/mirror\/new/);
  assert.strictEqual(changed, true);
});

test('managed: user-customized value is preserved', () => {
  const { text } = reconcileEnv('NLC_PIP_INDEX_URL=http://my-own:9999\n', { canonical: CANON });
  assert.match(text, /NLC_PIP_INDEX_URL=http:\/\/my-own:9999/);
  assert.doesNotMatch(text, /mirror\/new/);
});

test('managed: missing -> appended with template value', () => {
  const { text } = reconcileEnv('NLC_PIP_TRUSTED_HOST=mirror.local\n', { canonical: CANON });
  assert.match(text, /^NLC_PIP_INDEX_URL=http:\/\/mirror\/new$/m);
});

test('force: always overwritten (even if user set postgres)', () => {
  const { text, changed } = reconcileEnv('DATABASE_URL=postgresql://u:p@host/db\n', { canonical: CANON });
  assert.match(text, /^DATABASE_URL=sqlite$/m);
  assert.strictEqual(changed, true);
});

test('path: always rewritten to given AppData path; missing -> appended', () => {
  const { text } = reconcileEnv('NLC_DATA_DIR=D:/old/install/data\n', { canonical: CANON });
  assert.match(text, /^NLC_DATA_DIR=C:\/AppData\/IPMaster-Cowork\/data$/m);
});

test('drops non-canonical non-NLC_ assignment keys; DATABASE_URL whitelisted', () => {
  const { text } = reconcileEnv('OPENAI_API_KEY=sk-xxx\nDATABASE_URL=sqlite\nNLC_PIP_TRUSTED_HOST=mirror.local\n', { canonical: CANON });
  assert.doesNotMatch(text, /OPENAI_API_KEY/);
  assert.match(text, /^DATABASE_URL=sqlite$/m);
});

test('NLC_ key not in canonical -> kept as-is', () => {
  const { text } = reconcileEnv('NLC_CUSTOM_THING=42\nNLC_PIP_TRUSTED_HOST=mirror.local\n', { canonical: CANON });
  assert.match(text, /^NLC_CUSTOM_THING=42$/m);
});

test('comments and blank lines are preserved', () => {
  const src = '# header\n\n# NLC_LOG_LEVEL=INFO\nNLC_PIP_TRUSTED_HOST=mirror.local\n';
  const { text } = reconcileEnv(src, { canonical: CANON });
  assert.match(text, /# header/);
  assert.match(text, /# NLC_LOG_LEVEL=INFO/);
});

test('idempotent: re-running yields changed=false and identical text', () => {
  const once = reconcileEnv('DATABASE_URL=postgresql://x\nOPENAI_API_KEY=y\n', { canonical: CANON }).text;
  const twice = reconcileEnv(once, { canonical: CANON });
  assert.strictEqual(twice.changed, false);
  assert.strictEqual(twice.text, once);
});

// ── upgrade policy: vendor-controlled factory defaults must converge ───────────
// Regression: a managed key with no registered oldDefault kept its stale shipped
// value on upgrade (e.g. bumped endpoint never reached existing installs).
// Vendor-controlled identity/endpoint keys are 'force'.
const TEMPLATE = [
  'element_name=On‑Prem CoWork',
  'agent_display_name=CoWork',
  'DATABASE_URL=sqlite',
  'NLC_DEFAULT_TOKEN_BUDGET=0',
  'NLC_SKILL_MYTHOS_BASE_URL=https://ipmastermythos.huawei.com',
  '',
].join('\n');

test('agent identity keys are force-policy', () => {
  for (const k of ['element_name', 'agent_display_name']) {
    assert.ok(ENV_FORCE_KEYS.includes(k), `${k} should be force`);
  }
});

test('upgrade: missing agent identity keys are appended from the current template', () => {
  const canonical = buildEnvCanonical(FACTORY_TEMPLATE);
  const { text, changed } = reconcileEnv('DATABASE_URL=sqlite\n', { canonical });
  assert.match(text, /^element_name=On‑Prem CoWork$/m);
  assert.match(text, /^agent_display_name=CoWork$/m);
  assert.strictEqual(changed, true);
});

test('upgrade: stale agent identity values are overwritten instead of dropped', () => {
  const canonical = buildEnvCanonical(FACTORY_TEMPLATE);
  const oldEnv = [
    'element_name=Legacy CoWork',
    'agent_display_name=Legacy',
    'DATABASE_URL=sqlite',
    '',
  ].join('\n');
  const { text, changed } = reconcileEnv(oldEnv, { canonical });
  assert.match(text, /^element_name=On‑Prem CoWork$/m);
  assert.match(text, /^agent_display_name=CoWork$/m);
  assert.doesNotMatch(text, /Legacy/);
  assert.strictEqual(changed, true);
});

test('NLC_SKILL_MYTHOS_BASE_URL is force-policy (vendor endpoint, every install)', () => {
  assert.ok(ENV_FORCE_KEYS.includes('NLC_SKILL_MYTHOS_BASE_URL'));
});

test('upgrade: stale mythos base url is overwritten to current build', () => {
  const canonical = buildEnvCanonical(TEMPLATE);
  const oldEnv = [
    'NLC_SKILL_MYTHOS_BASE_URL=https://old-mythos.example.com',
    'DATABASE_URL=sqlite',
    '',
  ].join('\n');
  const { text, changed } = reconcileEnv(oldEnv, { canonical });
  assert.match(text, /^NLC_SKILL_MYTHOS_BASE_URL=https:\/\/ipmastermythos\.huawei\.com$/m);
  assert.doesNotMatch(text, /old-mythos/);
  assert.strictEqual(changed, true);
});

test('upgrade: user-tunable managed knob is still preserved', () => {
  const canonical = buildEnvCanonical(TEMPLATE);
  // user raised their own token budget; managed + not a known old default → kept
  const { text } = reconcileEnv('NLC_DEFAULT_TOKEN_BUDGET=500000\nDATABASE_URL=sqlite\n', { canonical });
  assert.match(text, /^NLC_DEFAULT_TOKEN_BUDGET=500000$/m);
});

test('buildEnvCanonical: pathVals applied as path-policy entries', () => {
  const canonical = buildEnvCanonical(TEMPLATE, { NLC_DATA_DIR: 'C:/AppData/x/data' });
  const dataDir = canonical.find((c) => c.key === 'NLC_DATA_DIR');
  assert.strictEqual(dataDir.policy, 'path');
  assert.strictEqual(dataDir.value, 'C:/AppData/x/data');
});

test('parseAssignments reads only active assignments, ignores comments', () => {
  const m = parseAssignments('# A=1\nB=2\nNLC_X=hello world\n');
  assert.strictEqual(m.get('B'), '2');
  assert.strictEqual(m.get('NLC_X'), 'hello world');
  assert.ok(!m.has('A'));
});

test('CRLF input is preserved as CRLF output', () => {
  const { text } = reconcileEnv('NLC_PIP_TRUSTED_HOST=mirror.local\r\nDATABASE_URL=postgresql://x\r\n', { canonical: CANON });
  assert.match(text, /\r\n/);
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF among the CRLFs');
  assert.match(text, /^DATABASE_URL=sqlite\r$/m);
});

test('input without trailing newline gains one and is then idempotent', () => {
  const r1 = reconcileEnv('NLC_PIP_TRUSTED_HOST=mirror.local', { canonical: CANON });   // no trailing \n
  assert.ok(r1.text.endsWith('\n'));
  assert.strictEqual(r1.changed, true);
  const r2 = reconcileEnv(r1.text, { canonical: CANON });
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(r2.text, r1.text);
});

test('a canonical key missing from input is appended exactly once (no double-emit)', () => {
  const { text } = reconcileEnv('DATABASE_URL=sqlite\n', { canonical: CANON });
  const occurrences = (text.match(/^NLC_PIP_INDEX_URL=/mg) || []).length;
  assert.strictEqual(occurrences, 1);
});

test('managed missing -> appended AND changed is true', () => {
  const { changed } = reconcileEnv('DATABASE_URL=sqlite\n', { canonical: CANON });
  assert.strictEqual(changed, true);
});

// ── reconcile marker: gate on version + canonical fingerprint ─────────────────
// The AppData marker survives NSIS upgrades; gating on the version STRING alone
// meant a rebuilt package with the SAME version (dev `-test` iterations, or a
// hotfix that changed the factory template without bumping) never re-ran reconcile,
// so newly-added force values never reached existing installs. The marker now folds
// in a fingerprint of the canonical so any template/policy change re-triggers.
test('reconcileMarker: deterministic for same version + canonical', () => {
  assert.strictEqual(reconcileMarker('0.4.13-test', CANON), reconcileMarker('0.4.13-test', CANON));
});

test('reconcileMarker: differs when a canonical value changes (same version)', () => {
  const bumped = CANON.map((c) => (c.key === 'NLC_PIP_INDEX_URL' ? { ...c, value: 'http://mirror/newer' } : c));
  assert.notStrictEqual(reconcileMarker('0.4.13-test', CANON), reconcileMarker('0.4.13-test', bumped));
});

test('reconcileMarker: differs when a force key is added (same version)', () => {
  const extended = [...CANON, { key: 'NLC_SKILL_PULL_SERVER_URL', policy: 'force', value: 'http://x/api' }];
  assert.notStrictEqual(reconcileMarker('0.4.13-test', CANON), reconcileMarker('0.4.13-test', extended));
});

test('reconcileMarker: differs across versions with identical canonical', () => {
  assert.notStrictEqual(reconcileMarker('0.4.13-test', CANON), reconcileMarker('0.4.14', CANON));
});

test('reconcileMarker: order-independent (canonical entry order does not churn the marker)', () => {
  const shuffled = [CANON[2], CANON[0], CANON[3], CANON[1]];
  assert.strictEqual(reconcileMarker('0.4.13-test', CANON), reconcileMarker('0.4.13-test', shuffled));
});

test('reconcileMarker: begins with the version so it stays human-readable', () => {
  assert.match(reconcileMarker('0.4.13-test', CANON), /^0\.4\.13-test\b/);
});
