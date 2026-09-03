/** 市场按下载量排序：null 和 0 是两回事。
 *
 * netcowork 那个市场回 downloadCount，自建那套**根本不回这个字段**。两个市场都摆在
 * 技能中心里，所以列表里天然混着 `null` 和真实数字。
 *
 * 把 null 当 0 排，一整批"这个市场没这项数据"的条目会跟真正的冷门 skill 混在一起，
 * 用户看到的是"排序好像没生效"。这里钉的就是：**没有数据的一律沉底**，有数据的按数
 * 排，而 0 是真实数据、排在有数据那一段的末尾，不跟 null 混。
 */
import { describe, it, expect } from 'vitest'
import { byDownloadsDesc } from './SkillsPage'
import type { RemoteCatalogItem } from '@/api/skills'

const item = (name: string, download_count?: number | null): RemoteCatalogItem => ({
  source: 'netcowork' as RemoteCatalogItem['source'],
  id: name, name, description: null, updater: null, reference_id: name,
  create_time: null, is_pulled: false, download_count,
})

const order = (items: RemoteCatalogItem[]) =>
  [...items].sort(byDownloadsDesc).map(i => i.name)

describe('按下载量排序', () => {
  it('数字从高到低', () => {
    expect(order([item('a', 3), item('b', 99), item('c', 12)])).toEqual(['b', 'c', 'a'])
  })

  it('0 是真实数据，排在有数据那一段的末尾', () => {
    expect(order([item('zero', 0), item('some', 5)])).toEqual(['some', 'zero'])
  })

  it('**null 沉到 0 后面** —— 没有数据不等于没人下过', () => {
    expect(order([item('unknown', null), item('zero', 0)])).toEqual(['zero', 'unknown'])
  })

  it('字段整个缺失（undefined）与 null 同等对待', () => {
    expect(order([item('missing'), item('zero', 0)])).toEqual(['zero', 'missing'])
  })

  it('全是 null 时保持原顺序，不无端打乱', () => {
    expect(order([item('a', null), item('b', null), item('c', null)]))
      .toEqual(['a', 'b', 'c'])
  })

  it('混排：有数据的在前按数降序，没数据的整体沉底', () => {
    expect(order([
      item('n1', null), item('big', 100), item('zero', 0), item('n2', null), item('mid', 7),
    ])).toEqual(['big', 'mid', 'zero', 'n1', 'n2'])
  })
})
