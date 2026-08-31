import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { parseInWorker } from '../worker/parseClient'
import type { SheetData } from '../worker/protocol'
import { fetchOrThrow, useRawUrl, Loading, ErrorMsg } from './common'

export function ExcelViewer({ path, filename, reloadToken }: { path: string; filename: string; reloadToken?: number }) {
  const raw = useRawUrl()
  const { t } = useI18n()
  const [tables, setTables] = useState<SheetData[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)

  usePreviewToolbar({ download: { url: raw(path), filename } }, [path, filename])

  useEffect(() => {
    const ac = new AbortController()
    setTables(null); setError(null); setActiveSheet(0)
    fetchOrThrow(raw(path, reloadToken))
      .then((r) => r.arrayBuffer())
      .then((buf) => parseInWorker('xlsx', buf, { signal: ac.signal }))
      .then((sheets) => { if (!ac.signal.aborted) setTables(sheets) })
      .catch((e) => { if (e?.name !== 'AbortError') setError(String(e)) })
    return () => ac.abort()
  }, [path])

  if (error) return <ErrorMsg msg={error} />
  if (tables === null) return <Loading />
  if (tables.length === 0) return <div className="p-6 text-sm" style={{ color: 'var(--t3)' }}>{t('filePreview.empty')}</div>

  const sheet = tables[activeSheet]
  return (
    <div className="flex flex-col h-full">
      {tables.length > 1 && (
        <div className="flex gap-1 px-4 pt-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          {tables.map((tbl, i) => (
            <button
              key={tbl.name}
              onClick={() => setActiveSheet(i)}
              className="px-3 py-1.5 text-xs rounded-t transition-colors"
              style={{
                color: i === activeSheet ? 'var(--blue)' : 'var(--t2)',
                background: i === activeSheet ? 'var(--blue-dim)' : 'transparent',
                border: 'none',
                borderBottom: `2px solid ${i === activeSheet ? 'var(--blue)' : 'transparent'}`,
                cursor: 'pointer',
              }}
            >
              {tbl.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri} style={ri === 0 ? { background: 'var(--bg2)', fontWeight: 600 } : undefined}>
                {row.map((cell, ci) => (
                  <td key={ci} className="px-2 py-1 whitespace-nowrap max-w-[200px] truncate"
                    style={{ border: '1px solid var(--border)', color: 'var(--t1)' }}>
                    {String(cell ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
