/* export-vsdx.js —— 从几何 + 语义直接生成 Visio .vsdx（旁路，不经过 SVG）。

   为什么不从 SVG 转（设计文档 2026-07-25 的方案 C）：
   PNG/PDF 要的是"像素对"，从 SVG 转几乎白送；vsdx 要的是"**结构对、能接着改**"。
   SVG 里只剩矩形和折线，从它生成的 Visio 形状不是"设备"、连线不是"连接器"——拖动设备时
   连线不跟随，跟"真正可编辑"的要求直接冲突。所以这条路必须拿着 layout（坐标）+ model
   （语义）自己生成 Shape/Connector。

   .vsdx = OPC 包 = ZIP + 一组 XML part。结构参考 svgtovisio（MIT，McMarius11）——它证明了
   "纯 JS 生成可编辑 vsdx"这条路走得通，本文件的 part 清单、命名空间、Cell 名称沿用它的
   验证结果，但内容生成是我们自己的（它从 SVG 解析，我们从几何+语义直出）。

   坐标系差异（务必注意，写反了图会上下颠倒）：
   - 我们的世界坐标：y 向下增长，单位 px
   - Visio：y 向**上**增长，单位**英寸**
   所以 visioY = (pageHeightPx - worldY) * SCALE，且 Shape 的 PinX/PinY 是**中心点**不是左上角。

   浏览器用不到（导出只在 Node 侧做），只挂 module.exports。 */
"use strict";
const { zipSync } = require("./zip-writer.js");
const { svgToGeometry, checkGeometry } = require("./svg-geometry.js");
const { loadCatalog, readSvgText } = require("./icons.js");
const R = require("./regions.js");

const PX_PER_INCH = 96;          // CSS 像素 → 英寸的换算基准
const MARGIN_PX = 40;            // 图纸四周留白，跟 draw-core 的 VIEW_PAD 对齐

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
// Visio 的 Cell V 要纯数字，NaN/Infinity 会让文件打不开
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? +n.toFixed(6) : (fallback == null ? 0 : fallback);
}
// 颜色统一成 #RRGGBB；Visio 不认 "none"/CSS 颜色名
function color(c, fallback) {
  if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (typeof c === "string" && /^#[0-9a-fA-F]{3}$/.test(c)) {
    return "#" + c.slice(1).split("").map(ch => ch + ch).join("");
  }
  return fallback;
}

// opts.warnings：调用方传一个数组进来收集警告（图标转换失败等）。不传就丢弃——
// 但**默认丢弃是有风险的**，所以 cli.js 一定要传，让 agent 看得到降级发生了。
function buildVsdx(model, layout, opts) {
  const bb = layout.bbox;
  const pageWpx = (bb.maxX - bb.minX) + MARGIN_PX * 2;
  const pageHpx = (bb.maxY - bb.minY) + MARGIN_PX * 2;
  const pageW = pageWpx / PX_PER_INCH;
  const pageH = pageHpx / PX_PER_INCH;

  // 世界坐标 → Visio 英寸坐标。x 平移到 0 起点；y 同时平移并翻转。
  const vx = (x) => (x - bb.minX + MARGIN_PX) / PX_PER_INCH;
  const vy = (y) => (pageHpx - (y - bb.minY + MARGIN_PX)) / PX_PER_INCH;
  const vlen = (px) => px / PX_PER_INCH;

  const ro = R.renderOptions(model);
  const enc = model.encoding || {};
  const roles = enc.deviceRoles || {};
  const linkTypes = enc.linkTypes || {};
  const zoneTypes = enc.zoneTypes || {};

  let nextId = 1;
  const shapeIdOf = new Map();   // 设备 id → Visio Shape ID
  const shapes = [];
  const connects = [];

  // ---- 1) zone 虚线框：先画，在设备下面（Visio 里靠 Shape 顺序决定 z 序）----
  for (const z of (layout.zones || [])) {
    const zb = z.bbox;
    if (!zb) continue;
    const id = nextId++;
    const w = vlen(zb.maxX - zb.minX), h = vlen(zb.maxY - zb.minY);
    const zt = zoneTypes[z.type] || {};
    shapes.push(rectShape({
      id, pinX: vx(zb.minX) + w / 2, pinY: vy(zb.maxY) + h / 2, w, h,
      fill: color(zt.fill, "#FFFFFF"), line: color(zt.stroke, "#8AA0B4"),
      linePattern: 2,          // 2 = 虚线，跟 SVG 侧 stroke-dasharray 对应
      rounded: ro.zoneCorner === "round",
      fillPattern: 0,          // 0 = 透明，别把里面的设备盖住
      strokeScale: ro.strokeScale,
      text: z.label || "",
      textTop: true,           // zone 标签贴在框顶部，跟 draw-core 一致
    }));
  }

  // ---- 2) 设备 ----
  // 有图标的设备生成 **Group**：图标按填充色拆成若干子形状（Visio 的填充色是形状级的，
  // 不是 Geometry 段级的，多色图标只能拆），标签是另一个子形状。
  //
  // group 的 Width/Height **声明成图标盒**，标签子形状放在局部坐标的负 y、在声明的盒子
  // 外面。这样做是为了跟 SVG 侧对齐：draw-core.js 的 drawNodes 用 n.left/n.w 把图标画满
  // 整个设备方框，标签画在框**外**下方（n.bottom + ...），而端口锚点算在方框边上——
  // 也就是说 SVG 里线碰的是**图标边**。若把标签圈进 group 盒，整形粘连会让线落在比图标
  // 大一圈的框上，两边表现不一致（实测确认过这个差异）。
  const iconProblems = (opts && opts.warnings) || [];
  for (const nid in layout.nodes) {
    const n = layout.nodes[nid];
    const r = roles[n.role] || {};
    if (r.decorative) continue;      // "…" 省略标记不是真实网络实体，不生成 Shape
    const w = vlen(n.w), h = vlen(n.h);
    const pinX = vx(n.left) + w / 2, pinY = vy(n.bottom) + h / 2;
    const label = n.label || nid;

    const geo = iconGeometry(r, n, iconProblems);
    if (!geo) {
      // 没图标：保持原来的圆角方框 + 框内文字
      const id = nextId++;
      shapeIdOf.set(nid, id);
      shapes.push(rectShape({
        id, pinX, pinY, w, h,
        fill: color(r.fill, "#EEF2FB"), line: color(r.stroke, "#6B83C9"),
        linePattern: 1, fillPattern: 1, text: label, rounded: true, strokeScale: ro.strokeScale,
      }));
      continue;
    }

    // group 的 ID 必须先占位再生成孩子——孩子的 ID 要排在它后面，
    // 而连接器粘的是 group 的 ID（整形粘连，ToPart=3）
    const gid = nextId++;
    shapeIdOf.set(nid, gid);
    const kids = [];
    for (const sec of geo.sections) {
      // 每个色段做成一个铺满整个 group 盒的子形状，几何行用局部坐标（y 已经向上）。
      // 不按色段各自算包围盒——那样每个子形状的选择框都不一样，用户在 Visio 里
      // 点选时会很别扭，而且省不下多少。
      const rows = sec.rows.map((q, i) =>
        `          <Row T="${q.t}" IX="${i + 1}"><Cell N="X" V="${num(q.x * w)}"/><Cell N="Y" V="${num(q.y * h)}"/></Row>`
      ).join("\n");
      kids.push(`      <Shape ID="${nextId++}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
        <Cell N="PinX" V="${num(w / 2)}"/><Cell N="PinY" V="${num(h / 2)}"/>
        <Cell N="Width" V="${num(w)}"/><Cell N="Height" V="${num(h)}"/>
        <Cell N="LocPinX" V="${num(w / 2)}"/><Cell N="LocPinY" V="${num(h / 2)}"/>
        <Cell N="Angle" V="0"/>
        <Cell N="FillForegnd" V="${(sec.fill || "#FFFFFF").toUpperCase()}"/>
        <Cell N="FillPattern" V="${sec.fill ? 1 : 0}"/>
        <Cell N="LineColor" V="${(sec.stroke || "#000000").toUpperCase()}"/>
        <Cell N="LinePattern" V="${sec.stroke ? 1 : 0}"/>
        <Cell N="LineWeight" V="${num(sec.stroke ? Math.max(sec.strokeWidth * w, 0.003) : 0)}"/>
        <Section N="Geometry" IX="0">
          <Cell N="NoFill" V="${sec.fill ? 0 : 1}"/>
          <Cell N="NoLine" V="${sec.stroke ? 0 : 1}"/>
${rows}
        </Section>
      </Shape>`);
    }
    // 标签：负 y，落在 group 声明的盒子外面，但仍是 group 的孩子，跟着一起动
    const labelH = 0.18, roleText = r.legend || n.role;
    kids.push(`      <Shape ID="${nextId++}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
        <Cell N="PinX" V="${num(w / 2)}"/><Cell N="PinY" V="${num(-labelH * 0.7)}"/>
        <Cell N="Width" V="${num(Math.max(w, 0.8))}"/><Cell N="Height" V="${num(labelH * 2)}"/>
        <Cell N="LocPinX" V="${num(Math.max(w, 0.8) / 2)}"/><Cell N="LocPinY" V="${num(labelH)}"/>
        <Cell N="Angle" V="0"/>
        <Cell N="FillPattern" V="0"/><Cell N="LinePattern" V="0"/>
        <Section N="Character"><Row IX="0"><Cell N="Size" V="0.1"/></Row></Section>
        <Text>${esc(label)}${roleText ? "\n" + esc(roleText) : ""}</Text>
      </Shape>`);

    shapes.push(`    <Shape ID="${gid}" Type="Group" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="PinX" V="${num(pinX)}"/><Cell N="PinY" V="${num(pinY)}"/>
      <Cell N="Width" V="${num(w)}"/><Cell N="Height" V="${num(h)}"/>
      <Cell N="LocPinX" V="${num(w / 2)}"/><Cell N="LocPinY" V="${num(h / 2)}"/>
      <Cell N="Angle" V="0"/>
      <Shapes>
${kids.join("\n")}
      </Shapes>
    </Shape>`);
  }

  // ---- 3) 连接器：1-D Shape + Connects 粘住两端 ----
  // 这一段是"真正可编辑"的落点：BeginX/EndX 给出端点，<Connect> 把连接器的两端粘到设备
  // Shape 上。粘住之后在 Visio 里拖动设备，连线会跟着走——这正是从 SVG 转做不到的。
  for (const l of (layout.links || [])) {
    const a = l.aAnchor, b = l.bAnchor;
    if (!a || !b) continue;
    const fromId = shapeIdOf.get(l.a), toId = shapeIdOf.get(l.b);
    const id = nextId++;
    const lt = linkTypes[l.type] || {};
    const pts = (l.route && l.route.length >= 2) ? l.route : [a, b];

    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = Math.max(vlen(maxX - minX), 0.01);
    const h = Math.max(vlen(maxY - minY), 0.01);

    // 局部几何：相对连接器自身包围盒左下角，y 同样要翻
    const geom = pts.map((p, i) => {
      const lx = num(vlen(p.x - minX)), ly = num(h - vlen(p.y - minY));
      return `        <Row T="${i === 0 ? "MoveTo" : "LineTo"}" IX="${i + 1}">`
           + `<Cell N="X" V="${lx}"/><Cell N="Y" V="${ly}"/></Row>`;
    }).join("\n");

    // ---- 动态粘连：让线跟着设备走 ----
    // 关键在**公式**，不在 <Connects>。微软文档（BegTrigger Cell, Glue Info Section）：
    // "用动态粘连把 1-D 形状粘到另一个形状时，应用会生成一个引用对方 EventXFMod 单元格的
    // 公式……那个形状变化时，Visio 重算所有引用它 EventXFMod 的公式，包括 BegTrigger"。
    // <Connects> 只是粘连关系的索引/缓存，光有它 Visio 认为线没粘住——第一版就是这样，
    // 38 个 Connect 齐全、零悬空，但在 EdrawMax 里拖动设备连线纹丝不动。
    //
    // 所以三件必须齐：① BegTrigger/EndTrigger 引用目标的 EventXFMod（变化时触发重算）；
    // ② BeginX/Y、EndX/Y 用 _WALKGLUE 公式而不是死坐标；③ ObjType=2 声明这是 1-D 形状
    // （不声明的话 Visio 当二维图形处理，Begin/End 那组单元格根本不参与计算）。
    const glueBeg = fromId
      ? `\n      <Cell N="BegTrigger" V="2" F="_XFTRIGGER(Sheet.${fromId}!EventXFMod)"/>`
      : "";
    const glueEnd = toId
      ? `\n      <Cell N="EndTrigger" V="2" F="_XFTRIGGER(Sheet.${toId}!EventXFMod)"/>`
      : "";
    const walk = 'F="_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)"';

    shapes.push(`    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="ObjType" V="2"/>
      <!-- 保持直线：我们只给了两点的直线几何，但 _WALKGLUE 让 Visio 在设备移动时自行重算
           路径，它会按**默认的直角路由**走——用户反馈的"稍微调一下位置，斜线就走成折线"
           就是这个。三个单元格控制这件事，一起给上：
             ConFixedCode=2      从不重新布线（visLOConFixNever），这条是决定性的
             ShapeRouteStyle=16  中心到中心的直连（而不是直角/网络/树形那些）
             ConLineRouteExt=1   路径外观取直线（而不是曲线）
           注意：**这三个值在 Visio/亿图里的实际效果本地无法验证**，只能验文件结构。
           跟粘连那次一样，得人工在软件里拖一下才算数。 -->
      <Cell N="ConFixedCode" V="2"/>
      <Cell N="ShapeRouteStyle" V="16"/>
      <Cell N="ConLineRouteExt" V="1"/>
      <Cell N="PinX" V="${num(vx(minX) + w / 2)}"/>
      <Cell N="PinY" V="${num(vy(maxY) + h / 2)}"/>
      <Cell N="Width" V="${num(w)}"/>
      <Cell N="Height" V="${num(h)}"/>
      <Cell N="LocPinX" V="${num(w / 2)}"/>
      <Cell N="LocPinY" V="${num(h / 2)}"/>
      <Cell N="Angle" V="0"/>
      <Cell N="BeginX" V="${num(vx(a.x))}" ${fromId ? walk : ""}/>
      <Cell N="BeginY" V="${num(vy(a.y))}" ${fromId ? walk : ""}/>
      <Cell N="EndX" V="${num(vx(b.x))}" ${toId ? walk : ""}/>
      <Cell N="EndY" V="${num(vy(b.y))}" ${toId ? walk : ""}/>${glueBeg}${glueEnd}
      <Cell N="WalkPreference" V="0"/>
      <Cell N="FillPattern" V="0"/>
      <Cell N="LineWeight" V="${num(R.strokePt(lt.width, ro.strokeScale) / 72)}"/>   <!-- pt → 英寸；收细系数见 regions.js STROKE -->
      <Cell N="LineColor" V="${color(lt.stroke, "#6B83C9")}"/>
      <Cell N="LinePattern" V="${lt.dash ? 2 : 1}"/>
      <Cell N="BeginArrow" V="0"/>
      <Cell N="EndArrow" V="0"/>
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="1"/>
        <Cell N="NoLine" V="0"/>
${geom}
      </Section>
    </Shape>`);

    // FromPart 9 = BeginX 端，12 = EndX 端；ToPart 3 = 目标 Shape 本体（整形粘连）
    if (fromId) connects.push(`    <Connect FromSheet="${id}" FromCell="BeginX" FromPart="9" ToSheet="${fromId}" ToCell="PinX" ToPart="3"/>`);
    if (toId) connects.push(`    <Connect FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="${toId}" ToCell="PinX" ToPart="3"/>`);
  }

  const page1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
              xml:space="preserve">
  <Shapes>
${shapes.join("\n")}
  </Shapes>${connects.length ? `
  <Connects>
${connects.join("\n")}
  </Connects>` : ""}
</PageContents>`;

  return zipSync([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/app.xml", data: APP_PROPS },
    { name: "docProps/core.xml", data: CORE_PROPS },
    { name: "visio/document.xml", data: DOCUMENT },
    { name: "visio/_rels/document.xml.rels", data: DOCUMENT_RELS },
    { name: "visio/windows.xml", data: WINDOWS },
    { name: "visio/pages/pages.xml", data: pagesXml(pageW, pageH) },
    { name: "visio/pages/_rels/pages.xml.rels", data: PAGES_RELS },
    { name: "visio/pages/page1.xml", data: page1 },
  ]);
}

/* 取一个角色的图标几何。取不到（没配 icon、目录里没有、素材有问题）一律返回 null，
   调用方退回纯色方框——这是设计上允许的正常降级，跟 SVG 侧一致。
   但**素材有问题**要记进 problems 往上报，不能静默降级：静默降级的话，图标转错了
   只表现为"这台设备画成了方框"，看图的人分不清是没配图标还是转换出了错。 */
function iconGeometry(role, node, problems) {
  if (!role.icon) return null;
  let entry;
  try { entry = loadCatalog()[role.icon]; } catch (e) { return null; }
  if (!entry || !entry.blue) return null;
  const useYellow = entry.deviceType && node.iconTheme === "yellow" && entry.yellow;
  const rel = useYellow ? entry.yellow : entry.blue;
  let text;
  try { text = readSvgText(rel); } catch (e) { problems.push(`${role.icon}: 素材读不到 (${rel})`); return null; }
  const geo = svgToGeometry(text);
  const bad = checkGeometry(role.icon, geo);
  if (bad.length) { problems.push(...bad); return null; }

  // 长宽比的守卫放在**使用方**，因为这里才是会出错的地方：svg-geometry 输出的坐标两个轴
  // 都是 0..1，长宽比只由目标盒子决定。topo.js 会用 icons.js 算的 aspect 覆盖设备方框比例，
  // 正常情况下两者一致；一旦哪天没覆盖上（新画法、别的引擎、agent 手写了 w/h），图标就会
  // 被拉伸，而文件本身完全合法、测试也不会红。所以宁可报警告也不能静默拉伸。
  if (geo.aspect && node.w > 0 && node.h > 0) {
    const boxAspect = node.w / node.h;
    if (Math.abs(boxAspect - geo.aspect) / geo.aspect > 0.02) {
      problems.push(`${role.icon}: 设备方框比例 ${boxAspect.toFixed(3)} 与图标比例 ${geo.aspect.toFixed(3)} 不一致，图标会被拉伸`);
    }
  }
  return geo;
}

// 矩形 Shape（设备和 zone 共用）。rounded 走 Visio 的 Rounding 单元格而不是自己画圆角几何。
function rectShape({ id, pinX, pinY, w, h, fill, line, linePattern, fillPattern, text, rounded, textTop, strokeScale }) {
  const textXml = text
    ? `\n      <Section N="Character"><Row IX="0"><Cell N="Size" V="0.11"/></Row></Section>`
      + (textTop ? `\n      <Cell N="VerticalAlign" V="0"/>` : "")
      + `\n      <Text>${esc(text)}</Text>`
    : "";
  return `    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="PinX" V="${num(pinX)}"/>
      <Cell N="PinY" V="${num(pinY)}"/>
      <Cell N="Width" V="${num(w)}"/>
      <Cell N="Height" V="${num(h)}"/>
      <Cell N="LocPinX" V="${num(w / 2)}"/>
      <Cell N="LocPinY" V="${num(h / 2)}"/>
      <Cell N="Angle" V="0"/>
      <Cell N="FillForegnd" V="${fill}"/>
      <Cell N="FillPattern" V="${fillPattern}"/>
      <Cell N="LineColor" V="${line}"/>
      <Cell N="LinePattern" V="${linePattern}"/>
      <Cell N="LineWeight" V="${num(R.strokePt(R.STROKE.ZONE, strokeScale) / 72)}"/>${rounded ? `\n      <Cell N="Rounding" V="0.07"/>` : ""}
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="${fillPattern === 0 ? 1 : 0}"/>
        <Cell N="NoLine" V="0"/>
        <Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="${num(w)}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="3"><Cell N="X" V="${num(w)}"/><Cell N="Y" V="${num(h)}"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="${num(h)}"/></Row>
        <Row T="LineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
      </Section>${textXml}
    </Shape>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>
  <Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>
  <Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>
  <Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="http://schemas.microsoft.com/office/visio/2012/main"
               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
               xml:space="preserve">
  <DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0">
    <GlueSettings>9</GlueSettings>
    <SnapSettings>65847</SnapSettings>
  </DocumentSettings>
  <FaceNames>
    <FaceName ID="1" Name="Calibri"/>
    <FaceName ID="2" Name="Microsoft YaHei"/>
  </FaceNames>
  <StyleSheets>
    <StyleSheet ID="0" Name="No Style" NameU="No Style">
      <Cell N="LineWeight" V="0.01041666666666667"/>
      <Cell N="LineColor" V="#000000"/>
      <Cell N="LinePattern" V="1"/>
      <Cell N="FillForegnd" V="#FFFFFF"/>
      <Cell N="FillPattern" V="1"/>
      <Section N="Character"><Row IX="0"><Cell N="Font" V="2"/><Cell N="Color" V="#2B3542"/><Cell N="Size" V="0.11"/></Row></Section>
      <Section N="Paragraph"><Row IX="0"><Cell N="HorzAlign" V="1"/></Row></Section>
    </StyleSheet>
  </StyleSheets>
</VisioDocument>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>
  <Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/windows" Target="windows.xml"/>
</Relationships>`;

const WINDOWS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Windows xmlns="http://schemas.microsoft.com/office/visio/2012/main" ClientWidth="1000" ClientHeight="700">
  <Window ID="0" WindowType="Drawing" WindowState="1073741824" Document="\\visio\\document.xml" Page="0" ViewScale="1" ViewCenterX="0" ViewCenterY="0"/>
</Windows>`;

const PAGES_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/>
</Relationships>`;

const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
            xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Visio</Application>
  <AppVersion>15.0000</AppVersion>
</Properties>`;

const CORE_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>网络拓扑图</dc:title>
  <dc:creator>IPMaster-Cowork</dc:creator>
</cp:coreProperties>`;

function pagesXml(w, h) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="http://schemas.microsoft.com/office/visio/2012/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Page ID="0" Name="Page-1" NameU="Page-1">
    <PageSheet>
      <Cell N="PageWidth" V="${num(w)}"/>
      <Cell N="PageHeight" V="${num(h)}"/>
      <Cell N="PageScale" V="1"/>
      <Cell N="DrawingScale" V="1"/>
      <Cell N="DrawingSizeType" V="3"/>
      <Cell N="DrawingScaleType" V="0"/>
    </PageSheet>
    <Rel r:id="rId1"/>
  </Page>
</Pages>`;
}

module.exports = { buildVsdx };
