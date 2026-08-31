/**
 * 全局「当前 agent」—— 整个应用同一时刻只跟一个 agent 打交道。
 *
 * 为什么是全局而不是每条会话各自选：agent 不是会话的一个参数，而是**用户此刻在哪个世界里**
 * ——会话列表、新建会话、顶栏身份全都跟着它走。像换 workspace，不像改设置项。
 * （底层不变：会话仍各自带 template_id，这层只决定"看谁的、建给谁"。）
 *
 * 选择记在 localStorage：切换是低频动作，重启后回到上次那个才符合直觉。
 */

import { useCallback, useSyncExternalStore } from 'react'
import { getAgents, defaultAgent, agentById, subscribeAgents, type Agent } from './registry'

const STORAGE_KEY = 'netlive.currentAgent.v1'

// 模块级单例 + 订阅：抽屉、侧边栏、顶栏分散在组件树各处，用 context 得把 Provider 提到根上
// 再层层传；这里的状态只是一个 id，用 useSyncExternalStore 更省事，也不会因 Provider 重渲染
// 波及整棵树。
let current: Agent | null = readStored()
const listeners = new Set<() => void>()

function readStored(): Agent | null {
  try {
    const saved = agentById(localStorage.getItem(STORAGE_KEY))
    if (saved) return saved
  } catch {
    // localStorage 不可用（隐私模式/配额）→ 当作没存过，退到默认
  }
  return defaultAgent()
}

function emit() { for (const l of listeners) l() }

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** 切到某个 agent。传入阵容里没有的 id 时忽略——宁可停在原地，也不要把界面切成空白。 */
export function setCurrentAgent(id: string): void {
  const next = agentById(id)
  if (!next || next.id === current?.id) return
  current = next
  try { localStorage.setItem(STORAGE_KEY, next.id) } catch { /* 存不下不影响本次切换 */ }
  emit()
}

function getSnapshot(): Agent | null { return current }

// 阵容是**运行期**到达的：模块加载那一刻它还是空的，所以上面的 current 必然解析成 null。
// 阵容一到就重解一次，否则界面会永远停在"没有当前 agent"——而这个错不报任何东西。
// 无条件 emit：阵容变了即使当前 agent 没变，读 getAgents() 的地方（如抽屉的列表）也要重渲染。
subscribeAgents(() => {
  current = readStored()
  emit()
})

/** 当前 agent。阵容为空（衍生品牌没配 agent）→ null，调用方退回「没有 agent 这一层」的旧形态。 */
export function useCurrentAgent(): Agent | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 当前 agent + 切换函数，给抽屉这类既要读又要写的地方。 */
export function useAgentSwitch(): { current: Agent | null; agents: readonly Agent[]; switchTo: (id: string) => void } {
  const cur = useCurrentAgent()
  const switchTo = useCallback((id: string) => setCurrentAgent(id), [])
  return { current: cur, agents: getAgents(), switchTo }
}
