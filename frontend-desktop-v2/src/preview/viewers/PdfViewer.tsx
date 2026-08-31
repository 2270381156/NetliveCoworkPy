import { useEffect, useRef, useState } from 'react'
// IMPORTANT: import pdfSetup BEFORE pdf_viewer.mjs. pdfSetup's body assigns
// `globalThis.pdfjsLib`, which pdf_viewer.mjs destructures at module load time.
// Swapping the import order crashes the renderer in production builds.
import { pdfjsLib, CMAP_URL, CMAP_PACKED } from './pdf/pdfSetup'
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { flattenOutline, type OutlineDest } from './pdf/outline'
import { usePreviewToolbar, useTocSidebar } from '../toolbar/PreviewToolbarContext'
import type { TocItem } from '../toolbar/capabilities'
import { fetchOrThrow, rawUrl, Loading, ErrorMsg } from './common'
import './pdf/pdf.css'

const ZOOM_STEP = 0.2
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5

interface PdfApi {
  viewer: PDFViewer
  linkService: PDFLinkService
  eventBus: EventBus
  dests: Map<string, OutlineDest>
}

export function PdfViewer({ path, filename }: { path: string; filename: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerElRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<PdfApi | null>(null)
  const lastQuery = useRef('')
  // Whether the viewer is in a fit-mode (re-fits on container resize) vs. a
  // fixed user-chosen zoom (does not auto-refit). Tracked as a ref because the
  // ResizeObserver callback needs a stable reference and re-creating the
  // observer on every fit-mode change would lose the in-flight ro.observe.
  const fitModeRef = useRef(true)
  const { setOpen: setTocOpen } = useTocSidebar()

  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [scale, setScale] = useState(1)
  const [page, setPage] = useState({ current: 1, count: 0 })
  const [matches, setMatches] = useState({ current: 0, total: 0 })
  const [toc, setToc] = useState<TocItem[]>([])

  // Build the pdfjs stack + load the document. Re-runs on path change.
  useEffect(() => {
    const container = containerRef.current!
    const viewerEl = viewerElRef.current!
    let destroyed = false
    let pdfDoc: PDFDocumentProxy | null = null

    setError(null); setReady(false); setToc([]); setMatches({ current: 0, total: 0 })

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const findController = new PDFFindController({ eventBus, linkService })
    const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController })
    linkService.setViewer(viewer)

    // Disable pdfjs's built-in in-line scroll. Its scrollMatchIntoView always
    // does `parent.scrollTop = absoluteOffset`, so every match advance nudges
    // the page even when the match is already visible.
    ;(findController as unknown as { scrollMatchIntoView: () => void }).scrollMatchIntoView = () => {}

    // Suppress the page-level scroll that pdfjs runs on every match advance.
    // PDFFindController's #updatePage does `linkService.page = selectedPageIdx
    // + 1` on every selected-match change. linkService.page → PDFViewer.
    // currentPageNumber → _setCurrentPageNumber → #resetCurrentPageView →
    // #scrollIntoView(pageView) — which forces the page back to the top of the
    // container even when the page hasn't actually changed. That's the
    // *real* source of the flicker users see when stepping through matches on
    // the same page (the earlier scrollMatchIntoView override didn't catch it
    // because it's a separate scroll path). We override the setter to skip the
    // assignment when the page hasn't changed; cross-page navigation still
    // works normally.
    const linkProto = Object.getPrototypeOf(linkService) as object
    const pageDesc = Object.getOwnPropertyDescriptor(linkProto, 'page')
    if (pageDesc?.get && pageDesc?.set) {
      const get = pageDesc.get
      const set = pageDesc.set
      Object.defineProperty(linkService, 'page', {
        configurable: true,
        get(this: typeof linkService) { return get.call(this) },
        set(this: typeof linkService, v: number) {
          if (get.call(this) === v) return
          set.call(this, v)
        },
      })
    }

    eventBus.on('pagesinit', () => {
      fitModeRef.current = true
      viewer.currentScaleValue = 'page-width'
      setReady(true)
    })
    eventBus.on('scalechanging', (e: { scale: number }) => setScale(e.scale))
    eventBus.on('pagechanging', (e: { pageNumber: number }) => setPage((p) => ({ ...p, current: e.pageNumber })))
    eventBus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) =>
      setMatches(e.matchesCount))
    eventBus.on('updatefindcontrolstate', (e: { matchesCount: { current: number; total: number } }) =>
      setMatches(e.matchesCount))

    // Backstop in-line scroll. pdfjs's built-in scrollMatchIntoView depends on
    // `element.offsetParent` being set at the moment of the scroll, which races
    // with page-level scroll + textLayer (re)render — symptom: search lands on
    // the right page but not the right line (esp. when an image precedes the
    // matched text). We only scroll when the active match is NOT already in
    // view (with a margin) — this avoids "first up, then down" jumps when the
    // previous and next matches sit on adjacent visible lines: pdfjs's scroll
    // already nudged the new match into view, so we leave the position alone
    // instead of forcing a second correction to centre.
    const ensureSelectedVisible = () => {
      const c = containerRef.current
      if (!c) return
      const el = c.querySelector('.highlight.selected') as HTMLElement | null
      if (!el) return
      const elRect = el.getBoundingClientRect()
      const cRect = c.getBoundingClientRect()
      const MARGIN = 40 // px from each viewport edge
      const inView = elRect.top >= cRect.top + MARGIN && elRect.bottom <= cRect.bottom - MARGIN
      if (inView) return
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
    }
    eventBus.on('updatefindcontrolstate', () => {
      // Let pdfjs's own scroll attempt run first; then verify the match is
      // visible (and only scroll if not). 80ms is enough for the matching
      // textLayer to render even on a fresh page jump while still feeling
      // instant to the user.
      setTimeout(ensureSelectedVisible, 80)
    })
    eventBus.on('textlayerrendered', () => {
      // After a page's text layer becomes available, if the active match is on
      // this page and out of view, scroll it in.
      setTimeout(ensureSelectedVisible, 0)
    })

    fetchOrThrow(rawUrl(path))
      .then((r) => r.arrayBuffer())
      .then((data) => pdfjsLib.getDocument({ data, cMapUrl: CMAP_URL, cMapPacked: CMAP_PACKED }).promise)
      .then(async (doc) => {
        if (destroyed) { doc.destroy(); return }
        pdfDoc = doc
        viewer.setDocument(doc)
        linkService.setDocument(doc, null)
        setPage({ current: 1, count: doc.numPages })
        const outline = await doc.getOutline().catch(() => null)
        const flat = flattenOutline(outline as never)
        apiRef.current = { viewer, linkService, eventBus, dests: flat.dests }
        if (!destroyed) {
          setToc(flat.items)
          // Auto-open the TOC sidebar when the document has an outline (Acrobat
          // default behaviour). Reapplied on every file load so opening another
          // outline-rich PDF restores the sidebar even after the user closed it.
          if (flat.items.length > 0) setTocOpen(true)
        }
      })
      .catch((e) => { if (!destroyed) setError(String(e)) })

    return () => {
      destroyed = true
      apiRef.current = null
      try { viewer.setDocument(null as never) } catch { /* ignore */ }
      pdfDoc?.destroy()
    }
  }, [path, setTocOpen])

  // Re-fit page width whenever the scrollable container resizes — covers the TOC
  // sidebar toggling (which shrinks/expands available width) and the user
  // dragging the app window. Only re-fits when in a fit-mode; explicit user zoom
  // (in/out/reset) sets fitModeRef.current = false and is preserved.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      if (!fitModeRef.current) return
      const v = apiRef.current?.viewer
      if (v) v.currentScaleValue = 'page-width'
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // pdfjs's find controller replaces its whole state on every 'find' dispatch, so
  // 'again' (next/prev) must re-send the query + flags or it wipes the active search.
  function dispatchFind(again: boolean, findPrevious: boolean) {
    apiRef.current?.eventBus.dispatch('find', {
      source: null, type: again ? 'again' : '', query: lastQuery.current,
      caseSensitive: false, entireWord: false, highlightAll: true, findPrevious,
    })
  }

  // Register toolbar capabilities; re-register when live state changes.
  usePreviewToolbar({
    zoom: {
      in: () => {
        fitModeRef.current = false
        const v = apiRef.current?.viewer
        if (v) v.currentScale = Math.min(ZOOM_MAX, v.currentScale + ZOOM_STEP)
      },
      out: () => {
        fitModeRef.current = false
        const v = apiRef.current?.viewer
        if (v) v.currentScale = Math.max(ZOOM_MIN, v.currentScale - ZOOM_STEP)
      },
      reset: () => {
        fitModeRef.current = false
        const v = apiRef.current?.viewer
        if (v) v.currentScale = 1
      },
      fit: () => {
        fitModeRef.current = true
        const v = apiRef.current?.viewer
        if (v) v.currentScaleValue = 'page-width'
      },
      scale,
    },
    pages: {
      count: page.count,
      current: page.current,
      goto: (n: number) => { const v = apiRef.current?.viewer; if (v) v.currentPageNumber = n },
    },
    search: {
      run: (query: string) => { lastQuery.current = query; dispatchFind(false, false) },
      next: () => dispatchFind(true, false),
      prev: () => dispatchFind(true, true),
      clear: () => { lastQuery.current = ''; apiRef.current?.eventBus.dispatch('findbarclose', { source: null }) },
      count: matches.total,
      current: matches.current,
    },
    ...(toc.length > 0 ? {
      toc: {
        items: toc,
        goto: (id: string) => {
          const api = apiRef.current
          const dest = api?.dests.get(id)
          if (api && dest != null) void api.linkService.goToDestination(dest)
        },
      },
    } : {}),
    download: { url: rawUrl(path), filename },
  }, [scale, page.current, page.count, matches.total, matches.current, toc, path, filename])

  if (error) return <ErrorMsg msg={error} />

  return (
    <div className="relative h-full w-full">
      {!ready && <div className="absolute inset-0 z-10"><Loading /></div>}
      <div ref={containerRef} className="ipm-pdf-container">
        <div ref={viewerElRef} className="pdfViewer" />
      </div>
    </div>
  )
}
