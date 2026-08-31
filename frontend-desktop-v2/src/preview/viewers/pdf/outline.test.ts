import { describe, it, expect } from 'vitest'
import { flattenOutline } from './outline'

// Mirrors the shape pdfjs getOutline() returns: { title, dest, items }
const sample = [
  { title: 'Chapter 1', dest: 'ch1', items: [
    { title: 'Section 1.1', dest: [{ num: 4, gen: 0 }, { name: 'XYZ' }], items: [] },
  ] },
  { title: 'Chapter 2', dest: 'ch2', items: [] },
]

describe('flattenOutline', () => {
  it('flattens a nested outline with levels and a dest map', () => {
    const { items, dests } = flattenOutline(sample as never)
    expect(items.map((i) => [i.label, i.level])).toEqual([
      ['Chapter 1', 0],
      ['Section 1.1', 1],
      ['Chapter 2', 0],
    ])
    expect(new Set(items.map((i) => i.id)).size).toBe(3)
    for (const i of items) expect(dests.has(i.id)).toBe(true)
    expect(dests.get(items[0].id)).toBe('ch1')
  })

  it('returns empty for null/empty outline', () => {
    expect(flattenOutline(null).items).toEqual([])
    expect(flattenOutline([]).items).toEqual([])
  })

  it('uses a fallback label for untitled items', () => {
    const { items } = flattenOutline([{ title: '', dest: 'x', items: [] }] as never)
    expect(items[0].label.length).toBeGreaterThan(0)
  })
})
