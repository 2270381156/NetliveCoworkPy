import type { Session } from '@/shared/types'
import type { ActivityState } from '@/lib/activity'

// chat 领域的 SSE 派生 UI 模型类型(铁律二:领域类型随其 feature)。
// 与旧 useSessionSSE 的类型一致;Step 4 迁移 chat 时旧定义并入此处。

export interface ChatImageData {
  media_type: string
  source_type: 'base64' | 'url'
  data: string
}

export interface ChatMessage {
  id: string
  kind: 'message'
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  images?: readonly ChatImageData[]
  created_at: string
}

export interface ChatToolCall {
  id: string
  kind: 'tool_call'
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  created_at: string
}

export interface AskOption { label: string; description?: string; recommended?: boolean }
export interface AskQuestion { question: string; options?: AskOption[]; multi_select?: boolean }

export interface ChatWaitingInput {
  id: string
  kind: 'waiting_input'
  prompt: string
  input_type: string
  hitl_kind: 'approval' | 'input'
  task_title: string
  command?: string
  arguments?: Record<string, unknown>
  questions?: AskQuestion[]
  created_at: string
}

export interface ChatObserverMessage {
  id: string
  kind: 'observer_message'
  round_label: string
  content: string
  reasoning?: string
  created_at: string
}

export type ChatItem = ChatMessage | ChatToolCall | ChatWaitingInput | ChatObserverMessage

// 铁律四:reducer 输出不可变。`items` 是只读数组、元素只读 → `state.items[0].isExpanded = true`
// 之类是编译错误,把 UI 交互状态(展开/折叠等)逼回组件本地 useState,不混进 reducer。
export interface SSEState {
  session: Readonly<Session> | null
  items: ReadonlyArray<Readonly<ChatItem>>
  waitingInput: Readonly<ChatWaitingInput> | null
  streamingText: string | null
  streamingReasoning: string | null
  streamingImages: ReadonlyArray<Readonly<ChatImageData>>
  observerStreamingText: string | null
  currentActivity: ActivityState | null
  connected: boolean
  error: string | null
  llmError: { message: string } | null
  llmRetrying: boolean
  llmRetryProgress: { attempt: number; maxAttempts: number } | null
  interruptReason: string | null
  /** 确定性自增 id 计数器(替代旧 uid()/Date.now,使 reducer 纯函数化、golden-master 可快照)。 */
  seq: number
}

export interface SSEHandle extends SSEState {
  /** 强制重新订阅事件流(向已结束会话发消息 / 恢复运行后重连)。 */
  reconnect: () => void
  /** 关闭 LLM 错误弹窗(用户点关闭或恢复成功后)。 */
  clearLlmError: () => void
}

export const EMPTY_SSE_STATE: SSEState = {
  session: null, items: [], waitingInput: null,
  streamingText: null, streamingReasoning: null, streamingImages: [],
  observerStreamingText: null, currentActivity: null, connected: false, error: null,
  llmError: null, llmRetrying: false, llmRetryProgress: null, interruptReason: null,
  seq: 0,
}
