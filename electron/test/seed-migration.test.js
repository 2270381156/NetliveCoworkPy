'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { planSeedMigration } = require('../lib/seed-migration');

test('same version still reports missing items but versionChanged=false', () => {
  const r = planSeedMigration({
    installedVersion: '0.1.0', currentVersion: '0.1.0',
    bundledConfigFiles: ['a.json', 'b.json'], existingConfigFiles: ['a.json'],
    bundledEnvKeys: ['K1', 'K2'], existingEnvKeys: ['K1'],
  });
  assert.strictEqual(r.versionChanged, false);
  assert.deepStrictEqual(r.filesToCopy, ['b.json']);
  assert.deepStrictEqual(r.envKeysToAdd, ['K2']);
});

test('upgrade reports version change and missing items', () => {
  const r = planSeedMigration({
    installedVersion: '0.1.0', currentVersion: '0.1.1',
    bundledConfigFiles: ['a.json', 'b.json'], existingConfigFiles: ['a.json'],
    bundledEnvKeys: ['K1', 'K2', 'K3'], existingEnvKeys: ['K1', 'K2'],
  });
  assert.strictEqual(r.versionChanged, true);
  assert.deepStrictEqual(r.filesToCopy, ['b.json']);
  assert.deepStrictEqual(r.envKeysToAdd, ['K3']);
});

test('first install (no installed version) is a version change', () => {
  const r = planSeedMigration({
    installedVersion: null, currentVersion: '0.1.0',
    bundledConfigFiles: ['a.json'], existingConfigFiles: [],
    bundledEnvKeys: ['K1'], existingEnvKeys: [],
  });
  assert.strictEqual(r.versionChanged, true);
  assert.deepStrictEqual(r.filesToCopy, ['a.json']);
  assert.deepStrictEqual(r.envKeysToAdd, ['K1']);
});

test('nothing missing yields empty lists', () => {
  const r = planSeedMigration({
    installedVersion: '0.1.0', currentVersion: '0.1.1',
    bundledConfigFiles: ['a.json'], existingConfigFiles: ['a.json'],
    bundledEnvKeys: ['K1'], existingEnvKeys: ['K1'],
  });
  assert.deepStrictEqual(r.filesToCopy, []);
  assert.deepStrictEqual(r.envKeysToAdd, []);
});
