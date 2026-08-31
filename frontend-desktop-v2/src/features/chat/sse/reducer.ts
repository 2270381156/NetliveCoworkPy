import { reduceActivity } from '@/lib/activity'
import type { ActivityState } from '@/lib/activity'
import { classifyLlmFailure } from '@/lib/llmError'
import type { Session } from '@/shared/types'
import type { ChatItem, ChatImageData, ChatMessage, ChatWaitingInput, AskQuestion, SSEState } from './types'
import { EMPTY_SSE_STATE } from './types'

// 纯 reducer:(state, frame) => state。把旧 useSessionSSE.handle()/evtToItem()/history
// 路径原样搬过来,但去掉副作用(EventSource.close 留在 Step 4 的薄 hook),并用 state.seq 做
// 确定性 id(替代 uid()/Date.now),created_at 用事件自带值(缺省空串),从而可脱离浏览器单测
// + golden-master 快照。live 与 replay(history)走同一套规则。
//
// ⚠️ 行为保真说明(沿用旧码,非本步要改):
//  - observer 推理仅在 history 回放出现,live 链路不处理 observer_reasoning_*(旧码即如此)。
//    "实时也渲染 observer 推理" 是白名单 fix #2,待接 chat 时按白名单单独施加 + 补 fixture。
//  - 旧 live 的 created_at 兜底用 now();此处改用事件自带 created_at(缺省 ''),属白名单内的
//    无害时间戳来源差异。

type Frame = Record<string, unknown>
type ActivityEvt = Parameters<typeof reduceActivity>[1]

// finish_task 收尾标记:其 deliverables_summary 渲染成助手气泡。
// tool_name 由后端 qualify("control:finish_task") 得来(ctx-weft control_capability.py:50)。
const FINISH_TASK_TOOL = 'control__finish_task'

function finishBubble(evt: Frame, id: string, created_at: string): ChatMessage | null {
  if ((evt.tool_name as string) !== FINISH_TASK_TOOL) return null
  const args = (evt.arguments as Record<string, unknown>) || {}
  const summary = String(args.deliverables_summary ?? '').trim()
  if (!summary) return null
  return { id, kind: 'message', role: 'assistant', content: summary, created_at }
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
  return { text: String(raw ?? '') }
}

/** 推一个新 item(用 state.seq 生成确定性 id 并自增)。 */
function withItem(s: SSEState, make: (id: string) => ChatItem): SSEState {
  const id = `i${s.seq}`
  return { ...s, seq: s.seq + 1, items: [...s.items, make(id)] }
}

/** history 回放:把单个持久化事件映射成 item(稳定 id 由调用方按序号给定)。 */
function evtToItem(evt: Frame, id: string, actorReasoning?: string, observerReasoning?: string): ChatItem | null {
  const t = evt.type as string
  if (t === 'message') {
    const { text, images } = parseContent(evt.content)
    return { id, kind: 'message', role: (evt.role as 'user' | 'assistant') || 'assistant', content: text, images, created_at: (evt.created_at as string) || '' }
  }
  if (t === 'text_done') {
    const text = (evt.text as string) || ''
    if (!text) return null
    return { id, kind: 'message', role: 'assistant', content: text, reasoning: actorReasoning, created_at: (evt.created_at as string) || '' }
  }
  if (t === 'tool_call') {
    return { id, kind: 'tool_call', tool_name: (evt.tool_name as string) || '', arguments: (evt.arguments as Record<string, unknown>) || {}, result: (evt.result as string) || '', is_error: (evt.is_error as boolean) || false, created_at: (evt.created_at as string) || '' }
  }
  if (t === 'observer_text_done') {
    const text = (evt.text as string) || ''
    if (!text) return null
    return { id, kind: 'observer_message', round_label: (evt.round_label as string) || '', content: text, reasoning: observerReasoning, created_at: (evt.created_at as string) || '' }
  }
  if (t === 'control_tool_call') {
    return finishBubble(evt, id, (evt.created_at as string) || '')
  }
  return null // daemon_*, task_*, llm_prompt → skip
}

export function reduceSse(state: SSEState, frame: Frame): Readonly<SSEState> {
  const type = frame.type as string
  if (type === 'ping') return state

  if (type === 'history') {
    const events = (frame.events as Frame[]) || []
    const items: ChatItem[] = []
    let actorReasoning: string | undefined
    let observerReasoning: string | undefined
    let activity: ActivityState | null = null
    for (const evt of events) {
      const et = evt.type as string
      activity = reduceActivity(activity, evt as unknown as ActivityEvt)
      if (et === 'reasoning_done') { actorReasoning = (evt.text as string) || undefined; continue }
      if (et === 'observer_reasoning_done') { observerReasoning = (evt.text as string) || undefined; continue }
      const item = evtToItem(evt, `h${items.length}`, actorReasoning, observerReasoning)
      if (item) items.push(item)
      if (et === 'text_done') actorReasoning = undefined
      if (et === 'observer_text_done') observerReasoning = undefined
    }
    return { ...state, items, currentActivity: activity }
  }

  // 其余事件:先过活动状态条 reducer(无变化保持原引用)
  const ca = reduceActivity(state.currentActivity, frame as unknown as ActivityEvt)
  const s = ca === state.currentActivity ? state : { ...state, currentActivity: ca }
  const created_at = (frame.created_at as string) || ''

  switch (type) {
    case 'init': {
      const session = frame.session as Session
      const messages = (frame.messages as Frame[]) || []
      if (s.items.length > 0) {
        return { ...s, session, waitingInput: null, streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, connected: true, error: null }
      }
      let seq = s.seq
      const items: ChatItem[] = messages.map(m => {
        const { text, images } = parseContent(m.content)
        return { id: `i${seq++}`, kind: 'message' as const, role: (m.role as 'user' | 'assistant') || 'assistant', content: text, images, created_at: (m.created_at as string) || '' }
      })
      // 等价旧码 `{ ...EMPTY, session, items, connected }`(全量重置),但保留递增后的 seq 防 id 撞车。
      return { ...EMPTY_SSE_STATE, session, items, connected: true, seq }
    }

    case 'token_update': {
      if (!s.session) return s
      return { ...s, session: { ...s.session, input_tokens_used: (frame.input_tokens_used as number) ?? s.session.input_tokens_used, output_tokens_used: (frame.output_tokens_used as number) ?? s.session.output_tokens_used, context_tokens: (frame.context_tokens as number) ?? s.session.context_tokens } }
    }

    case 'session_update': {
      if (!s.session) return s
      const status = frame.status as Session['status']
      const updated: Session = {
        ...s.session, status,
        ...(frame.llm_account != null ? { llm_account: frame.llm_account as string } : {}),
        ...(frame.llm_model != null ? { llm_model: frame.llm_model as string } : {}),
      }
      const running = status === 'RUNNING'
      return {
        ...s, session: updated,
        waitingInput: running ? null : s.waitingInput,
        streamingText: running ? null : s.streamingText,
        streamingReasoning: running ? null : s.streamingReasoning,
        observerStreamingText: running ? null : s.observerStreamingText,
        interruptReason: (frame.interrupt_reason as string | null) ?? null,
        llmRetrying: running ? s.llmRetrying : false,
        llmRetryProgress: running ? s.llmRetryProgress : null,
      }
    }

    case 'message': {
      const { text, images } = parseContent(frame.content)
      return withItem(s, id => ({ id, kind: 'message', role: (frame.role as 'user' | 'assistant') || 'assistant', content: text, images, created_at }))
    }

    case 'tool_call':
      return withItem(s, id => ({ id, kind: 'tool_call', tool_name: (frame.tool_name as string) || '', arguments: (frame.arguments as Record<string, unknown>) || {}, result: (frame.result as string) || '', is_error: (frame.is_error as boolean) || false, created_at }))

    case 'control_tool_call': {
      const bubble = finishBubble(frame, `i${s.seq}`, created_at)
      return bubble ? { ...s, seq: s.seq + 1, items: [...s.items, bubble] } : s
    }

    case 'waiting_input':
    case 'bash_exec_confirm': {
      // HITL 进 waitingInput 字段(不进 items),与旧码一致。
      const hitl_kind: 'approval' | 'input' = type === 'bash_exec_confirm' || frame.kind === 'approval' ? 'approval' : 'input'
      const item: ChatWaitingInput = {
        id: `i${s.seq}`, kind: 'waiting_input', prompt: (frame.prompt as string) || '',
        input_type: type === 'bash_exec_confirm' ? 'bash_exec_confirm' : ((frame.input_type as string) || 'user_input'),
        hitl_kind, task_title: (frame.task_title as string) || '',
        command: type === 'bash_exec_confirm' ? (frame.command as string) || '' : undefined,
        arguments: (frame.arguments as Record<string, unknown>) || {},
        questions: (frame.questions as AskQuestion[]) || [], created_at,
      }
      return { ...s, seq: s.seq + 1, waitingInput: item }
    }

    case 'llm_retry': {
      const attempt = (frame.attempt as number) || 0
      const maxAttempts = (frame.max_attempts as number) || 0
      return { ...s, llmRetrying: true, llmRetryProgress: maxAttempts > 0 ? { attempt, maxAttempts } : null }
    }

    case 'task_failed': {
      const c = classifyLlmFailure(frame as Parameters<typeof classifyLlmFailure>[0])
      return c ? { ...s, llmError: c.error ?? s.llmError, llmRetrying: c.retrying } : s
    }

    case 'llm_request_started':
      return s.llmRetrying ? { ...s, llmRetrying: false, llmRetryProgress: null } : s

    case 'text_delta': {
      const delta = (frame.delta as string) || ''
      return delta ? { ...s, streamingText: (s.streamingText ?? '') + delta, llmRetrying: false, llmRetryProgress: null } : s
    }

    case 'reasoning_delta': {
      const delta = (frame.delta as string) || ''
      return delta ? { ...s, streamingReasoning: (s.streamingReasoning ?? '') + delta } : s
    }

    case 'image': {
      const img: ChatImageData = { media_type: (frame.media_type as string) || '', source_type: (frame.source_type as 'base64' | 'url') || 'base64', data: (frame.data as string) || '' }
      return { ...s, streamingImages: [...s.streamingImages, img] }
    }

    case 'text_done': {
      const text = (frame.text as string) || ''
      if (!text && s.streamingImages.length === 0 && !s.streamingReasoning) return { ...s, streamingText: null, streamingReasoning: null }
      const reasoning = s.streamingReasoning || undefined
      const images = s.streamingImages.length > 0 ? s.streamingImages : undefined
      return withItem({ ...s, streamingText: null, streamingReasoning: null, streamingImages: [] },
        id => ({ id, kind: 'message', role: 'assistant', content: text, reasoning, images, created_at }))
    }

    case 'reasoning_done': {
      const reasoning = (frame.text as string) || ''
      return reasoning ? { ...s, streamingReasoning: reasoning } : s
    }

    case 'observer_text_delta': {
      const delta = (frame.delta as string) || ''
      return delta ? { ...s, observerStreamingText: (s.observerStreamingText ?? '') + delta } : s
    }

    case 'observer_text_done': {
      const text = (frame.text as string) || ''
      if (!text) return { ...s, observerStreamingText: null }
      return withItem({ ...s, observerStreamingText: null },
        id => ({ id, kind: 'observer_message', round_label: (frame.round_label as string) || '', content: text, created_at }))
    }

    case 'done':
      // 终态:更新 status + 清流式态。EventSource.close() 是副作用,留给 Step 4 的薄 hook。
      return { ...s, waitingInput: null, streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, llmRetrying: false, llmRetryProgress: null, session: s.session ? { ...s.session, status: (frame.final_status as Session['status']) || s.session.status } : s.session }

    default:
      return s // daemon_*, task_*, llm_prompt, observer_reasoning_*(live) → 忽略
  }
}
