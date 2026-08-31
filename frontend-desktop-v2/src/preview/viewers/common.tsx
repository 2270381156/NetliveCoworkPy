import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useI18n } from '@/i18n'

export function rawUrl(path: string): string {
  return `/api/v1/workspace/file/raw?path=${encodeURIComponent(path)}`
}

export function textUrl(path: string): string {
  return `/api/v1/workspace/file?path=${encodeURIComponent(path)}`
}

// fetch that throws on !ok with FastAPI's `detail` extracted into the message,
// so callers (mammoth/xlsx) don't get HTML/JSON error bodies dressed up as
// their expected binary format.
export async function fetchOrThrow(url: string): Promise<Response> {
  const r = await fetch(url)
  if (!r.ok) {
    let detail = ''
    try {
      const body = await r.text()
      try { detail = (JSON.parse(body) as { detail?: string })?.detail || body }
      catch { detail = body }
    } catch { /* ignore body read failures */ }
    throw new Error(`HTTP ${r.status}${detail ? ': ' + detail.slice(0, 200) : ''}`)
  }
  return r
}

export function useFileText(path: string) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setContent(null); setError(null)
    fetchOrThrow(textUrl(path))
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setContent(d.content) })
      .catch((e) => { if (!cancelled) setError(String(e)) })
    // Ignore a stale resolution if `path` changed before this fetch settled,
    // so an earlier file's content can't overwrite a later one.
    return () => { cancelled = true }
  }, [path])
  return { content, error }
}

export function Loading() {
  const { t } = useI18n()
  return (
    <div className="flex h-full items-center justify-center gap-2" style={{ color: 'var(--t3)' }}>
      <Spinner className="h-4 w-4" /> <span className="text-sm">{t('common.loading')}</span>
    </div>
  )
}

export function ErrorMsg({ msg }: { msg: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-red-500 text-sm">{msg}</div>
}
