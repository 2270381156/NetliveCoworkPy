'use strict';

const { contextsEqual, prepareRetryBatch } = require('./token-usage');

function createTokenUsageController({
  getContext,
  getCloudBaseUrl,
  drainLocal,
  ackLocal = async () => true,
  loadRetryQueue,
  saveRetryQueue,
  postEvent,
  log = () => {},
  maxItems = 500,
  AbortControllerImpl = AbortController,
}) {
  let transitioning = false;
  let inFlight = null;
  let trailing = false;
  let cloudAbortController = null;

  function persist(entries) {
    try {
      return saveRetryQueue(entries) !== false;
    } catch (error) {
      log(`token-usage: retry persistence failed — ${error.message}`);
      return false;
    }
  }

  function readContext() {
    try {
      return getContext();
    } catch (error) {
      log(`token-usage: cannot establish auth epoch — ${error.message}`);
      return null;
    }
  }

  async function runDrain() {
    if (transitioning) return;
    const context = readContext();
    if (!context || !context.token) return;
    const cloudBase = getCloudBaseUrl();
    if (!cloudBase) return;

    let drained = [];
    let claimId = null;
    try {
      const value = await drainLocal();
      if (Array.isArray(value)) {
        drained = value; // compatibility with the pre-claim local endpoint
      } else if (value && typeof value === 'object' && Array.isArray(value.events)) {
        claimId = typeof value.claimId === 'string' && value.claimId ? value.claimId : null;
        drained = claimId
          ? value.events.map((event, index) => ({
            event,
            itemId: `spool:${claimId}:${index}`,
          }))
          : value.events;
      }
    } catch (_) {
      // The Python spool remains on disk when its local endpoint is unavailable.
    }

    const prepared = prepareRetryBatch({
      retryQueue: loadRetryQueue(),
      drainedEvents: drained,
      context,
      // Do not apply the safety cap before attempting delivery: doing so would
      // discard the oldest valid event even when the cloud has already recovered.
      maxItems: Number.MAX_SAFE_INTEGER,
    });
    let pending = prepared.entries;
    if (prepared.discarded) {
      log(`token-usage: discarded ${prepared.discarded} pre-login/invalid record(s)`
        + (prepared.overflow ? ` (${prepared.overflow} over queue limit)` : ''));
    }

    // Never ack a claimed Python batch (or POST its events) until every accepted
    // event has been durably handed to Electron's retry queue.
    if (!persist(pending)) return;
    if (claimId) {
      try {
        if (await ackLocal(claimId) === false) return;
      } catch (_) {
        // The claim remains in Python. Its stable claimId/index item IDs make a
        // later claim retry safe and de-duplicated against this durable queue.
        return;
      }
    }

    for (const entry of [...pending]) {
      if (transitioning) break;
      const latest = readContext();
      if (!latest || !contextsEqual(latest, context) || latest.token !== context.token) break;

      const controller = new AbortControllerImpl();
      cloudAbortController = controller;
      try {
        await postEvent(entry.event, context, cloudBase, controller.signal);
      } catch (_) {
        if (controller.signal.aborted || transitioning) break;
        continue; // keep this event in the durable retry queue
      } finally {
        if (cloudAbortController === controller) cloudAbortController = null;
      }

      const index = pending.findIndex((value) => value.itemId === entry.itemId);
      if (index >= 0) pending = [...pending.slice(0, index), ...pending.slice(index + 1)];
      if (!persist(pending)) return;
    }

    // Preserve the original policy: only the records that still failed after a
    // delivery attempt are capped.  Successful recovery gets a chance to flush
    // the entire queue first.
    if (pending.length > maxItems) {
      const overflow = pending.length - maxItems;
      pending = pending.slice(overflow);
      log(`token-usage: discarded ${overflow} failed record(s) over queue limit`);
      persist(pending);
    }
  }

  function requestDrain() {
    if (transitioning) {
      trailing = true;
      return Promise.resolve();
    }
    if (inFlight) {
      trailing = true;
      return inFlight;
    }

    trailing = false;
    const run = runDrain();
    inFlight = run;
    const clear = () => {
      if (inFlight !== run) return;
      inFlight = null;
      if (trailing && !transitioning) {
        trailing = false;
        requestDrain().catch(() => {});
      }
    };
    run.then(clear, clear);
    return run;
  }

  async function beginAuthTransition() {
    if (transitioning) throw new Error('认证状态正在切换，请稍候');
    // This assignment happens before the first await, closing every startup /
    // SSE / timer entry point immediately.
    transitioning = true;
    if (cloudAbortController) cloudAbortController.abort();
    const current = inFlight;
    if (current) {
      try { await current; } catch (_) { /* drain is best effort */ }
    }
  }

  function endAuthTransition({ drain = false } = {}) {
    transitioning = false;
    if (drain) requestDrain().catch(() => {});
    else trailing = false;
  }

  function pruneRetryForCurrentContext() {
    const context = readContext();
    if (!context) return { entries: [], discarded: 0, overflow: 0, saved: false };
    const prepared = prepareRetryBatch({
      retryQueue: loadRetryQueue(),
      drainedEvents: [],
      context,
      maxItems: Number.MAX_SAFE_INTEGER,
    });
    return { ...prepared, saved: persist(prepared.entries) };
  }

  function clearRetry() {
    return persist([]);
  }

  function stateForTest() {
    return { transitioning, inFlight: !!inFlight, trailing };
  }

  return {
    beginAuthTransition,
    clearRetry,
    endAuthTransition,
    pruneRetryForCurrentContext,
    requestDrain,
    stateForTest,
  };
}

module.exports = { createTokenUsageController };
