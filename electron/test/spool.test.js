'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSpoolText, drainSpool } = require('../lib/spool');

test('parseSpoolText parses one JSON object per line, counts bad lines', () => {
  const text = '{"event_type":"a","ts":"T1"}\nnot-json\n\n{"event_type":"b","x":1}\n';
  const { events, errors } = parseSpoolText(text);
  assert.deepStrictEqual(events, [
    { event_type: 'a', ts: 'T1' },
    { event_type: 'b', x: 1 },
  ]);
  assert.strictEqual(errors, 1); // 空行不算错误
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'spool-')); }

test('drainSpool renames, reads, deletes, returns events', () => {
  const spool = path.join(tmpDir(), 'telemetry-spool.jsonl');
  fs.writeFileSync(spool, '{"event_type":"a"}\n');
  const events = drainSpool({ spoolPath: spool });
  assert.strictEqual(events.length, 1);
  assert.ok(!fs.existsSync(spool));
  assert.ok(!fs.existsSync(spool + '.draining'));
});

test('drainSpool recovers a leftover .draining from a crashed previous run', () => {
  const spool = path.join(tmpDir(), 'telemetry-spool.jsonl');
  fs.writeFileSync(spool + '.draining', '{"event_type":"left"}\n');
  const events = drainSpool({ spoolPath: spool });
  assert.strictEqual(events[0].event_type, 'left');
  assert.ok(!fs.existsSync(spool + '.draining'));
});

test('drainSpool with no file returns empty array', () => {
  const events = drainSpool({ spoolPath: path.join(tmpDir(), 'none.jsonl') });
  assert.deepStrictEqual(events, []);
});
