import { useRef, useState } from 'react'
import {
  ZoomIn, ZoomOut, Maximize, Download, Copy,
  Check, Search, ChevronUp, ChevronDown, ListTree,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { usePreviewToolbarState, useTocSidebar } from './PreviewToolbarContext'

// Toolbar buttons must NOT steal keyboard focus from the search input on click.
// The browser's default mousedown handler moves focus to the clicked button;
// after that, every Enter press fires that button's click again (e.g. clicking
// Zoom and then pressing Enter keeps zooming, and Enter no longer cycles search
// matches). preventDefault on mousedown blocks the focus transfer; the click
// event itself still fires. Tab-keyboard focus continues to work because Tab
// doesn't go through mousedown.
function keepFocus(e: React.MouseEvent) { e.preventDefault() }

export function PreviewToolbar() {
  const { t } = useI18n()
  const caps = usePreviewToolbarState()
  const { open: tocOpen, setOpen: setTocOpen } = useTocSidebar()
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const hasAny = caps.zoom || caps.pages || caps.search || caps.download || caps.copy || caps.toc
  if (!hasAny) return null

  function doCopy() {
    if (!caps.copy) return
    void navigator.clipboard.writeText(caps.copy()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 flex-shrink-0"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
      {caps.zoom && (
        <>
          <Button variant="ghost" size="icon" title={t('preview.zoomOut')} onMouseDown={keepFocus} onClick={() => caps.zoom!.out()}>
            <ZoomOut size={15} />
          </Button>
          <span className="text-xs tabular-nums w-10 text-center" style={{ color: 'var(--t2)' }}>
            {Math.round(caps.zoom.scale * 100)}%
          </span>
          <Button variant="ghost" size="icon" title={t('preview.zoomIn')} onMouseDown={keepFocus} onClick={() => caps.zoom!.in()}>
            <ZoomIn size={15} />
          </Button>
          <Button variant="ghost" size="icon" title={t('preview.zoomFit')} onMouseDown={keepFocus} onClick={() => caps.zoom!.fit()}>
            <Maximize size={15} />
          </Button>
        </>
      )}

      {caps.toc && caps.toc.items.length > 0 && (
        <Button
          variant="ghost"
          size="icon"
          title={t('preview.toc')}
          onMouseDown={keepFocus}
          onClick={() => setTocOpen(!tocOpen)}
          // Active visual when the sidebar is open — Acrobat-style affordance.
          style={tocOpen ? { background: 'var(--blue-dim)', color: 'var(--blue)' } : undefined}
        >
          <ListTree size={15} />
        </Button>
      )}

      {caps.pages && (
        <span className="text-xs px-2" style={{ color: 'var(--t2)' }}>
          {t('preview.page')} {caps.pages.current} / {caps.pages.count}
        </span>
      )}

      {caps.search && (
        <div className="flex items-center gap-1 ml-1">
          <Search size={14} style={{ color: 'var(--t3)' }} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); caps.search!.run(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                // Word / Acrobat / Chrome convention: Enter = next, Shift+Enter = previous.
                if (e.shiftKey) caps.search!.prev()
                else caps.search!.next()
              }
            }}
            placeholder={t('preview.searchPlaceholder')}
            className="text-xs px-2 py-1 rounded outline-none"
            style={{ background: 'var(--bg1)', border: '1px solid var(--border)', color: 'var(--t1)', width: 160 }}
          />
          {typeof caps.search.count === 'number' && (
            <span className="text-xs tabular-nums" style={{ color: 'var(--t3)' }}>
              {caps.search.count}
            </span>
          )}
          <Button
            variant="ghost" size="icon" title={t('preview.prevMatch')}
            onMouseDown={keepFocus}
            // After cycling, restore focus to the input so Enter/Shift+Enter
            // continues to drive the search instead of triggering this button again.
            onClick={() => { caps.search!.prev(); searchInputRef.current?.focus() }}
          >
            <ChevronUp size={15} />
          </Button>
          <Button
            variant="ghost" size="icon" title={t('preview.nextMatch')}
            onMouseDown={keepFocus}
            onClick={() => { caps.search!.next(); searchInputRef.current?.focus() }}
          >
            <ChevronDown size={15} />
          </Button>
        </div>
      )}

      <div className="flex-1" />

      {caps.copy && (
        <Button variant="ghost" size="icon" title={copied ? t('preview.copied') : t('preview.copy')} onMouseDown={keepFocus} onClick={doCopy}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </Button>
      )}
      {caps.download && (
        <a href={caps.download.url} download={caps.download.filename} title={t('preview.download')}>
          <Button variant="ghost" size="icon" onMouseDown={keepFocus}>
            <Download size={15} />
          </Button>
        </a>
      )}
    </div>
  )
}
