// Agent 当前状态条的纯逻辑：把 SSE wire 事件流推导成「当前在干嘛 + 起始时间」，
// 并渲染成 vibe 氛围词 / 工具真名 + 实时时长。无 React 依赖，便于单测。
// 与 frontend-desktop/src/lib/activity.ts 同构（两个工程各一份）。

export type ActivityPhase = 'llm_pending' | 'reasoning' | 'generating' | 'tool' | 'tool_hidden' | 'compacting'

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

export const VIBE_POOLS: Record<'llm_pending' | 'reasoning' | 'generating' | 'tool_hidden' | 'compacting', string[]> = {
  llm_pending: ['组织思路中', '冥思苦想中', '酝酿中', '捋一捋'],
  reasoning: ['抽丝剥茧中', '推演中', '权衡利弊中', '正在推理'],
  generating: ['奋笔疾书中', '正在落笔', '整理成文中', '正在回复'],
  tool_hidden: ['整理思绪中', '规划下一步', '内部协调中', '梳理任务中'],
  compacting: ['正在压缩上下文', '精简记忆中', '整理上下文中', '腾挪窗口中'],
}

function obsSource(evt: WireEvt, prev: ActivityState | null): 'actor' | 'observer' {
  if (evt.source === 'observer' || evt.source === 'actor') return evt.source
  if (evt.type.startsWith('observer_')) return 'observer'
  return prev?.source ?? 'actor'
}

/** (上一个 activity, wire 事件) → 下一个 activity。nowIso 用于「完成→新等待段」的起始时间。 */
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
        started_at: prev?.started_at ?? nowIso,
      }

    case 'text_delta':
    case 'observer_text_delta':
      return {
        phase: 'generating',
        source: obsSource(evt, prev),
        started_at: prev?.started_at ?? nowIso,
      }

    case 'tool_call_started':
      return evt.is_control
        ? { phase: 'tool_hidden', source: obsSource(evt, prev), started_at: evt.created_at || nowIso }
        : { phase: 'tool', tool_name: evt.tool_name || '', source: obsSource(evt, prev), started_at: evt.created_at || nowIso }

    // 一段工作完成 → 回到等待下一信号（新计时段）
    case 'tool_call':
    case 'control_tool_call':
    case 'observer_tool_call':
    case 'observer_control_tool_call':
    case 'text_done':
    case 'observer_text_done':
      return { phase: 'llm_pending', source: prev?.source ?? 'actor', started_at: nowIso }

    case 'compact_started':
      return { phase: 'compacting', source: 'actor', started_at: evt.created_at || nowIso }

    case 'context_compacted':
      // 压缩收尾；紧随其后的 act llm_request_started 会自然接管，这里回落等待段兜底。
      return { phase: 'llm_pending', source: prev?.source ?? 'actor', started_at: nowIso }

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

/** 工具阶段显示真名，其余阶段按 elapsed 从词池轮换。 */
export function activityLabel(activity: ActivityState, elapsedMs: number): string {
  if (activity.phase === 'tool') return `正在执行 ${activity.tool_name}`
  const pool = VIBE_POOLS[activity.phase]
  const idx = Math.floor(Math.max(0, elapsedMs) / VIBE_ROTATE_MS) % pool.length
  return pool[idx]
}
