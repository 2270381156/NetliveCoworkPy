'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveUpdateConfig, shouldCheckForUpdates, shouldReportTelemetry } = require('../lib/update-config');

test('reads feed/telemetry/channel straight from app-config', () => {
  const cfg = resolveUpdateConfig({
    feedUrl: 'http://10.25.228.203:8077',
    telemetryUrl: 'http://10.25.228.203:8077',
    channel: 'beta',
  });
  assert.strictEqual(cfg.feedUrl, 'http://10.25.228.203:8077');
  assert.strictEqual(cfg.telemetryUrl, 'http://10.25.228.203:8077');
  assert.strictEqual(cfg.channel, 'beta');
});

test('unknown channel normalizes to stable', () => {
  assert.strictEqual(resolveUpdateConfig({ channel: 'weird' }).channel, 'stable');
});

test('missing channel defaults to stable', () => {
  assert.strictEqual(resolveUpdateConfig({}).channel, 'stable');
});

test('empty app-config yields empty urls and false guards', () => {
  const cfg = resolveUpdateConfig({});
  assert.strictEqual(cfg.feedUrl, '');
  assert.strictEqual(cfg.telemetryUrl, '');
  assert.strictEqual(shouldCheckForUpdates(cfg), false);
  assert.strictEqual(shouldReportTelemetry(cfg), false);
});

test('empty dev app-config disables update + telemetry', () => {
  // electron/app-config.json (dev/repo fallback) leaves feed/telemetry empty.
  const cfg = resolveUpdateConfig({ netcoworkBaseUrl: 'http://172.20.10.2:5174', feedUrl: '', telemetryUrl: '', channel: 'stable' });
  assert.strictEqual(shouldCheckForUpdates(cfg), false);
  assert.strictEqual(shouldReportTelemetry(cfg), false);
});

test('guards true when urls present', () => {
  const cfg = resolveUpdateConfig({ feedUrl: 'http://x', telemetryUrl: 'http://y' });
  assert.strictEqual(shouldCheckForUpdates(cfg), true);
  assert.strictEqual(shouldReportTelemetry(cfg), true);
});
