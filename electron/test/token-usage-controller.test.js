'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createTokenUsageController } = require('../lib/token-usage-controller');
const { wrapRetryEvent } = require('../lib/token-usage');

const boundary = Date.parse('2026-07-13T08:00:00.000Z');

function context(overrides = {}) {
  return {
    token: 'jwt-b',
    epochId: 'epoch-b',
    userId: 'user-b',
    notBeforeMs: boundary,
    ...overrides,
  };
}

function event(ts, suffix) {
  return {
    event_type: 'token_usage',
    ts,
    session_id: `desktop:session:${suffix}`,
    input_tokens: 10,
    output_tokens: 2,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function memoryController({
  current = context(),
  retry = [],
  drainLocal = async () => [],
  ackLocal = async () => true,
  saveRetryQueue,
  postEvent = async () => {},
} = {}) {
  let currentContext = current;
  let queue = retry;
  const saves = [];
  const posts = [];
  const controller = createTokenUsageController({
    getContext: () => currentContext,
    getCloudBaseUrl: () => 'https://cloud.example',
    drainLocal,
    ackLocal,
    loadRetryQueue: () => queue,
    saveRetryQueue: saveRetryQueue || ((value) => {
      queue = value;
      saves.push(value.map((entry) => entry.itemId));
      return true;
    }),
    postEvent: async (...args) => {
      posts.push(args[0].session_id);
      return postEvent(...args);
    },
  });
  return {
    controller,
    get queue() { return queue; },
    get currentContext() { return currentContext; },
    set currentContext(value) { currentContext = value; },
    posts,
    saves,
  };
}

test('mixed local batch drops stock and persists new usage before POST', async () => {
  const old = event('2026-07-13T07:59:59.000Z', 'old');
  const fresh = event('2026-07-13T08:00:01.000Z', 'fresh');
  let harness;
  harness = memoryController({
    drainLocal: async () => [old, fresh],
    postEvent: async () => {
      assert.strictEqual(harness.queue.length, 1, 'accepted event must be durable before POST');
      assert.strictEqual(harness.queue[0].event.session_id, fresh.session_id);
    },
  });

  await harness.controller.requestDrain();

  assert.deepStrictEqual(harness.posts, [fresh.session_id]);
  assert.deepStrictEqual(harness.queue, []);
  assert.strictEqual(harness.saves.length, 2); // full pending queue, then success removal
});

test('retry persistence failure is fail-closed and never calls cloud POST', async () => {
  let postCount = 0;
  const harness = memoryController({
    drainLocal: async () => [event('2026-07-13T08:00:01.000Z', 'fresh')],
    saveRetryQueue: () => false,
    postEvent: async () => { postCount += 1; },
  });

  await harness.controller.requestDrain();
  assert.strictEqual(postCount, 0);
});

test('claimed Python batch is acked only after retry persistence succeeds', async () => {
  let ackCount = 0;
  let postCount = 0;
  const harness = memoryController({
    drainLocal: async () => ({
      claimId: 'claim-1',
      events: [event('2026-07-13T08:00:01.000Z', 'fresh')],
    }),
    ackLocal: async () => { ackCount += 1; return true; },
    saveRetryQueue: () => false,
    postEvent: async () => { postCount += 1; },
  });

  await harness.controller.requestDrain();
  assert.strictEqual(ackCount, 0);
  assert.strictEqual(postCount, 0);
});

test('replayed unacked claim is de-duplicated by stable claim item id', async () => {
  let ackCount = 0;
  const claim = {
    claimId: 'claim-replayed',
    events: [event('2026-07-13T08:00:01.000Z', 'fresh')],
  };
  const harness = memoryController({
    drainLocal: async () => claim,
    ackLocal: async () => {
      ackCount += 1;
      return ackCount > 1;
    },
  });

  await harness.controller.requestDrain();
  assert.strictEqual(harness.posts.length, 0);
  assert.strictEqual(harness.queue.length, 1);
  assert.strictEqual(harness.queue[0].itemId, 'spool:claim-replayed:0');

  await harness.controller.requestDrain();
  assert.strictEqual(harness.posts.length, 1);
  assert.deepStrictEqual(harness.queue, []);
});

test('startup, SSE and timer triggers are single-flight with one trailing pass', async () => {
  const first = deferred();
  let localCalls = 0;
  let active = 0;
  let maxActive = 0;
  const harness = memoryController({
    drainLocal: async () => {
      localCalls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (localCalls === 1) await first.promise;
      active -= 1;
      return [];
    },
  });

  const startup = harness.controller.requestDrain();
  const sse = harness.controller.requestDrain();
  const timer = harness.controller.requestDrain();
  assert.strictEqual(localCalls, 1);
  first.resolve();
  await Promise.all([startup, sse, timer]);
  await until(() => localCalls === 2 && !harness.controller.stateForTest().inFlight);

  assert.strictEqual(maxActive, 1);
  assert.strictEqual(localCalls, 2);
});

test('login transition aborts a cloud request only after its item is durable', async () => {
  const ctx = context();
  const queued = wrapRetryEvent(event('2026-07-13T08:00:01.000Z', 'queued'), ctx, 'queued-item');
  const postStarted = deferred();
  const harness = memoryController({
    current: ctx,
    retry: [queued],
    postEvent: (_event, _context, _base, signal) => new Promise((resolve, reject) => {
      postStarted.resolve();
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });

  const drain = harness.controller.requestDrain();
  await postStarted.promise;
  const transition = harness.controller.beginAuthTransition();
  await transition;
  await drain;

  assert.strictEqual(harness.queue.length, 1);
  assert.strictEqual(harness.queue[0].itemId, 'queued-item');
  assert.strictEqual(harness.controller.stateForTest().transitioning, true);

  harness.currentContext = context({ token: 'jwt-c', epochId: 'epoch-c', userId: 'user-c' });
  const pruned = harness.controller.pruneRetryForCurrentContext();
  assert.strictEqual(pruned.discarded, 1);
  assert.deepStrictEqual(harness.queue, []);
  harness.controller.endAuthTransition();
});

test('identical payloads are removed by itemId, not by payload equality', async () => {
  const ctx = context();
  const payload = event('2026-07-13T08:00:01.000Z', 'same');
  const first = wrapRetryEvent(payload, ctx, 'item-1');
  const second = wrapRetryEvent({ ...payload }, ctx, 'item-2');
  let calls = 0;
  const harness = memoryController({
    current: ctx,
    retry: [first, second],
    postEvent: async () => {
      calls += 1;
      if (calls === 2) throw new Error('network down');
    },
  });

  await harness.controller.requestDrain();

  assert.deepStrictEqual(harness.queue.map((entry) => entry.itemId), ['item-2']);
});

test('queue limit is applied after delivery attempts, not before recovery', async () => {
  const ctx = context();
  const retry = Array.from({ length: 500 }, (_, index) => wrapRetryEvent(
    event('2026-07-13T08:00:01.000Z', `retry-${index}`),
    ctx,
    `retry-item-${index}`,
  ));
  const fresh = event('2026-07-13T08:00:02.000Z', 'fresh-501');
  const harness = memoryController({
    current: ctx,
    retry,
    drainLocal: async () => [fresh],
  });

  await harness.controller.requestDrain();

  assert.strictEqual(harness.posts.length, 501);
  assert.strictEqual(harness.posts[0], 'desktop:session:retry-0');
  assert.strictEqual(harness.posts[500], fresh.session_id);
  assert.deepStrictEqual(harness.queue, []);
});

test('queue limit retains the newest 500 records only after all sends fail', async () => {
  const ctx = context();
  const retry = Array.from({ length: 500 }, (_, index) => wrapRetryEvent(
    event('2026-07-13T08:00:01.000Z', `retry-${index}`),
    ctx,
    `retry-item-${index}`,
  ));
  const harness = memoryController({
    current: ctx,
    retry,
    drainLocal: async () => [event('2026-07-13T08:00:02.000Z', 'fresh-501')],
    postEvent: async () => { throw new Error('offline'); },
  });

  await harness.controller.requestDrain();

  assert.strictEqual(harness.posts.length, 501);
  assert.strictEqual(harness.queue.length, 500);
  assert.strictEqual(harness.queue[0].itemId, 'retry-item-1');
  assert.strictEqual(harness.queue[499].event.session_id, 'desktop:session:fresh-501');
});
