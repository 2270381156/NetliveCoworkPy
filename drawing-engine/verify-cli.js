/* cli.js 自测：验证 stdin/stdout JSON 桥接协议本身（Python 子进程调用走的就是这条路）。
   用法：node verify-cli.js */
const { spawnSync } = require("child_process");
const path = require("path");
const fsMod = require("fs");
const os = require("os");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

// draw 取代了原来的 observe：诊断和预览是同一次调用的两个产出（2026-07-28 合并）。
// 所以这里每次都要给一个 --out；测试只关心 stdout 的诊断，HTML 落到临时目录即可。
const DRAW_OUT = path.join(os.tmpdir(), "verify-cli-draw.html");
function runDraw(inputObj, extra) {
  const args = [path.join(__dirname, "cli.js"), "draw", `--out=${DRAW_OUT}`].concat(extra || []);
  const r = spawnSync(process.execPath, args, {
    input: typeof inputObj === "string" ? inputObj : JSON.stringify(inputObj),
    encoding: "utf8",
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* leave null，交给调用方按 raw stdout 断言 */ }
  return { status: r.status, stdout: r.stdout, parsed };
}

console.log("① 正常样例拓扑：返回 DRC 诊断，exit code 0");
{
  const model = require("./topo-data.js");
  const r = runDraw(model);
  ok(r.status === 0, `exit code=${r.status}`);
  ok(r.parsed && typeof r.parsed.score === "number", `拿到 score=${r.parsed && r.parsed.score}`);
  ok(r.parsed && Array.isArray(r.parsed.findings), `findings 是数组，长度=${r.parsed && r.parsed.findings.length}`);
  ok(r.parsed && r.parsed.deviceCount === model.devices.length, "deviceCount 对得上");
  ok(r.parsed && r.parsed.bbox && Number.isFinite(r.parsed.bbox.minX), "bbox 有效");
  ok(r.parsed && !("html" in r.parsed),
    "返回值里没有 html 正文——HTML 只落盘、不穿 agent 上下文（原 render_html 的 163KB 会触发 spill）");
  ok(fsMod.existsSync(DRAW_OUT) && fsMod.readFileSync(DRAW_OUT, "utf8").startsWith("<!doctype html"),
    "预览 HTML 真的写到磁盘了");
  ok(r.parsed && r.parsed.bytes > 0 && r.parsed.path === DRAW_OUT, "回传的 path/bytes 对得上");
}

console.log("①b draw 嵌进 HTML 的是原始模型，不是补全后的——保证往返幂等");
{
  // computeGeometry 会经 normalizeEncoding() 把派生的 fill/stroke 写回 model。若嵌入这份，
  // 本来"没写颜色、由引擎自动配"的角色就变成"显式指定了颜色"，之后加新角色时自动配色
  // 看到的已占用槽位不同，配色结果会跟第一次不一样。
  // 必须用一个**真的靠自动配色**的模型：topo-data.js 每个角色都手写了 fill，
  // 拿它测等于什么都没测（第一版就这么写的，断言恒假）。
  const model = {
    meta: {},
    encoding: {
      deviceRoles: { sw: { legend: "交换机" }, pc: { legend: "终端" } },
      linkTypes: { plain: { legend: "链路" } }, connTypes: {}, zoneTypes: {},
    },
    devices: [{ id: "S", role: "sw", tier: 0, label: "S" }, { id: "P", role: "pc", tier: 1, label: "P" }],
    links: [{ a: "S", b: "P", type: "plain" }],
    zones: [],
  };
  runDraw(model);
  const html = fsMod.readFileSync(DRAW_OUT, "utf8");
  const m = /window\.TOPO = (\{[\s\S]*?\});<\/script>/.exec(html);
  ok(!!m, "HTML 里嵌了 window.TOPO");
  if (m) {
    const embedded = JSON.parse(m[1]);
    const noFill = Object.values(embedded.encoding.deviceRoles).some(v => v.fill == null);
    ok(noFill, "自动配色的角色在嵌入模型里仍然没有 fill（派生字段已剥离）");
  }
}

console.log("② 非法 JSON：exit code 非 0，stdout 吐结构化错误而不是崩溃/空输出");
{
  const r = runDraw("{not valid json");
  ok(r.status !== 0, `exit code=${r.status}`);
  ok(r.parsed && r.parsed.error === "INVALID_JSON", `error=${r.parsed && r.parsed.error}`);
}

console.log("③ 缺 devices/links 字段：结构化报错，不是裸异常堆栈");
{
  const r = runDraw({ meta: {} });
  ok(r.status !== 0, `exit code=${r.status}`);
  ok(r.parsed && r.parsed.error === "INVALID_MODEL", `error=${r.parsed && r.parsed.error}`);
}

console.log("④ 链路引用不存在的设备：LAYOUT_FAILED 而不是进程崩溃");
{
  const r = runDraw({
    meta: {}, encoding: { deviceRoles: {}, linkTypes: {}, connTypes: {} },
    devices: [{ id: "A", role: "x", tier: 0, label: "A" }],
    links: [{ a: "A", b: "GHOST", type: "normal" }],
  });
  ok(r.status !== 0, `exit code=${r.status}`);
  ok(r.parsed && r.parsed.error === "LAYOUT_FAILED", `error=${r.parsed && r.parsed.error}`);
}

console.log("⑤ export --format=svg 落盘并回传路径，不回传内容");
{
  const os = require("os"), fsx = require("fs");
  const out = path.join(os.tmpdir(), "topo-export-test-" + process.pid + ".svg");
  const model = require("./topo-data.js");
  const r = spawnSync(process.execPath,
    [path.join(__dirname, "cli.js"), "export", "--format=svg", "--out=" + out, "--routing=direct"],
    { input: JSON.stringify(model), encoding: "utf8" });
  const parsed = JSON.parse(r.stdout);
  ok(r.status === 0, `exit code=${r.status}`);
  ok(parsed.path === out && parsed.format === "svg", "回传 path/format");
  ok(typeof parsed.bytes === "number" && parsed.bytes > 0, `回传 bytes=${parsed.bytes}`);
  ok(!("svg" in parsed) && !("content" in parsed), "**不**回传文件内容（二进制格式会撑爆 agent 上下文）");
  ok(fsx.existsSync(out) && fsx.readFileSync(out, "utf8").startsWith("<svg "), "文件真的落盘且是 SVG");
  fsx.unlinkSync(out);
}

console.log("⑥ 未实现的 format 明确报错，不产出半成品");
{
  const model = require("./topo-data.js");
  const r = spawnSync(process.execPath,
    [path.join(__dirname, "cli.js"), "export", "--format=png", "--out=/tmp/x.png"],
    { input: JSON.stringify(model), encoding: "utf8" });
  const parsed = JSON.parse(r.stdout);
  ok(r.status !== 0, `exit code=${r.status}`);
  ok(parsed.error === "UNSUPPORTED_FORMAT" && /二期/.test(parsed.message), `报错说明计划期次: ${parsed.message}`);
}

console.log("⑦ meta.routing 作者化字段：优先级 代码默认 < meta.routing < --routing 显式覆盖");
{
  const os = require("os"), fsx = require("fs");
  const base = require("./topo-data.js");
  const run = (m, extra) => {
    const out = path.join(os.tmpdir(), "topo-routing-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".svg");
    const args = [path.join(__dirname, "cli.js"), "export", "--format=svg", "--out=" + out].concat(extra || []);
    const r = spawnSync(process.execPath, args, { input: JSON.stringify(m), encoding: "utf8" });
    let poly = -1;
    if (r.status === 0 && fsx.existsSync(out)) {
      poly = (fsx.readFileSync(out, "utf8").match(/<polyline/g) || []).length;
      fsx.unlinkSync(out);
    }
    return { parsed: JSON.parse(r.stdout), status: r.status, poly };
  };
  const withMeta = (routing) => {
    const m = JSON.parse(JSON.stringify(base));
    if (routing != null) m.meta.routing = routing;
    return m;
  };

  // 2026-07-28 起只开放 direct：orthogonal 的引擎还在,但产出不达标(多线汇聚共线重叠),
  // 入口校验直接拒。缺省也随之改成 direct。
  ok(run(withMeta(null), []).poly === 0, "不写任何 routing → 缺省 direct（0 折线）");
  ok(run(withMeta("direct"), []).poly === 0, "meta.routing:direct 生效——这就是“决定能被记住”");

  const viaFlag = run(withMeta(null), ["--routing=orthogonal"]);
  ok(viaFlag.status !== 0 && viaFlag.parsed.error === "BAD_ARGS" && /暂未开放/.test(viaFlag.parsed.message),
    "--routing=orthogonal 被明确拒绝(不是静默画成直线): " + viaFlag.parsed.message.slice(0, 60));
  const viaMeta = run(withMeta("orthogonal"), []);
  ok(viaMeta.status !== 0 && viaMeta.parsed.error === "BAD_ARGS" && viaMeta.parsed.message.indexOf("meta.routing") >= 0,
    "模型里写 meta.routing:orthogonal 同样被拒且指明来源");

  const bad = run(withMeta("bogus"), []);
  ok(bad.status !== 0 && bad.parsed.error === "BAD_ARGS" && bad.parsed.message.indexOf("meta.routing") >= 0,
    "meta.routing 写错报 BAD_ARGS 且指明来源: " + bad.parsed.message);
}

console.log("⑧ draw 返回值真的带上 geometry / style 两段体检数据");
{
  // 光有模块正确不够——agent 只看得到 cli 吐出来的那份 JSON。normalizeEncoding 那个 bug
  // (模块对的、一个调用方漏调) 就是这么漏过去的，所以接线本身必须单独钉一条。
  const bare = {
    meta: {},
    encoding: {
      deviceRoles: { sw: { legend: "交换机" }, pc: { legend: "终端" } },
      linkTypes: { plain: { legend: "普通链路" } },
      connTypes: {}, zoneTypes: {}
    },
    devices: [{ id: "A", role: "sw", tier: 0, label: "A" }, { id: "B", role: "pc", tier: 1, label: "B" }],
    links: [{ a: "A", b: "B", type: "plain" }],
    zones: []
  };
  const r = runDraw(bare);
  ok(r.parsed && r.parsed.geometry && Array.isArray(r.parsed.geometry.zoneOverlaps),
    "返回值里有 geometry 段");
  ok(r.parsed && r.parsed.style && Array.isArray(r.parsed.style.rolesWithoutIcon),
    "返回值里有 style 段");
  // 两个角色都只写了 legend，一个图标都没配 —— 这正是真实 agent 画出来的那张图的形态
  ok(r.parsed && r.parsed.style.rolesWithoutIcon.length === 2,
    `缺图标的角色被报出来（实际 ${JSON.stringify(r.parsed && r.parsed.style.rolesWithoutIcon)}）`);
  ok(r.parsed && r.parsed.score === 100,
    "同时 DRC 仍是满分——图标不进 DRC 打分，这个信号只能靠 style 段传达");
}

console.log("⑨ export --out 必须是绝对路径（相对路径会写进引擎安装目录，用户找不到文件）");
{
  const model = require("./topo-data.js");
  const r = spawnSync(process.execPath, [path.join(__dirname, "cli.js"), "export",
    "--format=svg", "--out=relative.svg"], { input: JSON.stringify(model), encoding: "utf8" });
  const parsed = JSON.parse(r.stdout);
  ok(r.status !== 0 && parsed.error === "BAD_ARGS", `相对路径被拒: ${parsed.error}`);
  ok(/绝对路径/.test(parsed.message), "错误信息说清了要绝对路径");
  ok(!fsMod.existsSync(path.join(__dirname, "relative.svg")), "并且真的没有在引擎目录留下文件");
}

console.log("⑩ routing 参数跟 meta.routing 不一致时给出 ROUTING_NOT_PERSISTED");
{
  // 真实 agent 踩过：用户要直线，它传 routing=direct 导出了，但没回写 meta.routing。
  // 图是直线、模型说自己是正交，下次重新渲染无声变回折线。SOUL.md 早写了"必须落到
  // meta.routing"，agent 也完全理解——但没有信号提醒它这事正在发生。
  const base = JSON.parse(JSON.stringify(require("./topo-data.js")));
  const out = path.join(os.tmpdir(), "verify-cli-routing.svg");
  const runExport = (model, routing) => {
    const args = [path.join(__dirname, "cli.js"), "export", "--format=svg", `--out=${out}`];
    if (routing) args.push(`--routing=${routing}`);
    const r = spawnSync(process.execPath, args, { input: JSON.stringify(model), encoding: "utf8" });
    return JSON.parse(r.stdout);
  };

  const withMeta = (v) => { const m = JSON.parse(JSON.stringify(base)); m.meta = m.meta || {}; if (v) m.meta.routing = v; else delete m.meta.routing; return m; };

  const mismatch = runExport(withMeta("orthogonal"), "direct");
  ok((mismatch.warnings || []).some(w => w.code === "ROUTING_NOT_PERSISTED"),
    "meta 写 orthogonal、参数传 direct → 报 ROUTING_NOT_PERSISTED");
  ok(/会变回/.test((mismatch.warnings[0] || {}).message || ""), "提示说清了后果（下次会变回去）");

  ok((runExport(withMeta("direct"), "direct").warnings || []).length === 0,
    "两边一致 → 无警告");
  ok((runExport(withMeta("direct"), null).warnings || []).length === 0,
    "不传参数（模型说了算）→ 无警告");
  ok((runExport(withMeta(null), "direct").warnings || []).some(w => w.code === "ROUTING_NOT_PERSISTED"),
    "模型没设 meta.routing、参数传 direct → 同样报（决定没被记住）");

  try { fsMod.unlinkSync(out); } catch { /* 清理失败不影响断言 */ }
}

// ⑪ --model=<abs path>：模型从文件读，而不是走 stdin
// 动机是硬约束：模型作为工具参数时必须由 LLM 逐字生成，受单次输出上限约束——几十台设备
// 展开成 JSON 上万 token 就传不进来了，而生成它的脚本可能只有几十行。
console.log("⑪ --model 从文件读模型");
{
  const base = require("./topo-data.js");
  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), "cli-model-"));
  const modelFile = path.join(dir, "m.topo.json");
  fsMod.writeFileSync(modelFile, JSON.stringify(base), "utf8");
  const bomFile = path.join(dir, "bom.topo.json");
  fsMod.writeFileSync(bomFile, "\uFEFF" + JSON.stringify(base), "utf8");

  let seq = 0;
  const draw = (extra, input) => {
    const out = path.join(dir, "o" + (seq++) + ".html");
    const r = spawnSync(process.execPath,
      [path.join(__dirname, "cli.js"), "draw", "--out=" + out].concat(extra),
      { input: input == null ? "" : input, encoding: "utf8" });
    let j = null; try { j = JSON.parse(r.stdout); } catch { /* 留 null 让断言报出来 */ }
    return { j: j, out: out };
  };

  const viaStdin = draw([], JSON.stringify(base));
  const viaFile = draw(["--model=" + modelFile]);
  ok(viaFile.j && !viaFile.j.error,
    "--model 出图成功" + (viaFile.j && viaFile.j.error ? "：" + viaFile.j.error : ""));
  // 不只比字节数：两份 HTML 逐字节相同才证明两条入口走的是同一条渲染路径
  ok(fsMod.readFileSync(viaStdin.out).equals(fsMod.readFileSync(viaFile.out)),
    "--model 与 stdin 产出的 HTML 逐字节相同");

  const viaBom = draw(["--model=" + bomFile]);
  ok(viaBom.j && !viaBom.j.error, "带 UTF-8 BOM 的模型文件能正常读（记事本/Out-File 默认就带）");
  ok(viaBom.j && !viaBom.j.error && fsMod.readFileSync(viaBom.out).equals(fsMod.readFileSync(viaFile.out)),
    "BOM 版与无 BOM 版产出一致（说明是剥掉了而不是绕过了）");

  const rel = draw(["--model=m.topo.json"]);
  ok(rel.j && rel.j.error === "BAD_ARGS", "相对路径报 BAD_ARGS（实际 " + (rel.j && rel.j.error) + "）");

  const missing = draw(["--model=" + path.join(dir, "nope.json")]);
  ok(missing.j && missing.j.error === "MODEL_FILE_UNREADABLE",
    "文件不存在报 MODEL_FILE_UNREADABLE 而不是 INVALID_JSON（实际 " + (missing.j && missing.j.error) + "）");

  const badJson = path.join(dir, "bad.json");
  fsMod.writeFileSync(badJson, "{ not json", "utf8");
  const bad = draw(["--model=" + badJson]);
  ok(bad.j && bad.j.error === "INVALID_JSON",
    "文件在但内容不是 JSON 报 INVALID_JSON（实际 " + (bad.j && bad.j.error) + "）");

  try { fsMod.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
