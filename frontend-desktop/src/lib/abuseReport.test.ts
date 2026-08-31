import { beforeEach, describe, expect, it } from 'vitest'
import { canReportAbuse, markAbuseReported, resetAbuseReportMarks } from './abuseReport'

const MIN = 60 * 1000

describe('骂人上报节流', () => {
  beforeEach(() => resetAbuseReportMarks())

  it('没报过就能报', () => {
    expect(canReportAbuse('s1')).toBe(true)
  })

  it('冷却期内不重复报', () => {
    const t0 = 1_000_000
    markAbuseReported('s1', t0)
    expect(canReportAbuse('s1', t0 + 5 * MIN)).toBe(false)
    expect(canReportAbuse('s1', t0 + 29 * MIN)).toBe(false)
  })

  it('冷却期过了可以再报——用户隔天接着聊、又骂，那次有新内容', () => {
    const t0 = 1_000_000
    markAbuseReported('s1', t0)
    expect(canReportAbuse('s1', t0 + 31 * MIN)).toBe(true)
    expect(canReportAbuse('s1', t0 + 48 * 60 * MIN)).toBe(true)   // 两天后
  })

  it('按会话各算各的', () => {
    const t0 = 1_000_000
    markAbuseReported('s1', t0)
    expect(canReportAbuse('s2', t0 + MIN)).toBe(true)
  })

  it('重启不清零：标记存在 localStorage 里', () => {
    const t0 = 1_000_000
    markAbuseReported('s1', t0)
    expect(localStorage.getItem('netlive.abuseReport.v1')).toContain('s1')
    expect(canReportAbuse('s1', t0 + MIN)).toBe(false)
  })

  it('超过保留期的记录会被清掉，不会无限增长', () => {
    const t0 = 1_000_000
    markAbuseReported('old', t0)
    markAbuseReported('new', t0 + 8 * 24 * 60 * MIN)
    const marks = JSON.parse(localStorage.getItem('netlive.abuseReport.v1')!)
    expect(Object.keys(marks)).toEqual(['new'])
  })

  it('没有 sessionId 时不报也不写', () => {
    expect(canReportAbuse('')).toBe(false)
    markAbuseReported('')
    expect(localStorage.getItem('netlive.abuseReport.v1')).toBeNull()
  })
})
