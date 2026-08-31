import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseXlsx } from './xlsx'

function makeWorkbookBytes(): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], ['1', '2']])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

describe('parseXlsx', () => {
  it('parses a binary workbook into sheet rows', () => {
    const sheets = parseXlsx(makeWorkbookBytes(), {})
    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBe('Sheet1')
    expect(sheets[0].rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('parses csv text via the csv option', () => {
    const csv = 'x,y\n3,4'
    const buf = new TextEncoder().encode(csv).buffer
    const sheets = parseXlsx(buf, { csv: true })
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows).toEqual([['x', 'y'], ['3', '4']])
  })
})
