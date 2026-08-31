'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createReporter } = require('../telemetry');

const context = {
  installId: 'iid', appVersion: '0.1.0', channel: 'stable',
  os: 'win32', arch: 'x64', now: () => 1,
};

function memQueue() {
  let q = [];
  return { load: () => q, save: (v) => { q = v; }, current: () => q };
}

test('successful send leaves queue empty', async () => {
  const mq = memQueue();
  let posts = 0;
  const r = createReporter({
    endpoint: 'http://t', context,
    loadQueue: mq.load, saveQueue: mq.save,
    fetchImpl: async () => { posts += 1; return { ok: true }; },
  });
  await r.report('app_launch');
  assert.strictEqual(posts, 1);
  assert.deepStrictEqual(mq.current(), []);
});

test('failed send keeps event queued for later', async () => {
  const mq = memQueue();
  const r = createReporter({
    endpoint: 'http://t', context,
    loadQueue: mq.load, saveQueue: mq.save,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  await r.report('app_launch');
  assert.strictEqual(mq.current().length, 1);
  assert.strictEqual(mq.current()[0].event_type, 'app_launch');
});

test('no endpoint is a no-op', async () => {
  const mq = memQueue();
  let posts = 0;
  const r = createReporter({
    endpoint: '', context, loadQueue: mq.load, saveQueue: mq.save,
    fetchImpl: async () => { posts += 1; return { ok: true }; },
  });
  await r.report('app_launch');
  assert.strictEqual(posts, 0);
  assert.deepStrictEqual(mq.current(), []);
});

test('flush drains a previously queued event once back online', async () => {
  const mq = memQueue();
  mq.save([{ event_type: 'app_launch', install_id: 'iid' }]);
  let posts = 0;
  const r = createReporter({
    endpoint: 'http://t', context,
    loadQueue: mq.load, saveQueue: mq.save,
    fetchImpl: async () => { posts += 1; return { ok: true }; },
  });
  await r.flush();
  assert.strictEqual(posts, 1);
  assert.deepStrictEqual(mq.current(), []);
});
