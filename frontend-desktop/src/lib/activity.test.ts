import { describe, it, expect } from 'vitest'
import { reduceActivity, activityLabel, formatDuration, VIBE_POOL_SIZES } from './activity'
import type { ActivityState } from './activity'

const NOW = '2026-06-15T00:00:10.000Z'

describe('reduceActivity', () => {
  it('starts an llm_pending activity on llm_request_started', () => {
    const next = reduceActivity(null, { type: 'llm_request_started', source: 'actor', created_at: '2026-06-15T00:00:00.000Z' }, NOW)
    expect(next).toEqual({ phase: 'llm_pending', source: 'actor', started_at: '2026-06-15T00:00:00.000Z' })
  })

  it('keeps started_at when llm_pending transitions to reasoning then generating', () => {
    const a = reduceActivity(null, { type: 'llm_request_started', source: 'actor', created_at: '2026-06-15T00:00:00.000Z' }, NOW)!
    const b = reduceActivity(a, { type: 'reasoning_delta' }, NOW)!
    expect(b).toEqual({ phase: 'reasoning', source: 'actor', started_at: '2026-06-15T00:00:00.000Z' })
    const c = reduceActivity(b, { type: 'text_delta' }, NOW)!
    expect(c.phase).toBe('generating')
    expect(c.started_at).toBe('2026-06-15T00:00:00.000Z')
  })

  it('does NOT inherit a stale tool anchor into reasoning (resets the timer)', () => {
    // Bug: a missed tool_call result / reconnect mid-tool leaves prev in the `tool`
    // phase with an old started_at; reasoning must NOT absorb the tool's duration
    // (otherwise the timer reads as a "strangely long" reasoning event).
    const tool: ActivityState = { phase: 'tool', tool_name: 'bash_exec', source: 'actor', started_at: '2026-06-15T00:00:00.000Z' }
    const next = reduceActivity(tool, { type: 'reasoning_delta' }, NOW)!
    expect(next.phase).toBe('reasoning')
    expect(next.started_at).toBe(NOW)   // fresh, not the 10s-old tool start
  })

  it('does NOT inherit a stale tool_hidden anchor into generating', () => {
    const ctrl: ActivityState = { phase: 'tool_hidden', source: 'actor', started_at: '2026-06-15T00:00:00.000Z' }
    const next = reduceActivity(ctrl, { type: 'text_delta' }, NOW)!
    expect(next.phase).toBe('generating')
    expect(next.started_at).toBe(NOW)
  })

  it('shows the real tool name for a non-control tool_call_started', () => {
    const next = reduceActivity(null, { type: 'tool_call_started', tool_name: 'bash_exec', is_control: false, source: 'actor', created_at: NOW }, NOW)
    expect(next).toEqual({ phase: 'tool', tool_name: 'bash_exec', source: 'actor', started_at: NOW })
  })

  it('hides control tools into tool_hidden phase', () => {
    const next = reduceActivity(null, { type: 'tool_call_started', tool_name: 'finish_task', is_control: true, source: 'actor', created_at: NOW }, NOW)
    expect(next!.phase).toBe('tool_hidden')
    expect(next!.tool_name).toBeUndefined()
  })

  it('returns to llm_pending (new wait) after a finished tool_call', () => {
    const tool: ActivityState = { phase: 'tool', tool_name: 'bash_exec', source: 'actor', started_at: '2026-06-15T00:00:00.000Z' }
    const next = reduceActivity(tool, { type: 'tool_call' }, NOW)
    expect(next).toEqual({ phase: 'llm_pending', source: 'actor', started_at: NOW })
  })

  it('returns to llm_pending after text_done', () => {
    const gen: ActivityState = { phase: 'generating', source: 'actor', started_at: '2026-06-15T00:00:00.000Z' }
    const next = reduceActivity(gen, { type: 'text_done' }, NOW)
    expect(next).toEqual({ phase: 'llm_pending', source: 'actor', started_at: NOW })
  })

  it('anchors the post-completion wait to the event time, not wall-clock now', () => {
    // On history replay the reducer runs without an explicit nowIso; a completed
    // event must anchor the new wait segment to its own created_at so the timer
    // reflects real elapsed time, not the (much later) moment of replay.
    const t0 = '2026-06-15T00:00:00.000Z'
    const next = reduceActivity(null, { type: 'tool_call', created_at: t0 })
    expect(next).toEqual({ phase: 'llm_pending', source: 'actor', started_at: t0 })
  })

  it('reconstructs the current wait start from the last completed event on replay', () => {
    // Mimic sse history replay (completion events only, each with created_at, no nowIso).
    const evts = [
      { type: 'message', created_at: '2026-06-15T00:00:00.000Z' },
      { type: 'text_done', created_at: '2026-06-15T00:01:00.000Z' },
      { type: 'tool_call', created_at: '2026-06-15T00:02:00.000Z' },
    ]
    let a: ActivityState | null = null
    for (const e of evts) a = reduceActivity(a, e)
    expect(a).toEqual({ phase: 'llm_pending', source: 'actor', started_at: '2026-06-15T00:02:00.000Z' })
  })

  it('clears on done / interrupted / waiting_input', () => {
    const gen: ActivityState = { phase: 'generating', source: 'actor', started_at: NOW }
    expect(reduceActivity(gen, { type: 'done' }, NOW)).toBeNull()
    expect(reduceActivity(gen, { type: 'interrupted' }, NOW)).toBeNull()
    expect(reduceActivity(gen, { type: 'waiting_input' }, NOW)).toBeNull()
  })

  it('clears on a terminal session_update but not on RUNNING', () => {
    const gen: ActivityState = { phase: 'generating', source: 'actor', started_at: NOW }
    expect(reduceActivity(gen, { type: 'session_update', status: 'SUCCEEDED' }, NOW)).toBeNull()
    expect(reduceActivity(gen, { type: 'session_update', status: 'RUNNING' }, NOW)).toBe(gen)
  })

  it('marks observer source from observer deltas', () => {
    const next = reduceActivity(null, { type: 'observer_reasoning_delta' }, NOW)
    expect(next!.phase).toBe('reasoning')
    expect(next!.source).toBe('observer')
  })

  it('ignores unrelated events', () => {
    const gen: ActivityState = { phase: 'generating', source: 'actor', started_at: NOW }
    expect(reduceActivity(gen, { type: 'token_update' }, NOW)).toBe(gen)
  })
})

describe('formatDuration', () => {
  it('shows seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(3200)).toBe('3s')
    expect(formatDuration(59000)).toBe('59s')
  })
  it('shows minutes and seconds at or above a minute', () => {
    expect(formatDuration(60000)).toBe('1m0s')
    expect(formatDuration(65000)).toBe('1m5s')
    expect(formatDuration(125000)).toBe('2m5s')
  })
})

describe('activityLabel', () => {
  it('returns the real tool name for the tool phase', () => {
    const a: ActivityState = { phase: 'tool', tool_name: 'bash_exec', source: 'actor', started_at: NOW }
    expect(activityLabel(a, 5000)).toEqual({ kind: 'tool', tool: 'bash_exec' })
  })

  it('rotates the vibe index by elapsed time', () => {
    const a: ActivityState = { phase: 'reasoning', source: 'actor', started_at: NOW }
    const size = VIBE_POOL_SIZES.reasoning
    expect(activityLabel(a, 0)).toEqual({ kind: 'vibe', phase: 'reasoning', index: 0 })
    expect(activityLabel(a, 4000)).toEqual({ kind: 'vibe', phase: 'reasoning', index: 1 % size })
    expect(activityLabel(a, 4000 * size)).toEqual({ kind: 'vibe', phase: 'reasoning', index: 0 })
  })

  it('has a positive pool size for every vibe phase', () => {
    for (const phase of ['llm_pending', 'reasoning', 'generating', 'tool_hidden'] as const) {
      expect(VIBE_POOL_SIZES[phase]).toBeGreaterThan(0)
    }
  })
})
