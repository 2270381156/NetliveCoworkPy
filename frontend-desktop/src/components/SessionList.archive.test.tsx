import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * 被收回 cowork 的会话去哪儿了 —— 这一条判错的表现是**记录看起来丢了**（界面上没有任何
 * 入口够得着），比"打开就报错"更彻底，而设计 §3 明确不允许。
 *
 * 只验分档逻辑本身（哪些进归档、哪些留主列表），不渲染整个侧栏：侧栏挂着 react-query、
 * SSE、localStorage 一大串，为一条分档规则把它们全 mock 出来，测的就不是这条规则了。
 */
const brandingAgents: unknown[] = []
vi.mock('@branding', () => ({ default: { get agents() { return brandingAgents } } }))

import { hydrateAgents } from '@/agents/registry'
import { isSessionReadOnly, lineupState, noteLineupFetched } from '@/agents/lineup'

type S = { id: string; template_id: string }

/** 侧栏的分档规则（与 SessionList 同一判据）：归档 = 用户自己归的 ∪ 权限被收回的。 */
function split(sessions: S[], manualArchived: Set<string>) {
  const st = lineupState()
  const revoked = new Set(sessions.filter(s => isSessionReadOnly(s, st)).map(s => s.id))
  const archived = sessions.filter(s => manualArchived.has(s.id) || revoked.has(s.id))
  const main = sessions.filter(s => !manualArchived.has(s.id) && !revoked.has(s.id))
  return { archived: archived.map(s => s.id), main: main.map(s => s.id), revoked }
}

const dto = (id: string) => ({ id, display_name: id, subtitle: '', accent: '#000', order: 1 })
const ses = (id: string, tpl: string): S => ({ id, template_id: tpl })

beforeEach(() => {
  brandingAgents.length = 0
  brandingAgents.push({ id: 'ipmaster' })
  noteLineupFetched(true)
})

describe('被收回 cowork 的会话进归档', () => {
  const all = [
    ses('a', 'agent:ipmaster'),
    ses('b', 'agent:coremaster'),
    ses('c', 'agent:mbb'),
    ses('d', 'agent:default'),
  ]

  test('只开通了 ipmaster：别人的会话进归档，自己的留主列表', () => {
    hydrateAgents([dto('ipmaster')])
    const r = split(all, new Set())
    expect(r.main).toEqual(['a', 'd'])          // d 是母版会话，谁的权限都收不回它
    expect(r.archived).toEqual(['b', 'c'])
  })

  test('一个 cowork 都没开通：之前的会话全进归档', () => {
    // 这条推翻了早先"零 cowork 时列表保持平铺"的决定（2026-08-22 改判）。
    hydrateAgents([])
    const r = split(all, new Set())
    expect(r.main).toEqual(['d'])
    expect(r.archived).toEqual(['a', 'b', 'c'])
  })

  test('权限恢复后自己回主列表，不需要清任何标记', () => {
    hydrateAgents([dto('ipmaster')])
    expect(split(all, new Set()).archived).toContain('c')
    hydrateAgents([dto('ipmaster'), dto('mbb')])
    const r = split(all, new Set())
    expect(r.archived).not.toContain('c')
    expect(r.main).toContain('c')
  })

  test('用户自己归档的照旧，与权限无关', () => {
    hydrateAgents([dto('ipmaster')])
    const r = split(all, new Set(['a']))
    expect(r.archived).toEqual(['a', 'b', 'c'])
    expect(r.main).toEqual(['d'])
  })

  test('阵容没拉到时一条都不进归档', () => {
    // 我们只是不知道，不是"没有"。一次网络抖动把用户所有会话扫进归档，比什么都不做糟得多。
    hydrateAgents([])
    noteLineupFetched(false)
    expect(split(all, new Set()).archived).toEqual([])
  })
})
