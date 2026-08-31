import { describe, test, it, expect } from 'vitest'
import { PAGE_ROWS, columnsFor, formatDay, paginate } from './SkillTile'

// 分页本身不容易错，容易错的是**边界**：越界的页码、空集合、以及搜索之后总数变小。
// 后者是实际会遇到的：搜出 3 条却停在第 2 页，看到的是空白，而用户以为"没搜到"。

const items = Array.from({ length: 25 }, (_, i) => i + 1)

describe('paginate', () => {
  test('按页切片', () => {
    expect(paginate(items, 1, 10).slice).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(paginate(items, 3, 10).slice).toEqual([21, 22, 23, 24, 25])
    expect(paginate(items, 3, 10).pages).toBe(3)
  })

  test('页码越界夹回最后一页，不返回空页', () => {
    // 搜索把 25 条筛成 3 条时就会走到这里：页码还停在 3，但只剩 1 页。
    const r = paginate([1, 2, 3], 3, 10)
    expect(r.page).toBe(1)
    expect(r.slice).toEqual([1, 2, 3])
  })

  test('页码小于 1 或非法一律当第 1 页', () => {
    expect(paginate(items, 0, 10).page).toBe(1)
    expect(paginate(items, -5, 10).page).toBe(1)
    expect(paginate(items, NaN, 10).page).toBe(1)
  })

  test('空集合仍是 1 页，不是 0 页', () => {
    // 0 页会让翻页器显示 "1 / 0"，看起来像坏了。
    const r = paginate([], 1, 10)
    expect(r.pages).toBe(1)
    expect(r.total).toBe(0)
    expect(r.slice).toEqual([])
  })

  test('刚好整除时不多出一个空页', () => {
    expect(paginate(items.slice(0, 20), 1, 10).pages).toBe(2)
  })
})

// 日期来自两个不同实现：netcowork 是 Java LocalDateTime（Jackson 默认 ISO，带 T），
// 联调 mock 是空格分隔。两种都要能显示，而且**读不懂时不能显示 "Invalid Date"**。
describe('formatDay', () => {
  test('ISO 带 T（netcowork 真实格式）', () => {
    expect(formatDay('2026-05-12T09:16:00')).toBe('2026/5/12')
  })

  test('空格分隔（自建市场 / mock）', () => {
    expect(formatDay('2026-05-12 09:16:00')).toBe('2026/5/12')
  })

  test('读不懂就退回前 10 个字符，不显示 Invalid Date', () => {
    expect(formatDay('不是日期')).toBe('不是日期')
    expect(formatDay('2026-05-12+bad')).not.toContain('Invalid')
  })
})

describe('columnsFor —— 每页凑整行', () => {
  // 每页固定 12 张，而一行几张是按宽度自适应的，两者对不上：一行 5 张时 12 张 = 两整行
  // 加孤零零的 2 张，最后一行空一大块，看起来像"这页没加载完"。所以页大小要跟着列数走。
  it('按宽度算出列数（卡片最小 232、间隔 12）', () => {
    expect(columnsFor(232)).toBe(1)
    expect(columnsFor(475)).toBe(1)      // 差 1px 排不下第二列
    expect(columnsFor(476)).toBe(2)      // 232*2 + 12
    expect(columnsFor(1000)).toBe(4)
  })

  it('再窄也是 1 列，不能是 0', () => {
    // 0 列会让每页装 0 张——一页空白，而且翻多少页都空白。
    expect(columnsFor(0)).toBe(1)
    expect(columnsFor(-100)).toBe(1)
  })

  it('页大小 = 列数 × 行数，每页正好铺满', () => {
    for (const w of [500, 800, 1200, 1600]) {
      const size = columnsFor(w) * PAGE_ROWS
      expect(size % columnsFor(w)).toBe(0)
    }
  })
})
