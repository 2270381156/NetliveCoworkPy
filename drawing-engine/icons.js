/* icons.js —— 拓扑图标解析:读 topology-icons/catalog.json,
   把 model 里实际用到的 icon key 转成 base64 data URI,供 render.js/serve.js 内嵌进页面。
   只处理 model 里真正引用到的 key(不是全量目录),避免把整个图标库都塞进输出。
   Node-only(用 fs 读文件),不进浏览器。 */
"use strict";
const fs = require("fs");
const path = require("path");

const ICONS_ROOT = path.join(__dirname, "topology-icons");

let _catalog = null;
function loadCatalog() {
  if (_catalog) return _catalog;
  const raw = fs.readFileSync(path.join(ICONS_ROOT, "catalog.json"), "utf8");
  _catalog = JSON.parse(raw);
  return _catalog;
}

function readSvgText(relPath) {
  return fs.readFileSync(path.join(ICONS_ROOT, relPath), "utf8");
}

function svgToDataUri(svgText) {
  return "data:image/svg+xml;base64," + Buffer.from(svgText, "utf8").toString("base64");
}

// 从 SVG 的 viewBox="minX minY width height" 解析宽高比(宽/高)；没有 viewBox 或格式不
// 认识时返回 null——调用方(topo.js/geometry-elk.mjs)遇到 null 一律退回"不覆盖长宽比"
// 的原有行为,不抛异常。
function parseAspect(svgText) {
  const m = svgText.match(/viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return (w > 0 && h > 0) ? w / h : null;
}

// 返回 { [key]: { blue: dataUri, yellow: dataUri|null, deviceType: bool, aspect: number|null } }
// 未登记的 key 直接跳过(不报错)——渲染时会退化成纯色矩形,这是设计上允许的正常状态。
// aspect 从 blue 素材的 SVG viewBox 算出(宽/高),供④层(topo.js/geometry-elk.mjs)在设了
// icon 时用它覆盖设备方框的长宽比,消除"方框比例跟图标本身比例对不上导致端口悬空"这类
// 问题(案例验证发现,见 docs/superpowers/specs/2026-07-08-topology-layered-authoring-model-design.md
// 开放问题 9)。
function resolveIconsForModel(model) {
  const catalog = loadCatalog();
  const usedKeys = new Set();
  const roles = (model.encoding && model.encoding.deviceRoles) || {};
  for (const role in roles) {
    const icon = roles[role].icon;
    if (icon) usedKeys.add(icon);
  }
  const result = {};
  for (const key of usedKeys) {
    const entry = catalog[key];
    if (!entry) continue;
    const blueText = entry.blue ? readSvgText(entry.blue) : null;
    result[key] = {
      blue: blueText ? svgToDataUri(blueText) : null,
      yellow: entry.deviceType && entry.yellow ? svgToDataUri(readSvgText(entry.yellow)) : null,
      deviceType: !!entry.deviceType,
      aspect: blueText ? parseAspect(blueText) : null,
    };
  }
  return result;
}

// readSvgText 也导出给 export-vsdx.js：vsdx 要的不是 data URI 而是**原始 SVG 文本**，
// 它得把 path 转成 Visio 的 Geometry 行（见 svg-geometry.js 开头，其它几条路都验过不通）。
module.exports = { loadCatalog, resolveIconsForModel, readSvgText };
