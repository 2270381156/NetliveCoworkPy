'use strict';

// Merge bundled (app-shipped) MCP server entries into the user's mcp.json dict.
// Bundled server keys are refreshed/added (the bundled config is authoritative for
// app-shipped endpoints), but user-added servers (keys not in the bundle) and any
// other top-level keys are preserved. Pure — no fs.
// NOTE: output is canonical pretty-printed JSON (2-space + trailing newline); a user
// file with different formatting reports changed=true and is reformatted once, then
// stable. Data-safe — server entries are never lost, only re-serialized.

//: 我们**曾经**随包发过、现在不发了的 MCP。合并只会刷新和新增，永远不删，
//: 于是这些条目会在老用户的 mcp.json 里一直留着——它们仍然被注册、仍然出现在
//: 智能体的能力清单里，而云端管理台里根本没有它们，谁也不知道该去哪关掉。
//:
//: 只清这张名单上的：用户自己加的 MCP 一律不动（那是他的东西，不是我们的）。
//: 以后再下架某个随包 MCP，把名字加到这里，不要指望"不在随包里就删"——
//: 那条规则会把用户自己加的一并删掉。
const RETIRED_BUNDLED_SERVERS = ['tech-kb-mcp', 'knowledge-a-net'];

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

  // 下架的清掉——但如果这一版又把它随包发回来了，以随包的为准，不删。
  for (const name of RETIRED_BUNDLED_SERVERS) {
    if (!(name in bundledServers)) delete user.mcpServers[name];
  }

  const text = JSON.stringify(user, null, 2) + '\n';
  return { text, changed: text !== userText };
}

module.exports = { mergeBundledMcpServers, RETIRED_BUNDLED_SERVERS };
