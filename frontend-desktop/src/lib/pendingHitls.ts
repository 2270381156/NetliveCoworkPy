// pending HITL 列表维护(纯函数,可单测)。真值来源:SSE waiting_input 事件(upsert) +
// GET /hitl/pending 校准(reconcile,服务端为准)——spec 2026-07-05 多面板。
import type { HitlPendingItem } from '@/api/hitl'
import type { ChatWaitingInput } from '@/hooks/useSessionSSE'

const byCreatedAt = (a: ChatWaitingInput, b: ChatWaitingInput) =>
  (a.created_at || '').localeCompare(b.created_at || '')

const keyOf = (w: ChatWaitingInput) => w.hitl_id || `local:${w.id}`

export function upsertPending(list: ChatWaitingInput[], item: ChatWaitingInput): ChatWaitingInput[] {
  const k = keyOf(item)
  const rest = list.filter(w => keyOf(w) !== k)
  return [...rest, item].sort(byCreatedAt)
}

export function serverItemToWaiting(p: HitlPendingItem): ChatWaitingInput {
  return {
    id: `srv:${p.id}`, kind: 'waiting_input',
    prompt: p.question, input_type: 'user_input',
    hitl_kind: p.kind, task_title: p.capability_id,
    arguments: p.arguments || {}, questions: p.questions || [],
    hitl_id: p.id, form: (p.form || undefined) as ChatWaitingInput['form'],
    created_at: p.created_at || '',
  }
}

export function reconcileFromServer(
  list: ChatWaitingInput[], server: HitlPendingItem[],
): ChatWaitingInput[] {
  // 服务端为真值:同 id 保留本地对象引用(React 原地协调),服务端没有的删(含无 id 旧条目),多出的追加
  const local = new Map(list.filter(w => w.hitl_id).map(w => [w.hitl_id as string, w]))
  return server.map(p => local.get(p.id) ?? serverItemToWaiting(p)).sort(byCreatedAt)
}
