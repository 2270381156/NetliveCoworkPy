'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCommands, commandsUrl, ackUrl } = require('../lib/commands');

test('parseCommands keeps only valid upload_logs commands', () => {
  const body = { commands: [
    { id: 'c1', type: 'upload_logs' },
    { id: 'c2', type: 'something_else' }, // wrong type → dropped
    { type: 'upload_logs' },              // no id → dropped
    null,                                 // garbage → dropped
  ] };
  assert.deepStrictEqual(parseCommands(body), [{ id: 'c1', type: 'upload_logs' }]);
});

test('parseCommands tolerates missing / garbage body', () => {
  assert.deepStrictEqual(parseCommands(null), []);
  assert.deepStrictEqual(parseCommands({}), []);
  assert.deepStrictEqual(parseCommands({ commands: 'nope' }), []);
});

test('commandsUrl and ackUrl encode ids', () => {
  assert.strictEqual(commandsUrl('http://x:8077', 'inst/1'), 'http://x:8077/clients/inst%2F1/commands');
  assert.strictEqual(ackUrl('http://x:8077', 'i', 'c 1'), 'http://x:8077/clients/i/commands/c%201/ack');
});
