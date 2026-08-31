import { describe, test, expect, beforeEach, vi } from 'vitest'

// 三种"一个 cowork 都没有"在数据上长得一样（空数组），但对用户意味着完全不同的事。
// 判错了不会报任何东西：权限没配好的人会以为产品就长这样，或者后端没起来的人跑去申请权限。

// 本分支的判据是**显式声明**，不是构建期阵容：cowork 按权限运行期下发，品牌文件里没有阵容。
let coworkLayer: boolean | undefined
vi.mock('@branding', () => ({ default: { get hasCoworkLayer() { return coworkLayer } } }))

import { hydrateAgents } from './registry'
import { lineupState, canStartSession, noteLineupFetched } from './lineup'

beforeEach(() => {
  coworkLayer = undefined                   // 缺省即"有这一层"（漏写一个键不该让它悄悄消失）
  hydrateAgents([])
  noteLineupFetched(false)                  // 先置成已知状态，避免用例间串味
})

const dto = (id: string) => ({ id, display_name: id, subtitle: '', accent: '#000', order: 1 })

describe('阵容状态', () => {
  test('拉到了且非空 → ready', () => {
    hydrateAgents([dto('ipmaster')])
    expect(lineupState()).toBe('ready')
    expect(canStartSession()).toBe(true)
  })

  test('拉到了但是空 → none（没权限，重试没用）', () => {
    noteLineupFetched(true)
    expect(lineupState()).toBe('none')
    // 不拦的话会建出一条跑母版模板的会话：不属于任何 cowork，界面上无名无姓。
    expect(canStartSession()).toBe(false)
  })

  test('没拉到 → unreachable（故障，重试可能就好了）', () => {
    noteLineupFetched(false)
    expect(lineupState()).toBe('unreachable')
    expect(canStartSession()).toBe(false)
  })

  test('构建本来就没有 cowork 这一层 → brandless，一切照旧', () => {
    // 衍生品牌的单 agent 形态：空阵容是正常状态，不该显示"尚未开通"，更不该禁掉新建。
    coworkLayer = false
    expect(lineupState()).toBe('brandless')
    expect(canStartSession()).toBe(true)
  })

  test('判据是构建期有没有这一层，不是运行期清单', () => {
    // 拿运行期清单当判据是循环的：清单为空正是要区分的那件事本身。
    coworkLayer = false
    noteLineupFetched(true)
    expect(lineupState()).toBe('brandless')
  })
})

// ── 只读推导 ─────────────────────────────────────────────────────────────────
// 只读 ≡ 这条会话的 cowork 此刻不在可用集合里（设计文档 §3）。会话记录里没有 read_only
// 字段——加了就得在权限恢复时清掉，而"该清没清"是个静默故障：权限回来了会话却永远只读。

import { isSessionReadOnly } from './lineup'

describe('会话只读', () => {
  test('cowork 还在 → 可用', () => {
    hydrateAgents([dto('mbb')])
    expect(isSessionReadOnly({ template_id: 'agent:mbb' })).toBe(false)
  })

  test('cowork 没了 → 只读', () => {
    hydrateAgents([dto('ipmaster')])
    expect(isSessionReadOnly({ template_id: 'agent:mbb' })).toBe(true)
  })

  test('权限恢复后自己活过来，不需要清任何状态', () => {
    hydrateAgents([dto('ipmaster')])
    const s = { template_id: 'agent:mbb' }
    expect(isSessionReadOnly(s)).toBe(true)
    hydrateAgents([dto('ipmaster'), dto('mbb')])
    expect(isSessionReadOnly(s)).toBe(false)
  })

  test('母版 default 的历史会话不算只读', () => {
    // 它不是 cowork，没有谁的权限能收回它；判成只读会让一批老会话集体锁死。
    hydrateAgents([dto('ipmaster')])
    expect(isSessionReadOnly({ template_id: 'agent:default' })).toBe(false)
    expect(isSessionReadOnly({ template_id: 'default' })).toBe(false)
  })

  test('阵容没拉到时不判只读', () => {
    // 我们只是**不知道**，不是"没有"。判只读会把一次网络抖动显示成"你的权限被收回了"，
    // 而后端那边其实好好的。
    hydrateAgents([])
    noteLineupFetched(false)
    expect(isSessionReadOnly({ template_id: 'agent:mbb' })).toBe(false)
  })

  test('没有 cowork 这一层的构建里，一切照旧', () => {
    coworkLayer = false
    hydrateAgents([])
    expect(isSessionReadOnly({ template_id: 'agent:mbb' })).toBe(false)
  })

  test('一个都没开通时，历史会话全部只读', () => {
    hydrateAgents([])
    noteLineupFetched(true)
    expect(isSessionReadOnly({ template_id: 'agent:mbb' })).toBe(true)
  })
})
