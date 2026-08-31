'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSessionReportZipAsync } = require('../lib/session-report-async');
const { buildSessionReportZip } = require('../lib/session-report-build');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-report-'));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'electron.log'), 'hello electron\n');
  fs.writeFileSync(path.join(dir, '.env'), 'NLC_X=1\n');
  return {
    sessionId: 'sess-1',
    env: { app_version: '0.0.0' },
    sqliteBuf: Buffer.from('sqlite-bytes'),
    appDataDir: dir,
    skillsDir: path.join(dir, 'skills'),
    agentsDir: path.join(dir, 'agents'),
  };
}

// zip 里的文件名都在中央目录里出现，抽名字够验证内容装齐了。
function namesIn(zip) {
  const s = zip.toString('latin1');
  return ['session-sess-1.sqlite.gz', 'environment.json', 'electron.log', 'config/.env'].filter((n) => s.includes(n));
}

test('worker 线程产出的 zip 与主线程同步产出的逐字节一致', async () => {
  const opts = fixture();
  const viaWorker = await buildSessionReportZipAsync(opts);
  const viaMain = buildSessionReportZip(opts);
  assert.ok(Buffer.isBuffer(viaWorker));
  assert.deepStrictEqual(viaWorker, viaMain);
  assert.deepStrictEqual(namesIn(viaWorker), ['session-sess-1.sqlite.gz', 'environment.json', 'electron.log', 'config/.env']);
});

test('线程起不来时退回主线程，并记一条日志', async () => {
  const opts = fixture();
  const logs = [];
  // 用非法 workerData(不可结构化克隆)逼 Worker 构造失败。
  const bad = { ...opts, env: { fn: () => {} } };
  const zip = await buildSessionReportZipAsync(bad, { logFn: (m) => logs.push(m) });
  assert.ok(Buffer.isBuffer(zip) && zip.length > 0);
  assert.ok(logs.some((m) => m.includes('main thread')), logs.join('|'));
});
