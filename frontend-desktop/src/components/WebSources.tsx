import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Globe2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { parseWebSources, webSourceFaviconUrl, type WebSource } from '@/lib/webSources'
import styles from './WebSources.module.css'

interface WebSourcesProps {
  sources: WebSource[]
  /** Open a validated source in Cowork's existing in-app browser. */
  onOpenUrl?: (url: string) => void
}

const KNOWN_MARKS = [
  ['zhihu.com', '知', 'zhihu'],
  ['baidu.com', '百', 'baidu'],
  ['juejin.cn', '掘', 'juejin'],
  ['weixin.qq.com', '微', 'wechat'],
  ['github.com', 'G', 'github'],
  ['wikipedia.org', 'W', 'wikipedia'],
  ['csdn.net', 'C', 'csdn'],
  ['weather.com.cn', '天', 'weather'],
] as const

const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp',
])

function matchingMark(domain: string) {
  return KNOWN_MARKS.find(([known]) => domain === known || domain.endsWith(`.${known}`))
}

function siteIdentity(domain: string): string {
  return matchingMark(domain)?.[0] ?? domain.replace(/^www\./, '')
}

function fallbackMark(domain: string): { glyph: string; tone: string } {
  const known = matchingMark(domain)
  if (known) return { glyph: known[1], tone: known[2] }

  const labels = domain.replace(/^www\./, '').split('.').filter(Boolean)
  const suffix = labels.slice(-2).join('.')
  const label = labels.length > 2 && COMMON_SECOND_LEVEL_SUFFIXES.has(suffix)
    ? labels[labels.length - 3]
    : (labels.length > 1 ? labels[labels.length - 2] : labels[0])
  const glyph = (label?.match(/[a-z0-9]/i)?.[0] ?? label?.[0] ?? '网').toUpperCase()
  let hash = 0
  for (const char of domain) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
  return { glyph, tone: `default-${(hash % 5) + 1}` }
}

function SourceMark({ source, compact = false }: { source: WebSource; compact?: boolean }) {
  const mark = fallbackMark(source.domain)
  const faviconUrl = useMemo(() => webSourceFaviconUrl(source), [source])
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [faviconUrl])

  return (
    <span
      className={`${styles.siteMark}${compact ? ` ${styles.compactMark}` : ''}`}
      data-tone={mark.tone}
      data-source-mark="true"
      title={compact ? source.domain : undefined}
      aria-hidden="true"
    >
      <span className={styles.fallback}>{mark.glyph}</span>
      {faviconUrl && !failed && (
        <img
          className={`${styles.logo}${loaded ? ` ${styles.logoLoaded}` : ''}`}
          data-source-logo="true"
          src={faviconUrl}
          alt=""
          aria-hidden="true"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}

function SourceRow({ source, onOpenUrl }: { source: WebSource; onOpenUrl?: (url: string) => void }) {
  const { t } = useI18n()
  return (
    <li className={styles.listItem}>
      <button
        type="button"
        className={styles.row}
        onClick={() => onOpenUrl?.(source.url)}
        disabled={!onOpenUrl}
        aria-label={t('webSources.openInApp', { title: source.title })}
        title={source.url}
      >
        <SourceMark source={source} />
        <span className={styles.rowCopy}>
          <span className={styles.rowTitle}>{source.title}</span>
          <span className={styles.rowMeta}>
            <span className={styles.rowUrl} dir="ltr">{source.url}</span>
          </span>
        </span>
        <ChevronRight className={styles.chevron} size={16} aria-hidden="true" />
      </button>
    </li>
  )
}

export function WebSources({ sources, onOpenUrl }: WebSourcesProps) {
  const { t } = useI18n()
  const listId = useId()
  const safeSources = useMemo(() => parseWebSources(sources), [sources])
  const iconSources = useMemo(() => {
    const sites = new Set<string>()
    return safeSources.filter(source => {
      const identity = siteIdentity(source.domain)
      if (sites.has(identity)) return false
      sites.add(identity)
      return true
    }).slice(0, 3)
  }, [safeSources])
  const [expanded, setExpanded] = useState(false)

  if (safeSources.length === 0) return null

  return (
    <section className={styles.root} aria-label={t('webSources.heading')}>
      <div className={styles.header}>
        <div className={styles.summary}>
          <span className={styles.heading}>
            <Globe2 size={15} aria-hidden="true" />
            <span>{t('webSources.heading')}</span>
          </span>
          <span className={styles.siteIcons} data-testid="web-source-summary-icons" aria-hidden="true">
            {iconSources.map(source => <SourceMark key={siteIdentity(source.domain)} source={source} compact />)}
          </span>
        </div>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          aria-controls={listId}
        >
          <span>{t(expanded ? 'webSources.collapse' : 'webSources.viewPages')}</span>
          {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
      </div>

      {expanded && (
        <div id={listId} className={styles.inlinePanel} role="region" aria-label={t('webSources.list')}>
          <ul className={styles.list}>
            {safeSources.map(source => <SourceRow key={source.url} source={source} onOpenUrl={onOpenUrl} />)}
          </ul>
        </div>
      )}
    </section>
  )
}
