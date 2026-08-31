import { describe, test, expect, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

// cowork 的小标记：只显示套件自带的 logo，没有就什么都不显示。
//
// 最要紧的是**没 logo 时不能把行挤歪**：同一份列表里有的 cowork 带 logo、有的不带，
// 空位没了这两种行的文字就左右错开，而这种错位没人会当成 bug 报上来。

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k, lang: 'zh', setLang: () => {} }) }))
vi.mock('@/agents/lineup', () => ({
  canStartSession: () => true,
  useLineupState: () => 'ready',
}))
vi.mock('@/api/coworks', () => ({ refreshCoworks: async () => {} }))

import { AgentMark } from './AgentHome'

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'ipmaster', displayName: 'IPMaster Cowork', subtitle: '', accent: '#3b82f6', ...over,
} as never)

describe('AgentMark', () => {
  test('没有 logo → 什么都不显示', () => {
    const { container } = render(<AgentMark agent={agent()} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('')
  })

  test('没有 logo 时连空位都不占，不把后面的文字推出去', () => {
    // 留个透明方块看着像对齐错了——尤其新建会话弹窗的标题，会被顶开一截。
    expect(render(<AgentMark agent={agent()} size={20} />).container.firstElementChild).toBeNull()
  })

  test('有 logo → 显示图', () => {
    const { container } = render(<AgentMark agent={agent({ logoUrl: '/api/v1/coworks/ipmaster/logo' })} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/v1/coworks/ipmaster/logo')
  })

  test('图加载失败 → 同样什么都不显示，不留半张破图', () => {
    const { container } = render(<AgentMark agent={agent({ logoUrl: '/broken.svg' })} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('')
  })

  // ── fallback="letter"：只有新建会话弹窗用它 ──────────────────────────────

  test('要首字母时，没有 logo → 显示首字母方块', () => {
    const { container } = render(<AgentMark agent={agent()} fallback="letter" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('I')
  })

  test('要首字母时，图加载失败也回落到首字母，不留空白', () => {
    // 弹窗标题左边就这一个图形，破图或空白都会让标题看着缺一块。
    const { container } = render(<AgentMark agent={agent({ logoUrl: '/broken.svg' })} fallback="letter" />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.textContent).toBe('I')
  })

  test('首字母取第一个字母数字，不是第一个字符', () => {
    // 「中文名 Cowork」这种取到的是引号或汉字，方块里塞汉字会挤出去。
    expect(render(<AgentMark agent={agent({ displayName: '「MBB」Cowork' })} fallback="letter" />)
      .container.textContent).toBe('M')
  })

  test('连一个字母数字都没有时退回首字符，而不是空白', () => {
    expect(render(<AgentMark agent={agent({ displayName: '核心网' })} fallback="letter" />)
      .container.textContent).toBe('核')
  })

  test('换了 agent 之后重置失败标记', () => {
    // 上一个的 logo 挂了，不该连累下一个也不显示。
    const { container, rerender } = render(<AgentMark agent={agent({ logoUrl: '/broken.svg' })} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()

    rerender(<AgentMark agent={agent({ id: 'mbb', displayName: 'MBB', logoUrl: '/other.svg' })} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/other.svg')
  })
})
