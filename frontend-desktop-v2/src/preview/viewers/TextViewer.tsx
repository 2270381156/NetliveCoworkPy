import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { useFileText, rawUrl, Loading, ErrorMsg } from './common'

export function TextViewer({ path, filename }: { path: string; filename: string }) {
  const { content, error } = useFileText(path)
  usePreviewToolbar({
    copy: () => content ?? '',
    download: { url: rawUrl(path), filename },
  }, [content, path, filename])
  if (error) return <ErrorMsg msg={error} />
  if (content === null) return <Loading />
  return (
    <pre className="px-6 py-4 text-xs leading-relaxed whitespace-pre font-mono" style={{ color: 'var(--t1)' }}>
      {content}
    </pre>
  )
}
