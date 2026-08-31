/** 当前阵容（已开通的 cowork）。阵容是运行期到达的，所以订阅着取，别在模块顶层捕获。 */
import { useSyncExternalStore } from 'react'

import { getAgents, subscribeAgents, type Agent } from './registry'

export function useAgents(): readonly Agent[] {
  // getAgents 返回的是模块级那一份引用，只在 hydrate 时整体替换——可以直接当快照用。
  return useSyncExternalStore(subscribeAgents, getAgents, getAgents)
}

export type { Agent }
