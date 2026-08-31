'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { uploadLogs } = require('../lib/log-uploader');

class FakeForm {
  constructor() { this.entries = []; }
  append(k, v, name) { this.entries.push([k, v, name]); }
}
class FakeBlob {
  constructor(parts, opts) { this.size = parts[0] ? parts[0].length : 0; this.type = opts && opts.type; }
}

test('uploadLogs posts fields + ONE zip archive to /logs, returns true on ok', async () => {
  let calledUrl, calledOpts;
  const fetchImpl = async (url, opts) => { calledUrl = url; calledOpts = opts; return { ok: true }; };
  const ok = await uploadLogs({
    endpoint: 'http://x:8077',
    fields: { install_id: 'i', reason: 'crash', command_id: undefined }, // undefined skipped
    archive: { name: 'logs-crash.zip', data: Buffer.from('PKzz') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calledUrl, 'http://x:8077/logs');
  assert.strictEqual(calledOpts.method, 'POST');
  const form = calledOpts.body;
  const textKeys = form.entries.filter((e) => e[0] !== 'files').map((e) => e[0]).sort();
  assert.deepStrictEqual(textKeys, ['install_id', 'reason']);   // command_id=undefined dropped
  const fileEntries = form.entries.filter((e) => e[0] === 'files');
  assert.strictEqual(fileEntries.length, 1);                    // exactly one archive part
  assert.strictEqual(fileEntries[0][2], 'logs-crash.zip');
  assert.strictEqual(fileEntries[0][1].type, 'application/zip');
});

test('uploadLogs returns false when fetch rejects', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const ok = await uploadLogs({
    endpoint: 'http://x', fields: {}, archive: { name: 'logs.zip', data: Buffer.from('z') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, false);
});

test('uploadLogs returns false on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const ok = await uploadLogs({
    endpoint: 'http://x', fields: {}, archive: { name: 'logs.zip', data: Buffer.from('z') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob,
  });
  assert.strictEqual(ok, false);
});

test('uploadLogs reports the reason via logFn (non-ok status)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  const logs = [];
  const ok = await uploadLogs({
    endpoint: 'http://x', fields: {}, archive: { name: 'logs.zip', data: Buffer.from('z') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob, logFn: (m) => logs.push(m),
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /403/);
});

test('uploadLogs reports the reason via logFn (fetch rejects)', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  const logs = [];
  await uploadLogs({
    endpoint: 'http://x', fields: {}, archive: { name: 'logs.zip', data: Buffer.from('z') },
    fetchImpl, FormDataImpl: FakeForm, BlobImpl: FakeBlob, logFn: (m) => logs.push(m),
  });
  assert.match(logs[0], /boom/);
});
