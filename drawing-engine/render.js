/* render.js —— 拓扑 → 单文件、离线可看的 HTML。
   2026-07-25 起：SVG 由 draw-core.js 在 Node 侧拼好后整段内嵌，浏览器**不再做任何布局和
   绘制**，只剩平移缩放（纯 viewBox 操作）。因此这里不再内嵌 topo.js/regions.js 源码——
   "漏内嵌某个依赖导致整页空白"那类 bug 从结构上不可能再发生。
   HTML 里的 SVG 和 `cli.js export --format=svg` 导出的 .svg 是同一个函数产出的同一串字节。
   window.TOPO 仍然内嵌，但只作溯源用（这份图由哪份模型生成），不参与渲染。
   Node-only。 */
"use strict";
const { computeViewBox } = require("./draw-core.js");

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 只剩视口交互：滚轮缩放、拖拽平移、适应窗口、缩放百分比。不碰 SVG 内容。
const VIEWPORT_SCRIPT = `(function () {
  const svg = document.getElementById("svg");
  const bb = window.__VIEWBOX__;
  let vb = { x: bb.x, y: bb.y, w: bb.w, h: bb.h };
  const home = Object.assign({}, vb);
  const applyVB = () => {
    svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
    const sc = Math.min(svg.clientWidth / vb.w, svg.clientHeight / vb.h);
    document.getElementById("zoom").textContent = "缩放 " + Math.round(sc * 100) + "%";
  };
  const clientToWorld = (cx, cy) => {
    const p = svg.createSVGPoint(); p.x = cx; p.y = cy;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const w = clientToWorld(e.clientX, e.clientY);
    const k = e.deltaY < 0 ? 0.9 : 1.111;
    vb.x = w.x - (w.x - vb.x) * k; vb.y = w.y - (w.y - vb.y) * k; vb.w *= k; vb.h *= k;
    applyVB();
  }, { passive: false });
  let dragging = false, lx = 0, ly = 0;
  svg.addEventListener("pointerdown", (e) => {
    dragging = true; lx = e.clientX; ly = e.clientY;
    svg.classList.add("drag"); svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const sc = Math.min(svg.clientWidth / vb.w, svg.clientHeight / vb.h), wpp = 1 / sc;
    vb.x -= (e.clientX - lx) * wpp; vb.y -= (e.clientY - ly) * wpp;
    lx = e.clientX; ly = e.clientY; applyVB();
  });
  const stop = () => { dragging = false; svg.classList.remove("drag"); };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  document.getElementById("fit").addEventListener("click", () => {
    vb = Object.assign({}, home); applyVB();
  });
  window.addEventListener("resize", applyVB);
  applyVB();
})();`;

// HTML 外壳样式。注意 .devlabel/.devrole 不在这里——它们随 SVG 走（见 draw-core.js 的
// SVG_STYLE），这样导出的 .svg 单独打开也有正确字体样式。
const STYLE = `
  :root { --bg:#f7f8fa; --panel:#ffffff; --ink:#2b3542; --muted:#6b7787; --line:#dbe1e8; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; font-family: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:var(--bg); }
  #app { position:fixed; inset:0; display:flex; flex-direction:column; }
  #bar { display:flex; align-items:center; gap:14px; padding:8px 14px; background:var(--panel); border-bottom:1px solid var(--line); font-size:13px; }
  #bar b { font-weight:600; }
  #bar .sp { flex:1; }
  #bar button { font:inherit; padding:4px 12px; border:1px solid var(--line); border-radius:6px; background:#fff; cursor:pointer; }
  #bar button:hover { background:#f0f3f7; }
  #bar .hint { color:var(--muted); }
  #stage { position:relative; flex:1; overflow:hidden; }
  #stage svg { width:100%; height:100%; display:block; cursor:grab; background:
        radial-gradient(circle at 1px 1px, #e6eaef 1px, transparent 0) 0 0/22px 22px; }
  #stage svg.drag { cursor:grabbing; }
`;

/** 把算好的 layout 渲染成单文件 HTML。svg 参数是 draw-core.buildSVG() 的产物。 */
function renderStandaloneHTML(model, layout, svg) {
  const title = (model.meta && model.meta.name) || "网络拓扑图";
  // 用 draw-core 导出的同一个函数算 home 视口——不能在这里自己再写一遍 pad 外扩，
  // 两份不一致会让"适应窗口"跳到跟 SVG 自身 viewBox 不同的取景。
  const viewBox = computeViewBox(layout);
  // buildSVG 产出的根标签带 width/height（给单独打开的 .svg 用），在 HTML 里要让它填满
  // #stage，所以把 id 加上、去掉固定尺寸，交给 CSS 控制。
  const inlineSvg = svg
    .replace(/^<svg /, '<svg id="svg" ')
    .replace(/ width="\d+" height="\d+"/, "");

  return `<!doctype html>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<div id="app">
  <div id="bar">
    <b>拓扑</b><span class="hint">· ${escapeHtml(title)}</span>
    <span class="sp"></span>
    <span class="hint">滚轮缩放 · 拖拽平移 · 线宽随缩放恒定</span>
    <button id="fit">适应窗口</button>
    <span id="zoom" class="hint"></span>
  </div>
  <div id="stage">${inlineSvg}</div>
</div>
<script>window.TOPO = ${JSON.stringify(model)};</script>
<script>window.__VIEWBOX__ = ${JSON.stringify(viewBox)};</script>
<script>${VIEWPORT_SCRIPT}</script>
`;
}

module.exports = { renderStandaloneHTML };
