import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PlainText } from './ChatPanel'

// 用户敲进输入框的内容不是 Markdown。这些用例锁住「原样呈现」：一旦有人把
// <PlainText> 换回 <Markdown>，配置命令和 shell 片段会被解析成标题/公式/单行段落。

const HUAWEI = `#
interface GigabitEthernet0/0/1
 port link-type trunk
 port trunk allow-pass vlan 10 20
#`

describe('用户消息按原文呈现', () => {
  it('华为配置：# 不变标题，行首缩进和换行都保留', () => {
    const { container } = render(<PlainText text={HUAWEI} />)
    expect(container.querySelector('h1')).toBeNull()
    // 逐字符相等——包括 ' port link-type trunk' 的前导空格
    expect(container.textContent).toBe(HUAWEI)
    expect(getComputedStyle(container.firstElementChild!).whiteSpace).toBe('pre-wrap')
  })

  it('shell 里的 $VAR 不被 remark-math 吃成公式', () => {
    const src = 'echo $HOME and $PATH'
    const { container } = render(<PlainText text={src} />)
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toBe(src)
  })

  it('通配符与下划线不产生 em/strong', () => {
    const src = 'ls *.log && chmod a+x my_script_name.sh'
    const { container } = render(<PlainText text={src} />)
    expect(container.querySelector('em')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toBe(src)
  })

  it('管道符不被 GFM 当表格', () => {
    const src = 'grep -r "foo" . | wc -l'
    const { container } = render(<PlainText text={src} />)
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toBe(src)
  })

  it('多行不被折叠成一行', () => {
    const src = 'line one\nline two\nline three'
    const { container } = render(<PlainText text={src} />)
    expect(container.textContent).toBe(src)
  })
})
