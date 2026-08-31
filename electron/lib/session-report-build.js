'use strict';
const path = require('path');
const { zipEntries } = require('./zip');
const { buildSessionReportEntries } = require('./session-report');
const { gatherExtraReportData } = require('./report-collect');
const { collectSessionLogs } = require('./log-bundler');

// The CPU/IO-heavy half of "report this session": read the logs, walk the
// skills/agents/config trees, and deflate everything into one zip. Pure sync —
// the caller decides where it runs (a worker thread, normally; see
// session-report-async.js). Takes only serializable inputs so it can be handed
// across a thread boundary as-is.
function buildSessionReportZip({ sessionId, env, sqliteBuf, appDataDir, skillsDir, agentsDir }) {
  const logEntries = collectSessionLogs({ logsDir: path.join(appDataDir, 'logs') });
  const { entries: extraEntries, manifest } = gatherExtraReportData({
    sessionId,
    skillsDir,
    agentsDir,
    dataDir: path.join(appDataDir, 'data'),
    resourcesDir: path.join(appDataDir, 'resources'),
    envPath: path.join(appDataDir, '.env'),
  });
  const entries = buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries, extraEntries, manifest });
  return zipEntries(entries);
}

module.exports = { buildSessionReportZip };
