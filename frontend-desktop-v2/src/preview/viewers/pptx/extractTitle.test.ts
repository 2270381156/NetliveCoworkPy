import { describe, it, expect } from 'vitest'
import { extractTitle } from './extractTitle'
import type { SlideData } from '../../worker/parsers/pptx'

function makeSlide(opts: { shapes?: SlideData['shapes'] } = {}): SlideData {
  return {
    index: 0,
    width: 960,
    height: 540,
    shapes: opts.shapes ?? [],
    masterShapes: [],
    layoutShapes: [],
    suppressMasterShapes: false,
  }
}

describe('extractTitle', () => {
  it('returns the first non-empty run text of the first text shape', () => {
    const slide = makeSlide({
      shapes: [{
        type: 'text', left: 0, top: 0, width: 100, height: 50,
        paragraphs: [{
          runs: [
            { text: '  ', bold: false, italic: false, underline: false,
              strikethrough: false, fontSize: null, fontFamily: null,
              color: null, spacing: null, href: null, baseline: null,
              highlight: null, glow: null },
            { text: '系统架构', bold: false, italic: false, underline: false,
              strikethrough: false, fontSize: null, fontFamily: null,
              color: null, spacing: null, href: null, baseline: null,
              highlight: null, glow: null },
          ],
          align: 'l', bullet: null,
        }],
      }],
    })
    expect(extractTitle(slide)).toBe('系统架构')
  })

  it('returns empty string when there is no text shape', () => {
    const slide = makeSlide({
      shapes: [{
        type: 'image', left: 0, top: 0, width: 100, height: 50,
        dataUri: 'data:image/png;base64,xxx',
      }],
    })
    expect(extractTitle(slide)).toBe('')
  })

  it('returns empty string when all text shapes are whitespace-only', () => {
    const slide = makeSlide({
      shapes: [{
        type: 'text', left: 0, top: 0, width: 100, height: 50,
        paragraphs: [{
          runs: [{
            text: '   \n\t', bold: false, italic: false, underline: false,
            strikethrough: false, fontSize: null, fontFamily: null,
            color: null, spacing: null, href: null, baseline: null,
            highlight: null, glow: null,
          }],
          align: 'l', bullet: null,
        }],
      }],
    })
    expect(extractTitle(slide)).toBe('')
  })

  it('continues past an empty title placeholder to find the next shape with text', () => {
    const slide = makeSlide({
      shapes: [
        // Empty title-placeholder shape (very common — laid out from master,
        // not overridden by deck author).
        {
          type: 'text', left: 0, top: 0, width: 100, height: 20,
          paragraphs: [{
            runs: [{
              text: '', bold: false, italic: false, underline: false,
              strikethrough: false, fontSize: null, fontFamily: null,
              color: null, spacing: null, href: null, baseline: null,
              highlight: null, glow: null,
            }],
            align: 'l', bullet: null,
          }],
        },
        // Body / content text where the visible heading actually lives.
        {
          type: 'text', left: 0, top: 30, width: 100, height: 50,
          paragraphs: [{
            runs: [{
              text: '业务架构', bold: false, italic: false, underline: false,
              strikethrough: false, fontSize: null, fontFamily: null,
              color: null, spacing: null, href: null, baseline: null,
              highlight: null, glow: null,
            }],
            align: 'l', bullet: null,
          }],
        },
      ],
    })
    expect(extractTitle(slide)).toBe('业务架构')
  })

  it('concatenates all runs of a title split by font/script change', () => {
    // PowerPoint splits a mixed-script title into separate runs because
    // Latin and CJK glyphs use different fonts. Real-world case observed
    // in the 网络规划与配置.pptx test deck: "5.1 IP承载网络规划流程"
    // came out as three runs.
    const mkRun = (text: string) => ({
      text, bold: false, italic: false, underline: false,
      strikethrough: false, fontSize: null, fontFamily: null,
      color: null, spacing: null, href: null, baseline: null,
      highlight: null, glow: null,
    })
    const slide = makeSlide({
      shapes: [{
        type: 'text', left: 0, top: 0, width: 800, height: 50,
        paragraphs: [{
          runs: [mkRun('5.1 '), mkRun('IP'), mkRun('承载网络规划流程')],
          align: 'l', bullet: null,
        }],
      }],
    })
    expect(extractTitle(slide)).toBe('5.1 IP承载网络规划流程')
  })

  it('falls back to layoutShapes when the slide itself has no text content', () => {
    const layoutTitle: SlideData['layoutShapes'] = [{
      type: 'text', left: 0, top: 0, width: 100, height: 20,
      paragraphs: [{
        runs: [{
          text: '7.2 IP地址规划', bold: false, italic: false, underline: false,
          strikethrough: false, fontSize: null, fontFamily: null,
          color: null, spacing: null, href: null, baseline: null,
          highlight: null, glow: null,
        }],
        align: 'l', bullet: null,
      }],
    }]
    const slide: SlideData = {
      index: 0,
      width: 960,
      height: 540,
      shapes: [],          // author didn't override anything on this slide
      masterShapes: [],
      layoutShapes: layoutTitle,
      suppressMasterShapes: false,
    }
    expect(extractTitle(slide)).toBe('7.2 IP地址规划')
  })

  it('prefers the isTitle-flagged shape over a higher top-positioned non-title shape', () => {
    const mkRun = (text: string) => ({
      text, bold: false, italic: false, underline: false,
      strikethrough: false, fontSize: null, fontFamily: null,
      color: null, spacing: null, href: null, baseline: null,
      highlight: null, glow: null,
    })
    // A decorative kicker/date text box sits ABOVE the real title (smaller
    // top). The spatial heuristic alone would surface the kicker; the
    // isTitle flag must win.
    const slide = makeSlide({
      shapes: [
        {
          type: 'text', left: 0, top: 5, width: 300, height: 20,
          paragraphs: [{ runs: [mkRun('2026年第一季度')], align: 'l', bullet: null }],
        },
        {
          type: 'text', left: 0, top: 80, width: 600, height: 60, isTitle: true,
          paragraphs: [{ runs: [mkRun('网络承载方案汇报')], align: 'l', bullet: null }],
        },
      ],
    })
    expect(extractTitle(slide)).toBe('网络承载方案汇报')
  })

  it('falls back to the spatial heuristic when no shape is flagged isTitle', () => {
    const mkRun = (text: string) => ({
      text, bold: false, italic: false, underline: false,
      strikethrough: false, fontSize: null, fontFamily: null,
      color: null, spacing: null, href: null, baseline: null,
      highlight: null, glow: null,
    })
    const slide = makeSlide({
      shapes: [
        {
          type: 'text', left: 0, top: 500, width: 300, height: 20,
          paragraphs: [{ runs: [mkRun('页脚版权')], align: 'l', bullet: null }],
        },
        {
          type: 'text', left: 0, top: 10, width: 600, height: 60,
          paragraphs: [{ runs: [mkRun('顶部标题')], align: 'l', bullet: null }],
        },
      ],
    })
    expect(extractTitle(slide)).toBe('顶部标题')
  })
})
