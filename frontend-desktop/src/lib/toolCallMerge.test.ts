import { describe, it, expect } from 'vitest'
import { appendPendingToolCall, applyToolCallResult } from './toolCallMerge'
import type { ChatItem } from '@/hooks/useSessionSSE'

let n = 0
const mkId = () => `id-${n++}`

const pendingEvt = { tool_call_id: 'tc1', tool_name: 'bash_exec', arguments: { cmd: 'ls' }, created_at: 't0' }
const resultEvt = { tool_call_id: 'tc1', tool_name: 'bash_exec', arguments: { cmd: 'ls' }, result: 'a\nb', is_error: false, created_at: 't1' }

describe('appendPendingToolCall', () => {
  it('appends a pending tool_call bubble carrying args, empty result', () => {
    const out = appendPendingToolCall([], pendingEvt, mkId)
    expect(out).toHaveLength(1)
    const it0 = out[0] as Extract<ChatItem, { kind: 'tool_call' }>
    expect(it0.kind).toBe('tool_call')
    expect(it0.tool_call_id).toBe('tc1')
    expect(it0.tool_name).toBe('bash_exec')
    expect(it0.arguments).toEqual({ cmd: 'ls' })
    expect(it0.result).toBe('')
    expect(it0.status).toBe('pending')
  })

  it('is idempotent on duplicate tool_call_id (SSE replay)', () => {
    const once = appendPendingToolCall([], pendingEvt, mkId)
    const twice = appendPendingToolCall(once, pendingEvt, mkId)
    expect(twice).toBe(once)            // same reference, no dup
    expect(twice).toHaveLength(1)
  })
})

describe('applyToolCallResult', () => {
  it('fills the matching pending bubble in place (same id, status done)', () => {
    const withPending = appendPendingToolCall([], pendingEvt, mkId)
    const pendId = (withPending[0] as { id: string }).id
    const out = applyToolCallResult(withPending, resultEvt, mkId)
    expect(out).toHaveLength(1)         // merged, not appended
    const it0 = out[0] as Extract<ChatItem, { kind: 'tool_call' }>
    expect(it0.id).toBe(pendId)         // same bubble
    expect(it0.status).toBe('done')
    expect(it0.result).toBe('a\nb')
    expect(it0.is_error).toBe(false)
  })

  it('appends a done bubble when no pending exists (back-compat / replay gap)', () => {
    const out = applyToolCallResult([], resultEvt, mkId)
    expect(out).toHaveLength(1)
    const it0 = out[0] as Extract<ChatItem, { kind: 'tool_call' }>
    expect(it0.status).toBe('done')
    expect(it0.tool_name).toBe('bash_exec')
    expect(it0.result).toBe('a\nb')
  })
})
