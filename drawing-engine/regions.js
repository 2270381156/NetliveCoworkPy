/* regions.js —— zone 递归布局：把 zones 数组（成员可以引用设备 id 也可以引用另一个 zone 的
   id，从而形成嵌套）解析成树，自底向上"测量"每个区域自己的尺寸，自顶向下"落位"成世界坐标。
   两个引擎（topo.js 的 computeLayout()、geometry-elk.mjs 的 computeElkLayout()）共用同一份
   结构逻辑，不能各写一份——这个项目已经因为"两个引擎各写一份同类推导、悄悄不同步"栽过三次
   坑（iconTheme、aPort、图标长宽比），区域递归这次范围更大，结构层必须共享。
   见设计文档 2026-07-10-topology-recursive-region-layout-design.md；净空距行铺/satelliteGap/
   per-zone与meta间距覆盖的语义见 2026-07-24-topology-layout-vocabulary-and-geometry-observe-design.md。
   浏览器：window.TopoRegions；node：module.exports。 */
(function (root) {
  "use strict";

  const MAX_ZONE_DEPTH = 2; // zone 自身允许的最大嵌套深度：L1/L2（根区域 L0 隐式，不计入）；
                            // 超过（出现 L3）是④层入口门禁硬错误，不是警告——见设计文档"深度限制"一节。

  // ---- 建树：从扁平的 zones 数组解析出父子关系,顺带做结构校验 ----
  function buildRegionTree(model) {
    const zonesById = new Map();
    for (const z of (model.zones || [])) {
      if (zonesById.has(z.id)) throw new Error(`zone id 重复声明: "${z.id}"`);
      zonesById.set(z.id, z);
    }
    const devicesById = new Map();
    for (const d of model.devices) devicesById.set(d.id, d);

    // 一个成员只能有一个直接父级——两个 zone 同时声明同一个成员是归属歧义,门禁拒绝
    const parentOf = new Map();
    for (const z of zonesById.values()) {
      for (const m of z.members || []) {
        if (parentOf.has(m)) {
          throw new Error(`"${m}" 同时被两个 zone 声明为成员: "${parentOf.get(m)}" 和 "${z.id}"，一个成员只能属于一个直接父级`);
        }
        parentOf.set(m, z.id);
      }
    }

    // 深度 + 循环引用检测：顺着 parentOf 往上走，数链长度；重复经过同一个 id 就是环
    function depthOf(zoneId, seen) {
      if (seen.has(zoneId)) throw new Error(`zone 嵌套出现循环引用: ${[...seen, zoneId].join(" -> ")}`);
      seen.add(zoneId);
      const parent = parentOf.get(zoneId);
      if (parent === undefined) return 1; // 没有父级，是顶层 zone（L1）
      if (!zonesById.has(parent)) throw new Error(`"${zoneId}" 的父级 "${parent}" 不是一个已声明的 zone`);
      return 1 + depthOf(parent, seen);
    }
    for (const z of zonesById.values()) {
      const d = depthOf(z.id, new Set());
      if (d > MAX_ZONE_DEPTH) {
        throw new Error(`zone "${z.id}" 嵌套深度超过上限(根区域L0 + 最多${MAX_ZONE_DEPTH}层显式嵌套): 实际声明深度第 L${d} 层`);
      }
    }

    function buildNode(id) {
      const z = zonesById.get(id);
      if (z) {
        if (!z.members || !z.members.length) throw new Error(`zone "${id}" 没有任何成员(members 为空)`);
        return {
          kind: "zone", id, zone: z,
          tier: z.tier, satelliteOf: z.satelliteOf || null,
          satelliteGap: z.satelliteGap != null ? z.satelliteGap : null,
          children: z.members.map(m => {
            if (!zonesById.has(m) && !devicesById.has(m)) {
              throw new Error(`zone "${id}" 引用了不存在的设备/zone 成员: "${m}"`);
            }
            return buildNode(m);
          })
        };
      }
      const d = devicesById.get(id);
      return { kind: "device", id, tier: d.tier, satelliteOf: d.satelliteOf || null,
               satelliteGap: d.satelliteGap != null ? d.satelliteGap : null };
    }

    // 根区域(L0,隐式)的直接孩子 = 没被任何 zone 引用的设备 + 没被任何 zone 引用的顶层 zone，
    // 按"declaration order = 落位顺序"排——一个 zone 的排序位置取它所有(递归)成员设备里最早
    // 出现在 devices 数组的那个的下标，跟裸设备的下标放在同一把尺子上排序。之前这里是"先拼所有
    // 裸设备、再拼所有顶层 zone"，两组内部各自保序但组间顺序固定，作者没法用声明顺序把一个zone
    // 排到某个裸设备左边（除非把裸设备也套进一个 zone 才能借道控制顺序）——同一 tier 内混了裸
    // 设备和 zone 时排出来的左右顺序，就可能跟作者实际想要的对不上。
    const deviceIndex = new Map();
    model.devices.forEach((d, i) => deviceIndex.set(d.id, i));
    function minDeviceIndex(id) {
      const z = zonesById.get(id);
      if (!z) return deviceIndex.get(id);
      return Math.min(...z.members.map(minDeviceIndex));
    }
    const rootChildIds = [
      ...model.devices.map(d => d.id).filter(id => !parentOf.has(id)),
      ...[...zonesById.keys()].filter(id => !parentOf.has(id))
    ].sort((a, b) => minDeviceIndex(a) - minDeviceIndex(b));
    return {
      kind: "zone", id: "__root__", zone: { layout: "row" }, tier: 0, satelliteOf: null,
      children: rootChildIds.map(buildNode)
    };
  }

  // ---- 测量：自底向上。每个 zone 拿到自己的直接孩子(可能混合设备和已测量的子 zone，
  // 两者对这一步来说都只是"一个有 w/h 的方块")，按 layout 字段选规则算出：
  // 每个孩子的局部坐标(相对本区域左上角) + 本区域自己的 w/h。 ----
  const MEASURERS = { row: measureRow, column: measureColumn };

  function measure(node, sizeDevice, cfg) {
    if (node.kind === "device") {
      const s = sizeDevice(node.id);
      node.w = s.w; node.h = s.h;
      // fw = 布局占位宽（含标签，见 footprintWidth）。调用方没给就退回方框宽，
      // 行为与加这个字段之前完全一致。
      node.fw = s.fw != null ? s.fw : s.w;
      // fhBelow = 方框下方标签占的高度（不对称，只往下）。不给就是 0，行为与加它之前一致。
      node.fhBelow = s.fhBelow != null ? s.fhBelow : 0;
      return;
    }
    for (const c of node.children) measure(c, sizeDevice, cfg);
    const style = (node.zone && node.zone.layout) || "row";
    const fn = MEASURERS[style];
    if (!fn) throw new Error(`zone "${node.id}" 声明了未知的 layout: "${style}"`);
    // per-zone 间距覆盖：只作用于本 zone 自己这一层的排布，不向子 zone 继承（设计决定：
    // 继承链让"这个数从哪来的"难回答；子 zone 要么自己声明、要么用全局默认——注意上面的
    // 递归调用传的是原始 cfg，不是 eff）。
    const zDecl = node.zone || {};
    const eff = Object.assign({}, cfg);
    if (zDecl.rowGap != null) eff.rowGap = zDecl.rowGap;
    if (zDecl.hGap != null) eff.hGap = zDecl.hGap;
    const result = fn(node.children, eff);
    node.localPlacements = result.placements; // Map<id, {x,y}>：局部坐标，左上角，相对本区域左上角
    node.w = result.w; node.h = result.h;
    // zone 自己的标签画在框内顶部，不外扩；占位等于框本身
    node.fw = result.w;
    node.fhBelow = 0;
    if (node.id === "__root__") {
      // 根区域(L0)自己永远不会被别的父级当"方块"消费——它的 box 最后会被 layoutRegions 删掉
      // (delete boxes.__root__)，所以它的直接孩子不需要"从本区域左上角=0"这个归一化(那是为了让
      // 上层能把子 zone 当一个从(0,0)起的方块摆放而做的)。保留 measureRow 算出来的原始(未归一化、
      // 以居中游标为基准)坐标，这样根区域下的内容才能保持"跟 topo.js 现有对称行为一致"——左右对称
      // 于世界坐标原点，而不是整体被搬到从 x=0 起的位置。position 覆盖不受影响：place() 的覆盖分支
      // 不读 localPlacements，直接用 ox + dx。
      const raw = new Map();
      for (const [id, p] of node.localPlacements) raw.set(id, { x: p.x + result.minX, y: p.y + result.minY });
      node.localPlacements = raw;
    }
  }

  // "row" 规则：按 tier 分行，行与行之间保证 rowGap 的净空(clearance)——每行的顶边 =
  // 上一行的底边 + rowGap，行高 = 该行主组最高孩子的高度，行内孩子垂直居中。
  // tier 从此是纯序数：只决定行的先后，数值间隔不产生空间效果（旧的中心距语义会让高内容
  // 吃穿留白直到重叠，参考图重画时"计算区域/存储区域框重叠-8px"就是这个根因，见设计文档
  // 2026-07-24）。每行主组整体居中于 x=0、satelliteOf 贴在锚点外侧不参与居中，与原来一致。
  // 两个有意的细节：
  // 1) satellite 贴靠偏移用 satelliteGap(缺省90)，不再借用为同行小图标设计的 hGap——锚点/
  //    卫星若都是带 ZONE_PAD 外扩的 zone，46 会被两侧各啃 18 只剩 10 可视留白。
  // 2) satellite 不参与行高计算——旁挂的高区域（如竖排的网络安全区）允许纵向溢出到相邻行的
  //    侧边空间（参考图就是这种画法），不把整张图撑高；溢出是否撞到东西由 geometry-report
  //    量出来交给 agent 判断，不在这里硬约束。
  function measureRow(children, cfg) {
    // 兜底字面量 46/78/90 必须与 topo.js CFG 的 H_GAP/ROW_GAP/SATELLITE_GAP 数值一致，改一处必须同步另一处
    const hGap = (cfg && cfg.hGap != null) ? cfg.hGap : 46;
    const rowGap = (cfg && cfg.rowGap != null) ? cfg.rowGap : 78;
    const satGap = (cfg && cfg.satelliteGap != null) ? cfg.satelliteGap : 90;

    const byTier = new Map();
    for (const c of children) {
      const t = c.tier == null ? 0 : c.tier;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t).push(c);
    }
    const tiers = [...byTier.keys()].sort((a, b) => a - b);

    const cx = new Map(), cy = new Map();
    let rowTop = 0;
    for (const t of tiers) {
      const row = byTier.get(t);
      const primary = row.filter(c => !c.satelliteOf);
      const satellites = row.filter(c => c.satelliteOf);
      // 行高只看主组；整行全是 satellite 的退化情况用全体成员兜底（不然行高是 -Infinity）
      const rowH = primary.length ? Math.max(...primary.map(c => c.h))
                                  : Math.max(...row.map(c => c.h));
      const mid = rowTop + rowH / 2;

      // 用 fw（含标签的占位宽）而不是 c.w：标签比方框宽时,按方框宽排会让相邻设备的标签
      // 挨在一起、并且伸出 zone 虚框（实测 14.8px）。fw 缺省等于 c.w,不设时行为不变。
      const total = primary.reduce((s, c) => s + c.fw, 0) + hGap * Math.max(0, primary.length - 1);
      let cursor = -total / 2;
      for (const c of primary) {
        cx.set(c.id, cursor + c.fw / 2);   // 方框水平居中于占位,占位中心即方框中心
        cy.set(c.id, mid);
        cursor += c.fw + hGap;
      }
      for (const c of satellites) {
        const anchor = children.find(x => x.id === c.satelliteOf);
        if (!anchor) throw new Error(`"${c.id}" 的 satelliteOf 指向的兄弟不存在: "${c.satelliteOf}"`);
        const anchorCx = cx.get(anchor.id);
        if (anchorCx === undefined) throw new Error(`"${c.id}" 的 satelliteOf 指向的兄弟 "${c.satelliteOf}" 还没有坐标(可能不在同一 tier)`);
        const gap = c.satelliteGap != null ? c.satelliteGap : satGap;
        const outward = anchorCx >= 0 ? 1 : -1;
        const anchorLeft = anchorCx - anchor.w / 2, anchorRight = anchorCx + anchor.w / 2;
        cx.set(c.id, outward > 0 ? anchorRight + gap + c.w / 2 : anchorLeft - gap - c.w / 2);
        cy.set(c.id, mid);
      }
      rowTop += rowH + rowGap;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of children) {
      // 容器范围也用 fw：zone 的 bbox 由它派生,不含标签的话虚框仍然包不住标签
      const l = cx.get(c.id) - c.fw / 2, r = cx.get(c.id) + c.fw / 2;
      // 底边要含标签（fhBelow）：zone 的 bbox 由容器范围派生，不含的话虚框会压住文字
      const top = cy.get(c.id) - c.h / 2, bot = cy.get(c.id) + c.h / 2 + (c.fhBelow || 0);
      minX = Math.min(minX, l); maxX = Math.max(maxX, r);
      minY = Math.min(minY, top); maxY = Math.max(maxY, bot);
    }
    const placements = new Map();
    for (const c of children) {
      placements.set(c.id, { x: cx.get(c.id) - c.w / 2 - minX, y: cy.get(c.id) - c.h / 2 - minY });
    }
    return { placements, w: maxX - minX, h: maxY - minY, minX, minY };
  }

  // "column" 规则：measureRow 的转置——tier 决定第几列（从左到右），同 tier 孩子在列内
  // 纵向堆叠、垂直居中于 y=0；列与列之间保证 hGap 净空，列内上下之间保证 rowGap 净空
  // （rowGap=垂直净空、hGap=水平净空，两种 layout 里含义一致）。
  // v1 不支持 satelliteOf 成员：转置后旁挂语义（贴上侧还是下侧）需要单独设计，遇到硬报错
  // （宁可报错不可歪画），有真实需求再补。
  function measureColumn(children, cfg) {
    // 兜底字面量同 measureRow：46/78 必须与 topo.js CFG 的 H_GAP/ROW_GAP 一致（这里没有
    // satelliteGap——satelliteOf 在下面直接抛错，取不到那一步）
    const hGap = (cfg && cfg.hGap != null) ? cfg.hGap : 46;
    const rowGap = (cfg && cfg.rowGap != null) ? cfg.rowGap : 78;
    for (const c of children) {
      if (c.satelliteOf) throw new Error(`column 布局暂不支持 satelliteOf(成员 "${c.id}")`);
    }

    const byTier = new Map();
    for (const c of children) {
      const t = c.tier == null ? 0 : c.tier;
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t).push(c);
    }
    const tiers = [...byTier.keys()].sort((a, b) => a - b);

    const cx = new Map(), cy = new Map();
    let colLeft = 0;
    for (const t of tiers) {
      const col = byTier.get(t);
      const colW = Math.max(...col.map(c => c.fw));   // 同 measureRow：列宽要容得下标签
      const mid = colLeft + colW / 2;
      const total = col.reduce((s, c) => s + c.h, 0) + rowGap * Math.max(0, col.length - 1);
      let cursor = -total / 2;
      for (const c of col) {
        cy.set(c.id, cursor + c.h / 2);
        cx.set(c.id, mid);
        cursor += c.h + rowGap;
      }
      colLeft += colW + hGap;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of children) {
      // 容器范围也用 fw：zone 的 bbox 由它派生,不含标签的话虚框仍然包不住标签
      const l = cx.get(c.id) - c.fw / 2, r = cx.get(c.id) + c.fw / 2;
      // 底边要含标签（fhBelow）：zone 的 bbox 由容器范围派生，不含的话虚框会压住文字
      const top = cy.get(c.id) - c.h / 2, bot = cy.get(c.id) + c.h / 2 + (c.fhBelow || 0);
      minX = Math.min(minX, l); maxX = Math.max(maxX, r);
      minY = Math.min(minY, top); maxY = Math.max(maxY, bot);
    }
    const placements = new Map();
    for (const c of children) {
      placements.set(c.id, { x: cx.get(c.id) - c.w / 2 - minX, y: cy.get(c.id) - c.h / 2 - minY });
    }
    return { placements, w: maxX - minX, h: maxY - minY, minX, minY };
  }

  // ---- 落位：自顶向下。父级已经在测量阶段给每个孩子分配了局部偏移量，
  // 父偏移量 + 子局部坐标 = 子的世界坐标；孩子有 position 覆盖时跳过规则算出来的偏移量。 ----
  function place(node, ox, oy, out) {
    out[node.id] = { x: ox, y: oy, w: node.w, h: node.h };
    if (node.kind === "device") return;
    for (const c of node.children) {
      const local = node.localPlacements.get(c.id);
      let cx = ox + local.x, cy = oy + local.y;
      if (c.zone && c.zone.position) { cx = ox + c.zone.position.dx; cy = oy + c.zone.position.dy; }
      place(c, cx, cy, out);
    }
  }

  // ---- 对外入口：一次性建树+测量+落位，拿到每个 id(设备或 zone)在世界坐标下的 {x,y,w,h}，
  // 以及父先于子的绘制顺序(zone id 列表，供 drawZones 用，修掉"父zone声明在子zone后面
  // 时整个盖住子zone"的绘制顺序 bug)。 ----
  function layoutRegions(model, sizeDevice, cfg) {
    const tree = buildRegionTree(model);
    measure(tree, sizeDevice, cfg);
    const boxes = {};
    place(tree, 0, 0, boxes);
    delete boxes.__root__;

    const zoneOrder = [];
    (function walk(node) {
      if (node.kind === "zone" && node.id !== "__root__") zoneOrder.push(node.id);
      if (node.children) for (const c of node.children) walk(c);
    })(tree);

    return { boxes, zoneOrder };
  }

  // meta 下的④层布局作者化字段 → CFG 覆盖（设计文档 2026-07-24；同时了结 07-08 开放问题12
  // 高优先级三项）。统一放在这里给两个引擎共用，不在各自调用点手写一份。
  function metaLayoutOverrides(model) {
    const m = (model && model.meta) || {};
    const o = {};
    if (m.rowGap != null) o.ROW_GAP = m.rowGap;
    if (m.hGap != null) o.H_GAP = m.hGap;
    if (m.zonePad != null) o.ZONE_PAD = m.zonePad;
    if (m.shapeBuffer != null) o.SHAPE_BUFFER = m.shapeBuffer;
    return o;
  }

  // CFG(大写键) → layoutRegions 的 cfg(小写键) 映射。两个引擎都必须用这个函数而不是手写
  // 字面量——手写的字段白名单在 CFG 加新键时会悄悄漏传(iconTheme/aPort 两次栽过的同款坑)。
  function layoutOptsFromCfg(cfg) {
    return { hGap: cfg.H_GAP, rowGap: cfg.ROW_GAP, satelliteGap: cfg.SATELLITE_GAP };
  }

  // 导出给 cli.js 做入口参数校验用：作者写了不支持的 layout 是**参数问题**，该报 BAD_ARGS
  // 而不是 LAYOUT_FAILED（计算失败）。两类错误分开，调用方才能按错误码正确分支——跟
  // routing 校验同一个理由。清单从这里取，不在 cli 侧另抄一份。
  const SUPPORTED_LAYOUTS = Object.keys(MEASURERS);

  /* ── 设备标签的视觉占位 ────────────────────────────────────────────────────
     标签是设备视觉占位的一部分,但它画在方框**外面**(有图标时在框下方),所以方框尺寸
     不等于占位尺寸。这套公式必须只有一份:draw-core.js 按它画,布局按它留位置。
     各写一遍就是本项目反复踩的"两份实现、不同步不会失败"。

     实测复现(2026-07-29):长标签 + 靠 zone 边缘的设备 → 标签横向伸出 zone 虚框 14.8px。
     根因是 regions.js 按方框宽排列、topo.js 按方框包围盒加 ZONE_PAD,标签宽度从未参与。 */

  // 字号从方框高派生(draw-core 原有取值,搬过来集中管理)
  function labelMetrics(nodeH) {
    return {
      labelSize: Math.max(7, Math.min(12.5, nodeH * 0.27)),
      roleSize: Math.max(5.5, Math.min(8.5, nodeH * 0.185)),
    };
  }

  // 两行文字的基线偏移。有图标时挪到框外下方避免遮挡图标;没图标时居中在框内。
  function labelOffsets(nodeH, hasIcon) {
    const { labelSize, roleSize } = labelMetrics(nodeH);
    return hasIcon
      ? { labelDy: labelSize * 0.9, roleDy: labelSize * 1.9, hasIcon: true }
      : { labelDy: -roleSize * 0.65, roleDy: labelSize * 0.62, hasIcon: false };
  }

  /* 文本宽度估算。布局层没有字体度量(无 DOM、无 canvas),只能估。
     刻意估**偏宽**:虚线分组框略宽无害,而估窄了标签就会露在框外——那正是要修的问题。
     CJK 按 1.0em、其余按 0.6em(常见无衬线字体的数字/大写字母约 0.55~0.6em)。 */
  const CJK_RE = /[⺀-鿿＀-￯　-〿]/;
  function estimateTextWidth(s, size) {
    let w = 0;
    for (const ch of String(s == null ? "" : s)) w += CJK_RE.test(ch) ? 1.0 : 0.6;
    return w * size;
  }

  /* 设备的布局占位宽度。标签水平居中于方框,所以占位相对方框是**对称**的,
     取 max(方框宽, 最宽那行文字) 即可,方框中心 = 占位中心,不需要额外偏移。
     纵向暂不处理:实测行间净空还有 47px 余量(ROW_GAP=78 减去标签约 19 与字号),
     等真出现纵向溢出再动——那会让占位变成不对称的,复杂度高得多。 */
  function footprintWidth(boxW, boxH, label, roleText, hasIcon) {
    const { labelSize, roleSize } = labelMetrics(boxH);
    if (!hasIcon) return boxW;   // 无图标时文字在框内,不外扩
    return Math.max(boxW,
      estimateTextWidth(label, labelSize),
      estimateTextWidth(roleText, roleSize));
  }

  /* 标签在方框**下方**占的高度。纵向占位跟横向不同——它是**不对称**的（标签只往下挂），
     所以不能像 fw 那样取 max 了就完事，得单独给一个"向下多占多少"。
     数值 = 两行文字 + 行距，与 export-pptx.js 给标签文本框的高度是同一个数——两处各写
     一遍就会出现"框按 A 算、文字按 B 排"，而这正是 zone 边框压住文字的直接原因。 */
  function labelExtentBelow(nodeH, hasIcon) {
    if (!hasIcon) return 0;                 // 没图标时文字排在方框内，不外扩
    const { labelSize, roleSize } = labelMetrics(nodeH);
    return (labelSize + roleSize) * 1.45;
  }

  /* 一条链路的**出线轴**：由它两端设备的**最近公共祖先 zone** 的 layout 决定。

     为什么是"链路的"而不是"设备的"：同一台设备的不同链路跨越的是不同层级的分层。
     A1 在 DC-A 内（row 分层）、DC-A 与 DC-B 被父 zone 横排（column）：
       A1→A2（同 DC 内跨层）公共祖先是 DC-A(row)     → 上下
       A1→B1（跨 DC）      公共祖先是父 zone(column) → 左右
     按"设备有一个轴"是判不出来的——这是本函数上一版（layeringAxis，按设备直接父 zone 取轴）
     的缺陷:嵌套建模时设备的直接父都是 row，跨 DC 链路又变回上下出线。

     这条规则把"端口出线边"从一个需要调的经验规则变成了结构推导:布局本来就是按 zone
     递归做的（measure/place），端口判定原来却是平的、只看裸坐标——不对称正是根源。
     按公共祖先取轴之后不需要 |dx| vs |dy| 比大小、不需要 tiebreak、不需要新字段，
     两种建模方式都对，且没有 zone 或 zone 未声明 layout 时退化成隐式根区域的 row，
     与改这条之前的行为完全一致。

     返回 (devA, devB) => "vertical" | "horizontal"。 */
  function layeringAxisFor(model) {
    const parentOf = new Map();
    const zonesById = new Map();
    for (const z of (model && model.zones) || []) {
      zonesById.set(z.id, z);
      for (const m of (z.members || [])) parentOf.set(m, z.id);
    }
    // 从设备往上到根的 zone 链（近→远）。zone 深度上限 L2，链很短。
    const chainOf = (id) => {
      const out = [];
      let cur = parentOf.get(id);
      while (cur !== undefined && zonesById.has(cur)) {
        out.push(cur);
        cur = parentOf.get(cur);
      }
      return out;
    };
    const cache = new Map();
    return function axisOf(a, b) {
      const key = a < b ? a + "|" + b : b + "|" + a;
      if (cache.has(key)) return cache.get(key);
      const ca = chainOf(a), cb = new Set(chainOf(b));
      let lca = null;
      for (const z of ca) if (cb.has(z)) { lca = z; break; }
      // 没有公共 zone → 隐式根区域（L0，layout 固定 row）→ 纵向
      const z = lca ? zonesById.get(lca) : null;
      const axis = (z && z.layout === "column") ? "horizontal" : "vertical";
      cache.set(key, axis);
      return axis;
    };
  }

  /* ── 图例图示的尺寸 ──────────────────────────────────────────────────────
     原来是写死的 20×12（渲染侧）+ H_SWATCH_ADVANCE=26（布局侧），两处各写一份。
     两个问题:
     ① **大小不齐**。20×12 的框长宽比 1.67，而实测本库图标 aspect 1.045~1.952，
        配 preserveAspectRatio="meet" 之后每个图标的实际大小都不同、且都小于框——
        1.22 的只画到 14.6×12，1.95 的只画到 20×10.3。
     ② 作者调不了整体大小（LEGEND_CFG 是模块级 const，metaLayoutOverrides 也不认）。

     解法:**按图标自己的长宽比填满高度**（大小齐了），而**预留框按最宽的算**
     （文字左缘对齐）。

     2026-07-31 修一个真 bug（放大 legendIconSize 时条目"里紧外松"反转）：

     条目的视觉分组靠的是"图示到自己文字的间隙 < 本条目到下一条目的间隙"。原来
     **只有前者跟着 h 缩放**（advance = boxW + h×GAP_RATIO），后者是 LEGEND_CFG 里写死的
     H_ITEM_GAP=18。于是 h 一大，图示离自己的文字比离下一个图标还远，读起来变成
     「图标1————文字1-图标2————文字2」，文字被归到了下一个图标那边。
     实测 aspect=1.22 的图标：h=12 时 15.3 < 18（勉强对），h=20 就是 25.6 > 18（已反转），
     **h>14 一律反转**。缺省值正好卡在刚好还对，所以此前测不出来。

     两处一起改:
     ① itemGap 也从 h 派生（ITEM_GAP_RATIO=1.5，h=12 时算出来正好还是原来的 18）；
     ② 预留框改成按**这张图实际用到的最宽图标**算，不再用常数 2.0。原来那个常数意味着
        一张全是 aspect≈1.2 图标的图，64% 的预留宽度是空的——h=12 时浪费 9px 看不出来，
        h=36 时就是 28px，正是它把①放大成了肉眼可见的错位。
        （当初图省事用常数，是为了不把 icons 传进 deriveLegend；现在传了。）

     ---- 2026-07-31 第二轮：改成**固定统一框，按需缩放** ----

     第一轮把预留框改成"按这张图实际用到的最宽图标算"，只在图标宽度接近时有效。实测一张
     典型图：6 个角色里 5 个 aspect 1.222，只有 internet（云形）1.952 —— 它一个把框撑到
     23.4，其余 5 个画出来才 14.7，**离文字 14.8（空隙跟图标本身一样宽）**；而链路线段铺满
     框（23.4）就成了设备图标的 1.6 倍。用户两条观感反馈说的都是这个。

     根因是第一轮仍沿用了"图示填满**高度**"（高度齐 → 宽度不齐 → 必须有个按最宽算的框）。
     一个离群值就毁掉全组。

     现在的规则只有一条：**所有图示（设备图标、链路线段、接口标记、zone 框）共用一个固定
     预留框 boxW × iconH，内容按 preserveAspectRatio="meet" 缩放进去。**

     - 间距变成常数（`advance - 图示宽`），不再随某个图标的 aspect 漂移；
     - 链路线段 = boxW，跟设备图标同宽（实测 1.02 倍，此前 1.6 倍）；
     - `maxAspect` 那条从 deriveLegend 一路传到渲染侧的管线**整条删掉**，少一处要同步的地方。

     BOX_ASPECT=1.25 是照实测定的：**全库 35 个图标里 29 个 aspect 恰好是 1.222**
     （25%/中位/75% 全是它），离群的只有 6 个（1.045/1.3/1.4/1.5/1.6/1.952）。
     所以绝大多数图标几乎正好填满这个框。

     **代价（有意接受）**：宽于 1.25 的图标改由宽度定尺寸，会比别的矮——最极端的 internet
     在 h=12 时画成 15×7.7 而不是 23.4×12。它是 35 个里唯一一个，且不是"设备"图标
     （catalog 里 deviceType=false），矮一点比把整组的间距拖垮划算。 */
  const LEGEND = {
    ICON_H: 12,          // 图示目标高度，meta.legendIconSize 可覆盖
    BOX_ASPECT: 1.25,    // 统一预留框的长宽比。实测全库 35 个图标里 29 个 aspect=1.222
    GAP_RATIO: 0.5,      // 图示框到文字的间隙 / 图示高度
    ITEM_GAP_RATIO: 1.5, // 条目之间的间隙 / 图示高度。必须 > GAP_RATIO 才能"里紧外松"
                         // （框统一之后这个条件是恒成立的，不再依赖任何图标的 aspect）
  };
  function legendMetrics(size) {
    const h = (Number(size) > 0) ? Number(size) : LEGEND.ICON_H;
    const boxW = h * LEGEND.BOX_ASPECT;
    return {
      iconH: h,
      boxW,                                    // 统一预留宽度：四类图示共用
      advance: boxW + h * LEGEND.GAP_RATIO,     // 从图示左缘到文字左缘
      itemGap: h * LEGEND.ITEM_GAP_RATIO,       // 横向模式：条目之间的额外间距
      rowH: h * 1.25,                           // 竖列模式行高（size=12 时正好是原来的 15）
      hRowH: h * 1.5,                           // 横向模式行高（size=12 时正好是原来的 18）
    };
  }
  // 单个图示的实际绘制尺寸：等比缩放**装进**统一框（宽高都不超框），即 SVG 的
  // preserveAspectRatio="meet"。宽于框的按宽度定、其余按高度定。
  function legendSwatchSize(aspect, lm) {
    const a = (Number(aspect) > 0) ? Number(aspect) : LEGEND.BOX_ASPECT;
    const s = Math.min(lm.boxW / a, lm.iconH);   // 缩放后的高度
    return { w: a * s, h: s };
  }

  /* ── 线宽 ────────────────────────────────────────────────────────────────
     为什么要集中管：SVG 用 vector-effect="non-scaling-stroke"，线宽永远是**屏幕像素**、
     不随图缩放；而 vsdx/pptx 是绝对单位，把同一个数如实换算过去就显得粗——SVG 那边其实
     一直在作弊。三个输出各自写死数值的话，调一处另两处不动，正是本项目反复踩的坑。

     STROKE_SCALE 是给绝对单位输出用的收细系数。0.6 是照"pptx 里看着跟 SVG 差不多"定的
     经验值：1.6px 如实换算是 1.2pt，乘 0.6 后 0.72pt。 */
  const STROKE = {
    ZONE: 0.8,        // zone 虚线框（原 1.4，实测偏粗）
    DEVICE_BOX: 1.0,  // 无图标时的设备方框（原 1.4）
    LINK_DEFAULT: 1.6,
    SCALE: 0.6,
  };
  // px → pt（96dpi 下 1px = 0.75pt），并应用收细系数
  const strokePt = (px, scale) =>
    (px == null ? STROKE.LINK_DEFAULT : px) * 0.75 * (scale == null ? STROKE.SCALE : scale);

  /* 渲染侧的作者化开关。放这里而不是各输出各读一遍 model.meta，是因为**默认值必须只有
     一份**——三个输出各写一个默认，作者不设时三边表现就会不一致。
     只收"没有正确答案、属于作者视觉意图"的那几个；字号刻意不开放：它由设备高派生，
     而布局给标签留的位置（footprintWidth/labelExtentBelow）正是按它算的，开放字号就得
     让布局跟着字号走——那是今天连修两处的地方，不值得为了一个选项再引一次风险。 */
  function renderOptions(model) {
    const m = (model && model.meta) || {};
    const scale = Number(m.strokeScale);
    return {
      // zone 边框圆角。缺省方角——实测圆角在密集图里跟网元挨得近时更容易看错边界。
      zoneCorner: m.zoneCorner === "round" ? "round" : "square",
      // 端口小圆是否画。缺省画；用户只要拓扑结构、不关心接口时可以关掉。
      // 注意：**只影响 SVG/HTML**，vsdx/pptx 本来就不画端口标记（它们进不了"可编辑"的语义）。
      showPorts: m.showPorts !== false,
      // 全局线宽系数。缺省 STROKE.SCALE(0.6)，见上面那段为什么绝对单位输出要收细。
      strokeScale: Number.isFinite(scale) && scale > 0 ? scale : STROKE.SCALE,
      // 图例图示的目标高度。布局(deriveLegend)和渲染(drawLegendSwatch)都从这里取，
      // 只有一份——两处各读一遍 model.meta 就会出现"框按 A 算、图示按 B 画"。
      legendIconSize: (Number(m.legendIconSize) > 0) ? Number(m.legendIconSize) : LEGEND.ICON_H,
    };
  }

  const API = { labelMetrics, labelOffsets, estimateTextWidth, footprintWidth, labelExtentBelow, layeringAxisFor, legendMetrics, legendSwatchSize, STROKE, strokePt, renderOptions,

    buildRegionTree, layoutRegions, metaLayoutOverrides, layoutOptsFromCfg,
                MAX_ZONE_DEPTH, SUPPORTED_LAYOUTS };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.TopoRegions = API;
})(typeof window !== "undefined" ? window : this);
