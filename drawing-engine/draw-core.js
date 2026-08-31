/* draw-core.js —— 唯一一份绘制逻辑：把 (model, layout, icons) 拼成自包含的 SVG 字符串。
   只在 Node 跑——2026-07-25 起浏览器不再做任何布局/绘制，HTML 里内嵌的就是这里产出的 SVG，
   导出的 .svg 也是同一串字节，两者不可能不一致（此前 render.js 内嵌脚本和 index.html 各有
   一份拷贝，是本项目反复出现的"多处各写一份然后悄悄不同步"模式的又一处）。
   见设计文档 2026-07-25-topology-geometry-in-node-and-export-design.md。 */
"use strict";
const TopoRegions = require("./regions.js");

// SVG 内部样式：必须用字面色值，不能引用 CSS 变量（即 --ink / --muted 那套）——变量定义在
// HTML 的 :root 上，单独打开导出的 .svg 时未定义，文字会退化成黑色甚至不可见。
// 对照表：--ink = #2b3542，--muted = #6b7787。
// 注：本文件里刻意一处都不出现 CSS 变量引用语法，方便用 grep 一眼查回归。
const SVG_STYLE = `
  .devlabel { font-size:12.5px; font-weight:600; fill:#2b3542; }
  .devrole  { font-size:8.5px; fill:#6b7787; }
`;

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 元素工厂：attrs 里值为 null/undefined 的键直接跳过（原 DOM 版会写成字面量 "undefined"）。
// 有 text 时产出带闭合标签的元素，否则自闭合。
function el(tag, attrs, text) {
  let a = "";
  for (const k in (attrs || {})) {
    const v = attrs[k];
    if (v == null) continue;
    a += ` ${k}="${esc(v)}"`;
  }
  return text != null ? `<${tag}${a}>${esc(text)}</${tag}>` : `<${tag}${a}/>`;
}

function drawZones(out, layout, enc, ro) {
  for (const z of layout.zones || []) {
    const zt = enc.zoneTypes[z.type] || {};
    const b = z.bbox;
    out.push(el("rect", {
      x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY,
      rx: ro.zoneCorner === "round" ? 12 : 0,
      fill: zt.fill || "none", stroke: zt.stroke || "#9aa5b1",
      "stroke-width": TopoRegions.strokePt(TopoRegions.STROKE.ZONE, ro.strokeScale) / 0.75, "stroke-dasharray": "7,5", "vector-effect": "non-scaling-stroke"
    }));
    out.push(el("text", { x: b.minX + 10, y: b.minY + 16, "text-anchor": "start",
      style: `font-size:11px;font-weight:600;letter-spacing:.02em;fill:${zt.stroke || "#6b7787"}` },
      z.label || zt.legend || z.id));
  }
}

function perp(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1; return { x: -dy / L, y: dx / L }; }

function drawEdges(out, layout, enc) {
  for (const l of layout.links) {
    const a = l.aAnchor, b = l.bAnchor; if (!a || !b) continue;
    const lt = enc.linkTypes[l.type] || enc.linkTypes.normal;
    const base = { stroke: lt.stroke, "stroke-width": lt.width, fill: "none",
                   "vector-effect": "non-scaling-stroke", "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (lt.dash) base["stroke-dasharray"] = lt.dash;
    const bundle = lt.bundle || 1;
    if (l.route && l.route.length > 1) {
      const pts = l.route.map(p => `${p.x},${p.y}`).join(" ");
      const attrs = bundle > 1 ? Object.assign({}, base, { "stroke-width": lt.width * 2 }) : base;
      out.push(el("polyline", Object.assign({ points: pts }, attrs)));
    } else if (bundle > 1) {
      const p = perp(a.x, a.y, b.x, b.y), off = 2.4;
      for (const s of [-1, 1]) {
        out.push(el("line", Object.assign({}, base,
          { x1: a.x + p.x * off * s, y1: a.y + p.y * off * s, x2: b.x + p.x * off * s, y2: b.y + p.y * off * s })));
      }
    } else {
      out.push(el("line", Object.assign({}, base, { x1: a.x, y1: a.y, x2: b.x, y2: b.y })));
    }
  }
}

function drawPorts(out, layout, enc) {
  for (const l of layout.links) {
    const a = l.aAnchor, b = l.bAnchor; if (!a || !b) continue;
    drawPort(out, a); drawPort(out, b);
    drawConn(out, l.aConn, a, enc); drawConn(out, l.bConn, b, enc);
  }
}

function drawPort(out, anchor) {
  out.push(el("circle", { cx: anchor.x, cy: anchor.y, r: 2.1, fill: "#ffffff",
    stroke: "#8aa0b4", "stroke-width": 1.1, "vector-effect": "non-scaling-stroke" }));
}

function drawConn(out, key, anchor, enc) {
  if (!key) return; const c = enc.connTypes[key]; if (!c) return;
  const r = 3.6;
  const common = { fill: c.fill, stroke: "#ffffff", "stroke-width": 1, "vector-effect": "non-scaling-stroke" };
  if (c.shape === "square")
    out.push(el("rect", Object.assign({}, common, { x: anchor.x - r, y: anchor.y - r, width: r * 2, height: r * 2, rx: 1 })));
  else
    out.push(el("circle", Object.assign({}, common, { cx: anchor.x, cy: anchor.y, r })));
}

function drawNodes(out, layout, enc, icons) {
  for (const id in layout.nodes) {
    const n = layout.nodes[id];
    const role = enc.deviceRoles[n.role] || {};
    // 原 DOM 版把一台设备的图形+两行文字装在一个 <g> 里；字符串版用显式开闭标签保持同样结构。
    const g = [];
    if (role.glyph === "ellipsis") {
      g.push(el("text", { x: n.cx, y: n.cy + 1, "text-anchor": "middle", "dominant-baseline": "middle",
        style: "font-size:20px;font-weight:700;letter-spacing:1px;fill:#9aa5b1" }, "···"));
      out.push("<g>" + g.join("") + "</g>");
      continue;
    }
    const icon = role.icon && icons[role.icon];
    const useYellow = icon && icon.deviceType && n.iconTheme === "yellow" && icon.yellow;
    const iconHref = icon && (useYellow ? icon.yellow : icon.blue);
    if (iconHref) {
      g.push(el("image", { href: iconHref, x: n.left, y: n.top, width: n.w, height: n.h,
        preserveAspectRatio: "xMidYMid meet" }));
    } else {
      const boxAttr = { fill: role.fill || "#eef1f4", stroke: role.stroke || "#8aa0b4",
                        "stroke-width": TopoRegions.STROKE.DEVICE_BOX, "vector-effect": "non-scaling-stroke" };
      if (role.glyph === "cloud")
        g.push(el("ellipse", Object.assign({}, boxAttr, { cx: n.cx, cy: n.cy, rx: n.w / 2, ry: n.h / 2 })));
      else
        g.push(el("rect", Object.assign({}, boxAttr, { x: n.left, y: n.top, width: n.w, height: n.h, rx: 7 })));
    }
    // 字号与偏移都来自 regions.js —— **不要在这里重写公式**。布局要按同一套数值给标签
    // 留位置（footprintWidth），两处各写一遍就是本项目反复踩的"不同步不会失败"。
    // 0.9/1.9 那组经验值现在在 regions.js labelOffsets 里。
    const { labelSize, roleSize } = TopoRegions.labelMetrics(n.h);
    const off = TopoRegions.labelOffsets(n.h, !!iconHref);
    const labelY = iconHref ? n.bottom + off.labelDy : n.cy + off.labelDy;
    const roleY = iconHref ? n.bottom + off.roleDy : n.cy + off.roleDy;
    g.push(el("text", { x: n.cx, y: labelY, "text-anchor": "middle", "dominant-baseline": "middle",
      class: "devlabel", style: `font-size:${labelSize.toFixed(2)}px` }, n.label));
    g.push(el("text", { x: n.cx, y: roleY, "text-anchor": "middle", "dominant-baseline": "middle",
      class: "devrole", style: `font-size:${roleSize.toFixed(2)}px` }, role.legend || n.role));
    out.push("<g>" + g.join("") + "</g>");
  }
}

function drawLegend(out, layout, enc, icons, lm) {
  if (!layout.legend) return;
  for (const g of layout.legend.groups) {
    out.push(el("text", { x: g.titleX, y: g.titleY, "text-anchor": "start", "dominant-baseline": "middle",
      style: "font-size:11px;font-weight:700;letter-spacing:.02em;fill:#6b7787" }, g.title));
    for (const row of g.rows) drawLegendRow(out, g.kind, row, enc, icons, lm);
  }
}

function drawLegendRow(out, kind, row, enc, icons, lm) {
  drawLegendSwatch(out, kind, row.key, row.x, row.y, enc, icons, lm);
  const e = (enc[kind] || {})[row.key] || {};
  // 原来这里的 fill 引用的是 CSS 变量 --ink：单独打开的 .svg 里 :root 没定义它，文字会变黑，
  // 所以换成字面色值 #2b3542。
  out.push(el("text", { x: row.x + lm.advance, y: row.y, "text-anchor": "start", "dominant-baseline": "middle",
    style: "font-size:10.5px;fill:#2b3542" }, e.legend || row.key));
}

function drawLegendSwatch(out, kind, key, x, y, enc, icons, lm) {
  if (kind === "deviceRoles") {
    const e = enc.deviceRoles[key] || {};
    const icon = e.icon && icons[e.icon];
    if (icon && icon.blue) {
      // 按图标自身长宽比填满高度：20×12 那版对每个 aspect 缩放量不同，视觉大小参差不齐。
      // 预留框(lm.boxW)按最宽的算，图示在框内左对齐——文字左缘因此对齐。
      const sw = TopoRegions.legendSwatchSize(icon.aspect, lm);
      out.push(el("image", { href: icon.blue, x, y: y - sw.h / 2, width: sw.w, height: sw.h,
        preserveAspectRatio: "xMidYMid meet" }));
    } else {
      const h = lm.iconH * 0.83;   // 无图标时的色块：比图示略扁，跟原来 20×10 的比例一致
      out.push(el("rect", { x, y: y - h / 2, width: lm.boxW, height: h, rx: 2, fill: e.fill, stroke: e.stroke }));
    }
  } else if (kind === "linkTypes") {
    /* 线段示意**跟设备图示一样铺满预留框**（x → x+boxW）。原来写死 x+20：设备图示跟着
       meta.legendIconSize 变大了，线还是那么短，一眼就看出不是一套东西。
       双线的上下偏移同理，原来写死 ∓2，现在按图示高派生（h=12 时仍是 ∓2）。
       线宽(e.width)**不缩放**——那是作者声明的真实链路线宽，图例要如实展示。 */
    const e = enc.linkTypes[key] || {};
    const dy = lm.iconH / 6;
    if (e.bundle > 1) {
      out.push(el("line", { x1: x, y1: y - dy, x2: x + lm.boxW, y2: y - dy, stroke: e.stroke, "stroke-width": e.width }));
      out.push(el("line", { x1: x, y1: y + dy, x2: x + lm.boxW, y2: y + dy, stroke: e.stroke, "stroke-width": e.width }));
    } else {
      const attrs = { x1: x, y1: y, x2: x + lm.boxW, y2: y, stroke: e.stroke, "stroke-width": e.width };
      if (e.dash) attrs["stroke-dasharray"] = e.dash;
      out.push(el("line", attrs));
    }
  } else if (kind === "connTypes") {
    // 接口标记居中于预留框，尺寸从图示高派生（h=12 时正好还是原来的 r=4 / 边长 8、圆心 x+10）
    const e = enc.connTypes[key] || {};
    const cx = x + lm.boxW / 2;
    if (e.shape === "square") {
      const side = lm.iconH * (2 / 3);
      out.push(el("rect", { x: cx - side / 2, y: y - side / 2, width: side, height: side, rx: 1, fill: e.fill }));
    } else {
      out.push(el("circle", { cx, cy: y, r: lm.iconH / 3, fill: e.fill }));
    }
  } else if (kind === "zoneTypes") {
    const e = enc.zoneTypes[key] || {};
    out.push(el("rect", { x, y: y - lm.iconH * 0.415, width: lm.boxW, height: lm.iconH * 0.83, rx: 2, fill: e.fill, stroke: e.stroke,
      "stroke-width": 1.2, "stroke-dasharray": "3,2" }));
  }
}

// 视口外扩距离。SVG 的 viewBox 和 HTML 里"适应窗口"按钮的 home 视口必须用同一个值，
// 否则点一下适应窗口画面会跳到跟 SVG 自身 viewBox 不一样的取景。所以这里统一导出
// computeViewBox()，render.js 不再自己算一份（评审指出这正是本次重构要消灭的重复常量模式）。
const VIEW_PAD = 40;

function computeViewBox(layout) {
  const bb = layout.bbox;
  return {
    x: bb.minX - VIEW_PAD,
    y: bb.minY - VIEW_PAD,
    w: (bb.maxX - bb.minX) + VIEW_PAD * 2,
    h: (bb.maxY - bb.minY) + VIEW_PAD * 2,
  };
}

// 唯一入口：产出自包含 SVG 字符串（含内部 <style>、图标 data URI，无任何外部引用）。
function buildSVG(model, layout, icons) {
  const enc = model.encoding;
  const ro = TopoRegions.renderOptions(model);   // meta 里的作者化渲染开关，默认值只有一份
  const out = [];
  // 顺序即 z 序，跟原 render() 一致：zone 在最底、其次连线、再设备、端口、图例
  drawZones(out, layout, enc, ro);
  drawEdges(out, layout, enc);
  drawNodes(out, layout, enc, icons);
  // meta.showPorts=false 时不画端口小圆——用户只要拓扑结构、不关心接口时用
  if (ro.showPorts) drawPorts(out, layout, enc);
  drawLegend(out, layout, enc, icons, TopoRegions.legendMetrics(ro.legendIconSize));

  const v = computeViewBox(layout);
  // 铺满 viewBox 的白底。SVG 自己不带背景时用的是查看器的底色——深色模式的浏览器/看图工具
  // 里，设备文字(#2b3542 深蓝灰)会糊在深底上几乎读不出来。HTML 版看着正常是因为外层页面
  // CSS 给了浅色底，单独打开的 .svg 没这层兜底，所以导出物必须自带底色。
  // （用真打包出来的引擎导出 .svg、在深色模式浏览器里打开才发现的——此前所有断言查的都是
  // "内容对不对"，没有一条查"在中性环境里读不读得清"。）
  const bg = el("rect", { x: v.x, y: v.y, width: v.w, height: v.h, fill: "#ffffff" });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" width="${Math.round(v.w)}" height="${Math.round(v.h)}">
<style>${SVG_STYLE}</style>
${bg}
<g id="world">
${out.join("\n")}
</g>
</svg>`;
}

// 本模块真正会画出特殊图形的 glyph 值——其余值一律落到"普通方框"分支被静默忽略。
// 导出给 style-report.js 用：它要判断某个角色到底有没有视觉标识，不能自己臆断
// "写了 glyph 就算有"（2026-07-27 就这么错过一次：sample-dual-core 里每个角色都写了
// glyph:"switch"/"fw"，draw-core 根本不认，画出来全是纯色方框，style 报告却给了全清）。
const RENDERED_GLYPHS = ["cloud", "ellipsis"];

module.exports = { buildSVG, computeViewBox, RENDERED_GLYPHS };
