import { describe, it, expect } from 'vitest'
import { prefixSelectors } from './slideToHtml'

describe('prefixSelectors', () => {
  it('prefixes a single class selector', () => {
    expect(prefixSelectors('.sh-0-1 { color: red; }', '.ipm-pptx-root '))
      .toBe('.ipm-pptx-root .sh-0-1 { color: red; }')
  })

  it('prefixes each selector in a list', () => {
    expect(prefixSelectors('.a, .b { x:1; }', '.ipm-pptx-root '))
      .toBe('.ipm-pptx-root .a, .ipm-pptx-root .b { x:1; }')
  })

  it('handles consecutive rules separated by }', () => {
    const css = '.a { x:1; } .b { y:2; }'
    expect(prefixSelectors(css, '.ipm-pptx-root '))
      .toBe('.ipm-pptx-root .a { x:1; } .ipm-pptx-root .b { y:2; }')
  })

  it('preserves leading whitespace inside rule bodies', () => {
    const css = '.a {\n  color: red;\n}\n'
    expect(prefixSelectors(css, '.ipm-pptx-root '))
      .toBe('.ipm-pptx-root .a {\n  color: red;\n}\n')
  })

  it('handles rule bodies with large value content quickly (no O(N²) regex backtrack)', () => {
    // Real-world hit: slide #1 of the user's test deck had a 107KB
    // background-image data URL inside its rule body. The old regex-based
    // implementation (/([^{}]+)\{/g) backtracked catastrophically on the
    // large `[^{}]+` match attempt, taking 10+ seconds per slide. The
    // indexOf-based implementation must finish this same case in
    // milliseconds — guard with a tight budget so a future regex
    // regression fails the test obviously.
    const bigValue = 'A'.repeat(100_000)
    const css = `.sld-0{background-image:url(data:image/png;base64,${bigValue});}`
    const t0 = performance.now()
    const out = prefixSelectors(css, '.ipm-pptx-root ')
    const elapsed = performance.now() - t0
    expect(out.startsWith('.ipm-pptx-root .sld-0{')).toBe(true)
    expect(out).toContain(bigValue)  // value content preserved verbatim
    expect(elapsed).toBeLessThan(50)
  })
})
