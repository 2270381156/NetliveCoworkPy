import { useEffect, useRef, useCallback, useState } from 'react'
import type { Session } from '@/types'
import { now } from '@/lib/utils'
import { reduceActivity } from '@/lib/activity'
import { taskSummaryFromEvent } from '@/lib/taskSummary'
import { classifyLlmFailure } from '@/lib/llmError'
import type { ActivityState } from '@/lib/activity'

// ── DEV ONLY: 原始 SSE 帧录制(Step 0c golden-master 采集用)──────────────────
// `import.meta.env.DEV` 守卫 → 生产构建里整段被 tree-shake,零运行时开销。
// 采集流程(开发模式,真实后端):
//   1) 在桌面/浏览器里跑某个场景(正常对话/工具调用/observer/HITL/失败重试/中断恢复)
//   2) 控制台 `window.__sseSave('01-plain-dialog')` 下载该场景的帧序列 JSON
//   3) 把文件挪到 `src/features/chat/sse/__fixtures__/`,作为新 reducer 的回归基线
//   4) `window.__sseClear()` 清空,采下一个场景
// 也可被 Playwright 通过 `page.evaluate(() => window.__sseDump)` 直接读出落盘。
interface SseDumpEntry { sessionId: string; frame: unknown }
const __sseDump: SseDumpEntry[] = []
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>
  w.__sseDump = __sseDump
  w.__sseClear = () => { __sseDump.length = 0 }
  w.__sseSave = (name: string) => {
    const blob = new Blob([JSON.stringify(__sseDump, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name || 'sse'}.json`
    a.click()
  }
}

// ── Item types (desktop: no control/daemon/task items) ───────────────────────

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
  hitl_kind: 'approval' | 'input'   // approval → Approve/Reject 按钮;input → 文本框
  task_title: string
  command?: string
  arguments?: Record<string, unknown>   // approval 门控时被调用工具的参数,供人工判断
  questions?: AskQuestion[]             // ask_user 的结构化批量问题;有值则渲染选项面板而非纯文本框
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

export interface ChatTaskSummary {
  id: string
  kind: 'task_summary'
  summary: string
  created_at: string
}

export type ChatItem = ChatMessage | ChatToolCall | ChatWaitingInput | ChatObserverMessage | ChatTaskSummary

export interface SSEState {
  session: Session | null
  items: ChatItem[]
  waitingInput: ChatWaitingInput | null
  streamingText: string | null
  streamingReasoning: string | null
  streamingImages: ChatImageData[]
  observerStreamingText: string | null
  currentActivity: ActivityState | null
  connected: boolean
  error: string | null
  /** 终态 LLM 调用错误（task 真失败 → FAILED）→ 触发弹窗。message 为后端原始错误串。靠 clearLlmError 清除。 */
  llmError: { message: string } | null
  /** LLM 正在自愈重试（自愈退避 / task 重试）→ 输入框上方内联提示。LLM 重新工作时自动清除。 */
  llmRetrying: boolean
  /** 自愈退避进度（来自 llm_retry 事件）；有值时内联提示显示「第 N/M 次」。task 级重试无此细节(null)。 */
  llmRetryProgress: { attempt: number; maxAttempts: number } | null
  /** INTERRUPTED 成因（如 "llm_outage"）→ 让中断提示条显示 LLM 故障专属文案 + 恢复运行。 */
  interruptReason: string | null
}

export interface SSEHandle extends SSEState {
  /** 强制重新订阅事件流。用于向已结束会话发消息/恢复运行后，重新建立被终态关闭的连接。 */
  reconnect: () => void
  /** 关闭 LLM 错误弹窗（用户点关闭或恢复运行成功后调用）。 */
  clearLlmError: () => void
}

const EMPTY: SSEState = {
  session: null, items: [], waitingInput: null,
  streamingText: null, streamingReasoning: null, streamingImages: [],
  observerStreamingText: null, currentActivity: null, connected: false, error: null,
  llmError: null, llmRetrying: false, llmRetryProgress: null, interruptReason: null,
}

let _idCounter = 0
function uid() { return `sse-${Date.now()}-${_idCounter++}` }

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSessionSSE(sessionId: string | null): SSEHandle {
  const [state, setState] = useState<SSEState>(EMPTY)
  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // 最近一次收到任意事件（含 ping）的时刻；僵尸连接看门狗据此判活。
  const lastEventTimeRef = useRef<number>(Date.now())
  // 重连代：bump 后 effect 重新订阅（向已结束会话恢复运行/僵尸连接重连时用）
  const [epoch, setEpoch] = useState(0)

  const close = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
  }, [])

  const reconnect = useCallback(() => setEpoch(e => e + 1), [])

  const clearLlmError = useCallback(() => setState(s => (s.llmError ? { ...s, llmError: null } : s)), [])

  useEffect(() => {
    if (!sessionId) {
      close()
      setState(EMPTY)
      return
    }

    close()
    const isNewSession = sessionIdRef.current !== sessionId
    sessionIdRef.current = sessionId
    // 仅切换会话时清空；同会话重连（epoch）保留已渲染内容，靠稳定 key 原地协调，避免空屏闪烁
    if (isNewSession) setState(EMPTY)

    const es = new EventSource(`/api/v1/sessions/${sessionId}/stream`)
    esRef.current = es
    lastEventTimeRef.current = Date.now()

    es.onopen = () => { lastEventTimeRef.current = Date.now(); setState(s => ({ ...s, connected: true, error: null })) }
    es.onerror = () => setState(s => ({ ...s, connected: false, error: '连接断开，正在重连…' }))

    es.onmessage = (event) => {
      lastEventTimeRef.current = Date.now()
      try {
        const frame = JSON.parse(event.data as string)
        if (import.meta.env.DEV) __sseDump.push({ sessionId, frame })
        handle(frame)
      } catch { /* ignore */ }
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

    function handle(data: Record<string, unknown>) {
      const type = data.type as string
      if (type === 'ping') return

      if (type === 'history') {
        const events = (data.events as Array<Record<string, unknown>>) || []
        const items: ChatItem[] = []
        let actorReasoning: string | undefined
        let observerReasoning: string | undefined
        let activity: ActivityState | null = null
        for (const evt of events) {
          const et = evt.type as string
          activity = reduceActivity(activity, evt as unknown as Parameters<typeof reduceActivity>[1])
          if (et === 'reasoning_done') { actorReasoning = (evt.text as string) || undefined; continue }
          if (et === 'observer_reasoning_done') { observerReasoning = (evt.text as string) || undefined; continue }
          const item = evtToItem(evt, actorReasoning, observerReasoning)
          // 稳定 key：按回放顺序定址（h0/h1/…），不用 Date.now() 的 uid。重连重发 history 时
          // key 不变 → React 原地复用节点、不重挂载、不重播进场动画，杜绝闪动。
          if (item) { item.id = `h${items.length}`; items.push(item) }
          if (et === 'text_done') actorReasoning = undefined
          if (et === 'observer_text_done') observerReasoning = undefined
        }
        setState(s => ({ ...s, items, currentActivity: activity }))
        return
      }

      // 每个事件都喂给状态条 reducer（无变化时返回原引用，避免多余重渲染）
      setState(s => {
        const ca = reduceActivity(s.currentActivity, data as unknown as Parameters<typeof reduceActivity>[1])
        return ca === s.currentActivity ? s : { ...s, currentActivity: ca }
      })

      if (type === 'init') {
        const session = data.session as Session
        const messages = (data.messages as Array<Record<string, unknown>>) || []
        setState(s => {
          if (s.items.length > 0) {
            return { ...s, session, waitingInput: null, streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, connected: true, error: null }
          }
          const items: ChatItem[] = messages.map(m => {
            const { text, images } = parseContent(m.content)
            return { id: uid(), kind: 'message' as const, role: (m.role as 'user' | 'assistant') || 'assistant', content: text, images, created_at: (m.created_at as string) || '' }
          })
          return { ...EMPTY, session, items, connected: true }
        })
        return
      }

      if (type === 'token_update') {
        setState(s => ({ ...s, session: s.session ? { ...s.session, input_tokens_used: (data.input_tokens_used as number) ?? s.session.input_tokens_used, output_tokens_used: (data.output_tokens_used as number) ?? s.session.output_tokens_used, context_tokens: (data.context_tokens as number) ?? s.session.context_tokens } : s.session }))
        return
      }

      if (type === 'session_update') {
        setState(s => {
          if (!s.session) return s
          const status = data.status as Session['status']
          const updated: Session = {
            ...s.session,
            status,
            ...(data.llm_account != null ? { llm_account: data.llm_account as string } : {}),
            ...(data.llm_model != null ? { llm_model: data.llm_model as string } : {}),
          }
          return {
            ...s,
            session: updated,
            waitingInput: status === 'RUNNING' ? null : s.waitingInput,
            streamingText: status === 'RUNNING' ? null : s.streamingText,
            streamingReasoning: status === 'RUNNING' ? null : s.streamingReasoning,
            observerStreamingText: status === 'RUNNING' ? null : s.observerStreamingText,
            // 中断成因随 session_update 下发（重连时也重推）；非 INTERRUPTED 态为 null
            interruptReason: (data.interrupt_reason as string | null) ?? null,
            // 自愈在 session 仍 RUNNING 时进行；一旦离开 RUNNING（耗尽→INTERRUPTED 等），重试提示落幕
            llmRetrying: status === 'RUNNING' ? s.llmRetrying : false,
            llmRetryProgress: status === 'RUNNING' ? s.llmRetryProgress : null,
          }
        })
        return
      }

      if (type === 'message') {
        const { text, images } = parseContent(data.content)
        setState(s => ({ ...s, items: [...s.items, { id: uid(), kind: 'message', role: (data.role as 'user' | 'assistant') || 'assistant', content: text, images, created_at: (data.created_at as string) || now() }] }))
        return
      }

      if (type === 'tool_call') {
        setState(s => ({ ...s, items: [...s.items, { id: uid(), kind: 'tool_call', tool_name: (data.tool_name as string) || '', arguments: (data.arguments as Record<string, unknown>) || {}, result: (data.result as string) || '', is_error: (data.is_error as boolean) || false, created_at: (data.created_at as string) || now() }] }))
        return
      }

      if (type === 'control_tool_call') {
        const s = taskSummaryFromEvent(data as Parameters<typeof taskSummaryFromEvent>[0])
        if (s) {
          setState(st => ({ ...st, items: [...st.items, { id: uid(), kind: 'task_summary', summary: s.summary, created_at: (data.created_at as string) || now() }] }))
        }
        return
      }

      if (type === 'waiting_input' || type === 'bash_exec_confirm') {
        const hitl_kind: 'approval' | 'input' = type === 'bash_exec_confirm' || data.kind === 'approval' ? 'approval' : 'input'
        const item: ChatWaitingInput = { id: uid(), kind: 'waiting_input', prompt: (data.prompt as string) || '', input_type: type === 'bash_exec_confirm' ? 'bash_exec_confirm' : ((data.input_type as string) || 'user_input'), hitl_kind, task_title: (data.task_title as string) || '', command: type === 'bash_exec_confirm' ? (data.command as string) || '' : undefined, arguments: (data.arguments as Record<string, unknown>) || {}, questions: (data.questions as AskQuestion[]) || [], created_at: now() }
        setState(s => ({ ...s, waitingInput: item }))
        return
      }

      // 自愈退避进度（session 仍 RUNNING）→ 内联「重试中(第 N/M 次)」提示
      if (type === 'llm_retry') {
        const attempt = (data.attempt as number) || 0
        const maxAttempts = (data.max_attempts as number) || 0
        setState(s => ({ ...s, llmRetrying: true, llmRetryProgress: maxAttempts > 0 ? { attempt, maxAttempts } : null }))
        return
      }

      if (type === 'task_failed') {
        const c = classifyLlmFailure(data as Parameters<typeof classifyLlmFailure>[0])
        if (c) setState(s => ({ ...s, llmError: c.error ?? s.llmError, llmRetrying: c.retrying }))
        return
      }

      // LLM 重新发起请求 → 上一次失败的「正在重试」提示落幕
      if (type === 'llm_request_started') {
        setState(s => (s.llmRetrying ? { ...s, llmRetrying: false, llmRetryProgress: null } : s))
        return
      }

      if (type === 'text_delta') {
        const delta = (data.delta as string) || ''
        if (delta) setState(s => ({ ...s, streamingText: (s.streamingText ?? '') + delta, llmRetrying: false, llmRetryProgress: null }))
        return
      }

      if (type === 'reasoning_delta') {
        const delta = (data.delta as string) || ''
        if (delta) setState(s => ({ ...s, streamingReasoning: (s.streamingReasoning ?? '') + delta }))
        return
      }

      if (type === 'image') {
        const img: ChatImageData = { media_type: (data.media_type as string) || '', source_type: (data.source_type as 'base64' | 'url') || 'base64', data: (data.data as string) || '' }
        setState(s => ({ ...s, streamingImages: [...s.streamingImages, img] }))
        return
      }

      if (type === 'text_done') {
        const text = (data.text as string) || ''
        setState(s => {
          if (!text && s.streamingImages.length === 0 && !s.streamingReasoning) return { ...s, streamingText: null, streamingReasoning: null }
          const item: ChatMessage = { id: uid(), kind: 'message', role: 'assistant', content: text, reasoning: s.streamingReasoning || undefined, images: s.streamingImages.length > 0 ? s.streamingImages : undefined, created_at: now() }
          return { ...s, items: [...s.items, item], streamingText: null, streamingReasoning: null, streamingImages: [] }
        })
        return
      }

      if (type === 'reasoning_done') {
        const reasoning = (data.text as string) || ''
        if (reasoning) setState(s => ({ ...s, streamingReasoning: reasoning }))
        return
      }

      if (type === 'observer_text_delta') {
        const delta = (data.delta as string) || ''
        if (delta) setState(s => ({ ...s, observerStreamingText: (s.observerStreamingText ?? '') + delta }))
        return
      }

      if (type === 'observer_text_done') {
        const text = (data.text as string) || ''
        const round_label = (data.round_label as string) || ''
        setState(s => {
          if (!text) return { ...s, observerStreamingText: null }
          const item: ChatObserverMessage = { id: uid(), kind: 'observer_message', round_label, content: text, created_at: now() }
          return { ...s, items: [...s.items, item], observerStreamingText: null }
        })
        return
      }

      if (type === 'done') {
        // 终态：主动关闭 EventSource，阻止浏览器对已结束会话每 3s（retry）自动重连。
        // 否则重连会反复重发 init/history，整列消息重刷 → 持续闪动。恢复运行靠 reconnect()。
        close()
        setState(s => ({ ...s, waitingInput: null, streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, llmRetrying: false, llmRetryProgress: null, session: s.session ? { ...s.session, status: (data.final_status as Session['status']) || s.session.status } : s.session }))
      }

      // Silently ignore: daemon_*, task_*, llm_prompt
    }

    function evtToItem(evt: Record<string, unknown>, actorReasoning?: string, observerReasoning?: string): ChatItem | null {
      const t = evt.type as string
      if (t === 'message') {
        const { text, images } = parseContent(evt.content)
        return { id: uid(), kind: 'message', role: (evt.role as 'user' | 'assistant') || 'assistant', content: text, images, created_at: (evt.created_at as string) || '' }
      }
      if (t === 'text_done') {
        const text = (evt.text as string) || ''
        if (!text) return null
        return { id: uid(), kind: 'message', role: 'assistant', content: text, reasoning: actorReasoning, created_at: (evt.created_at as string) || '' }
      }
      if (t === 'tool_call') {
        return { id: uid(), kind: 'tool_call', tool_name: (evt.tool_name as string) || '', arguments: (evt.arguments as Record<string, unknown>) || {}, result: (evt.result as string) || '', is_error: (evt.is_error as boolean) || false, created_at: (evt.created_at as string) || '' }
      }
      if (t === 'observer_text_done') {
        const text = (evt.text as string) || ''
        if (!text) return null
        return { id: uid(), kind: 'observer_message', round_label: (evt.round_label as string) || '', content: text, reasoning: observerReasoning, created_at: (evt.created_at as string) || '' }
      }
      if (t === 'control_tool_call') {
        const s = taskSummaryFromEvent(evt as Parameters<typeof taskSummaryFromEvent>[0])
        if (!s) return null
        return { id: uid(), kind: 'task_summary', summary: s.summary, created_at: (evt.created_at as string) || '' }
      }
      // daemon_*, task_*, llm_prompt → skip
      return null
    }

    return () => { close() }
  }, [sessionId, epoch, close])

  // 僵尸连接看门狗：EventSource 仍 OPEN 但代理把死连接挂住（无 onerror、无事件）→ 浏览器不会
  // 自动重连。后端每 3s 发 ping;若 >5s 无任何事件，判定连接已死，强制 reconnect（重发 Last-Event-ID
  // 拉回错过的事件，如服务重启后的 INTERRUPTED 状态）。
  useEffect(() => {
    if (!sessionId) return
    const id = setInterval(() => {
      const OPEN = (globalThis as { EventSource?: { OPEN: number } }).EventSource?.OPEN ?? 1
      if (esRef.current?.readyState === OPEN && Date.now() - lastEventTimeRef.current > 5_000) {
        reconnect()
      }
    }, 2_000)
    return () => clearInterval(id)
  }, [sessionId, reconnect])

  return { ...state, reconnect, clearLlmError }
}
