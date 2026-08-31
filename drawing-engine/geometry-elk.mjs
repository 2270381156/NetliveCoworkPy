/* 档 B 几何后端：真实 elkjs 布点 + elkjs-libavoid 避障布线。
   模拟设计方案 §4/§9.1 的"Python capability provider 拉起 Node sidecar，走 IPC 拿 JSON"——
   这里没有真 Python，用 HTTP（见 serve.js /api/layout）代替 IPC，但输入输出契约刻意对齐
   topo.js 的 computeLayout()：{ nodes, links, bbox, tiers }，证明几何层可换、上下游不用动（§4 的核心主张）。
   Node-only（libavoid-js 的 WASM 在 Node 侧走自动初始化），不进浏览器。 */
import { init as initAvoid, routeEdges } from "@mr_mint/elkjs-libavoid";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { deriveLegend, normalizeEncoding, CFG } = require("./topo.js");
const { layoutRegions, metaLayoutOverrides, layoutOptsFromCfg } = require("./regions.js");

let avoidReady = null;
function ensureAvoidInit() {
  if (!avoidReady) avoidReady = initAvoid();
  return avoidReady;
}

async function computeElkLayout(model, opts) {
  // 优先级同 topo.js 的 computeLayout()：代码默认值 < meta 作者化覆盖 < opts
  // 优先级/键大小写契约同 topo.js computeLayout()：opts 用大写键(ROW_GAP)，小写会被静默忽略。
  // 跟 topo.js 的 computeLayout() 一样先补全 encoding 的缺省样式——这一步以前只有 hand 引擎有,
  // elk 引擎漏掉,导致作者只写 legend(SOUL.md 允许的写法)时连线没有 stroke、整条线隐形。
  // 由真实 agent 画的第一张图暴露:所有测试样例都手写了 stroke,从没触发过这条路径。
  normalizeEncoding(model);
  const cfg = Object.assign({}, CFG, metaLayoutOverrides(model), opts || {});
  const icons = (opts && opts.icons) || {};
  const devicesById = {};
  for (const d of model.devices) devicesById[d.id] = d;

  const sizeById = {};
  for (const d of model.devices) {
    const enc = Object.assign({ w: 72, h: 42 }, model.encoding.deviceRoles[d.role] || {});
    const iconInfo = enc.icon && icons[enc.icon];
    const width = (iconInfo && iconInfo.aspect) ? enc.h * iconInfo.aspect : enc.w;
    sizeById[d.id] = { w: width, h: enc.h };
  }

  const { boxes, zoneOrder } = layoutRegions(model, id => sizeById[id], layoutOptsFromCfg(cfg));

  // ---- 拼一个跟"已定位"图同形状的对象，直接喂给 libavoid 绕线——不再跑 elk 的 layered
  // 算法，节点位置全部来自 regions.js，两个引擎的设备坐标完全一致。 ----
  const positioned = {
    id: "root",
    children: model.devices.map(d => {
      const b = boxes[d.id];
      return { id: d.id, x: b.x, y: b.y, width: b.w, height: b.h };
    }),
    edges: model.links.map((l, i) => ({
      id: l.__eid || (l.__eid = "e" + i), sources: [l.a], targets: [l.b]
    }))
  };

  await ensureAvoidInit();
  // shapeBufferDistance：绕过无关设备时的最小间距。不传时 libavoid 用 4，视觉上贴边。
  const routes = await routeEdges(positioned, { shapeBufferDistance: cfg.SHAPE_BUFFER });

  const nodes = {};
  for (const c of positioned.children) {
    const d = devicesById[c.id];
    nodes[c.id] = {
      id: c.id, role: d.role, label: d.label, tier: d.tier,
      w: c.width, h: c.height,
      cx: c.x + c.width / 2, cy: c.y + c.height / 2,
      left: c.x, right: c.x + c.width, top: c.y, bottom: c.y + c.height,
      iconTheme: d.iconTheme || null
    };
  }

  const links = model.links.map((l, i) => {
    const eid = l.__eid || ("e" + i);
    const r = routes.get(eid);
    const route = r ? [r.sourcePoint, ...(r.bendPoints || []), r.targetPoint] : null;
    return Object.assign({}, l, {
      route,
      aAnchor: route ? { x: route[0].x, y: route[0].y } : null,
      bAnchor: route ? { x: route[route.length - 1].x, y: route[route.length - 1].y } : null
    });
  });

  const zonesById = {};
  for (const z of (model.zones || [])) zonesById[z.id] = z;
  const zones = zoneOrder.map(id => {
    const b = boxes[id];
    return Object.assign({}, zonesById[id], {
      bbox: { minX: b.x - cfg.ZONE_PAD, minY: b.y - cfg.ZONE_PAD,
              maxX: b.x + b.w + cfg.ZONE_PAD, maxY: b.y + b.h + cfg.ZONE_PAD }
    });
  });

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id in nodes) {
    const n = nodes[id];
    minX = Math.min(minX, n.left); minY = Math.min(minY, n.top);
    maxX = Math.max(maxX, n.right); maxY = Math.max(maxY, n.bottom);
  }
  for (const z of zones) {
    minX = Math.min(minX, z.bbox.minX); minY = Math.min(minY, z.bbox.minY);
    maxX = Math.max(maxX, z.bbox.maxX); maxY = Math.max(maxY, z.bbox.maxY);
  }
  const tiers = [...new Set(model.devices.map(d => d.tier))].sort((a, b) => a - b);

  const legend = deriveLegend(model, { minX, minY, maxX, maxY });
  if (legend) {
    minX = Math.min(minX, legend.bbox.minX); minY = Math.min(minY, legend.bbox.minY);
    maxX = Math.max(maxX, legend.bbox.maxX); maxY = Math.max(maxY, legend.bbox.maxY);
  }

  return { nodes, links, zones, bbox: { minX, minY, maxX, maxY }, tiers, engine: "elk+libavoid", legend };
}

export { computeElkLayout };
