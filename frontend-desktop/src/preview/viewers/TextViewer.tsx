import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { useFileText, useRawUrl, Loading, ErrorMsg } from './common'

export function TextViewer({ path, filename, reloadToken }: { path: string; filename: string; reloadToken?: number }) {
  const raw = useRawUrl()
  const { content, error } = useFileText(path, reloadToken)
  usePreviewToolbar({
    copy: () => content ?? '',
    download: { url: raw(path), filename },
  }, [content, path, filename])
  if (error) return <ErrorMsg msg={error} />
  if (content === null) return <Loading />
  return (
    <pre className="px-6 py-4 text-xs leading-relaxed whitespace-pre font-mono" style={{ color: 'var(--t1)' }}>
      {content}
    </pre>
  )
}
