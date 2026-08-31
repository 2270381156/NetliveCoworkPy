// 「排队待发送」消息的全局存放处（模块级、仅内存、不落盘）。
//
// 为什么不放在 ChatPanel 的 state 里：
//   1) 队列要跨会话切换/切到设置页存活——ChatPanel 会随之重挂，state 存不住；
//   2) 更关键的是「谁来发」：ChatPanel 只订阅当前会话的 SSE，看不到别的会话什么时候空闲。
//      真正的发送方是 useQueueDrainer（挂在 Desktop 上，用 3s 轮询的会话列表做信号源），
//      它要能读到所有会话的队列，所以队列必须住在组件树之外。
// 不落盘是有意的：重启后再自动发出几天前排的队，比丢掉更危险。

import { stripSkillPrefix } from './skillCommand'

export interface QueuedMessage {
  id: string                // React key / 删除定位（消息内容可能重复，不能用下标或文本）
  text: string              // 用户原始输入，列表里展示的就是它
  prompt: string            // 去掉 /skill 前缀后的正文
  skillName: string | null  // /skill 绑定，provider-qualified（发送时进 initial_task）
  provider: string | null   // 入队那一刻的模型选择——延后发送时不能改用别的会话的当前选择
  model: string | null
}

const queues = new Map<string, QueuedMessage[]>()
const listeners = new Set<() => void>()
// 稳定空引用：useSyncExternalStore 的 getSnapshot 必须返回稳定引用，否则无限重渲染。
const EMPTY: readonly QueuedMessage[] = Object.freeze([])

let seq = 0

function emit() { for (const l of listeners) l() }

export function subscribeQueues(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getQueue(sessionId: string | null): readonly QueuedMessage[] {
  return (sessionId ? queues.get(sessionId) : null) ?? EMPTY
}

export function setQueue(sessionId: string, next: readonly QueuedMessage[]): void {
  if (next.length > 0) queues.set(sessionId, [...next])
  else queues.delete(sessionId)
  emit()
}

export function enqueue(sessionId: string, msg: Omit<QueuedMessage, 'id'>): void {
  const next = [...getQueue(sessionId), { ...msg, id: `q${++seq}` }]
  queues.set(sessionId, next)
  emit()
}

/** 发送成功后按 id 摘掉那一条（不能按下标：等待期间用户可能删了/加了别的）。 */
export function removeQueued(sessionId: string, msgId: string): void {
  setQueue(sessionId, getQueue(sessionId).filter(m => m.id !== msgId))
}

/** 有待发送消息的会话 id 列表——drainer 每轮只需检查这几个会话。 */
export function queuedSessionIds(): string[] {
  return [...queues.keys()]
}

/** 会话已从列表里消失（被删）→ 它的队列也跟着清掉，别再往一个不存在的会话发。 */
export function pruneQueues(aliveIds: ReadonlySet<string>): void {
  let changed = false
  for (const id of queues.keys()) {
    if (!aliveIds.has(id)) { queues.delete(id); changed = true }
  }
  if (changed) emit()
}

// PAUSED 软待命回复不新起 run → 不能硬绑 skill；改为在回复里带一句自然语言指令，让 agent
// 自主调用该 skill。ChatPanel 的即时发送与 drainer 的自动发送共用，避免两处措辞漂移。
export function pausedReplyText(prompt: string, skillName: string | null, raw: string): string {
  // skillName 是发给后端的 qualified 名（local_skill__xxx），给 agent 看的提示语要去前缀。
  return skillName ? `${prompt}\n\n（请使用「${stripSkillPrefix(skillName)}」skill 来完成本次任务）` : raw
}
