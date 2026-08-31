import { useMemo } from 'react'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github.css'
import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { useFileText, rawUrl, Loading, ErrorMsg } from './common'

export function CodeViewer({ path, lang, filename }: { path: string; lang: string; filename: string }) {
  const { content, error } = useFileText(path)

  const html = useMemo(() => {
    if (content === null) return ''
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(content, { language: lang }).value
        : hljs.highlightAuto(content).value
    } catch {
      return null
    }
  }, [content, lang])

  usePreviewToolbar({
    copy: () => content ?? '',
    download: { url: rawUrl(path), filename },
  }, [content, path, filename])

  if (error) return <ErrorMsg msg={error} />
  if (content === null) return <Loading />

  return (
    <pre className="hljs text-xs leading-relaxed m-0 p-4 overflow-auto h-full" style={{ background: 'transparent' }}>
      {html === null
        ? <code>{content}</code>
        : <code dangerouslySetInnerHTML={{ __html: html }} />}
    </pre>
  )
}
