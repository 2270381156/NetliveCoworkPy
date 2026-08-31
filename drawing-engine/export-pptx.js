/* export-pptx.js —— 从几何 + 语义直接生成 .pptx（旁路，不经过 SVG）。

   为什么要这个格式：vsdx 面向"专业绘图工具里继续改"，pptx 面向"塞进汇报材料、用
   PowerPoint 直接改"——后者是多数人手边真正有的工具。两者不是替代关系。

   与 vsdx 的关键差异（决定了这里的设计）：
   - **幻灯片是固定画布**。vsdx 的页面按内容大小生成，pptx 不能这么干：一张比例奇怪的
     幻灯片塞进汇报材料就是废的。所以固定 16:9（13.333in × 7.5in），把图**等比缩放**
     居中放进去。这是这个格式的用途决定的，不是偷懒。
   - **坐标单位是 EMU**，且 y 向**下**（跟我们的世界坐标一致，不像 Visio 要翻）。
     914400 EMU/英寸，我们的世界坐标是 96px/英寸 → 9525 EMU/px。
   - **连线是真连接**：<p:cxnSp> 的 stCxn/endCxn 指向形状 id，PowerPoint 里拖动形状线会
     跟着走。这跟 vsdx 的诉求一致，也是不走 SVG 的原因——从 SVG 转出来只是一堆线段。

   v1 范围（刻意不做的写在这里，不要靠猜）：
   - 做：zone 虚线框、设备（图标 custGeom 或圆角矩形）、设备标签、连线（带 stCxn/endCxn）
   - 不做：图例（legend）。它是一组独立的文字+色块，机制上跟设备没区别，但要另算一套
     布局；v1 先把主体跑通。**导出时会在 warnings 里说明图例没带**，不静默丢。
   - 不做：端口标记。跟 vsdx 一致——它们在 SVG 里是装饰，进不了"可编辑"的语义。

   Node-only。 */
"use strict";
const { zipSync } = require("./zip-writer.js");
const { svgToGeometry, checkGeometry } = require("./svg-geometry.js");
const { loadCatalog, readSvgText } = require("./icons.js");
const R = require("./regions.js");

const EMU_PER_PX = 9525;              // 914400 EMU/inch ÷ 96 px/inch
const SLIDE_W = 12192000;             // 13.333in，16:9
const SLIDE_H = 6858000;              // 7.5in
const MARGIN = 457200;                // 0.5in 四周留白

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
// EMU 必须是整数：小数会被某些实现拒绝或静默取整，自己取整可控
const emu = (v) => Math.round(Number.isFinite(v) ? v : 0);
// srgbClr 要的是不带 # 的六位十六进制
function hex6(c, fallback) {
  if (typeof c === "string") {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(c.trim());
    if (m) return m[1].toUpperCase();
    const s = /^#?([0-9a-fA-F]{3})$/.exec(c.trim());
    if (s) return s[1].split("").map(ch => ch + ch).join("").toUpperCase();
  }
  return fallback;
}

function buildPptx(model, layout, opts) {
  const warnings = (opts && opts.warnings) || [];
  // 范围按**实际画出来的东西**算，不能直接用 layout.bbox：那个 bbox 含图例区域，
  // 而 v1 不画图例——直接用它会让幻灯片底部白占一大块（实测就是这个现象）。
  const bb = drawnBounds(model, layout);
  const wPx = Math.max(bb.maxX - bb.minX, 1), hPx = Math.max(bb.maxY - bb.minY, 1);

  // 等比缩放到可用区域内并居中。取 min 保证两个方向都装得下；不放大超过 1:1——
  // 小图被拉满整页会让线宽和字号显得突兀，宁可留白。
  const availW = SLIDE_W - MARGIN * 2, availH = SLIDE_H - MARGIN * 2;
  const scale = Math.min(availW / (wPx * EMU_PER_PX), availH / (hPx * EMU_PER_PX), 1);
  const drawW = wPx * EMU_PER_PX * scale, drawH = hPx * EMU_PER_PX * scale;
  const originX = (SLIDE_W - drawW) / 2, originY = (SLIDE_H - drawH) / 2;
  const X = (x) => emu(originX + (x - bb.minX) * EMU_PER_PX * scale);
  const Y = (y) => emu(originY + (y - bb.minY) * EMU_PER_PX * scale);
  const L = (px) => emu(px * EMU_PER_PX * scale);   // 长度（无平移）
  // 线宽：pt → EMU（12700 EMU/pt），并**乘 scale**。不乘的话图被缩小后线宽不变，
  // 越大的图线看着越粗——这正是"线显得很粗"的一半原因（另一半是 SVG 用
  // non-scaling-stroke 在作弊，绝对单位输出如实换算就显粗，见 regions.js STROKE）。
  const ro = R.renderOptions(model);
  const lnW = (px) => Math.max(emu(R.strokePt(px, ro.strokeScale) * 12700 * scale), 3175);   // 下限 0.25pt，别细到看不见

  const enc = model.encoding || {};
  const roles = enc.deviceRoles || {};
  const linkTypes = enc.linkTypes || {};
  const zoneTypes = enc.zoneTypes || {};

  let nextId = 2;                     // 1 留给幻灯片自身的根 group
  const shapeIdOf = new Map();        // 设备 id → group 形状 id
  const cxnTargetOf = new Map();      // 设备 id → 承载端口连接点的子形状 id（连线粘它）
  const body = [];

  // ---- zone：先出，压在设备下面（pptx 的 z 序就是文档顺序）----
  for (const z of (layout.zones || [])) {
    const zb = z.bbox;
    if (!zb) continue;
    const zt = zoneTypes[z.type] || {};
    const stroke = hex6(zt.stroke, "9AA5B1");
    const fill = hex6(zt.fill, null);
    body.push(`      <p:sp>
        <p:nvSpPr><p:cNvPr id="${nextId++}" name="${esc(z.label || z.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${X(zb.minX)}" y="${Y(zb.minY)}"/><a:ext cx="${L(zb.maxX - zb.minX)}" cy="${L(zb.maxY - zb.minY)}"/></a:xfrm>
          <a:prstGeom prst="${ro.zoneCorner === "round" ? "roundRect" : "rect"}"><a:avLst/></a:prstGeom>
          ${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : `<a:noFill/>`}
          <a:ln w="${lnW(R.STROKE.ZONE)}"><a:solidFill><a:srgbClr val="${stroke}"/></a:solidFill><a:prstDash val="dash"/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr anchor="t"/><a:lstStyle/><a:p>
          <a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="1000" b="1"><a:solidFill><a:srgbClr val="${stroke}"/></a:solidFill></a:rPr><a:t>${esc(z.label || z.id)}</a:t></a:r>
        </a:p></p:txBody>
      </p:sp>`);
  }

  // ---- 设备：每台一个 group（图标色段 + 标签），连线粘 group ----
  // chOff/chExt 与 off/ext 取相同值，子形状坐标就跟父级同一套，不必再做一次换算
  // ——DrawingML 的 group 坐标是最容易出错的地方，能省掉这层换算就省掉。
  for (const nid in layout.nodes) {
    const n = layout.nodes[nid];
    const r = roles[n.role] || {};
    if (r.decorative) continue;                 // "…" 省略标记不是实体
    const gid = nextId++;
    shapeIdOf.set(nid, gid);

    const geo = iconGeometry(r, n, warnings);
    const { labelSize, roleSize } = R.labelMetrics(n.h);
    const off = R.labelOffsets(n.h, !!geo);
    const roleText = r.legend || n.role;
    // 文本框宽度必须按**估算的文字宽度**来，不能拍一个固定值：拍 max(n.w/2,40) 的那版
    // 在 LibreOffice 里把 "Internet" 折成了 "Interne/t"、"汇聚交换机" 折成两行。
    // 估算函数就在 regions.js（布局给标签留位置用的是同一个），乘 1.15 留一点余量——
    // 估窄了就换行，估宽了只是选中框大一点，两种错的代价不对等。
    const textHalf = 1.15 * Math.max(
      R.estimateTextWidth(n.label || nid, labelSize),
      R.estimateTextWidth(roleText, roleSize)) / 2;
    const halfW = Math.max(n.w / 2, textHalf);
    const gLeft = n.cx - halfW, gRight = n.cx + halfW;
    // 两行文字紧贴图标下沿排：文本框顶边就是方框底边，高度给足两行 + 行距
    const tTop = n.bottom;
    const tH = R.labelExtentBelow(n.h, !!geo);   // 与布局给 zone 留的高度同一个数
    const gTop = n.top, gBot = geo ? tTop + tH : n.bottom;

    const kids = [];
    /* 不可见的锚点承载形状：盒子**正好等于设备方框**，连线粘它而不是粘 group。

       为什么不粘 group：group 框含标签文本框、并按文字宽度加宽过，比设备大一圈——
       实测就是"线连在 group 上、没连在设备上"。

       为什么用 prstGeom rect 而不是 custGeom + 自定义连接点：自定义连接点（<a:cxnLst>）
       能精确复现我们算的端口分布，但**LibreOffice 完全不读它**——探针验过：同一个连接点
       分别用 path 空间和 EMU 空间两种坐标写法，渲染结果一模一样（都落在右上角），说明它
       走的是自己算的落点。而 LibreOffice 正是当前的实际使用环境。
       预设矩形的连接点是标准定义的（0=上 1=左 2=下 3=右），各实现都认。
       代价：每条边只有中点一个连接点，同一条边上的多条线会汇到一点，不如 SVG 里沿边散开。
       这是拿"各处都能用"换"端口精确"，等哪天目标环境确定支持自定义连接点再回来改。 */
    const anchorCarrierId = nextId++;
    kids.push(`        <p:sp>
          <p:nvSpPr><p:cNvPr id="${anchorCarrierId}" name="ports"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="${X(n.left)}" y="${Y(n.top)}"/><a:ext cx="${L(n.w)}" cy="${L(n.h)}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/><a:ln><a:noFill/></a:ln>
          </p:spPr>
          <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
        </p:sp>`);
    cxnTargetOf.set(nid, anchorCarrierId);
    if (geo) {
      for (const sec of geo.sections) {
        const P = 100000;                        // path 坐标空间（整数，越大越精细）
        const d = sec.rows.map((q, i) => {
          const px = Math.round(q.x * P), py = Math.round((1 - q.y) * P);  // DrawingML 的 y 向下
          return q.t === "MoveTo"
            ? `<a:moveTo><a:pt x="${px}" y="${py}"/></a:moveTo>`
            : `<a:lnTo><a:pt x="${px}" y="${py}"/></a:lnTo>`;
        }).join("");
        const secFill = hex6(sec.fill, null);
        kids.push(`        <p:sp>
          <p:nvSpPr><p:cNvPr id="${nextId++}" name="icon"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="${X(n.left)}" y="${Y(n.top)}"/><a:ext cx="${L(n.w)}" cy="${L(n.h)}"/></a:xfrm>
            <a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>
              <a:pathLst><a:path w="${P}" h="${P}">${d}<a:close/></a:path></a:pathLst>
            </a:custGeom>
            ${secFill ? `<a:solidFill><a:srgbClr val="${secFill}"/></a:solidFill>` : `<a:noFill/>`}
            ${sec.stroke ? `<a:ln w="6350"><a:solidFill><a:srgbClr val="${hex6(sec.stroke, "FFFFFF")}"/></a:solidFill></a:ln>` : `<a:ln><a:noFill/></a:ln>`}
          </p:spPr>
          <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
        </p:sp>`);
      }
    } else {
      kids.push(`        <p:sp>
          <p:nvSpPr><p:cNvPr id="${nextId++}" name="${esc(n.label || nid)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="${X(n.left)}" y="${Y(n.top)}"/><a:ext cx="${L(n.w)}" cy="${L(n.h)}"/></a:xfrm>
            <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="${hex6(r.fill, "EEF2FB")}"/></a:solidFill>
            <a:ln w="${lnW(R.STROKE.DEVICE_BOX)}"><a:solidFill><a:srgbClr val="${hex6(r.stroke, "6B83C9")}"/></a:solidFill></a:ln>
          </p:spPr>
          <p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>
            <a:r><a:rPr lang="zh-CN" sz="${Math.round(labelSize * 100)}"/><a:t>${esc(n.label || nid)}</a:t></a:r>
          </a:p></p:txBody>
        </p:sp>`);
    }

    // 有图标时标签是独立文本框，放在图标下方（跟 SVG 侧一致）
    if (geo) {
      kids.push(`        <p:sp>
          <p:nvSpPr><p:cNvPr id="${nextId++}" name="label"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="${X(gLeft)}" y="${Y(tTop)}"/><a:ext cx="${L(gRight - gLeft)}" cy="${L(tH)}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>
          </p:spPr>
          <p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:lstStyle/>
            <a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="${Math.round(labelSize * 100)}" b="1"><a:solidFill><a:srgbClr val="2B3542"/></a:solidFill></a:rPr><a:t>${esc(n.label || nid)}</a:t></a:r></a:p>
            <a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="${Math.round(roleSize * 100)}"><a:solidFill><a:srgbClr val="6B7787"/></a:solidFill></a:rPr><a:t>${esc(roleText)}</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>`);
    }

    body.push(`      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="${gid}" name="${esc(n.label || nid)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm>
          <a:off x="${X(gLeft)}" y="${Y(gTop)}"/><a:ext cx="${L(gRight - gLeft)}" cy="${L(gBot - gTop)}"/>
          <a:chOff x="${X(gLeft)}" y="${Y(gTop)}"/><a:chExt cx="${L(gRight - gLeft)}" cy="${L(gBot - gTop)}"/>
        </a:xfrm></p:grpSpPr>
${kids.join("\n")}
      </p:grpSp>`);
  }

  // ---- 连线：stCxn/endCxn 指向 group id，PowerPoint 里拖动形状线会跟着走 ----
  let linkCount = 0;
  for (const l of (layout.links || [])) {
    const a = l.aAnchor, b = l.bAnchor;
    if (!a || !b) continue;
    const fromId = shapeIdOf.get(l.a), toId = shapeIdOf.get(l.b);
    const lt = linkTypes[l.type] || {};
    const x1 = X(a.x), y1 = Y(a.y), x2 = X(b.x), y2 = Y(b.y);
    // 直线连接器的 xfrm 用包围盒 + flipH/flipV 表达方向，这是 DrawingML 的既定写法
    const ox = Math.min(x1, x2), oy = Math.min(y1, y2);
    const cx = Math.max(Math.abs(x2 - x1), 1), cy = Math.max(Math.abs(y2 - y1), 1);
    const flipH = x2 < x1 ? ' flipH="1"' : "";
    const flipV = y2 < y1 ? ' flipV="1"' : "";
    // 连接点按**锚点所在的边**选，不能都写 idx="0"——那会让所有线粘在同一个点上
    // （实测就是这个现象：连线跟随正常，但端口位置全跑到一处）。
    // 形状的默认连接点是四个边中点，惯例序号 0=上 1=左 2=下 3=右。
    // 注意这只做到"边对了"：我们的布局把同一条边上的多条线沿边散开，而默认连接点只有
    // 边中点这一个，多条线仍会汇到同一点。要完全保真得给形状定义自定义连接点
    // （custGeom 的 <a:cxnLst>），那需要把连线粘到 group 内部的子形状上——
    // 而"粘 group"是已经实测跟随正常的，不拿它去换未验证的方案。
    // 预设矩形的连接点序号：0=上 1=左 2=下 3=右
    const SIDE_IDX = { top: 0, left: 1, bottom: 2, right: 3 };
    const sideIdx = (an) => (an && SIDE_IDX[an.side] != null ? SIDE_IDX[an.side] : 0);
    const tFrom = cxnTargetOf.get(l.a), tTo = cxnTargetOf.get(l.b);
    const cxn = (tFrom != null ? `<a:stCxn id="${tFrom}" idx="${sideIdx(a)}"/>` : "")
              + (tTo != null ? `<a:endCxn id="${tTo}" idx="${sideIdx(b)}"/>` : "");
    body.push(`      <p:cxnSp>
        <p:nvCxnSpPr>
          <p:cNvPr id="${nextId++}" name="link"/>
          <p:cNvCxnSpPr>${cxn}</p:cNvCxnSpPr>
          <p:nvPr/>
        </p:nvCxnSpPr>
        <p:spPr>
          <a:xfrm${flipH}${flipV}><a:off x="${ox}" y="${oy}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
          <a:prstGeom prst="line"><a:avLst/></a:prstGeom>
          <a:ln w="${lnW(lt.width)}"><a:solidFill><a:srgbClr val="${hex6(lt.stroke, "6B83C9")}"/></a:solidFill>${lt.dash ? `<a:prstDash val="dash"/>` : ""}</a:ln>
        </p:spPr>
      </p:cxnSp>`);
    linkCount++;
  }

  if (layout.legend) {
    warnings.push({
      code: "PPTX_LEGEND_OMITTED",
      message: "pptx 导出当前不含图例（legend）。图上的颜色/线型含义没有随文件带出去，"
             + "汇报时需要另行说明，或改用 svg/vsdx。",
    });
  }

  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${body.join("\n")}
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;

  return {
    buf: zipSync([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: ROOT_RELS },
      { name: "docProps/app.xml", data: APP_PROPS },
      { name: "docProps/core.xml", data: CORE_PROPS },
      { name: "ppt/presentation.xml", data: PRESENTATION },
      { name: "ppt/_rels/presentation.xml.rels", data: PRESENTATION_RELS },
      { name: "ppt/slideMasters/slideMaster1.xml", data: SLIDE_MASTER },
      { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: MASTER_RELS },
      { name: "ppt/slideLayouts/slideLayout1.xml", data: SLIDE_LAYOUT },
      { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: LAYOUT_RELS },
      { name: "ppt/slides/slide1.xml", data: slide },
      { name: "ppt/slides/_rels/slide1.xml.rels", data: SLIDE_RELS },
      { name: "ppt/theme/theme1.xml", data: THEME },
    ]),
    shapeCount: shapeIdOf.size,
    linkCount,
  };
}

/* 本导出实际画出来的内容范围：zone 框 + 设备方框 + 设备标签（标签会伸到方框外）。
   刻意不用 layout.bbox——它为图例预留了空间，而 v1 不画图例。 */
function drawnBounds(model, layout) {
  const roles = (model.encoding && model.encoding.deviceRoles) || {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x1, y1, x2, y2) => {
    minX = Math.min(minX, x1); minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2);
  };
  for (const z of (layout.zones || [])) {
    if (z.bbox) eat(z.bbox.minX, z.bbox.minY, z.bbox.maxX, z.bbox.maxY);
  }
  for (const id in layout.nodes) {
    const n = layout.nodes[id];
    const r = roles[n.role] || {};
    if (r.decorative) continue;
    const { labelSize, roleSize } = R.labelMetrics(n.h);
    const half = Math.max(n.w / 2, 1.15 * Math.max(
      R.estimateTextWidth(n.label || id, labelSize),
      R.estimateTextWidth(r.legend || n.role, roleSize)) / 2);
    eat(n.cx - half, n.top, n.cx + half, n.bottom + R.labelExtentBelow(n.h, true));
  }
  if (!Number.isFinite(minX)) return layout.bbox;   // 空图兜底
  return { minX, minY, maxX, maxY };
}

// 跟 export-vsdx.js 同一套取图标逻辑：取不到一律 null 退回纯色方框，但**素材有问题要上报**
// ——静默降级的话，图标转错了只表现为"这台设备画成了方框"，分不清是没配还是出错。
function iconGeometry(role, node, warnings) {
  if (!role.icon) return null;
  let entry;
  try { entry = loadCatalog()[role.icon]; } catch (e) { return null; }
  if (!entry || !entry.blue) return null;
  const useYellow = entry.deviceType && node.iconTheme === "yellow" && entry.yellow;
  let text;
  try { text = readSvgText(useYellow ? entry.yellow : entry.blue); }
  catch (e) { warnings.push({ code: "ICON_UNREADABLE", message: `${role.icon}: 素材读不到` }); return null; }
  const geo = svgToGeometry(text);
  const bad = checkGeometry(role.icon, geo);
  if (bad.length) { warnings.push({ code: "ICON_BAD", message: bad.join("; ") }); return null; }
  return geo;
}

const CT = "application/vnd.openxmlformats-officedocument";
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="${CT}.presentationml.slide+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}.theme+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const OR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${OR}/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="${OR}/extended-properties" Target="docProps/app.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const PRESENTATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="${OR}"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>
  <p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
</p:presentation>`;

const PRESENTATION_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${OR}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="${OR}/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId3" Type="${OR}/theme" Target="theme/theme1.xml"/>
</Relationships>`;

const EMPTY_TREE = `<p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>`;

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="${OR}"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>${EMPTY_TREE}</p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"
            accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"
            hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;

const MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${OR}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="${OR}/theme" Target="../theme/theme1.xml"/>
</Relationships>`;

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="${OR}"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             type="blank" preserve="1">
  <p:cSld name="空白">${EMPTY_TREE}</p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

const LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${OR}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

const SLIDE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${OR}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;

// 主题：schema 要求 themeElements 齐全（fmtScheme 的四组 style 少一个就不合法）。
// 这里是最小可用集，不追求好看——图上的颜色一律写死在形状里，不走主题。
const FONT_SCHEME = `<a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>`;
const FILL_STYLE = `<a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>`;
const LINE_STYLE = `<a:lnStyleLst>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>`;
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    ${FONT_SCHEME}
    <a:fmtScheme name="Office">
      ${FILL_STYLE}
      ${LINE_STYLE}
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;

const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="${OR.replace("/relationships", "/extended-properties")}"
            xmlns:vt="${OR.replace("/relationships", "/docPropsVTypes")}">
  <Application>IPMaster-Cowork</Application>
  <Slides>1</Slides>
</Properties>`;

const CORE_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>网络拓扑图</dc:title>
  <dc:creator>IPMaster-Cowork</dc:creator>
</cp:coreProperties>`;

/* staticParts：除 slide1.xml 之外的全部 OPC part。导出它是为了让探针/自测脚本能拿
   同一份骨架去装自己造的 slide——此前探针靠正则从本文件里抓这些常量，脆且已经出过错。 */
function staticParts() {
  return [
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/app.xml", data: APP_PROPS },
    { name: "docProps/core.xml", data: CORE_PROPS },
    { name: "ppt/presentation.xml", data: PRESENTATION },
    { name: "ppt/_rels/presentation.xml.rels", data: PRESENTATION_RELS },
    { name: "ppt/slideMasters/slideMaster1.xml", data: SLIDE_MASTER },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: MASTER_RELS },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: SLIDE_LAYOUT },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: LAYOUT_RELS },
    { name: "ppt/theme/theme1.xml", data: THEME },
  ];
}

module.exports = { buildPptx, staticParts, SLIDE_W, SLIDE_H, EMU_PER_PX };
