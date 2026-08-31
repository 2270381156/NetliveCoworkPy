'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { planRetirement } = require('../lib/seed-retirement');

test('still-bundled entries are never retired', () => {
  const r = planRetirement({
    seededHashes: { docx: 'h1', pdf: 'h2' },
    bundleEntries: ['docx', 'pdf'],
    destState: { docx: { exists: true, hash: 'h1' }, pdf: { exists: true, hash: 'h2' } },
  });
  assert.deepStrictEqual(r.toDelete, []);
  assert.deepStrictEqual(r.toRelease, []);
  assert.deepStrictEqual(r.toForget, []);
});

test('dropped + pristine entry is deleted and forgotten', () => {
  const r = planRetirement({
    seededHashes: { docx: 'h1', legacy: 'hOld' },
    bundleEntries: ['docx'],                               // legacy no longer shipped
    destState: { legacy: { exists: true, hash: 'hOld' } }, // untouched since we wrote it
  });
  assert.deepStrictEqual(r.toDelete, ['legacy']);
  assert.deepStrictEqual(r.toRelease, []);
  assert.deepStrictEqual(r.toForget, ['legacy']);
});

test('dropped + user-modified entry is released (kept) and forgotten', () => {
  const r = planRetirement({
    seededHashes: { legacy: 'hOld' },
    bundleEntries: [],
    destState: { legacy: { exists: true, hash: 'hUserEdited' } },
  });
  assert.deepStrictEqual(r.toDelete, []);
  assert.deepStrictEqual(r.toRelease, ['legacy']);        // never deleted — user owns it now
  assert.deepStrictEqual(r.toForget, ['legacy']);
});

test('user-added dirs (never in ledger) are invisible to GC', () => {
  // `mine` was pulled by the user: not in seededHashes → cannot appear in any list.
  const r = planRetirement({
    seededHashes: { docx: 'h1' },
    bundleEntries: ['docx'],
    destState: {},                                         // caller wouldn't even probe `mine`
  });
  assert.deepStrictEqual(r.toDelete, []);
  assert.deepStrictEqual(r.toRelease, []);
  assert.deepStrictEqual(r.toForget, []);
});

test('already-vanished entry is only forgotten, not deleted', () => {
  const r = planRetirement({
    seededHashes: { legacy: 'hOld' },
    bundleEntries: [],
    destState: { legacy: { exists: false, hash: null } },  // user already removed it by hand
  });
  assert.deepStrictEqual(r.toDelete, []);
  assert.deepStrictEqual(r.toRelease, []);
  assert.deepStrictEqual(r.toForget, ['legacy']);
});

test('missing destState entry defaults to vanished (forget only)', () => {
  const r = planRetirement({
    seededHashes: { legacy: 'hOld' },
    bundleEntries: [],
    destState: {},                                         // no probe result supplied
  });
  assert.deepStrictEqual(r.toDelete, []);
  assert.deepStrictEqual(r.toRelease, []);
  assert.deepStrictEqual(r.toForget, ['legacy']);
});

test('mixed bundle: refresh-survivor, delete-pristine, release-edited at once', () => {
  const r = planRetirement({
    seededHashes: { docx: 'h1', oldPristine: 'p0', oldEdited: 'e0' },
    bundleEntries: ['docx'],
    destState: {
      oldPristine: { exists: true, hash: 'p0' },
      oldEdited: { exists: true, hash: 'eX' },
    },
  });
  assert.deepStrictEqual(r.toDelete, ['oldPristine']);
  assert.deepStrictEqual(r.toRelease, ['oldEdited']);
  assert.deepStrictEqual(r.toForget.sort(), ['oldEdited', 'oldPristine']);
});

test('empty manifest yields empty plan', () => {
  const r = planRetirement({ seededHashes: {}, bundleEntries: ['docx'], destState: {} });
  assert.deepStrictEqual(r, { toDelete: [], toRelease: [], toForget: [] });
});
