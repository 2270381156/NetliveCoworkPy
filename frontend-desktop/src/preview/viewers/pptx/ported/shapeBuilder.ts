/**
 * Verbatim port of `_buildShapeParts` + its inline helpers from NID
 * `src/webview/pptxViewerPanel.ts` (lines 2396–2842 plus a few small
 * utilities below). Do not refactor — see ported/README.md.
 */
// Type imports used by _buildShapeParts (Task 6). Imported for in-file use,
// then re-exported so consumers (Task 7 slideToHtml wrapper) can reference them.
import type {
  SlideShape, TextShape, ImageShape, TableShape, ConnectorShape, ChartShape,
} from '../../../worker/parsers/pptx'
export type { SlideShape, TextShape, ImageShape, TableShape, ConnectorShape, ChartShape }
import { _presetGeomPaths } from './presetGeomPaths'
// NON-NID ADDITION: 补充预设几何（ported 表未覆盖）与图表 SVG 渲染。ported 表优先、这里只补缺；
// 图表渲染独立在 chartRenderer.ts，本文件只在 switch 里加一个 'chart' case 调它。见下方两处标注。
import { _presetGeomExtra } from '../presetGeomExtra'
import { renderChartSvg } from '../chartRenderer'
const _geomLookup = (name: string): string | undefined => _presetGeomPaths[name] ?? _presetGeomExtra[name]

// --- escapeHtml: NID imports this from htmlUtils.ts; we keep a local copy
// so ported/ stays self-contained. ---
// NOTE: NID's htmlUtils.ts escapeHtml does NOT include a `'` → `&#39;` substitution.
// The task scaffold included it, but the verbatim port matches NID exactly (4 replacements only).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Returns true if 6-digit hex color has perceived luminance < 0.5 (dark background) */
// Verbatim from NID pptxViewerPanel.ts:1901–1906 — keep, do not modify.
export function _isDark(hex: string): boolean {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/**
 * Resolve a bullet character from a (possibly symbol) font to a displayable
 * Unicode character.  Many templates store bullets as ASCII letters in
 * Wingdings / Wingdings 2 / Symbol fonts where the glyphs don't match the
 * Unicode codepoints of those letters.
 */
// Verbatim from NID pptxViewerPanel.ts:1824–1879 — wingdings/symbol-font
// character mapping used by bullet rendering. Keep verbatim.
/** Wingdings code→Unicode mapping (extended) */
const _wingdingsMap: Record<number, string> = {
  0x6C: '●', 0x6E: '◆', 0x6F: '❖', 0x73: '★',
  0x4F: '○', 0x76: '✔', 0x78: '✖', 0xFC: '✓', 0xFB: '✗',
  0xE0: '⬛', 0xA8: '◉', 0xA1: '✈', 0xAC: '♠', 0xAB: '♣',
  0xAD: '♥', 0xAE: '♦', 0x22: '✂', 0x26: '☛', 0x28: '☞',
  0x2A: '☺', 0x2B: '☻', 0x2C: '☹', 0x46: '👍', 0x48: '👎',
  0x57: '⛏', 0x74: '◼', 0x75: '◻', 0x77: '⬥', 0x7D: '⌂',
  0x21: '✏', 0x23: '✇', 0x25: '☜', 0x27: '☝', 0x29: '☠',
  0x31: '☐', 0x32: '☑', 0x33: '☒',
};

const _wingdings2Map: Record<number, string> = {
  0x75: '◆', 0x76: '◇', 0x77: '●', 0x78: '○',
  0x52: '■', 0x53: '□', 0x71: '▶', 0x72: '▷',
  0x56: '✔', 0x57: '✘', 0x50: '☐', 0x51: '☑',
};

const _wingdings3Map: Record<number, string> = {
  0x77: '►', 0x78: '◄', 0x75: '▲', 0x76: '▼',
  0x7D: '⊳', 0x7E: '⊲', 0x7B: '△', 0x7C: '▽',
};

const _knownSymbolFonts = ['symbol', 'marlett', 'webdings',
  'wingdings', 'wingdings 2', 'wingdings 3'];

function _resolveSymbolChar(char: string, font?: string | null): string {
  if (!char) { return ''; }
  const f = (font ?? '').toLowerCase().trim();
  const code = char.charCodeAt(0);
  if (f === 'wingdings 2' && _wingdings2Map[code]) { return _wingdings2Map[code]; }
  if (f === 'wingdings' && _wingdingsMap[code]) { return _wingdingsMap[code]; }
  if (f === 'wingdings 3' && _wingdings3Map[code]) { return _wingdings3Map[code]; }
  if (_knownSymbolFonts.includes(f) && code < 128) { return '•'; }
  return char;
}

/**
 * Resolve an entire text string through symbol font mapping.
 * If the font is a known symbol font, each character is individually mapped.
 */
export function _resolveSymbolText(text: string, fontFamily?: string | null): string {
  if (!text || !fontFamily) { return text; }
  const f = fontFamily.replace(/"/g, '').split(',')[0].toLowerCase().trim();
  if (!_knownSymbolFonts.includes(f)) { return text; }
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += _resolveSymbolChar(text[i], f);
  }
  return result;
}

/** Format an auto-numbered bullet value based on OOXML buAutoNum type */
// Verbatim from NID pptxViewerPanel.ts:2396–2429 — auto-numbering helpers
// used by _buildShapeParts for bulleted lists. Keep verbatim.
export function _formatAutoNum(type: string, n: number): string {
  switch (type) {
    case 'arabicPeriod': return `${n}.`;
    case 'arabicParenR': return `${n})`;
    case 'arabicParenBoth': return `(${n})`;
    case 'arabicPlain': return `${n}`;
    case 'romanUcPeriod': return `${_toRoman(n)}.`;
    case 'romanLcPeriod': return `${_toRoman(n).toLowerCase()}.`;
    case 'alphaUcPeriod': return `${_toAlpha(n)}.`;
    case 'alphaLcPeriod': return `${_toAlpha(n).toLowerCase()}.`;
    case 'alphaUcParenR': return `${_toAlpha(n)})`;
    case 'alphaLcParenR': return `${_toAlpha(n).toLowerCase()})`;
    case 'alphaUcParenBoth': return `(${_toAlpha(n)})`;
    case 'alphaLcParenBoth': return `(${_toAlpha(n).toLowerCase()})`;
    default: return `${n}.`;
  }
}
function _toRoman(n: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}
function _toAlpha(n: number): string {
  let result = '';
  while (n > 0) { n--; result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26); }
  return result;
}

export { _presetGeomPaths }

// ────────────────────────────────────────────────────────────────────────────
// Verbatim from NID pptxViewerPanel.ts:2430–2842 — the core shape-to-HTML+CSS
// emitter. Do not refactor — see ported/README.md.
// ────────────────────────────────────────────────────────────────────────────

// _BuildParts interface (verbatim from NID pptxViewerPanel.ts:2428).
export interface _BuildParts { html: string; css: string; }

// _buildShapeParts (verbatim from NID pptxViewerPanel.ts:2430–2842).
export function _buildShapeParts(
  shape: SlideShape, slideW: number, slideH: number,
  slideIdx: number | string, shapeIdx: number,
): _BuildParts {
  const cls = `sh-${slideIdx}-${shapeIdx}`;
  const leftPct = ((shape.left / slideW) * 100).toFixed(2);
  const topPct = ((shape.top / slideH) * 100).toFixed(2);
  const widthPct = ((shape.width / slideW) * 100).toFixed(2);
  const heightPct = ((shape.height / slideH) * 100).toFixed(2);

  switch (shape.type) {
    case 'text': {
      const svgPath = shape.customSvgPath ?? (shape.shapeGeom ? _geomLookup(shape.shapeGeom) : undefined);  // NON-NID: 合并补充几何表
      const useShapeSvg = !!(svgPath && (shape.fill || shape.border || shape.customSvgPath));
      const textOverflow = ((shape.fill || shape.bgImage) && !useShapeSvg) ? 'overflow:hidden;' : 'overflow:visible;';
      let css = `.${cls}{position:absolute;left:${leftPct}%;top:${topPct}%;width:${widthPct}%;height:${heightPct}%;${textOverflow}`;
      if (shape.fill && !useShapeSvg) { css += `background:${shape.fill};`; }
      if (shape.bgImage) { css += `background-image:url(${shape.bgImage});background-size:100% 100%;`; }
      if (shape.border && !useShapeSvg) { const bwPt = (shape.border.widthPx * 0.75).toFixed(1); css += `border:calc(${bwPt} * var(--pt,1pt)) solid ${shape.border.color};`; }
      if (shape.shadow) { css += `box-shadow:${shape.shadow};`; }
      // NON-NID: roundRect 半径改用 var(--pt) 表达（随容器缩放、四角统一圆形），取代原 border-radius:%（非正方形盒子上会拉成椭圆）。
      if (shape.borderRadius) { css += `border-radius:calc(${(shape.borderRadius * 0.75).toFixed(1)} * var(--pt,1pt));`; }
      if (shape.rotation) { css += `transform:rotate(${shape.rotation.toFixed(1)}deg);`; }
      // Vertical text
      if (shape.verticalText) {
        if (shape.verticalText === 'eaVert' || shape.verticalText === 'vert') {
          css += 'writing-mode:vertical-rl;';
        } else if (shape.verticalText === 'vert270') {
          css += 'writing-mode:vertical-rl;transform:rotate(180deg);';
        } else if (shape.verticalText === 'wordArtVert') {
          css += 'writing-mode:vertical-rl;text-orientation:upright;';
        }
      }
      // Vertical anchor: flexbox centering
      if (shape.anchor === 'ctr') {
        css += 'display:flex;flex-direction:column;justify-content:center;';
      } else if (shape.anchor === 'b') {
        css += 'display:flex;flex-direction:column;justify-content:flex-end;';
      }
      // Apply text body insets as padding (convert px → pt for proportional scaling)
      if (useShapeSvg && shape.paragraphs.every(p => p.runs.every(r => !r.text.trim()))) {
        // Decorative shape with no visible text — remove padding so SVG fills the bounding box
        css += 'padding:0;';
      } else if (shape.insets) {
        const [t, r, b, l] = shape.insets.map(v => v * 0.75);  // px → pt
        css += `padding:calc(${t.toFixed(1)} * var(--pt,1pt)) calc(${r.toFixed(1)} * var(--pt,1pt)) calc(${b.toFixed(1)} * var(--pt,1pt)) calc(${l.toFixed(1)} * var(--pt,1pt));`;
      }
      css += `}\n`;

      // Resolve auto-numbered bullets: count consecutive paragraphs with same autonum type
      const autoNumCounters = new Map<string, number>();
      const resolvedBullets: (string | null)[] = shape.paragraphs.map(p => {
        if (!p.bullet || !p.bullet.startsWith('__autonum__')) { return p.bullet; }
        const parts = p.bullet.split('__');
        // parts: ['', 'autonum', '', type, '', startAt]
        const numType = parts[3] ?? 'arabicPeriod';
        const startAt = parseInt(parts[5] ?? '1', 10);
        const key = `${numType}-${p.indentLevel ?? 0}`;
        const current = (autoNumCounters.get(key) ?? (startAt - 1)) + 1;
        autoNumCounters.set(key, current);
        return _formatAutoNum(numType, current);
      });

      let inner = '';
      for (let pi = 0; pi < shape.paragraphs.length; pi++) {
        const p = shape.paragraphs[pi];
        const pCls = `${cls}-p${pi}`;
        const pFontSz = p.runs[0]?.fontSize || 14;
        const mt = p.spaceBefore !== undefined ? `calc(${p.spaceBefore} * var(--pt, 1pt))` : '0';
        const mb = p.spaceAfter !== undefined ? `calc(${p.spaceAfter} * var(--pt, 1pt))` : '0';
        let pCss = `.${pCls}{text-align:${p.align};margin:${mt} 0 ${mb} 0;font-size:calc(${pFontSz} * var(--pt, 1pt));`;
        if (p.lineHeightPt !== undefined) {
          pCss += `line-height:calc(${p.lineHeightPt} * var(--pt, 1pt));`;
        } else if (p.lineHeight !== undefined) {
          pCss += `line-height:${p.lineHeight.toFixed(2)};`;
        }
        // Multi-level indent: use marL (left margin) if specified, else fall back to level-based
        const bulletText = resolvedBullets[pi];
        if (p.marginLeftPt !== undefined) {
          const indPt = (p.indentPt ?? 0) * 0.75;  // px → pt for scaling
          const padPt = p.marginLeftPt * 0.75;      // px → pt for scaling
          // OOXML indent is the first-line offset relative to marL (negative = hanging)
          pCss += `padding-left:calc(${padPt.toFixed(1)} * var(--pt,1pt));text-indent:calc(${indPt.toFixed(1)} * var(--pt,1pt));`;
        } else if (bulletText) {
          const level = p.indentLevel ?? 0;
          const indentEm = 1.2 + level * 1.2;
          pCss += `padding-left:${indentEm.toFixed(1)}em;text-indent:-1.2em;`;
        }
        pCss += '}\n';
        css += pCss;

        let runsHtml = '';
        for (let ri = 0; ri < p.runs.length; ri++) {
          const r = p.runs[ri];
          const rCls = `${cls}-p${pi}-r${ri}`;
          // Map symbol font characters (Wingdings etc.) to Unicode
          const displayText = _resolveSymbolText(r.text, r.fontFamily);
          let rCss = '';
          if (r.bold) { rCss += 'font-weight:bold;'; }
          if (r.italic) { rCss += 'font-style:italic;'; }
          if (r.fontSize) { rCss += `font-size:calc(${r.fontSize} * var(--pt, 1pt));`; }
          if (r.fontFamily && displayText === r.text) { rCss += `font-family:${r.fontFamily};`; }
          if (r.color) { rCss += `color:${r.color};`; }
          // NON-NID ADDITION: glow → text-shadow (colored halo around light
          // headings; see _resolveGlow in the parser). Kept minimal so the
          // rest of this file stays a faithful NID port.
          if (r.glow) { rCss += `text-shadow:${r.glow};`; }
          if (r.underline && r.strikethrough) { rCss += 'text-decoration:underline line-through;'; }
          else if (r.underline) { rCss += 'text-decoration:underline;'; }
          else if (r.strikethrough) { rCss += 'text-decoration:line-through;'; }
          if (r.spacing) { rCss += `letter-spacing:calc(${r.spacing} * var(--pt, 1pt));`; }
          // Superscript/subscript
          if (r.baseline && r.baseline > 0) { rCss += 'vertical-align:super;font-size:65%;'; }
          else if (r.baseline && r.baseline < 0) { rCss += 'vertical-align:sub;font-size:65%;'; }
          let spanContent = escapeHtml(displayText);
          if (rCss) {
            css += `.${rCls}{${rCss}}\n`;
            spanContent = `<span class="${rCls}">${spanContent}</span>`;
          }
          // Wrap with hyperlink if present
          if (r.href) {
            spanContent = `<a href="${escapeHtml(r.href)}" target="_blank" rel="noopener">${spanContent}</a>`;
          }
          runsHtml += spanContent;
        }

        // Only show bullet when there's actual text; empty bullet paragraphs render as blank line
        let bulletHtml = '';
        if (bulletText && runsHtml) {
          const buCls = `${cls}-p${pi}-bu`;
          let buCss = '';
          if (p.bulletColor) { buCss += `color:${p.bulletColor};`; }
          if (p.bulletSizePct !== undefined && p.bulletSizePct !== 100) {
            buCss += `font-size:${p.bulletSizePct.toFixed(0)}%;`;
          }
          if (buCss) {
            css += `.${buCls}{${buCss}}\n`;
            bulletHtml = `<span class="${buCls}" aria-hidden="true">${escapeHtml(bulletText)} </span>`;
          } else {
            bulletHtml = `<span aria-hidden="true">${escapeHtml(bulletText)} </span>`;
          }
        }
        // Empty paragraph: use <br> to preserve one line of vertical space
        const content = (bulletHtml || runsHtml) ? `${bulletHtml}${runsHtml}` : '<br>';
        inner += `<p class="${pCls}">${content}</p>`;
      }
      // Prepend SVG background for non-rect shapes
      let svgBg = '';
      if (useShapeSvg && svgPath) {
        const fillAttr = shape.fill ? ` fill="${escapeHtml(shape.fill)}"` : ' fill="none"';
        const strokeAttr = shape.border ? ` stroke="${escapeHtml(shape.border.color)}" stroke-width="${shape.border.widthPx}"` : '';
        // NON-NID: 仅椭圆加 overflow:visible —— 让其四个顶点处的居中描边外半段不被 SVG 默认裁剪(修 p4"被削")。
        // 只限椭圆,避免给其它带边框形状(如 flowchart 框)也放开、导致边框外半显出来看起来变粗。
        const svgOverflow = shape.shapeGeom === 'ellipse' ? 'overflow:visible;' : '';
        css += `.${cls}-svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;${svgOverflow}}\n`;
        if (shape.shapeGeom === 'ellipse') {
          // Use native SVG ellipse for correct scaling at any size
          svgBg = `<svg class="${cls}-svg" viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="50" rx="50" ry="50"${fillAttr}${strokeAttr} vector-effect="non-scaling-stroke"/></svg>`;
        } else {
          svgBg = `<svg class="${cls}-svg" viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><path d="${svgPath}"${fillAttr}${strokeAttr} vector-effect="non-scaling-stroke"/></svg>`;
        }
      }
      const fgInner = shape.autoFit === 'norm' ? `<div class="autofit-inner" data-autofit="norm">${inner}</div>` : inner;
      // NON-NID: 有 SVG 背景时,文字外包一层 position:relative,确保绘制在绝对定位的 svgBg 之上。
      // 否则填充 SVG(如 P20 填充圆、其它带填充的形状)会盖住居中文字,导致"字丢了"。
      if (useShapeSvg && svgBg) {
        css += `.${cls}-fg{position:relative;}\n`;
        return { html: `<div class="shape-text ${cls}">${svgBg}<div class="${cls}-fg">${fgInner}</div></div>`, css };
      }
      return { html: `<div class="shape-text ${cls}">${svgBg}${fgInner}</div>`, css };
    }
    case 'image': {
      let css = `.${cls}{position:absolute;left:${leftPct}%;top:${topPct}%;width:${widthPct}%;height:${heightPct}%;overflow:hidden;`;
      if (shape.rotation) { css += `transform:rotate(${shape.rotation.toFixed(1)}deg);`; }
      css += `}\n`;
      if (shape.crop) {
        // srcRect crops: l/t/r/b are percentages of the original image to remove
        // Use object-fit:cover + object-position to show only the visible region
        const visW = 100 - shape.crop.l - shape.crop.r;
        const visH = 100 - shape.crop.t - shape.crop.b;
        const scaleX = (100 / visW * 100).toFixed(2);
        const scaleY = (100 / visH * 100).toFixed(2);
        const posX = visW > 0 ? (shape.crop.l / visW * 100).toFixed(2) : '0';
        const posY = visH > 0 ? (shape.crop.t / visH * 100).toFixed(2) : '0';
        css += `.${cls} img{width:${scaleX}%;height:${scaleY}%;object-fit:fill;margin-left:-${posX}%;margin-top:-${posY}%;}\n`;
      } else {
        css += `.${cls} img{width:100%;height:100%;}\n`;
      }
      return { html: `<div class="${cls}"><img src="${shape.dataUri}" /></div>`, css };
    }
    case 'chart': {
      // NON-NID ADDITION: 原生 PPTX 图表 → SVG（渲染逻辑在 ../chartRenderer.ts）。绝对定位填满 box。
      const css = `.${cls}{position:absolute;left:${leftPct}%;top:${topPct}%;width:${widthPct}%;height:${heightPct}%;overflow:hidden;}\n`;
      return { html: `<div class="${cls}">${renderChartSvg(shape)}</div>`, css };
    }
    case 'connector': {
      // Render connector as absolutely-positioned SVG covering the full slide.
      // Connectors often have zero width or height (vertical/horizontal lines),
      // so percentage-based sizing inside a near-zero div won't work.
      // Instead, place a full-slide SVG and draw the line at exact positions.
      const markerId = `arrow-${slideIdx}-${shapeIdx}`;

      // Compute start/end points in slide-percentage space
      const lPct = shape.left / slideW * 100;
      const tPct = shape.top / slideH * 100;
      const wPct = shape.width / slideW * 100;
      const hPct = shape.height / slideH * 100;

      // flipH/flipV determine which corners are start vs end
      let sx: number, sy: number, ex: number, ey: number;
      if (!shape.flipH && !shape.flipV) {
        sx = lPct; sy = tPct; ex = lPct + wPct; ey = tPct + hPct;
      } else if (shape.flipH && !shape.flipV) {
        sx = lPct + wPct; sy = tPct; ex = lPct; ey = tPct + hPct;
      } else if (!shape.flipH && shape.flipV) {
        sx = lPct; sy = tPct + hPct; ex = lPct + wPct; ey = tPct;
      } else {
        sx = lPct + wPct; sy = tPct + hPct; ex = lPct; ey = tPct;
      }

      let defs = '';
      let lineAttrs = `stroke="${shape.strokeColor}" stroke-width="${shape.strokeWidth}"`;
      if (shape.dashStyle) { lineAttrs += ` stroke-dasharray="${shape.dashStyle}"`; }

      if (shape.headArrow || shape.tailArrow) {
        defs = '<defs>';
        if (shape.tailArrow) {
          defs += `<marker id="${markerId}-tail" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${shape.strokeColor}"/></marker>`;
          lineAttrs += ` marker-end="url(#${markerId}-tail)"`;
        }
        if (shape.headArrow) {
          defs += `<marker id="${markerId}-head" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M10,0 L0,5 L10,10 Z" fill="${shape.strokeColor}"/></marker>`;
          lineAttrs += ` marker-start="url(#${markerId}-head)"`;
        }
        defs += '</defs>';
      }

      // Build SVG shape based on connector type
      const connType = shape.connectorType;
      let svgShape = '';

      // Determine points for bent connectors
      let points: number[][] | null = null;
      // Determine if connector is primarily vertical or horizontal
      // by comparing absolute spans of start→end in each axis
      const spanX = Math.abs(ex - sx);
      const spanY = Math.abs(ey - sy);
      const verticalFirst = spanY > spanX;

      if (connType === 'bentConnector2') {
        if (verticalFirst) {
          // V-then-H: start → (sx, ey) → end
          points = [[sx,sy], [sx,ey], [ex,ey]];
        } else {
          // H-then-V: start → (ex, sy) → end
          points = [[sx,sy], [ex,sy], [ex,ey]];
        }
      } else if (connType === 'bentConnector3') {
        const adj1 = shape.adjustValues[0] ?? 0.5;
        if (verticalFirst) {
          // V-H-V pattern (down → right → up/down)
          const midY = tPct + adj1 * hPct;
          points = [[sx,sy], [sx,midY], [ex,midY], [ex,ey]];
        } else {
          // H-V-H pattern (right → down → right)
          const midX = lPct + adj1 * wPct;
          points = [[sx,sy], [midX,sy], [midX,ey], [ex,ey]];
        }
      } else if (connType === 'bentConnector4') {
        const adj1 = shape.adjustValues[0] ?? 0.5;
        const adj2 = shape.adjustValues[1] ?? 0.5;
        if (verticalFirst) {
          // V-H-V-H: down → right → down → right
          const midY = tPct + adj1 * hPct;
          const midX = lPct + adj2 * wPct;
          points = [[sx,sy], [sx,midY], [midX,midY], [midX,ey], [ex,ey]];
        } else {
          // H-V-H-V: right → down → right → down
          const midX = lPct + adj1 * wPct;
          const midY = tPct + adj2 * hPct;
          points = [[sx,sy], [midX,sy], [midX,midY], [ex,midY], [ex,ey]];
        }
      } else if (connType === 'bentConnector5') {
        const adj1 = shape.adjustValues[0] ?? 0.5;
        const adj2 = shape.adjustValues[1] ?? 0.5;
        const adj3 = shape.adjustValues[2] ?? 0.5;
        if (verticalFirst) {
          const midY1 = tPct + adj1 * hPct;
          const midX = lPct + adj2 * wPct;
          const midY2 = tPct + adj3 * hPct;
          points = [[sx,sy], [sx,midY1], [midX,midY1], [midX,midY2], [ex,midY2], [ex,ey]];
        } else {
          const midX1 = lPct + adj1 * wPct;
          const midY = tPct + adj2 * hPct;
          const midX2 = lPct + adj3 * wPct;
          points = [[sx,sy], [midX1,sy], [midX1,midY], [midX2,midY], [midX2,ey], [ex,ey]];
        }
      } else if (connType.startsWith('curvedConnector')) {
        // Curved connectors: use cubic bezier curves
        if (connType === 'curvedConnector2') {
          // Simple curve through (ex, sy)
          svgShape = `<path d="M${sx.toFixed(3)},${sy.toFixed(3)} C${ex.toFixed(3)},${sy.toFixed(3)} ${ex.toFixed(3)},${sy.toFixed(3)} ${ex.toFixed(3)},${ey.toFixed(3)}" fill="none" ${lineAttrs} vector-effect="non-scaling-stroke"/>`;
        } else if (connType === 'curvedConnector3') {
          const adj1 = shape.adjustValues[0] ?? 0.5;
          const midX = lPct + adj1 * wPct;
          svgShape = `<path d="M${sx.toFixed(3)},${sy.toFixed(3)} C${midX.toFixed(3)},${sy.toFixed(3)} ${midX.toFixed(3)},${ey.toFixed(3)} ${ex.toFixed(3)},${ey.toFixed(3)}" fill="none" ${lineAttrs} vector-effect="non-scaling-stroke"/>`;
        } else {
          // curvedConnector4/5: fallback to straight line
          svgShape = `<line x1="${sx.toFixed(3)}" y1="${sy.toFixed(3)}" x2="${ex.toFixed(3)}" y2="${ey.toFixed(3)}" ${lineAttrs} vector-effect="non-scaling-stroke"/>`;
        }
      }

      if (points) {
        // Bent connectors: use <polyline>
        const pointsStr = points.map(p => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join(' ');
        svgShape = `<polyline points="${pointsStr}" fill="none" ${lineAttrs} vector-effect="non-scaling-stroke"/>`;
      } else if (!connType.startsWith('curvedConnector')) {
        // Straight line (default / straightConnector1 / line)
        svgShape = `<line x1="${sx.toFixed(3)}" y1="${sy.toFixed(3)}" x2="${ex.toFixed(3)}" y2="${ey.toFixed(3)}" ${lineAttrs} vector-effect="non-scaling-stroke"/>`;
      }

      const css = `.${cls}{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;}\n`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style="overflow:visible">${defs}${svgShape!}</svg>`;
      return { html: `<div class="${cls}">${svg}</div>`, css };
    }
    case 'table': {
      let css = `.${cls}{position:absolute;left:${leftPct}%;top:${topPct}%;width:${widthPct}%;height:${heightPct}%;overflow:visible;}\n`;

      // Colgroup for column widths
      let colgroup = '';
      if (shape.colWidths.length > 0) {
        colgroup = '<colgroup>';
        for (let ci = 0; ci < shape.colWidths.length; ci++) {
          const colCls = `${cls}-c${ci}`;
          colgroup += `<col class="${colCls}">`;
          css += `.${colCls}{width:${shape.colWidths[ci].toFixed(2)}%;}\n`;
        }
        colgroup += '</colgroup>';
      }

      // Row height CSS
      for (let ri = 0; ri < shape.rowHeights.length; ri++) {
        css += `.${cls}-r${ri}{height:${shape.rowHeights[ri].toFixed(2)}%;}\n`;
      }

      // Banding / header row styles (applied via row class, only when cells lack explicit bgColor)
      const bandStartRow = shape.firstRow ? 1 : 0;
      if (shape.firstRow) {
        css += `.${cls}-r0 th,.${cls}-r0 td{font-weight:bold;}\n`;
      }
      if (shape.bandRow) {
        // Even data rows (relative to bandStartRow) get a subtle shading
        for (let ri = bandStartRow; ri < shape.rows.length; ri++) {
          if ((ri - bandStartRow) % 2 === 1) {
            css += `.${cls}-r${ri} th:not([class*="bg"]),.${cls}-r${ri} td:not([class*="bg"]){background:rgba(0,0,0,0.04);}\n`;
          }
        }
      }

      let cellIdx = 0;
      let tbl = `<table class="slide-table">${colgroup}`;
      for (let r = 0; r < shape.rows.length; r++) {
        tbl += `<tr class="${cls}-r${r}">`;
        const tag = (r === 0 && shape.firstRow) ? 'th' : 'td';
        for (const cell of shape.rows[r]) {
          if (cell.skip) { continue; }  // merged-away cell
          const cellCls = `${cls}-cell${cellIdx++}`;
          let attrs = ` class="${cellCls}"`;
          if (cell.colspan > 1) { attrs += ` colspan="${cell.colspan}"`; }
          if (cell.rowspan > 1) { attrs += ` rowspan="${cell.rowspan}"`; }
          // Cell background color + alignment + borders CSS
          const cellStyles: string[] = [];
          if (cell.bgColor) {
            cellStyles.push(`background:${cell.bgColor}`);
          } else if (r === 0 && shape.firstRow) {
            // Header row default: use theme accent color with white text
            const hdrBg = shape.accentColor ?? '#4472C4';
            cellStyles.push(`background:${hdrBg}`);
            cellStyles.push('color:#ffffff');
          }
          if (cell.align) { cellStyles.push(`text-align:${cell.align}`); }
          if (cell.vAlign) { cellStyles.push(`vertical-align:${cell.vAlign}`); }
          if (cell.borders) {
            const _bpt = (w: number) => `calc(${(w * 0.75).toFixed(1)} * var(--pt,1pt))`;
            if (cell.borders.top) { cellStyles.push(`border-top:${_bpt(cell.borders.top.widthPx)} solid ${cell.borders.top.color}`); }
            if (cell.borders.right) { cellStyles.push(`border-right:${_bpt(cell.borders.right.widthPx)} solid ${cell.borders.right.color}`); }
            if (cell.borders.bottom) { cellStyles.push(`border-bottom:${_bpt(cell.borders.bottom.widthPx)} solid ${cell.borders.bottom.color}`); }
            if (cell.borders.left) { cellStyles.push(`border-left:${_bpt(cell.borders.left.widthPx)} solid ${cell.borders.left.color}`); }
          }
          if (cellStyles.length) {
            css += `.slide-table .${cellCls}{${cellStyles.join(';')};}\n`;
          }
          // Render cell content with formatted runs
          let cellContent = '';
          if (cell.runs && cell.runs.length > 0) {
            let runIdx = 0;
            for (const run of cell.runs) {
              if (run.text === '\n') {
                cellContent += '<br>';
                continue;
              }
              const runCls = `${cellCls}-r${runIdx++}`;
              const cellDisplayText = _resolveSymbolText(run.text, run.fontFamily ?? null);
              let rCss = '';
              if (run.bold) { rCss += 'font-weight:bold;'; }
              if (run.color) { rCss += `color:${run.color};`; }
              if (run.fontSize) { rCss += `font-size:calc(${run.fontSize} * var(--pt, 1pt));`; }
              if (run.fontFamily && cellDisplayText === run.text) { rCss += `font-family:${run.fontFamily};`; }
              if (rCss) {
                css += `.${runCls}{${rCss}}\n`;
                cellContent += `<span class="${runCls}">${escapeHtml(cellDisplayText)}</span>`;
              } else {
                cellContent += escapeHtml(cellDisplayText);
              }
            }
          } else {
            cellContent = escapeHtml(cell.text);
          }
          tbl += `<${tag}${attrs}>${cellContent}</${tag}>`;
        }
        tbl += '</tr>';
      }
      tbl += '</table>';
      return { html: `<div class="${cls}">${tbl}</div>`, css };
    }
    default:
      return { html: '', css: '' };
  }
}
