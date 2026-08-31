'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  MAX_UI_LOAD_RETRIES,
  isTransientLoadError,
  shouldRetryLoad,
  retryDelayMs,
  watchdogOverslept,
} = require('../lib/load-recovery');

// The field report: machine slept ~2s after loadURL, main frame failed with
// -331 and nothing retried, so the window sat on the splash for 14h.
test('ERR_NETWORK_IO_SUSPENDED is transient and retried', () => {
  assert.strictEqual(isTransientLoadError(-331), true);
  assert.strictEqual(shouldRetryLoad(-331, 0), true);
});

test('ERR_NETWORK_CHANGED is transient', () => {
  assert.strictEqual(isTransientLoadError(-21), true);
});

test('a real load failure is not retried', () => {
  // ERR_CONNECTION_REFUSED: backend genuinely gone — retrying hides it.
  assert.strictEqual(isTransientLoadError(-102), false);
  assert.strictEqual(shouldRetryLoad(-102, 0), false);
});

test('retries stop at the cap so the user still gets a dialog', () => {
  assert.strictEqual(shouldRetryLoad(-331, MAX_UI_LOAD_RETRIES - 1), true);
  assert.strictEqual(shouldRetryLoad(-331, MAX_UI_LOAD_RETRIES), false);
});

test('backoff doubles and is capped', () => {
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4, 5].map((n) => retryDelayMs(n)),
    [1000, 2000, 4000, 8000, 8000, 8000],
  );
});

test('watchdog that elapsed roughly its timeout is a real timeout', () => {
  assert.strictEqual(watchdogOverslept(1000, 1000 + 20500, 20000), false);
});

test('watchdog frozen across a suspend is detected, not reported', () => {
  const fourteenHours = 14 * 60 * 60 * 1000;
  assert.strictEqual(watchdogOverslept(1000, 1000 + fourteenHours, 20000), true);
});
