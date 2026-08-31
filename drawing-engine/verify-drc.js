/* DRC 引擎自测：用法 node verify-drc.js
   DRC 现在只查"图纸本身"：编码表完整性（legend）+ 命名规范（id/label）——
   不碰网络工程设计（HA/冗余/单点故障这类问题已经从 DRC 里移除，见 drc.js 头部注释）。
   三部分：① 样例拓扑本身命名/图例齐全，应该零发现满分；② 逐条构造最小反例，
   证明每条规则真能触发；③ 一个刻意搭好的干净拓扑同样应该零发现满分——防止
   引擎只会一路报警不会闭嘴。 */
const sampleModel = require("./topo-data.js");
const { runDRC } = require("./drc.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };
const has = (findings, rule, ...refs) =>
  findings.some(f => f.rule === rule && refs.every(r => f.refs.includes(r)));

function miniModel(devices, links, encodingOverrides) {
  const base = {
    deviceRoles: {
      core: { w: 80, h: 40, legend: "Core" },
      leaf: { w: 70, h: 36, legend: "Leaf" }
    },
    linkTypes: {
      normal: { stroke: "#000", width: 1, legend: "Link" }
    },
    connTypes: {}
  };
  const encoding = Object.assign({}, base, encodingOverrides || {});
  if (encodingOverrides) for (const k in encodingOverrides) encoding[k] = Object.assign({}, base[k], encodingOverrides[k]);
  return { meta: { name: "mini" }, encoding, devices, links };
}
function drcOf(model) { return runDRC(model); }

console.log("① 样例拓扑（图例/命名本身齐全，DRC 不再管网络工程设计，应零发现满分）");
{
  const r = drcOf(sampleModel);
  ok(r.findings.length === 0, `findings 为空（实际 ${r.findings.length} 条：${JSON.stringify(r.findings)}）`);
  ok(r.score === 100, `score=100（实际 ${r.score}）`);
}

console.log("② 逐条反例：证明每条规则会触发（不是摆设）");
{
  let r = drcOf(miniModel(
    [{ id: "A", role: "mystery", tier: 0, label: "A" }, { id: "B", role: "leaf", tier: 1, label: "B" }],
    [{ a: "A", b: "B", type: "normal" }]));
  ok(has(r.findings, "legend.role-missing", "mystery"), "legend.role-missing：用了编码表里没有的 role");

  r = drcOf(miniModel(
    [{ id: "A", role: "leaf", tier: 0, label: "A1" }, { id: "A", role: "leaf", tier: 1, label: "A2" }],
    []));
  ok(has(r.findings, "naming.duplicate-id", "A"), "naming.duplicate-id：两台设备同 id");

  r = drcOf(miniModel([{ id: "A", role: "leaf", tier: 0 }], []));
  ok(has(r.findings, "naming.missing-label", "A"), "naming.missing-label：设备无 label");
}

console.log("②b 合法的风格选择不该触发任何规则（label 重复 / legend 文案为空——本次讨论明确移除）");
{
  let r = drcOf(miniModel(
    [{ id: "A", role: "leaf", tier: 0, label: "X" }, { id: "B", role: "leaf", tier: 1, label: "X" }],
    []));
  ok(!has(r.findings, "naming.duplicate-label", "X"), "两台设备同 label 不再产生 naming.duplicate-label（合法的风格选择）");
  ok(r.findings.length === 0, `label 重复不影响 findings（实际 ${r.findings.length} 条：${JSON.stringify(r.findings)}）`);

  r = drcOf(miniModel(
    [{ id: "A", role: "core", tier: 0, label: "A" }, { id: "B", role: "leaf", tier: 1, label: "B" }],
    [{ a: "A", b: "B", type: "normal" }],
    { deviceRoles: { leaf: { legend: "" } } }));
  ok(!has(r.findings, "legend.role-empty", "leaf"), "legend 文案为空不再产生 legend.role-empty（合法的风格选择）");
  ok(r.findings.length === 0, `legend 为空不影响 findings（实际 ${r.findings.length} 条：${JSON.stringify(r.findings)}）`);
}

console.log("③ 干净拓扑：零发现、满分（引擎不会瞎报警）");
{
  const clean = miniModel(
    [
      { id: "R1", role: "leaf", tier: 0, label: "R1" },
      { id: "R2", role: "leaf", tier: 0, label: "R2" },
      { id: "C1", role: "core", tier: 1, label: "C1" },
      { id: "C2", role: "core", tier: 1, label: "C2" }
    ],
    [
      { a: "R1", b: "C1", type: "normal" }, { a: "R2", b: "C1", type: "normal" },
      { a: "R1", b: "C2", type: "normal" }, { a: "R2", b: "C2", type: "normal" }
    ]);
  const r = drcOf(clean);
  ok(r.findings.length === 0, `findings 为空（实际 ${r.findings.length} 条：${JSON.stringify(r.findings)}）`);
  ok(r.score === 100, `score=100（实际 ${r.score}）`);
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
