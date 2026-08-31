/* node 自测：renderStandaloneHTML 产出的 HTML。
   2026-07-25 语义反转：以前断言"内嵌了 regions.js 且在 topo.js 之前"（那时布局在浏览器算）；
   现在布局和绘制都在 Node 完成，HTML 里**不应该**出现任何布局/绘制代码，只应有预渲染的
   SVG + 平移缩放脚本。 */
const { renderStandaloneHTML } = require("./render.js");
const { buildSVG } = require("./draw-core.js");
const { computeLayout } = require("./topo.js");
const { resolveIconsForModel } = require("./icons.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

const model = require("./topo-data.js");
const icons = resolveIconsForModel(model);
const layout = computeLayout(model, { icons });
const svg = buildSVG(model, layout, icons);
const html = renderStandaloneHTML(model, layout, svg);

console.log("① HTML 里不再有任何布局/绘制代码");
ok(!html.includes("buildRegionTree"), "不含 regions.js 的源码");
ok(!html.includes("function computeLayout"), "不含 topo.js 的 computeLayout");
ok(!html.includes("function drawNodes"), "不含绘制函数（绘制只在 Node 侧发生）");

console.log("② 含预渲染 SVG，且与 buildSVG 产出同源");
ok(html.includes('<svg id="svg"'), "内嵌了 SVG 根元素");
{
  // 取 SVG 里第一个设备 label，确认它确实出现在 HTML 内嵌的那段 SVG 里
  const label = model.devices[0].label;
  ok(svg.includes(">" + label + "<") && html.includes(">" + label + "<"),
    `SVG 与 HTML 内容同源（抽查 label "${label}"）`);
}

console.log("③ 视口脚本与溯源数据");
ok(html.includes("window.__VIEWBOX__"), "内嵌视口初值");
ok(html.includes("window.TOPO"), "内嵌源模型（仅溯源用，不参与渲染）");
ok(html.includes('id="fit"'), "保留适应窗口按钮");

/* 图例图示：四类图示共用一个**固定统一框**，内容等比缩放装进去，且 meta.legendIconSize
   能整体调。
   演进：写死 20×12 → 按自身长宽比填满高度（大小齐，但宽度不齐 → 必须按最宽的留框）→
   按这张图最宽的图标留框（一个 aspect 1.952 的离群值就把框撑到 23.4，其余 5 个 14.7 的
   离文字 14.8、链路线段成了它们的 1.6 倍）→ **现在：固定框 1.25×h**。
   实测全库 35 个图标里 29 个 aspect=1.222，所以绝大多数几乎正好填满这个框。 */
console.log("图例图示尺寸");
{
  const R = require("./regions.js");
  const { buildSVG } = require("./draw-core.js");
  const { computeLayout } = require("./topo.js");
  const { resolveIconsForModel } = require("./icons.js");
  const mk = (meta) => {
    const m = JSON.parse(JSON.stringify(require("./topo-data.js")));
    Object.assign(m.meta = m.meta || {}, meta || {});
    const i = resolveIconsForModel(m);
    return buildSVG(m, computeLayout(m, { icons: i }), i);
  };
  const swatches = (svg) => [...svg.matchAll(/width="([\d.]+)" height="([\d.]+)" preserveAspectRatio/g)]
    .map(m => ({ w: +m[1], h: +m[2] }));

  const lay = (meta) => {
    const m = JSON.parse(JSON.stringify(require("./topo-data.js")));
    Object.assign(m.meta = m.meta || {}, meta || {});
    const i = resolveIconsForModel(m);
    return { model: m, icons: i, layout: computeLayout(m, { icons: i }) };
  };
  const boxWOf = (size) => R.legendMetrics(size || 12).boxW;

  const def = swatches(mk({})).filter(s => s.h <= 14);
  ok(def.length > 0, `缺省图例里取到 ${def.length} 个图示`);
  // 统一框的核心不变式：**没有一个图示超出框**（超了文字左缘就不齐）
  ok(def.every(s => s.w <= boxWOf() + 1e-6 && s.h <= 12 + 1e-6),
    `每个图示都装得进统一框 ${boxWOf().toFixed(1)}×12（实际最大 ${Math.max(...def.map(s => s.w)).toFixed(1)}×${Math.max(...def.map(s => s.h)).toFixed(1)}）`);
  // 绝大多数图标（本库 35 个里 29 个 aspect=1.222）应当**几乎填满**框——留白过大就说明框选宽了
  const fillRatio = Math.max(...def.map(s => s.w)) / boxWOf();
  ok(fillRatio > 0.95,
    `典型图标几乎填满框（最宽的填了 ${(fillRatio * 100).toFixed(0)}%，低于 95% 说明框选宽了）`);
  // 宽于框的图标改由宽度定尺寸，会比别的矮——这是接受的代价，但不能矮得离谱
  const hs = [...new Set(def.map(s => s.h))].sort((a, b) => a - b);
  ok(hs[0] >= 12 * 0.6,
    `最矮的图示仍有框高的 ${(hs[0] / 12 * 100).toFixed(0)}%（高度取值 ${hs.join("/")}）`);

  const big = swatches(mk({ legendIconSize: 20 })).filter(s => s.w <= boxWOf(20) + 1e-6);
  ok(big.length === def.length && Math.abs(Math.max(...big.map(s => s.w)) / boxWOf(20) - fillRatio) < 0.01,
    `meta.legendIconSize=20 整体等比放大（取到 ${big.length} 个，填充率不变）`);

  // 横向图例走的是另一套排布算法（流式换行），别只测竖列那条路
  ok(swatches(mk({ legendPosition: "bottom" })).filter(s => s.h <= 12 + 1e-6).length === def.length,
    "横向图例（legendPosition=bottom）同样生效");

  /* 回归：放大 legendIconSize 时"里紧外松"必须成立。
     图示到**自己**文字的间隙 < 本条目文字到**下一条**图示的间隙——反过来的话，文字在视觉上
     就归到了下一个图标那边，读成「图标1————文字1-图标2」。
     2026-07-31 实测的原始缺陷：advance 跟着 h 缩放而 H_ITEM_GAP 写死 18，h>14 一律反转
     （h=20 时 25.6 vs 18）。缺省 12 正好卡在刚好还对（15.3 < 18），所以只测缺省测不出来。 */
  const textW = (s, size) => [...String(s)]
    .reduce((w, ch) => w + (ch.charCodeAt(0) > 0xFF ? size : size * 0.55), 0);
  for (const size of [12, 20, 28, 36]) {
    const { model: m, icons: ic, layout } = lay({ legendIconSize: size, legendPosition: "bottom" });
    const lm = R.legendMetrics(size);
    const g = layout.legend.groups.find(x => x.kind === "deviceRoles");
    let worstIntra = 0, worstInter = Infinity, pairs = 0;
    for (let i = 0; i < g.rows.length - 1; i++) {
      const cur = g.rows[i], next = g.rows[i + 1];
      if (Math.abs(cur.y - next.y) > 1e-6) continue;   // 换行了，不是同一行的相邻条目
      const e = m.encoding.deviceRoles[cur.key] || {};
      const info = e.icon && ic[e.icon];
      const sw = R.legendSwatchSize(info && info.aspect, lm);
      const intra = lm.advance - sw.w;                                    // 图示右缘 → 自己文字
      const inter = next.x - (cur.x + lm.advance + textW(e.legend || cur.key, 10.5)); // 文字右缘 → 下一图示
      worstIntra = Math.max(worstIntra, intra);
      worstInter = Math.min(worstInter, inter);
      pairs++;
    }
    ok(pairs > 0 && worstIntra < worstInter,
      `legendIconSize=${size}：里紧外松成立（图示→自己文字 ${worstIntra.toFixed(1)}` +
      ` < 文字→下一条 ${worstInter.toFixed(1)}，${pairs} 对相邻条目）`);
  }

  /* 回归：**所有四类图示**都要跟着 legendIconSize 缩放，不只是设备图标。
     2026-07-31 用户实测：设备图标调大了，链路那条线还是原来那么短（写死 x+20），
     接口小圆也没变（写死 r=4）。同一排图示大小不一，一眼就看出不是一套东西。
     按 (x1,y1)/(cx,cy) 落在图例行坐标上来认元素——主图里也有 line/circle，不能只按标签抓。 */
  const near = (a, b) => Math.abs(a - b) < 0.01;
  const swatchGeom = (size) => {
    const { model: m, icons: ic, layout } = lay({ legendIconSize: size, legendPosition: "bottom" });
    const svg = buildSVG(m, layout, ic);
    const lm = R.legendMetrics(size);
    const rowsOf = (kind) => (layout.legend.groups.find(g => g.kind === kind) || { rows: [] }).rows;
    const num = (s, k) => { const t = new RegExp(`${k}="([-\\d.]+)"`).exec(s); return t ? +t[1] : NaN; };
    const lines = [...svg.matchAll(/<line [^>]*>/g)].map(x => x[0]);
    const circles = [...svg.matchAll(/<circle [^>]*>/g)].map(x => x[0]);
    const rects = [...svg.matchAll(/<rect [^>]*>/g)].map(x => x[0]);
    const linkRow = rowsOf("linkTypes")[0];
    const lineEl = lines.find(s => near(num(s, "x1"), linkRow.x) && near(num(s, "y1"), linkRow.y));
    // uplink 是 circle、dci-100ge 是 square，各挑一条来量
    const connRows = rowsOf("connTypes");
    const circRow = connRows.find(r => r.key === "uplink");
    const sqRow = connRows.find(r => r.key === "dci-100ge");
    const circEl = circles.find(s => near(num(s, "cx"), circRow.x + lm.boxW / 2) && near(num(s, "cy"), circRow.y));
    const side = lm.iconH * (2 / 3);
    const sqEl = rects.find(s => near(num(s, "x"), sqRow.x + lm.boxW / 2 - side / 2) && near(num(s, "y"), sqRow.y - side / 2));
    return {
      boxW: lm.boxW,
      lineLen: lineEl ? num(lineEl, "x2") - num(lineEl, "x1") : NaN,
      circleR: circEl ? num(circEl, "r") : NaN,
      squareSide: sqEl ? num(sqEl, "width") : NaN,
    };
  };
  {
    const a = swatchGeom(12), b = swatchGeom(24);
    ok(near(a.lineLen, a.boxW) && near(b.lineLen, b.boxW),
      `链路线段铺满预留框（12→${a.lineLen.toFixed(1)} / 24→${b.lineLen.toFixed(1)}，` +
      `预留框 ${a.boxW.toFixed(1)} / ${b.boxW.toFixed(1)}）`);
    ok(near(b.lineLen, a.lineLen * 2),
      `图示尺寸翻倍时线段长度同步翻倍（${a.lineLen.toFixed(1)} → ${b.lineLen.toFixed(1)}）`);
    ok(near(a.circleR, 4) && near(b.circleR, 8),
      `接口圆点跟着缩放（r 12→${a.circleR} / 24→${b.circleR}；缺省仍是原来的 4）`);
    ok(near(a.squareSide, 8) && near(b.squareSide, 16),
      `接口方块跟着缩放（边长 12→${a.squareSide} / 24→${b.squareSide}；缺省仍是原来的 8）`);
  }
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
