/* geometry-report.js —— ④层几何测量（纯函数，无 DOM）：对算好的 layout 做"体检"，产出
   结构化测量数据（observe 输出的 geometry 字段）——agent 不看渲染图，这就是它的眼睛。
   这是测量不是规则：position 钉住的元素可能被作者故意摆得与别的东西重叠，所以只报数字和
   明细、不打分、不进 DRC findings，判断留给 agent（设计文档 2026-07-24 的"汇总统计"概念；
   同时了结 07-08 开放问题 2——④层几何检查以独立模块并入 observe，不做独立工具）。
   浏览器：window.TopoGeometryReport；node：module.exports。 */
(function (root) {
  "use strict";

  const TopoRegions = typeof module !== "undefined" && module.exports
    ? require("./regions.js") : root.TopoRegions;

  const EPS = 0.5; // 浮点/贴边容差：恰好贴边不算越界/相交

  // 线段与矩形是否真的相交（含线段完全落在框内的情况）。用 Liang-Barsky 参数化裁剪：
  // 把线段看成 P0 + t·(P1-P0)，逐边求 t 的可行区间，区间非空即相交。比"逐边做线段求交
  // 再单独判包含"少一半分支，也不会漏掉"整条线在框里"这种没有交点的情形。
  function segIntersectsBox(p0, p1, box) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (Math.abs(p) < 1e-12) return q >= 0;   // 平行于该边：只要在内侧就还活着
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    return clip(-dx, p0.x - box.x1) && clip(dx, box.x2 - p0.x)
        && clip(-dy, p0.y - box.y1) && clip(dy, box.y2 - p0.y);
  }

  function buildGeometryReport(model, layout) {
    const zones = layout.zones || [];
    const zoneById = new Map(zones.map(z => [z.id, z]));
    const decls = new Map((model.zones || []).map(z => [z.id, z]));

    // 祖先关系：父子/祖孙的包含是预期结构，不算重叠
    const parentOf = new Map();
    for (const z of decls.values()) for (const m of z.members || []) parentOf.set(m, z.id);
    // seen 集合防环：正常路径上 computeLayout() 会先于本模块拒掉循环引用的模型，但这个模块
    // 也对外暴露成 window.TopoGeometryReport 可以被单独调用，没有 seen 会直接死循环挂住调用方。
    function isAncestor(a, b) {
      const seen = new Set();
      let cur = parentOf.get(b);
      while (cur !== undefined && !seen.has(cur)) {
        if (cur === a) return true;
        seen.add(cur);
        cur = parentOf.get(cur);
      }
      return false;
    }

    // ---- zone 两两重叠（可视化框相交，排除父子链） ----
    const zoneOverlaps = [];
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i], b = zones[j];
        if (isAncestor(a.id, b.id) || isAncestor(b.id, a.id)) continue;
        const ox = Math.min(a.bbox.maxX, b.bbox.maxX) - Math.max(a.bbox.minX, b.bbox.minX);
        const oy = Math.min(a.bbox.maxY, b.bbox.maxY) - Math.max(a.bbox.minY, b.bbox.minY);
        if (ox > EPS && oy > EPS) {
          zoneOverlaps.push({ a: a.id, b: b.id, overlapX: +ox.toFixed(1), overlapY: +oy.toFixed(1) });
        }
      }
    }

    // ---- 成员越界（成员图形超出所属 zone 的可视化框） ----
    const containmentViolations = [];
    for (const z of zones) {
      const decl = decls.get(z.id); if (!decl) continue;
      for (const m of decl.members || []) {
        let mb = null;
        if (zoneById.has(m)) mb = zoneById.get(m).bbox;
        else if (layout.nodes[m]) {
          const n = layout.nodes[m];
          mb = { minX: n.left, minY: n.top, maxX: n.right, maxY: n.bottom };
        }
        if (!mb) continue;
        if (mb.minX < z.bbox.minX - EPS || mb.minY < z.bbox.minY - EPS ||
            mb.maxX > z.bbox.maxX + EPS || mb.maxY > z.bbox.maxY + EPS) {
          containmentViolations.push({ zone: z.id, member: m });
        }
      }
    }

    // ---- 根区域的行几何。分两个独立指标，因为它们回答的是两个不同的问题：
    //   rowClearances —— 相邻两行主组之间的净空，也就是 rowGap 实际控制的那个量。**不含
    //     satelliteOf 旁挂成员**：把整行(含旁挂)压成一个全宽包围盒去做一维投影比较，会
    //     产生假警报——一个竖跨多行的旁挂区域(参考图里的"网络安全区"就是)贴在最左边时，
    //     垂直方向必然跟相邻行交叠，但水平方向离得远、根本不碰；而合并后的行盒横跨全宽,
    //     连"水平方不方向重叠"都没法再区分出来。所以这里只量主组,让这个数干净可信。
    //   satelliteOverflows —— 旁挂成员是否真的撞到别的行。布局阶段有意不让旁挂撑大行高
    //     (保持"高区域侧挂跨行"的紧凑画法)，代价就是它可能溢出到相邻行的地盘，这里用真正
    //     的二维矩形求交去判定,只报真碰撞。 ----
    const memberIds = new Set(parentOf.keys());
    const satelliteOf = new Map();
    for (const d of model.devices) if (d.satelliteOf) satelliteOf.set(d.id, d.satelliteOf);
    for (const z of (model.zones || [])) if (z.satelliteOf) satelliteOf.set(z.id, z.satelliteOf);

    const boxOf = (id) => {
      if (zoneById.has(id)) return zoneById.get(id).bbox;
      const n = layout.nodes[id];
      return n ? { minX: n.left, minY: n.top, maxX: n.right, maxY: n.bottom } : null;
    };
    const tierOf = (id) => {
      const z = decls.get(id);
      if (z) return z.tier == null ? 0 : z.tier;
      const d = model.devices.find(x => x.id === id);
      return d && d.tier != null ? d.tier : 0;
    };

    // 根区域的直接孩子(不含被 zone 收编的)，拆成主组/旁挂两拨
    const rootIds = [];
    for (const d of model.devices) if (!memberIds.has(d.id)) rootIds.push(d.id);
    for (const z of (model.zones || [])) if (!memberIds.has(z.id)) rootIds.push(z.id);

    const rows = new Map();          // 只装主组
    const addBox = (t, box) => {
      const r = rows.get(t);
      if (!r) { rows.set(t, Object.assign({}, box)); return; }
      r.minX = Math.min(r.minX, box.minX); r.minY = Math.min(r.minY, box.minY);
      r.maxX = Math.max(r.maxX, box.maxX); r.maxY = Math.max(r.maxY, box.maxY);
    };
    for (const id of rootIds) {
      if (satelliteOf.has(id)) continue;
      const b = boxOf(id); if (!b) continue;
      addBox(tierOf(id), b);
    }

    const tiers = [...rows.keys()].sort((x, y) => x - y);
    const rowClearances = [];
    for (let i = 1; i < tiers.length; i++) {
      const prev = rows.get(tiers[i - 1]), cur = rows.get(tiers[i]);
      rowClearances.push({ fromTier: tiers[i - 1], toTier: tiers[i],
        clearance: +(cur.minY - prev.maxY).toFixed(1) });
    }

    const satelliteOverflows = [];
    for (const id of rootIds) {
      if (!satelliteOf.has(id)) continue;
      const sb = boxOf(id); if (!sb) continue;
      const ownTier = tierOf(id);
      for (const t of tiers) {
        if (t === ownTier) continue;           // 自己这一行是它的地盘,不算溢出
        const rb = rows.get(t);
        const ox = Math.min(sb.maxX, rb.maxX) - Math.max(sb.minX, rb.minX);
        const oy = Math.min(sb.maxY, rb.maxY) - Math.max(sb.minY, rb.minY);
        if (ox > EPS && oy > EPS) {
          satelliteOverflows.push({ satellite: id, intoTier: t,
            overlapX: +ox.toFixed(1), overlapY: +oy.toFixed(1) });
        }
      }
    }

    // ---- 走线穿越设备：一条链路的路径压过了非端点设备的图形 ----
    //
    // 2026-07-28 由真实用户在第一轮反馈里指出（"服务器2/4/6连接交换机的线都被压住了"）。
    // 此前几何测量的四项全是设备/zone 的矩形关系，**没有一项跟连线有关**——线穿设备时
    // DRC 照样 100 分、几何全清，只有人眼能看出来。
    //
    // 典型成因：一列设备竖排时（server-1 在上、server-2 在下），交换机到下面那台的连线
    // 必然穿过上面那台的盒子。这不是"错误"（有些画法就是允许压线），所以按本模块的一贯
    // 原则**只报事实、不打分、不进 findings**，判断留给 agent。
    //
    // 两种走线都能查：direct 是 aAnchor→bAnchor 一段直线，orthogonal 是 route 折线的每一段。
    const linkCrossings = [];
    for (const l of (layout.links || [])) {
      const pts = l.route && l.route.length >= 2
        ? l.route
        : (l.aAnchor && l.bAnchor ? [l.aAnchor, l.bAnchor] : null);
      if (!pts) continue;

      const crosses = [];
      for (const id in layout.nodes) {
        if (id === l.a || id === l.b) continue; // 自己的两个端点不算
        const n = layout.nodes[id];
        // 内缩 EPS：贴着别人边缘擦过去不算压住，只有真的进到框里才报
        const box = { x1: n.left + EPS, y1: n.top + EPS, x2: n.right - EPS, y2: n.bottom - EPS };
        if (box.x2 <= box.x1 || box.y2 <= box.y1) continue;
        for (let i = 0; i + 1 < pts.length; i++) {
          if (segIntersectsBox(pts[i], pts[i + 1], box)) { crosses.push(id); break; }
        }
      }
      if (crosses.length) crosses.sort();
      if (crosses.length) linkCrossings.push({ a: l.a, b: l.b, type: l.type, crosses });
    }

    // ---- column 布局分出了多列：说出这个事实，因为它最容易跟"上下堆叠"的意图搞反 ----
    //
    // column 里 tier 是"第几列"不是"第几行"：成员写不同 tier 会得到并排的多列。这是**有意
    // 设计并测试过的能力**（verify-regions ⑱ 锁了列间净空和跨列垂直居中），不是 bug，所以
    // 不能硬报错。但它也是本项目见过的最隐蔽的沉默失败之一——
    //
    // 2026-07-28 真实 agent 想要"交换机一行、服务器一行"，写成 column + 两个不同 tier 的子
    // zone，得到并排两列。用户连说两轮"还是在同一排"，agent 却在改 zone 的 type、改嵌套层数,
    // 唯独没碰那个真正决定形态的字段——因为 DRC 满分、几何全清、图也画得出来，没有任何东西
    // 指向它。SKILL.md 里有带 ⚠ 的警告和完整反例，它读了照样写反。
    //
    // 所以这里只陈述事实："这个 column zone 分出了 N 列，各列成员是谁"。想要多列的作者看到
    // 就是确认；想要堆叠的作者看到 columns>1 立刻就知道错在哪。判断留给 agent，跟本模块其余
    // 各项一样不打分、不进 findings。
    const columnFanouts = [];
    for (const z of (model.zones || [])) {
      if ((z.layout || "row") !== "column") continue;
      const byTier = new Map();
      for (const mid of (z.members || [])) {
        const decl = decls.get(mid) || (model.devices || []).find(d => d.id === mid);
        const t = (decl && decl.tier != null) ? decl.tier : 0;
        if (!byTier.has(t)) byTier.set(t, []);
        byTier.get(t).push(mid);
      }
      if (byTier.size > 1) {
        const tiers = [...byTier.keys()].sort((a, b) => a - b);
        columnFanouts.push({
          zone: z.id,
          columns: byTier.size,
          byTier: tiers.map(t => ({ tier: t, members: byTier.get(t) })),
        });
      }
    }

    /* ⑦ 设备标签伸出所属 zone 虚框。
       布局层已经把标签宽算进占位（regions.js footprintWidth），正常情况下这里恒为空。
       留这条不是双保险,而是因为**布局修完之后仍有别的路径能把它带回来**：elk 引擎那条、
       meta 覆盖、agent 手写 w/h,以及文本宽度只能估（布局层没有字体度量）。
       这类缺陷的特征正是"图画得出来、文件也合法、只有量一下才发现"。
       只报事实,不下结论——判断留给 skill。 */
    const labelOverflows = [];
    {
      const roles = (model.encoding && model.encoding.deviceRoles) || {};
      for (const z of (layout.zones || [])) {
        const b = z.bbox;
        if (!b) continue;
        for (const id in layout.nodes) {
          const n = layout.nodes[id];
          const r = roles[n.role] || {};
          if (r.decorative) continue;              // "…" 省略标记不画标签
          // 只看落在本 zone 里的设备（按中心点判归属，跟 containmentViolations 一致）
          if (n.cx < b.minX || n.cx > b.maxX || n.cy < b.minY || n.cy > b.maxY) continue;
          const { labelSize, roleSize } = TopoRegions.labelMetrics(n.h);
          const half = Math.max(
            TopoRegions.estimateTextWidth(n.label, labelSize),
            TopoRegions.estimateTextWidth(r.legend || n.role, roleSize)) / 2;
          const left = (b.minX - (n.cx - half)), right = ((n.cx + half) - b.maxX);
          const over = Math.max(left, right);
          if (over > EPS) {
            labelOverflows.push({
              device: id, label: n.label, zone: z.id,
              side: left >= right ? "left" : "right",
              overflowPx: Math.round(over * 10) / 10,
            });
          }
        }
      }
    }

    return { zoneOverlaps, containmentViolations, rowClearances, satelliteOverflows, linkCrossings, columnFanouts, labelOverflows };
  }

  const API = { buildGeometryReport };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.TopoGeometryReport = API;
})(typeof window !== "undefined" ? window : this);
