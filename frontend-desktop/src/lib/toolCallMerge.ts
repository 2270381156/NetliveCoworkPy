// 工具调用气泡的合并：tool_call_pending 建「待执行」气泡，tool_call 原地填结果。
// 纯函数（type-only 引入类型、运行时无 React 依赖），live 与 history 回放共用。

import type { ChatItem, ChatToolCall } from '@/hooks/useSessionSSE'

export interface PendingToolCallEvt {
  tool_call_id: string
  tool_name: string
  arguments: Record<string, unknown>
  task_id?: string
  created_at: string
}

export interface ToolCallResultEvt {
  tool_call_id: string
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  task_id?: string
  created_at: string
}

/** 追加一个「待执行」气泡；同 tool_call_id 已存在则原样返回（幂等）。 */
export function appendPendingToolCall(
  items: ChatItem[], evt: PendingToolCallEvt, makeId: () => string,
): ChatItem[] {
  if (items.some(it => it.kind === 'tool_call' && it.tool_call_id === evt.tool_call_id)) {
    return items
  }
  const item: ChatToolCall = {
    id: makeId(), kind: 'tool_call', tool_call_id: evt.tool_call_id, status: 'pending',
    tool_name: evt.tool_name, arguments: evt.arguments, result: '', is_error: false,
    task_id: evt.task_id || undefined,
    created_at: evt.created_at,
  }
  return [...items, item]
}

/** 把结果填进匹配的 pending 气泡；无匹配则追加一个「已完成」气泡（兼容回放缺口）。 */
export function applyToolCallResult(
  items: ChatItem[], evt: ToolCallResultEvt, makeId: () => string,
): ChatItem[] {
  const idx = items.findIndex(
    it => it.kind === 'tool_call' && it.tool_call_id === evt.tool_call_id && it.status === 'pending',
  )
  if (idx >= 0) {
    const prev = items[idx] as ChatToolCall
    const updated: ChatToolCall = {
      ...prev, status: 'done', result: evt.result, is_error: evt.is_error,
      task_id: prev.task_id || evt.task_id || undefined,
      created_at: evt.created_at || prev.created_at,
    }
    return [...items.slice(0, idx), updated, ...items.slice(idx + 1)]
  }
  const item: ChatToolCall = {
    id: makeId(), kind: 'tool_call', tool_call_id: evt.tool_call_id, status: 'done',
    tool_name: evt.tool_name, arguments: evt.arguments, result: evt.result,
    is_error: evt.is_error, task_id: evt.task_id || undefined, created_at: evt.created_at,
  }
  return [...items, item]
}

/**
 * run 终态收尾时，把仍挂着的「待执行」气泡就地收成终态。
 * 背景：内核对「执行前硬拒绝」（准入层拒写、未知工具、非法参数等）只补一条 TOOL_RESULT 进
 * memory 供模型继续，**不发** CAPABILITY_FINISHED，故前端收不到 tool_call 终态事件、气泡永远卡
 * 「执行中…」。run 走到 SUCCEEDED/FAILED/CANCELED/INTERRUPTED 时不会再有任何工具收尾，安全兜底。
 */
export function flushPendingToolCalls(items: ChatItem[], note: string): ChatItem[] {
  let changed = false
  const next = items.map(it => {
    if (it.kind === 'tool_call' && it.status === 'pending') {
      changed = true
      return { ...it, status: 'done', is_error: true, result: it.result || note } as ChatToolCall
    }
    return it
  })
  return changed ? next : items
}
