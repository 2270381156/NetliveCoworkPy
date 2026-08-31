import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { useFileText, useRawUrl, Loading, ErrorMsg } from './common'
import { Mermaid } from './Mermaid'

// Collapse '.'/'..' segments so a resolved path like 'ws/docs/./other.md' or
// 'ws/docs/../other.md' becomes something the backend file endpoint accepts.
function normalizePath(p: string): string {
  const isAbs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
      continue
    }
    out.push(seg)
  }
  return (isAbs ? '/' : '') + out.join('/')
}

// Resolve a relative ref (img src / link href) against the markdown file's own
// directory, returning a workspace path (the value the file endpoints accept via
// ?path=). Protocol URLs are returned unchanged by the callers below.
function resolveWorkspacePath(ref: string, mdPath: string): string {
  if (ref.startsWith('/')) return normalizePath(ref)
  const dir = mdPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  return normalizePath(dir ? `${dir}/${ref}` : ref)
}

// raw 由组件传入（它绑定到当前预览会话所属的后端），本函数保持纯函数便于单测。
function resolveImgSrc(src: string, mdPath: string, raw: (p: string) => string): string {
  if (!src || /^(https?:|data:|\/\/)/i.test(src)) return src
  return raw(resolveWorkspacePath(src, mdPath))
}

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|tel:|\/\/)/i.test(href)
}

// 抽出开头的 YAML frontmatter（--- … ---），以 fenced code block（```yaml）形式
// 放回 body，让 react-markdown 用代码块渲染（类似 Typora 的效果）。
// 不直接交给 markdown 渲染，否则 `key: val\n---` 会被当成 Setext 标题显示成大号加粗。
function splitFrontmatter(md: string): { fm: string | null; body: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md)
  if (m) return { fm: m[1], body: md.slice(m[0].length) }
  return { fm: null, body: md }
}

export function MarkdownViewer({
  path,
  filename,
  onNavigate,
  reloadToken,
}: {
  path: string
  filename: string
  // Open another workspace document inside the preview panel. When absent (e.g.
  // markdown rendered outside the file-preview modal) in-workspace links are
  // simply swallowed rather than navigating the main frame away.
  onNavigate?: (path: string) => void
  reloadToken?: number
}) {
  const raw = useRawUrl()
  const { content, error } = useFileText(path, reloadToken)
  usePreviewToolbar({
    copy: () => content ?? '',
    download: { url: raw(path), filename },
  }, [content, path, filename])

  if (error) return <ErrorMsg msg={error} />
  if (content === null) return <Loading />

  const { fm, body } = splitFrontmatter(content)

  // 将 YAML frontmatter 以 fenced code block 形式放回 body，
  // 让 react-markdown 用代码块渲染（类似 Typora 的效果）。
  const mdBody = fm ? `\`\`\`yaml\n${fm}\n\`\`\`\n\n${body}` : body

  return (
    <div className="prose prose-sm max-w-none px-8 py-6 md-doc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img({ src, alt, ...rest }) {
            return <img src={resolveImgSrc(src ?? '', path, raw)} alt={alt ?? ''} {...rest} className="max-w-full rounded" />
          },
          // ```mermaid blocks render as diagrams. Other fenced code keeps the
          // default <pre><code> (recolored to light-gray via .md-doc in index.css).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code({ node: _node, className, children, ...rest }: any) {
            if (className?.includes('language-mermaid')) {
              return <Mermaid chart={String(children).replace(/\n$/, '')} />
            }
            return <code className={className} {...rest}>{children}</code>
          },
          // Drop the <pre> wrapper around a mermaid block so the diagram isn't
          // boxed in a code background. Detected from the source hast node, since
          // by the time children render the inner <code> is already a <Mermaid>.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pre({ node, children, ...rest }: any) {
            const cls = node?.children?.[0]?.properties?.className
            if (Array.isArray(cls) && cls.includes('language-mermaid')) return <>{children}</>
            return <pre {...rest}>{children}</pre>
          },
          a({ href, children }) {
            const h = href ?? ''
            // In-page anchors (TOC links) only touch the fragment — harmless.
            if (!h || h.startsWith('#')) return <a href={h}>{children}</a>
            // External links open in the OS browser via Electron's
            // setWindowOpenHandler (target=_blank → new-window request).
            if (isExternalHref(h)) return <a href={h} target="_blank" rel="noreferrer">{children}</a>
            // In-workspace document link. NEVER let the main frame navigate: a
            // bare <a href="other.md"> resolves to the SPA origin, the backend
            // 404s, and the whole SPA gets replaced by {"detail":"not found"}
            // with no way back (menu bar removed). Open it in the preview panel.
            return (
              <a
                href={h}
                onClick={(e) => {
                  e.preventDefault()
                  if (onNavigate) onNavigate(resolveWorkspacePath(h.split(/[?#]/)[0], path))
                }}
              >
                {children}
              </a>
            )
          },
        }}
      >
        {mdBody}
      </ReactMarkdown>
    </div>
  )
}
