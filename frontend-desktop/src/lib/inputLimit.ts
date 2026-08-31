/**
 * 输入框长度限制 —— 以「估算 token 数」为口径，而不是简单数字符。
 *
 * 为什么不用 maxLength：
 *   中文 1 字 ≈ 2 token，英文 1 token ≈ 4 字符，两者差 8 倍。
 *   若按字符数一刀切，中文卡太松、英文卡太死；
 *   而随机乱码（base64 / 哈希串）分词粒度更细（≈2 字符 1 token），
 *   同样长度能顶出 2 倍 token，必须单独惩罚。
 *
 * 估算规则（保守偏高，宁可少收一点也不要超模型上限）：
 *   - CJK 汉字 / 假名 / 谚文 / 全角标点        → 2 token/字
 *   - 星际平面字符（emoji 等代理对）           → 3 token/字符
 *   - 拉丁词：普通词 ceil(len/4)；
 *     超长无空格串（>15，视作乱码/base64）ceil(len/2)
 *   - 数字串 ceil(len/3)
 *   - 其他单个标点/符号                        → 1 token
 *   - 空格不计；换行计 1 token
 *
 * 上限 20000 token 对应：纯中文约 1 万字；纯英文约 8 万字符；
 * 乱码串约 4 万字符 —— 正好是需求要的那条“统一线”。
 */

export const MAX_INPUT_TOKENS = 20000

/** 兜底硬上限：防止一次粘贴几 MB 文本把 React state / 估算函数拖死。 */
export const MAX_INPUT_CHARS = 200_000

const RE_CJK = /[　-〿㐀-䶿一-鿿豈-﫿぀-ヿ가-힯＀-･]/
const RE_LATIN_WORD = /[A-Za-zÀ-ɏ]/
const RE_DIGIT = /[0-9]/

function isCJK(ch: string) { return RE_CJK.test(ch) }

/**
 * 估算文本 token 数。纯前端启发式，误差 ±20%，只用于输入限流。
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  // 普通拉丁词/数字的字符数先累计、最后统一折算，避免逐词 ceil 把短词放大 30%+
  let latinChars = 0
  let digitChars = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    const code = text.charCodeAt(i)

    // 代理对（emoji / 生僻字）：整体算 3 token
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      tokens += 3
      i += 2
      continue
    }
    if (isCJK(ch)) {
      tokens += 2
      i++
      continue
    }
    if (RE_LATIN_WORD.test(ch)) {
      let j = i
      while (j < n && RE_LATIN_WORD.test(text[j])) j++
      const len = j - i
      // 超长连续字母串 ≈ 乱码/base64/哈希，分词更碎，按 2 字符 1 token 计
      if (len > 15) tokens += Math.ceil(len / 2)
      else latinChars += len
      i = j
      continue
    }
    if (RE_DIGIT.test(ch)) {
      let j = i
      while (j < n && RE_DIGIT.test(text[j])) j++
      digitChars += j - i
      i = j
      continue
    }
    if (ch === '\n' || ch === '\r') { tokens += 1; i++; continue }
    if (ch === ' ' || ch === '\t') { i++; continue }
    // 其余标点/符号：1 个 1 token
    tokens += 1
    i++
  }
  return tokens + Math.ceil(latinChars / 4) + Math.ceil(digitChars / 3)
}

export interface InputLimitState {
  /** 落进 state 的文本：只在超过 MAX_INPUT_CHARS 兜底闸时才被砍 */
  text: string
  tokens: number
  /** 是否超过 token 上限 —— 超了就禁止发送 */
  over: boolean
}

/**
 * 输入框 onChange / onPaste 统一入口。
 *
 * 不做 token 级截断：截断会悄悄吞掉用户的字，用户既不知道丢了什么、
 * 也无从判断该删哪段。改为「照单全收 + 标红 + 禁用发送」，由用户自己删。
 * 只保留 MAX_INPUT_CHARS 这道兜底闸，防止几 MB 的粘贴卡死渲染。
 */
export function checkInput(raw: string, maxTokens = MAX_INPUT_TOKENS): InputLimitState {
  const text = raw.length > MAX_INPUT_CHARS ? raw.slice(0, MAX_INPUT_CHARS) : raw
  const tokens = estimateTokens(text)
  return { text, tokens, over: tokens > maxTokens }
}
