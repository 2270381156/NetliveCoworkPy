'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEvent, enqueue, tailString } = require('../lib/telemetry-core');

const ctx = {
  installId: 'iid-1', appVersion: '0.1.0', channel: 'stable',
  os: 'win32', arch: 'x64', hostname: 'HOST-1', osUsername: 'alice',
  now: () => 1700000000000,
};

test('buildEvent sets common fields and event_type', () => {
  const ev = buildEvent('app_launch', ctx);
  assert.deepStrictEqual(ev, {
    event_type: 'app_launch', install_id: 'iid-1', app_version: '0.1.0',
    channel: 'stable', os: 'win32', arch: 'x64',
    hostname: 'HOST-1', os_username: 'alice', ts: 1700000000000,
  });
});

test('buildEvent merges extra fields', () => {
  const ev = buildEvent('update_download_failed', ctx, { error: 'boom' });
  assert.strictEqual(ev.event_type, 'update_download_failed');
  assert.strictEqual(ev.error, 'boom');
});

test('extra.ts overrides ctx.now (spool events keep backend timestamp)', () => {
  const ev = buildEvent('step_failed', ctx, { ts: 'BACKEND-TS', session_id: 's1' });
  assert.strictEqual(ev.ts, 'BACKEND-TS');
});

test('enqueue appends', () => {
  assert.deepStrictEqual(enqueue([], { a: 1 }), [{ a: 1 }]);
});

test('enqueue trims to maxLen keeping newest', () => {
  const q = enqueue(enqueue(enqueue([], { n: 1 }, 2), { n: 2 }, 2), { n: 3 }, 2);
  assert.deepStrictEqual(q, [{ n: 2 }, { n: 3 }]);
});

test('tailString keeps at most maxBytes from the end', () => {
  assert.strictEqual(tailString('abcdef', 4), 'cdef');
  assert.strictEqual(tailString('ab', 4), 'ab');
  assert.strictEqual(tailString('', 4), '');
});
