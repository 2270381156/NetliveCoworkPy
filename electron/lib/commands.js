'use strict';

// Parse GET /clients/{id}/commands response → list of actionable upload_logs
// commands. Only upload_logs is supported (spec non-goal: no remote config).
function parseCommands(body) {
  if (!body || !Array.isArray(body.commands)) return [];
  return body.commands.filter((c) => c && c.type === 'upload_logs' && c.id);
}

function commandsUrl(endpoint, installId) {
  return `${endpoint}/clients/${encodeURIComponent(installId)}/commands`;
}

function ackUrl(endpoint, installId, commandId) {
  return `${endpoint}/clients/${encodeURIComponent(installId)}/commands/${encodeURIComponent(commandId)}/ack`;
}

module.exports = { parseCommands, commandsUrl, ackUrl };
