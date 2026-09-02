import { describe, expect, it } from 'vitest'

import { catalogReferenceId, type RemoteCatalogItem } from '@/api/skills'

/** 引用身份必须来自后端：同一 source/id 在通用与专属市场是两条不同的引用，
 *  前端自拼 `${source}:${id}` 会把两个市场的"已引用"状态串台。 */
describe('catalogReferenceId', () => {
  it('matches installed references with backend-provided scoped ids', () => {
    const general = { source: 'mythos', id: '1129', reference_id: 'ref:v3:general' }
    const scoped = { source: 'mythos', id: '1129', reference_id: 'ref:v3:ipmaster' }
    expect(catalogReferenceId(general as RemoteCatalogItem)).not.toBe(
      catalogReferenceId(scoped as RemoteCatalogItem),
    )
  })

  it('returns the backend identity as-is, never synthesizes a key', () => {
    const item = { source: 'cowork', id: 'c-1', reference_id: 'ref:v3:abc' }
    expect(catalogReferenceId(item as RemoteCatalogItem)).toBe('ref:v3:abc')
  })

  it('distinguishes entries that only differ by id (same market)', () => {
    const a = { source: 'cowork', id: '1', reference_id: 'ref:v3:one' }
    const b = { source: 'cowork', id: '2', reference_id: 'ref:v3:two' }
    expect(catalogReferenceId(a as RemoteCatalogItem)).not.toBe(
      catalogReferenceId(b as RemoteCatalogItem),
    )
  })
})
