/* serve.js 自测：验证 /api/layout 的 JSON 序列化层没有悄悄丢字段。
   背景：sanitizeHandLayout()（hand 引擎）和 geometry-elk.mjs 的 computeElkLayout()（elk 引擎）
   各自手写了一份"哪些字段吐给前端"的白名单，iconTheme 加进 topo.js 的 computeLayout() 后，
   这两处白名单都忘了同步——布局计算本身是对的，HTTP 响应却把 iconTheme 悄悄丢了，浏览器端
   drawNodes() 因此永远拿不到 iconTheme，图标颜色码全部退化成默认蓝色，且没有任何报错/崩溃，
   纯靠人眼对比截图才发现。这里用真实 HTTP 请求命中真实跑起来的 server，两个引擎都测一遍，
   防止同类"字段白名单漏更新"的问题再次悄悄发生。
   用法：node verify-serve.js */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

const TOPO_DATA_PATH = path.join(__dirname, "topo-data.js");
// 原来用 5199，在这台机器当前的 Windows 动态端口排除区间(5177-5276)里，serve.js 会
// EACCES 起不来——换成不在任何已知排除区间里的端口。如果这个也撞了，换个数字就行。
const PORT = 15199;

const FIXTURE = `
(function (root) {
  const TOPO = {
    meta: { name: "verify-serve fixture", layoutDirection: "TB", legendPosition: "right" },
    encoding: {
      deviceRoles: { core: { w: 80, h: 46, legend: "核心交换机", icon: "core-switch" } },
      linkTypes: { normal: { legend: "链路" } },
      connTypes: {},
    },
    devices: [
      { id: "A", role: "core", tier: 0, label: "A", iconTheme: "yellow" },
      { id: "B", role: "core", tier: 1, label: "B" },
    ],
    links: [{ a: "A", b: "B", type: "normal", aPort: "p1", bPort: "p2" }],
  };
  if (typeof module !== "undefined" && module.exports) module.exports = TOPO;
  else root.TOPO = TOPO;
})(typeof window !== "undefined" ? window : this);
`;

function getJSON(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "localhost", port: PORT, path: pathname }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("非法 JSON: " + body.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try { await getJSON("/api/icons"); return; } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("serve.js 在超时前没能起来");
}

async function main() {
  const original = fs.readFileSync(TOPO_DATA_PATH, "utf8");
  fs.writeFileSync(TOPO_DATA_PATH, FIXTURE);
  let child = null;
  try {
    child = spawn(process.execPath, [path.join(__dirname, "serve.js"), String(PORT)], { stdio: "ignore" });
    await waitForServer();

    console.log("① hand 引擎：/api/layout 响应里 iconTheme/aPort/bPort 都没被序列化层丢掉");
    {
      const data = await getJSON("/api/layout?engine=hand");
      ok(data.nodes && data.nodes.A && data.nodes.A.iconTheme === "yellow", `A.iconTheme=${data.nodes && data.nodes.A && data.nodes.A.iconTheme}`);
      ok(data.nodes && data.nodes.B && data.nodes.B.iconTheme === null, `B.iconTheme=${data.nodes && data.nodes.B && data.nodes.B.iconTheme}(没设时该是 null，不是 undefined 导致字段缺失)`);
      const link = data.links && data.links.find(l => l.a === "A" && l.b === "B");
      ok(link && link.aPort === "p1", `link.aPort=${link && link.aPort}`);
      ok(link && link.bPort === "p2", `link.bPort=${link && link.bPort}`);
    }

    console.log("② elk 引擎：computeElkLayout() 的输出字段白名单也没丢 iconTheme/aPort/bPort");
    {
      const data = await getJSON("/api/layout?engine=elk");
      ok(data.nodes && data.nodes.A && data.nodes.A.iconTheme === "yellow", `A.iconTheme=${data.nodes && data.nodes.A && data.nodes.A.iconTheme}`);
      ok(data.nodes && data.nodes.B && data.nodes.B.iconTheme === null, `B.iconTheme=${data.nodes && data.nodes.B && data.nodes.B.iconTheme}`);
      const link = data.links && data.links.find(l => l.a === "A" && l.b === "B");
      ok(link && link.aPort === "p1", `link.aPort=${link && link.aPort}`);
      ok(link && link.bPort === "p2", `link.bPort=${link && link.bPort}`);
    }

    console.log("③ hand 引擎：设了 icon 的角色,w 由 h × 图标(core-switch)原生长宽比派生,不是作者写的 80");
    {
      const data = await getJSON("/api/layout?engine=hand");
      // core-switch.svg 真实 viewBox "0 0 2751 2251"，2751/2251 ≈ 1.2221；h=46 → w ≈ 56.2
      const expectedW = 46 * (2751 / 2251);
      ok(data.nodes && data.nodes.A && Math.abs(data.nodes.A.w - expectedW) < 1e-6,
        `A.w=${data.nodes && data.nodes.A && data.nodes.A.w}(应≈${expectedW.toFixed(2)}，不是作者写的 80)`);
    }

    console.log("④ elk 引擎：同一条派生规则在 geometry-elk.mjs 里也生效");
    {
      const data = await getJSON("/api/layout?engine=elk");
      const expectedW = 46 * (2751 / 2251);
      ok(data.nodes && data.nodes.A && Math.abs(data.nodes.A.w - expectedW) < 1e-6,
        `A.w=${data.nodes && data.nodes.A && data.nodes.A.w}(应≈${expectedW.toFixed(2)}，不是作者写的 80)`);
    }
    console.log("⑤ hand 引擎：/api/layout 响应里 legend 字段没被 sanitizeHandLayout() 的白名单丢掉");
    {
      const data = await getJSON("/api/layout?engine=hand");
      ok(data.legend && data.legend.position === "right", `data.legend.position=${data.legend && data.legend.position}(应为 right)`);
      ok(Array.isArray(data.legend && data.legend.groups) && data.legend.groups.length > 0,
        `data.legend.groups 非空数组(实际 ${data.legend && JSON.stringify(data.legend.groups && data.legend.groups.map(g => g.kind))})`);
    }

    console.log("⑥ elk 引擎：computeElkLayout() 的返回值里 legend 字段也在(不需要额外白名单,整个对象直接吐)");
    {
      const data = await getJSON("/api/layout?engine=elk");
      ok(data.legend && data.legend.position === "right", `data.legend.position=${data.legend && data.legend.position}(应为 right)`);
      ok(Array.isArray(data.legend && data.legend.groups) && data.legend.groups.length > 0,
        `data.legend.groups 非空数组(实际 ${data.legend && JSON.stringify(data.legend.groups && data.legend.groups.map(g => g.kind))})`);
    }

    console.log("⑦ /api/svg：两种 routing 都吐自包含 SVG（页面只负责塞进去，不再自己画）");
    for (const routing of ["direct", "orthogonal"]) {
      const data = await getJSON(`/api/svg?routing=${routing}`);
      const svg = data.svg || "";
      ok(svg.startsWith("<svg "), `${routing}: svg 以 "<svg " 开头(实际 ${JSON.stringify(svg.slice(0, 30))})`);
      ok(svg.includes(">A</text>") && svg.includes(">B</text>"), `${routing}: svg 里有设备 label A/B`);
      // 自包含：CSS 变量定义在 HTML 的 :root 上，单独打开 .svg 时未定义会让文字退化成黑色，
      // 所以 draw-core 产出的 SVG 里一处 var(--…) 都不许出现。
      ok(!svg.includes("var(--"), `${routing}: svg 里不含 CSS 变量引用 var(--`);
      ok(data.viewBox && typeof data.viewBox.w === "number" && data.viewBox.w > 0,
        `${routing}: viewBox.w=${data.viewBox && data.viewBox.w}(页面"适应窗口"要用)`);
    }

    console.log("⑧ /api/svg：routing 拼错是参数错误(400)，不是布局算崩(500)");
    {
      const data = await getJSON("/api/svg?routing=nosuch");
      ok(typeof data.error === "string" && data.error.includes("nosuch"), `error=${data.error}`);
      ok(!data.svg, "不该顺手吐一份 svg 出来");
    }
  } finally {
    if (child) child.kill();
    fs.writeFileSync(TOPO_DATA_PATH, original);
  }

  console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  // topo-data.js 的还原已经在 main() 自己的 try/finally 里处理了，这里只负责报错退出。
  console.error(err);
  process.exit(1);
});
