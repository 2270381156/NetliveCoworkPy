/* 独立 Web 服务：静态文件 + 几何/绘制 API。
   这是"体外"渲染服务——Electron 前端目前没有动态展示能力，拓扑图先完全脱离 frontend-desktop，
   单独用这个服务承载（静态 HTML + 走 Node 计算的 API）。
   /api/svg?routing=orthogonal|direct
       → { svg, bbox, viewBox }：布局 + 绘制全在 Node 侧完成，浏览器只负责把 svg 字符串塞进
         页面再做平移缩放。绘制逻辑只有 draw-core.js 一份（index.html 里那份拷贝已删除）。
   /api/layout?engine=hand|elk
       → 原始 layout JSON。页面已经不用它了，保留是因为 verify-serve.js 拿它做"序列化字段
         白名单别再悄悄漏字段"的回归测试（那个 bug 只有直接看 JSON 才抓得住）。
   /api/icons → 图标 data URI 表（verify-serve.js 也拿它做 server 就绪探测）。
   用法：node serve.js [port] */
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.argv[2]) || 5177;
const root = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8"
};

const model = require("./topo-data.js");
const { computeLayout } = require("./topo.js");
const { resolveIconsForModel } = require("./icons.js");
const { buildSVG, computeViewBox } = require("./draw-core.js");
let elkModulePromise = null;
const loadElk = () => elkModulePromise || (elkModulePromise = import("./geometry-elk.mjs"));

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// computeLayout() 的 node.ports[side][i].other 是别的 node 对象的引用，用于布点内部计算，
// 会成环，不能直接 JSON.stringify——对外只吐公开字段。
function sanitizeHandLayout(layout) {
  const nodes = {};
  for (const id in layout.nodes) {
    const n = layout.nodes[id];
    nodes[id] = { id: n.id, role: n.role, label: n.label, tier: n.tier, w: n.w, h: n.h,
                   cx: n.cx, cy: n.cy, left: n.left, right: n.right, top: n.top, bottom: n.bottom,
                   iconTheme: n.iconTheme };
  }
  return { engine: "hand", nodes, links: layout.links, zones: layout.zones, bbox: layout.bbox,
           tiers: layout.tiers, legend: layout.legend };
}

async function handleLayoutAPI(req, res, engine) {
  try {
    const icons = resolveIconsForModel(model);
    if (engine === "elk") {
      const { computeElkLayout } = await loadElk();
      sendJSON(res, 200, await computeElkLayout(model, { icons }));
    } else {
      sendJSON(res, 200, sanitizeHandLayout(computeLayout(model, { icons })));
    }
  } catch (err) {
    sendJSON(res, 500, { error: String((err && err.stack) || err) });
  }
}

// 与 cli.js 的 computeGeometry() 同一套两步流程，只是模型固定为启动时加载的 topo-data.js：
// routing=direct → topo.js 手写同步引擎（端口锚点直线）；
// routing=orthogonal → geometry-elk.mjs（elkjs 布点 + libavoid 正交避障折线，ESM+WASM 只能 Node 侧跑）。
async function computeGeometry(routing) {
  const icons = resolveIconsForModel(model);
  if (routing === "direct") return { layout: computeLayout(model, { icons }), icons };
  const { computeElkLayout } = await loadElk();
  return { layout: await computeElkLayout(model, { icons }), icons };
}

async function handleSvgAPI(res, routing) {
  // routing 拼错单独报 400：跟"布局真的算崩了"（500）区分开，否则调用方按状态码分支会误判。
  if (routing !== "orthogonal" && routing !== "direct") {
    return sendJSON(res, 400, { error: `未知的 routing: "${routing}"（可选 orthogonal|direct）` });
  }
  try {
    const geo = await computeGeometry(routing);
    // viewBox 用 draw-core 导出的同一个函数算——页面"适应窗口"的 home 视口必须跟 SVG 自身
    // 的 viewBox 完全一致，不能在页面里另写一遍外扩 pad（跟 render.js 同样的理由）。
    sendJSON(res, 200, {
      svg: buildSVG(model, geo.layout, geo.icons),
      bbox: geo.layout.bbox,
      viewBox: computeViewBox(geo.layout),
    });
  } catch (err) {
    sendJSON(res, 500, { error: String((err && err.stack) || err) });
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/icons") {
    try {
      return sendJSON(res, 200, resolveIconsForModel(model));
    } catch (err) {
      return sendJSON(res, 500, { error: String((err && err.stack) || err) });
    }
  }
  if (url.pathname === "/api/layout") {
    return handleLayoutAPI(req, res, url.searchParams.get("engine") || "hand");
  }
  if (url.pathname === "/api/svg") {
    // 优先级跟 cli.js 一致：代码默认 < 模型的 meta.routing < 查询串显式指定。
    // 开发预览必须跟最终产出物用同一套解析规则，否则预览"看着对"、导出却是另一种走线。
    return handleSvgAPI(res, url.searchParams.get("routing")
      || ((model.meta || {}).routing) || "orthogonal");
  }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const full = path.join(root, p);
  if (!full.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found: " + p); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
