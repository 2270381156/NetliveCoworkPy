import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchOrThrow, useRawUrl, Loading, ErrorMsg } from './common'
import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import './docx/docx.css'

// Markup-Compatibility namespace (OOXML spec §16)
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
// WordprocessingML namespace
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
// Word Processing Shape namespace (wps:wsp, wps:txbx)
const WPS_NS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'
// WordprocessingDrawing namespace (wp:anchor, wp:positionV, wp:posOffset)
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

// mc:Choice Requires values that docx-preview cannot render.
const UNSUPPORTED_REQUIRES = new Set(['wps', 'wpg', 'wpc'])

/** Walk up the DOM tree looking for the nearest ancestor with the given local name + NS. */
function findAncestor(node: Node, localName: string, ns: string): Element | null {
  let cur: Node | null = node.parentNode
  while (cur) {
    if (cur.nodeType === 1 /* ELEMENT_NODE */) {
      const el = cur as Element
      if (el.localName === localName && el.namespaceURI === ns) return el
    }
    cur = cur.parentNode
  }
  return null
}

/**
 * Pre-processes a DOCX ArrayBuffer so that mc:AlternateContent blocks whose
 * mc:Choice requires wps/wpg/wpc (Word Processing Shapes — floating text
 * boxes, grouped shapes, etc.) are handled gracefully.
 *
 * docx-preview cannot render wps:txbx text boxes OR the VML <v:textbox> in
 * mc:Fallback. So we extract the <w:p> paragraphs from wps:txbxContent and
 * inject them into the document flow so they are visible.
 *
 * Sorting: floating text boxes are positioned relative to their anchor
 * paragraph via wp:positionV/wp:posOffset. We estimate each box's visual
 * Y by (anchorParaIndex × EMU_per_para + posOffset) and insert all boxes in
 * that order just before the first section break — so the content appears in
 * approximately the correct visual sequence even though positioning is
 * approximate (document-flow, not absolute).
 */
async function inlineWpsTextBoxes(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)

  const xmlEntries = Object.entries(zip.files).filter(
    ([name]) => name.startsWith('word/') && name.endsWith('.xml') && !zip.files[name].dir,
  )

  await Promise.all(
    xmlEntries.map(async ([name, file]) => {
      const src = await file.async('string')
      if (!src.includes('AlternateContent')) return // fast skip

      const parser = new DOMParser()
      const xmlDoc = parser.parseFromString(src, 'application/xml')
      if (xmlDoc.querySelector('parsererror')) return

      const altNodes = Array.from(xmlDoc.getElementsByTagNameNS(MC_NS, 'AlternateContent'))

      // Compute column width (EMU) so we can detect whether a text box is
      // horizontally centred from its positionH offset + extent cx.
      const TWIP_TO_EMU = 635  // 914 400 EMU/in ÷ 1 440 twips/in
      let columnWidthEMU = 0
      const pgSzEl  = xmlDoc.getElementsByTagNameNS(W_NS, 'pgSz')[0]
      const pgMarEl = xmlDoc.getElementsByTagNameNS(W_NS, 'pgMar')[0]
      if (pgSzEl && pgMarEl) {
        const wAttr = (el: Element, n: string) =>
          parseInt(el.getAttribute(`w:${n}`) ?? el.getAttributeNS(W_NS, n) ?? '0', 10)
        const pgW  = wAttr(pgSzEl, 'w')      || 11906  // A4 default
        const marL = wAttr(pgMarEl, 'left')  || 1440
        const marR = wAttr(pgMarEl, 'right') || 1440
        columnWidthEMU = (pgW - marL - marR) * TWIP_TO_EMU
      }

      type TBEntry = {
        hostRun: Element | null
        ac: Element
        extracted: Node[]
        sortKey: number     // estimated visual Y in EMU
        hAlign: string | null  // inferred h-alignment ('center' | 'left' | …)
      }
      const entries: TBEntry[] = []

      for (const ac of altNodes) {
        if (!ac.parentNode) continue // already detached

        const wpsChoice = Array.from(ac.getElementsByTagNameNS(MC_NS, 'Choice')).find((ch) => {
          const req = (ch.getAttribute('Requires') ?? '').trim()
          return req.split(/\s+/).some((r) => UNSUPPORTED_REQUIRES.has(r))
        })
        if (!wpsChoice) continue

        // Anchor paragraph + its position among siblings
        const hostPara = findAncestor(ac, 'p', W_NS)
        const hostRun  = findAncestor(ac, 'r', W_NS)
        const paraIndex = hostPara?.parentNode
          ? Array.from(hostPara.parentNode.childNodes).indexOf(hostPara)
          : 0

        // Vertical posOffset in EMU (wp:positionV → wp:posOffset)
        let posOffsetV = 0
        const posVList = wpsChoice.getElementsByTagNameNS(WP_NS, 'positionV')
        if (posVList.length > 0) {
          const offEl = posVList[0].getElementsByTagNameNS(WP_NS, 'posOffset')[0]
          posOffsetV = parseInt(offEl?.textContent ?? '0', 10) || 0
        }
        // 228 600 EMU ≈ 18 pt — estimated height of one empty body paragraph
        const sortKey = paraIndex * 228_600 + posOffsetV

        // Extract <w:p> elements from wps:txbxContent
        const extracted: Node[] = []
        for (const txbx of Array.from(wpsChoice.getElementsByTagNameNS(WPS_NS, 'txbx'))) {
          const content = txbx.getElementsByTagNameNS(W_NS, 'txbxContent')[0]
          if (!content) continue
          for (const p of Array.from(content.getElementsByTagNameNS(W_NS, 'p'))) {
            extracted.push(p.cloneNode(true))
          }
        }

        // Infer the horizontal alignment of the text box so we can propagate it
        // to extracted paragraphs that carry no explicit w:jc.
        //
        // Structure: mc:AlternateContent → mc:Choice → w:drawing → wp:anchor
        // wp:anchor is INSIDE wpsChoice, so we search DOWN, not up.
        //
        // Priority 1: wp:positionH/wp:align (e.g. "center", "left", "right").
        // Priority 2: geometric estimate — if box centre ≈ column centre (±15 pt).
        let hAlign: string | null = null
        {
          const posHEl = wpsChoice.getElementsByTagNameNS(WP_NS, 'positionH')[0]
          if (posHEl) {
            const explicitAlign = posHEl.getElementsByTagNameNS(WP_NS, 'align')[0]
            if (explicitAlign?.textContent) {
              hAlign = explicitAlign.textContent.trim()
            } else if (columnWidthEMU > 0) {
              // wp:extent sits alongside wp:positionH inside the same wp:anchor
              const extentEl = wpsChoice.getElementsByTagNameNS(WP_NS, 'extent')[0]
              const cxVal = parseInt(extentEl?.getAttribute('cx') ?? '0', 10) || 0
              const hOffEl = posHEl.getElementsByTagNameNS(WP_NS, 'posOffset')[0]
              const posOH  = parseInt(hOffEl?.textContent ?? '0', 10) || 0
              const boxCtr = posOH + cxVal / 2
              const colCtr = columnWidthEMU / 2
              if (Math.abs(boxCtr - colCtr) < 200_000) hAlign = 'center'  // ±~15 pt
            }
          }
        }

        entries.push({ hostRun, ac, extracted, sortKey, hAlign })
      }

      if (entries.length === 0) return

      // Sort by estimated visual Y (ascending) so we process top-to-bottom.
      entries.sort((a, b) => a.sortKey - b.sortKey)

      // ── Map each text box to a body paragraph that acts as its spacer ──
      // bodyParas includes the ENTIRE document, so we must clamp targetIdx to
      // the current section (before the first sectPr paragraph). Text boxes
      // whose estimated Y exceeds the section boundary are piled just before
      // the section break rather than spilling into subsequent sections/pages.
      const body = xmlDoc.getElementsByTagNameNS(W_NS, 'body')[0]
      if (!body) return

      // Snapshot direct-child <w:p> elements BEFORE any mutation.
      const bodyParas = Array.from(body.childNodes).filter(
        (n): n is Element =>
          n.nodeType === 1 &&
          (n as Element).localName === 'p' &&
          (n as Element).namespaceURI === W_NS,
      )
      if (bodyParas.length === 0) return

      // Find the first paragraph that carries a sectPr (= section break).
      let sectBreakPara: Element | null = null
      let sectBreakIdx = bodyParas.length  // fallback: no section break found
      for (let i = 0; i < bodyParas.length; i++) {
        if (bodyParas[i].getElementsByTagNameNS(W_NS, 'sectPr').length > 0) {
          sectBreakPara = bodyParas[i]
          sectBreakIdx  = i
          break
        }
      }
      // Special bucket key for entries that overshoot the section boundary.
      const PAST_SECT = sectBreakIdx

      // Estimated height of one empty body paragraph in EMU (≈18 pt).
      const PARA_H = 228_600

      // Pre-compute insertion points ONCE before any mutations.
      const targetIdxOf = new Map<TBEntry, number>()
      const insertPtOf  = new Map<number, Node | null>()
      for (const entry of entries) {
        const rawIdx = Math.floor(entry.sortKey / PARA_H)
        // Entries beyond the section break are all inserted just before it.
        const idx = rawIdx >= sectBreakIdx ? PAST_SECT : Math.min(rawIdx, sectBreakIdx - 1)
        targetIdxOf.set(entry, idx)
        if (!insertPtOf.has(idx)) {
          insertPtOf.set(
            idx,
            idx === PAST_SECT
              ? sectBreakPara          // insert BEFORE the section-break para
              : bodyParas[idx].nextSibling,
          )
        }
      }

      // EMU → pt conversion factor
      const EMU_PER_PT = 12700
      // Estimated Y (in pt) of the "past-section" insertion point
      const sectionBaseY_pt = sectBreakIdx * (PARA_H / EMU_PER_PT)

      // Insert in sorted order (top → bottom of page).
      for (const entry of entries) {
        const idx    = targetIdxOf.get(entry)!
        const insertPt = insertPtOf.get(idx) ?? null

        // For entries that overshoot the section boundary, the estimated visual
        // Y is larger than the section base Y. Bridge the gap with w:spacing
        // w:before on the first extracted paragraph so docx-preview pushes it
        // toward the correct vertical position on the cover page.
        if (idx === PAST_SECT && entry.extracted.length > 0) {
          const targetY_pt = entry.sortKey / EMU_PER_PT
          const spacerPt   = targetY_pt - sectionBaseY_pt
          if (spacerPt > 10) {
            const firstPara = entry.extracted[0] as Element
            let pPr = firstPara.getElementsByTagNameNS(W_NS, 'pPr')[0] as Element | undefined
            if (!pPr) {
              pPr = xmlDoc.createElementNS(W_NS, 'w:pPr')
              firstPara.insertBefore(pPr, firstPara.firstChild)
            }
            let spacing = pPr.getElementsByTagNameNS(W_NS, 'spacing')[0] as Element | undefined
            if (!spacing) {
              spacing = xmlDoc.createElementNS(W_NS, 'w:spacing')
              pPr.appendChild(spacing)
            }
            // w:before is in twentieths of a point (twips); cap at one A4 body
            const twips = Math.min(Math.round(spacerPt * 20), 13920) // ≤ 696pt
            spacing.setAttribute('w:before', String(twips))
          }
        }

        // Propagate inferred h-alignment to paragraphs that lack explicit w:jc.
        // Paragraphs with an existing w:jc (from the original txbxContent) are
        // left untouched so their intentional alignment is preserved.
        if (entry.hAlign) {
          for (const p of entry.extracted) {
            const paraEl = p as Element
            const existingPPr = paraEl.getElementsByTagNameNS(W_NS, 'pPr')[0] as Element | undefined
            if (!existingPPr?.getElementsByTagNameNS(W_NS, 'jc')[0]) {
              let pPr = existingPPr
              if (!pPr) {
                pPr = xmlDoc.createElementNS(W_NS, 'w:pPr')
                paraEl.insertBefore(pPr, paraEl.firstChild)
              }
              const jcEl = xmlDoc.createElementNS(W_NS, 'w:jc')
              jcEl.setAttribute('w:val', entry.hAlign)
              pPr.appendChild(jcEl)
            }
          }
        }

        for (const p of entry.extracted) {
          if (insertPt) body.insertBefore(p, insertPt)
          else body.appendChild(p)
        }
      }

      // Remove anchor runs (and by extension the mc:AlternateContent).
      for (const { hostRun, ac } of entries) {
        if (hostRun?.parentNode) {
          hostRun.parentNode.removeChild(hostRun)
        } else if (ac.parentNode) {
          ac.parentNode.removeChild(ac)
        }
      }

      zip.file(name, new XMLSerializer().serializeToString(xmlDoc))
    }),
  )

  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
}

const ZOOM_STEP = 0.1
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3

/**
 * High-fidelity DOCX viewer backed by docx-preview, which parses the OOXML and
 * reproduces the Word page layout (fonts, spacing, headers/footers, footnotes,
 * page breaks) — vs the old mammoth path that flattened everything to semantic
 * HTML and lost the layout. docx-preview renders directly into a DOM container
 * (it is DOM-bound, so this runs on the main thread, not a worker).
 *
 * Known limitation: embedded EMF/WMF metafiles render as broken <img> (browser
 * can't display them and docx-preview owns the image extraction, so the
 * Electron GDI+ converter used for PPTX can't be hooked in here).
 */
export function DocxViewer({ path, filename, reloadToken }: { path: string; filename: string; reloadToken?: number }) {
  const raw = useRawUrl()
  // The container docx-preview renders into. Always mounted (even while
  // loading) so the ref is available when the async render resolves.
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const naturalWRef = useRef(0)   // 页面自然宽度（zoom=1 时测一次存起来，避免测到缩放后的值）
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scale, setScale] = useState(1)

  // 适配面板宽度的缩放：A4 页宽（~793px）在窄预览面板里放不下，默认缩到刚好装下（只缩不放大）。
  const computeFitScale = useCallback((): number => {
    const scroll = scrollRef.current
    const pageW = naturalWRef.current
    if (!scroll || !pageW) return 1
    const avail = scroll.clientWidth
    if (!avail) return 1
    return Math.max(ZOOM_MIN, Math.min(1, (avail - 16) / pageW))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setScale(1)   // 复位到 100%，测量自然页宽时不受上一个文档缩放影响
    fetchOrThrow(raw(path, reloadToken))
      .then((r) => r.arrayBuffer())
      .then(async (buf) => {
        if (cancelled) return
        const container = containerRef.current
        if (!container) return
        container.innerHTML = ''  // clear any previous document on path change
        const docx = await import('docx-preview')
        if (cancelled) return
        // Pre-process: extract wps text-box paragraphs into the document flow
        // so cover pages / floating text boxes are visible (docx-preview cannot
        // render either wps:txbx DrawingML or v:textbox VML text content).
        const processedBuf = await inlineWpsTextBoxes(buf)
        if (cancelled) return
        await docx.renderAsync(processedBuf, container, undefined, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        })
        if (cancelled) return
        // zoom=1 下测量自然页宽存起来，再据面板宽度算出默认缩放（先算后显，避免闪一下 100%）。
        const page = container.querySelector('section') as HTMLElement | null
        naturalWRef.current = page?.offsetWidth || container.scrollWidth || 0
        setScale(computeFitScale())
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(String(e))
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [path, computeFitScale])

  usePreviewToolbar({
    zoom: {
      scale,
      in: () => setScale((s) => Math.min(ZOOM_MAX, Math.round((s + ZOOM_STEP) * 100) / 100)),
      out: () => setScale((s) => Math.max(ZOOM_MIN, Math.round((s - ZOOM_STEP) * 100) / 100)),
      fit: () => setScale(computeFitScale()),   // 适配面板宽度
      reset: () => setScale(1),                 // 100% 原始大小
    },
    download: { url: raw(path), filename },
  }, [scale, path, filename, computeFitScale])

  if (error) return <ErrorMsg msg={error} />

  return (
    <div className="ipm-docx-root">
      {loading && <div className="ipm-docx-loading"><Loading /></div>}
      <div ref={scrollRef} className="ipm-docx-scroll">
        <div
          ref={containerRef}
          className="ipm-docx-container"
          // 用 zoom 而非 transform：zoom 会真正重排，缩小后布局宽度随之变小，
          // 不会在窄面板留下「幽灵横向滚动条」；居中由 .docx-wrapper 的 flex 负责。
          style={{ zoom: scale } as React.CSSProperties}
        />
      </div>
    </div>
  )
}
