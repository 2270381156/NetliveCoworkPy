/* svg-geometry.js —— 把图标 SVG 的 path 转成归一化几何，供 export-vsdx.js 生成 Visio 原生形状。

   为什么走这条路（其它路都验过了，都不通）：
   - 原生 VSS 模具：`.vss` 是 OLE 复合二进制；LibreOffice 能读 Visio 但**没有导出过滤器**，
     VSS→ODG 出来是空页。
   - EMF 嵌入：项目里、四个 NetIcon 包里、Downloads 里都没有 EMF 素材（那个 _ppt.zip 里
     是 312 个 PNG + 3 TIFF + 4 JPG）。
   - SVG 嵌入：[MS-VSDX] 的 ForeignType 只允许 Bitmap/EnhMetaFile/Ink/Object，没有 SVG；
     落到 Object 且没有 fallback 图时"容器形状不可见"。
   所以只能把 SVG 的矢量数据转成 Visio 自己的 Geometry 行。好在我们的 SVG 本来就是从这批
   VSS 导出的（32 个带 LibreOffice 的 class="BoundingBox" 签名），转几何不是绕远路，是把
   同一份矢量数据换个容器；相比原生模具只少了「连接点」和「形状数据字段」两样，而这两样
   我们都不用——连线走整形粘连，形状数据我们也不产出。

   输出坐标约定：x/y 各自归一化到 0..1（**两个轴独立**，不做居中留白），**y 向上**
   （Visio 的方向）。使用方乘上目标形状的 Width/Height 即可。
   长宽比不编码进坐标，而是单独用 `aspect` 报出来——**保证目标盒子的长宽比跟 aspect 一致
   是使用方的责任**。第一版把短边居中留白编进了坐标，使用方又乘上一个已经是正确长宽比的
   盒子，那层留白就把图标纵向压扁到 1/aspect：Internet（aspect 1.952）只剩 51% 高，
   上下各空出一大截，线看着离图标很远。教训是同一个长宽比不能在两个地方各处理一次。

   Node-only（export-vsdx.js 用），不进浏览器。 */
"use strict";

// 本库实测只用到 M/L/C/Z 四种命令。**没有** A（圆弧）、Q/T（二次贝塞尔）、S（平滑三次）、
// H/V（水平/垂直简写）。不支持的命令必须报出来而不是跳过——静默跳过会画出一个"看着像但
// 是错的"图形，比空图更难发现。换图标源时这里就是第一道信号。
const SUPPORTED = new Set(["M", "L", "C", "Z"]);

// 几何在单位盒里每个轴至少要占这么多。实测本库 35 个图标最小轴占比 0.984，
// 而归一化基准用错时会掉到 0.51（Internet）——两者之间间隔很大，取 0.8 既不会误报，
// 也一定能抓住那类错误。
const MIN_SPAN = 0.8;

// 图标库不同源，两种 fill 写法都要认：32 个是 LibreOffice 从 VSS 导出的（rgb(...)），
// 3 个来自别处（#RRGGBB）。只认一种会让那 3 个转出空图。
function toHex(v) {
  if (!v || v === "none") return null;
  if (v[0] === "#") {
    return v.length === 4 ? "#" + v.slice(1).split("").map(c => c + c).join("").toLowerCase() : v.toLowerCase();
  }
  const m = /rgb\(([\d\s,]+)\)/.exec(v);
  if (!m) return null;
  const parts = m[1].split(",").map(n => Number(n.trim()));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  return "#" + parts.map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
}

// 把整个 <path .../> 抓下来再在里面找属性。**不能假设属性顺序**：本库两种来源里 d 都排
// 第一位，只匹配"d 之前的属性"会永远搜到空串，那 3 个 hex 图标就是这么转成空图的。
function parsePaths(svgText) {
  const vb = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(svgText);
  if (!vb) return null;
  const view = { x: +vb[1], y: +vb[2], w: +vb[3], h: +vb[4] };
  if (!(view.w > 0 && view.h > 0)) return null;

  const tr = /transform="translate\(([-\d.]+)[,\s]+([-\d.]+)\)"/.exec(svgText);
  const tx = tr ? +tr[1] : 0, ty = tr ? +tr[2] : 0;

  const paths = [];
  const re = /<path\b([^>]*)>/g;
  let m;
  while ((m = re.exec(svgText))) {
    const attrs = m[1];
    // BoundingBox 是 LibreOffice 导出的辅助矩形；clipPath 里的 path 是裁剪定义，都不是图形
    if (/clipPathUnits|class="BoundingBox"/.test(attrs)) continue;
    const d = (/\sd="([^"]*)"/.exec(attrs) || [])[1];
    if (!d) continue;
    const fill = toHex((/\sfill="([^"]*)"/.exec(attrs) || [])[1]);
    const stroke = toHex((/\sstroke="([^"]*)"/.exec(attrs) || [])[1]);
    if (!fill && !stroke) continue;   // 两者都是 none 的纯辅助 path
    const sw = Number((/stroke-width="([\d.]+)"/.exec(attrs) || [])[1] || 0);
    paths.push({ d, fill, stroke, strokeWidth: Number.isFinite(sw) ? sw : 0 });
  }
  return { view, tx, ty, paths };
}

// 解析 d。返回 {cmds, unsupported}——unsupported 是遇到的不认识的命令字母集合。
function parseD(d) {
  const cmds = [];
  const unsupported = new Set();
  const toks = d.match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  let i = 0, op = null, cur = [0, 0];
  while (i < toks.length) {
    const t = toks[i];
    if (/[A-Za-z]/.test(t)) {
      if (!SUPPORTED.has(t.toUpperCase())) { unsupported.add(t.toUpperCase()); return { cmds, unsupported }; }
      op = t; i++;
      if (i >= toks.length && op.toUpperCase() !== "Z") break;
    }
    if (!op) { i++; continue; }
    if (op.toUpperCase() === "Z") { cmds.push({ op: "Z", pts: [] }); op = null; continue; }

    const n = op.toUpperCase() === "C" ? 6 : 2;
    if (i + n > toks.length) break;
    const nums = toks.slice(i, i + n).map(Number);
    if (nums.some(v => !Number.isFinite(v))) break;
    i += n;

    const rel = op === op.toLowerCase();
    const pts = [];
    for (let k = 0; k < n; k += 2) {
      pts.push([rel ? cur[0] + nums[k] : nums[k], rel ? cur[1] + nums[k + 1] : nums[k + 1]]);
    }
    cmds.push({ op: op.toUpperCase(), pts });
    cur = pts[pts.length - 1].slice();
    // SVG 规范：M 之后的连续坐标按 L 处理（保持相对/绝对不变）
    if (op === "M") op = "L";
    else if (op === "m") op = "l";
  }
  return { cmds, unsupported };
}

// 三次贝塞尔按容差打散成折线。Visio 有 NURBSTo，但不同版本对 NURBS 的解释有出入，打散更稳；
// 打散后**仍然是矢量**，Visio 里放大不糊，只是点密一些。
function flattenCubic(p0, p1, p2, p3, tol) {
  // 用控制多边形长度估曲线长度，比首尾直线距离靠谱（首尾重合的退化曲线不会被算成 0 段）
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            + Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
            + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(1, Math.min(48, Math.ceil(len / tol)));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/* svgText → { sections, aspect, unsupported }
     sections: [{ fill, stroke, strokeWidth, rows:[{t:"MoveTo"|"LineTo", x, y}] }]
               x/y ∈ 0..1，y 向上，按长边归一、短边居中（等价于 preserveAspectRatio="xMidYMid meet"）
     aspect:   原 viewBox 的 宽/高
     unsupported: 遇到的不支持命令（非空 = 这个图标转出来不可信）
   tolFrac 是**相对长边**的容差。绝对容差不行：本库 viewBox 长边从 42 到 3283 差 78 倍，
   写死的值对小图标会大过整个图标，所有曲线退化成直线——图能画出来但是错的。 */
function svgToGeometry(svgText, opts) {
  const tolFrac = (opts && opts.tolFrac) || 1 / 200;
  const parsed = parsePaths(svgText);
  if (!parsed) return { sections: [], aspect: null, unsupported: [] };

  const { view, tx, ty } = parsed;
  // 打散容差在**原始坐标系**里算，所以按 viewBox 长边取相对值。绝对容差不行：本库
  // viewBox 长边从 42 到 3283 差 78 倍，写死的值对小图标会大过整个图标，曲线全退化成直线。
  const tol = Math.max(view.w, view.h) * tolFrac;
  // 两个轴各自铺满 0..1。长宽比不进坐标，由 aspect 单独报出（见文件头）。
  const nx = (x) => (x + tx - view.x) / view.w;
  const ny = (y) => 1 - (y + ty - view.y) / view.h;

  const sections = [];
  const unsupported = new Set();

  for (const p of parsed.paths) {
    const { cmds, unsupported: bad } = parseD(p.d);
    for (const b of bad) unsupported.add(b);

    const rows = [];
    let cur = null;
    // 当前**子路径**的起点。一条 path 可以有多个 M…Z 子路径，Z 必须闭回本子路径的 M；
    // 闭回整条 path 的第一个 M 会凭空多画一条横跨的线。
    let subStart = null;
    for (const c of cmds) {
      if (c.op === "M") {
        cur = c.pts[0]; subStart = cur;
        rows.push({ t: "MoveTo", x: nx(cur[0]), y: ny(cur[1]) });
      } else if (c.op === "L") {
        cur = c.pts[0];
        rows.push({ t: "LineTo", x: nx(cur[0]), y: ny(cur[1]) });
      } else if (c.op === "C") {
        if (!cur) { cur = c.pts[0]; rows.push({ t: "MoveTo", x: nx(cur[0]), y: ny(cur[1]) }); }
        for (const q of flattenCubic(cur, c.pts[0], c.pts[1], c.pts[2], tol)) {
          rows.push({ t: "LineTo", x: nx(q[0]), y: ny(q[1]) });
        }
        cur = c.pts[2];
      } else if (c.op === "Z" && subStart) {
        rows.push({ t: "LineTo", x: nx(subStart[0]), y: ny(subStart[1]) });
        cur = subStart;
      }
    }
    if (!rows.length) continue;
    sections.push({
      fill: p.fill,
      stroke: p.stroke,
      // 描边宽度按 viewBox **宽度**归一，使用方乘目标形状的 Width 换成英寸
      strokeWidth: p.strokeWidth ? p.strokeWidth / view.w : 0,
      rows,
    });
  }

  return { sections, aspect: view.w / view.h, unsupported: [...unsupported] };
}

/* 自查：转换结果是否可信。返回问题清单（空数组 = 没问题）。
   这三条都是实际踩过的坑，不是假想：
     ① 空几何   —— fill 正则只认 rgb() 时，3 个 hex 图标转出空图，而脚本不报错
     ② 长宽比失真 —— 两轴各自归一化，纵向拉伸 46%，但"图画出来了"，扫一眼看不出来
     ③ 不支持命令 —— 换图标源时遇到 A/Q/S，静默跳过会画出形似而错的图形 */
function checkGeometry(name, result) {
  const problems = [];
  const total = result.sections.reduce((s, x) => s + x.rows.length, 0);
  if (!result.sections.length || total === 0) {
    problems.push(`${name}: 转出空几何`);
    return problems;   // 空的话后面的检查没有意义
  }
  if (result.unsupported.length) {
    problems.push(`${name}: 含不支持的 path 命令 ${result.unsupported.join(",")}，图形不可信`);
  }
  // 几何应当基本铺满单位盒（viewBox 就是图标自己的包围盒）。某个轴只占一小截，说明
  // 归一化用错了基准——第一版把短边居中留白编进坐标，Internet 的纵向就只剩 0.51，
  // 图能画出来、长宽比也"对"，但在目标盒子里被压扁，线离图标很远。
  const xs = [], ys = [];
  for (const s of result.sections) for (const r of s.rows) { xs.push(r.x); ys.push(r.y); }
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (spanX < MIN_SPAN || spanY < MIN_SPAN) {
    problems.push(`${name}: 几何没铺满单位盒（x 占 ${spanX.toFixed(3)}，y 占 ${spanY.toFixed(3)}）——归一化基准可能用错了`);
  }
  return problems;
}

module.exports = { svgToGeometry, checkGeometry, SUPPORTED };
