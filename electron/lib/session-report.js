'use strict';

// Assemble the zip entries for a "report this session" upload: the backend's
// per-session SQLite export, a client environment block, the full run logs
// (electron.log + backend.log + every dated rotation, 20MB cap), optional
// appended extra entries (e.g., skills, agents, config), and an optional
// report-manifest.json (if manifest is provided).
// Order: sqlite.gz → environment.json → logEntries → extraEntries → report-manifest.json (last, if manifest).
// Pure — the caller supplies the fetched sqlite bytes, the env block, the
// log entries (from collectTail), and optionally extra entries and a manifest object.
// The backend /export returns gzip(sqlite) (see session_export.py), so the entry
// is named .sqlite.gz — whoever extracts it gunzips before opening in the viewer
// (or feeds it to /import, which sniffs the gzip magic and decompresses).
function buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries, extraEntries, manifest }) {
  const entries = [
    { name: `session-${sessionId}.sqlite.gz`, data: sqliteBuf },
    { name: 'environment.json', data: Buffer.from(JSON.stringify(env, null, 2), 'utf8') },
    ...(logEntries || []),
    ...(extraEntries || []),
  ];
  if (manifest) {
    entries.push({ name: 'report-manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  }
  return entries;
}

module.exports = { buildSessionReportEntries };
