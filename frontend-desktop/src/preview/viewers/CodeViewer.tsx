import { useMemo } from 'react'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github.css'
import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { useFileText, useRawUrl, Loading, ErrorMsg } from './common'

// 超过此大小不做语法高亮：highlight.js 是同步的，对大文件跑正则会卡死主线程（页面点不动），
// 高亮后海量 <span> 也拖垮 DOM。大文件直接纯文本渲染。
const MAX_HIGHLIGHT_CHARS = 200_000

export function CodeViewer({ path, lang, filename, reloadToken }: { path: string; lang: string; filename: string; reloadToken?: number }) {
  const raw = useRawUrl()
  const { content, error } = useFileText(path, reloadToken)

  const html = useMemo(() => {
    if (content === null) return ''
    if (content.length > MAX_HIGHLIGHT_CHARS) return null   // 大文件跳过高亮 → 纯文本
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
    download: { url: raw(path), filename },
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
