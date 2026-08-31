'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectDirTree, collectFiles, PER_FILE_MAX, TREE_BUDGET, gatherExtraReportData } = require('../lib/report-collect');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')); }
function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

test('collectDirTree: absent dir → present:false, empty', () => {
  const res = collectDirTree({ dir: path.join(os.tmpdir(), 'no-such-rc-xyz'), prefix: 'skills' });
  assert.strictEqual(res.present, false);
  assert.deepStrictEqual(res.entries, []);
  assert.deepStrictEqual(res.skipped, []);
  assert.strictEqual(res.bytesUsed, 0);
});

test('collectDirTree: recurses, sorts, prefixes with forward slashes', () => {
  const d = tmpDir();
  write(d, 'b.md', 'BB');
  write(d, 'sub/a.md', 'A');
  const res = collectDirTree({ dir: d, prefix: 'skills' });
  assert.strictEqual(res.present, true);
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['skills/b.md', 'skills/sub/a.md']);
  assert.strictEqual(res.entries[1].data.toString(), 'A');
  assert.strictEqual(res.bytesUsed, 3);
});

test('collectDirTree: file over per-file cap → skipped(file-too-large), budget intact', () => {
  const d = tmpDir();
  write(d, 'big.bin', Buffer.alloc(11));
  write(d, 'small.md', 'ok');
  const res = collectDirTree({ dir: d, prefix: 'skills', perFileBytes: 10 });
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['skills/small.md']);
  assert.deepStrictEqual(res.skipped, [{ path: 'skills/big.bin', bytes: 11, reason: 'file-too-large' }]);
});

test('collectDirTree: budget overflow latches — file + all later → budget-exceeded', () => {
  const d = tmpDir();
  write(d, 'a.md', 'AAAA');   // 4
  write(d, 'b.md', 'BBBB');   // 4 → would hit budget
  write(d, 'c.md', 'C');      // 1 → still dropped once latched
  const res = collectDirTree({ dir: d, prefix: 'agents', budgetRemaining: 5 });
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['agents/a.md']);
  assert.strictEqual(res.bytesUsed, 4);
  assert.deepStrictEqual(res.skipped, [
    { path: 'agents/b.md', bytes: 4, reason: 'budget-exceeded' },
    { path: 'agents/c.md', bytes: 1, reason: 'budget-exceeded' },
  ]);
});

test('collectDirTree: read error on a file → recorded in errors, continues', () => {
  const d = tmpDir();
  write(d, 'good.md', 'g');
  const fsImpl = {
    statSync: (p) => fs.statSync(p),
    readdirSync: (p, o) => fs.readdirSync(p, o),
    readFileSync: (p) => { if (String(p).endsWith('good.md')) throw new Error('boom'); return fs.readFileSync(p); },
  };
  const res = collectDirTree({ dir: d, prefix: 'skills', fsImpl });
  assert.deepStrictEqual(res.entries, []);
  assert.strictEqual(res.errors.length, 1);
  assert.strictEqual(res.errors[0].path, 'skills/good.md');
  assert.match(res.errors[0].reason, /boom/);
});

test('collectDirTree: constants exported', () => {
  assert.strictEqual(PER_FILE_MAX, 2 * 1024 * 1024);
  assert.strictEqual(TREE_BUDGET, 16 * 1024 * 1024);
});

test('collectFiles: present → entry+included, missing → absent', () => {
  const d = tmpDir();
  const p = write(d, 'skill_references.json', '{"v":2}');
  const res = collectFiles({ files: [
    { path: p, name: 'config/skill_references.json' },
    { path: path.join(d, 'nope.json'), name: 'config/nope.json' },
  ] });
  assert.deepStrictEqual(res.entries.map((e) => e.name), ['config/skill_references.json']);
  assert.strictEqual(res.entries[0].data.toString(), '{"v":2}');
  assert.deepStrictEqual(res.included, ['config/skill_references.json']);
  assert.deepStrictEqual(res.absent, ['config/nope.json']);
  assert.deepStrictEqual(res.errors, []);
});

test('collectFiles: non-ENOENT read error → errors, not absent', () => {
  const fsImpl = { readFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } };
  const res = collectFiles({ files: [{ path: '/x', name: 'config/.env' }], fsImpl });
  assert.deepStrictEqual(res.absent, []);
  assert.strictEqual(res.errors.length, 1);
  assert.strictEqual(res.errors[0].path, 'config/.env');
});

function fakeAppData() {
  const root = tmpDir();
  write(root, 'skills/foo/SKILL.md', 'skill body');
  write(root, 'agents/bar.md', 'agent body');
  write(root, '.env', 'DATABASE_URL=secret\nNLC_LLM_KEY=abc');
  write(root, 'data/skill_references.json', '{"version":2}');
  write(root, 'data/llm_configs/anthropic.json', '{"api_key":"sk-xxx"}');
  write(root, 'resources/mcp.json', '{"servers":{}}');
  return root;
}

test('gatherExtraReportData: bundles skills/agents/config with prefixes', () => {
  const root = fakeAppData();
  const { entries, manifest } = gatherExtraReportData({
    sessionId: 'sess-9',
    skillsDir: path.join(root, 'skills'),
    agentsDir: path.join(root, 'agents'),
    dataDir: path.join(root, 'data'),
    resourcesDir: path.join(root, 'resources'),
    envPath: path.join(root, '.env'),
  });
  const names = entries.map((e) => e.name).sort();
  assert.deepStrictEqual(names, [
    'agents/bar.md',
    'config/.env',
    'config/llm_configs/anthropic.json',
    'config/mcp.json',
    'config/skill_references.json',
    'skills/foo/SKILL.md',
  ]);
  // secrets carried RAW (not redacted)
  const env = entries.find((e) => e.name === 'config/.env');
  assert.match(env.data.toString(), /DATABASE_URL=secret/);
  // manifest reflects sources
  assert.strictEqual(manifest.generated_for_session, 'sess-9');
  assert.strictEqual(manifest.sources.skills.status, 'present');
  assert.strictEqual(manifest.sources.agents.status, 'present');
  assert.ok(manifest.sources.config.included.includes('config/.env'));
  assert.ok(manifest.sources.config.absent.includes('config/skill_pull_config.json'));
});

test('gatherExtraReportData: absent skills/agents dirs → status absent, no throw', () => {
  const root = tmpDir();
  write(root, 'data/skill_references.json', '{}');
  const { entries, manifest } = gatherExtraReportData({
    sessionId: 's',
    skillsDir: path.join(root, 'skills'),
    agentsDir: path.join(root, 'agents'),
    dataDir: path.join(root, 'data'),
    resourcesDir: path.join(root, 'resources'),
    envPath: path.join(root, '.env'),
  });
  assert.strictEqual(manifest.sources.skills.status, 'absent');
  assert.strictEqual(manifest.sources.agents.status, 'absent');
  assert.ok(entries.some((e) => e.name === 'config/skill_references.json'));
});

test('gatherExtraReportData: skills+agents share the 16MB budget', () => {
  const root = tmpDir();
  // one 1.5MB skill file uses part of the budget; assert agents budget is reduced
  write(root, 'skills/a.bin', Buffer.alloc(1_500_000, 1));
  write(root, 'agents/b.bin', Buffer.alloc(1_000, 2));
  const { manifest } = gatherExtraReportData({
    sessionId: 's', skillsDir: path.join(root, 'skills'), agentsDir: path.join(root, 'agents'),
    dataDir: path.join(root, 'data'), resourcesDir: path.join(root, 'resources'), envPath: path.join(root, '.env'),
  });
  assert.strictEqual(manifest.sources.skills.bytes, 1_500_000);
  assert.strictEqual(manifest.sources.agents.bytes, 1_000);
});
