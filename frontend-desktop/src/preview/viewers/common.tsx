import { useEffect, useRef, useState, useCallback } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useI18n } from '@/i18n'
import { LOCAL_BASE } from '@/api/backends'
import { usePreviewBase } from '@/preview/previewBase'

// 这些 URL 打到**该会话所属的后端**：云端会话的工作区文件在云上那个实例里，
// 写死 /api/v1 就等于永远问地端要，云端文件必然 403（见 preview/previewBase.tsx）。
// base 默认地端，保证不在 Provider 里的用法（测试、独立渲染）行为不变。
//
// v：自动/手动刷新时的 cache-bust 版本号，避免浏览器返回旧缓存。
export function rawUrl(path: string, v?: number | string, base: string = LOCAL_BASE): string {
  return `${base}/workspace/file/raw?path=${encodeURIComponent(path)}${v ? `&v=${v}` : ''}`
}

export function textUrl(path: string, v?: number | string, base: string = LOCAL_BASE): string {
  return `${base}/workspace/file?path=${encodeURIComponent(path)}${v ? `&v=${v}` : ''}`
}

/** 绑定到当前预览会话的 rawUrl。viewer 里取原始文件 URL（img src / 下载 / 二进制取件）用它。 */
export function useRawUrl(): (path: string, v?: number | string) => string {
  const base = usePreviewBase()
  return useCallback((path: string, v?: number | string) => rawUrl(path, v, base), [base])
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

export function useFileText(path: string, reloadToken: number = 0) {
  const base = usePreviewBase()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const prevPath = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    // path 变了才清空 → 显示 loading；仅 reloadToken 变（同一文件的自动/手动刷新）则后台重取、
    // 拿到新内容再原地替换，不闪 loading；刷新失败保留旧内容（不覆盖成错误）。
    const isReload = prevPath.current === path
    prevPath.current = path
    if (!isReload) { setContent(null); setError(null) }
    fetchOrThrow(textUrl(path, reloadToken, base))
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setContent(d.content); setError(null) } })
      // Ignore a stale resolution if `path` changed before this fetch settled,
      // so an earlier file's content can't overwrite a later one.
      .catch((e) => { if (!cancelled && !isReload) setError(String(e)) })
    return () => { cancelled = true }
  }, [path, reloadToken, base])
  return { content, error }
}

// 应用窗口是否“活跃”（可见 + 聚焦）。不活跃时不轮询自动刷新，省请求；切回来立即恢复。
export function usePageActive(): boolean {
  const [active, setActive] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible' && document.hasFocus())
  useEffect(() => {
    const update = () => setActive(document.visibilityState === 'visible' && document.hasFocus())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])
  return active
}

// 轮询文件 mtime（经轻量 /file/stat 端点），变了就返回自增的 reloadToken；仅 enabled 时轮询。
// baseline 用 ref 且只在换文件时重置：这样“离开预览期间文件被改、切回来”也能触发一次刷新
// （切回来读到的 mtime 与离开前的 baseline 不同 → bump）。
export function useAutoRefresh(path: string, enabled: boolean, intervalMs = 2000): number {
  const base = usePreviewBase()
  const [token, setToken] = useState(0)
  const baseline = useRef<number | null>(null)
  useEffect(() => { baseline.current = null }, [path])
  useEffect(() => {
    if (!enabled || !path) return
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const statUrl = `${base}/workspace/file/stat?path=${encodeURIComponent(path)}`
    const tick = async () => {
      try {
        const r = await fetch(statUrl, { cache: 'no-store' })
        if (!stop && r.ok) {
          const { mtime } = (await r.json()) as { mtime: number }
          if (baseline.current === null) baseline.current = mtime          // 首次只记基线，不算变化
          else if (mtime !== baseline.current) { baseline.current = mtime; setToken((t) => t + 1) }
        }
      } catch { /* 瞬时错误忽略，下个周期再试 */ }
      if (!stop) timer = setTimeout(tick, intervalMs)
    }
    timer = setTimeout(tick, intervalMs)
    return () => { stop = true; clearTimeout(timer) }
  }, [path, enabled, intervalMs, base])
  return token
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
