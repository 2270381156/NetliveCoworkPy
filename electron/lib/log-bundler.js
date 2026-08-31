'use strict';
const fs = require('fs');
const path = require('path');

// TimedRotatingFileHandler backup suffix: backend.log.YYYY-MM-DD (LOCAL date).
// Accept both backend.log.YYYY-MM-DD (Python TimedRotatingFileHandler default)
// and the backend.log.YYYY-MM-DD.log variant seen in some environments.
const ROTATED_BACKUP_RE = /^\d{4}-\d{2}-\d{2}(?:\.log)?$/;

// Reads the last maxBytes of a file (whole file if smaller). Returns null when
// the file is absent/unreadable so callers can skip it silently.
function tailFileSync(filePath, maxBytes, fsImpl = fs) {
  try {
    const buf = fsImpl.readFileSync(filePath);
    return buf.length <= maxBytes ? buf : buf.subarray(buf.length - maxBytes);
  } catch (_) {
    return null;
  }
}

// crash mode: RAW tail (default 256KB) of each present file. Returns
// [{ name, data }] of raw bytes — the caller zips them into one archive.
function collectTail({ files, perFileBytes = 256 * 1024, fsImpl = fs }) {
  const out = [];
  for (const f of files) {
    const tail = tailFileSync(f.path, perFileBytes, fsImpl);
    if (tail === null) continue;
    out.push({ name: f.name, data: tail });
  }
  return out;
}

// Shared budget loop for the "whole files newest-first" modes.
// The file that would overflow is tail-truncated (tailBytes) if its tail still
// fits, then iteration stops — dropping everything older.
// PRECONDITION: `files` MUST be ordered newest-first.
function takeNewestFirstWithinBudget({ files, maxTotalBytes, tailBytes, fsImpl }) {
  const out = [];
  let total = 0;
  for (const f of files) {
    let raw;
    try { raw = fsImpl.readFileSync(f.path); } catch (_) { continue; }
    if (total + raw.length <= maxTotalBytes) {
      out.push({ name: f.name, data: raw });
      total += raw.length;
      continue;
    }
    const tail = raw.length <= tailBytes ? raw : raw.subarray(raw.length - tailBytes);
    if (total + tail.length <= maxTotalBytes) {
      out.push({ name: f.name, data: tail });
    }
    break;
  }
  return out;
}

// requested mode: whole RAW files newest-first until maxTotalBytes (raw bytes).
// maxTotalBytes is a RAW cap chosen so the resulting zip stays well under the
// server's 20MB. PRECONDITION: `files` MUST be ordered newest-first (caller
// logFilesForFull()).
function collectFull({ files, maxTotalBytes = 16 * 1024 * 1024, tailBytes = 256 * 1024, fsImpl = fs }) {
  return takeNewestFirstWithinBudget({ files, maxTotalBytes, tailBytes, fsImpl });
}

// session-report mode: electron.log and backend.log are MANDATORY and always
// uploaded WHOLE — never tail-truncated, even if together they already exceed
// maxTotalBytes. The budget (default 20MB — the server's upload cap) only
// limits the dated rotations (backend.log.YYYY-MM-DD[.log]), which are taken
// newest-first as whole files; the first rotation that would overflow ends the
// collection, dropping it and everything older. Absent/unreadable logs are
// skipped silently (an empty report still uploads sqlite + environment).
function collectSessionLogs({
  logsDir,
  maxTotalBytes = 20 * 1024 * 1024,
  fsImpl = fs,
}) {
  let names;
  try {
    names = fsImpl.readdirSync(logsDir);
  } catch (_) {
    return [];
  }
  const prefix = 'backend.log.';
  const rotations = names
    .filter((n) => n.startsWith(prefix) && ROTATED_BACKUP_RE.test(n.slice(prefix.length)))
    .sort()               // ISO dates: lexicographic == chronological
    .reverse();           // newest first

  const out = [];
  let total = 0;
  // Mandatory primaries: always FULL, no truncation whatsoever.
  for (const f of [
    { path: path.join(logsDir, 'electron.log'), name: 'electron.log' },
    { path: path.join(logsDir, 'backend.log'), name: 'backend.log' },
  ]) {
    let raw;
    try { raw = fsImpl.readFileSync(f.path); } catch (_) { continue; }
    out.push({ name: f.name, data: raw });
    total += raw.length;
  }
  // Rotations: whole files, newest-first, while they fit in the remaining
  // budget. First overflow stops — older rotations are less valuable than newer.
  for (const n of rotations) {
    let raw;
    try { raw = fsImpl.readFileSync(path.join(logsDir, n)); } catch (_) { continue; }
    if (total + raw.length > maxTotalBytes) break;
    out.push({ name: n, data: raw });
    total += raw.length;
  }
  return out;
}

module.exports = { tailFileSync, collectTail, collectFull, collectSessionLogs };
