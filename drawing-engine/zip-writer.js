/* zip-writer.js —— 极简 ZIP 打包器（stored 模式，零依赖）。
   给 export-vsdx.js 用：.vsdx 本质是 OPC 包 = ZIP + 一组 XML part。

   为什么不引 JSZip：本项目已经反复吃到"每个依赖都是打包负担"的亏（node_modules 9.2MB
   要整目录拷进包、elkjs 7.7MB 闲置、libavoid 让整套方案必须背 88MB Node 运行时）。
   而这里需要的只是 ZIP 容器格式本身——OPC 规范允许 stored（不压缩）条目，Visio/EdrawMax
   都能正常打开，所以连 deflate 都不需要，纯拼字节六十行就够。

   只实现读得懂 .vsdx 所需的最小子集：
   - 无压缩（method 0 = stored）
   - 无目录条目（OPC 不需要）
   - 无 Zip64（拓扑图产出远小于 4GB）
   - 无加密/注释
   字节序全部小端，见 PKWARE APPNOTE 4.3.7（本地文件头）/ 4.3.12（中央目录）/ 4.3.16（EOCD）。 */
"use strict";
const zlib = require("zlib");

// CRC-32（IEEE 802.3 多项式 0xEDB88320），ZIP 头里必须带，写错的话解压工具会报"文件损坏"
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// MS-DOS 日期时间（APPNOTE 4.4.6）。刻意用固定时间戳而不是 new Date()：
// 同一份模型两次导出应当产出逐字节相同的文件——这条性质让"导出是纯函数"可测，
// 也让下游做内容比对/缓存成为可能。1980-01-01 00:00:00 是 DOS 时间的原点。
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980年1月1日：year=0, month=1, day=1

/** files: [{ name, data: string|Buffer }] → Buffer（完整 .zip 字节流） */
function zipSync(files) {
  const locals = [];   // 本地文件头 + 数据
  const centrals = []; // 中央目录条目
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6);       // 通用标志位：bit 11 = 文件名为 UTF-8
    local.writeUInt16LE(0, 8);            // 压缩方法 0 = stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小（stored 时等于原始大小）
    local.writeUInt32LE(data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // 扩展字段长度
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    central.writeUInt16LE(20, 4);         // 创建版本
    central.writeUInt16LE(20, 6);         // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // 扩展字段
    central.writeUInt16LE(0, 32);         // 注释
    central.writeUInt16LE(0, 34);         // 磁盘号
    central.writeUInt16LE(0, 36);         // 内部属性
    central.writeUInt32LE(0, 38);         // 外部属性
    central.writeUInt32LE(offset, 42);    // 本地文件头相对偏移
    nameBuf.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);      // EOCD 签名
  eocd.writeUInt16LE(0, 4);               // 本磁盘号
  eocd.writeUInt16LE(0, 6);               // 中央目录起始磁盘号
  eocd.writeUInt16LE(files.length, 8);    // 本磁盘上的条目数
  eocd.writeUInt16LE(files.length, 10);   // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);         // 中央目录相对整个归档的偏移
  eocd.writeUInt16LE(0, 20);              // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { zipSync, crc32 };
