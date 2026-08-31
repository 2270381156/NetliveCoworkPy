import * as XLSX from 'xlsx'
import type { SheetData } from '../protocol'

export interface XlsxParseOptions { csv?: boolean }

export function parseXlsx(buffer: ArrayBuffer, options: XlsxParseOptions = {}): SheetData[] {
  const isCsv = options.csv === true
  const wb = isCsv
    ? XLSX.read(new TextDecoder().decode(buffer), { type: 'string' })
    : XLSX.read(new Uint8Array(buffer), { type: 'array' })
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '', raw: false })
    return { name, rows: rows as string[][] }
  })
}
