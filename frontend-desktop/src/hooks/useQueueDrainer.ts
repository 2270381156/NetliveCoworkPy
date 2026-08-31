// 排队待发送消息的唯一发送方。
//
// 信号源为什么是轮询的会话列表：与 useSessionNotifications 同理——App 只对「当前选中且正在
// 看聊天」的会话开 SSE，切走就断流。而队列最需要的恰恰是「用户没在看的那个会话跑完了，
// 把排的消息发出去」。GET /sessions（SessionList 里 refetchInterval 3s）是唯一覆盖全部会话
// 的信号源；React Query 按 key 去重，复用同一份缓存，不增加请求。代价是最多 3s 延迟。
//
// 正在看的那个会话不用等这 3s：ChatPanel 收到 SSE 的「忙→闲」边沿会直接调 requestDrain()
// 立刻发。两条路都走下面同一个 drainOne（同一把 sending 锁），不会重复发。
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sessionsApi } from '@/api/sessions'
import { hitlApi } from '@/api/hitl'
import { resolveHitlId } from '@/lib/hitlTarget'
import {
  getQueue, queuedSessionIds, pruneQueues, removeQueued, subscribeQueues,
  pausedReplyText, type QueuedMessage,
} from '@/lib/messageQueue'
import type { AuthUser, Session, SessionStatus } from '@/types'

// 可以自动发出的状态 = 「这一轮真干完了、且会话还能正常接新消息」。
// 忙(RUNNING/QUEUED/PAUSED_HITL/WAITING_INPUT)自不必说；INTERRUPTED 要先 resume、
// CANCELED 是用户自己叫停的、FAILED 要用户决定是否继续——这几种都把队列留在界面上等人处理，
// 不擅自替用户把消息灌进去。
const DRAINABLE: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['PAUSED', 'SUCCEEDED'])

// 每个会话同时只允许一条在飞（FIFO 的「逐条发」靠它保证），跨两条触发路径共用。
const sending = new Set<string>()
// 发送失败（后端重启等瞬时错误）→ 消息留在队列里，但先歇一会儿再试，别每轮都撞。
const RETRY_COOLDOWN_MS = 15_000
const retryAfter = new Map<string, number>()

async function sendOne(sessionId: string, m: QueuedMessage, status: SessionStatus, user: AuthUser | null) {
  if (status === 'PAUSED') {
    // 软待命回复：优先精确端点（带模型选择），拿不到 hitl id 兜底 /messages。与 ChatPanel
    // 的 waitReplyMut 同一套路由。
    const text = pausedReplyText(m.prompt, m.skillName, m.text)
    const hid = await resolveHitlId(sessionId, null)
    if (hid) {
      try { return await hitlApi.answer(sessionId, hid, text, m.provider, m.model) } catch { /* 兜底走下面 */ }
    }
    return sessionsApi.sendMessage(sessionId, text, m.provider, m.model)
  }
  return sessionsApi.sendMessage(
    sessionId, m.prompt, m.provider, m.model, user,
    m.skillName ? { skill_name: m.skillName } : null,
  )
}

interface Ctx {
  user: AuthUser | null
  onSent: (sessionId: string) => void
}
// useEffect 里读的最新上下文（user / onSent），供模块级的 requestDrain 也能用。
let ctxRef: Ctx = { user: null, onSent: () => {} }

async function drainOne(sessionId: string, status: SessionStatus) {
  if (sending.has(sessionId)) return
  if (!DRAINABLE.has(status)) return
  const head = getQueue(sessionId)[0]
  if (!head) return
  const until = retryAfter.get(sessionId) ?? 0
  if (until > Date.now()) return

  sending.add(sessionId)
  try {
    await sendOne(sessionId, head, status, ctxRef.user)
    retryAfter.delete(sessionId)
    removeQueued(sessionId, head.id)   // 只在发成功后摘，失败就留着下轮重试
    ctxRef.onSent(sessionId)
  } catch (e) {
    retryAfter.set(sessionId, Date.now() + RETRY_COOLDOWN_MS)
    console.warn('[queue] 自动发送失败，消息留在待发送列表，稍后重试', sessionId, e)
  } finally {
    sending.delete(sessionId)
  }
}

/**
 * 正在看的会话走这条：ChatPanel 拿 SSE 判定「忙→闲」后立刻调用，省掉轮询的 3s。
 * status 来自 SSE，比列表新鲜；重复调用被 sending 锁与队列为空挡住。
 */
export function requestDrain(sessionId: string, status: SessionStatus): void {
  void drainOne(sessionId, status)
}

export function useQueueDrainer(user: AuthUser | null, onSent: (sessionId: string) => void) {
  const qc = useQueryClient()
  // 同 queryKey → 复用 SessionList 那份缓存，不产生额外请求
  const { data: sessions, dataUpdatedAt } = useQuery<Session[]>({
    queryKey: ['sessions'],
    queryFn: sessionsApi.list,
    refetchInterval: 3000,
  })

  const onSentRef = useRef(onSent)
  onSentRef.current = onSent
  useEffect(() => {
    ctxRef = {
      user,
      onSent: id => { qc.invalidateQueries({ queryKey: ['sessions'] }); onSentRef.current(id) },
    }
  }, [user, qc])

  // 队列变化（用户刚排了一条 / 删了一条）也要重跑一轮判定：会话此刻可能本来就空闲。
  const [tick, setTick] = useState(0)
  useEffect(() => subscribeQueues(() => setTick(t => t + 1)), [])

  // 「这份列表是不是我发完之后才拉的」——刚发出去的那条还没让会话变忙时列表仍显示空闲，
  // 不卡这一下会把整条队列一次性发光（逐条发的意义就没了）。
  const sentAt = useRef(new Map<string, number>())

  useEffect(() => {
    if (!sessions) return
    // 空列表不当作「会话全没了」——后端抖一下返回空数组就把队列清光太冒险。
    if (sessions.length > 0) pruneQueues(new Set(sessions.map(s => s.id)))
    for (const id of queuedSessionIds()) {
      const s = sessions.find(x => x.id === id)
      if (!s || !DRAINABLE.has(s.status)) continue
      if (dataUpdatedAt <= (sentAt.current.get(id) ?? 0)) continue   // 这份列表比上次发送还旧
      sentAt.current.set(id, Date.now())
      void drainOne(id, s.status)
    }
  }, [sessions, dataUpdatedAt, tick])
}
