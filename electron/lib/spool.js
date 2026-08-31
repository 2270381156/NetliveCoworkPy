'use strict';
const fs = require('fs');

// Backend appends one JSON event per line (open-append-close per write, never
// holds a long-lived fd — required so our rename below can't fail on Windows).
// Contract: spec §5.

function parseSpoolText(text) {
  const events = [];
  let errors = 0;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') events.push(obj);
      else errors += 1;
    } catch (_) {
      errors += 1;
    }
  }
  return { events, errors };
}

// rename-then-read: atomic hand-off so a concurrent backend append lands in a
// fresh spool file instead of the one being read. A leftover .draining file
// (crash between rename and unlink) is recovered before taking a new batch.
function drainSpool({ spoolPath, fsImpl = fs }) {
  const draining = spoolPath + '.draining';
  try {
    if (!fsImpl.existsSync(draining)) {
      if (!fsImpl.existsSync(spoolPath)) return [];
      fsImpl.renameSync(spoolPath, draining);
    }
    const { events } = parseSpoolText(fsImpl.readFileSync(draining, 'utf8'));
    fsImpl.unlinkSync(draining);
    return events;
  } catch (_) {
    return []; // racing write / locked file → retry on next tick
  }
}

module.exports = { parseSpoolText, drainSpool };
