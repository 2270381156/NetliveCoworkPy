/* node 自测：svg-geometry.js。用法： node verify-svg-geometry.js

   这里的每一条都对应一个**实际踩过的坑**，不是凑数：
   ① fill 只认 rgb() → 3 个 hex 图标转出空图，而脚本不报错，被当成"全部转换成功"
   ② 正则只捕获 d 之前的属性 → 本库两种来源里 d 都排第一位，等于一直在空串里找 fill
   ③ 两轴各自归一化 → 纵向拉伸 46%，图能画出来但是错的，扫一眼看不出来
   ④ Z 闭回整条 path 的第一个 M → 多子路径时凭空多一条横跨的线
   ⑤ 绝对容差 → viewBox 长边 42~3283 差 78 倍，小图标的曲线全退化成直线
   ⑥ 不支持的命令静默跳过 → 画出形似而错的图形，比空图更难发现 */
"use strict";
const fs = require("fs");
const path = require("path");
const { svgToGeometry, checkGeometry } = require("./svg-geometry.js");
const { loadCatalog } = require("./icons.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };
const ICONS_ROOT = path.join(__dirname, "topology-icons");
const bboxOf = (r) => {
  const xs = [], ys = [];
  for (const s of r.sections) for (const q of s.rows) { xs.push(q.x); ys.push(q.y); }
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

console.log("① 两种 fill 写法都要认（图标库不同源：32 个 rgb()、3 个 #hex）");
{
  const mk = (fill) => `<svg viewBox="0 0 100 100"><path d="M 0,0 L 10,0 10,10 0,10 Z" fill="${fill}"/></svg>`;
  const a = svgToGeometry(mk("rgb(6,98,170)"));
  const b = svgToGeometry(mk("#0662aa"));
  ok(a.sections.length === 1 && a.sections[0].fill === "#0662aa", `rgb() → ${a.sections[0] && a.sections[0].fill}`);
  ok(b.sections.length === 1 && b.sections[0].fill === "#0662aa", `#hex → ${b.sections[0] && b.sections[0].fill}`);
  const c = svgToGeometry(`<svg viewBox="0 0 100 100"><path d="M 0,0 L 10,10 Z" fill="#0af"/></svg>`);
  ok(c.sections[0] && c.sections[0].fill === "#00aaff", `三位简写 #0af → ${c.sections[0] && c.sections[0].fill}`);
}

console.log("② 属性顺序不能假设：本库里 d 排第一位，fill 在它后面");
{
  const dFirst = `<svg viewBox="0 0 100 100"><path d="M 0,0 L 10,0 10,10 Z" fill="#0b5ea0" stroke="none"/></svg>`;
  const dLast = `<svg viewBox="0 0 100 100"><path fill="#0b5ea0" stroke="none" d="M 0,0 L 10,0 10,10 Z"/></svg>`;
  ok(svgToGeometry(dFirst).sections.length === 1, "d 在前也能取到 fill");
  ok(svgToGeometry(dLast).sections.length === 1, "d 在后同样能取到");
}

console.log("③ 两个轴各自铺满 0..1，长宽比单独用 aspect 报出（不编码进坐标）");
{
  // 3283×2251 是本库最常见的 viewBox。第一版把短边居中留白编进坐标，使用方又乘上一个
  // 已经是正确长宽比的盒子，图标被纵向压扁到 1/aspect——Internet 只剩 51% 高，
  // 上下各空一大截，线看着离图标很远。同一个长宽比不能在两个地方各处理一次。
  const svg = `<svg viewBox="0 0 3283 2251"><path d="M 0,0 L 3283,0 3283,2251 0,2251 Z" fill="rgb(0,0,0)"/></svg>`;
  const r = svgToGeometry(svg);
  const bb = bboxOf(r);
  ok(Math.abs(bb.w - 1) < 1e-9, `x 铺满 0..1（实际 ${bb.w.toFixed(6)}）`);
  ok(Math.abs(bb.h - 1) < 1e-9, `y 也铺满 0..1，不留白（实际 ${bb.h.toFixed(6)}）`);
  ok(Math.abs(r.aspect - 3283 / 2251) < 1e-9, `aspect 单独报出 ${r.aspect.toFixed(4)}`);
  // 极端长宽比同样不能留白——这是 Internet 那个 case
  const wide = svgToGeometry(`<svg viewBox="0 0 2000 1024"><path d="M 0,0 L 2000,0 2000,1024 0,1024 Z" fill="rgb(0,0,0)"/></svg>`);
  const wb = bboxOf(wide);
  ok(Math.abs(wb.h - 1) < 1e-9, `aspect≈1.95 的扁图 y 仍铺满（实际 ${wb.h.toFixed(4)}）`);
  ok(checkGeometry("wide", wide).length === 0, "checkGeometry 认为它没问题");
  // 反向：人为压扁的几何要被 checkGeometry 抓住
  const squashed = { aspect: 1.95, unsupported: [], sections: [{ fill: "#000", rows: [
    { t: "MoveTo", x: 0, y: 0.25 }, { t: "LineTo", x: 1, y: 0.25 }, { t: "LineTo", x: 1, y: 0.75 },
  ] }] };
  ok(checkGeometry("squashed", squashed).some(p => /没铺满/.test(p)), "纵向只占 0.5 的几何被判为有问题");
}

console.log("④ 多子路径：Z 要闭回**本子路径**的起点，不是整条 path 的第一个 M");
{
  // 两个分开的方块。若 Z 闭回第一个 M，第二个方块结束后会多一条横跨的线，
  // 表现为包围盒不变但顶点序列里出现一条从 (30,30) 回到 (0,0) 的边。
  const svg = `<svg viewBox="0 0 100 100"><path d="M 0,0 L 10,0 10,10 0,10 Z M 20,20 L 30,20 30,30 20,30 Z" fill="rgb(0,0,0)"/></svg>`;
  const r = svgToGeometry(svg);
  const rows = r.sections[0].rows;
  const moves = rows.filter(q => q.t === "MoveTo");
  ok(moves.length === 2, `识别出 2 个子路径（实际 ${moves.length}）`);
  // 最后一行必须回到第二个子路径的起点 (20,20)，不是第一个的 (0,0)
  const last = rows[rows.length - 1];
  ok(Math.abs(last.x - moves[1].x) < 1e-9 && Math.abs(last.y - moves[1].y) < 1e-9,
    `末行闭回第二个子路径起点（实际 x=${last.x.toFixed(3)}，第二子路径起点 x=${moves[1].x.toFixed(3)}）`);
}

console.log("⑤ 容差按长边取相对值：绝对容差会让小 viewBox 的曲线全退化成直线");
{
  const curve = (vb) => `<svg viewBox="0 0 ${vb} ${vb}"><path d="M 0,0 C ${vb*0.3},${vb*0.1} ${vb*0.7},${vb*0.9} ${vb},${vb} Z" fill="rgb(0,0,0)"/></svg>`;
  const big = svgToGeometry(curve(3283)).sections[0].rows.length;
  const small = svgToGeometry(curve(42)).sections[0].rows.length;
  ok(small > 5, `viewBox=42 的曲线也被细分（${small} 个点）`);
  ok(Math.abs(big - small) <= 2, `大小 viewBox 细分密度一致（${big} vs ${small}）——这正是绝对容差做不到的`);
}

console.log("⑥ 不支持的命令要报出来，不能静默跳过");
{
  const arc = `<svg viewBox="0 0 100 100"><path d="M 0,0 A 10 10 0 0 1 20,20 Z" fill="rgb(0,0,0)"/></svg>`;
  const r = svgToGeometry(arc);
  ok(r.unsupported.includes("A"), `圆弧 A 被识别为不支持（实际 ${JSON.stringify(r.unsupported)}）`);
  ok(checkGeometry("arc", r).some(p => /不支持/.test(p)), "checkGeometry 把它报成问题");
}

console.log("⑦ 全库逐个转换：非空、不变形、无不支持命令");
{
  const catalog = loadCatalog();
  const keys = Object.keys(catalog).filter(k => catalog[k].blue);
  const problems = [];
  let totalRows = 0, maxRows = 0, maxKey = "";
  for (const k of keys) {
    const text = fs.readFileSync(path.join(ICONS_ROOT, catalog[k].blue), "utf8");
    const r = svgToGeometry(text);
    problems.push(...checkGeometry(k, r));
    const n = r.sections.reduce((s, x) => s + x.rows.length, 0);
    totalRows += n;
    if (n > maxRows) { maxRows = n; maxKey = k; }
  }
  ok(keys.length > 0, `目录里有 ${keys.length} 个带 blue 素材的图标`);
  ok(problems.length === 0, problems.length ? `问题：\n      ` + problems.join("\n      ") : "全部通过");
  console.log(`      平均 ${Math.round(totalRows / keys.length)} 顶点，最多 ${maxRows}（${maxKey}）`);
}

console.log("⑧ 纯函数：同一份输入两次转换结果完全一致");
{
  const catalog = loadCatalog();
  const k = Object.keys(catalog).find(x => catalog[x].blue);
  const text = fs.readFileSync(path.join(ICONS_ROOT, catalog[k].blue), "utf8");
  ok(JSON.stringify(svgToGeometry(text)) === JSON.stringify(svgToGeometry(text)), "两次结果逐字段相同");
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
