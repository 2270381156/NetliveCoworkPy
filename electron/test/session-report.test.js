'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionReportEntries } = require('../lib/session-report');

test('builds sqlite + environment.json entries then appends log tails', () => {
  const entries = buildSessionReportEntries({
    sessionId: 'sess-1',
    env: { app_version: '0.4.8', hostname: 'h', os_username: 'u', platform: 'win32', arch: 'x64' },
    sqliteBuf: Buffer.from('SQLITEBYTES'),
    logEntries: [{ name: 'electron.log', data: Buffer.from('e') }],
  });
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].name, 'session-sess-1.sqlite.gz');
  assert.strictEqual(entries[0].data.toString(), 'SQLITEBYTES');
  assert.strictEqual(entries[1].name, 'environment.json');
  assert.deepStrictEqual(JSON.parse(entries[1].data.toString('utf8')), {
    app_version: '0.4.8', hostname: 'h', os_username: 'u', platform: 'win32', arch: 'x64',
  });
  assert.strictEqual(entries[2].name, 'electron.log'); // log tails appended last
});

test('tolerates missing logEntries (still sqlite + environment.json)', () => {
  const entries = buildSessionReportEntries({
    sessionId: 's', env: { app_version: '0.4.8' }, sqliteBuf: Buffer.from('z'),
  });
  assert.deepStrictEqual(entries.map((e) => e.name), ['session-s.sqlite.gz', 'environment.json']);
});

test('appends extraEntries then report-manifest.json last', () => {
  const entries = buildSessionReportEntries({
    sessionId: 'sess-2',
    env: { app_version: '0.4.8' },
    sqliteBuf: Buffer.from('DB'),
    logEntries: [{ name: 'electron.log', data: Buffer.from('e') }],
    extraEntries: [{ name: 'skills/a.md', data: Buffer.from('A') }],
    manifest: { generated_for_session: 'sess-2', sources: {}, skipped: [], errors: [] },
  });
  assert.deepStrictEqual(entries.map((e) => e.name), [
    'session-sess-2.sqlite.gz', 'environment.json', 'electron.log', 'skills/a.md', 'report-manifest.json',
  ]);
  assert.deepStrictEqual(
    JSON.parse(entries[entries.length - 1].data.toString('utf8')).generated_for_session, 'sess-2');
});

test('no manifest / no extraEntries → unchanged 3-entry shape (backward compat)', () => {
  const entries = buildSessionReportEntries({
    sessionId: 's', env: { app_version: '0.4.8' }, sqliteBuf: Buffer.from('z'),
    logEntries: [{ name: 'electron.log', data: Buffer.from('e') }],
  });
  assert.deepStrictEqual(entries.map((e) => e.name), ['session-s.sqlite.gz', 'environment.json', 'electron.log']);
});
