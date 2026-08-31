/**
 * 阵容状态 —— "现在到底是没有 cowork 这一层，还是你一个都没开通，还是根本没拉到"。
 *
 * 三者在数据上长得一模一样（`getAgents()` 都是空数组），但对用户意味着完全不同的事，
 * 界面必须分得开（设计文档 §4.4）：
 *
 *   brandless    这个构建本来就没有 cowork 这一层（衍生品牌，单 agent 形态）→ 通用文案，一切正常
 *   unreachable  清单没拉到（后端没起来/网络）→ **故障**，重试可能就好了
 *   none         拉到了，但一个都没有 → **没权限**，重试一万次也没用，得去申请
 *
 * 混同的代价很实：把 none 显示成"一切正常"，权限没配好的用户会以为产品就长这样，一直用着
 * 那个没有名字的通用 agent；把 unreachable 显示成"尚未开通"，后端没起来的人会跑去申请权限。
 *
 * 判据必须是**构建期**的，不能是运行期的清单——运行期清单为空正是要区分的那件事本身，
 * 拿它当判据是循环的。
 *
 * demo/experimental 用的是 `branding.agents`（把阵容烤进品牌文件）。本分支不能这么判：
 * cowork 是**运行期按权限下发**的套件，品牌文件里根本没有阵容，那样判会让每个构建都是
 * brandless，cowork 这一层在界面上整个消失。改成**显式声明** `hasCoworkLayer`，缺省为
 * true——衍生品牌要去掉这一层是件需要明写的事，而不是漏写一个键就悄悄发生。
 */
import { useSyncExternalStore } from 'react'

import branding from '@branding'   // 只用来判断"这个构建有没有 cowork 这一层"

import { agentById, agentIdFromTemplate, getAgents, subscribeAgents } from './registry'

export type LineupState = 'pending' | 'ready' | 'none' | 'unreachable' | 'brandless'

type Fetch = 'pending' | 'ok' | 'error'

let fetched: Fetch = 'pending'
const listeners = new Set<() => void>()

function emit() { for (const fn of listeners) fn() }

/** 启动拉清单之后调一次（见 main.tsx）。**不调的话状态永远停在 pending**，界面上表现为
 *  空态一直转圈——所以这个调用不是可选的收尾动作。 */
export function noteLineupFetched(ok: boolean): void {
  fetched = ok ? 'ok' : 'error'
  emit()
}

function hasCoworkLayer(): boolean {
  return (branding as { hasCoworkLayer?: boolean }).hasCoworkLayer !== false
}

export function lineupState(): LineupState {
  if (getAgents().length > 0) return 'ready'
  if (!hasCoworkLayer()) return 'brandless'
  if (fetched === 'pending') return 'pending'
  return fetched === 'error' ? 'unreachable' : 'none'
}

/** 能不能建新会话。没开通/没拉到时不能——不拦的话会建出一个跑母版模板的会话：它不是任何
 *  cowork，界面上无名无姓，用户却以为自己在正常使用产品。 */
export function canStartSession(state: LineupState = lineupState()): boolean {
  return state === 'ready' || state === 'brandless'
}

subscribeAgents(emit)

/**
 * 这条会话是不是**只读** —— 它的 cowork 此刻不在我的可用集合里（设计文档 §3）。
 *
 * 推导，不看字段：会话记录里从来没有 `read_only`。加了就得在权限恢复时清掉，而"该清没清"
 * 是个静默故障——权限回来了，会话却永远停在只读。推导式没有状态要维护，套件装回来判据自动
 * 变回 false，会话自己就活了（后端同一套判据，见 sessions._cowork_missing）。
 *
 * 只在阵容**确知**时判：
 *   · brandless —— 这个构建没有 cowork 这一层，会话本来就不归属任何 cowork，全判只读就废了；
 *   · pending / unreachable —— 我们只是**不知道**，不是"没有"。此时判只读会把一次网络抖动
 *     显示成"你的权限被收回了"，而后端那边其实好好的。
 *
 * 母版 `default` 的历史会话不算：它不是 cowork，没有谁的权限能收回它。
 */
export function isSessionReadOnly(
  session: { template_id?: string | null } | null | undefined,
  state: LineupState = lineupState(),
): boolean {
  if (state !== 'ready' && state !== 'none') return false
  const id = agentIdFromTemplate(session?.template_id)
  if (!id || id === 'default') return false
  return agentById(id) === null
}

export function useLineupState(): LineupState {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    lineupState,
    lineupState,
  )
}
