/**
 * Verbatim port of `_presetGeomPaths` from NID
 * `src/webview/pptxViewerPanel.ts` (lines 2320–2395).
 *
 * SVG path-data lookup table for OOXML preset shape geometries.
 * Used by _buildShapeParts to render shape outlines when the shape has
 * a known `prstGeom` and no `customSvgPath` from parsing.
 *
 * DO NOT EDIT — see ported/README.md.
 */
export const _presetGeomPaths: Record<string, string> = {
  // Basic shapes
  ellipse: 'M50,0 A50,50 0 1,1 50,100 A50,50 0 1,1 50,0 Z',
  triangle: 'M50,0 L100,100 L0,100 Z',
  rtTriangle: 'M0,100 L100,100 L0,0 Z',
  diamond: 'M50,0 L100,50 L50,100 L0,50 Z',
  parallelogram: 'M20,0 L100,0 L80,100 L0,100 Z',
  trapezoid: 'M20,0 L80,0 L100,100 L0,100 Z',
  pentagon: 'M50,0 L100,38 L81,100 L19,100 L0,38 Z',
  hexagon: 'M25,0 L75,0 L100,50 L75,100 L25,100 L0,50 Z',
  octagon: 'M29,0 L71,0 L100,29 L100,71 L71,100 L29,100 L0,71 L0,29 Z',
  // Stars
  star4: 'M50,0 L62,38 L100,50 L62,62 L50,100 L38,62 L0,50 L38,38 Z',
  star5: 'M50,0 L61,35 L98,35 L68,57 L79,91 L50,70 L21,91 L32,57 L2,35 L39,35 Z',
  star6: 'M50,0 L63,25 L100,25 L75,50 L100,75 L63,75 L50,100 L37,75 L0,75 L25,50 L0,25 L37,25 Z',
  // Arrows
  rightArrow: 'M0,25 L65,25 L65,0 L100,50 L65,100 L65,75 L0,75 Z',
  leftArrow: 'M100,25 L35,25 L35,0 L0,50 L35,100 L35,75 L100,75 Z',
  upArrow: 'M25,100 L25,35 L0,35 L50,0 L100,35 L75,35 L75,100 Z',
  downArrow: 'M25,0 L25,65 L0,65 L50,100 L100,65 L75,65 L75,0 Z',
  leftRightArrow: 'M0,50 L20,20 L20,35 L80,35 L80,20 L100,50 L80,80 L80,65 L20,65 L20,80 Z',
  upDownArrow: 'M50,0 L80,20 L65,20 L65,80 L80,80 L50,100 L20,80 L35,80 L35,20 L20,20 Z',
  notchedRightArrow: 'M0,25 L65,25 L65,0 L100,50 L65,100 L65,75 L0,75 L15,50 Z',
  bentArrow: 'M0,50 L50,0 L50,25 L100,25 L100,100 L75,100 L75,50 L50,50 Z',
  stripedRightArrow: 'M0,30 L5,30 L5,70 L0,70 Z M8,30 L13,30 L13,70 L8,70 Z M17,30 L65,30 L65,0 L100,50 L65,100 L65,70 L17,70 Z',
  chevron: 'M0,0 L75,0 L100,50 L75,100 L0,100 L25,50 Z',
  homePlate: 'M0,0 L80,0 L100,50 L80,100 L0,100 Z',
  // Callouts & speech
  wedgeRoundRectCallout: 'M5,0 L95,0 Q100,0 100,5 L100,65 Q100,70 95,70 L55,70 L50,100 L45,70 L5,70 Q0,70 0,65 L0,5 Q0,0 5,0 Z',
  wedgeRectCallout: 'M0,0 L100,0 L100,70 L55,70 L50,100 L45,70 L0,70 Z',
  wedgeEllipseCallout: 'M50,0 A50,35 0 1,1 50,70 A50,35 0 1,1 50,0 Z M45,70 L50,100 L55,70',
  cloudCallout: 'M25,10 Q10,0 10,15 Q0,15 5,25 Q0,35 10,40 Q5,55 20,55 Q20,65 35,60 Q45,70 55,60 Q70,65 75,55 Q90,55 90,40 Q100,35 90,25 Q95,10 80,10 Q75,0 60,5 Q45,-5 35,5 Q30,5 25,10 Z M30,60 Q25,70 30,75 M25,75 Q22,82 28,88 M22,88 L20,95',
  // Banners & ribbons
  ribbon2: 'M0,15 L10,15 L10,0 L90,0 L90,15 L100,15 L100,70 L90,55 L90,100 L10,100 L10,55 L0,70 Z',
  // Process & flow
  flowChartProcess: 'M0,0 L100,0 L100,100 L0,100 Z',
  flowChartDecision: 'M50,0 L100,50 L50,100 L0,50 Z',
  flowChartTerminator: 'M20,0 L80,0 Q100,0 100,50 Q100,100 80,100 L20,100 Q0,100 0,50 Q0,0 20,0 Z',
  flowChartPredefinedProcess: 'M0,0 L100,0 L100,100 L0,100 Z M10,0 L10,100 M90,0 L90,100',
  flowChartDocument: 'M0,0 L100,0 L100,80 Q75,100 50,80 Q25,60 0,80 Z',
  flowChartManualInput: 'M0,20 L100,0 L100,100 L0,100 Z',
  flowChartManualOperation: 'M0,0 L100,0 L85,100 L15,100 Z',
  flowChartConnector: 'M50,0 A50,50 0 1,1 50,100 A50,50 0 1,1 50,0 Z',
  flowChartAlternateProcess: 'M10,0 L90,0 Q100,0 100,10 L100,90 Q100,100 90,100 L10,100 Q0,100 0,90 L0,10 Q0,0 10,0 Z',
  // Misc
  heart: 'M50,30 Q50,0 25,0 Q0,0 0,25 Q0,50 50,100 Q100,50 100,25 Q100,0 75,0 Q50,0 50,30 Z',
  lightningBolt: 'M40,0 L60,35 L50,35 L80,60 L55,60 L100,100 L30,55 L45,55 L10,30 L30,30 L0,0 Z',
  sun: 'M50,25 A25,25 0 1,1 50,75 A25,25 0 1,1 50,25 Z M50,0 L50,15 M50,85 L50,100 M0,50 L15,50 M85,50 L100,50 M15,15 L25,25 M75,75 L85,85 M85,15 L75,25 M25,75 L15,85',
  cloud: 'M25,10 Q10,0 10,15 Q0,15 5,25 Q0,35 10,40 Q5,55 20,55 Q20,65 35,60 Q45,70 55,60 Q70,65 75,55 Q90,55 90,40 Q100,35 90,25 Q95,10 80,10 Q75,0 60,5 Q45,-5 35,5 Q30,5 25,10 Z',
  // Brackets & braces
  leftBracket: 'M30,0 Q0,0 0,50 Q0,100 30,100',
  rightBracket: 'M70,0 Q100,0 100,50 Q100,100 70,100',
  leftBrace: 'M30,0 Q15,0 15,15 L15,40 Q15,50 0,50 Q15,50 15,60 L15,85 Q15,100 30,100',
  rightBrace: 'M70,0 Q85,0 85,15 L85,40 Q85,50 100,50 Q85,50 85,60 L85,85 Q85,100 70,100',
  // Plus / cross
  mathPlus: 'M35,0 L65,0 L65,35 L100,35 L100,65 L65,65 L65,100 L35,100 L35,65 L0,65 L0,35 L35,35 Z',
  // Rounded rectangle (with more rounding than roundRect's CSS border-radius)
  snip1Rect: 'M0,0 L80,0 L100,20 L100,100 L0,100 Z',
  snip2DiagRect: 'M20,0 L80,0 L100,20 L100,100 L20,100 L0,80 Z',
  round1Rect: 'M0,0 L80,0 Q100,0 100,20 L100,100 L0,100 Z',
  round2DiagRect: 'M20,0 Q0,0 0,20 L0,100 L80,100 Q100,100 100,80 L100,0 Z',
  round2SameRect: 'M20,0 L80,0 Q100,0 100,20 L100,100 L0,100 L0,20 Q0,0 20,0 Z',
  // Corner / folded corner shapes
  corner: 'M0,0 L50,0 L50,50 L100,50 L100,100 L0,100 Z',
  foldedCorner: 'M0,0 L100,0 L100,80 L80,100 L0,100 Z M100,80 L80,80 L80,100',
  // Tabs and L-shapes
  frame: 'M0,0 L100,0 L100,100 L0,100 Z M10,10 L90,10 L90,90 L10,90 Z',
  plaque: 'M0,15 Q15,15 15,0 L85,0 Q85,15 100,15 L100,85 Q85,85 85,100 L15,100 Q15,85 0,85 Z',
  // Misc common
  donut: 'M50,0 A50,50 0 1,1 50,100 A50,50 0 1,1 50,0 Z M50,25 A25,25 0 1,0 50,75 A25,25 0 1,0 50,25 Z',
  noSmoking: 'M50,0 A50,50 0 1,1 50,100 A50,50 0 1,1 50,0 Z M15,15 L85,85 M50,15 A35,35 0 1,1 50,85 A35,35 0 1,1 50,15 Z',
  blockArc: 'M50,0 A50,50 0 1,1 50,100 A50,50 0 1,1 50,0 Z M50,20 A30,30 0 1,0 50,80 A30,30 0 1,0 50,20 Z',
  can: 'M0,15 Q0,0 50,0 Q100,0 100,15 L100,85 Q100,100 50,100 Q0,100 0,85 Z M0,15 Q0,30 50,30 Q100,30 100,15',
};
