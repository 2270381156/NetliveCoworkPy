import { useI18n } from '@/i18n'
import { usePreviewToolbarState, useTocSidebar } from './PreviewToolbarContext'

/**
 * Persistent left-side outline panel (Acrobat / Word style). Renders only when:
 *  - the user has toggled it on via the toolbar Contents button, AND
 *  - the active viewer has registered a `toc` capability with at least one item.
 * Sticky open-state across files (the Provider holds it), so opening the sidebar
 * once keeps it visible when switching to another document with an outline.
 */
export function TocSidebar() {
  const { t } = useI18n()
  const caps = usePreviewToolbarState()
  const { open } = useTocSidebar()

  if (!open || !caps.toc || caps.toc.items.length === 0) return null

  return (
    <div
      className="flex flex-col flex-shrink-0 overflow-hidden"
      style={{ width: 260, background: 'var(--bg2)', borderRight: '1px solid var(--border)' }}
    >
      <div
        className="px-3 py-2 text-xs font-semibold flex-shrink-0"
        style={{ color: 'var(--t2)', borderBottom: '1px solid var(--border)' }}
      >
        {t('preview.toc')}
      </div>
      <div className="flex-1 overflow-auto py-1">
        {caps.toc.items.map((item) => (
          <button
            key={item.id}
            onClick={() => caps.toc!.goto(item.id)}
            className="ipm-toc-item block w-full text-left text-xs py-1 truncate"
            style={{
              paddingLeft: 12 + (item.level ?? 0) * 12,
              paddingRight: 12,
              color: 'var(--t2)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
            title={item.label}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}
