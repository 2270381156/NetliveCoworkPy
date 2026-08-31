/* node 自测：export-pptx.js。用法： node verify-pptx.js

   验的是"包结构对不对、语义有没有丢"，**不是"PowerPoint 里好不好看"**。后者只能人工验，
   而且这个格式上已经踩过一次教训：LibreOffice 渲染正常 ≠ 语义正确（它压根不读自定义
   连接点，两种坐标写法给出同样的错误结果）。所以这里只钉可机检的部分。 */
"use strict";
const { buildPptx } = require("./export-pptx.js");
const { computeLayout } = require("./topo.js");
const { resolveIconsForModel } = require("./icons.js");
const zlib = require("zlib");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

// 独立 ZIP 读取：刻意不复用 zip-writer——用同一个库写又用它读等于自己跟自己对答案
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    const ln = buf.readUInt16LE(off + 26), le = buf.readUInt16LE(off + 28);
    const raw = buf.slice(off + 30 + ln + le, off + 30 + ln + le + (method ? csize : usize));
    out.set(name, method ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
function wellFormed(s) {
  const stack = []; const re = /<(\/?)([a-zA-Z_][\w:.-]*)[^>]*?(\/?)>/g; let m;
  while ((m = re.exec(s))) {
    if (m[0].startsWith("<?") || m[0].startsWith("<!")) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else if (!m[3]) stack.push(m[2]);
  }
  return stack.length === 0;
}

const model = JSON.parse(JSON.stringify(require("./topo-data.js")));
const icons = resolveIconsForModel(model);
const layout = computeLayout(model, { icons });
const warnings = [];
const built = buildPptx(model, layout, { warnings });
const parts = readZip(built.buf);
const slide = parts.get("ppt/slides/slide1.xml").toString("utf8");

console.log("① OPC 包齐全（少一个 part，PowerPoint 就打不开）");
for (const need of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels", "ppt/slides/slide1.xml", "ppt/slides/_rels/slide1.xml.rels",
  "ppt/slideLayouts/slideLayout1.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/theme/theme1.xml",
  "docProps/app.xml", "docProps/core.xml"]) ok(parts.has(need), `含 ${need}`);

console.log("② 每个 XML part 良构");
for (const [name, data] of parts) ok(wellFormed(data.toString("utf8")), `${name}`);

console.log("③ 形状数量与模型对得上（装饰节点不出形状）");
{
  const roles = model.encoding.deviceRoles;
  const real = model.devices.filter(d => !(roles[d.role] || {}).decorative).length;
  const links = layout.links.filter(l => l.aAnchor && l.bAnchor).length;
  ok(built.shapeCount === real, `设备 group ${built.shapeCount} = 真实设备 ${real}`);
  ok(built.linkCount === links, `连线 ${built.linkCount} = 有锚点的链路 ${links}`);
  ok((slide.match(/<p:grpSp>/g) || []).length === real, `<p:grpSp> ${real} 个`);
  ok((slide.match(/<p:cxnSp>/g) || []).length === links, `<p:cxnSp> ${links} 个`);
  for (const d of model.devices.filter(d => (roles[d.role] || {}).decorative)) {
    ok(!slide.includes(`<a:t>${d.label}</a:t>`), `装饰节点 ${d.id} 不出形状`);
  }
}

console.log("④ 连线真的粘在设备上 —— 丢了就退化成一张死图");
{
  const stc = slide.match(/<a:stCxn id="(\d+)" idx="(\d+)"\/>/g) || [];
  const endc = slide.match(/<a:endCxn id="(\d+)" idx="(\d+)"\/>/g) || [];
  ok(stc.length === built.linkCount && endc.length === built.linkCount, `每条线两端都有粘连`);
  // 粘连目标必须是真实存在的形状 id，引用错了 PowerPoint 里就是浮空的线
  const ids = new Set((slide.match(/<p:cNvPr id="(\d+)"/g) || []).map(s => /id="(\d+)"/.exec(s)[1]));
  const dangling = [...stc, ...endc].filter(c => !ids.has(/id="(\d+)"/.exec(c)[1]));
  ok(dangling.length === 0, `无悬空粘连（实际 ${dangling.length}）`);
  // 粘连目标必须是那个盒子=设备方框的承载矩形，不能是 group——group 框含标签、比设备大一圈，
  // 粘它就是"线连在 group 上、没连在设备上"（2026-07-30 实测踩过）
  const carriers = new Set();
  for (const m of slide.matchAll(/<p:cNvPr id="(\d+)" name="ports"\/>/g)) carriers.add(m[1]);
  ok(carriers.size === built.shapeCount, `每台设备都有一个 name="ports" 的承载矩形（${carriers.size}）`);
  ok([...stc, ...endc].every(c => carriers.has(/id="(\d+)"/.exec(c)[1])),
    "所有粘连都指向承载矩形（不是 group）");
  // 序号必须按边分布，不能全 0——全 0 就是所有线挤在同一个连接点上（实测踩过）
  const idxs = [...stc, ...endc].map(c => /idx="(\d+)"/.exec(c)[1]);
  ok(new Set(idxs).size > 1, `连接点序号按边分布（出现 ${new Set(idxs).size} 种，全 1 种说明又挤到一点了）`);
  ok(idxs.every(i => +i <= 3), "序号都在预设矩形的 0..3 范围内");
  ok(!slide.includes("<a:cxn ang"), "不用自定义连接点（LibreOffice 不读它，实测过）");
}

console.log("⑤ 幻灯片尺寸与坐标");
{
  const pres = parts.get("ppt/presentation.xml").toString("utf8");
  ok(/<p:sldSz cx="12192000" cy="6858000"\/>/.test(pres), "固定 16:9（13.333×7.5 英寸）");
  ok(!/(?:cx|cy|x|y)="-?\d*\.\d/.test(slide), "所有 EMU 都是整数（小数会被某些实现拒绝）");
  ok(!/NaN|Infinity/.test(slide), "无 NaN/Infinity");
}

console.log("⑥ 图例没带要明确告知，不能静默丢");
ok(warnings.some(w => w.code === "PPTX_LEGEND_OMITTED"), "返回 PPTX_LEGEND_OMITTED 警告");

console.log("⑦ 纯函数：同一份输入两次导出逐字节相同");
{
  const again = buildPptx(JSON.parse(JSON.stringify(require("./topo-data.js"))),
    computeLayout(JSON.parse(JSON.stringify(require("./topo-data.js"))), { icons }), { warnings: [] });
  ok(Buffer.compare(built.buf, again.buf) === 0, "两次导出字节完全一致");
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
