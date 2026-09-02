'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RETRY_ENTRY_VERSION = 1;

function userIdOf(user) {
  return user && user.id != null ? String(user.id) : '';
}

function normalizeContext(context) {
  if (!context || typeof context !== 'object') return null;
  const epochId = typeof context.epochId === 'string' ? context.epochId.trim() : '';
  const notBeforeMs = Number(context.notBeforeMs);
  if (!epochId || !Number.isFinite(notBeforeMs)) return null;
  return {
    epochId,
    userId: context.userId == null ? '' : String(context.userId),
    notBeforeMs,
  };
}

function contextsEqual(left, right) {
  const a = normalizeContext(left);
  const b = normalizeContext(right);
  return !!a && !!b
    && a.epochId === b.epochId
    && a.userId === b.userId
    && a.notBeforeMs === b.notBeforeMs;
}

function eventTimestampMs(event) {
  if (!event || typeof event !== 'object' || typeof event.ts !== 'string') return null;
  const value = Date.parse(event.ts);
  return Number.isFinite(value) ? value : null;
}

function eventIsAfterLoginBoundary(event, context) {
  const ctx = normalizeContext(context);
  if (!ctx) return false;
  const eventMs = eventTimestampMs(event);
  // Fail closed: a legacy/malformed record without a trustworthy occurrence
  // time must never be attributed to whoever happens to log in next.
  return eventMs != null && eventMs > ctx.notBeforeMs;
}

function buildTokenUsagePayload(event) {
  const value = event && typeof event === 'object' ? event : {};
  return {
    sessionId: value.session_id,
    cowork: value.cowork || '',
    inputTokens: value.input_tokens || 0,
    outputTokens: value.output_tokens || 0,
    llmAccount: value.llm_account || '',
    llmModel: value.llm_model || '',
  };
}

function isRetryEntry(value) {
  return !!value && typeof value === 'object'
    && value.version === RETRY_ENTRY_VERSION
    && typeof value.authEpochId === 'string'
    && value.event && typeof value.event === 'object';
}

function newItemId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function wrapRetryEvent(event, context, itemId = newItemId()) {
  const ctx = normalizeContext(context);
  if (!ctx) throw new TypeError('invalid token-usage auth context');
  return {
    version: RETRY_ENTRY_VERSION,
    itemId,
    authEpochId: ctx.epochId,
    userId: ctx.userId,
    event,
  };
}

function retryEntryForContext(value, context) {
  const ctx = normalizeContext(context);
  if (!ctx) return null;

  if (isRetryEntry(value)) {
    if (value.authEpochId !== ctx.epochId) return null;
    if ((value.userId == null ? '' : String(value.userId)) !== ctx.userId) return null;
    if (!eventIsAfterLoginBoundary(value.event, ctx)) return null;
    return value;
  }

  // Upgrade path for the 0.4.22/0.4.23 raw-event retry format. Only a record
  // provably created in this login epoch may enter the new tagged queue.
  return eventIsAfterLoginBoundary(value, ctx) ? wrapRetryEvent(value, ctx) : null;
}

function prepareRetryBatch({ retryQueue, drainedEvents, context, maxItems = 500 }) {
  const retry = Array.isArray(retryQueue) ? retryQueue : [];
  const drained = Array.isArray(drainedEvents) ? drainedEvents : [];
  const accepted = [];
  const seenItemIds = new Set();
  let discarded = 0;

  const accept = (entry) => {
    if (entry.itemId && seenItemIds.has(entry.itemId)) {
      discarded += 1;
      return;
    }
    if (entry.itemId) seenItemIds.add(entry.itemId);
    accepted.push(entry);
  };

  for (const value of retry) {
    const entry = retryEntryForContext(value, context);
    if (entry) accept(entry);
    else discarded += 1;
  }
  for (const value of drained) {
    const claimed = value && typeof value === 'object'
      && value.event && typeof value.event === 'object'
      && typeof value.itemId === 'string';
    const event = claimed ? value.event : value;
    if (event && event.session_id && eventIsAfterLoginBoundary(event, context)) {
      accept(wrapRetryEvent(
        event,
        context,
        claimed ? value.itemId : newItemId(),
      ));
    } else {
      discarded += 1;
    }
  }

  const limit = Number.isInteger(maxItems) && maxItems >= 0 ? maxItems : 500;
  const overflow = Math.max(0, accepted.length - limit);
  return {
    entries: overflow ? accepted.slice(overflow) : accepted,
    discarded: discarded + overflow,
    overflow,
  };
}

function loadJsonArray(filePath, fsImpl = fs) {
  // A complete .tmp means the process died after persisting the new queue but
  // before rename.  It is newer than the destination and must win; an incomplete
  // temp file is ignored and the last committed destination remains usable.
  for (const candidate of [`${filePath}.tmp`, filePath]) {
    try {
      if (!fsImpl.existsSync(candidate)) continue;
      const value = JSON.parse(fsImpl.readFileSync(candidate, 'utf8'));
      if (Array.isArray(value)) return value;
    } catch (_) {
      // try the committed destination next
    }
  }
  return [];
}

function saveJsonArrayAtomic(filePath, value, fsImpl = fs) {
  if (!Array.isArray(value)) throw new TypeError('retry queue must be an array');
  const tmp = `${filePath}.tmp`;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fsImpl.renameSync(tmp, filePath);
  } catch (error) {
    // Do not unlink tmp here.  If write completed but rename was interrupted,
    // loadJsonArray() can recover this newer, complete queue on the next tick or
    // process start.  A partial temp file is harmless: the loader falls back to
    // the last committed destination.
    throw error;
  }
}

module.exports = {
  RETRY_ENTRY_VERSION,
  buildTokenUsagePayload,
  contextsEqual,
  eventIsAfterLoginBoundary,
  eventTimestampMs,
  isRetryEntry,
  loadJsonArray,
  normalizeContext,
  prepareRetryBatch,
  retryEntryForContext,
  saveJsonArrayAtomic,
  userIdOf,
  wrapRetryEvent,
};
