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
