'use strict';

// Merge bundled (app-shipped) MCP server entries into the user's mcp.json dict.
// Bundled server keys are refreshed/added (the bundled config is authoritative for
// app-shipped endpoints), but user-added servers (keys not in the bundle) and any
// other top-level keys are preserved. Pure — no fs.
// NOTE: output is canonical pretty-printed JSON (2-space + trailing newline); a user
// file with different formatting reports changed=true and is reformatted once, then
// stable. Data-safe — server entries are never lost, only re-serialized.
function mergeBundledMcpServers(userText, bundledText) {
  let user;
  try { user = userText ? JSON.parse(userText) : {}; } catch (_) { user = {}; }
  if (!user || typeof user !== 'object' || Array.isArray(user)) user = {};
  if (!user.mcpServers || typeof user.mcpServers !== 'object' || Array.isArray(user.mcpServers)) {
    user.mcpServers = {};
  }

  let bundled;
  try { bundled = JSON.parse(bundledText); } catch (_) { bundled = {}; }
  const bundledServers = (bundled && typeof bundled.mcpServers === 'object' && !Array.isArray(bundled.mcpServers))
    ? bundled.mcpServers : {};

  for (const [name, cfg] of Object.entries(bundledServers)) user.mcpServers[name] = cfg;

  const text = JSON.stringify(user, null, 2) + '\n';
  return { text, changed: text !== userText };
}

module.exports = { mergeBundledMcpServers };
