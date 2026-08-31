/**
 * remark 插件：修复 GFM autolink 在「URL 紧跟 ** 或中文、无空格」时过度吞并的问题。
 *
 * 场景：模型输出 `**https://www.bing.com**，这是…国内版本：**https://cn.bing.com**`。
 * CommonMark 的 emphasis flanking 规则遇到「中文标点 + **」不闭合（CJK 已知问题），`**`
 * 退化成普通文本；GFM autolink 随即一路吞掉 `**`、中文、第二个 URL 直到空格，拼成一个
 * 超长“URL”。结果整段被当成一个链接、点开跳错地址。
 *
 * 本插件在 mdast 上把这种被吞并的裸链接（autolink：link.children 唯一 text === link.url）
 * 重新拆成 正确URL + 文本 + 下一个URL。显式 `[text](url)` 链接与正常裸链接不受影响。
 * 副作用：残留的 `**` 会以字面量显示（本就是 CJK emphasis 的固有行为，非本插件引入）。
 */

// URL 有效延续字符：遇到 空白 / * / <> / 引号 / 反引号 / 全角标点 / CJK 即停止。
const URL_HEAD = /https?:\/\/[^\s*<>"'`，。：；！？、…（）【】「」『』""'']+/
const TRAILING_PUNCT = /[.,;:!?、，。）)]+$/

function cleanUrl(u: string): string {
  const m = URL_HEAD.exec(u)
  if (!m) return ''
  return m[0].replace(TRAILING_PUNCT, '')
}

/** 把一段可能夹着多个 URL 的原始字符串拆成 text / link 交替的节点。 */
function splitRaw(value: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let rest = value
  while (rest) {
    const idx = rest.search(/https?:\/\//)
    if (idx < 0) { out.push({ type: 'text', value: rest }); break }
    if (idx > 0) out.push({ type: 'text', value: rest.slice(0, idx) })
    const url = cleanUrl(rest.slice(idx))
    if (!url) { out.push({ type: 'text', value: rest.slice(idx) }); break }
    out.push({ type: 'link', url, title: null, children: [{ type: 'text', value: url }] })
    rest = rest.slice(idx + url.length)
  }
  return out
}

// GFM autolink 既不认 file://，也不认 Windows 盘符裸路径（D:\a\b.html / D:/a/b.html）。这里把文本里
// 的两类本地文件链接切成 link 节点：
//   · file:// URL —— 直接成链，url 原样；
//   · Windows 盘符路径 —— 显示保留原始路径（含反斜杠/中文），但 url 归一为 file:///D:/a/b.html，以通过
//     <Markdown> 的 urlTransform 白名单与 a 渲染器的 file:// 分流，最终在右侧预览 tab 打开。
// 路径可含中文，只到空白/闭合括号/引号为止，再修掉尾随标点。Windows 路径守卫：盘符前非字母（排除 http 里
// 的 p://）、盘符后是单个 \ 或 /（(?!/) 排除 :// 协议）、必须带扩展名（避免把普通路径样文本都成链）。
// 已知局限：段名以 ASCII 标点开头的反斜杠路径（如 D:\_x\a.html）会被 markdown 转义吞掉分隔符，属已损坏
// 文本，本插件不保证正确——此类路径建议由模型用反引号或 file:// 输出。
const LOCAL_LINK = /file:\/\/\/?[^\s)】」』"'<>）]+|(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)[^\s"'<>)）】」』]*\.[A-Za-z0-9]{1,8}/g
// 非全局版，仅供 walk 里 test（避免 /g 的 lastIndex 状态干扰）。
const HAS_LOCAL_LINK = /file:\/\/|(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)[^\s]*\.[A-Za-z0-9]/
const FILE_TRAILING = /[.,;:!?、，。；）)】」』]+$/

// 裸 Windows 路径 → file:/// 形式 href（反斜杠转正斜杠）；file:// 原样。
function toFileHref(raw: string): string {
  return /^file:\/\//i.test(raw) ? raw : 'file:///' + raw.replace(/\\/g, '/')
}

function splitLocalLinks(value: string): Array<Record<string, unknown>> | null {
  LOCAL_LINK.lastIndex = 0
  if (!LOCAL_LINK.test(value)) return null
  LOCAL_LINK.lastIndex = 0
  const out: Array<Record<string, unknown>> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = LOCAL_LINK.exec(value))) {
    const raw = m[0].replace(FILE_TRAILING, '')
    if (!raw) continue
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    // 显示用原始路径(raw)，href 用归一后的 file:/// 形式。
    out.push({ type: 'link', url: toFileHref(raw), title: null, children: [{ type: 'text', value: raw }] })
    last = m.index + raw.length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out.length ? out : null
}

function isAutolink(node: Record<string, unknown>): boolean {
  const children = node.children as Array<Record<string, unknown>> | undefined
  return node.type === 'link'
    && Array.isArray(children) && children.length === 1
    && children[0].type === 'text'
    && children[0].value === node.url
}

// 含空白/`*`/引号/CJK（含全角标点），或不止一个 `://` → 判定被过度吞并。
function overConsumed(url: string): boolean {
  if (/[\s*<>"'`一-鿿　-〿＀-￯]/.test(url)) return true
  return (url.match(/:\/\//g)?.length ?? 0) > 1
}

function walk(node: Record<string, unknown>): void {
  const children = node.children as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(children)) return
  const next: Array<Record<string, unknown>> = []
  for (const child of children) {
    if (isAutolink(child) && overConsumed(child.url as string)) {
      next.push(...splitRaw(child.url as string))
    } else if (child.type === 'text' && typeof child.value === 'string' && HAS_LOCAL_LINK.test(child.value as string)) {
      const split = splitLocalLinks(child.value as string)
      if (split) next.push(...split)
      else next.push(child)
    } else {
      walk(child)
      next.push(child)
    }
  }
  node.children = next
}

export default function remarkFixAutolink() {
  return (tree: Record<string, unknown>) => { walk(tree) }
}
