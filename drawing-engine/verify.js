/* node 自测：断言布局的关键性质。用法： node verify.js */
const model = require("./topo-data.js");
const { computeLayout, CFG } = require("./topo.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const L = computeLayout(model);
const N = L.nodes;

console.log("① 核心对称");
ok(approx(N.CORE1.cx, -N.CORE2.cx), `Core-1.cx(${N.CORE1.cx}) == -Core-2.cx(${N.CORE2.cx})`);
ok(approx(N.CORE1.cy, N.CORE2.cy), `Core 对同 y (${N.CORE1.cy})`);

console.log("② 每个 tier 内主组（不含旁挂设备）整带包围盒居中于 x=0");
// 用包围盒左右边界对称，而不是"各设备中心点取平均"——后者只在宽度序列本身回文时才等于 0，
// 组内插了省略标记之类不对称宽度分布后，整带依然居中，但每个中心点的平均值不一定是 0。
const byTier = {};
for (const id in N) (byTier[N[id].tier] ||= []).push(N[id]);
for (const t in byTier) {
  const primary = byTier[t].filter(n => !n.satelliteOf);
  const minLeft = Math.min(...primary.map(n => n.left));
  const maxRight = Math.max(...primary.map(n => n.right));
  ok(approx(minLeft, -maxRight, 1e-6), `tier ${t} 主组包围盒对称 (left=${minLeft.toFixed(2)}, right=${maxRight.toFixed(2)})`);
}

console.log("②b 旁挂设备贴在挂载对象外侧，不参与居中");
{
  const fw1 = N.FW1, rt1 = N.RT1;
  ok(fw1.satelliteOf === "RT1", "FW-1.satelliteOf === RT1");
  const outward = rt1.cx >= 0 ? 1 : -1;
  // 贴靠偏移用 CFG.SATELLITE_GAP（2026-07-24 起独立于 H_GAP，不再硬编码 46）
  const g = CFG.SATELLITE_GAP;
  ok(outward < 0 ? approx(fw1.right, rt1.left - g, 1e-6) : approx(fw1.left, rt1.right + g, 1e-6),
    `FW-1 贴在 RT-1 外侧 ${g}（RT-1.cx=${rt1.cx}, FW-1.cx=${fw1.cx}）`);
}

console.log("③ tier 越大 y 越大（分层方向 TB）");
const ys = L.tiers.map(t => byTier[t][0].cy);
ok(ys.every((v, i) => i === 0 || v > ys[i - 1]), "y 单调递增: " + ys.join(","));

console.log("④ 同边端口均匀分布（Agg-1 底边→3 个接入）");
const bottom = N.AGG1.ports.bottom.map(p => p.end === "a" ? p.link.aAnchor : p.link.bAnchor).sort((a,b)=>a.x-b.x);
ok(bottom.length === 3, `Agg-1 底边端口数=${bottom.length}`);
if (bottom.length >= 2) {
  // 内插 (i+1)/(n+1) → 端口关于设备中心对称、间距相等
  const xs = bottom.map(a => a.x);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  ok(gaps.every(g => approx(g, gaps[0], 1e-6)), "相邻端口间距相等: " + gaps.map(g=>g.toFixed(2)).join(","));
  const mid = (xs[0] + xs[xs.length - 1]) / 2;
  ok(approx(mid, N.AGG1.cx, 1e-6), `端口整体关于设备中心对称 (mid=${mid.toFixed(2)}, cx=${N.AGG1.cx.toFixed(2)})`);
  ok(bottom.every(a => approx(a.y, N.AGG1.bottom)), "端口落在底边 y 上");
}

console.log("⑤ 所有链路两端都拿到锚点，且同边锚点不重合");
let allAnchored = true;
for (const l of L.links) if (!l.aAnchor || !l.bAnchor) allAnchored = false;
ok(allAnchored, "每条链路都有 aAnchor + bAnchor");
let dup = false;
for (const id in N) for (const side of ["top","bottom","left","right"]) {
  const pts = N[id].ports[side].map(p => (p.end==="a"?p.link.aAnchor:p.link.bAnchor));
  for (let i=0;i<pts.length;i++) for (let j=i+1;j<pts.length;j++)
    if (approx(pts[i].x,pts[j].x)&&approx(pts[i].y,pts[j].y)) dup=true;
}
ok(!dup, "同一条边上无重合锚点");

console.log("⑥ HA 横链走左右边（同 tier）");
const ha = L.links.find(l => l.type === "ha");
ok(ha && (ha.aAnchor.side==="right"||ha.aAnchor.side==="left") && (ha.bAnchor.side==="left"||ha.bAnchor.side==="right"),
   `HA a.side=${ha&&ha.aAnchor.side} b.side=${ha&&ha.bAnchor.side}`);

console.log("⑦ bbox 有限");
ok(Object.values(L.bbox).every(Number.isFinite), JSON.stringify(L.bbox));

console.log("⑧ Zone 包围盒纯派生：圈住成员、不圈邻居、随 pad 外扩");
{
  const svr = L.zones.find(z => z.id === "ZONE_SVR");
  ok(!!svr, "ZONE_SVR 存在");
  const members = ["AGG1", "ACC1", "ACC2", "MORE1", "ACC3"].map(id => N[id]);
  const minLeft = Math.min(...members.map(n => n.left)), maxRight = Math.max(...members.map(n => n.right));
  const minTop = Math.min(...members.map(n => n.top)), maxBottom = Math.max(...members.map(n => n.bottom));
  // 引用 CFG.ZONE_PAD 而不是硬编码 18——跟 ②b 的 SATELLITE_GAP 同理，常量改了测试要跟着走
  ok(approx(svr.bbox.minX, minLeft - CFG.ZONE_PAD) && approx(svr.bbox.maxX, maxRight + CFG.ZONE_PAD), "ZONE_SVR X 方向精确包住成员 + pad");
  ok(approx(svr.bbox.minY, minTop - CFG.ZONE_PAD) && approx(svr.bbox.maxY, maxBottom + CFG.ZONE_PAD), "ZONE_SVR Y 方向精确包住成员 + pad");
  ok(svr.bbox.maxX < N.AGG2.left, "ZONE_SVR 不越界侵入 Agg-2（另一个 zone 的地盘）");
}

console.log("⑨ deviceRoles 只给 legend（SOUL.md 要求的最小字段），不给 w/h 也不该整坍缩成 NaN");
{
  // 回归：topo.js 曾经写成 `model.encoding.deviceRoles[d.role] || {w:72,h:42}`——role 条目
  // 一存在（哪怕只有 legend）就不会走 fallback，w/h 缺失变成 undefined，从 cx 到 bbox 全线
  // 传染成 NaN（JSON 序列化后看着像 null），图形全堆到左上角。断言要用字段级默认，不是整条兜底。
  const minimalModel = {
    encoding: { deviceRoles: { sw: { legend: "交换机" } }, linkTypes: { link: { legend: "链路" } }, connTypes: {} },
    devices: [
      { id: "A", role: "sw", tier: 0, label: "A" },
      { id: "B", role: "sw", tier: 1, label: "B" },
    ],
    links: [{ a: "A", b: "B", type: "link", aConn: "", bConn: "" }],
  };
  const ML = computeLayout(minimalModel);
  ok(Object.values(ML.bbox).every(Number.isFinite), "缺 w/h 时 bbox 仍为有限数: " + JSON.stringify(ML.bbox));
  ok(Number.isFinite(ML.nodes.A.cx) && Number.isFinite(ML.nodes.B.cx), "缺 w/h 时 cx 仍为有限数");
}

console.log("⑩ 只给 legend 时也该拿到不同角色互相区分的颜色（不是清一色灰/黑）");
{
  // 回归：buildLegend 的设备图例、drawEdges 原来读 e.fill/e.stroke 完全没兜底——SOUL.md
  // 从不要求 agent 写 fill/stroke，缺字段时 SVG 属性变成字面量 "undefined"，浏览器按
  // fill 初始值（黑）处理，图例方块、连线全变黑；drawNodes 虽有兜底但只是同一种灰，
  // 所有角色看起来毫无区分度。normalizeEncoding 应按名字哈希取色，且不同名字要分到不同颜色。
  const twoRoleModel = {
    encoding: {
      deviceRoles: { alpha: { legend: "A角色" }, beta: { legend: "B角色" } },
      linkTypes: { link: { legend: "链路" } },
      connTypes: {},
    },
    devices: [
      { id: "A", role: "alpha", tier: 0, label: "A" },
      { id: "B", role: "beta", tier: 1, label: "B" },
    ],
    links: [{ a: "A", b: "B", type: "link", aConn: "", bConn: "" }],
  };
  computeLayout(twoRoleModel); // 就地补全 twoRoleModel.encoding
  const { alpha, beta } = twoRoleModel.encoding.deviceRoles;
  ok(!!alpha.fill && !!alpha.stroke && !!beta.fill && !!beta.stroke, "两个角色都拿到了 fill+stroke");
  ok(alpha.fill !== beta.fill, `不同角色颜色要不同 (alpha=${alpha.fill}, beta=${beta.fill})`);
  const link = twoRoleModel.encoding.linkTypes.link;
  ok(!!link.stroke && typeof link.width === "number", `linkType 也补全了 stroke/width (stroke=${link.stroke}, width=${link.width})`);
}

console.log("⑪ iconTheme 从 device 透传到 layout 节点(渲染要用,不影响布局坐标)");
{
  const model = {
    encoding: { deviceRoles: { sw: { legend: "交换机" } }, linkTypes: {}, connTypes: {} },
    devices: [
      { id: "A", role: "sw", tier: 0, label: "A", iconTheme: "yellow" },
      { id: "B", role: "sw", tier: 1, label: "B" },
    ],
    links: [],
  };
  const L = computeLayout(model);
  ok(L.nodes.A.iconTheme === "yellow", "设了 iconTheme 的设备,layout 节点上能读到");
  ok(L.nodes.B.iconTheme === null, "没设 iconTheme 的设备,layout 节点上是 null(不是 undefined 导致的 key 缺失)");
}

console.log("⑫ aPort/bPort 是纯逻辑标签,链路对象整体透传到 layout.links,不参与坐标计算");
{
  const model = {
    encoding: { deviceRoles: { sw: { legend: "交换机" } }, linkTypes: {}, connTypes: {} },
    devices: [
      { id: "A", role: "sw", tier: 0, label: "A" },
      { id: "B", role: "sw", tier: 1, label: "B" },
    ],
    links: [{ a: "A", b: "B", type: "normal", aPort: "p1", bPort: "p2" }],
  };
  const L = computeLayout(model);
  const link = L.links.find(l => l.a === "A" && l.b === "B");
  ok(!!link, "链路存在于 layout.links");
  ok(link && link.aPort === "p1", "aPort 透传到 layout.links");
  ok(link && link.bPort === "p2", "bPort 透传到 layout.links");
}

console.log("⑬ 设了 icon 时,方框 w 由 opts.icons 里的 aspect 从 h 派生,忽略作者写的 w;三种边界情况下行为不变");
{
  const iconModel = {
    encoding: { deviceRoles: { core: { w: 999, h: 40, legend: "核心", icon: "core-switch" } }, linkTypes: {}, connTypes: {} },
    devices: [{ id: "A", role: "core", tier: 0, label: "A" }],
    links: [],
  };
  const withAspect = computeLayout(iconModel, { icons: { "core-switch": { aspect: 2 } } });
  ok(approx(withAspect.nodes.A.w, 80), `设了 icon 且 opts.icons 有 aspect 时,w = h(40) × aspect(2) = 80,忽略作者写的 999(实际 ${withAspect.nodes.A.w})`);

  const withoutOpts = computeLayout(iconModel);
  ok(withoutOpts.nodes.A.w === 999, `没传 opts.icons 时,直接用作者写的 w(999),不报错不崩溃(实际 ${withoutOpts.nodes.A.w})`);

  const withUnrelatedIcons = computeLayout(iconModel, { icons: { "some-other-key": { aspect: 3 } } });
  ok(withUnrelatedIcons.nodes.A.w === 999, `opts.icons 里没有这个角色引用的 icon key 时,同样用作者写的 w(999)(实际 ${withUnrelatedIcons.nodes.A.w})`);

  const noIconModel = {
    encoding: { deviceRoles: { plain: { w: 60, h: 30, legend: "无图标角色" } }, linkTypes: {}, connTypes: {} },
    devices: [{ id: "C", role: "plain", tier: 0, label: "C" }],
    links: [],
  };
  const L2 = computeLayout(noIconModel, { icons: { "core-switch": { aspect: 2 } } });
  ok(L2.nodes.C.w === 60, `没有 icon 字段的角色,即使 opts.icons 里有别的 key,w/h 仍独立作者化不变(实际 ${L2.nodes.C.w})`);
}

console.log("⑭ 图例(legend)从 meta.showLegend/legendPosition/legendGroups 派生,永远算(除非显式关闭)");
{
  const baseModel = () => ({
    encoding: {
      deviceRoles: { sw: { legend: "交换机" } },
      linkTypes: { link: { legend: "链路" } },
      connTypes: {},
    },
    devices: [
      { id: "A", role: "sw", tier: 0, label: "A" },
      { id: "B", role: "sw", tier: 1, label: "B" },
    ],
    links: [{ a: "A", b: "B", type: "link" }],
  });

  const L1 = computeLayout(baseModel());
  ok(!!L1.legend, "没设 meta 时(缺省 showLegend)图例存在");
  ok(L1.legend.position === "bottom", `缺省 legendPosition 是 bottom(实际 ${L1.legend && L1.legend.position})`);
  ok(L1.legend.groups.length === 2, `缺省 legendGroups 时,两个用到的分组(设备/链路)都在(实际 ${L1.legend.groups.length})`);

  const noLegendModel = baseModel();
  noLegendModel.meta = { showLegend: false };
  const L2 = computeLayout(noLegendModel);
  ok(L2.legend === null, "showLegend:false 时图例是 null");
  ok(L2.bbox.maxX < L1.bbox.maxX, `showLegend:false 时整体 bbox 比有图例时更小(有=${L1.bbox.maxX}, 无=${L2.bbox.maxX})`);

  for (const pos of ["top", "bottom", "left", "right"]) {
    const m = baseModel();
    m.meta = { legendPosition: pos };
    const L = computeLayout(m);
    ok(!!L.legend && L.legend.position === pos, `legendPosition=${pos} 时 layout.legend.position 正确(实际 ${L.legend && L.legend.position})`);
  }
  {
    const mRight = baseModel(); mRight.meta = { legendPosition: "right" };
    const LRight = computeLayout(mRight);
    ok(LRight.legend.bbox.minX >= LRight.nodes.A.right && LRight.legend.bbox.minX >= LRight.nodes.B.right,
      `legendPosition=right 时图例包围盒(minX=${LRight.legend.bbox.minX})在两个节点右边界之外,不与设备重叠`);
  }
  {
    const m = baseModel();
    m.meta = { legendGroups: ["linkTypes"] };
    const L = computeLayout(m);
    ok(L.legend.groups.length === 1 && L.legend.groups[0].kind === "linkTypes",
      `legendGroups 只给 linkTypes 时,图例只有这一个分组(实际 ${L.legend.groups.map(g => g.kind).join(",")})`);
  }
  {
    const emptyModel = {
      encoding: { deviceRoles: {}, linkTypes: {}, connTypes: {} },
      devices: [], links: [],
    };
    const L = computeLayout(emptyModel);
    ok(L.legend === null, "模型完全没有设备/链路时,图例没有内容可画,是 null(不是空数组的壳)");
  }
}

console.log("⑮ 图例上/下摆放是横向流式(同组条目共享一行、面板横宽),左/右摆放是竖列(面板竖高)");
{
  // 造一个某组条目数明显偏多的模型：5 个设备角色 → 横向排布时它们该挤在同一行(或少数几行),
  // 而不是像竖列那样一行一个。
  const model = {
    meta: {},
    encoding: {
      deviceRoles: { a:{legend:"甲"}, b:{legend:"乙"}, c:{legend:"丙"}, d:{legend:"丁"}, e:{legend:"戊"} },
      linkTypes: { link:{legend:"链路"} },
      connTypes: {},
    },
    devices: [
      { id:"A", role:"a", tier:0, label:"A" }, { id:"B", role:"b", tier:0, label:"B" },
      { id:"C", role:"c", tier:0, label:"C" }, { id:"D", role:"d", tier:1, label:"D" },
      { id:"E", role:"e", tier:1, label:"E" },
    ],
    links: [{ a:"A", b:"D", type:"link" }],
  };

  const bottom = (() => { const m = JSON.parse(JSON.stringify(model)); m.meta.legendPosition = "bottom"; return computeLayout(m); })();
  const dev = bottom.legend.groups.find(g => g.kind === "deviceRoles");
  const distinctY = new Set(dev.rows.map(r => r.y));
  ok(distinctY.size < dev.rows.length, `bottom 时设备组 5 个条目横向排列,占的行数(${distinctY.size})少于条目数(${dev.rows.length})——不是一行一个`);
  const someRowShared = [...distinctY].some(y => dev.rows.filter(r => r.y === y).length >= 2);
  ok(someRowShared, "bottom 时至少有一行同时坐着 ≥2 个设备条目(证明是横向铺开,不是竖列)");
  const bw = bottom.legend.bbox.maxX - bottom.legend.bbox.minX, bh = bottom.legend.bbox.maxY - bottom.legend.bbox.minY;
  ok(bw > bh, `bottom 图例面板横宽(w=${bw.toFixed(0)} > h=${bh.toFixed(0)})`);

  const left = (() => { const m = JSON.parse(JSON.stringify(model)); m.meta.legendPosition = "left"; return computeLayout(m); })();
  const devL = left.legend.groups.find(g => g.kind === "deviceRoles");
  const distinctYL = new Set(devL.rows.map(r => r.y));
  ok(distinctYL.size === devL.rows.length, `left 时设备组仍是竖列,一行一个(行数${distinctYL.size}===条目数${devL.rows.length})`);
  // 竖列面板宽度固定(PANEL_W),条目少时绝对值上可能宽>高,所以不直接比 w/h；改成跟同内容的
  // 横向面板对比：竖列一定比横向更高、更窄(同一份分组,一个纵向堆一个横向铺)。
  const lw = left.legend.bbox.maxX - left.legend.bbox.minX, lh = left.legend.bbox.maxY - left.legend.bbox.minY;
  ok(lh > bh, `left 竖列比 bottom 横向更高(left h=${lh.toFixed(0)} > bottom h=${bh.toFixed(0)})`);
  ok(lw < bw, `left 竖列比 bottom 横向更窄(left w=${lw.toFixed(0)} < bottom w=${bw.toFixed(0)})`);
}

console.log("⑯ meta.rowGap/hGap/zonePad 作者化覆盖真实生效");
{
  const m = JSON.parse(JSON.stringify(model));
  m.meta.rowGap = 10;
  const tight = computeLayout(m);
  const NN = tight.nodes;
  const clearance = NN.CORE1.top - Math.max(NN.RT1.bottom, NN.RT2.bottom);
  ok(Math.abs(clearance - 10) < 1e-6, `meta.rowGap:10 后 RT行到CORE行净空=10(实际 ${clearance.toFixed(1)})`);
  const m2 = JSON.parse(JSON.stringify(model));
  m2.meta.zonePad = 40;
  const padded = computeLayout(m2);
  const zv = padded.zones.find(z => z.id === "ZONE_SVR");
  const zvOld = L.zones.find(z => z.id === "ZONE_SVR");
  ok(Math.abs(((zv.bbox.maxX - zv.bbox.minX) - (zvOld.bbox.maxX - zvOld.bbox.minX)) - 44) < 1e-6,
    "meta.zonePad:40 让 zone 框每边多扩 22(共宽 44)");
  // opts 排在 meta 之后 → 程序化调用方赢。注意 opts 用大写键(CFG 的键名)，写小写会被静默忽略
  const both = computeLayout(m, { ROW_GAP: 5 });
  const NB = both.nodes;
  const cl2 = NB.CORE1.top - Math.max(NB.RT1.bottom, NB.RT2.bottom);
  ok(Math.abs(cl2 - 5) < 1e-6, `opts.ROW_GAP:5 压过 meta.rowGap:10(实际净空 ${cl2.toFixed(1)})`);
  const lower = computeLayout(m, { rowGap: 5 });
  const NL = lower.nodes;
  const cl3 = NL.CORE1.top - Math.max(NL.RT1.bottom, NL.RT2.bottom);
  ok(Math.abs(cl3 - 10) < 1e-6, `opts 用小写键 rowGap 被静默忽略,仍是 meta 的 10(实际 ${cl3.toFixed(1)})——大小写契约的成文记录`);
}

console.log("⑰ 端口挂哪条边按【实际几何位置】判定，不是按 tier 字段（跨 zone 时 tier 不可比）");
{
  // 回归用例，来自真实 bug：tier 自 regions.js 起是 zone 内的【局部序号】，跨 zone 比较
  // tier 数值没有意义。旧实现 `nb.tier > na.tier ? "bottom" : "top"` 会把"根区域 tier 1 的
  // 路由器"和"某集群内局部 tier 0 的交换机"比成 0<1 → 判定交换机在上游 → 把往下走的线
  // 挂到路由器【顶边】，线从设备顶部绕出来造成交叉。而 DRC/几何检查全绿，属沉默失败。
  // 这里构造同样的拓扑形状：RT 在根区域 tier 1，SWX 在 zone 内局部 tier 0 但实际在 RT 下方。
  const m = {
    meta: {},
    encoding: { deviceRoles: { r: { w: 60, h: 40, legend: "r" } }, linkTypes: { normal: {} }, connTypes: {}, zoneTypes: { z: {} } },
    devices: [
      { id: "UP",  role: "r", tier: 0, label: "UP" },   // 根区域，在 RT 上方
      { id: "RT",  role: "r", tier: 1, label: "RT" },   // 根区域
      { id: "SWX", role: "r", tier: 0, label: "SWX" },  // zone 内【局部】tier 0，但实际在 RT 下方
    ],
    links: [{ a: "UP", b: "RT", type: "normal" }, { a: "RT", b: "SWX", type: "normal" }],
    zones: [{ id: "ZC", type: "z", layout: "row", tier: 2, members: ["SWX"] }],
  };
  const LL = computeLayout(m);
  const sideOf = (id, linkIdx) => {
    const l = LL.links[linkIdx];
    return l.a === id ? l.aAnchor.side : l.bAnchor.side;
  };
  ok(LL.nodes.SWX.cy > LL.nodes.RT.cy, `前提成立：SWX 实际在 RT 下方 (cy ${LL.nodes.SWX.cy} > ${LL.nodes.RT.cy})`);
  ok(LL.nodes.SWX.tier < LL.nodes.RT.tier, `前提成立：但 SWX 的 tier 字段反而更小 (${LL.nodes.SWX.tier} < ${LL.nodes.RT.tier})——正是旧实现会判错的形状`);
  ok(sideOf("RT", 0) === "top", "RT→上游 UP 走顶边");
  ok(sideOf("RT", 1) === "bottom", `RT→下游 SWX 走底边（旧实现在这里会错判成 top，实际=${sideOf("RT", 1)}）`);
  ok(LL.nodes.RT.ports.top.length === 1 && LL.nodes.RT.ports.bottom.length === 1,
    `RT 上下各一个端口（实际 top=${LL.nodes.RT.ports.top.length} bottom=${LL.nodes.RT.ports.bottom.length}）`);
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
