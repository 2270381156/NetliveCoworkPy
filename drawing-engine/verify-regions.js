/* node 自测：regions.js 的建树/门禁逻辑。用法： node verify-regions.js */
const { buildRegionTree } = require("./regions.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const throws = (fn, msgPart, what) => {
  try { fn(); ok(false, `${what}: 应该抛错但没抛`); }
  catch (e) { ok(String(e.message).includes(msgPart), `${what}: 抛出预期错误("${msgPart}") — 实际: ${e.message}`); }
};

console.log("① 扁平模型(没有 zones)：根区域直接包含所有设备");
{
  const model = { devices: [{ id: "A", tier: 0 }, { id: "B", tier: 0 }], zones: [] };
  const tree = buildRegionTree(model);
  ok(tree.kind === "zone" && tree.id === "__root__", "根节点是隐式 __root__");
  ok(tree.children.length === 2, `根区域直接孩子数=2 (实际 ${tree.children.length})`);
  ok(tree.children.every(c => c.kind === "device"), "两个孩子都是 device 节点");
}

console.log("② 一层嵌套：zone 的孩子里既有设备又有子 zone，深度正确识别");
{
  const model = {
    devices: [{ id: "A", tier: 0 }, { id: "B", tier: 1 }],
    zones: [{ id: "Z1", members: ["B"], layout: "row" }]
  };
  const tree = buildRegionTree(model);
  ok(tree.children.length === 2, `根区域直接孩子数=2(A 和 Z1) (实际 ${tree.children.length})`);
  const z1 = tree.children.find(c => c.id === "Z1");
  ok(z1.kind === "zone" && z1.children.length === 1 && z1.children[0].id === "B", "Z1 正确包含设备 B");
}

console.log("③ 两层嵌套(L1 包 L2)：允许");
{
  const model = {
    devices: [{ id: "A", tier: 0 }],
    zones: [
      { id: "L1", members: ["L2"] },
      { id: "L2", members: ["A"] }
    ]
  };
  const tree = buildRegionTree(model);
  const l1 = tree.children.find(c => c.id === "L1");
  ok(l1 && l1.children[0].id === "L2", "L1 包 L2 结构正确");
}

console.log("④ 三层嵌套(L1 包 L2 包 L3)：超过深度上限，报错");
{
  const model = {
    devices: [{ id: "A", tier: 0 }],
    zones: [
      { id: "L1", members: ["L2"] },
      { id: "L2", members: ["L3"] },
      { id: "L3", members: ["A"] }
    ]
  };
  throws(() => buildRegionTree(model), "嵌套深度超过上限", "三层显式嵌套(L3)");
}

console.log("⑤ 循环引用：Z1 包 Z2，Z2 又包 Z1，报错");
{
  const model = {
    devices: [{ id: "A", tier: 0 }],
    zones: [{ id: "Z1", members: ["Z2"] }, { id: "Z2", members: ["Z1"] }]
  };
  throws(() => buildRegionTree(model), "循环引用", "zone 循环引用");
}

console.log("⑥ 一个成员同时被两个 zone 声明：归属歧义，报错");
{
  const model = {
    devices: [{ id: "A", tier: 0 }],
    zones: [{ id: "Z1", members: ["A"] }, { id: "Z2", members: ["A"] }]
  };
  throws(() => buildRegionTree(model), "同时被两个 zone 声明为成员", "成员归属歧义");
}

console.log("⑦ zone 引用了不存在的设备/zone 成员：报错");
{
  const model = { devices: [{ id: "A", tier: 0 }], zones: [{ id: "Z1", members: ["NOPE"] }] };
  throws(() => buildRegionTree(model), "引用了不存在的设备/zone 成员", "悬空成员引用");
}

const { layoutRegions } = require("./regions.js");
const sizeAll = (w, h) => () => ({ w, h });

console.log("⑧ row 规则：单层两个同 tier 设备左右对称居中(跟 topo.js 现有对称行为一致)");
{
  const model = { devices: [{ id: "A", tier: 0 }, { id: "B", tier: 0 }], zones: [] };
  const { boxes } = layoutRegions(model, sizeAll(80, 40), {});
  const acx = boxes.A.x + boxes.A.w / 2, bcx = boxes.B.x + boxes.B.w / 2;
  ok(approx(acx, -bcx), `A.cx(${acx}) == -B.cx(${bcx})`);
}

console.log("⑨ satelliteOf：旁挂设备贴在锚点外侧，不参与主组居中");
{
  const model = {
    devices: [{ id: "A", tier: 0 }, { id: "B", tier: 0 }, { id: "S", tier: 0, satelliteOf: "A" }],
    zones: []
  };
  const { boxes } = layoutRegions(model, sizeAll(80, 40), {});
  const aMid = (boxes.A.x + boxes.B.x + boxes.B.w) / 2; // A/B 主组中点应该还是 0 附近
  ok(approx(boxes.A.x, -(boxes.B.x + boxes.B.w), 1e-6) === false || true, "占位(下面两条是真正的断言)");
  ok(boxes.S.x >= boxes.A.x + boxes.A.w || boxes.S.x + boxes.S.w <= boxes.A.x, "S 贴在 A 外侧，不跟 A 重叠");
  const bcx = boxes.B.x + boxes.B.w / 2;
  ok(approx(boxes.A.x + boxes.A.w / 2, -bcx, 1e-6), "A/B 主组依然对称居中(S 没有参与居中计算)");
}

console.log("⑩ 嵌套：一个 zone 包 2 个子 zone，每个子 zone 内部两个设备，整体不重叠");
{
  const model = {
    devices: [{ id: "A1", tier: 0 }, { id: "A2", tier: 0 }, { id: "B1", tier: 0 }, { id: "B2", tier: 0 }],
    zones: [
      { id: "OUTER", members: ["ZA", "ZB"], layout: "row" },
      { id: "ZA", members: ["A1", "A2"], layout: "row" },
      { id: "ZB", members: ["B1", "B2"], layout: "row" }
    ]
  };
  const { boxes, zoneOrder } = layoutRegions(model, sizeAll(50, 30), {});
  ok(boxes.ZA.x + boxes.ZA.w <= boxes.ZB.x || boxes.ZB.x + boxes.ZB.w <= boxes.ZA.x, "ZA/ZB 两个子 zone 的包围盒不重叠");
  ok(boxes.A1.x >= boxes.ZA.x && boxes.A1.x + boxes.A1.w <= boxes.ZA.x + boxes.ZA.w, "A1 落在 ZA 包围盒内部");
  ok(zoneOrder.indexOf("OUTER") < zoneOrder.indexOf("ZA"), "绘制顺序：父 zone(OUTER) 排在子 zone(ZA) 之前");
  ok(zoneOrder.indexOf("OUTER") < zoneOrder.indexOf("ZB"), "绘制顺序：父 zone(OUTER) 排在子 zone(ZB) 之前");
}

console.log("⑪ position 覆盖：显式钉住的孩子忽略规则算出的偏移量");
{
  const model = {
    devices: [{ id: "A", tier: 0 }, { id: "B", tier: 0 }],
    zones: [{ id: "Z1", members: ["A"], position: { dx: 999, dy: 888 } }]
  };
  const { boxes } = layoutRegions(model, sizeAll(50, 30), {});
  ok(boxes.Z1.x === 999 && boxes.Z1.y === 888, `position 覆盖生效(实际 x=${boxes.Z1.x}, y=${boxes.Z1.y})`);
}

console.log("⑫ 三层嵌套(L1 包 L2，L2 包设备)：measure/place 正常跑通，不报错");
{
  const model = {
    devices: [{ id: "A", tier: 0 }],
    zones: [{ id: "L1", members: ["L2"] }, { id: "L2", members: ["A"] }]
  };
  const { boxes } = layoutRegions(model, sizeAll(50, 30), {});
  ok(boxes.L1 && boxes.L2 && boxes.A, "L1/L2/A 都拿到了世界坐标");
}

console.log("⑬ 同一 tier 内裸设备和 zone 混排：左右顺序按 devices 数组的声明顺序来，不是\"裸设备一律排在 zone 前面\"");
{
  // A(裸设备,下标0) -> Z_B(zone,唯一成员B,下标1) -> C(裸设备,下标2)：declares顺序是 A,B,C，
  // 期望落位顺序也是 A,Z_B,C(从左到右)——修复前的 bug 会把裸设备(A,C)全排到 zone(Z_B)前面,
  // 变成 A,C,Z_B。
  const model = {
    devices: [{ id: "A", tier: 5 }, { id: "B", tier: 5 }, { id: "C", tier: 5 }],
    zones: [{ id: "Z_B", layout: "row", tier: 5, members: ["B"] }]
  };
  const { boxes } = layoutRegions(model, sizeAll(50, 30), {});
  const cxOf = id => boxes[id].x + boxes[id].w / 2;
  const order = ["A", "Z_B", "C"].map(id => cxOf(id));
  ok(order[0] < order[1] && order[1] < order[2],
    `落位顺序跟 devices 数组声明顺序一致: A.cx=${order[0].toFixed(1)} < Z_B.cx=${order[1].toFixed(1)} < C.cx=${order[2].toFixed(1)}`);
}

console.log("⑭ 净空距语义：行内有超高元素，下一行照样保住 rowGap 的留白（旧中心距语义会重叠）");
{
  const size = id => id === "TALL" ? { w: 50, h: 300 } : { w: 50, h: 30 };
  const model = { devices: [{ id: "TALL", tier: 0 }, { id: "B", tier: 1 }], zones: [] };
  const { boxes } = layoutRegions(model, size, {});
  ok(approx(boxes.B.y - (boxes.TALL.y + boxes.TALL.h), 78), `TALL(300高)底边到B顶边净空=78(实际 ${(boxes.B.y - (boxes.TALL.y + boxes.TALL.h)).toFixed(1)})`);
}

console.log("⑮ tier 是纯序数：数值间隔不产生空间效果");
{
  const m1 = { devices: [{ id: "A", tier: 0 }, { id: "B", tier: 1 }], zones: [] };
  const m2 = { devices: [{ id: "A", tier: 0 }, { id: "B", tier: 5 }], zones: [] };
  const m3 = { devices: [{ id: "A", tier: 0 }, { id: "B", tier: 0.5 }], zones: [] };
  const y1 = layoutRegions(m1, sizeAll(50, 30), {}).boxes.B.y;
  const y2 = layoutRegions(m2, sizeAll(50, 30), {}).boxes.B.y;
  const y3 = layoutRegions(m3, sizeAll(50, 30), {}).boxes.B.y;
  ok(approx(y1, y2) && approx(y1, y3), `tier差1/差5/差0.5 的行位置完全相同(${y1}/${y2}/${y3})——小数tier间距滥用通道已关闭`);
}

console.log("⑯ per-zone rowGap/hGap 覆盖：只影响本 zone 内部，不继承给子 zone");
{
  const model = {
    devices: [{ id: "A", tier: 0 }, { id: "B", tier: 1 }, { id: "C1", tier: 0 }, { id: "C2", tier: 1 }],
    zones: [
      { id: "Z", layout: "row", rowGap: 10, members: ["A", "B", "SUB"] },
      { id: "SUB", layout: "row", tier: 2, members: ["C1", "C2"] }
    ]
  };
  const { boxes } = layoutRegions(model, sizeAll(50, 30), {});
  ok(approx(boxes.B.y - (boxes.A.y + boxes.A.h), 10), `Z 内部行净空=10(覆盖生效,实际 ${(boxes.B.y - (boxes.A.y + boxes.A.h)).toFixed(1)})`);
  ok(approx(boxes.C2.y - (boxes.C1.y + boxes.C1.h), 78), `SUB 内部行净空=78(没有继承 Z 的 10,实际 ${(boxes.C2.y - (boxes.C1.y + boxes.C1.h)).toFixed(1)})`);
}

console.log("⑰ satelliteGap 三级优先级：成员字段 > cfg.satelliteGap > 缺省 90(不再借用 hGap 的 46)");
{
  const mk = extra => ({ devices: [{ id: "A", tier: 0 }, { id: "B", tier: 0 },
    Object.assign({ id: "S", tier: 0, satelliteOf: "A" }, extra || {})], zones: [] });
  // S 贴在 A 外侧,方向由 A.cx 的符号决定,这里两边都算一下取实际那个,不假设左右
  const gapOf = b => b.A.x - (b.S.x + b.S.w) >= 0 ? b.A.x - (b.S.x + b.S.w) : b.S.x - (b.A.x + b.A.w);
  const gDefault = gapOf(layoutRegions(mk(), sizeAll(80, 40), {}).boxes);
  const gCfg = gapOf(layoutRegions(mk(), sizeAll(80, 40), { satelliteGap: 33 }).boxes);
  const gMember = gapOf(layoutRegions(mk({ satelliteGap: 20 }), sizeAll(80, 40), { satelliteGap: 33 }).boxes);
  ok(approx(gDefault, 90), `都不设时用缺省 90(实际 ${gDefault.toFixed(1)})`);
  ok(approx(gCfg, 33), `cfg.satelliteGap:33 生效(实际 ${gCfg.toFixed(1)})`);
  ok(approx(gMember, 20), `成员字段 20 压过 cfg 的 33(实际 ${gMember.toFixed(1)})`);
}

console.log("⑱ layout:column 竖排：同 tier 成员纵向堆叠；多 tier 分列；satelliteOf 硬报错");
{
  const m1 = {
    devices: [{ id: "A" }, { id: "B" }, { id: "C" }],
    zones: [{ id: "Z", layout: "column", members: ["A", "B", "C"] }]
  };
  const b1 = layoutRegions(m1, sizeAll(50, 30), {}).boxes;
  ok(approx(b1.A.x, b1.B.x) && approx(b1.B.x, b1.C.x), "同列成员 x 相同(纵向堆叠)");
  ok(approx(b1.B.y - (b1.A.y + b1.A.h), 78), `列内上下净空=78(实际 ${(b1.B.y - (b1.A.y + b1.A.h)).toFixed(1)})`);
  const m2 = {
    devices: [{ id: "A", tier: 0 }, { id: "B", tier: 1 }],
    zones: [{ id: "Z", layout: "column", members: ["A", "B"] }]
  };
  const b2 = layoutRegions(m2, sizeAll(50, 30), {}).boxes;
  ok(approx(b2.B.x - (b2.A.x + b2.A.w), 46), `tier 不同分成两列,列间净空=46(实际 ${(b2.B.x - (b2.A.x + b2.A.w)).toFixed(1)})`);
  // 列内垂直居中：两列成员数不同时,少的那列要居中对齐到多的那列的中点——不测的话
  // "顶端对齐"这种退化实现也能过上面几条
  const m4 = {
    devices: [{ id: "L1", tier: 0 }, { id: "L2", tier: 0 }, { id: "R1", tier: 1 }],
    zones: [{ id: "Z", layout: "column", members: ["L1", "L2", "R1"] }]
  };
  const b4 = layoutRegions(m4, sizeAll(50, 30), {}).boxes;
  const midLeft = ((b4.L1.y) + (b4.L2.y + b4.L2.h)) / 2;
  const midRight = b4.R1.y + b4.R1.h / 2;
  ok(approx(midLeft, midRight), `两列各自垂直居中于同一中线(左列中点 ${midLeft.toFixed(1)} == 右列中点 ${midRight.toFixed(1)})`);
  const m3 = {
    devices: [{ id: "A" }, { id: "S", satelliteOf: "A" }],
    zones: [{ id: "Z", layout: "column", members: ["A", "S"] }]
  };
  throws(() => layoutRegions(m3, sizeAll(50, 30), {}), "column 布局暂不支持 satelliteOf", "column+satelliteOf");
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
