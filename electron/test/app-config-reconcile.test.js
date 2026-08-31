'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileAppConfig, APP_CONFIG_FORCE_KEYS } = require('../lib/app-config-reconcile');

const FACTORY = {
  netcoworkBaseUrl: 'http://10.25.228.203:8070',
  substrateBaseUrl: 'http://10.25.228.203:8070/substrate',
  feedUrl: 'http://10.25.228.203:8077',
  telemetryUrl: 'http://10.25.228.203:8077',
  channel: 'stable',
};

test('force keys are the four cloud URLs', () => {
  assert.deepStrictEqual(APP_CONFIG_FORCE_KEYS,
    ['netcoworkBaseUrl', 'substrateBaseUrl', 'feedUrl', 'telemetryUrl']);
});

test('the cloud URLs are force-overwritten from factory', () => {
  const user = {
    netcoworkBaseUrl: 'http://old', substrateBaseUrl: 'http://old/substrate',
    feedUrl: 'http://old', telemetryUrl: 'http://old', channel: 'beta',
  };
  const out = reconcileAppConfig(user, FACTORY);
  for (const k of APP_CONFIG_FORCE_KEYS) assert.strictEqual(out[k], FACTORY[k], k);
});

// substrate 做成 preserve 的话：换环境重打包之后，老机器上那份用户副本仍指着旧地址
// —— 表现是"新版装上了但阵容还是旧的"，且不报错。
test('a stale substrate address in the user copy is reset, not kept', () => {
  const out = reconcileAppConfig({ substrateBaseUrl: 'https://old-env/substrate' }, FACTORY);
  assert.strictEqual(out.substrateBaseUrl, FACTORY.substrateBaseUrl);
});

// 出厂没这个键时不许凭空造一个空串 —— 空串的含义是「这个部署没有云端」，
// 与「这个构建还没配」是两回事。同一个坑在 skill 市场地址上踩过一次。
test('a factory without the key does not invent an empty one', () => {
  const { substrateBaseUrl, ...noSubstrate } = FACTORY;
  const out = reconcileAppConfig({ substrateBaseUrl: 'https://kept/substrate' }, noSubstrate);
  assert.strictEqual(out.substrateBaseUrl, 'https://kept/substrate');
});

test('channel is preserved from the user copy', () => {
  const out = reconcileAppConfig({ ...FACTORY, channel: 'beta' }, FACTORY);
  assert.strictEqual(out.channel, 'beta');
});

test('missing channel falls back to factory', () => {
  const out = reconcileAppConfig({ netcoworkBaseUrl: 'x' }, FACTORY);
  assert.strictEqual(out.channel, 'stable');
});

test('unknown user keys are preserved', () => {
  const out = reconcileAppConfig({ ...FACTORY, foo: 'bar' }, FACTORY);
  assert.strictEqual(out.foo, 'bar');
});

test('new factory keys are added', () => {
  const out = reconcileAppConfig({ channel: 'beta' }, { ...FACTORY, newKey: 'v' });
  assert.strictEqual(out.newKey, 'v');
});

test('empty user copy yields the factory config', () => {
  assert.deepStrictEqual(reconcileAppConfig({}, FACTORY), FACTORY);
});

test('non-object inputs are tolerated', () => {
  assert.deepStrictEqual(reconcileAppConfig(null, FACTORY), FACTORY);
  assert.deepStrictEqual(reconcileAppConfig(undefined, undefined), {});
});

test('idempotent: reconciling an already-reconciled copy is a no-op', () => {
  const once = reconcileAppConfig({ channel: 'beta' }, FACTORY);
  const twice = reconcileAppConfig(once, FACTORY);
  assert.deepStrictEqual(twice, once);
});
