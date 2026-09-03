/** 骂人彩蛋 💩 弹幕：一次辱骂只扔一次，切视图 / 重挂不该重复扔。
 *
 * 现场：ChatPanel 的新建会话页与会话区是两个互斥分支、各挂一个 <PoopRain>。骂完发出
 * query → 切到会话区 → 那边的 PoopRain 首次挂载时 `trigger` 已 >0，旧代码只挡
 * `trigger==0`，于是又放一波；下次切回新建会话页同理。用户骂一次被扔了三次。
 *
 * 修复：只在 trigger **真正递增**时放。这里钉三条：挂载即非 0 不放、递增才放、不变不重放。
 */
import { render } from '@testing-library/react'
import { describe, it, expect, beforeAll } from 'vitest'
import { PoopRain } from './PoopRain'

// jsdom 没有 matchMedia；组件用 `?.` 兜底，但显式给一个"不减弱动画"的实现更贴近真机。
beforeAll(() => {
  if (!window.matchMedia) {
    // @ts-expect-error 测试环境补桩
    window.matchMedia = () => ({ matches: false })
  }
})

const poops = (c: HTMLElement) => c.querySelectorAll('span').length

describe('PoopRain 只在辱骂真正发生时扔', () => {
  it('挂载时 trigger 已 >0（切视图 / 重挂）不放', () => {
    // 会话区的 PoopRain 首次挂载就带着上一次骂人留下的 trigger=3 —— 不该扔。
    const { container } = render(<PoopRain trigger={3} />)
    expect(poops(container)).toBe(0)
  })

  it('trigger 递增（又骂了一次）才放', () => {
    const { container, rerender } = render(<PoopRain trigger={1} />)
    expect(poops(container)).toBe(0)          // 挂载不放
    rerender(<PoopRain trigger={2} />)
    expect(poops(container)).toBeGreaterThan(0)  // 递增才放
  })

  it('trigger 不变（重渲染 / 切回来）不重复放', () => {
    const { container, rerender } = render(<PoopRain trigger={1} />)
    rerender(<PoopRain trigger={2} />)
    const n = poops(container)
    rerender(<PoopRain trigger={2} />)        // 值没变
    expect(poops(container)).toBe(n)          // 不新增
  })
})
