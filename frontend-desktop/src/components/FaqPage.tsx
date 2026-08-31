import { useMemo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HelpCircleIcon, ChevronLeftIcon } from 'lucide-react'
import { useI18n } from '@/i18n'
import { FAQ_MD } from './faqContent'

// 标题文本 → 稳定 id(保留字母/数字/中日韩，空白转 -，其余标点去掉)。TOC 与渲染标题用同一函数 → id 对齐。
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '')
}
function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (node && typeof node === 'object' && 'props' in (node as any)) return nodeText((node as any).props.children)
  return ''
}

/** 应用内「常见问题」页(中间栏)。左侧目录导航 + 右侧 markdown 正文,内容按语言取用。 */
export function FaqPage({ onClose }: { onClose?: () => void }) {
  const { t, lang } = useI18n()
  const md = FAQ_MD[lang] ?? FAQ_MD.zh

  // 从 markdown 抽取 ## / ### 标题作为目录(# 标题=页标题，跳过)。
  const toc = useMemo(() => {
    const items: { level: 2 | 3; text: string; id: string }[] = []
    for (const line of md.split('\n')) {
      const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line)
      if (m) items.push({ level: m[1].length as 2 | 3, text: m[2], id: slugify(m[2]) })
    }
    return items
  }, [md])

  const goto = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const hId = (children: ReactNode) => slugify(nodeText(children))

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg0)' }}>
      {/* Header */}
      <div style={{ background: 'var(--bg1)', borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 px-6 py-4">
          {onClose && (
            <button
              onClick={onClose}
              title={t('common.back')}
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
              style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
            >
              <ChevronLeftIcon size={16} />
            </button>
          )}
          <HelpCircleIcon size={18} style={{ color: 'var(--blue)' }} />
          <h1 className="text-base font-semibold" style={{ color: 'var(--t1)' }}>{t('faq.title')}</h1>
        </div>
      </div>

      {/* Body:目录 + 正文 */}
      <div className="flex-1 overflow-auto">
        <div className="flex gap-6 px-6 py-6" style={{ maxWidth: 1000 }}>
          {/* 目录导航(粘顶) */}
          <nav className="flex-shrink-0" style={{ width: 210, position: 'sticky', top: 0, alignSelf: 'flex-start' }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--t3)', margin: '0 0 8px 8px' }}>{t('faq.toc')}</div>
            {toc.map((it, i) => (
              <button
                key={i}
                onClick={() => goto(it.id)}
                title={it.text}
                className="block w-full truncate rounded text-left transition-colors"
                style={{
                  fontSize: it.level === 2 ? 12.5 : 12,
                  fontWeight: it.level === 2 ? 600 : 400,
                  color: it.level === 2 ? 'var(--t2)' : 'var(--t3)',
                  padding: '4px 8px',
                  paddingLeft: it.level === 3 ? 18 : 8,
                  marginTop: it.level === 2 ? 6 : 0,
                  background: 'none', border: 'none', cursor: 'pointer',
                }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--blue)' }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = it.level === 2 ? 'var(--t2)' : 'var(--t3)' }}
              >
                {it.text}
              </button>
            ))}
          </nav>

          {/* 正文 */}
          <div className="prose prose-sm max-w-none msg-md" style={{ flex: 1, minWidth: 0 }}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                h2: ({ children }) => <h2 id={hId(children)} style={{ scrollMarginTop: 12 }}>{children}</h2>,
                h3: ({ children }) => <h3 id={hId(children)} style={{ scrollMarginTop: 12 }}>{children}</h3>,
              }}
            >
              {md}
            </Markdown>
          </div>
        </div>
      </div>
    </div>
  )
}
