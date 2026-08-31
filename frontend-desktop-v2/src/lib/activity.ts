// Agent 当前状态条的纯逻辑：把 SSE wire 事件流推导成「当前在干嘛 + 起始时间」，
// 并渲染成 vibe 氛围词 / 工具真名 + 实时时长。无 React 依赖，便于单测。

export type ActivityPhase = 'llm_pending' | 'reasoning' | 'generating' | 'tool' | 'tool_hidden'
export type VibePhase = 'llm_pending' | 'reasoning' | 'generating' | 'tool_hidden'

export interface ActivityState {
  phase: ActivityPhase
  tool_name?: string
  source: 'actor' | 'observer'
  started_at: string // 后端权威 ISO 时间；时长由前端据此 tick
}

interface WireEvt {
  type: string
  source?: string
  tool_name?: string
  is_control?: boolean
  created_at?: string
  status?: string
}

// 进入某 vibe 阶段后每 VIBE_ROTATE_MS 轮换一个词
export const VIBE_ROTATE_MS = 4000

// 每个 vibe 阶段词池的词条数；词条本身在 i18n（键 activity.vibe.<phase>.<idx>）以便国际化。
// 两种语言每阶段须保持同样的条数，否则轮换下标会越界回退到 zh。
export const VIBE_POOL_SIZES: Record<VibePhase, number> = {
  llm_pending: 4,
  reasoning: 4,
  generating: 4,
  tool_hidden: 4,
}

function obsSource(evt: WireEvt, prev: ActivityState | null): 'actor' | 'observer' {
  if (evt.source === 'observer' || evt.source === 'actor') return evt.source
  if (evt.type.startsWith('observer_')) return 'observer'
  return prev?.source ?? 'actor'
}

// reasoning/text 的 delta 没有自己的 created_at（live-only、不持久化），只能续上一段的计时。
// 但只有当上一段属于同一次 LLM turn（等待/推理/生成）时续接才对；若上一段是工具阶段或空
// （工具结果/复位事件丢失、重连错位时会发生），续接会把工具时长错算进推理时长，表现为
// 「奇怪的很长」。此时另起新计时（无 created_at → nowIso），让计时只反映当前推理/生成本身。
function continuesLlmTurn(prev: ActivityState | null): boolean {
  return !!prev && (prev.phase === 'llm_pending' || prev.phase === 'reasoning' || prev.phase === 'generating')
}

/** (上一个 activity, wire 事件) → 下一个 activity。起始时间优先取事件 created_at（服务端
 *  权威时间，保证重连/历史回放连续）；nowIso 仅在事件无 created_at 时兜底。 */
export function reduceActivity(
  prev: ActivityState | null,
  evt: WireEvt,
  nowIso: string = new Date().toISOString(),
): ActivityState | null {
  switch (evt.type) {
    case 'llm_request_started':
      return { phase: 'llm_pending', source: obsSource(evt, prev), started_at: evt.created_at || nowIso }

    case 'reasoning_delta':
    case 'observer_reasoning_delta':
      return {
        phase: 'reasoning',
        source: obsSource(evt, prev),
        started_at: continuesLlmTurn(prev) ? prev!.started_at : (evt.created_at || nowIso),
      }

    case 'text_delta':
    case 'observer_text_delta':
      return {
        phase: 'generating',
        source: obsSource(evt, prev),
        started_at: continuesLlmTurn(prev) ? prev!.started_at : (evt.created_at || nowIso),
      }

    case 'tool_call_started':
      return evt.is_control
        ? { phase: 'tool_hidden', source: obsSource(evt, prev), started_at: evt.created_at || nowIso }
        : { phase: 'tool', tool_name: evt.tool_name || '', source: obsSource(evt, prev), started_at: evt.created_at || nowIso }

    // 一段工作完成 → 回到等待下一信号（新计时段）。新段起点锚到该完成事件的
    // created_at（= 服务端权威时间，上一步结束即当前段开始），仅在缺失时回退 nowIso。
    // 这样历史回放（重连/切回会话）能据持久化时间还原真实起点，而非归零到回放时刻。
    case 'tool_call':
    case 'control_tool_call':
    case 'observer_tool_call':
    case 'observer_control_tool_call':
    case 'text_done':
    case 'observer_text_done':
      return { phase: 'llm_pending', source: prev?.source ?? 'actor', started_at: evt.created_at || nowIso }

    case 'done':
    case 'interrupted':
    case 'waiting_input':
    case 'bash_exec_confirm':
      return null

    case 'session_update':
      return evt.status && evt.status !== 'RUNNING' ? null : prev

    default:
      return prev
  }
}

/** <60s → "Ns"；≥60s → "NmMs"。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${total % 60}s`
}

/** 状态条要显示什么——本模块只算出「显示工具真名」还是「第 index 个氛围词」，
 *  具体文案交给带 i18n 的组件渲染，从而保持本模块无 React 依赖、可纯逻辑单测。 */
export type ActivityLabel =
  | { kind: 'tool'; tool: string }
  | { kind: 'vibe'; phase: VibePhase; index: number }

/** 工具阶段返回真名，其余阶段按 elapsed 在词池内轮换出下标。 */
export function activityLabel(activity: ActivityState, elapsedMs: number): ActivityLabel {
  if (activity.phase === 'tool') return { kind: 'tool', tool: activity.tool_name || '' }
  const size = VIBE_POOL_SIZES[activity.phase]
  const index = Math.floor(Math.max(0, elapsedMs) / VIBE_ROTATE_MS) % size
  return { kind: 'vibe', phase: activity.phase, index }
}
