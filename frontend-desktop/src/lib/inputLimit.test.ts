import { describe, it, expect } from 'vitest'
import { estimateTokens, checkInput, MAX_INPUT_CHARS } from './inputLimit'

describe('estimateTokens', () => {
  it('中文按 2 token/字：1 万字 ≈ 2 万 token', () => {
    const n = estimateTokens('中'.repeat(10000))
    expect(n).toBe(20000)
  })

  it('英文按约 4 字符/token', () => {
    // 8 万字符英文 ≈ 2 万 token
    const text = 'hello world '.repeat(6667) // 80004 字符
    const n = estimateTokens(text)
    expect(n).toBeGreaterThan(14000)
    expect(n).toBeLessThan(22000)
  })

  it('无意义长串（base64/哈希）按更碎的粒度惩罚', () => {
    const junk = 'a'.repeat(1000)
    const words = 'abcd '.repeat(200) // 同为 1000 个字母
    expect(estimateTokens(junk)).toBeGreaterThan(estimateTokens(words) * 1.5)
  })

  it('中英混杂等于各部分之和', () => {
    expect(estimateTokens('中文abcd')).toBe(estimateTokens('中文') + estimateTokens('abcd'))
  })

  it('emoji 计 3 token，空格不计，换行计 1', () => {
    expect(estimateTokens('😀')).toBe(3)
    expect(estimateTokens('   ')).toBe(0)
    expect(estimateTokens('\n\n')).toBe(2)
  })
})

describe('checkInput', () => {
  it('正常输入不标记超限', () => {
    const r = checkInput('你好，世界')
    expect(r.over).toBe(false)
    expect(r.text).toBe('你好，世界')
  })

  it('超限时原文保留（不截断），只标 over', () => {
    const raw = '中'.repeat(20000)
    const r = checkInput(raw)
    expect(r.over).toBe(true)
    expect(r.text).toBe(raw)          // 一个字都不能吞
    expect(r.tokens).toBe(40000)
  })

  it('中文刚好 1 万字不算超限', () => {
    const r = checkInput('中'.repeat(10000))
    expect(r.tokens).toBe(20000)
    expect(r.over).toBe(false)
  })

  it('超大乱码粘贴撞字符兜底闸，且标为超限、不卡死', () => {
    const r = checkInput('x'.repeat(500_000))
    expect(r.text.length).toBe(MAX_INPUT_CHARS)
    expect(r.over).toBe(true)
  })
})
