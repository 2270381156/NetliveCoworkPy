import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parsePptx } from './pptx'

const fixture = resolve(__dirname, '__fixtures__/sample.pptx')

describe('pptx parser', () => {
  it('parses the sample deck into slides with extractable text', async () => {
    const buf = readFileSync(fixture)
    const ab = new Uint8Array(buf).buffer
    const { slides } = await parsePptx(ab)
    expect(slides.length).toBeGreaterThan(0)
    const allText = slides
      .flatMap((s) => s.shapes)
      .filter((sh) => sh.type === 'text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .flatMap((sh: any) => sh.paragraphs.flatMap((p: any) => p.runs.map((r: any) => r.text)))
      .join('')
    expect(allText.trim().length).toBeGreaterThan(0)
  })
})
