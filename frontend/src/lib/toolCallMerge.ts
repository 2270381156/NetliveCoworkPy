// 工具调用气泡的合并：tool_call_pending 建「待执行」气泡，tool_call 原地填结果。
// 纯函数（type-only 引入类型、运行时无 React 依赖），live 与 history 回放共用。

import type { ChatItem, ChatToolCall } from '@/hooks/useSessionSSE'

export interface PendingToolCallEvt {
  tool_call_id: string
  tool_name: string
  arguments: Record<string, unknown>
  created_at: string
}

export interface ToolCallResultEvt {
  tool_call_id: string
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
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
      created_at: evt.created_at || prev.created_at,
    }
    return [...items.slice(0, idx), updated, ...items.slice(idx + 1)]
  }
  const item: ChatToolCall = {
    id: makeId(), kind: 'tool_call', tool_call_id: evt.tool_call_id, status: 'done',
    tool_name: evt.tool_name, arguments: evt.arguments, result: evt.result,
    is_error: evt.is_error, created_at: evt.created_at,
  }
  return [...items, item]
}
