'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeBundledMcpServers } = require('../lib/mcp-merge');

const BUNDLED = JSON.stringify({ mcpServers: { 'tech-kb-mcp': { url: 'http://x/mcp', timeout_per_call_sec: 60 } } });

test('seeds bundled server when user file is empty/missing', () => {
  const { text, changed } = mergeBundledMcpServers('', BUNDLED);
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(JSON.parse(text).mcpServers['tech-kb-mcp'], { url: 'http://x/mcp', timeout_per_call_sec: 60 });
});

test('preserves a user-added server alongside the bundled one', () => {
  const user = JSON.stringify({ mcpServers: { 'my-server': { url: 'http://mine' } } });
  const { text } = mergeBundledMcpServers(user, BUNDLED);
  const m = JSON.parse(text).mcpServers;
  assert.ok(m['my-server'], 'user server preserved');
  assert.ok(m['tech-kb-mcp'], 'bundled server added');
  assert.strictEqual(mergeBundledMcpServers(user, BUNDLED).changed, true);
});

test('bundled entry overwrites a user-edited same-key entry (app-authoritative)', () => {
  const user = JSON.stringify({ mcpServers: { 'tech-kb-mcp': { url: 'http://user-edited' } } });
  const { text } = mergeBundledMcpServers(user, BUNDLED);
  assert.strictEqual(JSON.parse(text).mcpServers['tech-kb-mcp'].url, 'http://x/mcp');
});

test('preserves other top-level keys in the user file', () => {
  const user = JSON.stringify({ mcpServers: {}, somethingElse: 42 });
  const { text } = mergeBundledMcpServers(user, BUNDLED);
  assert.strictEqual(JSON.parse(text).somethingElse, 42);
});

test('malformed user JSON is treated as empty and bundled is seeded', () => {
  const { text, changed } = mergeBundledMcpServers('{ not valid json', BUNDLED);
  assert.strictEqual(changed, true);
  assert.ok(JSON.parse(text).mcpServers['tech-kb-mcp']);
});

test('idempotent: re-merging the output changes nothing', () => {
  const once = mergeBundledMcpServers(JSON.stringify({ mcpServers: { 'my-server': { url: 'http://mine' } } }), BUNDLED).text;
  const twice = mergeBundledMcpServers(once, BUNDLED);
  assert.strictEqual(twice.changed, false);
  assert.strictEqual(twice.text, once);
});

test('下架的随包 MCP 会从用户配置里清掉', () => {
  // 合并只刷新和新增、永远不删，于是我们不再随包的 MCP 会在老用户机器上一直留着：
  // 仍然注册、仍然出现在智能体的能力清单里，而云端管理台里根本没有它们。
  const user = JSON.stringify({
    mcpServers: {
      'tech-kb-mcp': { url: 'http://old' },
      'knowledge-a-net': { url: 'http://old2' },
      'my-own': { url: 'http://mine' },
    },
  });
  // 用只含 browser-mcp 的随包配置——共用的 BUNDLED 夹具正好拿 tech-kb-mcp 当例子，
  // 那样它"仍在随包里"，本来就不该删。
  const onlyBrowser = JSON.stringify({ mcpServers: { 'browser-mcp': { command: 'node' } } });
  const { text } = mergeBundledMcpServers(user, onlyBrowser);
  const got = JSON.parse(text).mcpServers;
  assert.ok(!('tech-kb-mcp' in got), '下架的没清掉');
  assert.ok(!('knowledge-a-net' in got), '下架的没清掉');
  assert.ok('my-own' in got, '用户自己加的被误删了');
});

test('如果又随包发回来了，就不删', () => {
  const bundled = JSON.stringify({ mcpServers: { 'tech-kb-mcp': { url: 'http://new' } } });
  const user = JSON.stringify({ mcpServers: { 'tech-kb-mcp': { url: 'http://old' } } });
  const got = JSON.parse(mergeBundledMcpServers(user, bundled).text).mcpServers;
  assert.strictEqual(got['tech-kb-mcp'].url, 'http://new');
});
