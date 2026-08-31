import { useEffect, useRef, useCallback, useState } from 'react'
import type { Session, Task } from '@/types'
import { now } from '@/lib/time'
import { reduceActivity } from '@/lib/activity'
import type { ActivityState } from '@/lib/activity'
import { appendPendingToolCall, applyToolCallResult } from '@/lib/toolCallMerge'

// ── Chat item types ───────────────────────────────────────────────────────────

export type ChatItemKind =
  | 'message'
  | 'tool_call'
  | 'control_tool_call'
  | 'task_event'
  | 'session_event'
  | 'waiting_input'
  | 'llm_prompt'
  | 'observer_message'
  | 'observer_tool_call'
  | 'observer_control_tool_call'
  | 'daemon_message'
  | 'daemon_prompt'
  | 'daemon_tool_call'
  | 'daemon_control_tool_call'
  | 'error_event'
  | 'compact_marker'

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
  images?: ChatImageData[]
  created_at: string
}

export interface ChatToolCall {
  id: string
  kind: 'tool_call'
  tool_call_id?: string
  status?: 'pending' | 'done'
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  created_at: string
}

export interface ChatTaskEvent {
  id: string
  kind: 'task_event'
  task: Task
  created_at: string
}

export interface ChatWaitingInput {
  id: string
  kind: 'waiting_input'
  prompt: string
  input_type: string
  task_title: string
  command?: string   // bash_exec_confirm only
  hitl_id?: string
  form?: 'approval' | 'question' | 'wait'
  created_at: string
}

/** prompt 卡片的按需加载凭据：后端 ?prompts=stub 只发头部，正文靠这两个字段回取。
 *  event_index = sse_events 下标；bytes = 这条 prompt 的原始大小（折叠态显示）。 */
export interface PromptStubRef {
  stub?: boolean
  event_index?: number
  bytes?: number
  session_id?: string
}

export interface ChatLLMPrompt extends PromptStubRef {
  id: string
  kind: 'llm_prompt'
  source: string        // 'actor' | 'observer'
  round_label: string
  task_id: string
  agent_id: string
  system_prompt: string
  messages: Array<{ role: string; content: string | object[] }>
  tool_names: string[]
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

export interface ChatControlToolCall {
  id: string
  kind: 'control_tool_call'
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  created_at: string
}

export interface ChatObserverToolCall {
  id: string
  kind: 'observer_tool_call'
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  created_at: string
}

export interface ChatObserverControlToolCall {
  id: string
  kind: 'observer_control_tool_call'
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  created_at: string
}

export interface ChatDaemonMessage {
  id: string
  kind: 'daemon_message'
  text: string
  round_label?: string
  created_at: string
}

export interface ChatDaemonPrompt extends PromptStubRef {
  id: string
  kind: 'daemon_prompt'
  source: string
  round_label: string
  task_id: string
  agent_id: string
  system_prompt: string
  messages: Array<{ role: string; content: string | object[] }>
  tool_names: string[]
  created_at: string
}

export interface ChatDaemonToolCall {
  id: string
  kind: 'daemon_tool_call'
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  created_at: string
}

export interface ChatDaemonControlToolCall {
  id: string
  kind: 'daemon_control_tool_call'
  tool_name: string
  arguments: Record<string, unknown>
  result: string
  is_error: boolean
  created_at: string
}

export interface ChatErrorEvent {
  id: string
  kind: 'error_event'
  error: string
  error_type: string
  will_retry: boolean
  created_at: string
}

export interface ChatCompactMarker {
  id: string
  kind: 'compact_marker'
  total_superseded: number
  freed_tokens: number
  created_at: string
}

export interface SessionNotice {
  kind: 'failed' | 'interrupted'
  reason_code: string
  reason_text: string
  failures: Array<{ title: string; reason: string }>
  created_at: string
}

export type ChatItem =
  | ChatMessage
  | ChatToolCall
  | ChatControlToolCall
  | ChatTaskEvent
  | ChatWaitingInput
  | ChatLLMPrompt
  | ChatObserverMessage
  | ChatObserverToolCall
  | ChatObserverControlToolCall
  | ChatDaemonMessage
  | ChatDaemonPrompt
  | ChatDaemonToolCall
  | ChatDaemonControlToolCall
  | ChatErrorEvent
  | ChatCompactMarker

export interface SSEState {
  session: Session | null
  tasks: Task[]
  daemonTasks: Task[]
  items: ChatItem[]
  waitingInput: ChatWaitingInput | null
  streamingText: string | null
  streamingReasoning: string | null
  streamingImages: ChatImageData[]
  observerStreamingText: string | null
  observerStreamingReasoning: string | null
  currentActivity: ActivityState | null
  connected: boolean
  error: string | null
  notice: SessionNotice | null
}

let _idCounter = 0
function uid() {
  return `sse-${Date.now()}-${_idCounter++}`
}

/** 摘出 prompt 存根的回取凭据。后端 full 模式下这些字段不存在 → stub=false，卡片直接用内联正文。 */
function stubRef(evt: Record<string, unknown>, sessionId: string | null): PromptStubRef {
  return {
    stub: evt.stub === true,
    event_index: typeof evt.event_index === 'number' ? evt.event_index : undefined,
    bytes: typeof evt.bytes === 'number' ? evt.bytes : undefined,
    session_id: sessionId ?? undefined,
  }
}

function noticeFrom(evt: Record<string, unknown>): SessionNotice {
  return {
    kind: (evt.kind as SessionNotice['kind']) || 'failed',
    reason_code: (evt.reason_code as string) || '',
    reason_text: (evt.reason_text as string) || '',
    failures: (evt.failures as Array<{ title: string; reason: string }>) || [],
    created_at: (evt.created_at as string) || '',
  }
}

// ── useSessionSSE hook ────────────────────────────────────────────────────────

export function useSessionSSE(sessionId: string | null): SSEState & { reconnect: () => void } {
  const [state, setState] = useState<SSEState>({
    session: null,
    tasks: [],
    daemonTasks: [],
    items: [],
    waitingInput: null,
    streamingText: null,
    streamingReasoning: null,
    streamingImages: [],
    observerStreamingText: null,
    observerStreamingReasoning: null,
    currentActivity: null,
    connected: false,
    error: null,
    notice: null,
  })

  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [reconnectKey, setReconnectKey] = useState(0)
  const lastEventTimeRef = useRef(Date.now())

  const close = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }, [])

  // Expose reconnect so callers (e.g. terminal continuation) can re-open the stream
  const reconnect = useCallback(() => {
    close()
    setReconnectKey(k => k + 1)
  }, [close])

  useEffect(() => {
    if (!sessionId) {
      close()
      setState({ session: null, tasks: [], daemonTasks: [], items: [], waitingInput: null, streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, observerStreamingReasoning: null, currentActivity: null, connected: false, error: null, notice: null })
      return
    }

    if (sessionIdRef.current === sessionId && esRef.current) return

    const isSameSession = sessionIdRef.current === sessionId

    // Close previous connection
    close()
    sessionIdRef.current = sessionId
    if (isSameSession) {
      // 同 session 重连：保留已有内容避免闪烁，只清流式状态
      setState(s => ({
        ...s,
        connected: false,
        error: null,
        streamingText: null,
        streamingReasoning: null,
        streamingImages: [],
        observerStreamingText: null,
        observerStreamingReasoning: null,
      }))
    } else {
      // 切换到不同 session：完全重置
      setState({ session: null, tasks: [], daemonTasks: [], items: [], waitingInput: null, streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, observerStreamingReasoning: null, currentActivity: null, connected: false, error: null, notice: null })
    }

    // ?prompts=stub：llm_prompt/daemon_prompt 只收头部。它们占长会话历史的 95%（实测 66MB
    // 的会话里 62.8MB 是 prompt），全量下发时首屏是一个几十 MB 的 SSE frame，浏览器缓冲 +
    // JSON.parse 直接卡死 → 会话打不开。卡片展开时按 event_index 单条回取全文。
    const es = new EventSource(`/api/v1/sessions/${sessionId}/stream?prompts=stub`)
    esRef.current = es

    es.onopen = () => {
      lastEventTimeRef.current = Date.now()
      setState(s => ({ ...s, connected: true, error: null }))
    }

    es.onmessage = (event) => {
      lastEventTimeRef.current = Date.now()
      try {
        const data = JSON.parse(event.data)
        handleEvent(data)
      } catch {
        // ignore parse errors
      }
    }

    es.onerror = () => {
      setState(s => ({ ...s, connected: false, error: '连接断开，正在重连...' }))
    }

    function parseContent(raw: unknown): { text: string; images?: ChatImageData[] } {
      if (Array.isArray(raw)) {
        const parts = raw as Array<Record<string, string>>
        const images = parts
          .filter(p => p.type === 'image')
          .map(p => ({ media_type: p.media_type || '', source_type: (p.source_type || 'base64') as 'base64' | 'url', data: p.data || '' }))
        const text = parts.filter(p => p.type === 'text').map(p => p.text || '').join('\n')
        return { text, images: images.length > 0 ? images : undefined }
      }
      return { text: (raw as string) || '' }
    }

    function eventToItem(evt: Record<string, unknown>, extras?: { actorReasoning?: string; observerReasoning?: string }): ChatItem | null {
      const t = evt.type as string
      if (t === 'message') {
        const { text, images } = parseContent(evt.content)
        return {
          id: uid(),
          kind: 'message',
          role: (evt.role as 'user' | 'assistant') || 'assistant',
          content: text,
          images,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'text_done') {
        const text = (evt.text as string) || ''
        if (!text) return null
        return {
          id: uid(),
          kind: 'message',
          role: 'assistant',
          content: text,
          reasoning: extras?.actorReasoning,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'task_created' || t === 'task_updated') {
        const task = evt.task as import('@/types').Task
        return {
          id: uid(),
          kind: 'task_event',
          task,
          created_at: task?.created_at || '',
        }
      }
      if (t === 'llm_prompt') {
        return {
          ...stubRef(evt, sessionId),
          id: uid(),
          kind: 'llm_prompt',
          source: (evt.source as string) || 'actor',
          round_label: (evt.round_label as string) || '',
          task_id: (evt.task_id as string) || '',
          agent_id: (evt.agent_id as string) || '',
          system_prompt: (evt.system_prompt as string) || '',
          messages: (evt.messages as Array<{ role: string; content: string | object[] }>) || [],
          tool_names: (evt.tool_names as string[]) || [],
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'context_compacted') {
        return {
          id: uid(),
          kind: 'compact_marker',
          total_superseded: (evt.total_superseded as number) || 0,
          freed_tokens: (evt.freed_tokens as number) || 0,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'observer_text_done') {
        const text = (evt.text as string) || ''
        if (!text) return null
        return {
          id: uid(),
          kind: 'observer_message',
          round_label: (evt.round_label as string) || '',
          content: text,
          reasoning: extras?.observerReasoning,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'observer_tool_call') {
        return {
          id: uid(),
          kind: 'observer_tool_call',
          tool_name: (evt.tool_name as string) || '',
          arguments: (evt.arguments as Record<string, unknown>) || {},
          result: (evt.result as string) || '',
          is_error: (evt.is_error as boolean) || false,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'observer_control_tool_call') {
        return {
          id: uid(),
          kind: 'observer_control_tool_call',
          tool_name: (evt.tool_name as string) || '',
          arguments: (evt.arguments as Record<string, unknown>) || {},
          result: (evt.result as string) || '',
          is_error: (evt.is_error as boolean) || false,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'control_tool_call') {
        return {
          id: uid(),
          kind: 'control_tool_call',
          tool_name: (evt.tool_name as string) || '',
          arguments: (evt.arguments as Record<string, unknown>) || {},
          result: (evt.result as string) || '',
          is_error: (evt.is_error as boolean) || false,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'daemon_message') {
        const text = (evt.text as string) || ''
        if (!text) return null
        return {
          id: uid(),
          kind: 'daemon_message' as const,
          text,
          round_label: (evt.round_label as string) || undefined,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'daemon_prompt' || t === 'daemon_llm_prompt') {
        return {
          ...stubRef(evt, sessionId),
          id: uid(),
          kind: 'daemon_prompt' as const,
          source: (evt.source as string) || 'actor',
          round_label: (evt.round_label as string) || '',
          task_id: (evt.task_id as string) || '',
          agent_id: (evt.agent_id as string) || '',
          system_prompt: (evt.system_prompt as string) || '',
          messages: (evt.messages as Array<{ role: string; content: string | object[] }>) || [],
          tool_names: (evt.tool_names as string[]) || [],
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'daemon_tool_call') {
        return {
          id: uid(),
          kind: 'daemon_tool_call' as const,
          tool_name: (evt.tool_name as string) || '',
          arguments: (evt.arguments as Record<string, unknown>) || {},
          result: (evt.result as string) || '',
          is_error: (evt.is_error as boolean) || false,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'daemon_control_tool_call') {
        return {
          id: uid(),
          kind: 'daemon_control_tool_call' as const,
          tool_name: (evt.tool_name as string) || '',
          arguments: (evt.arguments as Record<string, unknown>) || {},
          result: (evt.result as string) || '',
          is_error: (evt.is_error as boolean) || false,
          created_at: (evt.created_at as string) || '',
        }
      }
      if (t === 'task_failed') {
        return {
          id: uid(),
          kind: 'error_event',
          error: (evt.error as string) || 'Task failed',
          error_type: (evt.error_type as string) || '',
          will_retry: (evt.will_retry as boolean) || false,
          created_at: (evt.created_at as string) || '',
        }
      }
      return null
    }

    function handleEvent(data: Record<string, unknown>) {
      const type = data.type as string

      if (type === 'ping') return

      // 每个事件都喂给状态条 reducer（无变化时返回原引用，避免多余重渲染）。
      // history 分支自行重放计算 currentActivity（此处对 'history' 类型为 no-op）。
      if (type !== 'history') {
        setState(s => {
          const ca = reduceActivity(s.currentActivity, data as unknown as Parameters<typeof reduceActivity>[1])
          return ca === s.currentActivity ? s : { ...s, currentActivity: ca }
        })
      }

      if (type === 'history') {
        const events = (data.events as Array<Record<string, unknown>>) || []
        let historyItems: ChatItem[] = []
        let actorReasoning: string | undefined
        let observerReasoning: string | undefined
        let finalSessionStatus: string | undefined
        let lastNotice: SessionNotice | null = null
        let activity: ActivityState | null = null
        for (const evt of events) {
          const evtType = evt.type as string
          activity = reduceActivity(activity, evt as unknown as Parameters<typeof reduceActivity>[1])
          if (evtType === 'reasoning_done') {
            actorReasoning = ((evt.text as string) || '') || undefined
            continue
          }
          if (evtType === 'observer_reasoning_done') {
            observerReasoning = ((evt.text as string) || '') || undefined
            continue
          }
          // Extract session status from session_update events embedded in history
          // (Java embeds INTERRUPTED/SUCCEEDED status changes in SSE buffer → history batch)
          if (evtType === 'session_update' && evt.status) {
            finalSessionStatus = evt.status as string
            continue
          }
          if (evtType === 'session_notice') {
            lastNotice = noticeFrom(evt)
            continue
          }
          if (evtType === 'tool_call_pending') {
            historyItems = appendPendingToolCall(historyItems, {
              tool_call_id: (evt.tool_call_id as string) || '',
              tool_name: (evt.tool_name as string) || '',
              arguments: (evt.arguments as Record<string, unknown>) || {},
              created_at: (evt.created_at as string) || '',
            }, uid)
            continue
          }
          if (evtType === 'tool_call') {
            historyItems = applyToolCallResult(historyItems, {
              tool_call_id: (evt.tool_call_id as string) || '',
              tool_name: (evt.tool_name as string) || '',
              arguments: (evt.arguments as Record<string, unknown>) || {},
              result: (evt.result as string) || '',
              is_error: (evt.is_error as boolean) || false,
              created_at: (evt.created_at as string) || '',
            }, uid)
            continue
          }
          const item = eventToItem(evt, { actorReasoning, observerReasoning })
          if (item) historyItems.push(item)
          if (evtType === 'text_done') actorReasoning = undefined
          if (evtType === 'observer_text_done') observerReasoning = undefined
        }
        setState(s => ({
          ...s,
          items: historyItems,
          currentActivity: activity,
          session: finalSessionStatus && s.session
            ? { ...s.session, status: finalSessionStatus as Session['status'] }
            : s.session,
          notice: lastNotice,
        }))
        return
      }

      if (type === 'init') {
        const session = data.session as Session
        const tasks = (data.tasks as Task[]) || []
        const daemonTasks = (data.daemon_tasks as Task[]) || []
        const messages = (data.messages as Array<Record<string, unknown>>) || []

        setState(s => {
          const isReconnect = s.items.length > 0
          if (isReconnect) {
            // 重连：保留已有聊天记录，只更新元数据和清除流式状态
            return {
              ...s,
              session,
              tasks,
              daemonTasks,
              waitingInput: null,
              streamingText: null,
              streamingReasoning: null,
              streamingImages: [],
              observerStreamingText: null,
              observerStreamingReasoning: null,
              connected: true,
              error: null,
            }
          }
          // 首次连接：用内存消息初始化
          const items: ChatItem[] = messages.map((m) => {
            const { text, images } = parseContent(m.content)
            return {
              id: uid(),
              kind: 'message' as const,
              role: (m.role as 'user' | 'assistant') || 'assistant',
              content: text,
              images,
              created_at: (m.created_at as string) || '',
            }
          })
          return {
            session,
            tasks,
            daemonTasks,
            items,
            waitingInput: null,
            streamingText: null,
            streamingReasoning: null,
            streamingImages: [],
            observerStreamingText: null,
            observerStreamingReasoning: null,
            currentActivity: null,
            connected: true,
            error: null,
            notice: null,
          }
        })
        return
      }

      if (type === 'token_update') {
        setState(s => ({
          ...s,
          session: s.session
            ? { ...s.session, input_tokens_used: (data.input_tokens_used as number) ?? s.session.input_tokens_used, output_tokens_used: (data.output_tokens_used as number) ?? s.session.output_tokens_used, context_tokens: (data.context_tokens as number) ?? s.session.context_tokens }
            : s.session,
        }))
        return
      }

      if (type === 'session_notice') {
        setState(s => ({ ...s, notice: noticeFrom(data) }))
        return
      }

      if (type === 'session_update') {
        setState(s => ({
          ...s,
          session: s.session
            ? { ...s.session, status: data.status as Session['status'], input_tokens_used: (data.input_tokens_used as number) ?? s.session.input_tokens_used, output_tokens_used: (data.output_tokens_used as number) ?? s.session.output_tokens_used }
            : s.session,
          // clear waiting input & streaming when session resumes
          waitingInput: data.status === 'RUNNING' ? null : s.waitingInput,
          streamingText: data.status === 'RUNNING' ? null : s.streamingText,
          streamingReasoning: data.status === 'RUNNING' ? null : s.streamingReasoning,
          observerStreamingText: data.status === 'RUNNING' ? null : s.observerStreamingText,
          observerStreamingReasoning: data.status === 'RUNNING' ? null : s.observerStreamingReasoning,
        }))
        return
      }

      if (type === 'task_created') {
        const task = data.task as Task
        setState(s => {
          const exists = s.tasks.some(t => t.id === task.id)
          return {
            ...s,
            tasks: exists ? s.tasks : [...s.tasks, task],
            items: [...s.items, {
              id: uid(),
              kind: 'task_event' as const,
              task,
              created_at: task.created_at,
            }],
          }
        })
        return
      }

      if (type === 'task_updated') {
        const task = data.task as Task
        setState(s => ({
          ...s,
          tasks: s.tasks.map(t => t.id === task.id ? task : t),
          items: [...s.items, {
            id: uid(),
            kind: 'task_event' as const,
            task,
            created_at: task.updated_at,
          }],
        }))
        return
      }

      if (type === 'context_compacted') {
        const item: ChatCompactMarker = {
          id: uid(),
          kind: 'compact_marker',
          total_superseded: (data.total_superseded as number) || 0,
          freed_tokens: (data.freed_tokens as number) || 0,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'daemon_task_created') {
        const task = data.task as Task
        setState(s => {
          const exists = s.daemonTasks.some(t => t.id === task.id)
          return { ...s, daemonTasks: exists ? s.daemonTasks : [...s.daemonTasks, task] }
        })
        return
      }

      if (type === 'daemon_task_updated') {
        const task = data.task as Task
        setState(s => ({ ...s, daemonTasks: s.daemonTasks.map(t => t.id === task.id ? task : t) }))
        return
      }

      if (type === 'message') {
        const { text, images } = parseContent(data.content)
        const item: ChatMessage = {
          id: uid(),
          kind: 'message',
          role: (data.role as 'user' | 'assistant') || 'assistant',
          content: text,
          images,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'tool_call_pending') {
        setState(s => ({ ...s, items: appendPendingToolCall(s.items, {
          tool_call_id: (data.tool_call_id as string) || '',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          created_at: (data.created_at as string) || now(),
        }, uid) }))
        return
      }

      if (type === 'tool_call') {
        setState(s => ({ ...s, items: applyToolCallResult(s.items, {
          tool_call_id: (data.tool_call_id as string) || '',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          result: (data.result as string) || '',
          is_error: (data.is_error as boolean) || false,
          created_at: (data.created_at as string) || now(),
        }, uid) }))
        return
      }

      if (type === 'waiting_input' || type === 'bash_exec_confirm') {
        const item: ChatWaitingInput = {
          id: uid(),
          kind: 'waiting_input',
          prompt: (data.prompt as string) || '',
          input_type: type === 'bash_exec_confirm' ? 'bash_exec_confirm' : ((data.input_type as string) || 'user_input'),
          task_title: (data.task_title as string) || '',
          command: type === 'bash_exec_confirm' ? (data.command as string) || '' : undefined,
          hitl_id: (data.hitl_id as string) || undefined,
          form: (data.form as ChatWaitingInput['form']) || undefined,
          created_at: now(),
        }
        setState(s => ({ ...s, waitingInput: item }))
        return
      }

      if (type === 'text_delta') {
        const delta = (data.delta as string) || ''
        if (delta) {
          setState(s => ({ ...s, streamingText: (s.streamingText ?? '') + delta }))
        }
        return
      }

      if (type === 'reasoning_delta') {
        const delta = (data.delta as string) || ''
        if (delta) {
          setState(s => ({ ...s, streamingReasoning: (s.streamingReasoning ?? '') + delta }))
        }
        return
      }

      if (type === 'image') {
        const img: ChatImageData = {
          media_type: (data.media_type as string) || '',
          source_type: (data.source_type as 'base64' | 'url') || 'base64',
          data: (data.data as string) || '',
        }
        setState(s => ({ ...s, streamingImages: [...s.streamingImages, img] }))
        return
      }

      if (type === 'text_done') {
        const text = (data.text as string) || ''
        setState(s => {
          if (!text && s.streamingImages.length === 0 && !s.streamingReasoning) {
            return { ...s, streamingText: null, streamingReasoning: null }
          }
          const item: ChatMessage = {
            id: uid(),
            kind: 'message',
            role: 'assistant',
            content: text,
            reasoning: s.streamingReasoning || undefined,
            images: s.streamingImages.length > 0 ? s.streamingImages : undefined,
            created_at: now(),
          }
          return { ...s, items: [...s.items, item], streamingText: null, streamingReasoning: null, streamingImages: [] }
        })
        return
      }

      if (type === 'reasoning_done') {
        const reasoning = (data.text as string) || ''
        if (reasoning) {
          setState(s => ({ ...s, streamingReasoning: reasoning }))
        }
        return
      }

      if (type === 'llm_prompt') {
        const item: ChatLLMPrompt = {
          ...stubRef(data, sessionId),
          id: uid(),
          kind: 'llm_prompt',
          source: (data.source as string) || 'actor',
          round_label: (data.round_label as string) || '',
          task_id: (data.task_id as string) || '',
          agent_id: (data.agent_id as string) || '',
          system_prompt: (data.system_prompt as string) || '',
          messages: (data.messages as Array<{ role: string; content: string }>) || [],
          tool_names: (data.tool_names as string[]) || [],
          created_at: now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'observer_text_delta') {
        const delta = (data.delta as string) || ''
        if (delta) {
          setState(s => ({ ...s, observerStreamingText: (s.observerStreamingText ?? '') + delta }))
        }
        return
      }

      if (type === 'observer_reasoning_delta') {
        const delta = (data.delta as string) || ''
        if (delta) {
          setState(s => ({ ...s, observerStreamingReasoning: (s.observerStreamingReasoning ?? '') + delta }))
        }
        return
      }

      if (type === 'observer_text_done') {
        const text = (data.text as string) || ''
        const round_label = (data.round_label as string) || ''
        setState(s => {
          if (!text && !s.observerStreamingReasoning) {
            return { ...s, observerStreamingText: null, observerStreamingReasoning: null }
          }
          const item: ChatObserverMessage = {
            id: uid(),
            kind: 'observer_message',
            round_label,
            content: text,
            reasoning: s.observerStreamingReasoning || undefined,
            created_at: now(),
          }
          return { ...s, items: [...s.items, item], observerStreamingText: null, observerStreamingReasoning: null }
        })
        return
      }

      if (type === 'observer_reasoning_done') {
        const reasoning = (data.text as string) || ''
        if (reasoning) {
          setState(s => ({ ...s, observerStreamingReasoning: reasoning }))
        }
        return
      }

      if (type === 'control_tool_call') {
        const item: ChatControlToolCall = {
          id: uid(),
          kind: 'control_tool_call',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          result: (data.result as string) || '',
          is_error: (data.is_error as boolean) || false,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'daemon_message') {
        const text = (data.text as string) || ''
        if (!text) return
        const item: ChatDaemonMessage = {
          id: uid(),
          kind: 'daemon_message',
          text,
          round_label: (data.round_label as string) || undefined,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'daemon_prompt' || type === 'daemon_llm_prompt') {
        const source = (data.source as string) || 'actor'
        const item: ChatDaemonPrompt = {
          ...stubRef(data, sessionId),
          id: uid(),
          kind: 'daemon_prompt',
          source,
          round_label: (data.round_label as string) || source,
          task_id: (data.task_id as string) || '',
          agent_id: (data.agent_id as string) || '',
          system_prompt: (data.system_prompt as string) || '',
          messages: (data.messages as Array<{ role: string; content: string | object[] }>) || [],
          tool_names: (data.tool_names as string[]) || [],
          created_at: now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'observer_tool_call') {
        const item: ChatObserverToolCall = {
          id: uid(),
          kind: 'observer_tool_call',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          result: (data.result as string) || '',
          is_error: (data.is_error as boolean) || false,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'observer_control_tool_call') {
        const item: ChatObserverControlToolCall = {
          id: uid(),
          kind: 'observer_control_tool_call',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          result: (data.result as string) || '',
          is_error: (data.is_error as boolean) || false,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'daemon_tool_call') {
        const item: ChatDaemonToolCall = {
          id: uid(),
          kind: 'daemon_tool_call',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          result: (data.result as string) || '',
          is_error: (data.is_error as boolean) || false,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'daemon_control_tool_call') {
        const item: ChatDaemonControlToolCall = {
          id: uid(),
          kind: 'daemon_control_tool_call',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          result: (data.result as string) || '',
          is_error: (data.is_error as boolean) || false,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'task_failed') {
        const item: ChatErrorEvent = {
          id: uid(),
          kind: 'error_event',
          error: (data.error as string) || 'Task failed',
          error_type: (data.error_type as string) || '',
          will_retry: (data.will_retry as boolean) || false,
          created_at: (data.created_at as string) || now(),
        }
        setState(s => ({
          ...s,
          streamingText: null,
          streamingReasoning: null,
          streamingImages: [],
          items: [...s.items, item],
        }))
        return
      }

      if (type === 'interrupted') {
        // RunCanceled from backend — pre-emptively update status before `done` arrives
        setState(s => ({
          ...s,
          waitingInput: null,
          streamingText: null,
          streamingReasoning: null,
          streamingImages: [],
          observerStreamingText: null,
          observerStreamingReasoning: null,
          session: s.session ? { ...s.session, status: 'CANCELED' } : s.session,
        }))
        return
      }

      if (type === 'done') {
        setState(s => ({
          ...s,
          waitingInput: null,
          streamingText: null,
          streamingReasoning: null,
          streamingImages: [],
          observerStreamingText: null,
          observerStreamingReasoning: null,
          session: s.session
            ? { ...s.session, status: (data.final_status as Session['status']) || s.session.status }
            : s.session,
        }))
        // Explicitly close to prevent EventSource auto-reconnect loop on terminal sessions
        close()
      }
    }

    return () => {
      close()
    }
  }, [sessionId, close, reconnectKey])

  // Detect zombie connections: if the EventSource is OPEN but no event has arrived
  // for 35s (backend sends keepalive every 25s), the proxy is keeping a dead
  // connection alive. Force a reconnect so the browser re-sends Last-Event-ID
  // and the backend delivers any missed events (e.g. INTERRUPTED after restart).
  useEffect(() => {
    if (!sessionId) return
    const id = setInterval(() => {
      if (esRef.current?.readyState === EventSource.OPEN) {
        if (Date.now() - lastEventTimeRef.current > 5_000) {
          reconnect()
        }
      }
    }, 2_000)
    return () => clearInterval(id)
  }, [sessionId, reconnect])

  return { ...state, reconnect }
}
