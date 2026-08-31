import { describe, it, expect } from 'vitest'
import remarkFixAutolink from './remarkFixAutolink'

// 插件是纯 mdast 变换，直接构造节点喂给 transformer（不依赖 remark-parse——它只是
// react-markdown 的间接依赖）。GFM autolink / remark 产生的节点形状在此手工构造：
//   · 文本 → { type:'text', value }
//   · 裸 autolink → { type:'link', url, children:[{type:'text', value:url}] }（child.value===url）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any

const text = (value: string): Node => ({ type: 'text', value })
const autolink = (url: string): Node => ({ type: 'link', url, title: null, children: [{ type: 'text', value: url }] })

// 把子节点放进一个段落跑 transformer，返回变换后的子节点数组。
function run(children: Node[]): Node[] {
  const tree: Node = { type: 'root', children: [{ type: 'paragraph', children }] }
  remarkFixAutolink()(tree)
  return tree.children[0].children
}
const links = (out: Node[]): Node[] => out.filter((n) => n.type === 'link')

describe('remarkFixAutolink — 裸 Windows 路径成链', () => {
  it('反斜杠路径（含中文）成链：显示保留原始路径，href 归一为 file:///', () => {
    const out = run([text('D:\\test\\test0716\\今日新闻摘要.html')])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('link')
    expect(out[0].url).toBe('file:///D:/test/test0716/今日新闻摘要.html')
    // 显示文本仍是原始反斜杠路径。
    expect(out[0].children[0].value).toBe('D:\\test\\test0716\\今日新闻摘要.html')
  })

  it('正斜杠路径成链', () => {
    const out = run([text('D:/test/test0716/今日新闻摘要.html')])
    expect(links(out)).toHaveLength(1)
    expect(out[0].url).toBe('file:///D:/test/test0716/今日新闻摘要.html')
  })

  it('嵌在句子里：切成 文本 + 链接 + 文本', () => {
    const out = run([text('报告已生成，见 D:\\out\\日报.html 请查看。')])
    expect(out.map((n) => n.type)).toEqual(['text', 'link', 'text'])
    expect(out[1].url).toBe('file:///D:/out/日报.html')
    expect(out[1].children[0].value).toBe('D:\\out\\日报.html')
    expect(out[2].value).toBe(' 请查看。')
  })

  it('修掉尾随标点', () => {
    const out = run([text('见 D:\\a\\b.html。')])
    const l = links(out)
    expect(l).toHaveLength(1)
    expect(l[0].url).toBe('file:///D:/a/b.html')
  })
})

describe('remarkFixAutolink — file:// 仍工作', () => {
  it('裸 file:// 成链', () => {
    const out = run([text('file:///D:/a/结果.html')])
    expect(links(out)).toHaveLength(1)
    expect(out[0].url).toBe('file:///D:/a/结果.html')
  })
})

describe('remarkFixAutolink — 守卫（不误伤）', () => {
  it('http URL 文本不被当成 Windows 路径（排除 p://）', () => {
    const out = run([text('http://www.bing.com/a.html')])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('text')
  })

  it('无扩展名的路径不成链', () => {
    const out = run([text('路径 D:\\some\\folder 结束')])
    expect(links(out)).toHaveLength(0)
  })
})

describe('remarkFixAutolink — GFM autolink 过度吞并的修复', () => {
  it('URL 紧跟 ** 被吞并的超长裸链接拆回多个正确 URL', () => {
    const out = run([autolink('https://www.bing.com**x**https://cn.bing.com')])
    const l = links(out)
    expect(l.length).toBeGreaterThanOrEqual(2)
    expect(l[0].url).toBe('https://www.bing.com')
    expect(l[1].url).toBe('https://cn.bing.com')
  })

  it('正常裸链接不受影响', () => {
    const out = run([autolink('https://example.com/page')])
    expect(links(out)).toHaveLength(1)
    expect(out[0].url).toBe('https://example.com/page')
  })
})
