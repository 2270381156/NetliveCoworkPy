import type { SlideData, SlideShape, TextShape } from '../../worker/parsers/pptx'

const MAX_TITLE_CHARS = 50

/**
 * Best-effort slide title for the TOC.
 *
 * Primary signal: the parser flags the OOXML title placeholder
 * (`<ph type="title"|"ctrTitle">`) as `TextShape.isTitle`. That is the
 * authoritative answer, so we use it first — across slide → layout → master,
 * since the title text may be authored at any of those levels.
 *
 * Fallback heuristic (older decks / shapes with no placeholder type): the
 * first non-empty text shape, scanned top-to-bottom by vertical position
 * (titles sit near the top; footers/page-numbers sit at the bottom).
 *
 * Returns '' only when nothing in the slide/layout/master has usable text.
 */
export function extractTitle(slide: SlideData): string {
  // 1. Authoritative: an explicitly-flagged title placeholder.
  const flagged =
    titleFromFlagged(slide.shapes) ||
    titleFromFlagged(slide.layoutShapes) ||
    titleFromFlagged(slide.masterShapes)
  if (flagged) return flagged

  // 2. Heuristic fallback: top-most non-empty text shape.
  return extractFromShapes(slide.shapes) ||
    extractFromShapes(slide.layoutShapes) ||
    extractFromShapes(slide.masterShapes)
}

/** Text of the first non-empty shape flagged isTitle, or '' if none. */
function titleFromFlagged(shapes: SlideShape[]): string {
  for (const shape of shapes) {
    if (shape.type !== 'text' || !shape.isTitle) continue
    const text = shapeText(shape)
    if (text) return text
  }
  return ''
}

function extractFromShapes(shapes: SlideShape[]): string {
  // Sort text shapes by vertical position — titles are typically near the
  // top of the slide, while footers (page numbers, copyright notices) live
  // at the bottom. Without this sort, a slide whose first author-defined
  // text shape happens to be the footer would surface the footer instead
  // of the real title.
  const textShapes = shapes
    .filter((s): s is TextShape => s.type === 'text')
    .slice()
    .sort((a, b) => a.top - b.top)
  for (const shape of textShapes) {
    const text = shapeText(shape)
    if (text) return text
    // Empty text shape — continue to the next one rather than giving up.
  }
  return ''
}

/**
 * Concatenate ALL runs across ALL paragraphs of a shape, normalise
 * whitespace, and truncate to MAX_TITLE_CHARS code points (CJK-safe via
 * Array.from). Returns '' for a whitespace-only shape.
 *
 * Concatenating every run (not just the first non-empty one) matters because
 * PowerPoint splits a single visible title line into multiple runs whenever
 * there's a formatting change — and a mixed-script title like
 * "5.1 IP承载网络规划流程" is almost always split because Latin and East
 * Asian glyphs use different fonts. Taking only the first run would yield
 * "5.1 IP" and lose the (real, Chinese) title text.
 */
function shapeText(shape: TextShape): string {
  let combined = ''
  for (const paragraph of shape.paragraphs) {
    for (const run of paragraph.runs) {
      combined += run.text
    }
    // Soft return between paragraphs inside the same shape — usually a
    // chapter number and the chapter name. Join with a space so the words
    // don't smash together.
    combined += ' '
  }
  const trimmed = combined.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''
  const codePoints = Array.from(trimmed)
  if (codePoints.length <= MAX_TITLE_CHARS) return trimmed
  return codePoints.slice(0, MAX_TITLE_CHARS).join('') + '…'
}
