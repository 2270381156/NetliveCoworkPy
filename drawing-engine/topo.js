/* 档 A 布局核心（纯逻辑，无 DOM）：分带放置 + 派生均匀端口。
   坐标全部在这里派生；语义数据里没有坐标。
   浏览器：window.TopoCore；node：module.exports。 */
(function (root) {
  "use strict";

  const TopoRegions = typeof module !== "undefined" && module.exports
    ? require("./regions.js") : root.TopoRegions;

  const CFG = {
    ROW_GAP: 78,   // 相邻行边缘之间的净空距(clearance)——2026-07-24 起不再是中心距，行内
                   // 内容多高都吃不掉这个留白；78 是旧中心距 122 减去典型设备高约 44 的换算，
                   // 保持既有图的视觉密度不变
    H_GAP: 46,     // 同一行内相邻元素的水平净空(本来就是净空语义,未变)
    SATELLITE_GAP: 90, // satelliteOf 贴靠偏移，独立于 H_GAP——锚点/卫星可能都是带 ZONE_PAD
                       // 外扩的 zone，46 会被两侧各啃 18 只剩 10 可视留白
    PORT_MARGIN: 0, // 端口分布是否留边（0 = 用 (i+1)/(n+1) 内插，天然留边）
    ZONE_PAD: 18,    // zone 虚框相对成员包围盒的外扩距离
    // 正交走线绕过"跟自己无关的设备"时保持的最小间距（只对 orthogonal 生效，direct 是两点
    // 直线不绕障）。libavoid 的缺省值是 4——它一直在正确绕行，但 4px 放在整张图的尺度下
    // 肉眼看着就是贴着设备边走，正是 2026-07-28 用户报的"从端口出来就与设备边界平行"。
    // 实测 4→12 是纯收益：折点总数和画布尺寸完全不变，只是绕行线离设备更远；16 以后折点
    // 开始增加（22→24→28），线要绕更远才能满足间距。所以取 12——零代价区间的上界。
    SHAPE_BUFFER: 12
  };

  // 图例内部排布常量（世界单位）。图例按 legendPosition 分两套算法（设计文档"图例面板的
  // 完整分层表达"一节）：
  //   - 左/右摆放（left/right）：竖列——标题在上、条目纵向一行一个（PANEL_W/TITLE_H/ROW_H）。
  //   - 上/下摆放（top/bottom）：横向流式换行——标题在每组左侧，条目横着排、排满主图宽度就换行、
  //     换组另起一块（H_* 那组常量 + 按字符数估算条目宽度）。
  // "组内条目数悬殊时动态拆分子列再装箱"那套更聪明的方案仍然记在开放问题 11 里，本轮不展开。
  const LEGEND_CFG = {
    PANEL_W: 170,    // 竖列模式：面板固定宽度
    PAD: 10,         // 内部四周留白
    TITLE_H: 16,     // 竖列模式：组标题行高度
    ROW_H: 15,       // 竖列模式：每个条目行高度
    GROUP_GAP: 8,    // 组与组之间的额外间距
    PANEL_GAP: 20,   // 面板跟主图 bbox 之间的间距
    // ---- 横向流式换行模式（上/下摆放）----
    H_ROW_H: 18,        // 横向模式：一行的高度
    H_LABEL_SIZE: 10.5, // 条目文字字号（跟渲染侧 drawLegendRow 的 10.5px 对齐，用于估宽）
    H_TITLE_SIZE: 11,   // 组标题字号（跟渲染侧 11px 对齐）
    H_SWATCH_ADVANCE: 26, // 条目图示占位（swatch 20 + 到文字的间隙 6，跟渲染侧 x+26 对齐）
    // H_ITEM_GAP 已删：它是唯一没跟着 legendIconSize 缩放的那个数，正是"里紧外松反转"那个
    // bug 的根源。现在由 regions.js 的 legendMetrics().itemGap 派生（h=12 时仍是 18）。
    // 留一个不再被读的旧常量在这里，下次改的人会以为它管用——所以直接删掉。
    H_TITLE_GAP: 14,    // 标题列跟条目起始列之间的间距
    H_MIN_BUDGET: 360,  // 横向可用宽度的兜底下限（主图特别窄时，别逼成一行一个）
  };

  // 没有 DOM 量不了真实文字宽度，按字符数估算：CJK/全角字符按 1 个字宽，ASCII 按 0.55 个字宽
  // （设计文档确认这个精度够用，横向换行判断不需要像素级精确）。
  function legendTextWidth(s, fontSize) {
    let w = 0;
    for (const ch of String(s)) w += (ch.charCodeAt(0) > 0xFF ? fontSize : fontSize * 0.55);
    return w;
  }

  // 图例分组 = model.encoding 的四张编码表，直接复用表名做 kind，不用另造分类词汇表
  // （设计文档"图例面板的完整分层表达"一节：这四类跟 L3 固定渲染栈里除文字层/内置Zone层
  // 之外的四层一一对应）。标题文案是这里唯一独立维护的展示细节。
  const LEGEND_GROUP_TITLES = {
    deviceRoles: "设备",
    linkTypes: "链路",
    connTypes: "接口类型",
    zoneTypes: "区域",
  };

  // 端口所在边 → 向外法线
  const SIDE_NORMAL = {
    top:    { nx: 0,  ny: -1 },
    bottom: { nx: 0,  ny: 1  },
    left:   { nx: -1, ny: 0  },
    right:  { nx: 1,  ny: 0  }
  };

  /* 从 a 指向 b 时，a 端应接在哪条边。

     规则：**跨层连接顺着分层方向出线，同层连接走垂直于分层方向的那两条边。**
     纵向分层（zone layout=row，缺省）时跨层走上下、同层走左右；
     横向分层（layout=column）时正好对调——跨层走左右、同层走上下。

     为什么不用 |dx| vs |dy| 谁大谁赢：跨层连接固定顺着分层方向出线，才不会因为两台设备
     左右偏得远就被 dx 主导、误判成侧边出线（布局越靠外侧越容易踩）。这个考虑本来就在，
     原来的问题是把"分层方向永远是纵向"写死了：只要 y 有差就上下出线。
     画两个数据中心左右互联（蝴蝶形）时，layout:"column" 确实把两个 DC 摆成了左右，
     但蝴蝶形的交叉链路仍然上下出线——2026-07-30 用户报的就是这个。

     axis 由 regions.layeringAxisFor() 给出，取**两端设备最近公共祖先 zone** 的 layout。
     是"链路的轴"而不是"设备的轴"：同一台设备的不同链路跨越的是不同层级的分层。 */
  function sideToward(na, nb, axis) {
    const dy = nb.cy - na.cy, dx = nb.cx - na.cx;
    if (axis === "horizontal") {
      if (Math.abs(dx) > 1e-6) return dx > 0 ? "right" : "left";
      return dy > 0 ? "bottom" : "top";
    }
    if (Math.abs(dy) > 1e-6) return dy > 0 ? "bottom" : "top";
    return dx > 0 ? "right" : "left";
  }

  // SOUL.md 只要求 agent 给每个角色/链路/接口类型写 legend（+critical），从不要求
  // fill/stroke/width 之类的视觉样式——这些属于"渲染"而非"语义"，应该被派生而不是被作者化。
  // 但 render.js/index.html 里不少读取点（尤其 buildLegend 的设备图例、drawEdges）本身没有
  // 兜底，缺字段时 SVG 属性变成字面量 "undefined"，浏览器按 SVG 初始值处理（fill 初始值是黑），
  // 于是图例方块、连线全变黑；drawNodes 虽有兜底但只是单一灰色，所有角色看起来一个样、无区分度。
  // 这里在布局阶段一次性把 model.encoding 里缺的样式字段按声明顺序取色补全（对象引用复用，
  // 后面 buildLegend/drawEdges/drawNodes 读到的就是补全后的同一份 encoding），保证每个不同的
  // 角色/链路类型/接口类型/区域类型都有稳定、彼此区分的颜色，不需要 agent 操心配色。
  const PALETTE = [
    { fill: "#eef2fb", stroke: "#6b83c9" },
    { fill: "#fde8e8", stroke: "#d98a8a" },
    { fill: "#e7f3ec", stroke: "#5aa27a" },
    { fill: "#fdf2e2", stroke: "#c9a06b" },
    { fill: "#f3e8fd", stroke: "#a97fd9" },
    { fill: "#e8f6fb", stroke: "#4a9fb5" },
    { fill: "#fdf8e2", stroke: "#b5a23e" },
    { fill: "#f5e9f0", stroke: "#b56b93" },
  ];
  // 按声明顺序轮转分配，撞了顺延到下一个没被占用的槽位。
  // 原来是 PALETTE[hash(key) % 8]——哈希取模**会撞**：真实 agent 画的第一张图里
  // access-switch 和 pc 就撞到同一格，接入交换机和 PC 一模一样的颜色，而上面那段注释
  // 自己声称"保证每个不同的角色都有彼此区分的颜色"——哈希取模给不了这个保证。
  // 代价：颜色不再只由名字决定，同一个角色在不同图里可能拿到不同颜色（取决于它在编码表里
  // 的声明位置）。这个代价可以接受——图例跟着图走，同一张图内稳定就够了。
  // 每个编码组各用一个分配器：角色跟链路类型共用一个颜色没问题（一个画方框底色、一个画
  // 线条），组**内**撞色才是问题。
  function makePaletteAllocator(table) {
    const taken = new Set();
    // 作者显式写死的颜色先占坑，免得自动分配的跟它撞
    for (const e of Object.values(table || {})) {
      const i = PALETTE.findIndex(p => p.fill === e.fill || p.stroke === e.stroke);
      if (i >= 0) taken.add(i);
    }
    let cursor = 0;
    return function next() {
      for (let n = 0; n < PALETTE.length; n++) {
        const i = (cursor + n) % PALETTE.length;
        if (!taken.has(i)) { taken.add(i); cursor = i + 1; return PALETTE[i]; }
      }
      // 条目数超过调色板长度，只能重复用——style-report 的 roleColorCollisions 会把这事报给 agent
      const i = cursor % PALETTE.length;
      cursor = i + 1;
      return PALETTE[i];
    };
  }

  function normalizeEncoding(model) {
    const enc = model.encoding || (model.encoding = {});
    const nextRole = makePaletteAllocator(enc.deviceRoles);
    for (const r of Object.values(enc.deviceRoles || {})) {
      // 只在真的缺颜色时才取槽位，否则两个颜色都写全的条目会白白占掉一格
      if (r.fill == null || r.stroke == null) {
        const p = nextRole();
        if (r.fill == null) r.fill = p.fill;
        if (r.stroke == null) r.stroke = p.stroke;
      }
    }
    const nextLink = makePaletteAllocator(enc.linkTypes);
    for (const t of Object.values(enc.linkTypes || {})) {
      if (t.stroke == null) t.stroke = nextLink().stroke;
      if (t.width == null) t.width = 1.6;
      if (t.bundle == null) t.bundle = 1;
    }
    const nextConn = makePaletteAllocator(enc.connTypes);
    for (const t of Object.values(enc.connTypes || {})) {
      if (t.fill == null) t.fill = nextConn().stroke; // 接口点用饱和色，跟role的浅底区分开
      if (t.shape == null) t.shape = "circle";
    }
    const nextZone = makePaletteAllocator(enc.zoneTypes);
    for (const t of Object.values(enc.zoneTypes || {})) {
      if (t.fill == null || t.stroke == null) {
        const p = nextZone();
        if (t.fill == null) t.fill = p.fill;
        if (t.stroke == null) t.stroke = p.stroke;
      }
    }
  }

  function computeLayout(model, opts) {
    // 代码默认值 < meta 作者化覆盖 < opts（程序化调用方的显式意图，优先级最高）
    // 优先级：代码默认(CFG) < 模型里的作者化 meta < 调用方 opts。注意键的大小写契约不同：
    // meta 用小写驼峰(meta.rowGap)，由 metaLayoutOverrides 翻译成大写键；opts 直接并进这个
    // 大写键的对象，所以程序化调用方必须写 opts.ROW_GAP——写 opts.rowGap 会被静默忽略。
    const cfg = Object.assign({}, CFG, TopoRegions.metaLayoutOverrides(model), opts || {});
    normalizeEncoding(model);
    const nodes = {};

    // ---- 1) 分带放置：交给 regions.js 递归算出每个设备/zone 的世界坐标 ----
    const sizeById = {};
    for (const d of model.devices) {
      const enc = Object.assign({ w: 72, h: 42 }, model.encoding.deviceRoles[d.role] || {});
      const iconInfo = enc.icon && opts && opts.icons && opts.icons[enc.icon];
      if (iconInfo && iconInfo.aspect) enc.w = enc.h * iconInfo.aspect;
      const node = {
        id: d.id, role: d.role, label: d.label, tier: d.tier,
        satelliteOf: d.satelliteOf || null,
        iconTheme: d.iconTheme || null,
        w: enc.w, h: enc.h, cx: 0, cy: 0,
        ports: { top: [], bottom: [], left: [], right: [] }
      };
      nodes[d.id] = node;
      // fw = 含标签的布局占位宽。标签水平居中于方框、可以比方框宽，不算进来的话
      // regions.js 会按方框宽排列，长标签就会挨在一起、并伸出 zone 虚框（实测 14.8px）。
      // 公式只有一份，在 regions.js，draw-core.js 画标签时调的是同一个。
      sizeById[d.id] = {
        w: enc.w, h: enc.h,
        fw: TopoRegions.footprintWidth(enc.w, enc.h, d.label, enc.legend || d.role, !!iconInfo),
        fhBelow: TopoRegions.labelExtentBelow(enc.h, !!iconInfo),
      };
    }

    const { boxes, zoneOrder } = TopoRegions.layoutRegions(model, id => sizeById[id],
      TopoRegions.layoutOptsFromCfg(cfg));

    const byTier = new Map();
    for (const id in nodes) {
      const n = nodes[id], b = boxes[id];
      n.cx = b.x + b.w / 2; n.cy = b.y + b.h / 2;
      n.left = b.x; n.right = b.x + b.w; n.top = b.y; n.bottom = b.y + b.h;
      if (!byTier.has(n.tier)) byTier.set(n.tier, []);
      byTier.get(n.tier).push(n);
    }
    const tiers = [...byTier.keys()].sort((a, b) => a - b);

    // ---- 2) 边归属：每条链路两端各自判定接在哪条边 ----
    // 出线轴是**链路的**属性（由两端的最近公共祖先 zone 决定），不是设备的——
    // 同一台设备的不同链路跨越的是不同层级的分层。详见 regions.layeringAxisFor()。
    const axisOf = TopoRegions.layeringAxisFor(model);
    const links = model.links.map(l => Object.assign({}, l));
    for (const l of links) {
      const na = nodes[l.a], nb = nodes[l.b];
      if (!na || !nb) throw new Error("链路引用了不存在的设备: " + l.a + "/" + l.b);
      const axis = axisOf(l.a, l.b);   // 同一条链路两端用同一个轴
      const sa = sideToward(na, nb, axis);
      const sb = sideToward(nb, na, axis);
      na.ports[sa].push({ link: l, end: "a", other: nb });
      nb.ports[sb].push({ link: l, end: "b", other: na });
    }

    // ---- 3) 端口排序 + 沿边均匀分布（派生锚点）----
    for (const id in nodes) {
      const n = nodes[id];
      for (const side of ["top", "bottom", "left", "right"]) {
        const arr = n.ports[side];
        if (!arr.length) continue;
        const horizontal = side === "top" || side === "bottom";
        // 按对端在该边轴向上的投影排序（减少在设备根部打绞）
        arr.sort((p, q) => horizontal ? p.other.cx - q.other.cx : p.other.cy - q.other.cy);
        const cnt = arr.length;
        for (let i = 0; i < cnt; i++) {
          const t = (i + 1) / (cnt + 1); // 内插 → 端口在该边上均匀分布
          let x, y;
          if (side === "top")    { x = n.left + t * n.w; y = n.top; }
          else if (side === "bottom") { x = n.left + t * n.w; y = n.bottom; }
          else if (side === "left")   { x = n.left; y = n.top + t * n.h; }
          else /* right */            { x = n.right; y = n.top + t * n.h; }
          const nm = SIDE_NORMAL[side];
          const anchor = { x, y, nx: nm.nx, ny: nm.ny, side };
          if (arr[i].end === "a") arr[i].link.aAnchor = anchor;
          else arr[i].link.bAnchor = anchor;
        }
      }
    }

    // ---- 4) Zone 包围盒：用 regions.js 算出的世界坐标，只在这里加渲染用的外扩留白；
    // zoneOrder 保证父 zone 排在子 zone 前面，drawZones 按数组顺序画就不会再出现
    // "父zone盖住子zone"的问题，不需要渲染侧改任何代码。 ----
    const zonesById = {};
    for (const z of (model.zones || [])) zonesById[z.id] = z;
    const zones = zoneOrder.map(id => {
      const b = boxes[id];
      return Object.assign({}, zonesById[id], {
        bbox: { minX: b.x - cfg.ZONE_PAD, minY: b.y - cfg.ZONE_PAD,
                maxX: b.x + b.w + cfg.ZONE_PAD, maxY: b.y + b.h + cfg.ZONE_PAD }
      });
    });

    /* 嵌套 zone 的边界收敛：保证父框把子框整个包进去，且中间留出一个 ZONE_PAD 的间隙。

       为什么需要这一步：bbox = 区域盒 ± ZONE_PAD，而**父 zone 的区域盒是按子 zone 的
       原始尺寸（未加 pad）算出来的**——regions.js 的 measure() 里 node.w = result.w，
       那是不含外扩的。子 zone 贴在父 zone 边缘时两者原始边重合，各自 +18 之后**两条边
       完全叠在一起**，画出来就是 L1/L2 边框重叠。
       （不在 regions.js 里把"zone 的占位含自己的 pad"算进去，是因为那会改变所有成员的
       落位坐标；这里只长外框，设备一个都不动。）

       自子到父收敛：zoneOrder 保证父在子之前，倒着遍历就先处理完子级。 */
    {
      const byId = new Map(zones.map(z => [z.id, z]));
      const parentOf = new Map();
      for (const z of (model.zones || [])) {
        for (const m of (z.members || [])) if (byId.has(m)) parentOf.set(m, z.id);
      }
      for (let i = zones.length - 1; i >= 0; i--) {
        const child = zones[i];
        const parent = byId.get(parentOf.get(child.id));
        if (!parent) continue;
        const c = child.bbox, p = parent.bbox, pad = cfg.ZONE_PAD;
        /* 每边最多长 2×pad。这个上限是必须的：无条件长大父框会把**作者用 position 把子
           zone 钉到父 zone 外面**这种真错误一并吞掉——geometry-report 的
           containmentViolations 就是专门报它的，而扩张后它永远报不出来（回归里当场红了）。
           2×pad 恰好覆盖 pad 算术带来的那点重叠（子、父各外扩 pad），真正越界的仍然越界。 */
        const cap = pad * 2;
        p.minX = Math.min(p.minX, Math.max(c.minX - pad, p.minX - cap));
        p.minY = Math.min(p.minY, Math.max(c.minY - pad, p.minY - cap));
        p.maxX = Math.max(p.maxX, Math.min(c.maxX + pad, p.maxX + cap));
        p.maxY = Math.max(p.maxY, Math.min(c.maxY + pad, p.maxY + cap));
      }
    }

    // ---- bbox（含 zone 的外扩边框，否则虚框会被 viewBox 裁掉）----
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

    // ---- 图例：永远尝试派生（除非 meta.showLegend:false），合并进整体 bbox ----
    const legend = deriveLegend(model, { minX, minY, maxX, maxY });
    if (legend) {
      minX = Math.min(minX, legend.bbox.minX); minY = Math.min(minY, legend.bbox.minY);
      maxX = Math.max(maxX, legend.bbox.maxX); maxY = Math.max(maxY, legend.bbox.maxY);
    }
    return { nodes, links, zones, bbox: { minX, minY, maxX, maxY }, tiers, legend };
  }

  // 图例投影：扫描实际用到的编码 token
  function usedEncodings(model) {
    const roles = new Set(model.devices.map(d => d.role));
    const linkT = new Set(model.links.map(l => l.type));
    const connT = new Set();
    for (const l of model.links) { if (l.aConn) connT.add(l.aConn); if (l.bConn) connT.add(l.bConn); }
    const zoneT = new Set((model.zones || []).map(z => z.type));
    return { roles: [...roles], linkTypes: [...linkT], connTypes: [...connT], zoneTypes: [...zoneT] };
  }

  // 图例派生：给定主图已经算好的 bbox，算出图例面板的外部包围盒 + 内部每一行的绝对世界坐标。
  // meta.showLegend/legendPosition/legendGroups 都是作者化的④层提示字段（跟 meta.layoutDirection
  // 同类，会真正改变这里算出来的坐标结果），不是 render_html 的调用参数——设计文档"图例面板的
  // 完整分层表达"一节有完整推导过程。两个布局引擎（本文件的 computeLayout()、geometry-elk.mjs
  // 的 computeElkLayout()）都要调用这同一个函数，不能各写一份，否则又是一次 iconTheme/aPort 那种
  // "两个引擎悄悄不同步"的坑。
  function deriveLegend(model, mainBbox) {
    const meta = model.meta || {};
    if (meta.showLegend === false) return null; // 没有图例区域是一个结构性事实，不是"算了但不画"

    const used = usedEncodings(model);

    /* 图例的尺寸字段全部从图示高度派生，不再写死——作者可用 meta.legendIconSize 整体调。
       缺省 12 时 rowH/hRowH/itemGap 算出来正好是原来的 15/18/18。
       预留框是**固定长宽比**的统一框（不跟任何图标的 aspect 走），四类图示共用，图标等比
       缩放装进去。这样"图示到自己文字"的间距是常数，链路线段也跟设备图标同宽。
       整套取值与取舍见 regions.js 的 LEGEND 注释。 */
    const lm = TopoRegions.legendMetrics(TopoRegions.renderOptions(model).legendIconSize);
    const usedByKind = {
      deviceRoles: used.roles, linkTypes: used.linkTypes,
      connTypes: used.connTypes, zoneTypes: used.zoneTypes,
    };
    const groupOrder = meta.legendGroups || ["deviceRoles", "linkTypes", "connTypes", "zoneTypes"];
    const enc = model.encoding || {};
    const labelOf = (kind, key) => ((enc[kind] || {})[key] || {}).legend || key;

    // ---- 先把"要展示哪些分组、每组有哪些条目"定下来（跟排布算法无关）----
    const active = [];
    for (const kind of groupOrder) {
      if (!LEGEND_GROUP_TITLES[kind]) continue; // 未知 kind 直接跳过，不报错
      const keys = usedByKind[kind] || [];
      if (!keys.length) continue; // 这个分组实际没有条目，不占版面
      active.push({ kind, title: LEGEND_GROUP_TITLES[kind],
        items: keys.map(key => ({ key, label: labelOf(kind, key) })) });
    }
    if (!active.length) return null; // 模型里实际没有任何编码被引用，图例没有内容可画

    const position = meta.legendPosition || "bottom";
    const horizontal = position === "top" || position === "bottom";
    const laid = horizontal ? layoutLegendHorizontal(active, mainBbox, lm)
                            : layoutLegendVertical(active, lm);

    // ---- 按 position 把局部坐标平移到主图世界坐标系 ----
    const L = Object.assign({}, LEGEND_CFG,
      { ROW_H: lm.rowH, H_ROW_H: lm.hRowH, H_SWATCH_ADVANCE: lm.advance });
    let ox, oy;
    if (position === "right") { ox = mainBbox.maxX + L.PANEL_GAP; oy = mainBbox.minY; }
    else if (position === "left") { ox = mainBbox.minX - L.PANEL_GAP - laid.panelW; oy = mainBbox.minY; }
    else if (position === "top") { ox = mainBbox.minX; oy = mainBbox.minY - L.PANEL_GAP - laid.panelH; }
    else { ox = mainBbox.minX; oy = mainBbox.maxY + L.PANEL_GAP; } // bottom（也是未知取值时的兜底）

    for (const g of laid.groups) {
      g.titleX += ox; g.titleY += oy;
      for (const row of g.rows) { row.x += ox; row.y += oy; }
    }

    return { bbox: { minX: ox, minY: oy, maxX: ox + laid.panelW, maxY: oy + laid.panelH },
             position, groups: laid.groups };
  }

  // 竖列模式（左/右摆放）：标题在上、条目纵向一行一个。返回局部坐标（未平移）。
  function layoutLegendVertical(active, lm) {
    const L = Object.assign({}, LEGEND_CFG,
      { ROW_H: lm.rowH, H_ROW_H: lm.hRowH, H_SWATCH_ADVANCE: lm.advance });
    const groups = [];
    let cursorY = L.PAD;
    for (const g of active) {
      const titleY = cursorY + L.TITLE_H / 2;
      cursorY += L.TITLE_H;
      const rows = g.items.map((it, i) => ({ key: it.key, x: L.PAD, y: cursorY + i * L.ROW_H + L.ROW_H / 2 }));
      cursorY += g.items.length * L.ROW_H + L.GROUP_GAP;
      groups.push({ kind: g.kind, title: g.title, titleX: L.PAD, titleY, rows });
    }
    return { groups, panelW: L.PANEL_W, panelH: cursorY - L.GROUP_GAP + L.PAD };
  }

  // 横向流式换行模式（上/下摆放）：标题在每组左侧、共用一个对齐的标题列；条目横着排，排满
  // 主图宽度就换到下一行；换组强制另起一行。跨行时标题只出现在该组第一行（顶部对齐，不重复）。
  function layoutLegendHorizontal(active, mainBbox, lm) {
    const L = Object.assign({}, LEGEND_CFG,
      { ROW_H: lm.rowH, H_ROW_H: lm.hRowH, H_SWATCH_ADVANCE: lm.advance });
    const budget = Math.max((mainBbox.maxX - mainBbox.minX), L.H_MIN_BUDGET);

    // 标题列宽 = 所有启用分组里最长标题的估算宽度 + 间距（各组条目从同一个 X 起排，左缘对齐）
    let titleColW = 0;
    for (const g of active) titleColW = Math.max(titleColW, legendTextWidth(g.title, L.H_TITLE_SIZE));
    titleColW += L.H_TITLE_GAP;

    const itemStartX = L.PAD + titleColW;
    const rightLimit = itemStartX + budget; // 条目区右边界，超过就换行
    let rowY = L.PAD;
    let maxXUsed = itemStartX;
    const groups = [];

    for (const g of active) {
      const titleY = rowY + L.H_ROW_H / 2; // 标题落在该组第一行
      let curX = itemStartX;
      let curY = rowY + L.H_ROW_H / 2;
      const rows = [];
      for (const it of g.items) {
        // itemGap 用 lm 的（跟着 legendIconSize 缩放）。原来这里是 LEGEND_CFG.H_ITEM_GAP=18,
        // 是唯一没跟着缩放的那个数——放大图示时条目就"里紧外松"反转了。
        const itemW = L.H_SWATCH_ADVANCE + legendTextWidth(it.label, L.H_LABEL_SIZE) + lm.itemGap;
        if (curX > itemStartX && curX + itemW > rightLimit) { // 换行（但一行至少放一个）
          curY += L.H_ROW_H; curX = itemStartX;
        }
        rows.push({ key: it.key, x: curX, y: curY });
        curX += itemW;
        maxXUsed = Math.max(maxXUsed, curX);
      }
      groups.push({ kind: g.kind, title: g.title, titleX: L.PAD, titleY, rows });
      rowY = curY + L.H_ROW_H + L.GROUP_GAP; // 下一组另起一行
    }

    return { groups, panelW: maxXUsed + L.PAD, panelH: rowY - L.GROUP_GAP + L.PAD };
  }

  // normalizeEncoding 必须导出：它给 encoding 里缺失的 fill/stroke/width 按声明顺序补默认值，
  // 而 SOUL.md 明确只要求 agent 写 legend、不要求写样式。以前它只在 computeLayout() 内部调用，
  // elk 路径(geometry-elk.mjs)完全不走这里 → 作者没写 stroke 时连线 stroke 为空 = 隐形。
  // 两个引擎必须都调它。
  const API = { computeLayout, usedEncodings, deriveLegend, normalizeEncoding, CFG };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.TopoCore = API;
})(typeof window !== "undefined" ? window : this);
