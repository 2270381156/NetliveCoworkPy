/* stdin/stdout JSON 桥接：给 Python capability provider 用子进程调用（走 stdio，不是 HTTP）。
   这条路径对应设计文档里"Python capability provider 拉起 Node 子进程"那个设想的最小实现。
   用法（模型从 stdin 读，或用 --model=<abs .topo.json> 从文件读；路径一律要绝对路径）：
     node cli.js draw --out=<abs .html> [--model=<abs .topo.json>] [--routing=direct]
         迭代期用。HTML 落盘给人看（单文件离线，双击可开），stdout 吐诊断给 agent 看：
         {path,bytes,score,findings,…,geometry,style,warnings}。两个受众一次调用。
     node cli.js export --format=svg|vsdx|pptx --out=<abs path> [--model=<abs .topo.json>] [--routing=…]
         确认后出成品。落盘，stdout 只吐 {path,bytes,format,warnings}，不回传文件内容。
   失败时 stdout 吐 {error, message}，进程 exit code 非 0；调用方按这两者一起判定成败，
   不要只看 exit code——JSON.parse 失败等场景仍会尽量把诊断信息写到 stdout。 */
"use strict";
const fs = require("fs");
const path = require("path");
const { computeLayout } = require("./topo.js");
const { runDRC } = require("./drc.js");
const { renderStandaloneHTML } = require("./render.js");
const { buildSVG } = require("./draw-core.js");
const { resolveIconsForModel } = require("./icons.js");
const { buildGeometryReport } = require("./geometry-report.js");
const { buildStyleReport } = require("./style-report.js");
const { SUPPORTED_LAYOUTS } = require("./regions.js");
const { buildVsdx } = require("./export-vsdx.js");
const { buildPptx } = require("./export-pptx.js");

// 极简 flag 解析：node cli.js <cmd> [--key=value …]
function parseFlags(argv) {
  const f = {};
  for (const a of argv.slice(3)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) f[m[1]] = m[2];
  }
  return f;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/* 模型来源二选一：stdin（调用方直接给 JSON）或 --model=<绝对路径>（读文件）。

   为什么要有文件这条路：模型是工具参数时，**它必须由模型逐字生成出来**，受单次输出
   token 上限约束——一张 48 台 leaf 的 spine-leaf 展开成 JSON 是上万 token，传不进去。
   而生成它的脚本可能只有几十行。走文件后，agent 可以拿 shell 写脚本直接产出
   .topo.json，那个大 JSON 从头到尾不经过模型输出，天花板就绕开了。

   返回 { text } 或 null（null 表示已 fail 过）。 */
async function readModelSource(flags) {
  if (!flags.model) return { text: await readStdin() };

  if (!path.isAbsolute(flags.model)) {
    fail("BAD_ARGS", `--model 必须是绝对路径，收到的是 "${flags.model}"。`
       + `引擎的工作目录不是你的工作目录，相对路径会解析到引擎安装位置去。`);
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(flags.model, "utf8");
  } catch (e) {
    // 分开报：文件读不到和 JSON 语法错是两类问题，糊成一个错误码会让调用方查错方向跑偏
    fail("MODEL_FILE_UNREADABLE", `读不到模型文件 ${flags.model}：${e.message || e}`);
    return null;
  }
  // 剥掉 UTF-8 BOM。走 stdin 时碰不到（provider 用 json.dumps().encode("utf-8")，不产 BOM），
  // 但文件是别人写的——记事本、PowerShell 的 Out-File、不少 Windows 工具默认都带 BOM，
  // 而 JSON.parse 见到 ﻿ 直接语法错，报出来的是"Unexpected token"，看不出真正原因。
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return { text: raw };
}

function fail(code, message) {
  process.stdout.write(JSON.stringify({ error: code, message: String(message) }));
  process.exitCode = 1;
}

// 返回 null 表示已经 fail() 过，调用方直接 return。
function parseModel(input) {
  let model;
  try {
    model = JSON.parse(input);
  } catch (e) {
    fail("INVALID_JSON", e.message || e);
    return null;
  }
  if (!model || !Array.isArray(model.devices) || !Array.isArray(model.links)) {
    fail("INVALID_MODEL", "model 必须含 devices[] 和 links[]");
    return null;
  }
  return model;
}

// routing 是对外唯一的走线选项：regions.js 重构后两个引擎的节点坐标已完全一致，
// 唯一区别只剩走线（direct=端口锚点直线 / orthogonal=libavoid 正交折线），
// 所以不再对外暴露"引擎"这个概念。
// elk 是 ESM + WASM，只能动态 import（跟 serve.js 里同样的桥接方式）。
//
// 优先级：代码默认(orthogonal) < 模型里的 meta.routing < 调用方显式传的 --routing。
// 跟 meta.rowGap/opts 那套是同一个形状,理由也一样：**作者的决定要能被记住**——用户说
// "这张图用直线"，写进 meta.routing 就能跟着模型走、下次重新渲染还在；只写成调用参数的话
// 那个决定只活在那一次调用里，重新渲染又退回默认值。调用方显式传的作为临时覆盖，不写回模型。
// 2026-07-28 起只开放 direct。orthogonal（libavoid 正交避障）的引擎代码仍在
// geometry-elk.mjs 里、也仍然可用，但产出还不达标：实测多条线汇聚同一设备时会共线重叠
// （spine-leaf 7 处 275px、datacenter 10 处 261px），肉眼看就是几根线叠在一起分不清。
// 已经验证过的修复是"同一条边上有多条线时把端口沿边分散"（实测降到 0~4px、零退化），
// 但那要连同回归测试一起落地，本轮先关掉这条路，等修复进来再开。
// 关掉的方式是入口校验拒绝，不是删代码——引擎和依赖都留着，恢复只需改这里。
const DEFAULT_ROUTING = "direct";
const OPEN_ROUTINGS = { direct: true };
const CLOSED_ROUTINGS = { orthogonal: "正交避障走线暂未开放（多线汇聚时会共线重叠，修复中）" };
function resolveRouting(model, explicit) {
  if (explicit != null) return explicit;
  const meta = (model && model.meta) || {};
  return meta.routing != null ? meta.routing : DEFAULT_ROUTING;
}

// 走线方式是"作者化决定"（SOUL.md）：写进 meta.routing 才跟着模型走。但调用方可以用
// routing 参数临时覆盖，这时导出的图跟模型自己声称的走线方式就不一致了——图是直线、模型
// 说自己是正交，下次不带参数重新渲染会悄悄变回折线。
// 真实 agent 就这么干过一次（2026-07-27）：按用户要求改成直线导出了，但没回写 meta.routing。
// 被问到时它解释得比 SOUL.md 还清楚，可见不是没看懂——是没有任何东西在"这件事正在发生"
// 的那一刻提醒它。跟图标那个问题同一个教训：没有反馈信号的地方就是盲区。
function routingWarnings(model, explicit) {
  if (explicit == null) return []; // 没覆盖，模型说了算，不存在不一致
  const declared = (model && model.meta && model.meta.routing) || null;
  if (declared === explicit) return [];
  return [{
    code: "ROUTING_NOT_PERSISTED",
    message: declared == null
      ? `本次用 routing="${explicit}" 出图，但模型里没有设 meta.routing——这个决定没被记住，`
        + `下次不带 routing 参数重新渲染会回退到默认的 "${DEFAULT_ROUTING}"。`
        + `要让它跟着模型走，把 meta.routing 设成 "${explicit}"。`
      : `本次用 routing="${explicit}" 出图，但模型 meta.routing 写的是 "${declared}"——`
        + `图和模型不一致，下次不带 routing 参数重新渲染会变回 "${declared}"。`
        + `要让这个决定跟着模型走，把 meta.routing 改成 "${explicit}"。`,
  }];
}

// 相对路径会按 Node 子进程的 cwd 解析，而 Python provider 是用 cwd=引擎目录 起的进程
// （provider.py 的 _run_node_cli），于是 --out=foo.svg 会把文件写进**应用自己的安装目录**。
// 真实 agent 踩过（2026-07-27）：工具返回成功、字节数也对，用户在工作区里却找不到文件，
// 而安装目录被污染、下次升级就没了。宁可明确报错让调用方给绝对路径。
function absPathHint(got) {
  return `--out 必须是绝对路径，收到的是相对路径 "${got}"。`
       + `相对路径会写进引擎安装目录而不是你的工作目录，文件会找不到。`;
}

// zone 的 layout 写了不支持的值（最常见的是环形组网写 layout:"ring"）是参数问题，不是
// 计算失败。不单独校验的话会落进 computeGeometry 的 catch 报成 LAYOUT_FAILED，跟"布局真的
// 算不出来"混为一谈；而且默认的报错只说"未知的 layout"，不告诉作者当前有哪些可选、
// 环形这类需求该怎么办。
function badLayout(model) {
  for (const z of (model && model.zones) || []) {
    const l = z.layout;
    if (l == null || SUPPORTED_LAYOUTS.includes(l)) continue;
    return `zone "${z.id}" 声明了不支持的 layout: "${l}"（当前可选：${SUPPORTED_LAYOUTS.join("|")}）。`
         + `环形/放射状组网（ring、radial 之类）当前表达不了——不要用 row/column 硬凑成近似形状，`
         + `如实告诉用户这是当前模型的表达力缺口。`;
  }
  return null;
}

async function computeGeometry(model, routing) {
  const icons = resolveIconsForModel(model);
  if (routing === "direct") {
    return { layout: computeLayout(model, { icons }), icons };
  }
  const { computeElkLayout } = await import("./geometry-elk.mjs");
  return { layout: await computeElkLayout(model, { icons }), icons };
}

// routing 的合法性单独校验、单独报 BAD_ARGS：computeGeometry 的调用点都包在
// LAYOUT_FAILED 的 catch 里，参数拼错混进"布局算失败"会让按 error 码分支的调用方误判。
// 参数问题和计算问题是两类错误，错误码要分开。
function badRouting(routing, where) {
  if (routing == null || OPEN_ROUTINGS[routing]) return null;
  const from = where ? `——来自 ${where}` : "";
  if (CLOSED_ROUTINGS[routing]) {
    return `routing "${routing}" ${CLOSED_ROUTINGS[routing]}。当前只支持 direct（两点直线）${from}`;
  }
  return `未知的 routing: "${routing}"（当前可选：${Object.keys(OPEN_ROUTINGS).join("|")}）${from}`;
}

// draw = 出预览 + 出诊断，一次调用服务两个受众：人看落盘的 HTML，agent 读返回的诊断。
//
// 合并自原来的 observe + render（2026-07-28）。分开时有两个问题：
//   1. render 把几十万字符的 HTML 当返回值给 agent，agent 拿到又立刻转存成文件——绕一圈还是
//      写文件。真实跑动中 163KB 触发 spill 落到 tool_outputs/，agent 只好用 Copy-Item 搬运，
//      弹出权限审批。这是设计导致的必然，不是意外。
//   2. agent 在诊断循环里只调 observe，人全程看不到它画成什么样。留一个"只诊断不出图"的入口，
//      agent 就会一直走它（本项目反复验证过：agent 只做被信号驱动的事），所以 observe 不保留。
//
// 代价：每轮迭代多跑一次走线（281ms vs 173ms）+ 写一个 HTML（同路径覆盖）。相比一个 LLM 往返
// 可忽略。收益是诊断与产物同源——agent 读到的测量描述的就是人正在看的那张图。
async function cmdDraw(flags) {
  if (!flags.out) return fail("BAD_ARGS", "缺少 --out=<预览 HTML 的输出路径>");
  if (!path.isAbsolute(flags.out)) return fail("BAD_ARGS", absPathHint(flags.out));
  const flagErr = badRouting(flags.routing, "--routing");
  if (flagErr) return fail("BAD_ARGS", flagErr);

  const src = await readModelSource(flags);
  if (!src) return;
  const model = parseModel(src.text);
  if (!model) return;
  // 快照原始模型：computeGeometry 会经 normalizeEncoding() 把派生的 fill/stroke 写回 model，
  // 而 HTML 里嵌的模型是给"下次基于这份 HTML 继续改"用的存档。嵌补全后的版本会让往返不幂等——
  // 本来"没写颜色、由引擎自动配"的角色变成"显式指定了颜色"，之后加新角色时自动配色看到的
  // 已占用槽位就不一样了，配色结果会跟第一次不同。
  const pristine = JSON.parse(JSON.stringify(model));

  const routing = resolveRouting(model, flags.routing);
  const metaErr = badRouting(routing, "模型的 meta.routing");
  if (metaErr) return fail("BAD_ARGS", metaErr);
  const layoutErr = badLayout(model);
  if (layoutErr) return fail("BAD_ARGS", layoutErr);

  let geo;
  try {
    geo = await computeGeometry(model, routing);
  } catch (e) {
    return fail("LAYOUT_FAILED", e.message || e);
  }

  let drc;
  try {
    drc = runDRC(model);
  } catch (e) {
    return fail("DRC_FAILED", e.message || e);
  }

  let bytes;
  try {
    const svg = buildSVG(model, geo.layout, geo.icons);
    const html = renderStandaloneHTML(pristine, geo.layout, svg);
    fs.writeFileSync(flags.out, html, "utf8");
    bytes = Buffer.byteLength(html, "utf8");
  } catch (e) {
    return fail("RENDER_FAILED", e.message || e);
  }

  const tierCounts = {};
  for (const id in geo.layout.nodes) {
    const t = geo.layout.nodes[id].tier;
    tierCounts[t] = (tierCounts[t] || 0) + 1;
  }

  process.stdout.write(JSON.stringify({
    path: flags.out,
    bytes,
    score: drc.score,
    findings: drc.findings,
    deviceCount: model.devices.length,
    linkCount: model.links.length,
    zoneCount: (model.zones || []).length,
    tierCounts,
    bbox: geo.layout.bbox,
    geometry: buildGeometryReport(model, geo.layout),
    // 必须在 computeGeometry 之后取：normalizeEncoding() 在布局阶段才把缺省颜色补进 encoding，
    // 提前调用会把所有角色都算成"撞色"（全是 undefined|undefined）。
    style: buildStyleReport(model),
    warnings: routingWarnings(model, flags.routing),
  }));
}

// export 由 Node 直接落盘、只回传路径——二进制格式（PNG/PDF/vsdx，二三期）塞不进 stdout 的
// JSON，base64 后经 agent 上下文更是灾难。svg 虽是文本，也走同一条路径保持契约统一。
const EXPORT_FORMATS = { svg: true, vsdx: true, pptx: true };
const PLANNED_FORMATS = { png: "二期", pdf: "二期" };

async function cmdExport(flags) {
  const format = flags.format;
  if (!format) return fail("BAD_ARGS", `缺少 --format=<${Object.keys(EXPORT_FORMATS).join("|")}>`);
  if (!EXPORT_FORMATS[format]) {
    const when = PLANNED_FORMATS[format];
    return fail("UNSUPPORTED_FORMAT",
      when ? `format "${format}" 计划在${when}实现，当前版本不支持` : `未知 format: "${format}"`);
  }
  if (!flags.out) return fail("BAD_ARGS", "缺少 --out=<输出文件路径>");
  if (!path.isAbsolute(flags.out)) return fail("BAD_ARGS", absPathHint(flags.out));
  const flagErr = badRouting(flags.routing, "--routing");
  if (flagErr) return fail("BAD_ARGS", flagErr);

  const src = await readModelSource(flags);
  if (!src) return;
  const model = parseModel(src.text);
  if (!model) return;
  const routing = resolveRouting(model, flags.routing);
  const metaErr = badRouting(routing, "模型的 meta.routing");
  if (metaErr) return fail("BAD_ARGS", metaErr);
  const layoutErr = badLayout(model);
  if (layoutErr) return fail("BAD_ARGS", layoutErr);

  let geo;
  try {
    geo = await computeGeometry(model, routing);
  } catch (e) {
    return fail("LAYOUT_FAILED", e.message || e);
  }

  let bytes;
  const exportWarnings = [];
  try {
    if (format === "pptx") {
      // pptx 与 vsdx 同为 OPC 包、同样旁路 SVG，但画布是**固定 16:9**：幻灯片要塞进汇报
      // 材料，按内容大小生成一张比例奇怪的片子是废的。见 export-pptx.js 文件头。
      const r = buildPptx(model, geo.layout, { warnings: exportWarnings });
      fs.writeFileSync(flags.out, r.buf);
      bytes = r.buf.length;
    } else if (format === "vsdx") {
      // vsdx 走旁路：从几何+语义直生成 Shape/Connector，不经过 SVG。理由见 export-vsdx.js
      // 文件头——从 SVG 转会丢语义，产出的形状不是"设备"、连线不是"连接器"，拖动设备时
      // 连线不跟随，跟"真正可编辑"的要求直接冲突。
      // warnings 必须收：图标转换失败会静默降级成纯色方框，不报出来的话看图的人
      // 分不清"这台设备本来就没配图标"和"图标转换出错了"。
      const buf = buildVsdx(model, geo.layout, { warnings: exportWarnings });
      fs.writeFileSync(flags.out, buf);
      bytes = buf.length;
    } else {
      const svg = buildSVG(model, geo.layout, geo.icons);
      fs.writeFileSync(flags.out, svg, "utf8");
      bytes = Buffer.byteLength(svg, "utf8");
    }
  } catch (e) {
    return fail("EXPORT_FAILED", e.message || e);
  }

  process.stdout.write(JSON.stringify({
    path: flags.out, bytes, format,
    warnings: routingWarnings(model, flags.routing).concat(exportWarnings),
  }));
}

async function main() {
  const cmd = process.argv[2];
  const flags = parseFlags(process.argv);
  if (cmd === "draw") {
    await cmdDraw(flags);
  } else if (cmd === "export") {
    await cmdExport(flags);
  } else {
    process.stderr.write(
      "usage: node cli.js draw --out=<abs .html> [--routing=orthogonal|direct] < topology.json\n" +
      "       node cli.js export --format=svg --out=<abs path> [--routing=…] < topology.json\n");
    process.exitCode = 2;
  }
}

main().catch((e) => fail("INTERNAL_ERROR", (e && e.message) || e));
