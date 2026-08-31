/**
 * PptxViewerPanel
 *
 * VS Code WebviewPanel for read-only PPTX viewing.
 *
 * Architecture: Extension Host reads PPTX via JSZip + @xmldom/xmldom
 * (PPTX = ZIP of OOXML), extracts slides with text, images, and tables,
 * then renders as HTML cards in the webview. No Document Service dependency.
 */

import JSZip from 'jszip'
// This parser now runs on the MAIN THREAD (not a Web Worker), so we use the
// browser-native DOMParser. Reason for the move: xmldom is pure-JS DOM with
// no internal indices, making getElementsByTagName O(subtree) per call —
// catastrophic on heavy slide layouts (the user's test deck has one 100KB
// layout with 49 shapes that took 13s to extract under xmldom). Native
// DOMParser builds a real DOM with cached HTMLCollection indices and is
// >10x faster. It's not in DedicatedWorkerGlobalScope (Window only, per
// spec), which is why we run on the main thread now — see file-rendering-
// upgrade memory entry for the full pivot rationale.

// ── OOXML Namespaces ─────────────────────────────────────────────────────────

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
// ── Types ────────────────────────────────────────────────────────────────────

export interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontSize: number | null;    // pt
  fontFamily: string | null;  // CSS font-family
  color: string | null;       // CSS color (#hex or rgba)
  spacing: number | null;     // letter-spacing in pt
  href: string | null;        // hyperlink URL (from hlinkClick)
  baseline: number | null;    // superscript (>0) / subscript (<0) in 1000ths of %
  highlight: string | null;   // text highlight background color
  glow: string | null;        // CSS text-shadow from <a:effectLst><a:glow> (colored halo)
}

export interface TextParagraph {
  runs: TextRun[];
  align: string;
  bullet: string | null;  // bullet character to prepend, null = no bullet
  indentLevel?: number;   // 0-based indentation level from pPr lvl
  marginLeftPt?: number;  // left margin in pt from pPr marL
  indentPt?: number;      // hanging indent in pt from pPr indent (negative = hanging)
  lineHeight?: number;    // CSS line-height multiplier (e.g. 1.2, 1.8)
  lineHeightPt?: number;  // absolute line-height in pt (from spcPts)
  spaceBefore?: number;   // pt — margin-top
  spaceAfter?: number;    // pt — margin-bottom
  bulletColor?: string;   // CSS color for bullet character
  bulletSizePct?: number; // bullet size as % of text size (e.g. 100 = same size)
}

export interface TextShape {
  type: 'text';
  left: number; top: number; width: number; height: number;
  rotation?: number;  // degrees (clockwise)
  paragraphs: TextParagraph[];
  fill?: string;  // CSS color for shape background (from spPr solidFill)
  border?: { color: string; widthPx: number };  // shape outline from <a:ln>
  shadow?: string;  // CSS box-shadow value from <a:outerShdw>
  shapeGeom?: string;  // preset geometry name (e.g. 'ellipse', 'rightArrow')
  borderRadius?: number; // CSS border-radius in px (for roundRect shapes)
  insets?: [number, number, number, number]; // [top, right, bottom, left] in px from bodyPr
  anchor?: string;  // vertical alignment: 'top' | 'ctr' | 'b'
  verticalText?: string;  // vertical text mode from bodyPr vert
  autoFit?: 'sp' | 'norm';  // sp: shape grows to fit text; norm: shrink text to fit shape
  customSvgPath?: string;  // SVG path data for custom geometry (custGeom)
  bgImage?: string;  // background image data URI from blipFill
  isTitle?: boolean;  // true when this shape is the slide's title/centered-title placeholder (<ph type="title"|"ctrTitle">)
}

export interface ImageShape {
  type: 'image';
  left: number; top: number; width: number; height: number;
  rotation?: number;  // degrees (clockwise)
  dataUri: string;
  crop?: { l: number; t: number; r: number; b: number };  // percentages 0-100
}

interface TableCellRun {
  text: string;
  bold?: boolean;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
}

interface CellBorder {
  color: string;
  widthPx: number;
}
interface TableCell {
  text: string;
  colspan: number;
  rowspan: number;
  skip: boolean; // true for cells covered by a merge
  bgColor?: string;   // CSS color for cell background
  align?: string;     // CSS text-align from <a:pPr algn>
  vAlign?: string;    // CSS vertical-align from <a:tcPr anchor>
  borders?: { top?: CellBorder; right?: CellBorder; bottom?: CellBorder; left?: CellBorder };
  runs?: TableCellRun[];  // formatted text runs
}

export interface TableShape {
  type: 'table';
  left: number; top: number; width: number; height: number;
  colWidths: number[];   // percentage of total table width per column
  rowHeights: number[];  // percentage of total table height per row
  rows: TableCell[][];
  bandRow?: boolean;     // alternating row shading
  bandCol?: boolean;     // alternating column shading
  firstRow?: boolean;    // header row styling
  lastRow?: boolean;
  accentColor?: string;  // theme accent1 color for header row background
}

export interface ConnectorShape {
  type: 'connector';
  left: number; top: number; width: number; height: number;
  flipH: boolean; flipV: boolean;
  strokeColor: string;   // CSS color
  strokeWidth: number;   // px
  dashStyle: string;     // SVG stroke-dasharray value ('' for solid)
  headArrow: boolean;    // true = draw arrowhead at start
  tailArrow: boolean;    // true = draw arrowhead at end
  connectorType: string;     // 'line' | 'bentConnector2' | 'bentConnector3' | etc.
  adjustValues: number[];    // adjustment values as fractions (0-1)
}

export interface ChartSeries {
  name?: string;
  color?: string;        // CSS color (series spPr 的 solidFill 或 a:ln 描边色); 缺省用调色板
  values: number[];      // 主数值(柱/条/折线/饼的 val；散点/气泡的 yVal)
  xValues?: number[];    // 散点/气泡的 xVal
  sizes?: number[];      // 气泡的 bubbleSize
  marker?: string;       // 散点标记形状(c:marker/c:symbol): circle/square/diamond/triangle/x/plus/star/dash/dot/none
  pointColors?: (string | undefined)[];  // 每数据点颜色(c:dPt)，饼/环按点着色时用
}
export interface ChartShape {
  type: 'chart';
  left: number; top: number; width: number; height: number;
  chartType: 'bar' | 'column' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'radar';
  categories: string[];  // 分类轴标签
  series: ChartSeries[];
  title?: string;
  showValues?: boolean;  // 是否显示数值标签(c:dLbls showVal)
}

export type SlideShape = TextShape | ImageShape | TableShape | ConnectorShape | ChartShape;

/** Position/size + default text style of a placeholder (from master/layout) */
interface PlaceholderTransform {
  left: number; top: number; width: number; height: number;
  defFontSz?: number;   // pt — from master txStyles defRPr sz/100
  defAlign?: string;    // CSS text-align — from master txStyles pPr algn
  defBullet?: string;   // bullet char — from master txStyles buChar/@char
  defColor?: string;    // CSS color — from master txStyles / layout lstStyle defRPr solidFill
}

/** Coordinate mapping for a <p:grpSp> group shape.
 *  Children in child-coord space → slide space:
 *    slideX = offX + (childX - chOffX) * extCx / chExtCx  (all in EMU)
 */
interface GroupTransform {
  offX: number; offY: number;       // group's position in slide space (EMU)
  extCx: number; extCy: number;     // group's size in slide space (EMU)
  chOffX: number; chOffY: number;   // child coordinate origin
  chExtCx: number; chExtCy: number; // child coordinate extent
}

export interface SlideData {
  index: number;
  width: number;
  height: number;
  shapes: SlideShape[];
  masterShapes: SlideShape[];       // non-placeholder shapes from slide master
  layoutShapes: SlideShape[];       // non-placeholder shapes from slide layout
  suppressMasterShapes: boolean;    // true when layout has showMasterSp="0"
  bgColor?: string;       // solid fill hex, e.g. '000000'
  bgImage?: string;       // data URI for image background (blipFill)
}

// ── PPTX Reading (JSZip + xmldom in Node.js) ────────────────────────────────

/** EMU → CSS px at 96 DPI */
function _emuToPx(emu: number): number {
  return Math.round(emu / 914400 * 96 * 10) / 10;
}

/**
 * EMF/WMF conversion hook. Browsers can't render Windows metafiles in <img>,
 * so the host (Electron main process, via GDI+) converts them to PNG. The
 * viewer injects a converter via setEmfConverter; when absent (tests, plain
 * browser, dev) metafiles are left unconverted and render as a placeholder.
 * Input: [{key, b64}] (raw metafile bytes); Output: [{key, png|null}] (PNG base64).
 */
type EmfConverter = (items: { key: string; b64: string }[]) => Promise<{ key: string; png: string | null }[]>;
let _emfConverter: EmfConverter | null = null;
export function setEmfConverter(fn: EmfConverter | null): void { _emfConverter = fn; }
// Per-parse cache: media path (e.g. 'ppt/media/image4.emf') → PNG data URI.
let _emfCache: Map<string, string> = new Map();

/** True for paths the browser can't render directly (Windows metafiles). */
function _isMetafile(pathLower: string): boolean {
  return pathLower.endsWith('.emf') || pathLower.endsWith('.wmf');
}

/**
 * Convert every EMF/WMF in the zip up-front, in ONE batch, and cache the
 * resulting PNG data URIs by media path. Called once at the start of parse so
 * later per-shape image lookups just read the cache. No-op without a converter.
 */
async function _prefetchMetafiles(zip: JSZip): Promise<void> {
  _emfCache = new Map();
  if (!_emfConverter) { return; }
  const paths = Object.keys(zip.files).filter((p) => _isMetafile(p.toLowerCase()));
  if (paths.length === 0) { return; }
  try {
    const items = await Promise.all(paths.map(async (p) => ({ key: p, b64: await zip.file(p)!.async('base64') })));
    const results = await _emfConverter(items);
    for (const r of results) {
      if (r.png) { _emfCache.set(r.key, `data:image/png;base64,${r.png}`); }
    }
  } catch { /* leave cache empty → placeholders */ }
}

/** Resolve a media path + already-read base64 + ext into a final image data
 * URI. Metafiles (.emf/.wmf) come from the converted-PNG cache; everything
 * else is the raw base64 under its real mime. Returns '' for an unconverted
 * metafile so the caller can render a placeholder instead of a broken <img>. */
function _imageDataUri(imgPath: string, ext: string, blob: string): string {
  if (_isMetafile(imgPath.toLowerCase())) {
    return _emfCache.get(imgPath) ?? '';
  }
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
  };
  return `data:${mimeMap[ext] ?? 'image/png'};base64,${blob}`;
}

export async function parsePptx(
  data: ArrayBuffer | Uint8Array,
  /** Called after each slide is parsed: (done, total). Lets the caller show
   * progress on very large decks (the test corpus has a 368-slide / 48MB
   * deck whose parse takes ~22s). */
  onProgress?: (done: number, total: number) => void,
): Promise<{ slides: SlideData[]; themeFonts: Map<string, string> }> {
  const zip = await JSZip.loadAsync(data);
  const parser = new DOMParser();

  // Convert all EMF/WMF metafiles to PNG up-front (one batch) so per-shape
  // image lookups below can read the cache. No-op without an injected converter.
  await _prefetchMetafiles(zip);

  // 0. Load default theme color scheme + font scheme (theme1 as fallback)
  const defaultThemeColors = new Map<string, string>();
  const defaultThemeFonts = new Map<string, string>();
  const defaultThemeXml = await zip.file('ppt/theme/theme1.xml')?.async('string');
  if (defaultThemeXml) {
    const themeDoc = parser.parseFromString(defaultThemeXml, 'text/xml');
    _loadThemeColors(themeDoc, defaultThemeColors);
    _loadThemeFonts(themeDoc, defaultThemeFonts);
  }

  // 1. Read presentation.xml for slide size
  const presXml = await zip.file('ppt/presentation.xml')?.async('string');
  let slideWidth = 9144000;  // default 10" × 7.5"
  let slideHeight = 6858000;
  if (presXml) {
    const presDoc = parser.parseFromString(presXml, 'text/xml');
    const sldSz = presDoc.getElementsByTagNameNS(NS_P, 'sldSz')[0];
    if (sldSz) {
      slideWidth = parseInt(sldSz.getAttribute('cx') ?? '9144000', 10);
      slideHeight = parseInt(sldSz.getAttribute('cy') ?? '6858000', 10);
    }
  }
  const widthPx = _emuToPx(slideWidth);
  const heightPx = _emuToPx(slideHeight);

  // 2. Discover slide files (sorted numerically)
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] ?? '0', 10);
      return na - nb;
    });

  // 2b. Cache for slide masters and themes (keyed by master path)
  interface MasterCache {
    phMap: Map<string, PlaceholderTransform>;
    shapes: SlideShape[];
    bg: { bgColor?: string; bgImage?: string };
    themeColors: Map<string, string>;
    themeFonts: Map<string, string>;
  }
  const masterCache = new Map<string, MasterCache>();

  async function _loadMaster(masterPath: string): Promise<MasterCache> {
    const cached = masterCache.get(masterPath);
    if (cached) { return cached; }

    const phMap = new Map<string, PlaceholderTransform>();
    let shapes: SlideShape[] = [];
    let bg: { bgColor?: string; bgImage?: string } = {};
    let tc = new Map(defaultThemeColors);
    let tf = new Map(defaultThemeFonts);

    const masterXml = await zip.file(masterPath)?.async('string');
    if (masterXml) {
      const masterDoc = parser.parseFromString(masterXml, 'text/xml');
      _collectPlaceholderTransforms(masterDoc, phMap);

      // Resolve master → theme via master rels
      const masterRelsPath = masterPath.replace(/\/([^/]+)$/, '/_rels/$1') + '.rels';
      const masterRelsXml = await zip.file(masterRelsPath)?.async('string');
      const masterRelsMap = _parseRelsXml(masterRelsXml, parser);
      const masterDir = masterPath.replace(/\/[^/]+$/, '/');

      // Find theme path from master rels
      for (const [, target] of masterRelsMap) {
        if (target.includes('theme')) {
          const themePath = target.startsWith('../') ? 'ppt/' + target.slice(3) : masterDir + target;
          const themeXml = await zip.file(themePath)?.async('string');
          if (themeXml) {
            tc = new Map<string, string>();
            tf = new Map<string, string>();
            const themeDoc = parser.parseFromString(themeXml, 'text/xml');
            _loadThemeColors(themeDoc, tc);
            _loadThemeFonts(themeDoc, tf);
          }
          break;
        }
      }

      // Overlay master txStyles defaults onto phMap AFTER the master theme is
      // loaded into `tc`, so title/body default colors expressed as schemeClr
      // resolve against the master's real theme (not just theme1 defaults).
      _applyMasterTxStyles(masterDoc, phMap, tc);

      shapes = await _extractShapes(masterDoc, masterRelsMap, zip, parser, new Map(), true, tc, tf, masterDir);
      bg = await _extractBg(masterDoc, masterRelsMap, zip, tc, masterDir);
    }

    const entry: MasterCache = { phMap, shapes, bg, themeColors: tc, themeFonts: tf };
    masterCache.set(masterPath, entry);
    return entry;
  }

  // 2c. Cache for slide layouts (keyed by layout path). Without this, EVERY
  // slide using the same layout re-extracts the layout shapes — and on this
  // codebase's xmldom-backed _extractShapes, that's the dominant per-slide
  // cost on layouts with many shapes (~300ms on a 9-shape layout). For
  // corporate decks where 30+ slides share a single content layout, this
  // cache is the biggest steady-state win available without changing the
  // XML library. It does NOT help slide #2 in the user's test deck (slide
  // #2 is the only user of slideLayout1, so it pays the cold cost itself),
  // but every slide after it benefits.
  interface LayoutCache {
    doc: Document;
    relsMap: Map<string, string>;
    shapes: SlideShape[];
    bg: { bgColor?: string; bgImage?: string };
    suppressMasterShapes: boolean;
  }
  const layoutCache = new Map<string, LayoutCache>();

  // 3. Parse each slide
  const slides: SlideData[] = [];
  // Track the last-used themeFonts for HTML rendering (used for CSS font-family)
  let lastThemeFonts = defaultThemeFonts;

  for (let i = 0; i < slideFiles.length; i++) {
    const slideFile = slideFiles[i];
    const xml = await zip.file(slideFile)?.async('string');
    if (!xml) { continue; }

    // Load relationship file for images + resolve slide layout path
    const relsFile = slideFile.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relsXml = await zip.file(relsFile)?.async('string');
    const relsMap = new Map<string, string>();  // rId → target path
    let layoutPath: string | null = null;
    if (relsXml) {
      const relsDoc = parser.parseFromString(relsXml, 'text/xml');
      const rels = relsDoc.getElementsByTagName('Relationship');
      for (let j = 0; j < rels.length; j++) {
        const id = rels[j].getAttribute('Id');
        const target = rels[j].getAttribute('Target') ?? '';
        const type = rels[j].getAttribute('Type') ?? '';
        if (id && target) { relsMap.set(id, target); }
        if (type.endsWith('/slideLayout') && target) {
          layoutPath = target.startsWith('../')
            ? 'ppt/' + target.slice(3)
            : 'ppt/slides/' + target;
        }
      }
    }

    // Resolve layout → master chain for this slide
    let masterPath = 'ppt/slideMasters/slideMaster1.xml';  // default fallback
    if (layoutPath) {
      const layoutRelsPath = layoutPath.replace(/\/([^/]+)$/, '/_rels/$1') + '.rels';
      const layoutRelsXml = await zip.file(layoutRelsPath)?.async('string');
      if (layoutRelsXml) {
        const lrDoc = parser.parseFromString(layoutRelsXml, 'text/xml');
        const lrels = lrDoc.getElementsByTagName('Relationship');
        for (let j = 0; j < lrels.length; j++) {
          const type = lrels[j].getAttribute('Type') ?? '';
          const target = lrels[j].getAttribute('Target') ?? '';
          if (type.endsWith('/slideMaster') && target) {
            masterPath = target.startsWith('../')
              ? 'ppt/' + target.slice(3)
              : 'ppt/slideLayouts/' + target;
            break;
          }
        }
      }
    }

    const master = await _loadMaster(masterPath);
    const themeColors = master.themeColors;
    const themeFonts = master.themeFonts;
    lastThemeFonts = themeFonts;
    const masterPhMap = master.phMap;
    const masterShapes = master.shapes;
    const masterBg = master.bg;

    // Build per-slide placeholder map + extract non-ph layout shapes
    const phMap = new Map(masterPhMap);
    let layoutShapes: SlideShape[] = [];
    let suppressMasterShapes = false;   // default: show master shapes
    let layoutBg: { bgColor?: string; bgImage?: string } = {};
    if (layoutPath) {
      let layoutEntry = layoutCache.get(layoutPath);
      if (!layoutEntry) {
        // Cold path: parse the layout XML, extract everything, cache it.
        const layoutXml = await zip.file(layoutPath)?.async('string');
        if (layoutXml) {
          const layoutDoc = parser.parseFromString(layoutXml, 'text/xml');
          const sldLayoutEl = layoutDoc.getElementsByTagNameNS(NS_P, 'sldLayout')[0];
          const suppress = sldLayoutEl?.getAttribute('showMasterSp') === '0';
          const layoutRelsPath = layoutPath.replace(/\/([^/]+)$/, '/_rels/$1') + '.rels';
          const layoutRelsXml = await zip.file(layoutRelsPath)?.async('string');
          const layoutRelsMap = _parseRelsXml(layoutRelsXml, parser);
          const lShapes = await _extractShapes(layoutDoc, layoutRelsMap, zip, parser, new Map(), true, themeColors, themeFonts, 'ppt/slideLayouts/');
          const lBg = await _extractBg(layoutDoc, layoutRelsMap, zip, themeColors, 'ppt/slideLayouts/');
          layoutEntry = {
            doc: layoutDoc as unknown as Document,
            relsMap: layoutRelsMap,
            shapes: lShapes,
            bg: lBg,
            suppressMasterShapes: suppress,
          };
          layoutCache.set(layoutPath, layoutEntry);
        }
      }
      if (layoutEntry) {
        // Per-slide phMap merge still runs every time (it mutates the
        // slide-specific phMap from masterPhMap baseline). These calls are
        // cheap relative to _extractShapes so caching just _extractShapes
        // is the big win.
        suppressMasterShapes = layoutEntry.suppressMasterShapes;
        _collectPlaceholderTransforms(layoutEntry.doc as unknown as Parameters<typeof _collectPlaceholderTransforms>[0], phMap);
        _applyLayoutLstStyles(layoutEntry.doc as unknown as Parameters<typeof _applyLayoutLstStyles>[0], phMap, themeColors);
        layoutShapes = layoutEntry.shapes;
        layoutBg = layoutEntry.bg;
      }
    }

    const doc = parser.parseFromString(xml, 'text/xml');
    const shapes = await _extractShapes(doc, relsMap, zip, parser, phMap, false, themeColors, themeFonts);

    // Background inheritance: slide → layout → master
    let bg = await _extractBg(doc, relsMap, zip, themeColors);
    if (!bg.bgColor && !bg.bgImage) { bg = layoutBg; }
    if (!bg.bgColor && !bg.bgImage) { bg = masterBg; }

    const slide: SlideData = { index: i, width: widthPx, height: heightPx, shapes, masterShapes, layoutShapes, suppressMasterShapes, bgColor: bg.bgColor, bgImage: bg.bgImage };
    slides.push(slide);
    onProgress?.(i + 1, slideFiles.length);
    // Yield to the event loop periodically so the (main-thread) parse of a
    // huge deck doesn't freeze the UI — the loading spinner keeps animating
    // and the modal close button stays responsive. Negligible overhead on
    // small decks (one yield per 16 slides).
    if ((i & 15) === 15) { await new Promise((resolve) => setTimeout(resolve, 0)); }
  }

  return { slides, themeFonts: lastThemeFonts };
}

async function _extractShapes(
  doc: Document,
  relsMap: Map<string, string>,
  zip: InstanceType<typeof import('jszip')>,
  _parser: DOMParser,
  phMap: Map<string, PlaceholderTransform>,
  nonPhOnly = false,
  themeColors: Map<string, string> = new Map(),
  themeFonts: Map<string, string> = new Map(),
  basePath = 'ppt/slides/',
): Promise<SlideShape[]> {
  const shapes: SlideShape[] = [];
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0];
  if (!spTree) { return shapes; }
  await _processShapeContainer(spTree, relsMap, zip, phMap, null, nonPhOnly, themeColors, themeFonts, shapes, basePath);
  return shapes;
}

/** Recursively process a shape container (<p:spTree> or <p:grpSp>) */
async function _processShapeContainer(
  container: Element,
  relsMap: Map<string, string>,
  zip: InstanceType<typeof import('jszip')>,
  phMap: Map<string, PlaceholderTransform>,
  groupEmu: GroupTransform | null,
  nonPhOnly: boolean,
  themeColors: Map<string, string>,
  themeFonts: Map<string, string>,
  shapes: SlideShape[],
  basePath = 'ppt/slides/',
): Promise<void> {
  for (let i = 0; i < container.childNodes.length; i++) {
    const node = container.childNodes[i];
    if (node.nodeType !== 1) { continue; }
    const el = node as Element;
    const localName = el.localName;

    try {
      if (localName === 'sp') {
        if (nonPhOnly && _isPlaceholder(el)) { continue; }
        const shape = await _extractTextShape(el, phMap, relsMap, zip, groupEmu, themeColors, themeFonts, basePath);
        if (shape) { shapes.push(shape); }
      } else if (localName === 'pic') {
        if (nonPhOnly && _isPlaceholder(el)) { continue; }
        const shape = await _extractImageShape(el, relsMap, zip, groupEmu, basePath);
        if (shape) { shapes.push(shape); }
      } else if (localName === 'graphicFrame') {
        if (nonPhOnly && _isPlaceholder(el)) { continue; }
        const shape = _extractTableShape(el, groupEmu, themeColors, themeFonts);
        if (shape) { shapes.push(shape); }
        else {
          // 原生图表 → ChartShape（SVG 渲染）；否则 SmartArt / OLE 走图片兜底（找内嵌预览图）。
          const chart = await _extractChartShape(el, relsMap, zip, groupEmu, basePath, themeColors);
          if (chart) { shapes.push(chart); }
          else {
            const fallback = await _extractGraphicFrameFallback(el, relsMap, zip, groupEmu, basePath);
            if (fallback) { shapes.push(fallback); }
          }
        }
      } else if (localName === 'cxnSp') {
        const shape = _extractConnectorShape(el, groupEmu, themeColors);
        if (shape) { shapes.push(shape); }
      } else if (localName === 'grpSp') {
        // Expand group shape recursively with coordinate transform
        const grpSpPr = _firstChildNS(el, NS_P, 'grpSpPr');
        const childGroup = grpSpPr ? _getGroupTransformInfo(grpSpPr, groupEmu) : groupEmu;
        await _processShapeContainer(el, relsMap, zip, phMap, childGroup, nonPhOnly, themeColors, themeFonts, shapes, basePath);
      }
    } catch {
      continue;  // skip broken shapes
    }
  }
}

function _getTransform(el: Element): { left: number; top: number; width: number; height: number; rotation?: number } | null {
  // sp/pic use a:xfrm (inside spPr); graphicFrame uses p:xfrm (direct child)
  const xfrm = el.getElementsByTagNameNS(NS_A, 'xfrm')[0]
            ?? el.getElementsByTagNameNS(NS_P, 'xfrm')[0];
  if (!xfrm) { return null; }
  const off = xfrm.getElementsByTagNameNS(NS_A, 'off')[0];
  const ext = xfrm.getElementsByTagNameNS(NS_A, 'ext')[0];
  if (!off || !ext) { return null; }
  const rotAttr = xfrm.getAttribute('rot');
  const rotation = rotAttr ? parseInt(rotAttr, 10) / 60000 : undefined;  // 60000ths of degree → degrees
  return {
    left: _emuToPx(parseInt(off.getAttribute('x') ?? '0', 10)),
    top: _emuToPx(parseInt(off.getAttribute('y') ?? '0', 10)),
    width: _emuToPx(parseInt(ext.getAttribute('cx') ?? '0', 10)),
    height: _emuToPx(parseInt(ext.getAttribute('cy') ?? '0', 10)),
    ...(rotation ? { rotation } : {}),
  };
}

async function _extractTextShape(
  sp: Element,
  phMap: Map<string, PlaceholderTransform>,
  relsMap: Map<string, string>,
  zip: InstanceType<typeof import('jszip')>,
  groupEmu: GroupTransform | null = null,
  themeColors: Map<string, string> = new Map(),
  themeFonts: Map<string, string> = new Map(),
  basePath = 'ppt/slides/',
): Promise<TextShape | null> {
  // txBody is optional for filled shapes; spPr is what determines the shape boundary
  const txBody = sp.getElementsByTagNameNS(NS_P, 'txBody')[0];

  // Extract fill and geometry from shape properties
  const spPr = _firstChildNS(sp, NS_P, 'spPr');
  let fill: string | null = null;
  let isRoundRect = false;
  let roundRectAdj = 0.16667;  // roundRect 圆角占短边比例；默认 16.667%（OOXML 缺省 adj）
  let shapeGeom: string | undefined;
  let customSvgPath: string | undefined;
  let bgImage: string | undefined;
  let explicitNoFill = false;
  if (spPr) {
    const prstGeom = _firstChildNS(spPr, NS_A, 'prstGeom');
    const custGeomEl = _firstChildNS(spPr, NS_A, 'custGeom');
    const prst = prstGeom?.getAttribute('prst') ?? (custGeomEl ? '__custom__' : 'rect');
    fill = _extractFill(spPr, themeColors);
    explicitNoFill = !!_firstChildNS(spPr, NS_A, 'noFill');
    if (prst === 'roundRect') {
      isRoundRect = true;
      // 读实际 adj（1/100000 单位 → 0-1 比例），不再写死默认值。
      const avLst = prstGeom ? _firstChildNS(prstGeom, NS_A, 'avLst') : null;
      const gd0 = avLst?.getElementsByTagNameNS(NS_A, 'gd')[0];
      const m = (gd0?.getAttribute('fmla') ?? '').match(/val\s+(\d+)/);
      if (m) { roundRectAdj = Math.min(0.5, parseInt(m[1], 10) / 100000); }
    }
    // Store non-rect geometry for SVG rendering
    if (prst !== 'rect' && prst !== 'roundRect' && prst !== '__custom__') { shapeGeom = prst; }
    // Parametric preset shapes — parse adjustment values and generate custom SVG path
    if (prstGeom && _parametricPresetBuilders[prst]) {
      const avLst = _firstChildNS(prstGeom, NS_A, 'avLst');
      const adjs = new Map<string, number>();
      if (avLst) {
        const gds = avLst.getElementsByTagNameNS(NS_A, 'gd');
        for (let gi = 0; gi < gds.length; gi++) {
          const name = gds[gi].getAttribute('name') ?? '';
          const fmla = gds[gi].getAttribute('fmla') ?? '';
          const valMatch = fmla.match(/val\s+(\d+)/);
          if (name && valMatch) { adjs.set(name, parseInt(valMatch[1], 10) / 1000); }
        }
      }
      customSvgPath = _parametricPresetBuilders[prst](adjs);
    }
    // 带起止角的部分圆/扇形:arc/pie/chord/blockArc（adj 是 1/60000 度）。ported 的 blockArc 是整环
    // 近似,这里用真实起止角覆盖。
    if (prstGeom && !customSvgPath && (prst === 'arc' || prst === 'pie' || prst === 'chord' || prst === 'blockArc')) {
      customSvgPath = _arcLikePath(prst, prstGeom) ?? undefined;
    }
    // Custom geometry path (freeform curves etc.)
    if (custGeomEl) {
      const cp = _extractCustomGeomPath(custGeomEl);
      if (cp) { customSvgPath = cp; }
    }
    // blipFill: image fill on shape (common in master decorative shapes)
    const blipFillEl = _firstChildNS(spPr, NS_A, 'blipFill');
    if (blipFillEl) {
      const blip = blipFillEl.getElementsByTagNameNS(NS_A, 'blip')[0];
      if (blip) {
        const rEmbed = blip.getAttributeNS(NS_R, 'embed') ?? blip.getAttribute('r:embed');
        if (rEmbed) {
          const target = relsMap.get(rEmbed);
          if (target) {
            const imgPath = target.startsWith('../') ? 'ppt/' + target.slice(3) : basePath + target;
            const imgFile = zip.file(imgPath);
            if (imgFile) {
              const blob = await imgFile.async('base64');
              const ext = ('.' + (imgPath.split('.').pop() ?? '')).toLowerCase();
              const uri = _imageDataUri(imgPath, ext, blob);
              if (uri) { bgImage = uri; }
            }
          }
        }
      }
    }
  }

  // Extract text body insets, autoFit, anchor, and vertical text from <a:bodyPr>
  // OOXML defaults: lIns=rIns=91440 EMU (0.1"), tIns=bIns=45720 EMU (0.05")
  let insets: [number, number, number, number] | undefined;
  let autoFit: 'sp' | 'norm' | undefined;
  let anchor: string | undefined;
  let verticalText: string | undefined;
  if (txBody) {
    const bodyPr = txBody.getElementsByTagNameNS(NS_A, 'bodyPr')[0];
    if (bodyPr) {
      const lI = bodyPr.getAttribute('lIns');
      const tI = bodyPr.getAttribute('tIns');
      const rI = bodyPr.getAttribute('rIns');
      const bI = bodyPr.getAttribute('bIns');
      // Only set insets if at least one is explicitly specified
      if (lI || tI || rI || bI) {
        insets = [
          _emuToPx(parseInt(tI ?? '45720', 10)),
          _emuToPx(parseInt(rI ?? '91440', 10)),
          _emuToPx(parseInt(bI ?? '45720', 10)),
          _emuToPx(parseInt(lI ?? '91440', 10)),
        ];
      }
      // Vertical alignment (anchor)
      const anchorAttr = bodyPr.getAttribute('anchor');
      if (anchorAttr === 'ctr' || anchorAttr === 'b') { anchor = anchorAttr; }
      // Vertical text mode
      const vertAttr = bodyPr.getAttribute('vert');
      if (vertAttr && vertAttr !== 'horz') { verticalText = vertAttr; }
      // <a:spAutoFit/> — shape grows to fit text
      if (_firstChildNS(bodyPr, NS_A, 'spAutoFit')) {
        autoFit = 'sp';
      } else if (_firstChildNS(bodyPr, NS_A, 'normAutofit')) {
        autoFit = 'norm';
      } else if (!_firstChildNS(bodyPr, NS_A, 'noAutofit')) {
        // No explicit autofit setting — default to normAutofit for placeholder shapes
        // (PowerPoint shrinks text to fit for placeholders by default)
        const ph = sp.getElementsByTagNameNS(NS_P, 'ph')[0];
        if (ph) { autoFit = 'norm'; }
      }
    }
  }

  // Explicit transform preferred; fall back to master/layout placeholder position
  let transform: { left: number; top: number; width: number; height: number; rotation?: number } | null;
  if (groupEmu) {
    const rawEmu = _getTransformEmu(sp);
    if (rawEmu) {
      const t = _applyGroupTransform(rawEmu, groupEmu);
      transform = { left: _emuToPx(t.x), top: _emuToPx(t.y), width: _emuToPx(t.cx), height: _emuToPx(t.cy), ...(rawEmu.rotation ? { rotation: rawEmu.rotation } : {}) };
    } else {
      transform = null;
    }
  } else {
    transform = _getTransform(sp);
    if (!transform) {
      const key = _getPhKey(sp);
      transform = key ? (phMap.get(key) ?? null) : null;
    }
  }
  if (!transform) { return null; }

  // Look up the placeholder's default text style (may be undefined for non-ph shapes)
  const phKey = _getPhKey(sp);
  const phInfo = phKey ? phMap.get(phKey) : undefined;

  // Determine default font for this shape based on placeholder type
  // Title placeholders → major theme font; body/other → minor (inherited from .slide CSS)
  const isTitle = phKey === 'type:title' || phKey === 'type:ctrTitle';
  let shapeFontDefault: string | null = null;
  if (isTitle) {
    const mjParts: string[] = [];
    const mjLt = themeFonts.get('+mj-lt');
    const mjEa = themeFonts.get('+mj-ea');
    if (mjLt) { mjParts.push(`"${mjLt}"`); }
    if (mjEa && mjEa !== mjLt) { mjParts.push(`"${mjEa}"`); }
    if (mjParts.length) { shapeFontDefault = mjParts.join(','); }
  }

  const paragraphs: TextParagraph[] = [];
  const pEls = txBody ? txBody.getElementsByTagNameNS(NS_A, 'p') : { length: 0 } as HTMLCollectionOf<Element>;

  for (let i = 0; i < pEls.length; i++) {
    const p = pEls[i];
    if (!txBody || p.parentNode !== txBody) { continue; }

    // Default align/bullet from placeholder info; explicit pPr overrides below
    let align = phInfo?.defAlign ?? 'left';
    let bullet: string | null = phInfo?.defBullet ?? null;

    // Paragraph-level default run properties (from <a:pPr><a:defRPr>).
    // defColor seeds from the placeholder's inherited text color (master
    // txStyles / layout lstStyle defRPr solidFill) so e.g. a title placeholder
    // whose run has no explicit color still gets its themed color (the slide-11
    // 目录 title is white from the master title style, not the default dark).
    let defFont: string | null = null;
    let defColor: string | null = phInfo?.defColor ?? null;
    let defBold = false;
    let defItalic = false;
    let defFontSz: number | null = null;
    let defUnderline = false;

    // Paragraph spacing
    let lineHeight: number | undefined;  // CSS line-height multiplier
    let lineHeightPt: number | undefined; // absolute line-height in pt (from spcPts)
    let spaceBefore: number | undefined;
    let spaceAfter: number | undefined;
    let indentLevel: number | undefined;
    let marginLeftPt: number | undefined;
    let indentPt: number | undefined;
    let bulletColor: string | undefined;
    let bulletSizePct: number | undefined;

    // Paragraph-level overrides
    const pPr = _firstChildNS(p, NS_A, 'pPr');
    if (pPr) {
      const algn = pPr.getAttribute('algn');
      if (algn === 'ctr') { align = 'center'; }
      else if (algn === 'r') { align = 'right'; }
      else if (algn === 'just') { align = 'justify'; }
      else if (algn === 'l') { align = 'left'; }

      // Indentation level and margins
      const lvlAttr = pPr.getAttribute('lvl');
      if (lvlAttr) { indentLevel = parseInt(lvlAttr, 10); }
      const marLAttr = pPr.getAttribute('marL');
      if (marLAttr) { marginLeftPt = _emuToPx(parseInt(marLAttr, 10)); }
      const indentAttr = pPr.getAttribute('indent');
      if (indentAttr) { indentPt = _emuToPx(parseInt(indentAttr, 10)); }

      if (pPr.getElementsByTagNameNS(NS_A, 'buNone')[0]) { bullet = null; }
      const pBuFont = pPr.getElementsByTagNameNS(NS_A, 'buFont')[0];
      const pBuFontName = pBuFont?.getAttribute('typeface') ?? null;
      const buChar = pPr.getElementsByTagNameNS(NS_A, 'buChar')[0];
      if (buChar) {
        const raw = buChar.getAttribute('char') ?? '';
        bullet = _resolveBulletChar(raw, pBuFontName);
      }
      // Numbered list: <a:buAutoNum type="arabicPeriod"/>
      const buAutoNum = pPr.getElementsByTagNameNS(NS_A, 'buAutoNum')[0];
      if (buAutoNum && !bullet) {
        // Use a placeholder; actual numbering computed after all paragraphs are collected
        const numType = buAutoNum.getAttribute('type') ?? 'arabicPeriod';
        const startAt = parseInt(buAutoNum.getAttribute('startAt') ?? '1', 10);
        bullet = `__autonum__${numType}__${startAt}`;
      }

      // Bullet color: <a:buClr><a:srgbClr val="FF0000"/>
      const buClr = _firstChildNS(pPr, NS_A, 'buClr');
      if (buClr) {
        bulletColor = _resolveSolidFillColor(buClr, themeColors) ?? undefined;
      }
      // Bullet size: <a:buSzPct val="100000"/> → 100%
      const buSzPct = _firstChildNS(pPr, NS_A, 'buSzPct');
      if (buSzPct) {
        bulletSizePct = parseInt(buSzPct.getAttribute('val') ?? '100000', 10) / 1000;
      }
      const buSzPts = _firstChildNS(pPr, NS_A, 'buSzPts');
      if (buSzPts && !bulletSizePct) {
        // Convert to approximate percentage of default font size
        const pts = parseInt(buSzPts.getAttribute('val') ?? '0', 10) / 100;
        const baseSz = defFontSz ?? 14;
        bulletSizePct = (pts / baseSz) * 100;
      }

      // Line spacing: <a:lnSpc><a:spcPct val="150000"/> → CSS line-height 1.5
      // Direct pass-through: OOXML percentage maps to CSS line-height multiplier.
      const lnSpc = _firstChildNS(pPr, NS_A, 'lnSpc');
      if (lnSpc) {
        const spcPctEl = lnSpc.getElementsByTagNameNS(NS_A, 'spcPct')[0];
        if (spcPctEl) {
          const val = parseInt(spcPctEl.getAttribute('val') ?? '100000', 10);
          lineHeight = val / 100000;
        } else {
          const spcPtsEl = lnSpc.getElementsByTagNameNS(NS_A, 'spcPts')[0];
          if (spcPtsEl) {
            // spcPts val is in hundredths of a point → convert to pt, store as negative to signal absolute
            lineHeightPt = parseInt(spcPtsEl.getAttribute('val') ?? '0', 10) / 100;
          }
        }
      }

      // Space before paragraph: <a:spcBef><a:spcPts val="400"/> → 4pt, or <a:spcPct val="20000"/> → 20%
      const spcBef = _firstChildNS(pPr, NS_A, 'spcBef');
      if (spcBef) {
        const pts = spcBef.getElementsByTagNameNS(NS_A, 'spcPts')[0];
        if (pts) {
          spaceBefore = parseInt(pts.getAttribute('val') ?? '0', 10) / 100;
        } else {
          const pct = spcBef.getElementsByTagNameNS(NS_A, 'spcPct')[0];
          if (pct) {
            // spcPct val is in 1/1000th of a percent (20000 = 20%), relative to font size
            // Approximate as fraction of a typical font size (use 0 if negligible)
            const pctVal = parseInt(pct.getAttribute('val') ?? '0', 10) / 100000;
            spaceBefore = pctVal * 12; // approximate: fraction × ~12pt base font
          }
        }
      }

      // Space after paragraph: <a:spcAft><a:spcPts val="400"/> → 4pt, or <a:spcPct val="20000"/> → 20%
      const spcAft = _firstChildNS(pPr, NS_A, 'spcAft');
      if (spcAft) {
        const pts = spcAft.getElementsByTagNameNS(NS_A, 'spcPts')[0];
        if (pts) {
          spaceAfter = parseInt(pts.getAttribute('val') ?? '0', 10) / 100;
        } else {
          const pct = spcAft.getElementsByTagNameNS(NS_A, 'spcPct')[0];
          if (pct) {
            const pctVal = parseInt(pct.getAttribute('val') ?? '0', 10) / 100000;
            spaceAfter = pctVal * 12;
          }
        }
      }

      // Extract default run properties
      const defRPr = _firstChildNS(pPr, NS_A, 'defRPr');
      if (defRPr) {
        defFont = _resolveFont(defRPr, themeFonts);
        // Only override the inherited placeholder color when this defRPr
        // actually specifies one — otherwise keep phInfo.defColor.
        const dc = _resolveRunColor(defRPr, themeColors);
        if (dc) { defColor = dc; }
        defBold = defRPr.getAttribute('b') === '1';
        defItalic = defRPr.getAttribute('i') === '1';
        const dSz = defRPr.getAttribute('sz');
        if (dSz) { defFontSz = Math.round(parseInt(dSz, 10) / 100); }
        const dU = defRPr.getAttribute('u') ?? '';
        defUnderline = !!(dU && dU !== 'none');
      }
    }

    // Extract per-run formatting
    const runs: TextRun[] = [];
    const runEls = p.getElementsByTagNameNS(NS_A, 'r');
    for (let j = 0; j < runEls.length; j++) {
      if (runEls[j].parentNode !== p) { continue; }
      const tEl = runEls[j].getElementsByTagNameNS(NS_A, 't')[0];
      const text = tEl?.textContent ?? '';
      if (!text) { continue; }
      const rPr = runEls[j].getElementsByTagNameNS(NS_A, 'rPr')[0];
      const sz = rPr?.getAttribute('sz');
      const uVal = rPr?.getAttribute('u') ?? '';
      const strikeVal = rPr?.getAttribute('strike') ?? '';
      const spcAttr = rPr?.getAttribute('spc');
      // Hyperlink
      const hlinkEl = rPr?.getElementsByTagNameNS(NS_A, 'hlinkClick')[0];
      const hlinkRid = hlinkEl?.getAttributeNS(NS_R, 'id') ?? hlinkEl?.getAttribute('r:id') ?? null;
      const href = hlinkRid ? (relsMap.get(hlinkRid) ?? null) : null;
      // Baseline (superscript/subscript)
      const baselineAttr = rPr?.getAttribute('baseline');
      const baseline = baselineAttr ? parseInt(baselineAttr, 10) : null;
      // Highlight color
      const highlightEl = rPr?.getElementsByTagNameNS(NS_A, 'highlight')[0];
      const highlight = highlightEl ? _resolveSolidFillColor(highlightEl, themeColors) : null;
      runs.push({
        text,
        bold: rPr?.getAttribute('b') === '1' || ((!rPr || !rPr.hasAttribute('b')) && defBold),
        italic: rPr?.getAttribute('i') === '1' || ((!rPr || !rPr.hasAttribute('i')) && defItalic),
        underline: rPr ? !!(uVal && uVal !== 'none') || (!rPr.hasAttribute('u') && defUnderline) : defUnderline,
        strikethrough: !!(strikeVal && strikeVal !== 'noStrike'),
        fontSize: sz ? Math.round(parseInt(sz, 10) / 100) : null,
        fontFamily: (rPr ? _resolveFont(rPr, themeFonts) : null),
        color: (rPr ? _resolveRunColor(rPr, themeColors) : null),
        spacing: spcAttr ? Math.round(parseInt(spcAttr, 10)) / 100 : null,
        href,
        baseline,
        highlight,
        glow: rPr ? _resolveGlow(rPr, themeColors) : null,
      });
    }

    // Field text (e.g., slide numbers) → plain run
    const flds = p.getElementsByTagNameNS(NS_A, 'fld');
    for (let j = 0; j < flds.length; j++) {
      if (flds[j].parentNode !== p) { continue; }
      const tEl = flds[j].getElementsByTagNameNS(NS_A, 't')[0];
      const text = tEl?.textContent ?? '';
      if (text) {
        const rPr = flds[j].getElementsByTagNameNS(NS_A, 'rPr')[0];
        const sz = rPr?.getAttribute('sz');
        runs.push({
          text,
          bold: rPr?.getAttribute('b') === '1',
          italic: rPr?.getAttribute('i') === '1',
          underline: false, strikethrough: false,
          fontSize: sz ? Math.round(parseInt(sz, 10) / 100) : null,
          fontFamily: rPr ? _resolveFont(rPr, themeFonts) : null,
          color: rPr ? _resolveRunColor(rPr, themeColors) : null,
          spacing: null,
          href: null,
          baseline: null,
          highlight: null,
          glow: rPr ? _resolveGlow(rPr, themeColors) : null,
        });
      }
    }

    // 数学公式(OMML) → 线性文本兜底:抽 <m:t> 字符拼成一个 run,至少把公式显示出来(不做真正的
    // 数学排版:上下标/根号/分式等结构会退化成线性文字)。math 文本嵌在 m:oMath > m:r > m:t 里,
    // 不是 a:r,故上面的 run 循环会漏掉。
    const mtEls = p.getElementsByTagNameNS(NS_M, 't');
    if (mtEls.length) {
      let mtext = '';
      for (let j = 0; j < mtEls.length; j++) { mtext += mtEls[j].textContent ?? ''; }
      if (mtext.trim()) {
        runs.push({
          text: mtext, bold: false, italic: true, underline: false, strikethrough: false,
          fontSize: null, fontFamily: null, color: null, spacing: null, href: null,
          baseline: null, highlight: null, glow: null,
        });
      }
    }

    // Apply defRPr fallbacks for runs without explicit values
    for (const r of runs) {
      if (!r.fontFamily && defFont) { r.fontFamily = defFont; }
      if (!r.fontFamily && shapeFontDefault) { r.fontFamily = shapeFontDefault; }
      if (!r.color && defColor) { r.color = defColor; }
      if (!r.fontSize && defFontSz) { r.fontSize = defFontSz; }
    }

    // Fall back to placeholder default font size when no run has explicit sz
    if (phInfo?.defFontSz && !runs.some(r => r.fontSize)) {
      for (const r of runs) { r.fontSize = phInfo.defFontSz; }
    }

    // Always push the paragraph — even empty ones take up one line of vertical
    // space in PowerPoint (blank lines between text blocks, etc.).
    paragraphs.push({
      runs, align, bullet,
      ...(indentLevel !== undefined ? { indentLevel } : {}),
      ...(marginLeftPt !== undefined ? { marginLeftPt } : {}),
      ...(indentPt !== undefined ? { indentPt } : {}),
      ...(lineHeight !== undefined ? { lineHeight } : {}),
      ...(lineHeightPt !== undefined ? { lineHeightPt } : {}),
      ...(spaceBefore !== undefined ? { spaceBefore } : {}),
      ...(spaceAfter !== undefined ? { spaceAfter } : {}),
      ...(bulletColor ? { bulletColor } : {}),
      ...(bulletSizePct !== undefined ? { bulletSizePct } : {}),
    });
  }

  // Keep filled shapes even with no text (colored bars, background rectangles, etc.)
  if (!paragraphs.length && !fill && !bgImage && !customSvgPath) { return null; }

  // roundRect: 半径 = 短边 * adj（绝对 px，slide 参考尺寸）。渲染时转成 pt 用 var(--pt) 表达
  // （与边框/字号同一套缩放），得到统一的圆角（单值 → 圆形四角，不像 border-radius:% 在非正方形
  // 盒子上拉成椭圆），且读实际 adj。保持 CSS 盒子 → 渐变/图片填充与文字不受影响（修 SVG 填充回归）。
  let borderRadius: number | undefined;
  if (isRoundRect && transform) {
    borderRadius = Math.min(transform.width, transform.height) * roundRectAdj;
  }

  // Extract shape outline border from <a:ln>
  let border: { color: string; widthPx: number } | undefined;
  let explicitLn = false;  // spPr 里有显式 <a:ln>(哪怕 noFill)→ 覆盖 style 的 lnRef，不再兜底加边框
  if (spPr) {
    const ln = _firstChildNS(spPr, NS_A, 'ln');
    if (ln) { explicitLn = true; }
    if (ln && !_firstChildNS(ln, NS_A, 'noFill')) {
      let lineColor: string | null = null;
      const solidFill = _firstChildNS(ln, NS_A, 'solidFill');
      if (solidFill) {
        lineColor = _resolveSolidFillColor(solidFill, themeColors);
      }
      // Fallback: <a:ln w="..."> without explicit fill → use tx1 theme color
      if (!lineColor && ln.getAttribute('w')) {
        const tx1 = themeColors.get('tx1');
        lineColor = tx1 ? `#${tx1}` : '#000000';
      }
      if (lineColor) {
        const wAttr = ln.getAttribute('w');
        const widthPx = wAttr ? Math.max(1, _emuToPx(parseInt(wAttr, 10))) : 1;
        border = { color: lineColor, widthPx };
      }
    }
  }

  // Check <p:style> for fill/border references when not already resolved
  const styleEl = _firstChildNS(sp, NS_P, 'style');
  if (styleEl) {
    if (!fill && !bgImage && !explicitNoFill) {
      const fillRef = _firstChildNS(styleEl, NS_A, 'fillRef');
      if (fillRef && parseInt(fillRef.getAttribute('idx') ?? '0', 10) > 0) {
        fill = _resolveSolidFillColor(fillRef, themeColors);
      }
    }
    if (!border && !explicitLn) {
      const lnRef = _firstChildNS(styleEl, NS_A, 'lnRef');
      if (lnRef && parseInt(lnRef.getAttribute('idx') ?? '0', 10) > 0) {
        const refColor = _resolveSolidFillColor(lnRef, themeColors);
        if (refColor) {
          border = { color: refColor, widthPx: 1 };
        }
      }
    }
  }

  // Extract shadow from <a:effectLst><a:outerShdw>
  const shadow = _extractShadow(spPr, themeColors) ?? undefined;

  return { type: 'text', ...transform, paragraphs, ...(isTitle ? { isTitle } : {}), ...(fill ? { fill } : {}), ...(border ? { border } : {}), ...(shadow ? { shadow } : {}), ...(shapeGeom ? { shapeGeom } : {}), ...(customSvgPath ? { customSvgPath } : {}), ...(bgImage ? { bgImage } : {}), ...(borderRadius ? { borderRadius } : {}), ...(insets ? { insets } : {}), ...(anchor ? { anchor } : {}), ...(verticalText ? { verticalText } : {}), ...(autoFit ? { autoFit } : {}) };
}

async function _extractImageShape(
  pic: Element,
  relsMap: Map<string, string>,
  zip: InstanceType<typeof import('jszip')>,
  groupEmu: GroupTransform | null = null,
  basePath = 'ppt/slides/',
): Promise<ImageShape | null> {
  let transform: { left: number; top: number; width: number; height: number; rotation?: number } | null;
  if (groupEmu) {
    const rawEmu = _getTransformEmu(pic);
    if (rawEmu) {
      const t = _applyGroupTransform(rawEmu, groupEmu);
      transform = { left: _emuToPx(t.x), top: _emuToPx(t.y), width: _emuToPx(t.cx), height: _emuToPx(t.cy), ...(rawEmu.rotation ? { rotation: rawEmu.rotation } : {}) };
    } else {
      transform = null;
    }
  } else {
    transform = _getTransform(pic);
  }
  if (!transform) { return null; }

  // Find r:embed reference
  const blipFill = pic.getElementsByTagNameNS(NS_P, 'blipFill')[0];
  const blip = (blipFill ?? pic).getElementsByTagNameNS(NS_A, 'blip')[0];
  if (!blip) { return null; }

  const rEmbed = blip.getAttributeNS(NS_R, 'embed') ?? blip.getAttribute('r:embed');
  if (!rEmbed) { return null; }

  const target = relsMap.get(rEmbed);
  if (!target) { return null; }

  // Resolve target path relative to the containing XML file's directory
  const imgPath = target.startsWith('../')
    ? 'ppt/' + target.slice(3)
    : basePath + target;

  const imgFile = zip.file(imgPath);
  if (!imgFile) { return null; }

  const blob = await imgFile.async('base64');
  const ext = ('.' + (imgPath.split('.').pop() ?? '')).toLowerCase();
  const dataUri = _imageDataUri(imgPath, ext, blob);
  // Unconverted metafile (no host converter) → no usable image; skip the shape
  // so the caller can render nothing rather than a broken <img>.
  if (!dataUri) { return null; }

  // Extract image crop from <a:srcRect>
  let crop: { l: number; t: number; r: number; b: number } | undefined;
  if (blipFill) {
    const srcRect = blipFill.getElementsByTagNameNS(NS_A, 'srcRect')[0];
    if (srcRect) {
      const l = parseInt(srcRect.getAttribute('l') ?? '0', 10) / 1000;  // 1000ths of % → %
      const t = parseInt(srcRect.getAttribute('t') ?? '0', 10) / 1000;
      const r = parseInt(srcRect.getAttribute('r') ?? '0', 10) / 1000;
      const b = parseInt(srcRect.getAttribute('b') ?? '0', 10) / 1000;
      if (l || t || r || b) { crop = { l, t, r, b }; }
    }
  }

  return { type: 'image', ...transform, dataUri, ...(crop ? { crop } : {}) };
}

function _extractTableShape(
  graphicFrame: Element,
  groupEmu: GroupTransform | null = null,
  themeColors: Map<string, string> = new Map(),
  themeFonts: Map<string, string> = new Map(),
): TableShape | null {
  let transform: { left: number; top: number; width: number; height: number } | null;
  if (groupEmu) {
    const rawEmu = _getTransformEmu(graphicFrame);
    if (rawEmu) {
      const t = _applyGroupTransform(rawEmu, groupEmu);
      transform = { left: _emuToPx(t.x), top: _emuToPx(t.y), width: _emuToPx(t.cx), height: _emuToPx(t.cy) };
    } else {
      transform = null;
    }
  } else {
    transform = _getTransform(graphicFrame);
  }
  if (!transform) { return null; }

  const tbl = graphicFrame.getElementsByTagNameNS(NS_A, 'tbl')[0];
  if (!tbl) { return null; }

  // Extract table properties (banding, header row flags)
  const tblPr = _firstChildNS(tbl, NS_A, 'tblPr');
  const bandRow = tblPr?.getAttribute('bandRow') === '1';
  const bandCol = tblPr?.getAttribute('bandCol') === '1';
  const firstRow = tblPr?.getAttribute('firstRow') === '1';
  const lastRow = tblPr?.getAttribute('lastRow') === '1';

  // Extract column widths from <a:tblGrid>/<a:gridCol w="...">
  const colWidthsEmu: number[] = [];
  const tblGrid = tbl.getElementsByTagNameNS(NS_A, 'tblGrid')[0];
  if (tblGrid) {
    const gridCols = tblGrid.getElementsByTagNameNS(NS_A, 'gridCol');
    for (let i = 0; i < gridCols.length; i++) {
      if (gridCols[i].parentNode !== tblGrid) { continue; }
      colWidthsEmu.push(parseInt(gridCols[i].getAttribute('w') ?? '0', 10));
    }
  }
  const totalColW = colWidthsEmu.reduce((s, w) => s + w, 0) || 1;
  const colWidths = colWidthsEmu.map(w => (w / totalColW) * 100);

  // Extract row heights from <a:tr h="...">
  const rowHeightsEmu: number[] = [];
  const rows: TableCell[][] = [];
  const trEls = tbl.getElementsByTagNameNS(NS_A, 'tr');
  for (let r = 0; r < trEls.length; r++) {
    if (trEls[r].parentNode !== tbl) { continue; }
    rowHeightsEmu.push(parseInt(trEls[r].getAttribute('h') ?? '0', 10));

    const cells: TableCell[] = [];
    const tcEls = trEls[r].getElementsByTagNameNS(NS_A, 'tc');
    for (let c = 0; c < tcEls.length; c++) {
      if (tcEls[c].parentNode !== trEls[r]) { continue; }
      const tc = tcEls[c];

      // Check merge attributes
      const hMerge = tc.getAttribute('hMerge') === '1';
      const vMerge = tc.getAttribute('vMerge') === '1';
      const gridSpan = parseInt(tc.getAttribute('gridSpan') ?? '1', 10);
      const rowSpan = parseInt(tc.getAttribute('rowSpan') ?? '1', 10);

      // Extract cell background color and vertical alignment from <a:tcPr>
      let bgColor: string | undefined;
      let vAlign: string | undefined;
      const tcPr = _firstChildNS(tc, NS_A, 'tcPr');
      if (tcPr) {
        // Try solidFill first, then gradFill
        const cellFill = _firstChildNS(tcPr, NS_A, 'solidFill');
        if (cellFill) {
          const resolved = _resolveSolidFillColor(cellFill, themeColors);
          if (resolved) { bgColor = resolved; }
        }
        if (!bgColor) {
          const gradFill = _firstChildNS(tcPr, NS_A, 'gradFill');
          if (gradFill) {
            const grad = _resolveGradFill(gradFill, themeColors);
            if (grad) { bgColor = grad; }
          }
        }
        const anchorAttr = tcPr.getAttribute('anchor');
        if (anchorAttr === 'ctr') { vAlign = 'middle'; }
        else if (anchorAttr === 'b') { vAlign = 'bottom'; }
        // Extract cell borders from <a:tcBorders>
        // This is processed below after cellBorders is declared
      }

      // Extract cell text alignment from first paragraph's <a:pPr algn>
      let cellAlign: string | undefined;
      const txBody = tc.getElementsByTagNameNS(NS_A, 'txBody')[0];
      if (txBody) {
        const firstP = txBody.getElementsByTagNameNS(NS_A, 'p')[0];
        if (firstP) {
          const pPr = _firstChildNS(firstP, NS_A, 'pPr');
          const algn = pPr?.getAttribute('algn');
          if (algn === 'ctr') { cellAlign = 'center'; }
          else if (algn === 'r') { cellAlign = 'right'; }
          else if (algn === 'just') { cellAlign = 'justify'; }
        }
      }

      // Extract formatted text runs from <a:r> elements
      const cellRuns: TableCellRun[] = [];
      let text = '';
      if (txBody) {
        const pEls = txBody.getElementsByTagNameNS(NS_A, 'p');
        for (let pi = 0; pi < pEls.length; pi++) {
          if (pEls[pi].parentNode !== txBody) { continue; }
          if (pi > 0) {
            text += '\n';
            cellRuns.push({ text: '\n' });
          }
          // Extract paragraph-level default run properties for fallback
          const pPrCell = _firstChildNS(pEls[pi], NS_A, 'pPr');
          const defRPrCell = pPrCell ? _firstChildNS(pPrCell, NS_A, 'defRPr') : null;
          let defColorCell: string | null = null;
          let defBoldCell = false;
          let defSzCell: number | null = null;
          if (defRPrCell) {
            defColorCell = _resolveRunColor(defRPrCell, themeColors);
            defBoldCell = defRPrCell.getAttribute('b') === '1';
            const dsz = defRPrCell.getAttribute('sz');
            if (dsz) { defSzCell = Math.round(parseInt(dsz, 10) / 100); }
          }
          const runEls = pEls[pi].getElementsByTagNameNS(NS_A, 'r');
          for (let ri = 0; ri < runEls.length; ri++) {
            if (runEls[ri].parentNode !== pEls[pi]) { continue; }
            const tEl = runEls[ri].getElementsByTagNameNS(NS_A, 't')[0];
            const runText = tEl?.textContent ?? '';
            if (!runText) { continue; }
            text += runText;
            const rPr = runEls[ri].getElementsByTagNameNS(NS_A, 'rPr')[0];
            const run: TableCellRun = { text: runText };
            if (rPr) {
              if (rPr.getAttribute('b') === '1' || (!rPr.hasAttribute('b') && defBoldCell)) { run.bold = true; }
              const color = _resolveRunColor(rPr, themeColors);
              if (color) { run.color = color; }
              else if (defColorCell) { run.color = defColorCell; }
              const sz = rPr.getAttribute('sz');
              if (sz) { run.fontSize = Math.round(parseInt(sz, 10) / 100); }
              else if (defSzCell) { run.fontSize = defSzCell; }
              const ff = _resolveFont(rPr, themeFonts);
              if (ff) { run.fontFamily = ff; }
            } else {
              // No rPr at all — use paragraph defaults
              if (defBoldCell) { run.bold = true; }
              if (defColorCell) { run.color = defColorCell; }
              if (defSzCell) { run.fontSize = defSzCell; }
            }
            cellRuns.push(run);
          }
          // If no <a:r> found, try collecting <a:t> directly (field text, etc.)
          if (runEls.length === 0) {
            const tEls = pEls[pi].getElementsByTagNameNS(NS_A, 't');
            for (let ti = 0; ti < tEls.length; ti++) {
              const t = tEls[ti].textContent ?? '';
              if (t) {
                text += t;
                const fRun: TableCellRun = { text: t };
                if (defBoldCell) { fRun.bold = true; }
                if (defColorCell) { fRun.color = defColorCell; }
                if (defSzCell) { fRun.fontSize = defSzCell; }
                cellRuns.push(fRun);
              }
            }
          }
        }
      } else {
        // Fallback: collect all <a:t> text
        const tEls = tc.getElementsByTagNameNS(NS_A, 't');
        for (let t = 0; t < tEls.length; t++) {
          const txt = tEls[t].textContent ?? '';
          text += txt;
          if (txt) { cellRuns.push({ text: txt }); }
        }
      }

      // Extract cell borders from <a:tcBorders>
      let borders: TableCell['borders'] | undefined;
      if (tcPr) {
        // DrawingML cell borders are DIRECT children of <a:tcPr>, named
        // lnL/lnR/lnT/lnB (ECMA-376 §21.1.3.x). The original port looked for
        // a <a:tcBorders> wrapper with top/right/bottom/left children — that
        // is the WordprocessingML (<w:tcBorders>) convention and never exists
        // in PPTX, so cell borders were NEVER extracted and every table fell
        // back to the blanket #ccc grid in pptx.css (wrong color, and a
        // doubled seam where two stacked tables meet).
        const extractBorderSide = (ln: string): CellBorder | undefined => {
          const sideEl = _firstChildNS(tcPr, NS_A, ln);
          if (!sideEl) { return undefined; }
          if (_firstChildNS(sideEl, NS_A, 'noFill')) { return undefined; }
          const sf = _firstChildNS(sideEl, NS_A, 'solidFill');
          if (!sf) { return undefined; }
          const color = _resolveSolidFillColor(sf, themeColors);
          if (!color) { return undefined; }
          const w = sideEl.getAttribute('w');
          const widthPx = w ? Math.max(1, _emuToPx(parseInt(w, 10))) : 1;
          return { color, widthPx };
        };
        const top = extractBorderSide('lnT');
        const right = extractBorderSide('lnR');
        const bottom = extractBorderSide('lnB');
        const left = extractBorderSide('lnL');
        if (top || right || bottom || left) {
          borders = { ...(top ? { top } : {}), ...(right ? { right } : {}), ...(bottom ? { bottom } : {}), ...(left ? { left } : {}) };
        }
      }

      cells.push({
        text: text.trim(),
        colspan: gridSpan,
        rowspan: rowSpan,
        skip: hMerge || vMerge,
        ...(bgColor ? { bgColor } : {}),
        ...(cellAlign ? { align: cellAlign } : {}),
        ...(vAlign ? { vAlign } : {}),
        ...(borders ? { borders } : {}),
        ...(cellRuns.length > 0 ? { runs: cellRuns } : {}),
      });
    }
    rows.push(cells);
  }
  const totalRowH = rowHeightsEmu.reduce((s, h) => s + h, 0) || 1;
  const rowHeights = rowHeightsEmu.map(h => (h / totalRowH) * 100);

  if (!rows.length) { return null; }
  const accent1 = themeColors.get('accent1');
  const accentColor = accent1 ? `#${accent1}` : undefined;
  return { type: 'table', ...transform, colWidths, rowHeights, rows, ...(bandRow ? { bandRow } : {}), ...(bandCol ? { bandCol } : {}), ...(firstRow ? { firstRow } : {}), ...(lastRow ? { lastRow } : {}), ...(accentColor ? { accentColor } : {}) };
}

/**
 * Fallback for SmartArt / Chart / other non-table graphicFrames.
 * Looks for a fallback drawing image referenced via rels (e.g. ppt/drawings/ or ppt/media/).
 */
async function _extractGraphicFrameFallback(
  graphicFrame: Element,
  relsMap: Map<string, string>,
  zip: InstanceType<typeof import('jszip')>,
  groupEmu: GroupTransform | null = null,
  basePath = 'ppt/slides/',
): Promise<ImageShape | null> {
  let transform: { left: number; top: number; width: number; height: number; rotation?: number } | null;
  if (groupEmu) {
    const rawEmu = _getTransformEmu(graphicFrame);
    if (rawEmu) {
      const t = _applyGroupTransform(rawEmu, groupEmu);
      transform = { left: _emuToPx(t.x), top: _emuToPx(t.y), width: _emuToPx(t.cx), height: _emuToPx(t.cy) };
    } else {
      transform = null;
    }
  } else {
    transform = _getTransform(graphicFrame);
  }
  if (!transform) { return null; }

  // Find the embedded preview image by DOM query — NOT by string-matching
  // graphicFrame.toString(). xmldom fails to serialize OLE / SmartArt subtrees
  // wrapped in <mc:AlternateContent> (toString returns just "<p:graphicFrame/>"),
  // so the old `frameXml.includes(rId)` check always missed. This is exactly
  // how Visio/Excel OLE objects embed their EMF preview (slide 8's flowchart):
  // <p:graphicFrame><a:graphic><a:graphicData uri=".../ole"><mc:AlternateContent>
  //   …<p:oleObj><p:pic><p:blipFill><a:blip r:embed="rId2"/>. getElementsByTagNameNS
  // still walks the parsed tree correctly, so we read the blip rIds directly.
  const blips = graphicFrame.getElementsByTagNameNS(NS_A, 'blip');
  for (let i = 0; i < blips.length; i++) {
    const rId = blips[i].getAttributeNS(NS_R, 'embed') ?? blips[i].getAttribute('r:embed');
    if (!rId) { continue; }
    const target = relsMap.get(rId);
    if (!target || !target.match(/\.(png|jpg|jpeg|gif|bmp|svg|emf|wmf|tiff)$/i)) { continue; }
    const imgPath = target.startsWith('../')
      ? 'ppt/' + target.slice(3)
      : basePath + target;
    const imgFile = zip.file(imgPath);
    if (!imgFile) { continue; }
    const blob = await imgFile.async('base64');
    const ext = ('.' + (imgPath.split('.').pop() ?? '')).toLowerCase();
    const dataUri = _imageDataUri(imgPath, ext, blob);
    if (!dataUri) { continue; }
    return { type: 'image', ...transform, dataUri };
  }
  return null;
}

/**
 * 原生 PPTX 图表（graphicFrame → a:graphicData uri=".../chart" → c:chart r:id → ppt/charts/chartN.xml）。
 * 解析 chart XML 的类型 + 系列/分类/数值/颜色，产出 ChartShape 交给前端 SVG 渲染器。
 * 只覆盖常见类型（柱/条/折线/面积/饼/环）；无法解析则返回 null（由调用方再走图片兜底）。
 */
async function _extractChartShape(
  graphicFrame: Element,
  relsMap: Map<string, string>,
  zip: InstanceType<typeof import('jszip')>,
  groupEmu: GroupTransform | null = null,
  basePath = 'ppt/slides/',
  themeColors: Map<string, string> = new Map(),
): Promise<ChartShape | null> {
  let transform: { left: number; top: number; width: number; height: number } | null;
  if (groupEmu) {
    const rawEmu = _getTransformEmu(graphicFrame);
    transform = rawEmu
      ? (() => { const t = _applyGroupTransform(rawEmu, groupEmu); return { left: _emuToPx(t.x), top: _emuToPx(t.y), width: _emuToPx(t.cx), height: _emuToPx(t.cy) }; })()
      : null;
  } else {
    transform = _getTransform(graphicFrame);
  }
  if (!transform) { return null; }

  // c:chart r:id → chart part 路径
  const chartEl = graphicFrame.getElementsByTagNameNS(NS_C, 'chart')[0];
  const rId = chartEl?.getAttributeNS(NS_R, 'id') ?? chartEl?.getAttribute('r:id');
  if (!rId) { return null; }
  const target = relsMap.get(rId);
  if (!target) { return null; }
  const chartPath = target.startsWith('../') ? 'ppt/' + target.slice(3) : basePath + target;
  const file = zip.file(chartPath);
  if (!file) { return null; }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(await file.async('text'), 'application/xml');
  } catch { return null; }

  const plotArea = doc.getElementsByTagNameNS(NS_C, 'plotArea')[0];
  if (!plotArea) { return null; }

  // 图表类型：取 plotArea 下第一个已知 chart 元素
  const typeMap: Record<string, ChartShape['chartType']> = {
    barChart: 'column', lineChart: 'line', areaChart: 'area',
    pieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter', bubbleChart: 'scatter', radarChart: 'radar',
  };
  let chartTypeEl: Element | null = null;
  let chartType: ChartShape['chartType'] | null = null;
  for (const key of Object.keys(typeMap)) {
    const el = plotArea.getElementsByTagNameNS(NS_C, key)[0];
    if (el) { chartTypeEl = el; chartType = typeMap[key]; break; }
  }
  if (!chartTypeEl || !chartType) { return null; }
  // barChart 方向：bar=条形(横)、col=柱形(竖)
  if (chartType === 'column') {
    const dir = _firstChildNS(chartTypeEl, NS_C, 'barDir')?.getAttribute('val');
    if (dir === 'bar') { chartType = 'bar'; }
  }

  // 缓存点：<c:pt idx="n"><c:v>val</c:v> → 按 idx 填数组
  const readCache = (parent: Element | null, tag: 'strRef' | 'numRef' | 'strCache' | 'numCache', asNum: boolean): (string | number)[] => {
    if (!parent) { return []; }
    // c:cat/c:val 下是 c:strRef/c:numRef，再下是 c:strCache/c:numCache；也可能直接 c:numLit
    let cache: Element | undefined = parent.getElementsByTagNameNS(NS_C, tag === 'strRef' ? 'strCache' : 'numCache')[0];
    if (!cache) { cache = parent.getElementsByTagNameNS(NS_C, tag === 'strRef' ? 'strLit' : 'numLit')[0]; }
    if (!cache) { return []; }
    const pts = cache.getElementsByTagNameNS(NS_C, 'pt');
    const out: (string | number)[] = [];
    for (let i = 0; i < pts.length; i++) {
      const idx = parseInt(pts[i].getAttribute('idx') ?? String(i), 10);
      const v = pts[i].getElementsByTagNameNS(NS_C, 'v')[0]?.textContent ?? '';
      out[idx] = asNum ? (parseFloat(v) || 0) : v;
    }
    for (let i = 0; i < out.length; i++) { if (out[i] === undefined) { out[i] = asNum ? 0 : ''; } }
    return out;
  };

  const serEls = chartTypeEl.getElementsByTagNameNS(NS_C, 'ser');
  const series: ChartSeries[] = [];
  let categories: string[] = [];
  for (let s = 0; s < serEls.length; s++) {
    const ser = serEls[s];
    // 系列名
    const tx = _firstChildNS(ser, NS_C, 'tx');
    const nameArr = readCache(tx, 'strRef', false);
    const name = (tx?.getElementsByTagNameNS(NS_C, 'v')[0]?.textContent) || (nameArr[0] as string) || undefined;
    // 系列颜色：spPr 的 solidFill（柱/条/饼填充）或 a:ln 描边色（折线/雷达）。
    const serSpPr = _firstChildNS(ser, NS_C, 'spPr');
    const color = serSpPr ? (_chartFillColor(serSpPr, themeColors) ?? undefined) : undefined;
    // 数值(y)。散点/气泡:再读 xVal、bubbleSize。
    const val = _firstChildNS(ser, NS_C, 'val') ?? _firstChildNS(ser, NS_C, 'yVal');
    const values = readCache(val, 'numRef', true) as number[];
    let xValues: number[] | undefined;
    let sizes: number[] | undefined;
    let marker: string | undefined;
    if (chartType === 'scatter') {
      const xv = _firstChildNS(ser, NS_C, 'xVal');
      if (xv) { xValues = readCache(xv, 'numRef', true) as number[]; }
      const bs = _firstChildNS(ser, NS_C, 'bubbleSize');
      if (bs) { sizes = readCache(bs, 'numRef', true) as number[]; }
      const mk = _firstChildNS(ser, NS_C, 'marker');
      const symVal = (mk ? _firstChildNS(mk, NS_C, 'symbol') : null)?.getAttribute('val');
      if (symVal && symVal !== 'auto') { marker = symVal; }
    }
    // 每点颜色（c:dPt）：饼/环/单系列柱按点着色。dPt 下有 c:idx 和 c:spPr。
    let pointColors: (string | undefined)[] | undefined;
    const dPts = ser.getElementsByTagNameNS(NS_C, 'dPt');
    if (dPts.length) {
      pointColors = [];
      for (let d = 0; d < dPts.length; d++) {
        const idx = parseInt(_firstChildNS(dPts[d], NS_C, 'idx')?.getAttribute('val') ?? '-1', 10);
        const dSpPr = _firstChildNS(dPts[d], NS_C, 'spPr');
        const c = dSpPr ? _chartFillColor(dSpPr, themeColors) : null;
        if (idx >= 0 && c) { pointColors[idx] = c; }
      }
    }
    // 分类（用第一个有 cat 的系列）
    if (!categories.length) {
      const cat = _firstChildNS(ser, NS_C, 'cat') ?? _firstChildNS(ser, NS_C, 'xVal');
      const strCats = readCache(cat, 'strRef', false) as string[];
      categories = strCats.length ? strCats : (readCache(cat, 'numRef', true) as number[]).map(String);
    }
    if (values.length) { series.push({ ...(name ? { name } : {}), ...(color ? { color } : {}), values, ...(xValues ? { xValues } : {}), ...(sizes ? { sizes } : {}), ...(marker ? { marker } : {}), ...(pointColors ? { pointColors } : {}) }); }
  }
  if (!series.length) { return null; }

  // 数值标签：任一 dLbls 打开 showVal 即认为要显示。
  const showValues = (() => {
    const dl = chartTypeEl.getElementsByTagNameNS(NS_C, 'showVal');
    for (let i = 0; i < dl.length; i++) { if (dl[i].getAttribute('val') === '1') { return true; } }
    return false;
  })();
  // 分类兜底：用最长系列长度生成 1..N
  if (!categories.length) {
    const n = Math.max(...series.map((x) => x.values.length));
    categories = Array.from({ length: n }, (_, i) => String(i + 1));
  }

  // 标题
  let title: string | undefined;
  const titleEl = doc.getElementsByTagNameNS(NS_C, 'title')[0];
  if (titleEl) {
    const ts = titleEl.getElementsByTagNameNS(NS_A, 't');
    const parts: string[] = [];
    for (let i = 0; i < ts.length; i++) { parts.push(ts[i].textContent ?? ''); }
    const joined = parts.join('').trim();
    if (joined) { title = joined; }
  }

  return { type: 'chart', ...transform, chartType, categories, series, ...(title ? { title } : {}), ...(showValues ? { showValues } : {}) };
}

/** 从一个 solidFill 元素取颜色：srgbClr（十六进制）或 schemeClr（主题映射）。 */
function _solidFillColor(solid: Element, themeColors: Map<string, string>): string | null {
  const srgb = _firstChildNS(solid, NS_A, 'srgbClr');
  if (srgb) { return '#' + (srgb.getAttribute('val') ?? '000000'); }
  const scheme = _firstChildNS(solid, NS_A, 'schemeClr');
  if (scheme) {
    const mapped = themeColors.get(scheme.getAttribute('val') ?? '');
    if (mapped) { return mapped.startsWith('#') ? mapped : '#' + mapped; }
  }
  return null;
}

/** 图表系列/元素颜色：优先 spPr 的填充色，其次 a:ln 描边色（折线/雷达系列的颜色在描边里）。 */
function _chartFillColor(spPr: Element, themeColors: Map<string, string>): string | null {
  const solid = _firstChildNS(spPr, NS_A, 'solidFill');
  if (solid) { const c = _solidFillColor(solid, themeColors); if (c) { return c; } }
  const ln = _firstChildNS(spPr, NS_A, 'ln');
  if (ln) {
    const lnSolid = _firstChildNS(ln, NS_A, 'solidFill');
    if (lnSolid) { return _solidFillColor(lnSolid, themeColors); }
  }
  return null;
}

/**
 * Extract a connector shape (<p:cxnSp>) as a ConnectorShape for SVG rendering.
 * Reads position/size from a:xfrm (including flipH/flipV), line style from a:ln.
 */
function _extractConnectorShape(
  cxnSp: Element,
  groupEmu: GroupTransform | null = null,
  themeColors: Map<string, string> = new Map(),
): ConnectorShape | null {
  const spPr = _firstChildNS(cxnSp, NS_P, 'spPr');
  if (!spPr) { return null; }

  // Get xfrm with flip attributes
  const xfrm = spPr.getElementsByTagNameNS(NS_A, 'xfrm')[0];
  if (!xfrm) { return null; }
  const flipH = xfrm.getAttribute('flipH') === '1';
  const flipV = xfrm.getAttribute('flipV') === '1';

  // Extract connector type and adjustment values from prstGeom
  const prstGeom = _firstChildNS(spPr, NS_A, 'prstGeom');
  const connectorType = prstGeom?.getAttribute('prst') ?? 'line';
  const adjustValues: number[] = [];
  if (prstGeom) {
    const avLst = _firstChildNS(prstGeom, NS_A, 'avLst');
    if (avLst) {
      const gds = avLst.getElementsByTagNameNS(NS_A, 'gd');
      for (let i = 0; i < gds.length; i++) {
        const fmla = gds[i].getAttribute('fmla') ?? '';
        const match = fmla.match(/val\s+(-?\d+)/);
        if (match) {
          adjustValues.push(parseInt(match[1], 10) / 100000);
        }
      }
    }
  }

  let transform: { left: number; top: number; width: number; height: number } | null;
  if (groupEmu) {
    const rawEmu = _getTransformEmu(cxnSp);
    if (rawEmu) {
      const t = _applyGroupTransform(rawEmu, groupEmu);
      transform = { left: _emuToPx(t.x), top: _emuToPx(t.y), width: _emuToPx(t.cx), height: _emuToPx(t.cy) };
    } else {
      transform = null;
    }
  } else {
    transform = _getTransform(cxnSp);
  }
  if (!transform) { return null; }

  // Line properties from <a:ln>
  const ln = _firstChildNS(spPr, NS_A, 'ln');
  let strokeColor = '#000000';
  let strokeWidth = 1;
  let dashStyle = '';
  let headArrow = false;
  let tailArrow = false;

  if (ln) {
    // Stroke width (EMU → px; default 12700 EMU = 1pt ≈ 1.333px)
    const wAttr = ln.getAttribute('w');
    if (wAttr) {
      strokeWidth = Math.max(0.5, _emuToPx(parseInt(wAttr, 10)));
    }

    // Stroke color
    const solidFill = _firstChildNS(ln, NS_A, 'solidFill');
    if (solidFill) {
      const resolved = _resolveSolidFillColor(solidFill, themeColors);
      if (resolved) { strokeColor = resolved; }
    }

    // Dash style
    const prstDash = _firstChildNS(ln, NS_A, 'prstDash');
    if (prstDash) {
      const val = prstDash.getAttribute('val') ?? '';
      switch (val) {
        case 'dash':    dashStyle = '8,4'; break;
        case 'dot':     dashStyle = '2,4'; break;
        case 'lgDash':  dashStyle = '12,4'; break;
        case 'dashDot': dashStyle = '8,4,2,4'; break;
        case 'lgDashDot': dashStyle = '12,4,2,4'; break;
        default: break;
      }
    }

    // Arrow heads
    const headEnd = _firstChildNS(ln, NS_A, 'headEnd');
    if (headEnd) {
      const t = headEnd.getAttribute('type') ?? 'none';
      headArrow = t !== 'none' && t !== '';
    }
    const tailEnd = _firstChildNS(ln, NS_A, 'tailEnd');
    if (tailEnd) {
      const t = tailEnd.getAttribute('type') ?? 'none';
      tailArrow = t !== 'none' && t !== '';
    }
  }

  return {
    type: 'connector', ...transform,
    flipH, flipV,
    strokeColor, strokeWidth, dashStyle,
    headArrow, tailArrow,
    connectorType, adjustValues,
  };
}

function _firstChildNS(parent: Element, ns: string, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n.nodeType === 1 && (n as Element).localName === localName &&
        (n as Element).namespaceURI === ns) {
      return n as Element;
    }
  }
  return null;
}

/**
 * Extract theme color scheme tokens from <a:clrScheme>.
 * Fills `colors` with: { tx1→#RRGGBB, bg1→…, accent1→…, … }
 * OOXML schemeClr token names → clrScheme child tag names:
 *   tx1=dk1, bg1=lt1, tx2=dk2, bg2=lt2, accent1–6, hlink, folHlink
 */
function _loadThemeColors(themeDoc: Document, colors: Map<string, string>): void {
  const clrScheme = themeDoc.getElementsByTagNameNS(NS_A, 'clrScheme')[0];
  if (!clrScheme) { return; }
  const tagToToken: Record<string, string> = {
    dk1: 'tx1', lt1: 'bg1', dk2: 'tx2', lt2: 'bg2',
    accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
    accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
    hlink: 'hlink', folHlink: 'folHlink',
  };
  for (const [tag, token] of Object.entries(tagToToken)) {
    const el = clrScheme.getElementsByTagNameNS(NS_A, tag)[0];
    if (!el) { continue; }
    const hex = _extractColor(el);  // _extractColor handles srgbClr/sysClr/prstClr
    if (hex) { colors.set(token, hex); }
  }
}

/**
 * Extract major/minor font names from <a:fontScheme> in theme1.xml.
 * Fills `fonts` with tokens: +mj-lt, +mj-ea, +mn-lt, +mn-ea → typeface name.
 */
function _loadThemeFonts(themeDoc: Document, fonts: Map<string, string>): void {
  const fontScheme = themeDoc.getElementsByTagNameNS(NS_A, 'fontScheme')[0];
  if (!fontScheme) { return; }
  const sections: Array<{ tag: string; prefix: string }> = [
    { tag: 'majorFont', prefix: '+mj-' },
    { tag: 'minorFont', prefix: '+mn-' },
  ];
  for (const { tag, prefix } of sections) {
    const sect = fontScheme.getElementsByTagNameNS(NS_A, tag)[0];
    if (!sect) { continue; }
    for (const script of ['latin', 'ea', 'cs']) {
      const el = sect.getElementsByTagNameNS(NS_A, script)[0];
      if (el) {
        const tf = el.getAttribute('typeface');
        if (tf) { fonts.set(`${prefix}${script.substring(0, 2)}`, tf); }
      }
    }
  }
}

// ── Color modifier helpers (HSL conversion + OOXML transforms) ──────────────

function _hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function _rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function _rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) { return [0, 0, l]; }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) { h = ((g - b) / d + (g < b ? 6 : 0)) / 6; }
  else if (max === g) { h = ((b - r) / d + 2) / 6; }
  else { h = ((r - g) / d + 4) / 6; }
  return [h, s, l];
}

function _hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) { t += 1; }
    if (t > 1) { t -= 1; }
    if (t < 1 / 6) { return p + (q - p) * 6 * t; }
    if (t < 1 / 2) { return q; }
    if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/**
 * Apply OOXML color transform child elements (lumMod, lumOff, tint, shade, satMod)
 * to a base hex color. Returns the modified hex (6-digit, no '#' prefix).
 */
function _applyColorModifiers(hex: string, colorEl: Element): string {
  let [r, g, b] = _hexToRgb(hex);
  let [h, s, l] = _rgbToHsl(r, g, b);

  // Process child elements in document order
  for (let i = 0; i < colorEl.childNodes.length; i++) {
    const child = colorEl.childNodes[i];
    if (child.nodeType !== 1) { continue; }
    const el = child as Element;
    const name = el.localName;
    const val = parseInt(el.getAttribute('val') ?? '100000', 10);
    const frac = val / 100000;

    switch (name) {
      case 'lumMod':
        // Multiply lightness by fraction
        l = l * frac;
        break;
      case 'lumOff':
        // Add fraction to lightness
        l = l + frac;
        break;
      case 'satMod':
        // Multiply saturation by fraction
        s = s * frac;
        break;
      case 'tint': {
        // Tint toward white: mix with white by (1 - frac)
        // OOXML tint: newR = R + (255 - R) * (1 - frac)
        [r, g, b] = _hslToRgb(h, s, l);
        r = r + (255 - r) * (1 - frac);
        g = g + (255 - g) * (1 - frac);
        b = b + (255 - b) * (1 - frac);
        [h, s, l] = _rgbToHsl(r, g, b);
        break;
      }
      case 'shade': {
        // Shade toward black: multiply each channel by frac
        [r, g, b] = _hslToRgb(h, s, l);
        r = r * frac;
        g = g * frac;
        b = b * frac;
        [h, s, l] = _rgbToHsl(r, g, b);
        break;
      }
      default:
        break;
    }
  }

  // Clamp HSL values
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  [r, g, b] = _hslToRgb(h, s, l);
  return _rgbToHex(r, g, b);
}

/**
 * Resolve a CSS color from a <a:solidFill> element.
 * Shared logic used by both shape fill extraction and run color extraction.
 */
/** DrawingML preset color names → hex (ECMA-376 §20.1.10.47, common subset). */
const PRESET_COLORS: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', blue: '0000ff',
  green: '008000', yellow: 'ffff00', cyan: '00ffff', magenta: 'ff00ff',
  gray: '808080', grey: '808080', darkGray: '404040', lightGray: 'c0c0c0',
  orange: 'ffa500', purple: '800080', dkBlue: '00008b', ltBlue: 'add8e6',
};

/** Resolve the color of a run's <a:effectLst><a:glow> (if any), ignoring the
 * glow's own alpha — we want a solid halo color, not a faded one. */
function _resolveGlowColor(rPr: Element, themeColors: Map<string, string>): string | null {
  const effectLst = rPr.getElementsByTagNameNS(NS_A, 'effectLst')[0];
  if (!effectLst) { return null; }
  const glow = effectLst.getElementsByTagNameNS(NS_A, 'glow')[0];
  if (!glow) { return null; }
  const schemeClr = glow.getElementsByTagNameNS(NS_A, 'schemeClr')[0];
  if (schemeClr) {
    const hex = themeColors.get(schemeClr.getAttribute('val') ?? '');
    if (hex) { return `#${_applyColorModifiers(hex, schemeClr)}`; }
  }
  const colorEl =
    glow.getElementsByTagNameNS(NS_A, 'srgbClr')[0] ??
    glow.getElementsByTagNameNS(NS_A, 'prstClr')[0] ??
    glow.getElementsByTagNameNS(NS_A, 'sysClr')[0];
  const hex = _extractColor(glow);  // srgb/sys/prst → raw hex (no alpha)
  if (hex && colorEl) { return `#${_applyColorModifiers(hex, colorEl)}`; }
  if (hex) { return `#${hex}`; }
  return null;
}

/**
 * Resolve a run's <a:glow> effect into a CSS text-shadow string, or null.
 *
 * "White/light text + colored glow" is a common PPTX heading idiom: the text
 * fill is white (invisible on a light slide) and a colored glow makes it
 * visible. PowerPoint/LibreOffice render the halo; to match, we keep the
 * faithful (white) text color and add the glow as a text-shadow. We stack
 * the shadow a few times because a single soft blur washes out when the text
 * and background are both light — stacking thickens the halo into a readable
 * colored outline.
 */
function _resolveGlow(rPr: Element, themeColors: Map<string, string>): string | null {
  const effectLst = rPr.getElementsByTagNameNS(NS_A, 'effectLst')[0];
  if (!effectLst) { return null; }
  const glow = effectLst.getElementsByTagNameNS(NS_A, 'glow')[0];
  if (!glow) { return null; }
  const color = _resolveGlowColor(rPr, themeColors);
  if (!color) { return null; }
  const radEmu = parseInt(glow.getAttribute('rad') ?? '0', 10);
  const radPt = radEmu > 0 ? radEmu / 12700 : 4;  // EMU → pt (12700 EMU/pt)
  const b = `calc(${radPt.toFixed(1)} * var(--pt, 1pt))`;
  // Three stacked copies → a denser, more visible halo than a single blur.
  return `0 0 ${b} ${color},0 0 ${b} ${color},0 0 ${b} ${color}`;
}

function _resolveSolidFillColor(solidFill: Element, themeColors: Map<string, string>): string | null {
  const applyModifiersAndAlpha = (hex: string, colorEl: Element): string => {
    // Apply color transforms (lumMod, lumOff, tint, shade, satMod)
    const modifiedHex = _applyColorModifiers(hex, colorEl);
    // Apply alpha if present
    const alphaEl = colorEl.getElementsByTagNameNS(NS_A, 'alpha')[0];
    if (!alphaEl) { return `#${modifiedHex}`; }
    const a = Math.round(parseInt(alphaEl.getAttribute('val') ?? '100000', 10) / 1000) / 100;
    const [r, g, b] = _hexToRgb(modifiedHex);
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
  };

  const srgbClr = solidFill.getElementsByTagNameNS(NS_A, 'srgbClr')[0];
  if (srgbClr) {
    const hex = srgbClr.getAttribute('val');
    if (hex) { return applyModifiersAndAlpha(hex, srgbClr); }
  }

  const schemeClr = solidFill.getElementsByTagNameNS(NS_A, 'schemeClr')[0];
  if (schemeClr) {
    const token = schemeClr.getAttribute('val') ?? '';
    const hex = themeColors.get(token);
    if (hex) { return applyModifiersAndAlpha(hex, schemeClr); }
  }

  const sysClr = solidFill.getElementsByTagNameNS(NS_A, 'sysClr')[0];
  if (sysClr) {
    const hex = sysClr.getAttribute('lastClr');
    if (hex) { return `#${hex}`; }
  }

  const prstClr = solidFill.getElementsByTagNameNS(NS_A, 'prstClr')[0];
  if (prstClr) {
    const v = prstClr.getAttribute('val') ?? '';
    if (PRESET_COLORS[v]) { return applyModifiersAndAlpha(PRESET_COLORS[v], prstClr); }
  }

  return null;
}

/** Extract font color from <a:rPr> inner <a:solidFill> */
function _resolveRunColor(rPr: Element, themeColors: Map<string, string>): string | null {
  const solidFill = rPr.getElementsByTagNameNS(NS_A, 'solidFill')[0];
  if (!solidFill) { return null; }
  return _resolveSolidFillColor(solidFill, themeColors);
}

/** Resolve font family from <a:rPr> → <a:latin>/<a:ea>/<a:cs>, with theme font token resolution */
function _resolveFont(rPr: Element, themeFonts: Map<string, string>): string | null {
  const parts: string[] = [];
  for (const tag of ['latin', 'ea', 'cs']) {
    const el = rPr.getElementsByTagNameNS(NS_A, tag)[0];
    if (!el) { continue; }
    let tf = el.getAttribute('typeface');
    if (!tf) { continue; }
    // Resolve theme font references like +mj-lt, +mn-ea
    if (tf.startsWith('+')) {
      tf = themeFonts.get(tf) ?? null;
      if (!tf) { continue; }
    }
    if (!parts.includes(tf)) { parts.push(tf); }
  }
  if (!parts.length) { return null; }
  // CSS font-family: quote names that contain spaces or CJK
  return parts.map(f => /^[a-zA-Z][a-zA-Z0-9 -]*$/.test(f) ? `"${f}"` : `"${f}"`).join(',');
}

/**
 * Resolve a CSS color string from a DrawingML <a:solidFill> element,
 * supporting srgbClr, schemeClr (via themeColors), sysClr, and alpha.
 * Returns null when there is no fill (<a:noFill>) or it can't be resolved.
 */
function _extractFill(
  spPr: Element | null | undefined,
  themeColors: Map<string, string>,
): string | null {
  if (!spPr) { return null; }
  // IMPORTANT: use _firstChildNS (direct children only), NOT getElementsByTagNameNS.
  // <a:ln><a:noFill/></a:ln> means "no border stroke" — NOT "no shape fill".
  // getElementsByTagNameNS would find the nested <a:noFill> and wrongly skip the shape.
  if (_firstChildNS(spPr, NS_A, 'noFill')) { return null; }
  const solidFill = _firstChildNS(spPr, NS_A, 'solidFill');
  if (solidFill) { return _resolveSolidFillColor(solidFill, themeColors); }
  // Gradient fill on shapes
  const gradFill = _firstChildNS(spPr, NS_A, 'gradFill');
  if (gradFill) { return _resolveGradFill(gradFill, themeColors); }
  return null;
}

/** Extract outer shadow as CSS box-shadow from <a:effectLst><a:outerShdw> */
function _extractShadow(
  spPr: Element | null | undefined,
  themeColors: Map<string, string>,
): string | null {
  if (!spPr) { return null; }
  const effectLst = _firstChildNS(spPr, NS_A, 'effectLst');
  if (!effectLst) { return null; }
  const outerShdw = _firstChildNS(effectLst, NS_A, 'outerShdw');
  if (!outerShdw) { return null; }
  // Distance & direction → x/y offsets
  const dist = parseInt(outerShdw.getAttribute('dist') ?? '0', 10);
  const dir = parseInt(outerShdw.getAttribute('dir') ?? '0', 10);
  const blurRad = parseInt(outerShdw.getAttribute('blurRad') ?? '0', 10);
  const distPt = _emuToPx(dist) * 0.75;   // px → pt for scaling
  const blurPt = _emuToPx(blurRad) * 0.75;
  const dirRad = (dir / 60000) * Math.PI / 180;  // 60000ths of degree → radians
  const dx = Math.round(distPt * Math.cos(dirRad) * 10) / 10;
  const dy = Math.round(distPt * Math.sin(dirRad) * 10) / 10;
  // Shadow color
  const color = _resolveSolidFillColor(outerShdw, themeColors);
  const alpha = outerShdw.getElementsByTagNameNS(NS_A, 'alpha')[0];
  let cssColor = color ?? 'rgba(0,0,0,0.4)';
  if (alpha) {
    const alphaVal = parseInt(alpha.getAttribute('val') ?? '100000', 10) / 100000;
    // Convert hex to rgba
    if (cssColor.startsWith('#') && cssColor.length === 7) {
      const r = parseInt(cssColor.slice(1, 3), 16);
      const g = parseInt(cssColor.slice(3, 5), 16);
      const b = parseInt(cssColor.slice(5, 7), 16);
      cssColor = `rgba(${r},${g},${b},${alphaVal.toFixed(2)})`;
    }
  }
  return `calc(${dx} * var(--pt,1pt)) calc(${dy} * var(--pt,1pt)) calc(${blurPt} * var(--pt,1pt)) ${cssColor}`;
}

/** Returns true if the <p:sp> has a <p:ph> placeholder element */
function _isPlaceholder(sp: Element): boolean {
  const nvSpPr = _firstChildNS(sp, NS_P, 'nvSpPr');
  if (!nvSpPr) { return false; }
  const nvPr = _firstChildNS(nvSpPr, NS_P, 'nvPr');
  if (!nvPr) { return false; }
  return !!_firstChildNS(nvPr, NS_P, 'ph');
}

/** Get raw EMU transform values (without group adjustment) */
function _getTransformEmu(el: Element): { x: number; y: number; cx: number; cy: number; rotation?: number } | null {
  const xfrm = el.getElementsByTagNameNS(NS_A, 'xfrm')[0]
            ?? el.getElementsByTagNameNS(NS_P, 'xfrm')[0];
  if (!xfrm) { return null; }
  const off = xfrm.getElementsByTagNameNS(NS_A, 'off')[0];
  const ext = xfrm.getElementsByTagNameNS(NS_A, 'ext')[0];
  if (!off || !ext) { return null; }
  const rotAttr = xfrm.getAttribute('rot');
  const rotation = rotAttr ? parseInt(rotAttr, 10) / 60000 : undefined;
  return {
    x: parseInt(off.getAttribute('x') ?? '0', 10),
    y: parseInt(off.getAttribute('y') ?? '0', 10),
    cx: parseInt(ext.getAttribute('cx') ?? '0', 10),
    cy: parseInt(ext.getAttribute('cy') ?? '0', 10),
    ...(rotation ? { rotation } : {}),
  };
}

/** Map child EMU coordinates to slide-space EMU using a group transform */
function _applyGroupTransform(
  emu: { x: number; y: number; cx: number; cy: number },
  g: GroupTransform,
): { x: number; y: number; cx: number; cy: number } {
  const sx = g.chExtCx ? g.extCx / g.chExtCx : 1;
  const sy = g.chExtCy ? g.extCy / g.chExtCy : 1;
  return {
    x: g.offX + (emu.x - g.chOffX) * sx,
    y: g.offY + (emu.y - g.chOffY) * sy,
    cx: emu.cx * sx,
    cy: emu.cy * sy,
  };
}

/**
 * Build a GroupTransform from a <p:grpSpPr> element.
 * If nested inside another group, the group's own position is mapped first.
 */
function _getGroupTransformInfo(
  grpSpPr: Element,
  parentGroup: GroupTransform | null,
): GroupTransform | null {
  const xfrm = grpSpPr.getElementsByTagNameNS(NS_A, 'xfrm')[0];
  if (!xfrm) { return parentGroup; }
  const off = xfrm.getElementsByTagNameNS(NS_A, 'off')[0];
  const ext = xfrm.getElementsByTagNameNS(NS_A, 'ext')[0];
  const chOff = xfrm.getElementsByTagNameNS(NS_A, 'chOff')[0];
  const chExt = xfrm.getElementsByTagNameNS(NS_A, 'chExt')[0];
  if (!off || !ext) { return parentGroup; }

  let rawOffX = parseInt(off.getAttribute('x') ?? '0', 10);
  let rawOffY = parseInt(off.getAttribute('y') ?? '0', 10);
  let rawExtCx = parseInt(ext.getAttribute('cx') ?? '1', 10);
  let rawExtCy = parseInt(ext.getAttribute('cy') ?? '1', 10);

  // If nested inside another group, transform this group's own position to slide space
  if (parentGroup) {
    const mapped = _applyGroupTransform(
      { x: rawOffX, y: rawOffY, cx: rawExtCx, cy: rawExtCy }, parentGroup);
    rawOffX = mapped.x; rawOffY = mapped.y;
    rawExtCx = mapped.cx; rawExtCy = mapped.cy;
  }

  return {
    offX: rawOffX, offY: rawOffY,
    extCx: rawExtCx, extCy: rawExtCy,
    chOffX: parseInt(chOff?.getAttribute('x') ?? '0', 10),
    chOffY: parseInt(chOff?.getAttribute('y') ?? '0', 10),
    chExtCx: parseInt(chExt?.getAttribute('cx') ?? String(rawExtCx), 10),
    chExtCy: parseInt(chExt?.getAttribute('cy') ?? String(rawExtCy), 10),
  };
}

/** Parse a rels XML string into a rId → target map */
function _parseRelsXml(
  relsXml: string | undefined | null,
  parser: DOMParser,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) { return map; }
  const doc = parser.parseFromString(relsXml, 'text/xml');
  const rels = doc.getElementsByTagName('Relationship');
  for (let j = 0; j < rels.length; j++) {
    const id = rels[j].getAttribute('Id');
    const target = rels[j].getAttribute('Target') ?? '';
    if (id && target) { map.set(id, target); }
  }
  return map;
}

/**
 * Resolve a bullet character from a (possibly symbol) font to a displayable
 * Unicode character.  Many templates store bullets as ASCII letters in
 * Wingdings / Wingdings 2 / Symbol fonts where the glyphs don't match the
 * Unicode codepoints of those letters.
 */
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
  0x70: '▪', 0x71: '▫', 0x72: '□', 0xA7: '▪',
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
  let code = char.charCodeAt(0);
  // PowerPoint stores symbol-font glyphs in the Unicode Private Use Area as
  // 0xF000 + the font's byte index (e.g. Wingdings 'ü' = byte 0xFC → 0xF0FC).
  // Strip that 0xF000 offset so the map lookup (keyed by the byte index) hits.
  // Without this, a bullet like 0xF0FC ('✓') misses every map and renders as
  // a tofu box □.
  if (code >= 0xF000 && code <= 0xF0FF) { code -= 0xF000; }
  if (f === 'wingdings 2' && _wingdings2Map[code]) { return _wingdings2Map[code]; }
  if (f === 'wingdings' && _wingdingsMap[code]) { return _wingdingsMap[code]; }
  if (f === 'wingdings 3' && _wingdings3Map[code]) { return _wingdings3Map[code]; }
  if (_knownSymbolFonts.includes(f) && code < 128) { return '•'; }
  return char;
}

function _resolveBulletChar(char: string, font?: string | null): string {
  return _resolveSymbolChar(char, font);
}

/**
/** Extract 6-digit hex RGB from a DrawingML fill element (solidFill/etc.) */
function _extractColor(fillEl: Element): string | null {
  const srgbClr = fillEl.getElementsByTagNameNS(NS_A, 'srgbClr')[0];
  if (srgbClr) { return srgbClr.getAttribute('val'); }
  // System color — use lastClr fallback value
  const sysClr = fillEl.getElementsByTagNameNS(NS_A, 'sysClr')[0];
  if (sysClr) { return sysClr.getAttribute('lastClr'); }
  // Preset color
  const prstClr = fillEl.getElementsByTagNameNS(NS_A, 'prstClr')[0];
  if (prstClr) {
    const v = prstClr.getAttribute('val');
    if (v && PRESET_COLORS[v]) { return PRESET_COLORS[v]; }
  }
  return null;
}

/**
 * Return the placeholder map key for a <p:sp> shape.
 *
 * OOXML matching rule (ECMA-376 §19.3.1.36):
 *   idx is the primary identifier.  A non-zero idx takes precedence over type
 *   so that master/layout/slide placeholders with the same idx always share
 *   the same key even when their type attributes differ.
 *   idx=0 (explicit or default) is the title slot — identified by type instead
 *   so "type:title", "type:dt", "type:ftr", "type:sldNum" remain distinct.
 */
function _getPhKey(sp: Element): string | null {
  const nvSpPr = _firstChildNS(sp, NS_P, 'nvSpPr');
  if (!nvSpPr) { return null; }
  const nvPr = _firstChildNS(nvSpPr, NS_P, 'nvPr');
  if (!nvPr) { return null; }
  const ph = _firstChildNS(nvPr, NS_P, 'ph');
  if (!ph) { return null; }
  const type = ph.getAttribute('type') ?? '';
  const idx  = ph.getAttribute('idx')  ?? '0';
  // Single-instance types (dt/ftr/sldNum/hdr): always match by type, not idx,
  // because master and layout may assign different idx values for the same role.
  if (type === 'dt' || type === 'ftr' || type === 'sldNum' || type === 'hdr') {
    return `type:${type}`;
  }
  // Non-zero idx → use idx as key (covers body/content/media/… slots)
  // idx=0 or absent  → use type as key (title, ctrTitle, etc.)
  return (idx && idx !== '0') ? `idx:${idx}` : (type ? `type:${type}` : 'idx:0');
}

/**
 * Walk a slide master or layout document and populate `map` with
 * each placeholder's geometry (left/top/width/height).
 *
 * When an entry already exists (layout overriding master), only the geometry
 * fields are updated — style fields (defFontSz/defAlign/defBullet) set by
 * _applyMasterTxStyles are preserved.
 */
function _collectPlaceholderTransforms(
  doc: Document,
  map: Map<string, PlaceholderTransform>,
): void {
  const spTree = doc.getElementsByTagNameNS(NS_P, 'spTree')[0];
  if (!spTree) { return; }
  const sps = spTree.getElementsByTagNameNS(NS_P, 'sp');
  for (let i = 0; i < sps.length; i++) {
    const sp = sps[i] as Element;
    if (sp.parentNode !== spTree) { continue; }  // skip nested group members
    const key = _getPhKey(sp);
    if (!key) { continue; }
    const t = _getTransform(sp);
    if (!t) { continue; }
    const existing = map.get(key);
    if (existing) {
      // Merge geometry only; keep style defaults from master txStyles
      existing.left = t.left; existing.top = t.top;
      existing.width = t.width; existing.height = t.height;
    } else {
      map.set(key, t);
    }
  }
}

/**
 * Read each layout placeholder's <a:lstStyle>/<a:lvl1pPr> and overlay the
 * bullet/align/fontSize fields on matching phMap entries.
 * This is the intermediate layer between master txStyles and slide-level pPr.
 */
function _applyLayoutLstStyles(
  layoutDoc: Document,
  phMap: Map<string, PlaceholderTransform>,
  themeColors: Map<string, string>,
): void {
  const spTree = layoutDoc.getElementsByTagNameNS(NS_P, 'spTree')[0];
  if (!spTree) { return; }
  const sps = spTree.getElementsByTagNameNS(NS_P, 'sp');
  for (let i = 0; i < sps.length; i++) {
    const sp = sps[i] as Element;
    if (sp.parentNode !== spTree) { continue; }
    const key = _getPhKey(sp);
    if (!key) { continue; }
    const entry = phMap.get(key);
    if (!entry) { continue; }

    const txBody = sp.getElementsByTagNameNS(NS_P, 'txBody')[0];
    if (!txBody) { continue; }
    const lstStyle = _firstChildNS(txBody, NS_A, 'lstStyle');
    if (!lstStyle) { continue; }
    const lvl1pPr = lstStyle.getElementsByTagNameNS(NS_A, 'lvl1pPr')[0];
    if (!lvl1pPr) { continue; }

    // Alignment
    const algn = lvl1pPr.getAttribute('algn');
    if (algn === 'ctr') { entry.defAlign = 'center'; }
    else if (algn === 'r') { entry.defAlign = 'right'; }
    else if (algn === 'just') { entry.defAlign = 'justify'; }
    else if (algn === 'l') { entry.defAlign = 'left'; }

    // Bullet
    if (lvl1pPr.getElementsByTagNameNS(NS_A, 'buNone')[0]) {
      entry.defBullet = undefined;
    }
    const buFontEl = lvl1pPr.getElementsByTagNameNS(NS_A, 'buFont')[0];
    const buFontName = buFontEl?.getAttribute('typeface') ?? null;
    const buChar = lvl1pPr.getElementsByTagNameNS(NS_A, 'buChar')[0];
    if (buChar) {
      const raw = buChar.getAttribute('char') ?? '';
      entry.defBullet = _resolveBulletChar(raw, buFontName);
    }

    // Font size + color
    const defRPr = lvl1pPr.getElementsByTagNameNS(NS_A, 'defRPr')[0];
    if (defRPr) {
      const sz = defRPr.getAttribute('sz');
      if (sz) { entry.defFontSz = Math.round(parseInt(sz, 10) / 100); }
      const c = _resolveRunColor(defRPr, themeColors);
      if (c) { entry.defColor = c; }
    }
  }
}

/**
 * Parse the default paragraph style from a single <p:titleStyle>/<p:bodyStyle>
 * element inside <p:txStyles>.  Returns only the fields we care about.
 */
function _parseLvl1Style(styleEl: Element, themeColors: Map<string, string>): Pick<PlaceholderTransform, 'defFontSz' | 'defAlign' | 'defBullet' | 'defColor'> {
  const result: Pick<PlaceholderTransform, 'defFontSz' | 'defAlign' | 'defBullet' | 'defColor'> = {};
  const lvl1pPr = styleEl.getElementsByTagNameNS(NS_A, 'lvl1pPr')[0];
  if (!lvl1pPr) { return result; }

  const algn = lvl1pPr.getAttribute('algn');
  if (algn === 'ctr') { result.defAlign = 'center'; }
  else if (algn === 'r') { result.defAlign = 'right'; }
  else if (algn === 'just') { result.defAlign = 'justify'; }
  else { result.defAlign = 'left'; }

  const defRPr = lvl1pPr.getElementsByTagNameNS(NS_A, 'defRPr')[0];
  if (defRPr) {
    const sz = defRPr.getAttribute('sz');
    if (sz) { result.defFontSz = Math.round(parseInt(sz, 10) / 100); }
    const c = _resolveRunColor(defRPr, themeColors);
    if (c) { result.defColor = c; }
  }

  const buFontEl = lvl1pPr.getElementsByTagNameNS(NS_A, 'buFont')[0];
  const buFontName = buFontEl?.getAttribute('typeface') ?? null;
  const buChar = lvl1pPr.getElementsByTagNameNS(NS_A, 'buChar')[0];
  if (buChar) {
    const raw = buChar.getAttribute('char') ?? '';
    result.defBullet = _resolveBulletChar(raw, buFontName);
  }

  return result;
}

/**
 * After placeholder transforms are collected, overlay text-style defaults
 * from the master's <p:txStyles> block onto the phMap entries.
 *   titleStyle → key "type:title"
 *   bodyStyle  → all content-placeholder keys (idx > 0)
 *   otherStyle → remaining idx:0 slot
 */
function _applyMasterTxStyles(
  masterDoc: Document,
  phMap: Map<string, PlaceholderTransform>,
  themeColors: Map<string, string>,
): void {
  const txStyles = masterDoc.getElementsByTagNameNS(NS_P, 'txStyles')[0];
  if (!txStyles) { return; }

  const sectionMap: Array<{ localName: string; apply: (s: ReturnType<typeof _parseLvl1Style>) => void }> = [
    {
      localName: 'titleStyle',
      apply: s => {
        const e = phMap.get('type:title');
        if (e) { Object.assign(e, s); }
      },
    },
    {
      localName: 'bodyStyle',
      apply: s => {
        // Apply to all content-placeholder slots (idx > 0)
        for (const [key, entry] of phMap) {
          if (key.startsWith('idx:') && key !== 'idx:0') { Object.assign(entry, s); }
        }
      },
    },
  ];

  for (const { localName, apply } of sectionMap) {
    const el = _firstChildNS(txStyles, NS_P, localName);
    if (el) { apply(_parseLvl1Style(el, themeColors)); }
  }
}

/**
 * Resolve a gradient fill (<a:gradFill>) to a CSS linear-gradient string.
 * Returns null if the gradient cannot be resolved.
 */
function _resolveGradFill(gradFill: Element, themeColors: Map<string, string>): string | null {
  const gsLst = _firstChildNS(gradFill, NS_A, 'gsLst');
  if (!gsLst) { return null; }

  const stops: Array<{ pos: number; color: string }> = [];
  const gsEls = gsLst.getElementsByTagNameNS(NS_A, 'gs');
  for (let i = 0; i < gsEls.length; i++) {
    const gs = gsEls[i];
    if (gs.parentNode !== gsLst) { continue; }
    const pos = parseInt(gs.getAttribute('pos') ?? '0', 10) / 1000; // 0-100000 → 0-100%

    // Resolve color from the <a:gs> child (srgbClr, schemeClr, sysClr)
    const color = _resolveSolidFillColor(gs, themeColors);
    if (color) {
      stops.push({ pos, color });
    }
  }

  if (stops.length === 0) { return null; }

  // Read angle from <a:lin ang="..."/>  (60000ths of a degree)
  const lin = _firstChildNS(gradFill, NS_A, 'lin');
  const angVal = lin ? parseInt(lin.getAttribute('ang') ?? '10800000', 10) : 10800000;
  const angleDeg = Math.round(angVal / 60000); // default 180° (top to bottom)

  const stopStrs = stops.map(s => `${s.color} ${s.pos.toFixed(1)}%`).join(', ');
  return `linear-gradient(${angleDeg}deg, ${stopStrs})`;
}

/**
 * Extract background from a document's <p:cSld><p:bg><p:bgPr>.
 * Supports solid fills (→ bgColor), gradient fills (→ bgColor as CSS gradient),
 * image fills / blipFill (→ bgImage data URI), and bgRef color overrides.
 */
async function _extractBg(
  doc: Document,
  relsMap: Map<string, string>,
  zip: InstanceType<typeof import('jszip')>,
  themeColors: Map<string, string> = new Map(),
  basePath = 'ppt/slides/',
): Promise<{ bgColor?: string; bgImage?: string }> {
  const cSld = doc.getElementsByTagNameNS(NS_P, 'cSld')[0];
  if (!cSld) { return {}; }
  const bg = _firstChildNS(cSld, NS_P, 'bg');
  if (!bg) { return {}; }
  const bgPr = _firstChildNS(bg, NS_P, 'bgPr');

  if (bgPr) {
    // Solid fill
    const solidFill = _firstChildNS(bgPr, NS_A, 'solidFill');
    if (solidFill) {
      const color = _extractColor(solidFill);
      if (color) { return { bgColor: color }; }
    }

    // Gradient fill → CSS linear-gradient
    const gradFill = _firstChildNS(bgPr, NS_A, 'gradFill');
    if (gradFill) {
      const bgGrad = _resolveGradFill(gradFill, themeColors);
      if (bgGrad) { return { bgColor: bgGrad }; }
    }

    // Image fill (blipFill) — common in modern templates for photo/textured backgrounds
    const blipFill = bgPr.getElementsByTagNameNS(NS_A, 'blipFill')[0];
    if (blipFill) {
      const blip = blipFill.getElementsByTagNameNS(NS_A, 'blip')[0];
      if (blip) {
        const rEmbed = blip.getAttributeNS(NS_R, 'embed') ?? blip.getAttribute('r:embed');
        if (rEmbed) {
          const target = relsMap.get(rEmbed);
          if (target) {
            const imgPath = target.startsWith('../')
              ? 'ppt/' + target.slice(3)
              : basePath + target;
            const imgFile = zip.file(imgPath);
            if (imgFile) {
              const blob = await imgFile.async('base64');
              const ext = ('.' + (imgPath.split('.').pop() ?? '')).toLowerCase();
              const uri = _imageDataUri(imgPath, ext, blob);
              if (uri) { return { bgImage: uri }; }
            }
          }
        }
      }
    }
  }

  // Background style reference (<p:bgRef>) — can contain a color override
  const bgRef = _firstChildNS(bg, NS_P, 'bgRef');
  if (bgRef) {
    const color = _resolveSolidFillColor(bgRef, themeColors);
    if (color) {
      // Strip '#' prefix for consistency with hex bgColor values
      const colorVal = color.startsWith('#') ? color.slice(1) : color;
      return { bgColor: colorVal };
    }
  }

  return {};
}

// ── HTML Builder ─────────────────────────────────────────────────────────────
// NOTE: VS Code Webview CSP blocks inline style="..." attributes when
// style-src uses nonce-based policy. All dynamic styles MUST go into the
// <style nonce="..."> block as CSS classes.

/**
 * Extract SVG path data from an OOXML <a:custGeom> element.
 * Converts moveTo/lnTo/cubicBezTo/quadBezTo/close to SVG path commands.
 * Coordinates are normalized to a 0-100 viewBox.
 */
function _extractCustomGeomPath(custGeom: Element): string | null {
  const pathLst = _firstChildNS(custGeom, NS_A, 'pathLst');
  if (!pathLst) { return null; }
  const pathEl = _firstChildNS(pathLst, NS_A, 'path');
  if (!pathEl) { return null; }

  const w = parseInt(pathEl.getAttribute('w') ?? '1', 10) || 1;
  const h = parseInt(pathEl.getAttribute('h') ?? '1', 10) || 1;

  let d = '';
  for (let i = 0; i < pathEl.childNodes.length; i++) {
    const node = pathEl.childNodes[i];
    if (node.nodeType !== 1) { continue; }
    const el = node as Element;
    const name = el.localName;

    if (name === 'moveTo') {
      const pt = el.getElementsByTagNameNS(NS_A, 'pt')[0];
      if (pt) {
        const x = (parseInt(pt.getAttribute('x') ?? '0', 10) / w * 100).toFixed(2);
        const y = (parseInt(pt.getAttribute('y') ?? '0', 10) / h * 100).toFixed(2);
        d += `M${x},${y} `;
      }
    } else if (name === 'lnTo') {
      const pt = el.getElementsByTagNameNS(NS_A, 'pt')[0];
      if (pt) {
        const x = (parseInt(pt.getAttribute('x') ?? '0', 10) / w * 100).toFixed(2);
        const y = (parseInt(pt.getAttribute('y') ?? '0', 10) / h * 100).toFixed(2);
        d += `L${x},${y} `;
      }
    } else if (name === 'cubicBezTo') {
      const pts = el.getElementsByTagNameNS(NS_A, 'pt');
      if (pts.length >= 3) {
        const coords: string[] = [];
        for (let j = 0; j < 3; j++) {
          coords.push(
            (parseInt(pts[j].getAttribute('x') ?? '0', 10) / w * 100).toFixed(2),
            (parseInt(pts[j].getAttribute('y') ?? '0', 10) / h * 100).toFixed(2),
          );
        }
        d += `C${coords.join(',')} `;
      }
    } else if (name === 'quadBezTo') {
      const pts = el.getElementsByTagNameNS(NS_A, 'pt');
      if (pts.length >= 2) {
        const coords: string[] = [];
        for (let j = 0; j < 2; j++) {
          coords.push(
            (parseInt(pts[j].getAttribute('x') ?? '0', 10) / w * 100).toFixed(2),
            (parseInt(pts[j].getAttribute('y') ?? '0', 10) / h * 100).toFixed(2),
          );
        }
        d += `Q${coords.join(',')} `;
      }
    } else if (name === 'arcTo') {
      // OOXML arcTo: wR, hR (radii in EMU), stAng, swAng (in 60000ths of a degree)
      const wR = parseInt(el.getAttribute('wR') ?? '0', 10);
      const hR = parseInt(el.getAttribute('hR') ?? '0', 10);
      const stAng = parseInt(el.getAttribute('stAng') ?? '0', 10) / 60000; // degrees
      const swAng = parseInt(el.getAttribute('swAng') ?? '0', 10) / 60000;
      const rx = wR / w * 100;
      const ry = hR / h * 100;
      // Compute arc endpoint: current position is on the ellipse at stAng,
      // endpoint is at stAng + swAng
      const endAngRad = (stAng + swAng) * Math.PI / 180;
      const stAngRad = stAng * Math.PI / 180;
      // Delta from center: center is offset from current pos by (-cos(stAng)*rx, -sin(stAng)*ry)
      const dx = rx * (Math.cos(endAngRad) - Math.cos(stAngRad));
      const dy = ry * (Math.sin(endAngRad) - Math.sin(stAngRad));
      const largeArc = Math.abs(swAng) > 180 ? 1 : 0;
      const sweep = swAng > 0 ? 1 : 0;
      // SVG arc: relative endpoint via 'a' (lowercase) for simplicity
      d += `a${rx.toFixed(2)},${ry.toFixed(2)} 0 ${largeArc} ${sweep} ${dx.toFixed(2)},${dy.toFixed(2)} `;
    } else if (name === 'close') {
      d += 'Z ';
    }
  }

  return d.trim() || null;
}

/**
 * Parametric preset shapes — generate SVG path from OOXML adjustment values.
 * Adjustment values are in percentage (0-100) after dividing by 1000.
 * Returns SVG path in 100×100 viewBox.
 */
/** 读 avLst 里某个 gd 的 val（原始整数）；无则返回默认。 */
function _gdVal(prstGeom: Element, name: string, def: number): number {
  const avLst = _firstChildNS(prstGeom, NS_A, 'avLst');
  if (avLst) {
    const gds = avLst.getElementsByTagNameNS(NS_A, 'gd');
    for (let i = 0; i < gds.length; i++) {
      if (gds[i].getAttribute('name') === name) {
        const m = (gds[i].getAttribute('fmla') ?? '').match(/val\s+(-?\d+)/);
        if (m) { return parseInt(m[1], 10); }
      }
    }
  }
  return def;
}
/** 0-100 网格上椭圆边界点(角度=度,顺时针,0°指向右;半径 r)。 */
function _arcPt(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
}
/**
 * arc/pie/chord/blockArc → SVG 路径(0-100 网格,渲染时按宽高比拉伸成椭圆弧,与 OOXML 一致)。
 * 角度取自 adj1(起)/adj2(止),单位 1/60000 度;blockArc 的 adj3 是厚度(1/100000)。默认值取 ECMA 预设。
 */
function _arcLikePath(prst: string, prstGeom: Element): string | null {
  const n = (v: number) => v.toFixed(2);
  const defs: Record<string, [number, number]> = { arc: [16200000, 0], pie: [0, 16200000], chord: [2700000, 16200000], blockArc: [10800000, 0] };
  const [dS, dE] = defs[prst] ?? [0, 16200000];
  const st = _gdVal(prstGeom, 'adj1', dS) / 60000;
  const en = _gdVal(prstGeom, 'adj2', dE) / 60000;
  let sweep = en - st; while (sweep < 0) { sweep += 360; } while (sweep > 360) { sweep -= 360; }
  const large = sweep > 180 ? 1 : 0;
  const [sx, sy] = _arcPt(st, 50);
  const [ex, ey] = _arcPt(en, 50);
  // arc 与 pie 都经圆心闭合成扇形:OOXML arc 虽是开放路径,但一旦有填充,开放路径会被 SVG 用弦
  // 隐式闭合 → 填成弓形(扇形减中心三角)。经圆心闭合才是用户期望的「四分之一圆(扇形)」。
  if (prst === 'arc' || prst === 'pie') { return `M50,50 L${n(sx)},${n(sy)} A50,50 0 ${large} 1 ${n(ex)},${n(ey)} Z`; }
  if (prst === 'chord') { return `M${n(sx)},${n(sy)} A50,50 0 ${large} 1 ${n(ex)},${n(ey)} Z`; }
  // blockArc: 环形段。adj3 = 厚度占半径比例。
  const th = Math.max(0.05, Math.min(0.95, _gdVal(prstGeom, 'adj3', 25000) / 100000));
  const ir = 50 * (1 - th);
  const [isx, isy] = _arcPt(st, ir);
  const [iex, iey] = _arcPt(en, ir);
  return `M${n(sx)},${n(sy)} A50,50 0 ${large} 1 ${n(ex)},${n(ey)} L${n(iex)},${n(iey)} A${n(ir)},${n(ir)} 0 ${large} 0 ${n(isx)},${n(isy)} Z`;
}

const _parametricPresetBuilders: Record<string, (adjs: Map<string, number>) => string> = {
  corner(adjs) {
    // adj1 = horizontal arm width (% of shape width), adj2 = vertical arm height (% of shape height)
    const a1 = adjs.get('adj1') ?? 50;  // default 50%
    const a2 = adjs.get('adj2') ?? 50;
    return `M0,0 L${a1},0 L${a1},${100 - a2} L100,${100 - a2} L100,100 L0,100 Z`;
  },
  foldedCorner(adjs) {
    const a = adjs.get('adj') ?? 16.667;  // fold size as % of shape
    const f = 100 - a;
    return `M0,0 L100,0 L100,${f} L${f},100 L0,100 Z M100,${f} L${f},${f} L${f},100`;
  },
};
