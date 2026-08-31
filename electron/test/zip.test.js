'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { crc32, zipEntries } = require('../lib/zip');

// minimal zip reader: walk local file headers, inflate, return [{name, data}]
function readZip(buf) {
  const out = [];
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp) });
    p = dataStart + compSize;
  }
  return out;
}

test('crc32 matches known check values', () => {
  assert.strictEqual(crc32(Buffer.from('')), 0);
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926); // standard CRC32 check value
});

test('zipEntries round-trips names and content (DEFLATE)', () => {
  const entries = [
    { name: 'electron.log', data: Buffer.from('e'.repeat(5000)) },
    { name: 'backend.log', data: Buffer.from('hello backend\n') },
  ];
  const zip = zipEntries(entries);
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);            // first local file header
  assert.strictEqual(zip.readUInt32LE(zip.length - 22), 0x06054b50); // EOCD
  assert.strictEqual(zip.readUInt16LE(zip.length - 22 + 10), 2);  // total entries = 2
  const got = readZip(zip);
  assert.deepStrictEqual(got.map((e) => e.name), ['electron.log', 'backend.log']);
  assert.strictEqual(got[0].data.toString(), 'e'.repeat(5000));
  assert.strictEqual(got[1].data.toString(), 'hello backend\n');
});

test('zipEntries on empty list is a valid empty zip', () => {
  const zip = zipEntries([]);
  assert.strictEqual(zip.length, 22);                  // EOCD only
  assert.strictEqual(zip.readUInt32LE(0), 0x06054b50);
  assert.strictEqual(zip.readUInt16LE(10), 0);         // total entries = 0
  assert.deepStrictEqual(readZip(zip), []);
});

test('zip extracts with PowerShell Expand-Archive (win32)', { skip: process.platform !== 'win32' }, () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ziptest-'));
  const zipPath = path.join(dir, 'logs.zip');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(zipPath, zipEntries([
    { name: 'electron.log', data: Buffer.from('line1\nline2\n') },
    { name: 'backend.log', data: Buffer.from('backend ok\n') },
  ]));
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`]);
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'electron.log'), 'utf8'), 'line1\nline2\n');
  assert.strictEqual(fs.readFileSync(path.join(outDir, 'backend.log'), 'utf8'), 'backend ok\n');
});
