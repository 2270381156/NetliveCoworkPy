/* 档 B（elkjs + elkjs-libavoid）几何引擎自测。用法：node verify-geometry.mjs
   核心问题：真实几何引擎的输出，能不能套进 topo.js computeLayout() 同一份契约？
   避障布线是不是真在干活（不是退化成直线、也真的不穿设备）？ */
import { createRequire } from "module";
import { computeElkLayout } from "./geometry-elk.mjs";

const require = createRequire(import.meta.url);
const { buildSVG } = require("./draw-core.js");
const model = require("./topo-data.js");
const { computeLayout: computeHandLayout } = require("./topo.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

// ---- 线段 × 矩形求交（判断布线是否穿过了某个设备包围盒）----
function segSeg(p1, p2, q1, q2) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(q1, q2, p1), d2 = d(q1, q2, p2), d3 = d(p1, p2, q1), d4 = d(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function pointInRect(p, r, eps) {
  return p.x > r.left + eps && p.x < r.right - eps && p.y > r.top + eps && p.y < r.bottom - eps;
}
function segCrossesRect(p1, p2, r, eps = 0.5) {
  if (pointInRect(p1, r, eps) || pointInRect(p2, r, eps)) return true;
  const corners = [
    [{ x: r.left, y: r.top }, { x: r.right, y: r.top }],
    [{ x: r.right, y: r.top }, { x: r.right, y: r.bottom }],
    [{ x: r.right, y: r.bottom }, { x: r.left, y: r.bottom }],
    [{ x: r.left, y: r.bottom }, { x: r.left, y: r.top }]
  ];
  return corners.some(([a, b]) => segSeg(p1, p2, a, b));
}

const hand = computeHandLayout(model);
const elk = await computeElkLayout(model);

console.log("① 输出契约与 topo.js computeLayout() 对齐（几何引擎可换、下游不用改）");
ok(["nodes", "links", "bbox", "tiers"].every(k => k in elk), "顶层字段一致: nodes/links/bbox/tiers");
{
  const n = elk.nodes.CORE1;
  ok(["cx", "cy", "w", "h", "left", "right", "top", "bottom", "tier"].every(k => k in n), "节点字段一致（cx/cy/w/h/left/right/top/bottom/tier）");
  const l = elk.links.find(x => x.a === "RT1" && x.b === "CORE1");
  ok(!!(l && l.aAnchor && l.bAnchor && "x" in l.aAnchor && "y" in l.aAnchor), "链路带 aAnchor/bAnchor（渲染器可直接复用画连接点标记的逻辑）");
}

console.log("② 布点合法性");
{
  const allFinite = Object.values(elk.nodes).every(n => [n.cx, n.cy, n.w, n.h].every(Number.isFinite) && n.w > 0 && n.h > 0);
  ok(allFinite, "所有节点坐标/宽高有限且为正");
  ok(Object.values(elk.bbox).every(Number.isFinite), "bbox 有限: " + JSON.stringify(elk.bbox));
}

console.log("③ 避障布线确实在生效（不是退化成直线）");
{
  const withBends = elk.links.filter(l => l.route && l.route.length > 2);
  ok(withBends.length > 0, `${withBends.length}/${elk.links.length} 条链路有转折点（bendPoints）`);
}

console.log("④ 布线不穿过非端点设备（libavoid 存在的意义，必须验证到）");
{
  let violations = [];
  for (const l of elk.links) {
    if (!l.route) continue;
    const others = Object.values(elk.nodes).filter(n => n.id !== l.a && n.id !== l.b);
    for (let i = 0; i < l.route.length - 1; i++) {
      const p1 = l.route[i], p2 = l.route[i + 1];
      for (const r of others) {
        if (segCrossesRect(p1, p2, r)) violations.push(`${l.a}->${l.b} 穿过 ${r.id}`);
      }
    }
  }
  ok(violations.length === 0, violations.length ? `发现 ${violations.length} 处穿越: ${violations.join(", ")}` : "零穿越");
}

console.log("⑤ 对照：手写分层算法（档 A）在同一张图上是否有穿越（用来量化档 B 的改善，不是失败判据）");
{
  let handViolations = 0;
  for (const l of hand.links) {
    const others = Object.values(hand.nodes).filter(n => n.id !== l.a && n.id !== l.b);
    for (const r of others) if (segCrossesRect(l.aAnchor, l.bAnchor, r)) handViolations++;
  }
  console.log(`  (info) 档 A 直线连接穿越设备次数: ${handViolations}`);
}

console.log("⑥ elk 档现在也返回 zones(之前完全没有这个字段)");
ok(Array.isArray(elk.zones) && elk.zones.length > 0, `elk.zones 是非空数组(实际长度 ${elk.zones ? elk.zones.length : 'undefined'})`);

console.log("⑦ 只写 legend、不写样式的模型：elk 路径也要补全 stroke（两个引擎都得调 normalizeEncoding）");
{
  // 真实 agent 按 SOUL.md 只写 legend、不写 fill/stroke/width。以前 normalizeEncoding 只在
  // topo.js 的 computeLayout() 里调，elk 路径完全跳过 → 连线没有 stroke 属性 → SVG 默认
  // stroke:none → 整条线隐形。而 orthogonal 是默认走线方式，所以这是默认路径上的缺陷。
  // 之前没暴露是因为所有测试样例都手写了 stroke；这条用"只有 legend"的模型把路径钉住。
  const bare = {
    meta: {},
    encoding: {
      deviceRoles: { r: { legend: "设备" } },          // 无 fill/stroke/w/h
      linkTypes:   { plain: { legend: "普通链路" } },   // 无 stroke/width
      connTypes:   {}, zoneTypes: {}
    },
    devices: [{ id: "A", role: "r", tier: 0, label: "A" }, { id: "B", role: "r", tier: 1, label: "B" }],
    links: [{ a: "A", b: "B", type: "plain" }],
    zones: []
  };
  const L = await computeElkLayout(bare);
  const svg = buildSVG(bare, L, {});
  const polys = svg.match(/<polyline[^>]*>/g) || [];
  const lines = svg.match(/<line[^>]*>/g) || [];
  const drawn = [...polys, ...lines].filter(e => !/class="/.test(e));
  ok(drawn.length > 0, `产出了 ${drawn.length} 条连线图元`);
  ok(drawn.every(e => /stroke="[^"]+"/.test(e)),
    "每条连线都有非空 stroke（缺了就是隐形线）：" + drawn.map(e => (/stroke="([^"]*)"/.exec(e) || [])[1]).join(","));
  ok(!svg.includes('stroke="undefined"'), "没有 stroke=\"undefined\"");
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
