'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotateIfNeeded } = require('../lib/log-rotate');

function tmpLog(sizeBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
  const p = path.join(dir, 'electron.log');
  fs.writeFileSync(p, 'x'.repeat(sizeBytes));
  return p;
}

test('small file is not rotated', () => {
  const p = tmpLog(10);
  assert.strictEqual(rotateIfNeeded({ logPath: p, maxBytes: 100 }), false);
  assert.ok(fs.existsSync(p));
  assert.ok(!fs.existsSync(p + '.1'));
});

test('oversize file rotates to .1 and replaces stale .1', () => {
  const p = tmpLog(200);
  fs.writeFileSync(p + '.1', 'old');
  assert.strictEqual(rotateIfNeeded({ logPath: p, maxBytes: 100 }), true);
  assert.ok(!fs.existsSync(p));
  assert.strictEqual(fs.readFileSync(p + '.1', 'utf8'), 'x'.repeat(200));
});

test('missing file is a no-op false', () => {
  assert.strictEqual(
    rotateIfNeeded({ logPath: path.join(os.tmpdir(), 'logrot-none', 'nope.log'), maxBytes: 100 }),
    false,
  );
});
