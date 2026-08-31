import { describe, it, expect } from 'vitest'
import { getExt, fileType, CODE_LANGS } from './fileType'

describe('getExt', () => {
  it('lowercases and strips path', () => {
    expect(getExt('C:/x/Report.PDF')).toBe('pdf')
    expect(getExt('a/b/c.tar.gz')).toBe('gz')
    expect(getExt('noext')).toBe('')
  })
})

describe('fileType', () => {
  it('classifies known types', () => {
    expect(fileType('png')).toBe('image')
    expect(fileType('md')).toBe('markdown')
    expect(fileType('docx')).toBe('docx')
    expect(fileType('xlsx')).toBe('excel')
    expect(fileType('csv')).toBe('excel')
    expect(fileType('py')).toBe('code')
    expect(fileType('txt')).toBe('text')
    expect(fileType('pdf')).toBe('pdf')
    expect(fileType('pptx')).toBe('pptx')
    expect(fileType('bin')).toBe('binary')
  })
  it('maps code extensions to highlight.js language ids', () => {
    expect(CODE_LANGS['py']).toBe('python')
    expect(CODE_LANGS['rs']).toBe('rust')
  })
})
