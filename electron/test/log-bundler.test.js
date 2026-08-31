'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tailFileSync, collectTail, collectFull, collectSessionLogs } = require('../lib/log-bundler');

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('tailFileSync returns last maxBytes of a file', () => {
  const p = tmpFile('a.log', 'abcdefghij');
  assert.strictEqual(tailFileSync(p, 4).toString(), 'ghij');
  assert.strictEqual(tailFileSync(p, 100).toString(), 'abcdefghij');
});

test('tailFileSync returns null for a missing file', () => {
  assert.strictEqual(tailFileSync(path.join(os.tmpdir(), 'nope-xyz-123.log'), 4), null);
});

test('collectTail returns RAW tails, skips missing files', () => {
  const a = tmpFile('electron.log', 'x'.repeat(500));
  const out = collectTail({
    files: [
      { path: a, name: 'electron.log' },
      { path: path.join(os.tmpdir(), 'absent-abc.log'), name: 'backend.log' },
    ],
    perFileBytes: 100,
  });
  assert.deepStrictEqual(out.map((o) => o.name), ['electron.log']);
  assert.strictEqual(out[0].data.length, 100);          // raw tail, not gzipped
  assert.strictEqual(out[0].data.toString(), 'x'.repeat(100));
});

test('collectFull includes whole RAW files within budget', () => {
  const a = tmpFile('electron.log', 'aaaa');
  const b = tmpFile('backend.log', 'bbbbbb');
  const out = collectFull({
    files: [{ path: a, name: 'electron.log' }, { path: b, name: 'backend.log' }],
    maxTotalBytes: 1000, tailBytes: 2,
  });
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.toString()]), [
    ['electron.log', 'aaaa'], ['backend.log', 'bbbbbb'],
  ]);
});

test('collectFull keeps newest, tail-truncates at budget, drops oldest', () => {
  const newest = tmpFile('electron.log', 'N'.repeat(8));
  const older = tmpFile('backend.log', 'O'.repeat(8));
  const oldest = tmpFile('backend.log.2026-06-24', 'X'.repeat(8));
  const out = collectFull({
    files: [
      { path: newest, name: 'electron.log' },
      { path: older, name: 'backend.log' },
      { path: oldest, name: 'backend.log.2026-06-24' },
    ],
    maxTotalBytes: 12, tailBytes: 4,
  });
  // newest whole (8) fits; older would hit 16>12 → tail to 4 (8+4=12) fits; oldest dropped
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.length]), [
    ['electron.log', 8], ['backend.log', 4],
  ]);
});

test('collectFull skips a missing middle file without stopping', () => {
  const a = tmpFile('electron.log', 'aa');
  const c = tmpFile('backend.log.2026-06-24', 'cc');
  const out = collectFull({
    files: [
      { path: a, name: 'electron.log' },
      { path: path.join(os.tmpdir(), 'gone-xyz.log'), name: 'backend.log' },
      { path: c, name: 'backend.log.2026-06-24' },
    ],
    maxTotalBytes: 1000, tailBytes: 2,
  });
  assert.deepStrictEqual(out.map((o) => o.name), ['electron.log', 'backend.log.2026-06-24']);
});

function tmpLogsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logs-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('collectSessionLogs returns full electron.log, backend.log and every dated rotation', () => {
  const dir = tmpLogsDir({
    'electron.log': 'e-full',
    'backend.log': 'b-full',
    'backend.log.2026-06-24': 'old-1',
    'backend.log.2026-06-25': 'old-2',
    'backend.log.2026-06-26': 'old-3',
    'backend.log.2026-06-27.log': 'old-4',  // trailing-.log naming variant
    'backend.log.not-a-date': 'ignored',
    'backend.log.txt': 'ignored',
    'unrelated.log': 'ignored',
  });
  const out = collectSessionLogs({ logsDir: dir, maxTotalBytes: 1000 });
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.toString()]), [
    ['electron.log', 'e-full'],
    ['backend.log', 'b-full'],
    ['backend.log.2026-06-27.log', 'old-4'],  // newest rotation first (incl. .log variant)
    ['backend.log.2026-06-26', 'old-3'],
    ['backend.log.2026-06-25', 'old-2'],
    ['backend.log.2026-06-24', 'old-1'],
  ]);
});

test('collectSessionLogs over budget keeps primaries FULL and drops overflow rotations whole', () => {
  const dir = tmpLogsDir({
    'electron.log': 'E'.repeat(8),
    'backend.log': 'B'.repeat(8),
    'backend.log.2026-06-25': 'N'.repeat(8),
    'backend.log.2026-06-24': 'O'.repeat(8),
  });
  const out = collectSessionLogs({ logsDir: dir, maxTotalBytes: 20 });
  // electron(8)+backend(8)=16 whole; newest rotation would hit 24>20 → dropped
  // WHOLE (no tail-truncation), and everything older with it.
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.length]), [
    ['electron.log', 8],
    ['backend.log', 8],
  ]);
});

test('collectSessionLogs primaries are NEVER truncated even when they alone exceed the budget', () => {
  const dir = tmpLogsDir({
    'electron.log': 'E'.repeat(15),
    'backend.log': 'B'.repeat(10),
    'backend.log.2026-06-25': 'N'.repeat(4),   // would fit alone, but primaries already over budget
  });
  const out = collectSessionLogs({ logsDir: dir, maxTotalBytes: 20 });
  assert.deepStrictEqual(out.map((o) => [o.name, o.data.length]), [
    ['electron.log', 15],   // 15+10=25 > 20 — still FULL; budget only gates rotations
    ['backend.log', 10],
  ]);
});

test('collectSessionLogs with a missing logs dir returns []', () => {
  const out = collectSessionLogs({
    logsDir: path.join(os.tmpdir(), 'absent-session-logs-xyz'),
    maxTotalBytes: 1000,
  });
  assert.deepStrictEqual(out, []);
});
