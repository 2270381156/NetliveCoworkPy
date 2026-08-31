import { describe, it, expect, beforeEach } from 'vitest'
import { buildAgentGroups, NO_AGENT_ID } from './useAgentGroups'
import { hydrateAgents } from '@/agents/registry'
import type { Session } from '@/types'

// 阵容现在是运行期从后端拉的，用例里先填上。顺序即后端给的顺序（它按套件 order 排）。
const LINEUP = [
  { id: 'ipmaster',   display_name: 'IPMaster Cowork',   subtitle: '', accent: '#3b82f6', order: 10 },
  { id: 'coremaster', display_name: 'CoreMaster Cowork', subtitle: '', accent: '#8b5cf6', order: 20 },
  { id: 'mbb',        display_name: 'MBB Cowork',        subtitle: '', accent: '#ec4899', order: 40 },
  { id: 'anmaster',   display_name: 'ANMaster Cowork',   subtitle: '', accent: '#22c55e', order: 60 },
]

beforeEach(() => { hydrateAgents(LINEUP) })

// 三层结构 agent → 项目空间 → 会话。分错组的后果是用户在 A 的名下看到跟 B 的对话，
// 而且不会报错，所以边界逐个钉。

let seq = 0
function ses(template_id: string | null, workspace: string, at = ''): Session {
  seq += 1
  return {
    id: `ses_${String(seq).padStart(3, '0')}`,
    user_prompt: '', goal: '', status: 'SUCCEEDED',
    template_id, root_agent_id: null,
    token_budget: 0, input_tokens_used: 0, output_tokens_used: 0, context_tokens: 0,
    failure_counter: 0, llm_account: null, llm_model: null,
    workspace,
    created_at: at || '2026-08-01T00:00:00Z',
    updated_at: at || '2026-08-01T00:00:00Z',
    last_activity_at: at || '2026-08-01T00:00:00Z',
  } as Session
}

describe('按 agent 分桶', () => {
  it('不同 agent 的会话分到各自的组', () => {
    const groups = buildAgentGroups([
      ses('agent:ipmaster', 'D:/a'),
      ses('agent:coremaster', 'D:/b'),
      ses('agent:ipmaster', 'D:/a'),
    ])
    expect(groups.map(g => [g.id, g.session_count])).toEqual([
      ['ipmaster', 2],
      ['coremaster', 1],
    ])
  })

  it('同一个目录跟两个 agent 聊过 → 两组，各自有自己的项目', () => {
    // 这正是 agent 必须在项目之上的理由：混成一组的话，两段无关的对话会挤在同一个目录下。
    const groups = buildAgentGroups([
      ses('agent:ipmaster', 'D:/shared'),
      ses('agent:mbb', 'D:/shared'),
    ])
    expect(groups).toHaveLength(2)
    for (const g of groups) {
      expect(g.projects).toHaveLength(1)
      expect(g.projects[0].working_dir).toBe('D:/shared')
      expect(g.projects[0].sessions).toHaveLength(1)
    }
  })

  it('组内仍按工作目录聚成项目', () => {
    const groups = buildAgentGroups([
      ses('agent:ipmaster', 'D:/p1'),
      ses('agent:ipmaster', 'D:/p1'),
      ses('agent:ipmaster', 'D:/p2'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].projects.map(p => p.session_count).sort()).toEqual([1, 2])
  })
})

describe('历史会话归主 agent', () => {
  // agent 上线前的会话 template_id 是 default / agent:default，当时产品只有一个 agent。
  // 不认领的话它们不属于任何一组 = 永远不显示，用户历史凭空消失。见 registry.agentOfSession。
  it.each([
    ['旧式 agent:default', 'agent:default'],
    ['旧式 default', 'default'],
    ['template_id 为空', null],
  ])('%s → 归阵容第一个 agent', (_l, tid) => {
    const groups = buildAgentGroups([ses(tid, 'D:/x')])
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('ipmaster')
  })

  it('历史会话与新会话同属主 agent 时并进一组，不各成一组', () => {
    const groups = buildAgentGroups([
      ses('agent:default', 'D:/x'),
      ses('agent:ipmaster', 'D:/x'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].session_count).toBe(2)
  })
})

describe('阵容里已删掉的 agent', () => {
  // 这才是真的「认不出」——不能顺手塞给主 agent，那会把 B 的对话记到 A 名下。
  it('落进「未指定」组', () => {
    const groups = buildAgentGroups([ses('agent:removed', 'D:/x')])
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe(NO_AGENT_ID)
    expect(groups[0].agent).toBeNull()
  })

  it('「未指定」永远垫底', () => {
    const groups = buildAgentGroups([
      ses('agent:removed', 'D:/old'),
      ses('agent:anmaster', 'D:/a'),
      ses('agent:ipmaster', 'D:/b'),
    ])
    expect(groups[groups.length - 1].id).toBe(NO_AGENT_ID)
  })
})

describe('顺序跟着阵容，不跟着活动时间', () => {
  it('晚聊的 agent 不会因为更近就跑到前面', () => {
    // 空态那六张卡片的顺序是用户刚认过的位置；侧栏跟着变会让人每次重新找。
    const groups = buildAgentGroups([
      ses('agent:anmaster', 'D:/a', '2026-08-19T10:00:00Z'),   // 阵容里最后一个，但最近
      ses('agent:ipmaster', 'D:/b', '2026-08-01T10:00:00Z'),   // 阵容里第一个，但最旧
    ])
    expect(groups.map(g => g.id)).toEqual(['ipmaster', 'anmaster'])
  })

  it('只列有会话的 agent —— 空 agent 在侧栏只是噪音', () => {
    const groups = buildAgentGroups([ses('agent:mbb', 'D:/a')])
    expect(groups.map(g => g.id)).toEqual(['mbb'])
  })

  it('空输入 → 空列表，不崩', () => {
    expect(buildAgentGroups([])).toEqual([])
  })
})
