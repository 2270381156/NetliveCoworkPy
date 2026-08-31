/* node 自测：geometry-report.js 的几何测量。用法： node verify-geometry-report.js */
const { buildGeometryReport } = require("./geometry-report.js");
const { computeLayout } = require("./topo.js");
const { resolveIconsForModel } = require("./icons.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

console.log("① 干净的样例图：无重叠、无越界、行净空全部非负");
{
  const model = require("./topo-data.js");
  const layout = computeLayout(model, { icons: resolveIconsForModel(model) });
  const g = buildGeometryReport(model, layout);
  ok(g.zoneOverlaps.length === 0, `zoneOverlaps 为空(实际 ${g.zoneOverlaps.length})`);
  ok(g.containmentViolations.length === 0, `containmentViolations 为空(实际 ${g.containmentViolations.length})`);
  ok(g.rowClearances.length > 0 && g.rowClearances.every(r => r.clearance >= 0),
    `rowClearances ${g.rowClearances.length} 条全部非负: ` + g.rowClearances.map(r => r.clearance).join(","));
}

console.log("② position 钉住制造的兄弟 zone 重叠：能被量出来");
{
  const model = {
    meta: {}, encoding: { deviceRoles: { r: { w: 60, h: 30, legend: "r" } }, linkTypes: {}, connTypes: {}, zoneTypes: { t: {} } },
    devices: [{ id: "A1", role: "r", tier: 0, label: "A1" }, { id: "B1", role: "r", tier: 0, label: "B1" }],
    links: [],
    zones: [
      { id: "ZA", type: "t", layout: "row", tier: 0, members: ["A1"] },
      { id: "ZB", type: "t", layout: "row", tier: 0, members: ["B1"], position: { dx: 0, dy: 0 } }
    ]
  };
  const layout = computeLayout(model);
  const g = buildGeometryReport(model, layout);
  ok(g.zoneOverlaps.length === 1 && ((g.zoneOverlaps[0].a === "ZA" && g.zoneOverlaps[0].b === "ZB") || (g.zoneOverlaps[0].a === "ZB" && g.zoneOverlaps[0].b === "ZA")),
    `ZA/ZB 重叠被报出(实际 ${JSON.stringify(g.zoneOverlaps)})`);
}

console.log("③ position 把子 zone 钉出父 zone 外：containmentViolations 能报出");
{
  const model = {
    meta: {}, encoding: { deviceRoles: { r: { w: 60, h: 30, legend: "r" } }, linkTypes: {}, connTypes: {}, zoneTypes: { t: {} } },
    devices: [{ id: "A1", role: "r", tier: 0, label: "A1" }, { id: "A2", role: "r", tier: 0, label: "A2" }],
    links: [],
    zones: [
      { id: "OUTER", type: "t", layout: "row", tier: 0, members: ["SUB", "A2"] },
      { id: "SUB", type: "t", layout: "row", tier: 0, members: ["A1"], position: { dx: 9999, dy: 0 } }
    ]
  };
  const layout = computeLayout(model);
  const g = buildGeometryReport(model, layout);
  ok(g.containmentViolations.some(v => v.zone === "OUTER" && v.member === "SUB"),
    `SUB 越出 OUTER 被报出(实际 ${JSON.stringify(g.containmentViolations)})`);
}

console.log("④ 走线穿越设备：竖排设备下方的连线必然压过上面那台，要能量出来");
{
  // 2026-07-28 真实用户第一轮就撞上的问题（"服务器2/4/6连接交换机的线都被压住了"）。
  // 此前四项测量全是设备/zone 的矩形关系,没有一项跟连线有关——线穿设备时 DRC 100 分、
  // 几何全清,只有人眼看得出来。
  const m = {
    meta: {}, encoding: {
      deviceRoles: { sw: { legend: "交换机" }, srv: { legend: "服务器" } },
      linkTypes: { plain: { legend: "链路" } }, connTypes: {}, zoneTypes: { g: { legend: "组" } },
    },
    // 一根竖柱：SW 在上,两台服务器依次在下（column 布局 + 同 tier,靠声明顺序定上下）
    devices: [
      { id: "SW", role: "sw", tier: 0, label: "SW" },
      { id: "S1", role: "srv", tier: 0, label: "S1" },
      { id: "S2", role: "srv", tier: 0, label: "S2" },
    ],
    links: [
      { a: "SW", b: "S1", type: "plain" },
      { a: "SW", b: "S2", type: "plain" },   // ← 这条必然穿过 S1
    ],
    zones: [{ id: "Z", type: "g", label: "机架", layout: "column", members: ["SW", "S1", "S2"] }],
  };
  const L = computeLayout(m, { icons: {} });
  const g = buildGeometryReport(m, L);
  const hit = g.linkCrossings.find(c => c.a === "SW" && c.b === "S2");
  ok(!!hit, `SW→S2 被报出穿越（实际 ${JSON.stringify(g.linkCrossings)}）`);
  ok(hit && hit.crosses.includes("S1"), `并且指名压过的是 S1（实际 ${hit && JSON.stringify(hit.crosses)}）`);
  ok(!g.linkCrossings.some(c => c.b === "S1"), "SW→S1 自己不算穿越（端点不计）");
  // 这几项测量互不替代:压线时其余三项照样全清,正是它必须单独存在的理由
  ok(g.zoneOverlaps.length === 0 && g.containmentViolations.length === 0,
    "压线的同时 zone 重叠/越界仍为 0——旧的四项测量抓不到这类问题");
}

console.log("④b 干净的树形图不误报（密集网状也不能虚报）");
{
  for (const f of ["./topo-data.js", "./demo-dc-spine-leaf.topo.json"]) {
    const raw = f.endsWith(".js") ? require(f) : JSON.parse(require("fs").readFileSync(f, "utf8"));
    const mm = JSON.parse(JSON.stringify(raw));
    const g = buildGeometryReport(mm, computeLayout(mm, { icons: {} }));
    ok(g.linkCrossings.length === 0,
      `${f} 零误报（实际 ${g.linkCrossings.length} 条：${g.linkCrossings.map(c => c.a + "→" + c.b).join(", ")}）`);
  }
}

console.log("④c column 分列被如实报出 —— 想要上下堆叠却写了不同 tier 时,这是唯一的线索");
{
  // column 里 tier 是"第几列"不是"第几行"。多列是有意设计的能力(verify-regions ⑱ 锁着),
  // 不能硬报错;但它也是最隐蔽的沉默失败:2026-07-28 真实 agent 想要"交换机一行、服务器一行",
  // 写成 column + 不同 tier 得到并排两列,用户连说两轮"还是在同一排",它却在改 zone 的 type
  // 和嵌套层数——因为 DRC 满分、几何全清,没有任何东西指向真正的原因。
  const mk = (t1, t2) => ({
    encoding: { deviceRoles: { r: {} }, linkTypes: {}, connTypes: {}, zoneTypes: { g: {} } },
    devices: [{ id: "A", role: "r", tier: 0, label: "A" }, { id: "B", role: "r", tier: 0, label: "B" }],
    links: [],
    zones: [
      { id: "ZA", type: "g", tier: t1, members: ["A"] },
      { id: "ZB", type: "g", tier: t2, members: ["B"] },
      { id: "OUT", type: "g", layout: "column", tier: 0, members: ["ZA", "ZB"] },
    ],
  });
  const rep = (m) => buildGeometryReport(m, computeLayout(m, { icons: {} }));

  const bad = rep(mk(0, 1));
  ok(bad.columnFanouts.length === 1, `不同 tier 的 column zone 被报出(实际 ${JSON.stringify(bad.columnFanouts)})`);
  ok(bad.columnFanouts[0] && bad.columnFanouts[0].columns === 2, "说清了分出几列");
  ok(bad.columnFanouts[0] && bad.columnFanouts[0].byTier.length === 2, "并列出每一列各是谁(照着改才知道往哪合)");
  ok(bad.zoneOverlaps.length === 0 && bad.containmentViolations.length === 0,
    "同时其余各项全清——这正是它必须单独存在的理由");

  ok(rep(mk(0, 0)).columnFanouts.length === 0, "同 tier(正确的堆叠写法)不报,没有噪音");
}

console.log("⑤ cli.js draw 输出里带 geometry 字段");
{
  const { spawnSync } = require("child_process");
  const path = require("path");
  const os = require("os");
  const model = require("./topo-data.js");
  // observe 于 2026-07-28 并入 draw：诊断和预览是同一次调用的两个产出。
  const out0 = path.join(os.tmpdir(), "verify-geomrep-draw.html");
  const r = spawnSync(process.execPath, [path.join(__dirname, "cli.js"), "draw", `--out=${out0}`],
    { input: JSON.stringify(model), encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  ok(out.geometry && Array.isArray(out.geometry.zoneOverlaps) && Array.isArray(out.geometry.rowClearances),
    "draw 返回 geometry.{zoneOverlaps,containmentViolations,rowClearances}");
}

console.log("⑤ 旁挂溢出：rowClearances 只量主组(不受旁挂污染)，真碰撞走 satelliteOverflows 的二维求交");
{
  // SAT 旁挂在 tier0 的 A 上、但高达 400——布局层有意让它纵向溢出到 tier1 的侧边空间,
  // 不把整张图撑高(measureRow 的行高只看主组)。两个指标各管一件事:
  //   rowClearances 只量主组间距(rowGap 真正控制的量),不能被旁挂污染成假警报;
  //   satelliteOverflows 用真正的二维矩形求交判定旁挂有没有撞到别的行。
  // 旁挂永远被摆在锚点外侧(锚点边缘 + satelliteGap)，所以它够不着自己这一行的主组；真会
  // 出事的是"下面某一行特别宽、宽到伸进旁挂正下方"。用 tier1 的设备台数来控制这件事。
  const mk = (nWide) => ({
    meta: {},
    encoding: { deviceRoles: { r: { w: 60, h: 30, legend: "r" }, tall: { w: 60, h: 400, legend: "tall" } },
                linkTypes: {}, connTypes: {}, zoneTypes: {} },
    devices: [
      { id: "A", role: "r", tier: 0, label: "A" },
      { id: "SAT", role: "tall", tier: 0, label: "SAT", satelliteOf: "A" }
    ].concat(Array.from({ length: nWide }, (_, i) => ({ id: "B" + i, role: "r", tier: 1, label: "B" + i }))),
    links: [], zones: []
  });
  const model = mk(1);
  const g = buildGeometryReport(model, computeLayout(model));
  const rc = g.rowClearances.find(r => r.fromTier === 0 && r.toTier === 1);
  ok(rc && Math.abs(rc.clearance - 78) < 1e-6,
    `rowClearances 只看主组,400高的旁挂没有污染它(实际 ${rc ? rc.clearance : "没有这条记录"},期望 78)`);
  // tier1 只有一台、居中于 x=0；SAT 贴在 A 外侧 90 远处,水平方向离得远 → 不算碰撞
  ok(g.satelliteOverflows.length === 0,
    `旁挂虽然纵向跨行,但水平方向不碰主组,不误报(实际 ${JSON.stringify(g.satelliteOverflows)})`);
  // tier1 摆 12 台,整行宽到伸进旁挂正下方 → 真碰撞,必须报出来
  const wide = mk(12);
  const g2 = buildGeometryReport(wide, computeLayout(wide));
  ok(g2.satelliteOverflows.some(s => s.satellite === "SAT" && s.intoTier === 1),
    `下一行宽到伸进旁挂底下时,二维求交把它报出来(实际 ${JSON.stringify(g2.satelliteOverflows)})`);
}

console.log("⑥ isAncestor 在循环引用的畸形模型上不死循环(本模块可被单独调用,不能依赖上游门禁)");
{
  // computeLayout 会先拒掉循环引用,但 geometry-report 也导出成 window.TopoGeometryReport,
  // 可能拿到没过门禁的模型。这里直接手搓一份 layout,绕过 computeLayout 的校验。
  const model = {
    devices: [{ id: "D", role: "r", tier: 0, label: "D" }],
    zones: [{ id: "ZA", members: ["ZB"] }, { id: "ZB", members: ["ZA"] }, { id: "ZC", members: ["D"] }]
  };
  const bb = (x) => ({ minX: x, minY: 0, maxX: x + 10, maxY: 10 });
  const layout = {
    nodes: { D: { left: 0, top: 0, right: 10, bottom: 10 } },
    zones: [{ id: "ZA", bbox: bb(0) }, { id: "ZB", bbox: bb(100) }, { id: "ZC", bbox: bb(200) }]
  };
  let done = false;
  try { buildGeometryReport(model, layout); done = true; } catch (e) { done = true; }
  ok(done, "环状 parentOf 上没有卡死(有 seen 集合兜底)");
}

// 设备标签伸出所属 zone 虚框
// 实测复现过（2026-07-29）:长标签 + 靠 zone 边缘的设备 → 横向伸出 14.8px。根因是
// regions.js 按方框宽排列、topo.js 按方框包围盒加 ZONE_PAD,标签宽度从未参与。
// 布局层已修（footprintWidth 把标签宽算进占位）,这条是护栏:elk 引擎、meta 覆盖、
// agent 手写 w/h 仍能把它带回来,而文本宽度只能估。
console.log("⑦ labelOverflows：设备标签伸出 zone 虚框");
{
  const base = JSON.parse(JSON.stringify(require("./topo-data.js")));
  const icons = resolveIconsForModel(base);
  const layout = computeLayout(base, { icons });

  ok(buildGeometryReport(base, layout).labelOverflows.length === 0,
    "布局已给标签留位置 → 参考图零溢出");

  // 长标签用例:改之前这里会报溢出,改之后布局把设备排开、zone 框跟着变宽 → 仍应为零
  const long = JSON.parse(JSON.stringify(require("./topo-data.js")));
  const map = { "Acc-1": "Access-Switch-Building-A", "Acc-2": "Access-Switch-Building-B",
                "Acc-3": "Access-Switch-Building-C" };
  for (const d of long.devices) if (map[d.label]) d.label = map[d.label];
  long.encoding.deviceRoles.access.legend = "园区接入层交换机（千兆）";
  const longLayout = computeLayout(long, { icons: resolveIconsForModel(long) });
  ok(buildGeometryReport(long, longLayout).labelOverflows.length === 0,
    "长标签用例也零溢出（布局按占位宽把设备排开了）");
  // 顺带钉住"确实排开了",否则上一条可能是因为别的原因恰好不溢出
  const refAcc = Object.values(layout.nodes).find(n => n.label === "Acc-1");
  const longAcc = Object.values(longLayout.nodes).find(n => n.label === "Access-Switch-Building-A");
  ok(Math.abs(longAcc.cx - refAcc.cx) > 1,
    `长标签让设备横向让位（cx ${refAcc.cx.toFixed(1)} → ${longAcc.cx.toFixed(1)}）`);

  // 反向:人为缩窄 zone 框,断言必须报出来——否则这条检查是摆设
  const narrow = computeLayout(JSON.parse(JSON.stringify(require("./topo-data.js"))), { icons });
  for (const z of narrow.zones) { z.bbox.minX += 30; z.bbox.maxX -= 30; }
  const hit = buildGeometryReport(base, narrow).labelOverflows;
  ok(hit.length > 0, `缩窄 zone 框后能抓到（${hit.length} 条）`);
  ok(hit.every(o => o.overflowPx > 0 && (o.side === "left" || o.side === "right")),
    "每条都带溢出量和方向");
  ok(hit.every(o => o.zone && o.device), "每条都指明了 zone 和设备");
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
