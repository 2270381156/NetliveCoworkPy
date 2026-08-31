import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { useFileText, useRawUrl, Loading, ErrorMsg } from './common'

/**
 * HTML 文件预览 —— 渲染成网页，而非源码。
 *
 * 用 sandbox iframe + srcdoc：`allow-scripts` 但**不带** allow-same-origin，被渲染的
 * HTML 运行在独立源里，脚本能跑（图表等），但碰不到宿主应用的 DOM / cookie / electronAPI。
 * 注意：单文件渲染，若 HTML 引用相对路径的图片/CSS，那些资源加载不出来（后端 raw 端点
 * 只发单个文件）；自包含 HTML（内联样式 / 绝对或 CDN 链接）正常。
 */
export function HtmlViewer({ path, filename, reloadToken }: { path: string; filename: string; reloadToken?: number }) {
  const raw = useRawUrl()
  const { content, error } = useFileText(path, reloadToken)
  usePreviewToolbar({
    copy: () => content ?? '',
    download: { url: raw(path), filename },
  }, [content, path, filename])
  if (error) return <ErrorMsg msg={error} />
  if (content === null) return <Loading />
  return (
    <iframe
      title={filename}
      srcDoc={content}
      sandbox="allow-scripts"
      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
    />
  )
}
