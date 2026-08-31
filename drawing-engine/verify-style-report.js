/* node 自测：style-report.js 的图示层体检 + topo.js 配色分配的去重保证。
   用法： node verify-style-report.js

   这两件事放一个文件里，是因为它们钉的是同一个教训（2026-07-27，由真实 agent 画的第一张图
   暴露）：DRC 100 分的图，五个角色一个图标没有、其中两个还共用一种颜色。前者是因为
   observe 的返回值里根本没提过图标，后者是因为原来的 PALETTE[hash(key)%8] 会撞——而代码
   注释却声称"保证每个不同的角色都有彼此区分的颜色"。 */
const { buildStyleReport } = require("./style-report.js");
const { normalizeEncoding } = require("./topo.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

// 造一个"只写 legend"的裸模型——这正是 SOUL.md 允许、真实 agent 实际会写的形态
function bareModel(roleNames) {
  const deviceRoles = {};
  for (const r of roleNames) deviceRoles[r] = { legend: r };
  return {
    encoding: { deviceRoles, linkTypes: {}, connTypes: {}, zoneTypes: {} },
    devices: roleNames.map((r, i) => ({ id: "d" + i, role: r, tier: i, label: "D" + i })),
    links: [], zones: []
  };
}

console.log("① 配色去重：调色板装得下时，每个角色颜色互不相同");
{
  // 就是这条断言在 2026-07-27 之前是缺的：当时 access-switch 和 pc 撞到同一格，
  // 5 个角色只出 4 种颜色，所有测试全绿、只有人眼看得出来。
  const m = bareModel(["internet", "router", "core-switch", "access-switch", "pc"]);
  normalizeEncoding(m);
  const fills = Object.values(m.encoding.deviceRoles).map(r => r.fill);
  ok(new Set(fills).size === fills.length,
    `5 个角色 5 种不同底色（实际 ${new Set(fills).size} 种）`);
  const strokes = Object.values(m.encoding.deviceRoles).map(r => r.stroke);
  ok(new Set(strokes).size === strokes.length, "描边色同样两两不同");
  ok(buildStyleReport(m).roleColorCollisions.length === 0, "style 报告里没有撞色");
}

console.log("② 作者显式写死的颜色会占坑，自动分配的不许跟它撞");
{
  const m = bareModel(["a", "b", "c"]);
  m.encoding.deviceRoles.a.fill = "#e7f3ec";   // 抢占 PALETTE[2]
  m.encoding.deviceRoles.a.stroke = "#5aa27a";
  normalizeEncoding(m);
  const others = ["b", "c"].map(k => m.encoding.deviceRoles[k].fill);
  ok(!others.includes("#e7f3ec"), "自动分配没有复用作者写死的那组色");
  ok(new Set(others).size === 2, "其余角色之间也不撞");
}

console.log("③ 角色数超过调色板长度时，如实报出撞色（不静默掩盖）");
{
  const names = Array.from({ length: 10 }, (_, i) => "r" + i);
  const m = bareModel(names);
  normalizeEncoding(m);
  const fills = Object.values(m.encoding.deviceRoles).map(r => r.fill);
  ok(new Set(fills).size === 8, `10 个角色用满 8 格调色板（实际 ${new Set(fills).size} 种）`);
  ok(buildStyleReport(m).roleColorCollisions.length > 0,
    "撞色被报进 style.roleColorCollisions，agent 看得见");
}

console.log("④ rolesWithoutIcon：这就是 agent 该不该回去挑图标的信号");
{
  const m = bareModel(["sw", "fw", "cloud-node", "dots"]);
  m.encoding.deviceRoles.fw.icon = "firewall";        // 配了图标
  m.encoding.deviceRoles["cloud-node"].glyph = "cloud"; // 用 glyph 表达，不算缺
  m.encoding.deviceRoles.dots.decorative = true;        // 省略标记，本来就不该有图标
  normalizeEncoding(m);
  const rep = buildStyleReport(m);
  ok(rep.rolesWithoutIcon.length === 1 && rep.rolesWithoutIcon[0] === "sw",
    `只报真正缺图标的角色（实际 ${JSON.stringify(rep.rolesWithoutIcon)}）`);
}

console.log("④b 只有 draw-core 真画得出来的 glyph 才算视觉标识（否则就是假的全清）");
{
  // sample-dual-core 暴露的：它每个角色都写了 glyph:"switch"/"fw"，而 draw-core 只认
  // cloud 和 ellipsis，其余值落到"普通方框"分支被静默忽略——画出来 0 个图标全是纯色框，
  // 而 style 报告当时说"缺图标 []"。检查本身给了假全清，比没有检查更糟。
  const m = bareModel(["sw", "fw", "cloudy"]);
  m.encoding.deviceRoles.sw.glyph = "switch";   // draw-core 不认，等于没写
  m.encoding.deviceRoles.fw.glyph = "fw";       // 同上
  m.encoding.deviceRoles.cloudy.glyph = "cloud"; // 这个真画得出椭圆
  normalizeEncoding(m);
  const rep = buildStyleReport(m);
  ok(rep.rolesWithoutIcon.includes("sw") && rep.rolesWithoutIcon.includes("fw"),
    `引擎不认的 glyph 仍算缺图标（实际 ${JSON.stringify(rep.rolesWithoutIcon)}）`);
  ok(!rep.rolesWithoutIcon.includes("cloudy"), "glyph:cloud 真的画得出来，不算缺");
  ok(rep.unrenderedGlyphs.length === 2, `写了但引擎不认的 glyph 被单独点出来（实际 ${JSON.stringify(rep.unrenderedGlyphs)}）`);

  // 真正的防漂移断言：RENDERED_GLYPHS 必须来自 draw-core，不是这里另抄一份
  const { RENDERED_GLYPHS } = require("./draw-core.js");
  const svg = require("./draw-core.js").buildSVG(m, require("./topo.js").computeLayout(m, {}), {});
  for (const gl of RENDERED_GLYPHS) {
    if (gl === "ellipsis") continue; // ellipsis 画的是文字不是图形，单独在 verify-draw-core 覆盖
    ok(svg.includes("<ellipse"), `draw-core 声称能画的 glyph "${gl}" 确实产出了图形`);
  }
}

console.log("④c 写了不存在的 icon key —— 只看写没写、不看值认不认识,是同一类假全清");
{
  // 2026-07-28 修 glyph 时只补了 glyph 那条,icon 这条漏了:写 icon:"不存在的key" 时
  // rolesWithoutIcon 是空的,agent 以为配好了,实际画出来全是纯色框。同一个错误犯了两次。
  const m = bareModel(["sw", "pc"]);
  m.encoding.deviceRoles.sw.icon = "core-switch";      // 目录里真有
  m.encoding.deviceRoles.pc.icon = "根本不存在的key";   // 目录里没有
  normalizeEncoding(m);
  const rep = buildStyleReport(m);
  ok(rep.unknownIcons.length === 1 && rep.unknownIcons[0].role === "pc",
    `不存在的 key 被点名（实际 ${JSON.stringify(rep.unknownIcons)}）`);
  ok(rep.rolesWithoutIcon.includes("pc"), "并且照样算进 rolesWithoutIcon（成图确实没图标）");
  ok(!rep.rolesWithoutIcon.includes("sw"), "真实存在的 key 不受影响");
}

console.log("⑤ 编码表里定义了但图上没用到的角色不打扰 agent");
{
  const m = bareModel(["used"]);
  m.encoding.deviceRoles.unused = { legend: "定义了但没有设备用它" };
  normalizeEncoding(m);
  const rep = buildStyleReport(m);
  ok(!rep.rolesWithoutIcon.includes("unused"), "未使用的角色不出现在 rolesWithoutIcon");
  ok(rep.roleCount === 1, `roleCount 只算图上真的用到的（实际 ${rep.roleCount}）`);
}

console.log("⑥ 全部配齐图标时列表为空——agent 据此判断这一项已经做完");
{
  const m = bareModel(["a", "b"]);
  m.encoding.deviceRoles.a.icon = "core-switch";
  m.encoding.deviceRoles.b.icon = "access-switch";
  normalizeEncoding(m);
  ok(buildStyleReport(m).rolesWithoutIcon.length === 0, "rolesWithoutIcon 为空");
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
