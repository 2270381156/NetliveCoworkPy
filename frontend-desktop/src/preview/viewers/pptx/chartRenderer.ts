/**
 * 原生 PPTX 图表 → SVG。自研轻量渲染器,覆盖常见类型:柱形(column)/条形(bar)/折线(line)/
 * 面积(area)/饼(pie)/环(doughnut)/雷达(radar)。不追求 Office 像素级一致,只求把图表画回来、可读:
 * 采用 chart XML 里的系列色 / 每点色(dPt) / 数值标签(dLbls) / 分类顺序。
 *
 * 关键:SVG 的 viewBox 用形状实际宽高(W×H),preserveAspectRatio="none" 缩放时 x/y 同比例
 * (渲染盒宽高比 == W:H),故文字/圆不失真。坐标即以 px 为单位。
 */
import type { ChartShape, ChartSeries } from '../../worker/parsers/pptx'

const PALETTE = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300']
const AXIS = '#d9d9d9'
const TEXT = '#595959'

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}
// 估算文本宽度(CJK 全宽 ~1em、其余 ~0.55em)——图例/边距布局用。
function textW(s: string, fs: number): number {
  let w = 0
  for (const ch of s) { w += (ch.charCodeAt(0) >= 0x2e80 ? 1.0 : 0.55) * fs }
  return w
}
function seriesColor(s: ChartSeries, i: number): string { return s.color || PALETTE[i % PALETTE.length] }

export function renderChartSvg(shape: ChartShape): string {
  const W = Math.max(1, shape.width)
  const H = Math.max(1, shape.height)
  const f = Math.max(7, Math.min(W, H) * 0.032)   // 基准字号
  const pad = f

  const titleH = shape.title ? f * 1.8 : 0
  const isPie = shape.chartType === 'pie' || shape.chartType === 'doughnut'
  const ptColors = shape.series[0]?.pointColors
  const legendItems = isPie
    ? shape.categories.map((c, i) => ({ label: c || String(i + 1), color: ptColors?.[i] || PALETTE[i % PALETTE.length] }))
    : shape.series.map((s, i) => ({ label: s.name || `系列${i + 1}`, color: seriesColor(s, i) }))
  const legendH = legendItems.length ? f * 1.7 : 0

  let body = ''
  if (shape.title) {
    body += `<text x="${(W / 2).toFixed(1)}" y="${(f * 1.25).toFixed(1)}" text-anchor="middle" font-size="${(f * 1.15).toFixed(1)}" font-weight="bold" fill="#333">${esc(shape.title)}</text>`
  }
  // 图例(底部,水平排列,按估算宽度排布 → 不重叠)
  if (legendItems.length) {
    const ly = H - legendH / 2
    const gap = f * 0.6
    const sw = f * 0.9
    const widths = legendItems.map((it) => sw + gap * 0.5 + textW(it.label, f * 0.9) + gap)
    const total = widths.reduce((a, b) => a + b, 0)
    let lx = Math.max(pad, (W - total) / 2)
    for (let i = 0; i < legendItems.length; i++) {
      const it = legendItems[i]
      body += `<rect x="${lx.toFixed(1)}" y="${(ly - sw / 2).toFixed(1)}" width="${sw.toFixed(1)}" height="${sw.toFixed(1)}" fill="${it.color}"/>`
      body += `<text x="${(lx + sw + gap * 0.5).toFixed(1)}" y="${(ly + f * 0.32).toFixed(1)}" font-size="${(f * 0.9).toFixed(1)}" fill="${TEXT}">${esc(it.label)}</text>`
      lx += widths[i]
    }
  }

  if (isPie) body += _pie(shape, W, titleH, H - legendH, f, ptColors)
  else if (shape.chartType === 'radar') body += _radar(shape, W, H, titleH, legendH, f)
  else if (shape.chartType === 'scatter') body += _scatter(shape, W, H, titleH, legendH, f)
  else body += _cartesian(shape, W, H, titleH, legendH, f)

  return `<svg class="ipm-chart" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" preserveAspectRatio="none" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">`
    + `<rect x="0" y="0" width="${W.toFixed(0)}" height="${H.toFixed(0)}" fill="#ffffff"/>${body}</svg>`
}

function _pie(shape: ChartShape, W: number, top: number, bottom: number, f: number, ptColors?: (string | undefined)[]): string {
  const vals = (shape.series[0]?.values ?? []).map((v) => Math.max(0, v))
  const total = vals.reduce((a, b) => a + b, 0)
  if (total <= 0) return ''
  const cx = W / 2
  const cy = (top + bottom) / 2
  const r = Math.min(W, bottom - top) / 2 * 0.86
  const inner = shape.chartType === 'doughnut' ? r * 0.55 : 0
  let a0 = -Math.PI / 2
  let out = ''
  for (let i = 0; i < vals.length; i++) {
    const frac = vals[i] / total
    const a1 = a0 + frac * Math.PI * 2
    const large = frac > 0.5 ? 1 : 0
    const color = ptColors?.[i] || PALETTE[i % PALETTE.length]
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0)
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1)
    if (inner > 0) {
      const ix0 = cx + inner * Math.cos(a0), iy0 = cy + inner * Math.sin(a0)
      const ix1 = cx + inner * Math.cos(a1), iy1 = cy + inner * Math.sin(a1)
      out += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${ix1.toFixed(1)},${iy1.toFixed(1)} A${inner.toFixed(1)},${inner.toFixed(1)} 0 ${large} 0 ${ix0.toFixed(1)},${iy0.toFixed(1)} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`
    } else {
      out += `<path d="M${cx.toFixed(1)},${cy.toFixed(1)} L${x0.toFixed(1)},${y0.toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`
    }
    if (frac > 0.04) {
      const am = (a0 + a1) / 2
      const lr = inner > 0 ? (r + inner) / 2 : r * 0.62
      const label = shape.showValues ? fmt(vals[i]) : (frac * 100).toFixed(0) + '%'
      out += `<text x="${(cx + lr * Math.cos(am)).toFixed(1)}" y="${(cy + lr * Math.sin(am) + f * 0.32).toFixed(1)}" text-anchor="middle" font-size="${(f * 0.82).toFixed(1)}" fill="#fff">${label}</text>`
    }
    a0 = a1
  }
  return out
}

function _radar(shape: ChartShape, W: number, H: number, titleH: number, legendH: number, f: number): string {
  const cats = shape.categories
  const n = Math.max(3, cats.length)
  let dMax = 0
  for (const s of shape.series) for (const v of s.values) { if (v > dMax) dMax = v }
  if (dMax <= 0) dMax = 1
  const cx = W / 2
  const top = titleH + f * 0.5
  const bottom = H - legendH - f * 0.5
  const cy = (top + bottom) / 2
  const R = Math.min(W, bottom - top) / 2 * 0.78
  const ang = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2
  let out = ''
  // 网格(同心多边形)+ 轴线
  for (let g = 1; g <= 4; g++) {
    const rr = (R * g) / 4
    const pts: string[] = []
    for (let i = 0; i < n; i++) pts.push(`${(cx + rr * Math.cos(ang(i))).toFixed(1)},${(cy + rr * Math.sin(ang(i))).toFixed(1)}`)
    out += `<polygon points="${pts.join(' ')}" fill="none" stroke="${AXIS}" stroke-width="0.5"/>`
  }
  for (let i = 0; i < n; i++) {
    const ex = cx + R * Math.cos(ang(i)), ey = cy + R * Math.sin(ang(i))
    out += `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${AXIS}" stroke-width="0.5"/>`
    const lx = cx + (R + f * 0.8) * Math.cos(ang(i)), ly = cy + (R + f * 0.8) * Math.sin(ang(i))
    const anchor = Math.abs(Math.cos(ang(i))) < 0.3 ? 'middle' : (Math.cos(ang(i)) > 0 ? 'start' : 'end')
    out += `<text x="${lx.toFixed(1)}" y="${(ly + f * 0.3).toFixed(1)}" text-anchor="${anchor}" font-size="${(f * 0.78).toFixed(1)}" fill="${TEXT}">${esc(cats[i] ?? String(i + 1))}</text>`
  }
  // 系列多边形
  for (let s = 0; s < shape.series.length; s++) {
    const ser = shape.series[s]
    const color = seriesColor(ser, s)
    const pts: string[] = []
    for (let i = 0; i < n; i++) {
      const rr = (Math.max(0, ser.values[i] ?? 0) / dMax) * R
      pts.push(`${(cx + rr * Math.cos(ang(i))).toFixed(1)},${(cy + rr * Math.sin(ang(i))).toFixed(1)}`)
    }
    out += `<polygon points="${pts.join(' ')}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="${Math.max(1, f * 0.16).toFixed(1)}"/>`
  }
  return out
}

// 散点图/气泡图:按 (x,y) 数值定位点;气泡按 bubbleSize 定半径。
function _scatter(shape: ChartShape, W: number, H: number, titleH: number, legendH: number, f: number): string {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, sizeMax = 0
  for (const s of shape.series) {
    const xs = s.xValues ?? s.values.map((_, i) => i + 1)
    for (let i = 0; i < s.values.length; i++) {
      const x = xs[i] ?? i + 1, y = s.values[i]
      if (x < xMin) xMin = x; if (x > xMax) xMax = x
      if (y < yMin) yMin = y; if (y > yMax) yMax = y
    }
    for (const v of s.sizes ?? []) if (v > sizeMax) sizeMax = v
  }
  if (!isFinite(xMin)) return ''
  if (xMin === xMax) { xMin -= 1; xMax += 1 }
  if (yMin === yMax) { yMin -= 1; yMax += 1 }
  // 轴留白:点不贴坐标轴边缘(Office 也有留白),否则 x=min/max 的点压在轴上 → 看着"位置不对"。
  const xPad = (xMax - xMin) * 0.08, yPad = (yMax - yMin) * 0.08
  xMin -= xPad; xMax += xPad; yMin -= yPad; yMax += yPad
  const xr = xMax - xMin, yr = yMax - yMin
  const ticks = 4
  const yLabels = Array.from({ length: ticks + 1 }, (_, t) => fmt(yMin + (yr * t) / ticks))
  const leftMargin = Math.max(...yLabels.map((s) => textW(s, f * 0.78)), f) + f * 0.7
  const px0 = leftMargin, px1 = W - f * 1.5
  const py0 = titleH + f * 0.6, py1 = H - legendH - f * 1.4
  const pw = Math.max(1, px1 - px0), ph = Math.max(1, py1 - py0)
  const mapX = (x: number) => px0 + ((x - xMin) / xr) * pw
  const mapY = (y: number) => py1 - ((y - yMin) / yr) * ph
  let out = ''
  // 网格 + 轴刻度
  for (let t = 0; t <= ticks; t++) {
    const yv = yMin + (yr * t) / ticks, y = mapY(yv)
    out += `<line x1="${px0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${px1.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${AXIS}" stroke-width="0.5"/>`
    out += `<text x="${(px0 - f * 0.4).toFixed(1)}" y="${(y + f * 0.28).toFixed(1)}" text-anchor="end" font-size="${(f * 0.78).toFixed(1)}" fill="${TEXT}">${fmt(yv)}</text>`
    const xv = xMin + (xr * t) / ticks, x = mapX(xv)
    out += `<line x1="${x.toFixed(1)}" y1="${py0.toFixed(1)}" x2="${x.toFixed(1)}" y2="${py1.toFixed(1)}" stroke="${AXIS}" stroke-width="0.5"/>`
    out += `<text x="${x.toFixed(1)}" y="${(py1 + f * 1).toFixed(1)}" text-anchor="middle" font-size="${(f * 0.78).toFixed(1)}" fill="${TEXT}">${fmt(xv)}</text>`
  }
  // 数据点。气泡恒为圆(按 size 定半径);散点用标记符号(显式 c:symbol,或按系列自动循环)。
  const rBase = Math.min(pw, ph) * 0.05
  for (let s = 0; s < shape.series.length; s++) {
    const ser = shape.series[s]
    const color = seriesColor(ser, s)
    const xs = ser.xValues ?? ser.values.map((_, i) => i + 1)
    const isBubble = !!ser.sizes
    const mk = isBubble ? 'circle' : (ser.marker || AUTO_MARKERS[s % AUTO_MARKERS.length])
    for (let i = 0; i < ser.values.length; i++) {
      const r = isBubble && sizeMax > 0 ? Math.max(f * 0.2, rBase * Math.sqrt((ser.sizes![i] ?? 0) / sizeMax)) : f * 0.32
      out += _marker(mapX(xs[i] ?? i + 1), mapY(ser.values[i]), r, mk, color, isBubble)
    }
  }
  return out
}

const AUTO_MARKERS = ['circle', 'square', 'triangle', 'diamond', 'x', 'plus', 'star']
// 散点/气泡标记形状 → SVG。filled=气泡(半透明+描边)。
function _marker(cx: number, cy: number, r: number, shape: string, color: string, filled: boolean): string {
  const s = (v: number) => v.toFixed(1)
  const op = filled ? '0.55' : '0.9'
  const poly = (pts: string) => `<polygon points="${pts}" fill="${color}" fill-opacity="${op}"/>`
  const stroke = (d: string) => `<path d="${d}" stroke="${color}" stroke-width="${s(Math.max(0.6, r * 0.5))}" fill="none"/>`
  switch (shape) {
    case 'none': return ''
    case 'square': return `<rect x="${s(cx - r)}" y="${s(cy - r)}" width="${s(r * 2)}" height="${s(r * 2)}" fill="${color}" fill-opacity="${op}"/>`
    case 'diamond': return poly(`${s(cx)},${s(cy - r)} ${s(cx + r)},${s(cy)} ${s(cx)},${s(cy + r)} ${s(cx - r)},${s(cy)}`)
    case 'triangle': return poly(`${s(cx)},${s(cy - r)} ${s(cx + r)},${s(cy + r)} ${s(cx - r)},${s(cy + r)}`)
    case 'x': return stroke(`M${s(cx - r)},${s(cy - r)} L${s(cx + r)},${s(cy + r)} M${s(cx + r)},${s(cy - r)} L${s(cx - r)},${s(cy + r)}`)
    case 'plus': return stroke(`M${s(cx)},${s(cy - r)} L${s(cx)},${s(cy + r)} M${s(cx - r)},${s(cy)} L${s(cx + r)},${s(cy)}`)
    case 'dash': return `<rect x="${s(cx - r)}" y="${s(cy - r * 0.28)}" width="${s(r * 2)}" height="${s(r * 0.56)}" fill="${color}"/>`
    case 'dot': return `<circle cx="${s(cx)}" cy="${s(cy)}" r="${s(r * 0.5)}" fill="${color}"/>`
    case 'star': {
      const p: string[] = []
      for (let k = 0; k < 10; k++) { const rad = k % 2 ? r * 0.5 : r; const a = -Math.PI / 2 + (k * Math.PI) / 5; p.push(`${s(cx + rad * Math.cos(a))},${s(cy + rad * Math.sin(a))}`) }
      return poly(p.join(' '))
    }
    default: return `<circle cx="${s(cx)}" cy="${s(cy)}" r="${s(r)}" fill="${color}" fill-opacity="${op}"${filled ? ` stroke="${color}" stroke-width="0.5"` : ''}/>`
  }
}

function _cartesian(shape: ChartShape, W: number, H: number, titleH: number, legendH: number, f: number): string {
  const horiz = shape.chartType === 'bar'
  // 水平条形图:Office 默认首类在底部 → 反转分类顺序绘制。
  const cats = horiz ? [...shape.categories].reverse() : shape.categories
  const series = horiz ? shape.series.map((s) => ({ ...s, values: [...s.values].reverse() })) : shape.series
  const nCat = Math.max(1, cats.length)
  const nSer = series.length
  const isLine = shape.chartType === 'line' || shape.chartType === 'area'
  let dMax = 0, dMin = 0
  for (const s of series) for (const v of s.values) { if (v > dMax) dMax = v; if (v < dMin) dMin = v }
  if (dMax === 0 && dMin === 0) dMax = 1
  const range = dMax - dMin || 1

  const ticks = 4
  // 左边距:column/line/area 放数值标签、bar 放分类标签 → 按最长标签估算,避免被裁。
  const leftLabels = horiz ? cats.map((c) => String(c)) : Array.from({ length: ticks + 1 }, (_, t) => fmt(dMin + (range * t) / ticks))
  const leftMargin = Math.min(W * 0.38, Math.max(...leftLabels.map((s) => textW(s, f * 0.8)), f) + f * 0.7)
  const px0 = leftMargin
  const px1 = W - f * 1.5
  const py0 = titleH + f * 0.6
  const py1 = H - legendH - (horiz ? f * 0.4 : f * 1.4)
  const pw = Math.max(1, px1 - px0)
  const ph = Math.max(1, py1 - py0)
  let out = ''

  const mapVX = (v: number) => px0 + ((v - dMin) / range) * pw
  const mapVY = (v: number) => py1 - ((v - dMin) / range) * ph

  // 网格 + 值刻度
  for (let t = 0; t <= ticks; t++) {
    const v = dMin + (range * t) / ticks
    if (horiz) {
      const x = mapVX(v)
      out += `<line x1="${x.toFixed(1)}" y1="${py0.toFixed(1)}" x2="${x.toFixed(1)}" y2="${py1.toFixed(1)}" stroke="${AXIS}" stroke-width="0.5"/>`
      out += `<text x="${x.toFixed(1)}" y="${(py1 + f * 1).toFixed(1)}" text-anchor="middle" font-size="${(f * 0.78).toFixed(1)}" fill="${TEXT}">${fmt(v)}</text>`
    } else {
      const y = mapVY(v)
      out += `<line x1="${px0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${px1.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${AXIS}" stroke-width="0.5"/>`
      out += `<text x="${(px0 - f * 0.4).toFixed(1)}" y="${(y + f * 0.28).toFixed(1)}" text-anchor="end" font-size="${(f * 0.78).toFixed(1)}" fill="${TEXT}">${fmt(v)}</text>`
    }
  }

  const band = (horiz ? ph : pw) / nCat
  const barSize = (band * 0.8) / Math.max(1, isLine ? 1 : nSer)

  // 分类标签
  for (let i = 0; i < nCat; i++) {
    const label = esc(String(cats[i] ?? i + 1))
    if (horiz) {
      const y = py0 + band * (i + 0.5)
      out += `<text x="${(px0 - f * 0.4).toFixed(1)}" y="${(y + f * 0.28).toFixed(1)}" text-anchor="end" font-size="${(f * 0.78).toFixed(1)}" fill="${TEXT}">${label}</text>`
    } else if (nCat <= 24) {
      const x = px0 + band * (i + 0.5)
      out += `<text x="${x.toFixed(1)}" y="${(py1 + f * 1.05).toFixed(1)}" text-anchor="middle" font-size="${(f * 0.78).toFixed(1)}" fill="${TEXT}">${label}</text>`
    }
  }

  const showVal = !!shape.showValues
  if (isLine) {
    for (let s = 0; s < nSer; s++) {
      const ser = series[s]
      const color = seriesColor(ser, s)
      const pts: string[] = []
      for (let i = 0; i < ser.values.length; i++) pts.push(`${(px0 + band * (i + 0.5)).toFixed(1)},${mapVY(ser.values[i]).toFixed(1)}`)
      if (shape.chartType === 'area') {
        const base = mapVY(Math.max(0, dMin))
        out += `<polygon points="${(px0 + band * 0.5).toFixed(1)},${base.toFixed(1)} ${pts.join(' ')} ${(px0 + band * (ser.values.length - 0.5)).toFixed(1)},${base.toFixed(1)}" fill="${color}" fill-opacity="0.3"/>`
      }
      out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${Math.max(1, f * 0.2).toFixed(1)}"/>`
      for (let i = 0; i < ser.values.length; i++) {
        out += `<circle cx="${(px0 + band * (i + 0.5)).toFixed(1)}" cy="${mapVY(ser.values[i]).toFixed(1)}" r="${(f * 0.22).toFixed(1)}" fill="${color}"/>`
        if (showVal) out += `<text x="${(px0 + band * (i + 0.5)).toFixed(1)}" y="${(mapVY(ser.values[i]) - f * 0.5).toFixed(1)}" text-anchor="middle" font-size="${(f * 0.72).toFixed(1)}" fill="${TEXT}">${fmt(ser.values[i])}</text>`
      }
    }
  } else {
    for (let i = 0; i < nCat; i++) {
      for (let s = 0; s < nSer; s++) {
        const v = series[s].values[i]
        if (v === undefined) continue
        const ser = series[s]
        const color = ser.pointColors?.[horiz ? nCat - 1 - i : i] || seriesColor(ser, s)
        const off = band * 0.1 + s * barSize
        if (horiz) {
          const y = py0 + band * i + off
          const x = Math.min(mapVX(v), mapVX(0)), x2 = Math.max(mapVX(v), mapVX(0))
          out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.5, x2 - x).toFixed(1)}" height="${(barSize * 0.9).toFixed(1)}" fill="${color}"/>`
          if (showVal) out += `<text x="${(x2 + f * 0.25).toFixed(1)}" y="${(y + barSize * 0.6).toFixed(1)}" font-size="${(f * 0.72).toFixed(1)}" fill="${TEXT}">${fmt(v)}</text>`
        } else {
          const x = px0 + band * i + off
          const yTop = Math.min(mapVY(v), mapVY(0)), yBot = Math.max(mapVY(v), mapVY(0))
          out += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${(barSize * 0.9).toFixed(1)}" height="${Math.max(0.5, yBot - yTop).toFixed(1)}" fill="${color}"/>`
          if (showVal) out += `<text x="${(x + barSize * 0.45).toFixed(1)}" y="${(yTop - f * 0.3).toFixed(1)}" text-anchor="middle" font-size="${(f * 0.72).toFixed(1)}" fill="${TEXT}">${fmt(v)}</text>`
        }
      }
    }
  }
  // 零基线
  if (horiz) out += `<line x1="${mapVX(Math.max(0, dMin)).toFixed(1)}" y1="${py0.toFixed(1)}" x2="${mapVX(Math.max(0, dMin)).toFixed(1)}" y2="${py1.toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>`
  else out += `<line x1="${px0.toFixed(1)}" y1="${mapVY(Math.max(0, dMin)).toFixed(1)}" x2="${px1.toFixed(1)}" y2="${mapVY(Math.max(0, dMin)).toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>`
  return out
}
