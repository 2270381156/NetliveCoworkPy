/* node 自测：zip-writer.js + export-vsdx.js。用法： node verify-vsdx.js

   验的是"文件结构对不对"和"语义有没有丢"，**不是"Visio 里打开好不好看"**——后者只能人工
   在 Visio/亿图里验，本地无法自动化。所以这里刻意把可机检的部分钉死：ZIP 字节格式合法、
   OPC part 齐全、XML 合法、Shape/Connect 数量与模型对得上、坐标翻转正确。 */
"use strict";
const { zipSync, crc32 } = require("./zip-writer.js");
const { buildVsdx } = require("./export-vsdx.js");
const { computeLayout } = require("./topo.js");
const { resolveIconsForModel } = require("./icons.js");
const zlib = require("zlib");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

// ---- 极简 ZIP 读取器：只为验证我们写出的字节能被独立解析出来 ----
// 刻意不用第三方库读：用同一个库写又用它读，等于自己跟自己对答案，写错了也看不出来。
function readZip(buf) {
  // 从尾部找 EOCD（22 字节定长，无注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录签名错，第 " + i + " 条");
    const crcExpect = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    // 顺着本地文件头取数据
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + size);
    if (crc32(data) !== crcExpect) throw new Error(`CRC 不符: ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* 形状树解析：设备现在是 Group（图标按填充色拆成子形状 + 标签子形状），页面里既有顶层
   形状也有嵌套形状。**不能再按字符串切**——按 "<Shape " 切会把子形状当成顶层，数量和
   坐标全错；之前那次 PinY 断言假失败就是字符串正则跨形状匹配造成的，这里一次性堵死。 */
function parseShapes(xml) {
  const tokens = [...xml.matchAll(/<Shape\b([^>]*?)(\/?)>|<\/Shape>/g)];
  const top = [];
  const stack = [];
  let pos = 0;
  for (const t of tokens) {
    if (t[0] === "</Shape>") {
      const node = stack.pop();
      if (node) node.body = xml.slice(node._start, t.index);
    } else {
      const attrs = t[1];
      const node = {
        id: (/ID="(\d+)"/.exec(attrs) || [])[1],
        type: (/Type="(\w+)"/.exec(attrs) || [])[1] || "Shape",
        children: [], body: "", _start: t.index + t[0].length,
      };
      (stack.length ? stack[stack.length - 1].children : top).push(node);
      if (!t[2]) stack.push(node);          // 非自闭合才入栈
    }
  }
  // body 含子形状；再算一份"只属于自己"的片段，供只该看本形状的断言使用
  const strip = (n) => {
    let own = n.body;
    const inner = /<Shapes>[\s\S]*<\/Shapes>/.exec(own);
    if (inner) own = own.slice(0, inner.index) + own.slice(inner.index + inner[0].length);
    n.own = own;
    n.children.forEach(strip);
  };
  top.forEach(strip);
  return top;
}
const own = (node) => node.own;
const cellOf = (node, name) => {
  const m = new RegExp(`<Cell N="${name}" V="([^"]*)"`).exec(node.own);
  return m ? m[1] : null;
};
const textIn = (node) => {
  const parts = [];
  const walk = (n) => {
    const m = /<Text>([\s\S]*?)<\/Text>/.exec(n.own);
    if (m) parts.push(m[1]);
    n.children.forEach(walk);
  };
  walk(node);
  return parts.join("\n");
};

console.log("① ZIP 字节格式：独立解析器能读回来，CRC 自洽");
{
  const buf = zipSync([
    { name: "a.txt", data: "hello" },
    { name: "dir/中文.xml", data: "<x>中文内容</x>" },
  ]);
  let entries = null, err = null;
  try { entries = readZip(buf); } catch (e) { err = e.message; }
  ok(!err, `解析成功${err ? "：" + err : ""}`);
  if (entries) {
    ok(entries.size === 2, `条目数 2（实际 ${entries.size}）`);
    ok(entries.get("a.txt").toString("utf8") === "hello", "内容正确");
    ok(entries.get("dir/中文.xml").toString("utf8") === "<x>中文内容</x>", "UTF-8 文件名与内容都正确");
  }
}

console.log("② 同一份模型两次导出逐字节相同（导出是纯函数，时间戳不能用 new Date）");
{
  const m = require("./topo-data.js");
  const mk = () => {
    const c = JSON.parse(JSON.stringify(m));
    return buildVsdx(c, computeLayout(c, { icons: resolveIconsForModel(c) }));
  };
  ok(Buffer.compare(mk(), mk()) === 0, "两次导出字节完全一致");
}

const model = JSON.parse(JSON.stringify(require("./topo-data.js")));
const layout = computeLayout(model, { icons: resolveIconsForModel(model) });
const parts = readZip(buildVsdx(model, layout));

console.log("③ OPC 包结构齐全（少一个 part，Visio 就打不开）");
{
  for (const need of [
    "[Content_Types].xml", "_rels/.rels",
    "visio/document.xml", "visio/_rels/document.xml.rels",
    "visio/pages/pages.xml", "visio/pages/_rels/pages.xml.rels", "visio/pages/page1.xml",
    "visio/windows.xml", "docProps/app.xml", "docProps/core.xml",
  ]) ok(parts.has(need), `含 ${need}`);
}

console.log("④ 每个 XML part 都是良构的");
{
  for (const [name, data] of parts) {
    const txt = data.toString("utf8");
    ok(wellFormed(txt), `${name} 标签配对良好`);
  }
}

const page = parts.get("visio/pages/page1.xml").toString("utf8");

const tops = parseShapes(page);
const roles = model.encoding.deviceRoles;
const realDevices = model.devices.filter(d => !(roles[d.role] || {}).decorative);
const zoneCount = (layout.zones || []).length;
const linkCount = layout.links.filter(l => l.aAnchor && l.bAnchor).length;

console.log("⑤ 顶层 Shape 数量与模型对得上（装饰节点不出形状）");
{
  ok(tops.length === zoneCount + realDevices.length + linkCount,
    `顶层 Shape ${tops.length} = zone ${zoneCount} + 设备 ${realDevices.length} + 连线 ${linkCount}`);
  const decorative = model.devices.filter(d => (roles[d.role] || {}).decorative);
  for (const d of decorative) {
    ok(!page.includes(`>${d.label}<`), `装饰节点 ${d.id} 不生成 Shape（它不是真实网络实体）`);
  }
}

console.log("⑤b 有图标的设备生成 Group，且 group 盒 = 图标盒（决定连线落在哪条边上）");
{
  const groups = tops.filter(s => s.type === "Group");
  ok(groups.length > 0, `生成了 ${groups.length} 个设备 Group`);
  // 每个 group 至少要有：图标色段（>=1）+ 标签，所以孩子数 >= 2
  ok(groups.every(g => g.children.length >= 2),
    `每个 Group 至少 2 个子形状（图标色段 + 标签），最少的有 ${Math.min(...groups.map(g => g.children.length))} 个`);
  // 标签子形状的 PinY 必须为负：它要落在 group 声明的盒子**外面**，
  // 这样整形粘连算出来的落点才是图标边，跟 SVG 侧（线碰设备方框边、标签在框外）一致。
  const labelOutside = groups.every(g => g.children.some(c => Number(cellOf(c, "PinY")) < 0));
  ok(labelOutside, "每个 Group 都有一个 PinY < 0 的子形状（标签在声明盒外，不撑大粘连边界）");
  // group 的 Width/Height 必须等于 layout 里的设备方框，不能被标签撑大
  const byLabel = new Map(Object.values(layout.nodes).map(n => [n.label, n]));
  const mismatched = groups.filter(g => {
    const n = byLabel.get(textIn(g).split("\n")[0]);
    if (!n) return false;
    return Math.abs(Number(cellOf(g, "Width")) - n.w / 96) > 1e-4;
  });
  ok(mismatched.length === 0, `Group 宽度都等于设备方框宽度（不符 ${mismatched.length} 个）`);
}

console.log("⑤c 图标真的转出了几何，不是静默降级成空盒");
{
  const groups = tops.filter(s => s.type === "Group");
  const rowsOf = (g) => g.children.reduce((s, c) => s + (c.own.match(/<Row T="/g) || []).length, 0);
  const empty = groups.filter(g => rowsOf(g) === 0);
  ok(empty.length === 0, `每个 Group 都有几何行（空的 ${empty.length} 个）`);
  const total = groups.reduce((s, g) => s + rowsOf(g), 0);
  console.log(`      ${groups.length} 个图标共 ${total} 个几何顶点`);

  // 几何必须**铺满 group 盒**。整形粘连的落点是 group 声明的 Width/Height，图标要是没
  // 铺满，线就会停在离图标一段距离的地方——这正是实际出过的问题：svg-geometry 第一版
  // 把短边居中留白编进坐标，使用方又乘上一个已经是正确长宽比的盒子，Internet
  // （aspect 1.952）纵向只剩 51%，上下各空一大截。文件合法、图也画得出来，只有量一下
  // 几何范围才发现得了。
  const short = [];
  for (const g of groups) {
    const W = Number(cellOf(g, "Width")), H = Number(cellOf(g, "Height"));
    const xs = [], ys = [];
    for (const c of g.children) {
      for (const m of own(c).matchAll(/<Cell N="X" V="([-\d.]+)"\/><Cell N="Y" V="([-\d.]+)"\/>/g)) {
        xs.push(Number(m[1])); ys.push(Number(m[2]));
      }
    }
    if (!xs.length) continue;
    const fx = (Math.max(...xs) - Math.min(...xs)) / W;
    const fy = (Math.max(...ys) - Math.min(...ys)) / H;
    if (fx < 0.9 || fy < 0.9) short.push(`${textIn(g).split("\n")[0]}(x ${fx.toFixed(2)}, y ${fy.toFixed(2)})`);
  }
  ok(short.length === 0, short.length
    ? `图标没铺满 group 盒：${short.join("，")}` : "每个图标都铺满了 group 盒（线会贴着图标边）");
}

console.log("⑥ 连接器真的粘住了两端 —— 这是「可编辑」的落点，丢了就退化成一张死图");
{
  const connects = page.match(/<Connect [^>]*\/>/g) || [];
  const linkCount = layout.links.filter(l => l.aAnchor && l.bAnchor).length;
  ok(connects.length === linkCount * 2, `Connect ${connects.length} = 链路 ${linkCount} × 2 端`);
  ok(connects.some(c => /FromCell="BeginX"/.test(c)), "起点端有 BeginX 粘连");
  ok(connects.some(c => /FromCell="EndX"/.test(c)), "终点端有 EndX 粘连");
  // 每条 Connect 引用的 ToSheet 必须是真实存在的 Shape ID，否则 Visio 里连线是浮空的
  const shapeIds = new Set((page.match(/<Shape ID="(\d+)"/g) || []).map(s => /ID="(\d+)"/.exec(s)[1]));
  const dangling = connects.filter(c => {
    const to = /ToSheet="(\d+)"/.exec(c);
    return !to || !shapeIds.has(to[1]);
  });
  ok(dangling.length === 0, `没有悬空粘连（实际 ${dangling.length} 条指向不存在的 Shape）`);

  // ---- 光有 <Connects> 是不够的：真正让线跟着走的是**公式** ----
  // 第一版就栽在这：38 个 Connect 齐全、零悬空，结构检查全绿，但在 EdrawMax 里拖动设备
  // 连线纹丝不动。微软文档（BegTrigger Cell, Glue Info Section）说明动态粘连靠的是引用
  // 目标 EventXFMod 的公式，<Connects> 只是索引。三件缺一不可，逐条钉住。
  const connShapes = page.split("<Shape ").slice(1).filter(b => /ObjType" V="2"/.test(b));
  ok(connShapes.length === linkCount, `${linkCount} 条连线都声明了 ObjType=2（1-D 形状，不声明则 Begin/End 不参与计算）`);
  ok(connShapes.every(b => /N="BeginX"[^/]*_WALKGLUE/.test(b)),
    "每条连线的 BeginX 带 _WALKGLUE 公式（死坐标 = 不跟随）");
  ok(connShapes.every(b => /N="EndX"[^/]*_WALKGLUE/.test(b)),
    "每条连线的 EndX 带 _WALKGLUE 公式");
  ok(connShapes.every(b => /BegTrigger[^/]*_XFTRIGGER\(Sheet\.\d+!EventXFMod\)/.test(b)),
    "BegTrigger 引用了目标 Shape 的 EventXFMod（对方一动就触发重算）");
  ok(connShapes.every(b => /EndTrigger[^/]*_XFTRIGGER\(Sheet\.\d+!EventXFMod\)/.test(b)),
    "EndTrigger 同样引用了 EventXFMod");
  // ---- 保持直线：不给这三个单元格，Visio 会按默认直角路由重算路径 ----
  // 用户反馈"稍微调一下设备位置，斜线就走成折线"。我们只给了两点直线几何，但 _WALKGLUE
  // 让 Visio 自行重算——重算时用的是页面默认的直角路由，斜线就没了。
  // 这三个值在软件里的实际效果本地验不了（同粘连那次），这里只钉住"确实写进去了"。
  ok(connShapes.every(b => /N="ConFixedCode" V="2"/.test(b)),
    "每条连线 ConFixedCode=2（从不重新布线）");
  ok(connShapes.every(b => /N="ShapeRouteStyle" V="16"/.test(b)),
    "每条连线 ShapeRouteStyle=16（中心到中心直连）");
  ok(connShapes.every(b => /N="ConLineRouteExt" V="1"/.test(b)),
    "每条连线 ConLineRouteExt=1（路径取直线不取曲线）");

  // 触发器引用的 Sheet 号必须是真实 Shape，引用错了公式静默失效
  const trigRefs = (page.match(/_XFTRIGGER\(Sheet\.(\d+)!/g) || []).map(t => /Sheet\.(\d+)!/.exec(t)[1]);
  ok(trigRefs.length > 0 && trigRefs.every(id => shapeIds.has(id)),
    `触发器引用的 ${trigRefs.length} 个 Sheet 号都是真实存在的 Shape`);
}

console.log("⑦ 坐标系翻转正确 —— Visio 的 y 向上，写反了整张图会上下颠倒");
{
  // 取模型里 tier 最小（画在最上面）和最大（最下面）的两台设备，
  // 在 Visio 坐标里前者的 PinY 必须**更大**
  const ns = Object.values(layout.nodes);
  const top = ns.reduce((a, b) => (a.cy <= b.cy ? a : b));
  const bottom = ns.reduce((a, b) => (a.cy >= b.cy ? a : b));
  // 必须用形状树，不能用字符串切。两次教训叠在这一处：
  // ① 一条跨 Shape 的正则会从文档**第一个** <Shape 一路匹配到目标标签，两台设备读出
  //    同一个值 3.375，断言假失败；
  // ② 改成按 "<Shape " 切之后，设备变成 Group、标签挪进子形状，切出来的"块"里第一个
  //    PinY 是子形状的局部坐标，又错一次。
  // 现在按树找**顶层**形状，标签从整棵子树里取。
  const pinYOf = (label) => {
    const g = tops.find(s => textIn(s).split("\n")[0] === label);
    if (!g) return null;
    const p = cellOf(g, "PinY");
    return p == null ? null : Number(p);
  };
  const yTop = pinYOf(top.label), yBottom = pinYOf(bottom.label);
  ok(yTop != null && yBottom != null, `取到两端设备的 PinY（${top.label}/${bottom.label}）`);
  if (yTop != null && yBottom != null) {
    ok(yTop > yBottom,
      `画在上面的 ${top.label}(PinY=${yTop}) 在 Visio 里 y 更大 > 下面的 ${bottom.label}(PinY=${yBottom})`);
  }
  ok(!/V="NaN"/.test(page) && !/V="Infinity"/.test(page), "没有 NaN/Infinity 混进 Cell 值（会让文件打不开）");
}

console.log("⑧ 页面尺寸是正数英寸");
{
  const pages = parts.get("visio/pages/pages.xml").toString("utf8");
  const w = Number(/<Cell N="PageWidth" V="([\d.]+)"/.exec(pages)[1]);
  const h = Number(/<Cell N="PageHeight" V="([\d.]+)"/.exec(pages)[1]);
  ok(w > 0 && h > 0 && w < 200 && h < 200, `页面 ${w}×${h} 英寸（正数且量级合理）`);
}

function wellFormed(s) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z_][\w:.-]*)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0].startsWith("<?") || m[0].startsWith("<!")) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; }
    else if (!m[3]) stack.push(m[2]);
  }
  return stack.length === 0;
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
