import { describe, it, expect } from 'vitest'
import { renderChartSvg } from './chartRenderer'
import type { ChartShape } from '../../worker/parsers/pptx'

function chart(over: Partial<ChartShape>): ChartShape {
  return {
    type: 'chart', left: 0, top: 0, width: 400, height: 300,
    chartType: 'column', categories: ['A', 'B', 'C'],
    series: [{ name: '系列1', values: [3, 5, 2] }],
    ...over,
  }
}

describe('renderChartSvg', () => {
  it('总是产出合法 <svg>，viewBox 用实际宽高', () => {
    const svg = renderChartSvg(chart({ width: 400, height: 300 }))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 400 300"')
    expect(svg).toContain('preserveAspectRatio="none"')
  })

  it('柱形图画出矩形条 + 图例含系列名', () => {
    const svg = renderChartSvg(chart({ chartType: 'column', series: [{ name: '销量', values: [1, 2, 3] }] }))
    expect(svg).toContain('<rect')
    expect(svg).toContain('销量')
  })

  it('多系列分组:矩形条数量 = 系列数 × 分类数', () => {
    const svg = renderChartSvg(chart({
      series: [{ name: 's1', values: [1, 2, 3] }, { name: 's2', values: [4, 5, 6] }],
    }))
    // 6 个数据条(2×3)；再加图例的 2 个色块 rect + 背景 1 个 rect
    const rects = (svg.match(/<rect/g) || []).length
    expect(rects).toBeGreaterThanOrEqual(6)
  })

  it('折线图画 polyline，面积图画 polygon', () => {
    expect(renderChartSvg(chart({ chartType: 'line' }))).toContain('<polyline')
    const area = renderChartSvg(chart({ chartType: 'area' }))
    expect(area).toContain('<polygon')
    expect(area).toContain('<polyline')
  })

  it('饼图画扇形 path + 百分比标签', () => {
    const svg = renderChartSvg(chart({ chartType: 'pie', series: [{ values: [25, 25, 50] }] }))
    expect(svg).toContain('<path')
    expect(svg).toContain('%')   // 百分比标签
  })

  it('环形图有内圈(doughnut)', () => {
    const svg = renderChartSvg(chart({ chartType: 'doughnut', series: [{ values: [1, 1, 1] }] }))
    expect(svg).toContain('<path')
  })

  it('标题被渲染', () => {
    const svg = renderChartSvg(chart({ title: '季度趋势' }))
    expect(svg).toContain('季度趋势')
  })

  it('系列自定义颜色被采用', () => {
    const svg = renderChartSvg(chart({ series: [{ name: 'x', color: '#ff0000', values: [1, 2, 3] }] }))
    expect(svg).toContain('#ff0000')
  })

  it('空数据不崩(饼图 total=0)', () => {
    const svg = renderChartSvg(chart({ chartType: 'pie', series: [{ values: [0, 0] }] }))
    expect(svg).toContain('<svg')
  })

  it('HTML 特殊字符在标题/标签里被转义', () => {
    const svg = renderChartSvg(chart({ title: '<b>&"', categories: ['<x>', 'y', 'z'] }))
    expect(svg).toContain('&lt;b&gt;&amp;&quot;')
    expect(svg).not.toContain('<b>')
  })
})
