/**
 * 补充的 OOXML 预设几何（NID 的 `_presetGeomPaths` 未覆盖的常用形状）。
 *
 * 这不是 ported 文件——是本项目自己加的，故放在 ported/ 之外。由 shapeBuilder 与 ported 的
 * `_presetGeomPaths` 合并使用（ported 表优先，这里只补缺）。均为 0-100 网格近似，尽量用多边形/
 * 直线（置信度高），少数曲线形状为粗略近似。渲染时经 preserveAspectRatio="none" 拉伸到实际宽高。
 */
export const _presetGeomExtra: Record<string, string> = {
  // Math 运算符
  plus: 'M35,0 L65,0 L65,35 L100,35 L100,65 L65,65 L65,100 L35,100 L35,65 L0,65 L0,35 L35,35 Z',
  mathMinus: 'M0,42 L100,42 L100,58 L0,58 Z',
  mathMultiply: 'M15,3 L50,38 L85,3 L97,15 L62,50 L97,85 L85,97 L50,62 L15,97 L3,85 L38,50 L3,15 Z',
  mathEqual: 'M8,28 L92,28 L92,42 L8,42 Z M8,58 L92,58 L92,72 L8,72 Z',
  mathDivide: 'M12,45 L88,45 L88,55 L12,55 Z M44,18 A6,6 0 1,1 56,18 A6,6 0 1,1 44,18 Z M44,82 A6,6 0 1,1 56,82 A6,6 0 1,1 44,82 Z',
  mathNotEqual: 'M8,32 L92,32 L92,44 L8,44 Z M8,56 L92,56 L92,68 L8,68 Z M62,10 L78,10 L38,90 L22,90 Z',
  // Flowchart（几何形，非曲线）
  flowChartInputOutput: 'M20,0 L100,0 L80,100 L0,100 Z',
  flowChartPreparation: 'M20,0 L80,0 L100,50 L80,100 L20,100 L0,50 Z',
  flowChartInternalStorage: 'M0,0 L100,0 L100,100 L0,100 Z M12,0 L12,100 M0,15 L100,15',
  flowChartOffpageConnector: 'M0,0 L100,0 L100,70 L50,100 L0,70 Z',
  flowChartMerge: 'M0,0 L100,0 L50,100 Z',
  flowChartExtract: 'M50,0 L100,100 L0,100 Z',
  flowChartOr: 'M50,0 A50,50 0 1,1 50,100 A50,50 0 1,1 50,0 Z M50,0 L50,100 M0,50 L100,50',
  flowChartSummingJunction: 'M50,0 A50,50 0 1,1 50,100 A50,50 0 1,1 50,0 Z M15,15 L85,85 M85,15 L15,85',
  flowChartSort: 'M50,0 L100,50 L50,100 L0,50 Z M0,50 L100,50',
  flowChartCollate: 'M0,0 L100,0 L0,100 L100,100 Z',
  flowChartPunchedCard: 'M20,0 L100,0 L100,100 L0,100 L0,20 Z',
  flowChartMagneticDisk: 'M0,15 Q0,0 50,0 Q100,0 100,15 L100,85 Q100,100 50,100 Q0,100 0,85 Z M0,15 Q0,30 50,30 Q100,30 100,15',
  // 其它常用形状
  cube: 'M0,25 L25,0 L100,0 L100,75 L75,100 L0,100 Z M0,25 L75,25 L100,0 M75,25 L75,100',
  bevel: 'M0,0 L100,0 L100,100 L0,100 Z M12,12 L88,12 L88,88 L12,88 Z M0,0 L12,12 M100,0 L88,12 M100,100 L88,88 M0,100 L12,88',
  halfFrame: 'M0,0 L100,0 L82,18 L18,18 L18,82 L0,100 Z',
  diagStripe: 'M0,55 L55,0 L100,0 L0,100 Z',
  moon: 'M55,0 A50,50 0 1,0 55,100 A40,50 0 1,1 55,0 Z',
}
