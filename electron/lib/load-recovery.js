'use strict';

// Decision logic for recovering the main window's UI load. Lives here rather
// than in main.js so it can be tested without an Electron runtime.

// Chromium net errors that say nothing about the backend: the browser's own
// network stack was paused (system sleep) or torn down and rebuilt (adapter /
// VPN change). The backend keeps serving on loopback throughout; only the load
// needs to happen again.
const TRANSIENT_LOAD_ERRORS = new Set([
  -21,   // ERR_NETWORK_CHANGED
  -106,  // ERR_INTERNET_DISCONNECTED
  -331,  // ERR_NETWORK_IO_SUSPENDED
]);

const MAX_UI_LOAD_RETRIES = 6;   // 1+2+4+8+8+8 ≈ 31s before we give up and ask the user

function isTransientLoadError(errorCode) {
  return TRANSIENT_LOAD_ERRORS.has(errorCode);
}

// True while a transient failure still deserves an automatic retry.
function shouldRetryLoad(errorCode, attempt, maxRetries = MAX_UI_LOAD_RETRIES) {
  return isTransientLoadError(errorCode) && attempt < maxRetries;
}

// Exponential backoff, capped. `attempt` is the number of retries already made.
function retryDelayMs(attempt, capMs = 8000) {
  return Math.min(1000 * 2 ** attempt, capMs);
}

// A suspended machine freezes timers; on resume they fire at once even though
// the renderer only had a moment to mount. Seen in the field as a bogus "white
// screen" box popping up 14h after the load. Wall clock tells the two apart: a
// real timeout elapsed ≈timeoutMs, an overslept one did not.
function watchdogOverslept(armedAt, now, timeoutMs) {
  return now - armedAt > timeoutMs * 2;
}

module.exports = {
  TRANSIENT_LOAD_ERRORS,
  MAX_UI_LOAD_RETRIES,
  isTransientLoadError,
  shouldRetryLoad,
  retryDelayMs,
  watchdogOverslept,
};
