import { describe, it, expect } from 'vitest'
import { taskSummaryFromEvent } from './taskSummary'

// 后端实际下发的 tool_name 是 capability_name(provider__name 形式)。
const FINISH = 'control__finish_task'

describe('taskSummaryFromEvent', () => {
  it('ignores non finish_task control tools', () => {
    expect(taskSummaryFromEvent({ tool_name: 'control__delegate_task', arguments: { result: 'x' }, is_root: true })).toBeNull()
  })

  it('matches the real control__finish_task tool name on a root task', () => {
    const s = taskSummaryFromEvent({ tool_name: FINISH, arguments: { result: 'done' }, is_root: true })
    expect(s).toEqual({ summary: 'done' })
  })

  it('also accepts the bare finish_task name', () => {
    const s = taskSummaryFromEvent({ tool_name: 'finish_task', arguments: { result: 'done' }, is_root: true })
    expect(s?.summary).toBe('done')
  })

  it('always renders the root summary (no length/turns gating)', () => {
    const s = taskSummaryFromEvent({ tool_name: FINISH, arguments: { result: 'done' }, is_root: true })
    expect(s).toEqual({ summary: 'done' })
  })

  it('never renders a sub-task summary', () => {
    expect(taskSummaryFromEvent({ tool_name: FINISH, arguments: { result: 'sub' }, is_root: false })).toBeNull()
  })

  it('treats a missing is_root flag as not-root and drops it', () => {
    expect(taskSummaryFromEvent({ tool_name: FINISH, arguments: { result: 'x' } })).toBeNull()
  })

  it('returns null when the root result is empty', () => {
    expect(taskSummaryFromEvent({ tool_name: FINISH, arguments: { result: '   ' }, is_root: true })).toBeNull()
  })
})
