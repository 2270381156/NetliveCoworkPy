import { useEffect, useRef, useCallback, useState } from 'react'
import type { Session } from '@/types'
import { TERMINAL_STATUSES } from '@/types'
import { now } from '@/lib/utils'
import { reduceActivity } from '@/lib/activity'
import { classifyLlmFailure } from '@/lib/llmError'
import type { ActivityState } from '@/lib/activity'
import { appendPendingToolCall, applyToolCallResult, flushPendingToolCalls } from '@/lib/toolCallMerge'
import { reconcileFromServer, upsertPending } from '@/lib/pendingHitls'
import { hitlApi } from '@/api/hitl'
import { sessionsApi } from '@/api/sessions'
import { httpFor } from '@/api/client'
import { baseOf } from '@/api/backends'
import { extractWebviewContent } from '@/lib/webviewBridge'
import { parseWebSources, type WebSource } from '@/lib/webSources'

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
  /** Compact source metadata attached to a final assistant answer. */
  sources?: WebSource[]
  /** 所属后端 task（一句 query 可被拆成多个 task）。前端据此把同一 task 的
   *  回复+工具调用收成一个胶囊；并发 task 交错时也能各归各的。旧帧没有 → 不分组。 */
  task_id?: string
  /** finish_task 的交付物小结气泡：该 task 的收尾标记，不是过程中的一步。
   *  折叠时与该 task 的最终答复一并留在胶囊外（见 ChatPanel 的 groupItems）。 */
  task_summary?: boolean
  created_at: string
  /** rewind：user 消息所属的用户回合号（后端 turn_seq），用于按回合回滚工作区。 */
  turnSeq?: number
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
  /** 所属后端 task，见 ChatMessage.task_id。 */
  task_id?: string
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
  hitl_id?: string                  // 精确应答用;旧 snapshot 补发的事件可能没有 → 兜底链
  form?: 'approval' | 'question' | 'wait'
  created_at: string
}

export interface ChatHitlAnswer {
  id: string
  kind: 'hitl_answer'
  content: string          // 原始文本（结构化: "1. Q → A\n..."，纯文本: 用户输入）
  prompt?: string          // 原 waiting_input 的 prompt（live 时有，history 时无）
  questions?: AskQuestion[] // 原结构化问题列表（live 时有，history 时无）
  parsedQA?: Array<{ question: string; answer: string }> // 解析后的 Q→A（结构化时有）
  created_at: string
  /** rewind：该用户输入所属回合号（后端 turn_seq），用于按回合回滚工作区。 */
  turnSeq?: number
}

export type ChatItem = ChatMessage | ChatToolCall | ChatWaitingInput | ChatHitlAnswer

export interface SessionNotice {
  kind: 'failed' | 'interrupted'
  reason_code: string
  reason_text: string
  /** agent 判定类死因的结构化字段，供前端按 reason_code 本地化拼文案（reason_text 仅兜底）。 */
  reason_data: { retry_count?: number | null; message?: string }
  failures: Array<{ title: string; reason: string }>
  created_at: string
}

// rewind：一次成功回滚的记录（来自后端持久化的 rewind_record 事件，历史重放也带出来）。
// safetyId：回滚前的工作区安全档 id，撤销时恢复到它（旧记录可能没有 → 不可撤）。
// undone：该回滚已被撤销（收到 rewind_undone）→ 徽章标"已撤销"，且不再提供撤销入口。
export interface RewindRecord { at: number; restored: number; deleted: number; safetyId?: string; undone?: boolean }

// rewind：当前"可撤销"的回滚——全局最近一次、且其后没有新的用户消息/未被撤销。null=无。
// 从事件流推导（见 history/live 处理），刷新/重连后仍一致，只有真正"做了别的操作"才关窗。
export interface UndoableRewind { turnSeq: number; safetyId: string }

/** 后端 task 的展示元信息：一句 query 会被拆成 1~N 个 task，前端按 task 折叠会话。 */
export interface TaskInfo {
  id: string
  title: string
  /** 后端 task 状态（ACTIVE / COMPLETED / FAILED / CANCELED …）。 */
  status: string
}

/** task 已收尾（不再产出）→ 该胶囊可以收起。未知状态按「未完成」处理，宁可展开也不误收。
 *  终态取自后端 TASK_STATUS_BY_EVENT：FINISHED / FAILED / CANCELED；
 *  SUSPENDED（等 HITL 应答）不算收尾，保持展开。COMPLETED 作为容错别名一并接受。 */
export function isTaskDone(status: string | undefined): boolean {
  return status === 'FINISHED' || status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELED'
}

export interface SSEState {
  session: Session | null
  items: ChatItem[]
  /** rewind：turnSeq → 该回合的回滚记录（可多条），挂到对应消息下方。 */
  rewindRecords: Record<number, RewindRecord[]>
  /** rewind：当前可撤销的回滚（全局最近一次、窗口未关）；驱动那条记录旁的「撤销」入口显隐。 */
  undoableRewind: UndoableRewind | null
  /** task_id → 展示元信息（live 来自 task_created/task_updated，历史来自 /tasks 接口）。 */
  tasks: Record<string, TaskInfo>
  /** 多 pending HITL 面板的真值列表（唯一来源；created_at 升序）。 */
  pendingHitls: ChatWaitingInput[]
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
  /** 会话通告（FAILED 死因 / INTERRUPTED 成因，host 合成的持久化帧）；取最后一条，
      kind 与当前 session 状态匹配才消费（ChatPanel/SessionNoticeBar 侧判定）。 */
  notice: SessionNotice | null
  /** history 帧是否已回放完（notice 随 history 下发）。切会话时 init 先到、notice 尚空，
      靠此标志 gate FAILED 提示条：加载未完不渲染，避免闪一下红色兜底框。 */
  historyLoaded: boolean
}

export interface SSEHandle extends SSEState {
  /** 强制重新订阅事件流。用于向已结束会话发消息/恢复运行后，重新建立被终态关闭的连接。 */
  reconnect: () => void
  /** 关闭 LLM 错误弹窗（用户点关闭或恢复运行成功后调用）。 */
  clearLlmError: () => void
  /** 写 pendingHitlRef，供下一条 role=user 消息配对气泡用。 */
  noteHitlAnswerTarget: (item: ChatWaitingInput) => void
  /** 应答成功后乐观移除该条目（真值随后被 reconcile 校准）。 */
  removePendingHitl: (hitlId: string) => void
  /** 回滚成功后乐观补一条回滚记录 + 开启撤销窗口——仅在 SSE 已关（终态，收不到 live rewind_record）时
   *  生效，避免与 live 事件重复。切会话/重连的历史重放会以持久化真值覆盖。 */
  addRewindRecord: (turnSeq: number, rec: RewindRecord) => void
  /** 撤销成功后乐观：把该回合最后一条记录标"已撤销" + 关闭撤销窗口——同样仅在 SSE 已关时生效
   *  （开着交给 live rewind_undone）。 */
  markRewindUndone: (turnSeq: number) => void
}

const EMPTY: SSEState = {
  session: null, items: [], rewindRecords: {}, undoableRewind: null, tasks: {}, pendingHitls: [],
  streamingText: null, streamingReasoning: null, streamingImages: [],
  observerStreamingText: null, currentActivity: null, connected: false, error: null,
  llmError: null, llmRetrying: false, llmRetryProgress: null, interruptReason: null,
  notice: null, historyLoaded: false,
}

const firstNonWait = (list: ChatWaitingInput[]) => list.find(w => w.form !== 'wait') ?? null

// rewind：把某回合【最后一条】回滚记录标成"已撤销"（撤销只作用于最近一次）。返回新引用。
function markLastUndone(records: Record<number, RewindRecord[]>, turnSeq: number): Record<number, RewindRecord[]> {
  const recs = records[turnSeq]
  if (!recs || recs.length === 0) return records
  const next = recs.slice()
  next[next.length - 1] = { ...next[next.length - 1], undone: true }
  return { ...records, [turnSeq]: next }
}

let _idCounter = 0
function uid() { return `sse-${Date.now()}-${_idCounter++}` }

function noticeFrom(evt: Record<string, unknown>): SessionNotice {
  return {
    kind: (evt.kind as SessionNotice['kind']) || 'failed',
    reason_code: (evt.reason_code as string) || '',
    reason_text: (evt.reason_text as string) || '',
    reason_data: (evt.reason_data as SessionNotice['reason_data']) || {},
    failures: (evt.failures as Array<{ title: string; reason: string }>) || [],
    created_at: (evt.created_at as string) || '',
  }
}

// finish_task 现在只是收尾标记（最终答复走普通消息 text_done）；其可选参数
// deliverables_summary（交付物小结）渲染成一条助手消息 → 走 MessageRow 的 AI 分支，与普通答复气泡完全一致。
// SSE tool_name 为 capability_name（control__finish_task）；历史/裸名 finish_task 也认。
const FINISH_TASK_TOOLS = ['control__finish_task', 'finish_task']

function finishBubbleFromEvent(evt: Record<string, unknown>, idFn: () => string): ChatMessage | null {
  if (!FINISH_TASK_TOOLS.includes(evt.tool_name as string)) return null
  const args = (evt.arguments as Record<string, unknown>) || {}
  // 新契约：产出小结在 arguments.deliverables_summary。
  let summary = String(args.deliverables_summary ?? '').trim()
  // 旧数据兼容：早期答复塞在 arguments.result，且仅根任务（is_root）展示。
  // 注意取 arguments.result，不是事件顶层 result（那是 "Task ... submitted." 的回执）。
  if (!summary && evt.is_root === true) summary = String(args.result ?? '').trim()
  if (!summary) return null   // 小结为空/纯空白 → 不渲染（保持静默）
  // 带上 task_id：否则这条小结不归属任何 task，会把该 task 的胶囊从中间劈成两半。
  // task_summary 让 groupItems 把它与该 task 的最终答复一起留在胶囊外，而不是
  // 顶替掉答复（小结通常只是交付物清单，答复才是正文）。
  return {
    id: idFn(), kind: 'message', role: 'assistant', content: summary,
    task_id: (evt.task_id as string) || undefined,
    task_summary: true,
    created_at: (evt.created_at as string) || '',
  }
}

// ── 僵尸连接看门狗判定（纯函数，便于测试）────────────────────────────────────
// 看门狗每 periodMs 跑一次，靠「距上次收到事件是否超过 silenceMs」判连接死活。
// 陷阱：lastEvent 记的是「事件处理器上次真正执行」的时刻，而非网络上次送达。
// 当主线程被长按/输入法/布局抖动卡死时，排队的 ping 处理器跑不了 → 事件看似"沉默"，
// 但连接其实是好的。此时若重连，会重发 init 把 pendingHitls 清空、卸载 HITL 面板，
// 用户正在填的文字和已选选项瞬间全丢。
// 判据：本次 tick 距上次 tick 的真实墙钟间隔若远超周期（>2×），说明看门狗自己也被
// 一起饿死了 → 沉默是自身卡顿造成的，不重连，只把事件基线顺延，等下个正常周期再判。
export function evaluateWatchdog(args: {
  isOpen: boolean
  now: number
  lastTick: number
  lastEvent: number
  periodMs: number
  silenceMs: number
}): { reconnect: boolean; starved: boolean } {
  const { isOpen, now, lastTick, lastEvent, periodMs, silenceMs } = args
  if (now - lastTick > periodMs * 2) return { reconnect: false, starved: true }
  return { reconnect: isOpen && now - lastEvent > silenceMs, starved: false }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSessionSSE(sessionId: string | null): SSEHandle {
  const [state, setState] = useState<SSEState>(EMPTY)
  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // 最近一次收到任意事件（含 ping）的时刻；僵尸连接看门狗据此判活。
  const lastEventTimeRef = useRef<number>(Date.now())
  // 待关联的 HITL 上下文：waiting_input 到达时写入，下一条 role=user message 消费后清空
  const pendingHitlRef = useRef<ChatWaitingInput | null>(null)
  // pendingHitls 列表被本地裁剪（应答/配对）的代次；reconcile 快照若落后于当前代，说明
  // 期间又有本地裁剪发生（快照可能已过期），须丢弃而非覆盖，防止把刚裁剪的条目复活。
  const pendingEpochRef = useRef(0)
  // 重连代：bump 后 effect 重新订阅（向已结束会话恢复运行/僵尸连接重连时用）
  const [epoch, setEpoch] = useState(0)

  const close = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
  }, [])

  const reconnect = useCallback(() => setEpoch(e => e + 1), [])

  const clearLlmError = useCallback(() => setState(s => (s.llmError ? { ...s, llmError: null } : s)), [])

  const setPendingList = useCallback((updater: (prev: ChatWaitingInput[]) => ChatWaitingInput[]) => {
    setState(s => ({ ...s, pendingHitls: updater(s.pendingHitls) }))
  }, [])

  const reconcilePending = useCallback(async (sid: string) => {
    const epoch = pendingEpochRef.current
    try {
      const server = await hitlApi.pending(sid)
      if (sessionIdRef.current !== sid) return        // 已切会话:防跨会话污染
      if (pendingEpochRef.current !== epoch) return   // 期间有本地裁剪(应答/配对):快照过期,丢弃
      setPendingList(prev => reconcileFromServer(prev, server))
    } catch { /* 失败保留现有列表:宁 stale 可操作(幂等)也不误隐藏;下个触发点重试 */ }
  }, [setPendingList])

  const noteHitlAnswerTarget = useCallback((item: ChatWaitingInput) => { pendingHitlRef.current = item }, [])
  const removePendingHitl = useCallback((hitlId: string) => {
    pendingEpochRef.current++
    setPendingList(prev => prev.filter(w => w.hitl_id !== hitlId))
  }, [setPendingList])
  const addRewindRecord = useCallback((turnSeq: number, rec: RewindRecord) => {
    // SSE 还开着（会话运行中）→ live rewind_record 会来，交给它，别乐观加造成重复。
    // 已关（终态，最常见的回滚时机）→ live 收不到，这里据 HTTP 响应乐观补上，并开启撤销窗口。
    if (esRef.current) return
    setState(s => ({ ...s,
      rewindRecords: { ...s.rewindRecords, [turnSeq]: [...(s.rewindRecords[turnSeq] || []), rec] },
      undoableRewind: rec.safetyId ? { turnSeq, safetyId: rec.safetyId } : null,
    }))
  }, [])
  const markRewindUndone = useCallback((turnSeq: number) => {
    if (esRef.current) return   // SSE 开着 → 交给 live rewind_undone
    setState(s => ({ ...s,
      rewindRecords: markLastUndone(s.rewindRecords, turnSeq),
      undoableRewind: null,
    }))
  }, [])

  useEffect(() => {
    if (!sessionId) {
      close()
      setState(EMPTY)
      return
    }

    close()
    const sid: string = sessionId          // 收窄后固化，供下面的事件回调闭包使用
    const isNewSession = sessionIdRef.current !== sessionId
    sessionIdRef.current = sessionId
    // 仅切换会话时清空；同会话重连（epoch）保留已渲染内容，靠稳定 key 原地协调，避免空屏闪烁
    if (isNewSession) setState(EMPTY)

    // ?lean=1：要精简版 history，后端剔除 llm_prompt/daemon_prompt（占大会话首帧 payload 98%，
    // 桌面端不消费）。调试前端 frontend/ 不带此参数，照常收到 prompt 卡片。
    // 事件流也按会话定址：云端会话的流来自云上那个实例（见 api/backends.ts）。
    const es = new EventSource(`${baseOf(sessionId)}/sessions/${sessionId}/stream?lean=1`)
    esRef.current = es
    lastEventTimeRef.current = Date.now()

    es.onopen = () => { lastEventTimeRef.current = Date.now(); setState(s => ({ ...s, connected: true, error: null })) }
    es.onerror = () => setState(s => ({ ...s, connected: false, error: '连接断开，正在重连…' }))

    es.onmessage = (event) => {
      lastEventTimeRef.current = Date.now()
      try { handle(JSON.parse(event.data as string)) } catch { /* ignore */ }
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

      // view_side_web_page 工具的现取请求：抓取当前 webview 内容，回传给后端解 future。
      if (type === 'webview_content_request') {
        const requestId = data.request_id as string
        const sid = sessionIdRef.current
        if (requestId && sid) {
          void extractWebviewContent().then(content => {
            httpFor(sid).post(`/sessions/${sid}/webview-content`, {
              request_id: requestId,
              url: content?.url ?? '',
              title: content?.title ?? '',
              text: content?.text ?? '',
              headings: content?.headings ?? [],
              links: content?.links ?? [],
            }).catch(() => {})   // 超时/无网页 → 后端自会回退
          })
        }
        return
      }

      if (type === 'history') {
        const events = (data.events as Array<Record<string, unknown>>) || []
        const historyItems: ChatItem[] = []
        const historyRewind: Record<number, RewindRecord[]> = {}   // rewind：回滚记录（挂到对应回合）
        // 长会话性能：tool_call 用 Map<tool_call_id → 下标> O(1) 定位，就地 push/改，
        // 不再走 appendPendingToolCall/applyToolCallResult 的「全量扫描 + 整数组 spread 复制」——
        // 那是 O(n²)，几万条工具事件会把主线程卡到白屏。回放过程只 append 不删，下标恒稳。
        const toolIdx = new Map<string, number>()
        let actorReasoning: string | undefined
        let activity: ActivityState | null = null
        let lastNotice: SessionNotice | null = null
        let lastGoal: string | null = null
        // rewind：边回放边算"当前可撤销的回滚"。最后一条带 safetyId 的 rewind_record 即候选；
        // 其后出现用户消息 / hitl_answer / rewind_undone → 关窗（置 null）。留到最后仍在的即窗口。
        let undoable: UndoableRewind | null = null
        for (const evt of events) {
          const et = evt.type as string
          activity = reduceActivity(activity, evt as unknown as Parameters<typeof reduceActivity>[1])
          if (et === 'reasoning_done') { actorReasoning = (evt.text as string) || undefined; continue }
          if (et === 'rewind_record') {                // rewind：侧数据，挂到对应回合、不入 items
            const ts = evt.turn_seq
            if (typeof ts === 'number') {
              const safetyId = (evt.safety_checkpoint_id as string) || undefined
              ;(historyRewind[ts] ||= []).push({
                at: Date.parse((evt.created_at as string) || '') || Date.now(),
                restored: (evt.restored as number) || 0, deleted: (evt.deleted as number) || 0,
                safetyId,
              })
              // 新回滚顶替上一个候选：能撤才设窗口，没 safetyId（旧数据）则关窗。
              undoable = safetyId ? { turnSeq: ts, safetyId } : null
            }
            continue
          }
          if (et === 'rewind_undone') {                // rewind：撤销事件 → 标该回合最后一条记录已撤销 + 关窗
            const ts = evt.turn_seq
            if (typeof ts === 'number') {
              const recs = historyRewind[ts]
              if (recs && recs.length) recs[recs.length - 1] = { ...recs[recs.length - 1], undone: true }
            }
            undoable = null
            continue
          }
          if (et === 'observer_reasoning_done') continue   // 观察者复盘文本，历史不渲染
          if (et === 'waiting_input') continue
          if (et === 'session_notice') { lastNotice = noticeFrom(evt); continue }
          if (et === 'session_goal_updated') {
            const goal = (evt.goal as string) || ''
            if (goal) lastGoal = goal
            continue
          }
          if (et === 'tool_call_pending') {
            const tcid = (evt.tool_call_id as string) || ''
            if (toolIdx.has(tcid)) continue   // 幂等：同 id 已建气泡（等价旧 items.some）
            toolIdx.set(tcid, historyItems.length)
            historyItems.push({
              id: uid(), kind: 'tool_call', tool_call_id: tcid, status: 'pending',
              tool_name: (evt.tool_name as string) || '',
              arguments: (evt.arguments as Record<string, unknown>) || {},
              result: '', is_error: false, task_id: (evt.task_id as string) || undefined,
              created_at: (evt.created_at as string) || '',
            })
            continue
          }
          if (et === 'tool_call') {
            const tcid = (evt.tool_call_id as string) || ''
            const at = toolIdx.get(tcid)
            const prev = at !== undefined ? historyItems[at] as ChatToolCall : undefined
            if (prev && prev.status === 'pending') {   // 原地填结果
              historyItems[at as number] = {
                ...prev, status: 'done', result: (evt.result as string) || '',
                is_error: (evt.is_error as boolean) || false,
                task_id: prev.task_id || (evt.task_id as string) || undefined,
                created_at: (evt.created_at as string) || prev.created_at,
              }
            } else {                                   // 无匹配 pending → 追加「已完成」气泡（回放缺口兜底）
              toolIdx.set(tcid, historyItems.length)
              historyItems.push({
                id: uid(), kind: 'tool_call', tool_call_id: tcid, status: 'done',
                tool_name: (evt.tool_name as string) || '',
                arguments: (evt.arguments as Record<string, unknown>) || {},
                result: (evt.result as string) || '',
                is_error: (evt.is_error as boolean) || false,
                task_id: (evt.task_id as string) || undefined,
                created_at: (evt.created_at as string) || '',
              })
            }
            continue
          }
          // rewind：用户又开口（发消息 / 答 HITL）→ 关闭撤销窗口（约束②：做了别的操作就不能撤）。
          if (et === 'message' && (evt.role as string) === 'user') undoable = null
          const item = evtToItem(evt, actorReasoning)
          // 稳定 key：按回放顺序定址（h0/h1/…），不用 Date.now() 的 uid。重连重发 history 时
          // key 不变 → React 原地复用节点、不重挂载、不重播进场动画，杜绝闪动。
          if (item) {
            item.id = `h${historyItems.length}`
            historyItems.push(item)
          }
          if (et === 'text_done') actorReasoning = undefined
        }
        // 计时起点复位到"现在"：历史回放重建 activity 是为了重连后能立刻显示当前
        // 阶段，但绝不能沿用「上一轮结束事件(text_done/finish_task)的旧时间戳」——
        // 否则计时从很久以前起算(重连/发消息续跑时尤其明显)。复位后从 0 起算。
        if (activity) activity = { ...activity, started_at: new Date().toISOString() }
        setState(s => {
          // 已终态(非 RUNNING/QUEUED)的会话不重建氛围词，避免打开/重连已结束会话时
          // 闪出一条“等待”。真正在跑的话，随后的实时事件也会无条件驱动显示。
          const running = s.session?.status === 'RUNNING' || s.session?.status === 'QUEUED'
          return {
            ...s,
            session: s.session && lastGoal ? { ...s.session, goal: lastGoal } : s.session,
            items: historyItems,
            rewindRecords: historyRewind,
            undoableRewind: undoable,
            currentActivity: running ? activity : null,
            notice: lastNotice,
            historyLoaded: true,
          }
        })
        // task 元信息（标题/状态）不进 history 帧 → 单独补一次，重开会话才知道哪些 task 已收尾
        // 该收起。失败不影响正文：拿不到就当未知状态（保持展开）。
        sessionsApi.tasks(sid)
          .then(list => {
            const map: Record<string, TaskInfo> = {}
            for (const t of list) {
              if (!t?.id) continue
              map[t.id] = { id: t.id, title: t.title || '', status: t.status || '' }
            }
            if (Object.keys(map).length === 0) return
            // 已到的 live 事件更新（比快照新）优先，不被这次回填覆盖。
            setState(s => ({ ...s, tasks: { ...map, ...s.tasks } }))
          })
          .catch(() => {})
        return
      }

      // 每个事件都喂给状态条 reducer（无变化时返回原引用，避免多余重渲染）。
      // 显隐由 ChatPanel 的「运行中才显示」门控制，故这里即使把活动推成非空，
      // 暂停/结束后也不会显示，无需在此额外压制。
      setState(s => {
        const ca = reduceActivity(s.currentActivity, data as unknown as Parameters<typeof reduceActivity>[1])
        return ca === s.currentActivity ? s : { ...s, currentActivity: ca }
      })

      if (type === 'init') {
        const session = data.session as Session
        const messages = (data.messages as Array<Record<string, unknown>>) || []
        setState(s => {
          if (s.items.length > 0) {
            return { ...s, session, pendingHitls: [], streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, connected: true, error: null }
          }
          const items: ChatItem[] = messages.map(m => {
            const { text, images } = parseContent(m.content)
            return { id: uid(), kind: 'message' as const, role: (m.role as 'user' | 'assistant') || 'assistant', content: text, images, created_at: (m.created_at as string) || '', turnSeq: typeof m.turn_seq === 'number' ? m.turn_seq : undefined }
          })
          return { ...EMPTY, session, items, connected: true }
        })
        const st = (data.session as Session | undefined)?.status
        if ((st === 'PAUSED' || st === 'PAUSED_HITL' || st === 'RUNNING') && sessionIdRef.current) {
          void reconcilePending(sessionIdRef.current)   // 重连/重启：以 pending 真值替换 stale 补发
        }
        return
      }

      if (type === 'token_update') {
        setState(s => ({ ...s, session: s.session ? { ...s.session, input_tokens_used: (data.input_tokens_used as number) ?? s.session.input_tokens_used, output_tokens_used: (data.output_tokens_used as number) ?? s.session.output_tokens_used, context_tokens: (data.context_tokens as number) ?? s.session.context_tokens, cache_read_tokens_used: (data.cache_read_tokens_used as number) ?? s.session.cache_read_tokens_used, cache_write_tokens_used: (data.cache_write_tokens_used as number) ?? s.session.cache_write_tokens_used } : s.session }))
        return
      }

      if (type === 'session_goal_updated') {
        const goal = (data.goal as string) || ''
        if (!goal) return
        setState(s => ({
          ...s,
          session: s.session ? { ...s.session, goal } : s.session,
        }))
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
          // run 走到终态：内核对「执行前硬拒绝」（准入层拒写等）不发 tool_call 终态事件，
          // 会留下卡在「执行中…」的气泡 → 就地收成终态，避免永久悬挂。
          const items = TERMINAL_STATUSES.includes(status)
            ? flushPendingToolCalls(s.items, '(该调用已被拒绝/结束，未回传独立结果)')
            : s.items
          return {
            ...s,
            items,
            session: updated,
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
        // 有条目被解决(或状态变化) → 拉服务端真值校准列表(替代旧的"RUNNING 即清空")
        if ((data.status as Session['status']) === 'RUNNING' && sessionIdRef.current) void reconcilePending(sessionIdRef.current)
        return
      }

      if (type === 'session_notice') {
        setState(s => ({ ...s, notice: noticeFrom(data) }))
        return
      }


      if (type === 'message') {
        const { text, images } = parseContent(data.content)
        const role = (data.role as 'user' | 'assistant') || 'assistant'
        const hitlCtx = role === 'user' ? pendingHitlRef.current : null
        if (hitlCtx) pendingHitlRef.current = null
        setState(s => {
          // 备用：pendingHitlRef 丢失时（重连乱序等），用 pendingHitls 首条非 wait 兜底，同时清掉悬挂的对话框
          const effectiveCtx = hitlCtx ?? (role === 'user' ? firstNonWait(s.pendingHitls) : null)
          const item = effectiveCtx
            ? makeHitlAnswer(uid(), text, effectiveCtx, (data.created_at as string) || now(), typeof data.turn_seq === 'number' ? data.turn_seq : undefined)
            : { id: uid(), kind: 'message' as const, role, content: text, images, created_at: (data.created_at as string) || now(), turnSeq: typeof data.turn_seq === 'number' ? data.turn_seq : undefined }
          // 已回答条目也要从 pendingHitls 真值列表移除，否则下次校准/重连会把它复活
          if (effectiveCtx) pendingEpochRef.current++
          const pendingHitls = effectiveCtx
            ? s.pendingHitls.filter(w => (effectiveCtx.hitl_id ? w.hitl_id !== effectiveCtx.hitl_id : w.id !== effectiveCtx.id))
            : s.pendingHitls
          // rewind：用户又开口 → 关闭撤销窗口（约束②）。
          const undoableRewind = role === 'user' ? null : s.undoableRewind
          return { ...s, items: [...s.items, item], pendingHitls, undoableRewind }
        })
        return
      }

      if (type === 'rewind_record') {              // rewind：回滚记录（实时），挂到对应回合消息下方
        const ts = data.turn_seq
        if (typeof ts === 'number') {
          const safetyId = (data.safety_checkpoint_id as string) || undefined
          setState(s => ({ ...s,
            rewindRecords: { ...s.rewindRecords, [ts]: [...(s.rewindRecords[ts] || []), {
              at: Date.parse((data.created_at as string) || '') || Date.now(),
              restored: (data.restored as number) || 0, deleted: (data.deleted as number) || 0,
              safetyId,
            }] },
            undoableRewind: safetyId ? { turnSeq: ts, safetyId } : null,
          }))
        }
        return
      }

      if (type === 'rewind_undone') {              // rewind：撤销事件（实时）→ 标最后一条记录已撤销 + 关窗
        const ts = data.turn_seq
        if (typeof ts === 'number') {
          setState(s => ({ ...s, rewindRecords: markLastUndone(s.rewindRecords, ts), undoableRewind: null }))
        }
        return
      }

      // task 生命周期：只取展示要用的 id/title/status，驱动「运行中展开 / 干完收起」。
      if (type === 'task_created' || type === 'task_updated') {
        const task = data.task as { id?: string; title?: string; status?: string } | undefined
        const id = task?.id || ''
        if (!id) return
        setState(s => {
          const prev = s.tasks[id]
          const next: TaskInfo = {
            id,
            title: task?.title || prev?.title || '',
            status: task?.status || prev?.status || 'ACTIVE',
          }
          if (prev && prev.title === next.title && prev.status === next.status) return s
          return { ...s, tasks: { ...s.tasks, [id]: next } }
        })
        return
      }

      if (type === 'tool_call_pending') {
        setState(s => ({ ...s, items: appendPendingToolCall(s.items, {
          tool_call_id: (data.tool_call_id as string) || '',
          tool_name: (data.tool_name as string) || '',
          arguments: (data.arguments as Record<string, unknown>) || {},
          task_id: (data.task_id as string) || '',
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
          task_id: (data.task_id as string) || '',
          created_at: (data.created_at as string) || now(),
        }, uid) }))
        return
      }

      // finish_task（spec 2026-07-01 起）：最终答复即消息正文（已由 text_done 渲染成气泡）。
      // finish_task 的 deliverables_summary（交付物小结）渲染成一条助手气泡；其它 control 工具静默忽略。
      if (type === 'control_tool_call') {
        const item = finishBubbleFromEvent({ ...data, created_at: (data.created_at as string) || now() }, uid)
        if (item) setState(s => ({ ...s, items: [...s.items, item] }))
        return
      }

      if (type === 'waiting_input' || type === 'bash_exec_confirm') {
        const hitl_kind: 'approval' | 'input' = type === 'bash_exec_confirm' || data.kind === 'approval' ? 'approval' : 'input'
        const item: ChatWaitingInput = { id: uid(), kind: 'waiting_input', prompt: (data.prompt as string) || '', input_type: type === 'bash_exec_confirm' ? 'bash_exec_confirm' : ((data.input_type as string) || 'user_input'), hitl_kind, task_title: (data.task_title as string) || '', command: type === 'bash_exec_confirm' ? (data.command as string) || '' : undefined, arguments: (data.arguments as Record<string, unknown>) || {}, questions: (data.questions as AskQuestion[]) || [], hitl_id: (data.hitl_id as string) || undefined, form: (data.form as ChatWaitingInput['form']) || undefined, created_at: now() }
        if (hitl_kind === 'input') pendingHitlRef.current = item
        setPendingList(prev => upsertPending(prev, item))
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
        const sources = parseWebSources(data.sources)
        setState(s => {
          if (!text && s.streamingImages.length === 0 && !s.streamingReasoning && sources.length === 0) return { ...s, streamingText: null, streamingReasoning: null }
          const item: ChatMessage = { id: uid(), kind: 'message', role: 'assistant', content: text, reasoning: s.streamingReasoning || undefined, images: s.streamingImages.length > 0 ? s.streamingImages : undefined, sources: sources.length > 0 ? sources : undefined, task_id: (data.task_id as string) || undefined, created_at: now() }
          return { ...s, items: [...s.items, item], streamingText: null, streamingReasoning: null, streamingImages: [] }
        })
        return
      }

      if (type === 'reasoning_done') {
        const reasoning = (data.text as string) || ''
        if (reasoning) setState(s => ({ ...s, streamingReasoning: reasoning }))
        return
      }

      // observer 消息（紫色 observer 行）一律不展示——无论有无内容。
      // 连流式过程文本也不累积，否则实时运行时会闪一段灰色 observer 文本。
      if (type === 'observer_text_delta') return
      if (type === 'observer_text_done') {
        setState(s => (s.observerStreamingText === null ? s : { ...s, observerStreamingText: null }))
        return
      }

      if (type === 'done') {
        // 终态：主动关闭 EventSource，阻止浏览器对已结束会话每 3s（retry）自动重连。
        // 否则重连会反复重发 init/history，整列消息重刷 → 持续闪动。恢复运行靠 reconnect()。
        close()
        setState(s => ({ ...s, pendingHitls: [], streamingText: null, streamingReasoning: null, streamingImages: [], observerStreamingText: null, llmRetrying: false, llmRetryProgress: null, session: s.session ? { ...s.session, status: (data.final_status as Session['status']) || s.session.status } : s.session }))
      }

      // Silently ignore: daemon_*, task_*, llm_prompt
    }

    function parseStructuredQA(text: string): Array<{ question: string; answer: string }> | null {
      const lines = text.trim().split('\n').filter(Boolean)
      if (!lines.length) return null
      const SEP = ' → '
      const parsed = lines.map(line => {
        const m = line.match(/^(\d+)\. (.+)$/)
        if (!m) return null
        const body = m[2]
        // lastIndexOf：q.question 本身可能含 " → "（流程图/箭头），答案在最后；取最后一个分隔符
        const idx = body.lastIndexOf(SEP)
        if (idx === -1) return null
        // 还原提交时转义的换行（q.question 含换行时序列化为字面 \n）
        return { question: body.slice(0, idx).replace(/\\n/g, '\n'), answer: body.slice(idx + SEP.length) }
      })
      return parsed.every(Boolean) ? (parsed as Array<{ question: string; answer: string }>) : null
    }

    function makeHitlAnswer(id: string, text: string, ctx: ChatWaitingInput | null, created_at: string, turnSeq?: number): ChatHitlAnswer {
      const parsedQA = parseStructuredQA(text) ?? undefined
      return { id, kind: 'hitl_answer', content: text, prompt: ctx?.prompt, questions: ctx?.questions, parsedQA, created_at, turnSeq }
    }

    function evtToItem(evt: Record<string, unknown>, actorReasoning?: string): ChatItem | null {
      const t = evt.type as string
      if (t === 'message') {
        const { text, images } = parseContent(evt.content)
        const role = (evt.role as 'user' | 'assistant') || 'assistant'
        // 历史回放：结构化问答格式（"1. Q → A\n..."）→ hitl_answer
        const evtTurn = typeof evt.turn_seq === 'number' ? evt.turn_seq : undefined
        if (role === 'user' && (parseStructuredQA(text) || (/^[1-9]\d*\. /.test(text.trim()) && text.includes(' → ')))) {
          return makeHitlAnswer(uid(), text, null, (evt.created_at as string) || '', evtTurn)
        }
        return { id: uid(), kind: 'message', role, content: text, images, created_at: (evt.created_at as string) || '', turnSeq: evtTurn }
      }
      if (t === 'text_done') {
        const text = (evt.text as string) || ''
        const sources = parseWebSources(evt.sources)
        if (!text && !actorReasoning && sources.length === 0) return null
        return { id: uid(), kind: 'message', role: 'assistant', content: text, reasoning: actorReasoning, sources: sources.length > 0 ? sources : undefined, task_id: (evt.task_id as string) || undefined, created_at: (evt.created_at as string) || '' }
      }
      // observer 消息一律不展示（含历史回放）。
      if (t === 'observer_text_done') return null
      // finish_task 收尾标记的 deliverables_summary → 助手气泡（回放路径随后覆盖为稳定 h<n> key）
      if (t === 'control_tool_call') return finishBubbleFromEvent(evt, uid)
      // 其它 control_tool_call、daemon_*, task_*, llm_prompt → skip
      return null
    }

    return () => { close() }
  }, [sessionId, epoch, close])

  // 僵尸连接看门狗：EventSource 仍 OPEN 但代理把死连接挂住（无 onerror、无事件）→ 浏览器不会
  // 自动重连。后端每 3s 发 ping;若 >5s 无任何事件，判定连接已死，强制 reconnect（重发 Last-Event-ID
  // 拉回错过的事件，如服务重启后的 INTERRUPTED 状态）。
  useEffect(() => {
    if (!sessionId) return
    const PERIOD = 2_000
    const SILENCE = 5_000
    let lastTick = Date.now()
    const id = setInterval(() => {
      const OPEN = (globalThis as { EventSource?: { OPEN: number } }).EventSource?.OPEN ?? 1
      const now = Date.now()
      const { reconnect: doReconnect, starved } = evaluateWatchdog({
        isOpen: esRef.current?.readyState === OPEN,
        now, lastTick, lastEvent: lastEventTimeRef.current, periodMs: PERIOD, silenceMs: SILENCE,
      })
      lastTick = now
      // 主线程刚被卡住（沉默是自身饿死造成的）：顺延事件基线，别误判死连接去重连——
      // 那会卸载 HITL 面板、清掉用户正在填的输入。等下个正常周期再重新判活。
      if (starved) { lastEventTimeRef.current = now; return }
      if (doReconnect) reconnect()
    }, PERIOD)
    return () => clearInterval(id)
  }, [sessionId, reconnect])

  return { ...state, reconnect, clearLlmError, noteHitlAnswerTarget, removePendingHitl, addRewindRecord, markRewindUndone }
}
