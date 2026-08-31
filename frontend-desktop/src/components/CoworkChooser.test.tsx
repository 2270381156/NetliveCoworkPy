import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// 归属选择器的规则很少但都不能错：错了不会报任何东西，只表现为某个 cowork 的会话里
// 多了或少了一个 skill——两个方向都很难从现象反推回这里。
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }) }))
vi.mock('@/agents/useAgents', () => ({
  useAgents: () => [
    { id: 'ipmaster', displayName: 'IPMaster Cowork', subtitle: '', accent: '#000' },
    { id: 'mbb', displayName: 'MBB Cowork', subtitle: '', accent: '#000' },
  ],
}))

import { CoworkChooser } from './SkillsPage'

const chooser = (value: string[]) => {
  const onChange = vi.fn()
  render(<CoworkChooser value={value} onChange={onChange} />)
  return onChange
}

describe('CoworkChooser', () => {
  test('勾具体的 cowork 会取消「通用」', () => {
    // 不取消的话归属成了 ["*","mbb"]，标签显示"通用 / MBB"——自相矛盾，且 `*` 已涵盖 MBB。
    const onChange = chooser(['*'])
    fireEvent.click(screen.getByText('MBB Cowork'))
    expect(onChange).toHaveBeenCalledWith(['mbb'])
  })

  test('勾「通用」会清空其余', () => {
    const onChange = chooser(['mbb', 'ipmaster'])
    fireEvent.click(screen.getByText('skills.ownerCommon'))
    expect(onChange).toHaveBeenCalledWith(['*'])
  })

  test('可以同时给几个 cowork —— 归属本来就是一组', () => {
    const onChange = chooser(['mbb'])
    fireEvent.click(screen.getByText('IPMaster Cowork'))
    expect(onChange).toHaveBeenCalledWith(['mbb', 'ipmaster'])
  })

  test('取消掉最后一个 → 回到通用，不是空', () => {
    // 空数组 = 谁都不能用 = 这条 skill 存在也没意义；后端读到空也按通用处理，两边要一致。
    const onChange = chooser(['mbb'])
    fireEvent.click(screen.getByText('MBB Cowork'))
    expect(onChange).toHaveBeenCalledWith(['*'])
  })

  test('空数组当成通用显示', () => {
    chooser([])
    expect((screen.getByText('skills.ownerCommon').querySelector('input') as HTMLInputElement).checked).toBe(true)
  })
})
