import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { InfoIcon, XIcon } from 'lucide-react'
import { fetchOrThrow, useRawUrl, ErrorMsg } from './common'
import { Spinner } from '@/components/ui/spinner'
import { parsePptx, setEmfConverter, type SlideData } from '../worker/parsers/pptx'
import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import type { TocItem } from '../toolbar/capabilities'
import { useI18n } from '@/i18n'
import { slideToHtml } from './pptx/slideToHtml'
import { extractTitle } from './pptx/extractTitle'
import './pptx/pptx.css'

// Register the EMF/WMF → PNG converter backed by the Electron main process
// (Windows GDI+ via System.Drawing). Browsers can't render Windows metafiles
// in <img>, so the parser delegates conversion to this host bridge. Absent in
// dev / plain browser / tests → the parser renders nothing for metafiles.
// (window.electronAPI is typed in NewSessionDialog.tsx's global declaration.)
{
  const bridge = typeof window !== 'undefined' ? window.electronAPI?.convertEmf : undefined
  setEmfConverter(bridge ? (items) => bridge(items) : null)
}

const ZOOM_STEP = 0.2
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4

/**
 * One slide. Renders its (expensive-to-stringify, image-heavy) HTML+CSS ONLY
 * when it scrolls near the viewport, then keeps it mounted. This is the
 * virtualisation that makes huge decks viable: a 368-slide / 48MB deck would
 * emit ~84MB of combined HTML+CSS (thousands of inline base64 images) if every
 * slide were rendered up-front — injecting that all at once hangs/crashes the
 * renderer. Lazy per-slide rendering caps live DOM to what's been viewed.
 *
 * The page wrapper reserves vertical space from the slide's intrinsic aspect
 * ratio BEFORE rendering, so the scrollbar length and scroll position are
 * stable whether or not the slide's content has materialised yet.
 *
 * React.memo (with an explicit comparator) means a sibling slide rendering
 * does not re-render this one — important when 368 children share a parent.
 */
const SlideItem = memo(
  function SlideItem({
    slide,
    idx,
    registerRef,
  }: {
    slide: SlideData
    idx: number
    registerRef: (idx: number, el: HTMLDivElement | null) => void
  }) {
    const [rendered, setRendered] = useState<{ css: string; html: string } | null>(null)
    const elRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
      if (rendered) return
      const el = elRef.current
      if (!el) return
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            observer.disconnect()
            setRendered(slideToHtml(slide, idx))
          }
        },
        // Render a screen ahead/behind so normal scrolling never reveals a
        // blank slide. slideToHtml is ~1ms after the prefixSelectors fix, so
        // rendering eagerly within this margin is cheap.
        { rootMargin: '600px 0px' },
      )
      observer.observe(el)
      return () => observer.disconnect()
    }, [slide, idx, rendered])

    return (
      <div
        ref={(el) => { elRef.current = el; registerRef(idx, el) }}
        className="ipm-pptx-slide-page"
        data-idx={idx}
      >
        <div
          className={`ipm-pptx-slide sld-${idx}`}
          style={{ ['--slide-aspect' as string]: String(slide.width / slide.height) }}
        >
          {rendered ? (
            <>
              <style dangerouslySetInnerHTML={{ __html: rendered.css }} />
              <div className="slide-inner" dangerouslySetInnerHTML={{ __html: rendered.html }} />
            </>
          ) : null}
        </div>
      </div>
    )
  },
  (prev, next) =>
    prev.slide === next.slide && prev.idx === next.idx && prev.registerRef === next.registerRef,
)

// 提示条：PPTX 预览为自研近似渲染，排版/图表/形状可能与 Office 打开略有差异。用户点关闭后永久不再提示。
const PPTX_NOTICE_KEY = 'ipmc.pptxPreviewNoticeDismissed'

export function PptxViewer({ path, filename, reloadToken }: { path: string; filename: string; reloadToken?: number }) {
  const raw = useRawUrl()
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const [showNotice, setShowNotice] = useState(() => {
    try { return localStorage.getItem(PPTX_NOTICE_KEY) !== '1' } catch { return true }
  })
  // 常驻显示,不自动消失；点 × 关闭并永久不再提示。
  const dismissNoticeForever = useCallback(() => {
    try { localStorage.setItem(PPTX_NOTICE_KEY, '1') } catch { /* 忽略配额/隐私模式 */ }
    setShowNotice(false)
  }, [])
  const slideRefs = useRef<HTMLDivElement[]>([])
  const [error, setError] = useState<string | null>(null)
  const [slides, setSlides] = useState<SlideData[]>([])
  const [scale, setScale] = useState(1)
  const [current, setCurrent] = useState(1)
  const [toc, setToc] = useState<TocItem[]>([])
  const [loading, setLoading] = useState(true)
  // Parse progress for large decks: [done, total]. total=0 → unknown yet.
  const [progress, setProgress] = useState<[number, number]>([0, 0])
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const currentRef = useRef(1)
  useEffect(() => { currentRef.current = current }, [current])
  const slideCountRef = useRef(0)
  useEffect(() => { slideCountRef.current = slides.length }, [slides.length])

  // Stable callback for SlideItem to publish its DOM ref (kept stable so memo'd
  // children don't re-render when the parent re-renders).
  const registerSlideRef = useCallback((idx: number, el: HTMLDivElement | null) => {
    if (el) slideRefs.current[idx] = el
  }, [])

  // Fetch + parse. Parse runs on the main thread (native DOMParser) and yields
  // periodically so the UI stays responsive even on a multi-second parse of a
  // huge deck (the spinner animates, the close button works). Rendering is
  // virtualised per slide (see SlideItem), so we only keep the parsed
  // SlideData here — slideToHtml runs lazily as slides scroll into view.
  useEffect(() => {
    let cancelled = false
    setError(null); setSlides([]); setCurrent(1); setToc([]); setProgress([0, 0])
    setLoading(true)
    slideRefs.current = []
    fetchOrThrow(raw(path, reloadToken))
      .then((r) => r.arrayBuffer())
      .then(async (buf) => {
        if (cancelled) return
        const result = await parsePptx(buf, (done, total) => {
          if (!cancelled) setProgress([done, total])
        })
        if (cancelled) return
        // Titles for the TOC — extractTitle is ~ms/slide, cheap enough to do
        // eagerly even for hundreds of slides, and it populates the TOC + page
        // count immediately on load.
        const allToc: TocItem[] = result.slides.map((slide, i) => {
          const title = extractTitle(slide)
          return { id: `slide-${i}`, label: title ? `${i + 1}. ${title}` : t('preview.slideN', { n: i + 1 }) }
        })
        setSlides(result.slides)
        setToc(allToc)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if ((e as { name?: string }).name !== 'AbortError') {
          setError(String(e))
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [path, t])

  // ResizeObserver via callback ref (the container only mounts when !loading;
  // a deps=[] useEffect would run while the spinner is showing and the ref is
  // still null, so the observer would never attach and containerSize would
  // stay {0,0}, breaking the fit-page CSS calc).
  const observerRef = useRef<ResizeObserver | null>(null)
  const setContainer = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    containerRef.current = el
    if (!el) return
    setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(() => {
      setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    observerRef.current = ro
  }, [])

  // Keyboard navigation: PageDown / PageUp / Arrow / Home / End step one slide.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
      const scrollTo = (n: number) => {
        const el = slideRefs.current[n - 1]
        if (!el) return
        e.preventDefault()
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }
      if (e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        scrollTo(Math.min(currentRef.current + 1, slideCountRef.current))
      } else if (e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        scrollTo(Math.max(currentRef.current - 1, 1))
      } else if (e.key === 'Home') {
        scrollTo(1)
      } else if (e.key === 'End') {
        scrollTo(slideCountRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // IntersectionObserver: track which slide is centred, for the toolbar's
  // current-page indicator. Observes the page wrappers (which exist as
  // placeholders even before their content renders).
  useEffect(() => {
    const container = containerRef.current
    if (!container || slides.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        let best = -1
        let bestRatio = 0
        for (const e of entries) {
          if (e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio
            best = Number((e.target as HTMLElement).dataset.idx)
          }
        }
        if (best >= 0) setCurrent(best + 1)
      },
      { root: container, rootMargin: '-40% 0px -40% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    for (const el of slideRefs.current) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [slides])

  usePreviewToolbar({
    pages: {
      count: slides.length,
      current,
      goto: (n: number) => {
        const el = slideRefs.current[n - 1]
        if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
      },
    },
    zoom: {
      scale,
      in: () => setScale((s) => Math.min(ZOOM_MAX, s + ZOOM_STEP)),
      out: () => setScale((s) => Math.max(ZOOM_MIN, s - ZOOM_STEP)),
      fit: () => setScale(1),
      reset: () => setScale(1),
    },
    ...(toc.length > 0 ? {
      toc: {
        items: toc,
        goto: (id: string) => {
          const idx = Number(id.replace('slide-', ''))
          const el = slideRefs.current[idx]
          if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
        },
      },
    } : {}),
    download: { url: raw(path), filename },
  }, [slides.length, current, scale, toc, path, filename])

  if (error) return <ErrorMsg msg={error} />
  if (loading) {
    const [done, total] = progress
    const label = total > 0 ? t('preview.parsingN', { n: done, total }) : t('preview.parsing')
    return (
      <div className="flex h-full items-center justify-center gap-3 text-sm" style={{ color: 'var(--t3)' }}>
        <Spinner className="h-4 w-4" /> <span>{label}</span>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0 }}>
      <div
        ref={setContainer}
        className="ipm-pptx-root"
        style={{
          ['--pptx-zoom' as string]: String(scale),
          ['--pptx-container-w' as string]: `${containerSize.w}px`,
          ['--pptx-container-h' as string]: `${containerSize.h}px`,
          scrollSnapType: scale === 1 ? 'y proximity' : 'none',
        }}
      >
        {slides.map((slide, idx) => (
          <SlideItem key={idx} slide={slide} idx={idx} registerRef={registerSlideRef} />
        ))}
      </div>
      {showNotice && (
        <div className="ipm-pptx-notice" role="note">
          <InfoIcon size={13} style={{ flexShrink: 0, color: 'var(--blue)' }} />
          <span>{t('preview.pptxApproxNotice')}</span>
          <button type="button" onClick={dismissNoticeForever} title={t('preview.pptxApproxDismiss')} aria-label={t('preview.pptxApproxDismiss')}>
            <XIcon size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
