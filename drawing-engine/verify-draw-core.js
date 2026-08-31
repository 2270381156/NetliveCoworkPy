/* node 自测：draw-core.js 产出的 SVG 结构与自包含性。用法： node verify-draw-core.js */
const { buildSVG } = require("./draw-core.js");
const { computeLayout } = require("./topo.js");
const { resolveIconsForModel } = require("./icons.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

const model = require("./topo-data.js");
const icons = resolveIconsForModel(model);
const svg = buildSVG(model, computeLayout(model, { icons }), icons);

console.log("① 基本结构");
ok(svg.startsWith("<svg "), "以 <svg 开头");
ok(svg.trimEnd().endsWith("</svg>"), "以 </svg> 结尾");
ok(svg.includes("<style>"), "含内部 <style>（导出的 .svg 单独打开也有样式）");
ok(/viewBox="[-\d.]+ [-\d.]+ [\d.]+ [\d.]+"/.test(svg), "viewBox 格式正确");

console.log("② 自包含：没有任何外部引用、没有未定义的 CSS 变量");
ok(!svg.includes("var(--"), "不含 var(--…)——CSS 变量在单独打开的 .svg 里没有定义，会让文字变黑/消失");
{
  // 允许 xmlns 的 w3.org 命名空间；图标是 data: URI；其余 http(s) 引用都算外部依赖
  const externals = (svg.match(/https?:\/\/[^"']+/g) || []).filter(u => !u.includes("www.w3.org"));
  ok(externals.length === 0, `无外部 http(s) 引用（实际 ${JSON.stringify(externals)}）`);
}

console.log("③ 内容覆盖：设备/链路/zone/图例都画了");
{
  const realDevices = model.devices.filter(d => !(model.encoding.deviceRoles[d.role] || {}).decorative);
  // 每台非装饰设备至少产出一个 label 文本
  for (const d of realDevices.slice(0, 3)) {
    ok(svg.includes(">" + d.label + "<"), `设备 ${d.id} 的 label "${d.label}" 出现在 SVG 里`);
  }
  ok((svg.match(/stroke-dasharray="7,5"/g) || []).length === model.zones.length,
    `zone 虚线框数量 = ${model.zones.length}`);
  ok(svg.includes("class=\"devlabel\""), "设备文字带 devlabel 类");
}

console.log("④ XML 转义：label 里的 & < > 不会破坏 SVG");
{
  const m = JSON.parse(JSON.stringify(model));
  m.devices[0].label = 'A&B <test> "q"';
  const s2 = buildSVG(m, computeLayout(m, { icons }), icons);
  ok(s2.includes("A&amp;B &lt;test&gt;"), "特殊字符被正确转义");
  ok(!s2.includes("<test>"), "没有产生非法标签");
}

console.log("⑤ 空值属性不写成字面量 undefined");
ok(!svg.includes("undefined"), "SVG 里不含 undefined（原 DOM 版缺字段时会写出 undefined 属性）");

// 下面三节覆盖样例 topo-data.js 走不到的分支。评审指出：这个 fixture 每个角色都有 icon，
// 所以"无图标"那条路径(cloud/纯色框/纯色 swatch)从没被跑过——⑤ 那条 undefined 断言因此
// 也是虚的。把当初只做过一次的人工核查固化成永久断言。
console.log("⑥ 无图标路径：cloud 画椭圆、swatch 走纯色分支（fixture 每个角色都有 icon，需去掉才走得到）");
{
  const m = JSON.parse(JSON.stringify(model));
  for (const r of Object.values(m.encoding.deviceRoles)) delete r.icon;
  m.encoding.deviceRoles.internet.glyph = "cloud";
  const s2 = buildSVG(m, computeLayout(m, {}), {});
  ok((s2.match(/<ellipse/g) || []).length >= 1, `glyph:"cloud" 画出 <ellipse>（实际 ${(s2.match(/<ellipse/g) || []).length} 个）`);
  ok(!s2.includes("<image"), "没有图标时不产出 <image>");
  ok(!s2.includes("undefined"), "无图标路径同样不产出 undefined（这才让 ⑤ 那条断言有牙齿）");
  ok(!s2.includes("var(--"), "无图标路径也不含 CSS 变量");
}

console.log("⑥b 导出物自带白底（查看器是深色模式时不能让深色文字糊在深底上）");
{
  // 只有真正在深色模式浏览器里打开导出的 .svg 才会发现的问题：SVG 不带背景时用查看器的
  // 底色，#2b3542 的设备文字落在深底上几乎读不出来。此前所有断言（自包含/无 var(--)/
  // 图标 data URI/元素数）都过，因为它们查的是"内容对不对"，没查"读不读得清"。
  const m = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  const [, vx, vy, vw, vh] = m;
  const bgRe = new RegExp('<rect x="' + vx + '" y="' + vy + '" width="' + vw + '" height="' + vh + '"[^>]*fill="#ffffff"');
  ok(bgRe.test(svg), "存在铺满 viewBox 的白色背景矩形");
  ok(svg.indexOf("#ffffff") < svg.indexOf('<g id="world"'), "背景在 world 组之前（画在最底层，不遮内容）");
}

console.log("⑦ 标签配对（字符串拼接不像 DOM 那样天然保证闭合，必须显式验）");
ok(wellFormed(svg), "hand 版 SVG 标签配对良好");

// elk 是 ESM + WASM，只能异步 import，所以放在最后单独跑，跑完再统一收尾。
console.log("⑧ elk 正交走线的 route 折线分支");
(async () => {
  const { computeElkLayout } = await import("./geometry-elk.mjs");
  const elkLayout = await computeElkLayout(model, { icons });
  const s3 = buildSVG(model, elkLayout, icons);
  ok((s3.match(/<polyline/g) || []).length > 0,
    `elk 布局产出 <polyline> 折线（实际 ${(s3.match(/<polyline/g) || []).length} 条）`);
  ok(wellFormed(s3), "elk 版 SVG 标签配对良好");
  finish();
})();

// 极简标签栈检查：只认自闭合 />、开标签、闭标签三种，够用来发现 <g> 这类容器漏闭合。
function wellFormed(s) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) { if (stack.pop() !== m[2]) return false; }
    else if (!m[3]) stack.push(m[2]);
  }
  return stack.length === 0;
}

function finish() {
  console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
  process.exit(fail ? 1 : 0);
}
