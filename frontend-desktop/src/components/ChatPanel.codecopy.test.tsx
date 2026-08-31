import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { LanguageProvider } from '../i18n'
import { mdComponents } from './ChatPanel'

// AI 输出里的代码/命令块，右上角要有一个复制按钮，点一下把块内原文写进剪贴板；
// 行内 code（如 `foo`）不该有复制按钮。

const HUAWEI = '```\ninterface GigabitEthernet0/0/1\n port link-type trunk\n```'

function renderMd(src: string) {
  return render(
    <LanguageProvider>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{src}</Markdown>
    </LanguageProvider>,
  )
}

describe('代码块复制按钮', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('代码块渲染出一个复制按钮', () => {
    const { container } = renderMd(HUAWEI)
    expect(container.querySelector('.code-block')).not.toBeNull()
    expect(container.querySelector('.code-copy')).not.toBeNull()
  })

  it('点击复制按钮把块内原文写入剪贴板（不含结尾换行）', () => {
    const { container } = renderMd(HUAWEI)
    const btn = container.querySelector('.code-copy') as HTMLButtonElement
    fireEvent.click(btn)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'interface GigabitEthernet0/0/1\n port link-type trunk',
    )
  })

  it('行内 code 不带复制按钮', () => {
    const { container } = renderMd('这是一段 `inline-code` 行内代码。')
    expect(container.querySelector('.code-copy')).toBeNull()
    expect(container.querySelector('code')).not.toBeNull()
  })
})
