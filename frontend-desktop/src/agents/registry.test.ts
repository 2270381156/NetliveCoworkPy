import { describe, it, expect, beforeEach } from 'vitest'
import {
  agentById, agentIdFromTemplate, agentOfSession, defaultAgent, getAgents,
  hydrateAgents, subscribeAgents, templateIdOf, type CoworkDTO,
} from './registry'

// 阵容现在是**运行期从后端拉**的（GET /api/v1/coworks），不再构建期内联。
// 这一层是「有哪些 agent」「这条会话归谁」的唯一真值来源，认错人的后果是用户在 A 的名下
// 看到 B 的会话，而且不报错——所以边界逐个钉死。

const ROWS: CoworkDTO[] = [
  { id: 'ipmaster',   display_name: 'IPMaster Cowork',   subtitle: 'IP 网络',  accent: '#3b82f6', order: 10 },
  { id: 'coremaster', display_name: 'CoreMaster Cowork', subtitle: '核心网',   accent: '#8b5cf6', order: 20 },
  { id: 'mbb',        display_name: 'MBB Cowork',        subtitle: '无线宽带', accent: '#ec4899', order: 40 },
]

beforeEach(() => { hydrateAgents(ROWS) })

describe('阵容来自 branding.json', () => {
  it('用后端给的清单填充，顺序沿用后端（它按套件 order 排）', () => {
    expect(getAgents().map(a => a.id)).toEqual(['ipmaster', 'coremaster', 'mbb'])
  })

  it('拉到之前是空的 —— 不能有构建期兜底阵容', () => {
    // 有兜底的话，用户装了两个 cowork 也会先看到打包时那七个，然后才「收走」五个。
    hydrateAgents([])
    expect(getAgents()).toEqual([])
    expect(defaultAgent()).toBeNull()
  })

  it('阵容到达时通知订阅者', () => {
    let hits = 0
    const off = subscribeAgents(() => { hits += 1 })
    hydrateAgents(ROWS)
    expect(hits).toBe(1)
    off()
    hydrateAgents(ROWS)
    expect(hits).toBe(1)          // 退订后不再收到
  })

  it('同 id 出现两次只保留先出现的', () => {
    hydrateAgents([...ROWS, { ...ROWS[0], display_name: '冒名的' }])
    expect(getAgents().filter(a => a.id === 'ipmaster')).toHaveLength(1)
    expect(getAgents()[0].displayName).toBe('IPMaster Cowork')
  })

  it('名字缺失退回 id，好过显示空白', () => {
    hydrateAgents([{ id: 'x', display_name: '  ', subtitle: '', accent: '', order: 1 }])
    expect(getAgents()[0].displayName).toBe('x')
  })

  it('没给色标时用兜底色 —— 少个颜色不该让界面开天窗', () => {
    hydrateAgents([{ id: 'x', display_name: 'X', subtitle: '', accent: '', order: 1 }])
    expect(getAgents()[0].accent).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('主 agent 是阵容里第一个', () => {
    expect(defaultAgent()?.id).toBe('ipmaster')
  })
})

describe('template_id 互转', () => {
  it('拼出后端认识的形态', () => {
    expect(templateIdOf('ipmaster')).toBe('agent:ipmaster')
  })

  it('往返一致', () => {
    for (const a of getAgents()) {
      expect(agentIdFromTemplate(templateIdOf(a.id))).toBe(a.id)
    }
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空串', ''],
    ['没有 agent: 前缀', 'default'],
    ['只有前缀没有 id', 'agent:'],
    ['前缀后面全是空格', 'agent:   '],
    ['别的前缀', 'skill:ipmaster'],
  ])('%s → null', (_label, input) => {
    expect(agentIdFromTemplate(input as string | null)).toBeNull()
  })
})

describe('会话归属', () => {
  it('认得出阵容里的 agent', () => {
    expect(agentOfSession({ template_id: 'agent:coremaster' })?.displayName).toBe('CoreMaster Cowork')
  })

  // agent 上线前的历史会话认领给主 agent。当时产品只有一个 agent，这些会话本来就是它的；
  // 全局切换模式下不认领就等于永远不显示（用户历史凭空消失）。
  // 注意"主 agent"现在是**运行期**阵容的第一个，阵容没拉到时它是 null。
  it.each([
    ['旧式 default', { template_id: 'default' }],
    ['旧式 agent:default', { template_id: 'agent:default' }],
    ['template_id 为空', { template_id: null }],
    ['字段缺失', {}],
  ])('历史会话 %s → 归主 agent', (_label, session) => {
    expect(agentOfSession(session)?.id).toBe('ipmaster')
  })

  it('agentIdFromTemplate 仍如实解析，不做认领（认领只发生在 agentOfSession）', () => {
    expect(agentIdFromTemplate('agent:default')).toBe('default')
  })

  // 阵容里被删掉的 agent 仍返回 null：那是真的「认不出」，不能顺手塞给主 agent。
  it('阵容里没有的 id → null', () => {
    expect(agentOfSession({ template_id: 'agent:nosuch' })).toBeNull()
  })

  it('agentById 对未知 id 不抛', () => {
    expect(agentById('nosuch')).toBeNull()
    expect(agentById(null)).toBeNull()
  })
})
