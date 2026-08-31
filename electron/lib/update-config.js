'use strict';

// Pure resolution of update configuration from the single source of truth:
// app-config.json (read by main.js#readAppConfigFile — packaged factory copy or
// the repo dev fallback). No env / per-machine-file overrides: the caller passes
// the parsed app-config object and that is authoritative.
function resolveUpdateConfig(appConfig = {}) {
  const channelRaw = appConfig.channel || 'stable';
  return {
    feedUrl: appConfig.feedUrl || '',
    telemetryUrl: appConfig.telemetryUrl || '',
    channel: channelRaw === 'beta' ? 'beta' : 'stable',
  };
}

function shouldCheckForUpdates(cfg) { return !!(cfg && cfg.feedUrl); }
function shouldReportTelemetry(cfg) { return !!(cfg && cfg.telemetryUrl); }

module.exports = { resolveUpdateConfig, shouldCheckForUpdates, shouldReportTelemetry };
