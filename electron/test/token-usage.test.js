'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildTokenUsagePayload,
  contextsEqual,
  eventIsAfterLoginBoundary,
  loadJsonArray,
  prepareRetryBatch,
  saveJsonArrayAtomic,
  wrapRetryEvent,
} = require('../lib/token-usage');

const boundary = Date.parse('2026-07-13T08:00:00.000Z');
const context = { epochId: 'epoch-new', userId: 'user-b', notBeforeMs: boundary };

function event(ts, suffix = '1') {
  return {
    event_type: 'token_usage',
    ts,
    session_id: `desktop:session:${suffix}`,
    input_tokens: 10,
    output_tokens: 2,
  };
}

test('cloud payload contains only the five token-usage contract fields', () => {
  const payload = buildTokenUsagePayload({
    ...event('2026-07-13T08:00:01.000Z'),
    project_id: 'legacy-project',
    task_id: 'legacy-task',
    llm_account: 'account-a',
    llm_model: 'model-a',
  });

  assert.deepStrictEqual(payload, {
    sessionId: 'desktop:session:1',
    cowork: '',
    inputTokens: 10,
    outputTokens: 2,
    llmAccount: 'account-a',
    llmModel: 'model-a',
  });
  assert.deepStrictEqual(Object.keys(payload), [
    'sessionId',
    'cowork',
    'inputTokens',
    'outputTokens',
    'llmAccount',
    'llmModel',
  ]);
});

test('login boundary strictly drops old/equal/invalid events and retains new events', () => {
  assert.strictEqual(eventIsAfterLoginBoundary(event('2026-07-13T07:59:59.999Z'), context), false);
  assert.strictEqual(eventIsAfterLoginBoundary(event('2026-07-13T08:00:00.000Z'), context), false);
  assert.strictEqual(eventIsAfterLoginBoundary(event('2026-07-13T08:00:00.001Z'), context), true);
  assert.strictEqual(eventIsAfterLoginBoundary(event('not-a-date'), context), false);
  assert.strictEqual(eventIsAfterLoginBoundary({ session_id: 'desktop:old' }, context), false);
});

test('mixed retry/spool batch accepts only the current login epoch', () => {
  const oldRaw = event('2026-07-13T07:00:00.000Z', 'old-raw');
  const newRaw = event('2026-07-13T08:00:01.000Z', 'new-raw');
  const oldEpoch = wrapRetryEvent(
    event('2026-07-13T08:00:02.000Z', 'old-epoch'),
    { ...context, epochId: 'epoch-old' },
    'old-epoch-item',
  );
  const wrongUser = wrapRetryEvent(
    event('2026-07-13T08:00:03.000Z', 'wrong-user'),
    { ...context, userId: 'user-a' },
    'wrong-user-item',
  );
  const current = wrapRetryEvent(
    event('2026-07-13T08:00:04.000Z', 'current'),
    context,
    'current-item',
  );

  const result = prepareRetryBatch({
    retryQueue: [oldRaw, newRaw, oldEpoch, wrongUser, current],
    drainedEvents: [
      event('2026-07-13T07:59:59.000Z', 'spool-old'),
      event('2026-07-13T08:00:05.000Z', 'spool-new'),
      { ts: '2026-07-13T08:00:06.000Z' },
    ],
    context,
  });

  assert.deepStrictEqual(
    result.entries.map((entry) => entry.event.session_id),
    ['desktop:session:new-raw', 'desktop:session:current', 'desktop:session:spool-new'],
  );
  assert.strictEqual(result.discarded, 5);
  assert.ok(result.entries.every((entry) => entry.authEpochId === context.epochId));
  assert.ok(result.entries.every((entry) => entry.userId === context.userId));
});

test('filtering happens before queue cap so legacy stock cannot evict new usage', () => {
  const old = Array.from({ length: 500 }, (_, index) =>
    event(`2026-07-12T00:00:${String(index % 60).padStart(2, '0')}.000Z`, `old-${index}`));
  const fresh = event('2026-07-13T08:00:10.000Z', 'fresh');
  const result = prepareRetryBatch({
    retryQueue: old,
    drainedEvents: [fresh],
    context,
    maxItems: 1,
  });

  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].event.session_id, fresh.session_id);
  assert.strictEqual(result.overflow, 0);
  assert.strictEqual(result.discarded, 500);
});

test('identical payloads receive stable distinct item ids', () => {
  const payload = event('2026-07-13T08:00:10.000Z', 'same');
  const first = wrapRetryEvent(payload, context, 'item-1');
  const second = wrapRetryEvent({ ...payload }, context, 'item-2');
  const result = prepareRetryBatch({ retryQueue: [first, second], drainedEvents: [], context });

  assert.deepStrictEqual(result.entries.map((entry) => entry.itemId), ['item-1', 'item-2']);
  const afterFirstSuccess = result.entries.filter((entry) => entry.itemId !== 'item-1');
  assert.deepStrictEqual(afterFirstSuccess.map((entry) => entry.itemId), ['item-2']);
});

test('context comparison includes epoch, user and login boundary', () => {
  assert.strictEqual(contextsEqual(context, { ...context }), true);
  assert.strictEqual(contextsEqual(context, { ...context, epochId: 'other' }), false);
  assert.strictEqual(contextsEqual(context, { ...context, userId: 'other' }), false);
  assert.strictEqual(contextsEqual(context, { ...context, notBeforeMs: boundary + 1 }), false);
});

test('retry queue is replaced through a temp file and remains valid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-token-usage-'));
  const file = path.join(dir, 'token-usage-retry.json');
  fs.writeFileSync(file, JSON.stringify([{ old: true }]), 'utf8');

  const value = [wrapRetryEvent(event('2026-07-13T08:00:11.000Z'), context, 'saved-item')];
  saveJsonArrayAtomic(file, value);

  assert.deepStrictEqual(loadJsonArray(file), value);
  assert.strictEqual(fs.existsSync(`${file}.tmp`), false);
});

test('malformed or non-array retry files fail closed as an empty queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-token-usage-'));
  const file = path.join(dir, 'token-usage-retry.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.deepStrictEqual(loadJsonArray(file), []);
  fs.writeFileSync(file, '{"not":"an array"}', 'utf8');
  assert.deepStrictEqual(loadJsonArray(file), []);
});

test('a complete temp queue is recovered after a crash before rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-token-usage-'));
  const file = path.join(dir, 'token-usage-retry.json');
  const committed = [wrapRetryEvent(event('2026-07-13T08:00:11.000Z'), context, 'old')];
  const newer = [...committed, wrapRetryEvent(event('2026-07-13T08:00:12.000Z'), context, 'new')];
  fs.writeFileSync(file, JSON.stringify(committed), 'utf8');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(newer), 'utf8');

  assert.deepStrictEqual(loadJsonArray(file), newer);

  fs.writeFileSync(`${file}.tmp`, '{partial', 'utf8');
  assert.deepStrictEqual(loadJsonArray(file), committed);
});

test('rename failure preserves a complete temp queue for recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipmc-token-usage-'));
  const file = path.join(dir, 'token-usage-retry.json');
  const committed = [wrapRetryEvent(event('2026-07-13T08:00:11.000Z'), context, 'old')];
  const newer = [...committed, wrapRetryEvent(event('2026-07-13T08:00:12.000Z'), context, 'new')];
  fs.writeFileSync(file, JSON.stringify(committed), 'utf8');

  assert.throws(() => saveJsonArrayAtomic(file, newer, {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    renameSync: () => { throw new Error('rename blocked'); },
  }), /rename blocked/);

  assert.strictEqual(fs.existsSync(`${file}.tmp`), true);
  assert.deepStrictEqual(loadJsonArray(file), newer);
});
