/**
 * useAgentGroups —— 会话列表的三层结构：**agent → 项目空间 → 会话**。
 *
 * agent 在项目之上：同一个项目目录可以既跟 IPMaster 聊过、又跟 CoreMaster 聊过，那是
 * 两组不同的对话，不该混在一个分组里。所以先按 agent 分桶，再在每个桶内部按工作目录
 * 聚成项目（复用 buildProjects，不另写一套规则）。
 *
 * 与 useProjectGroups 一样是前端聚合、后端无实体（Smart B）。将来后端有了 agent 维度的
 * 查询，把这里换成一次 API 调用即可，UI 不动。
 */

import { useMemo } from 'react'
import type { Session } from '@/types'
import { getAgents, agentOfSession, type Agent } from '@/agents/registry'
import { buildProjects, sessionActivityTime, type Project } from './useProjectGroups'

/**
 * 真的认不出归属的会话归到这一组——目前只剩「阵容里已被删掉的 agent」一种。
 * agent 上线前的历史会话不在此列：它们由 registry.agentOfSession 认领给主 agent，
 * 否则不属于任何组等于永远不显示。
 */
export const NO_AGENT_ID = '_no_agent'

export interface AgentGroup {
  /** agent.id，或 NO_AGENT_ID。 */
  id: string
  /** NO_AGENT_ID 组为 null。 */
  agent: Agent | null
  projects: Project[]
  session_count: number
  last_accessed_at: string
}

/**
 * 按 branding 里的阵容顺序排，而不是按最近活动排。
 *
 * 侧栏顺序要跟空态那六张卡片一致——用户刚在卡片上认了位置，进来发现顺序变了就得重新找。
 * 「未指定」永远垫底。
 */
// 每次现算，**不能提到模块顶层**：阵容是运行期异步到达的，模块级常量会永远停在
// 加载那一刻的空数组上——表现为所有 agent 都排到「阵容里没有的」那一档去。
function orderIndex(): Map<string, number> {
  return new Map(getAgents().map((a, i) => [a.id, i]))
}

export function buildAgentGroups(sessions: Session[]): AgentGroup[] {
  const buckets = new Map<string, Session[]>()
  for (const s of sessions) {
    const id = agentOfSession(s)?.id ?? NO_AGENT_ID
    const list = buckets.get(id) ?? []
    list.push(s)
    buckets.set(id, list)
  }

  const groups: AgentGroup[] = []
  for (const [id, sess] of buckets) {
    const projects = buildProjects(sess)
    // 组的时间取组内最新一条会话的活动时间——用于展示，不参与排序（顺序跟着阵容走）。
    const newest = sess.reduce(
      (acc, s) => (sessionActivityTime(s) > acc ? sessionActivityTime(s) : acc), '')
    groups.push({
      id,
      agent: id === NO_AGENT_ID ? null : (getAgents().find(a => a.id === id) ?? null),
      projects,
      session_count: sess.length,
      last_accessed_at: newest,
    })
  }

  // 只列**有会话**的 agent：侧栏是历史记录，空 agent 在这里只是噪音，入口在空态卡片那边。
  const ORDER = orderIndex()
  groups.sort((a, b) => {
    if (a.id === NO_AGENT_ID) return 1
    if (b.id === NO_AGENT_ID) return -1
    const ai = ORDER.get(a.id), bi = ORDER.get(b.id)
    // 阵容里没有的 id（配置改过、会话还在）排在已知 agent 之后、「未指定」之前。
    if (ai === undefined && bi === undefined) return a.id.localeCompare(b.id)
    if (ai === undefined) return 1
    if (bi === undefined) return -1
    return ai - bi
  })
  return groups
}

export function useAgentGroups(sessions: Session[]): AgentGroup[] {
  return useMemo(() => buildAgentGroups(sessions), [sessions])
}
