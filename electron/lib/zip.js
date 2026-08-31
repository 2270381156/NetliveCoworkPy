'use strict';
const zlib = require('zlib');

// Standard IEEE CRC32 (zip stores it over the UNcompressed data).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Build a minimal DEFLATE zip (no zip64, no data descriptor) from raw entries.
// entries: [{ name, data: Buffer }]. Deterministic: fixed DOS time (no clock —
// the sandbox forbids Date.now() and the zip mtime carries no meaning here).
function zipEntries(entries, { deflate = zlib.deflateRawSync } = {}) {
  const fileParts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const comp = deflate(data);
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0, 6);          // flags
    lfh.writeUInt16LE(8, 8);          // method = deflate
    lfh.writeUInt16LE(0, 10);         // mod time (fixed)
    lfh.writeUInt16LE(0, 12);         // mod date (fixed)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra length
    fileParts.push(lfh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);  // central directory signature
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);           // flags
    cd.writeUInt16LE(8, 10);          // method
    cd.writeUInt16LE(0, 12);          // mod time
    cd.writeUInt16LE(0, 14);          // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra length
    cd.writeUInt16LE(0, 32);          // comment length
    cd.writeUInt16LE(0, 34);          // disk number start
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs
    cd.writeUInt32LE(offset, 42);     // local header offset
    central.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + comp.length;
  }

  const filesBuf = Buffer.concat(fileParts);
  const centralBuf = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // EOCD signature
  eocd.writeUInt16LE(0, 4);           // disk number
  eocd.writeUInt16LE(0, 6);           // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);  // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(filesBuf.length, 16);   // central dir offset
  eocd.writeUInt16LE(0, 20);          // comment length

  return Buffer.concat([filesBuf, centralBuf, eocd]);
}

module.exports = { crc32, zipEntries };
