import { render } from '@testing-library/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { describe, it, expect } from 'vitest'

// 复刻 ChatPanel 里 <Markdown> 的插件装配,验证 ask_user 问题列表所依赖的渲染管线:
// LaTeX 数学能被 katex 渲染成 DOM(而非原样字面文本),且块级公式带横向溢出容器。
const REMARK = [remarkGfm, remarkMath]
const REHYPE = [rehypeKatex]

function renderMd(src: string) {
  return render(
    <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>{src}</Markdown>,
  )
}

describe('ask_user markdown 数学渲染', () => {
  it('行内公式 $…$ 渲染为 katex 而非字面 $', () => {
    const { container } = renderMd('其中 $n_t$ 是 topic 的条目数。')
    expect(container.querySelector('.katex')).not.toBeNull()
    // 原始字面 $n_t$ 不应残留在文本里
    expect(container.textContent).not.toContain('$n_t$')
  })

  it('单行 $$…$$ 渲染为行内 katex(remark-math 语义:非独占行=行内)', () => {
    // 用户实际粘贴的就是单行 $$…$$,它是行内 katex,靠 .msg-md 容器横向滚动兜底,而非 .katex-display
    const { container } = renderMd('$$ \\sum_{t} O(\\log n_t) $$')
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('.katex-display')).toBeNull()
    expect(container.textContent).not.toContain('$$')
  })

  it('独占多行的 $$ 块渲染为 katex-display', () => {
    const { container } = renderMd('$$\n\\sum_{t} O(\\log n_t)\n$$')
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('\\underbrace 等复杂结构不抛错、产出 katex DOM', () => {
    const { container } = renderMd(
      '$$ \\underbrace{\\sum_{t} O(\\log n_t)}_{\\text{cursor 查找}} + \\epsilon \\cdot |topics| $$',
    )
    expect(container.querySelector('.katex')).not.toBeNull()
  })
})
