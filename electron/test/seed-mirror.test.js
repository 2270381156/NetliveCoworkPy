'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { planMirror } = require('../lib/seed-mirror');

test('present entries not in the bundle are removed', () => {
  const r = planMirror({ shipped: ['default'], present: ['default', 'mine', 'pulled'] });
  assert.deepStrictEqual(r.toRemove, ['mine', 'pulled']);
});

test('shipped entries are always kept (never removed)', () => {
  const r = planMirror({ shipped: ['default', 'extra'], present: ['default', 'extra'] });
  assert.deepStrictEqual(r.toRemove, []);
});

test('empty bundle removes everything present', () => {
  const r = planMirror({ shipped: [], present: ['default', 'mine'] });
  assert.deepStrictEqual(r.toRemove, ['default', 'mine']);
});

test('nothing on disk yields nothing to remove', () => {
  const r = planMirror({ shipped: ['default'], present: [] });
  assert.deepStrictEqual(r.toRemove, []);
});

test('order follows present, not shipped', () => {
  const r = planMirror({ shipped: ['b'], present: ['z', 'b', 'a'] });
  assert.deepStrictEqual(r.toRemove, ['z', 'a']);
});

test('defaults: empty inputs → empty plan', () => {
  assert.deepStrictEqual(planMirror(), { toRemove: [] });
});
