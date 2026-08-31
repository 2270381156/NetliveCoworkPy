import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionSSE } from './useSessionSSE'

// Minimal EventSource stand-in (jsdom has none). Mirrors the finishBubble test's mock.
class MockEventSource {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 2
  static instances: MockEventSource[] = []

  url: string
  readyState = MockEventSource.CONNECTING
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() { this.readyState = MockEventSource.CLOSED }

  open() { this.readyState = MockEventSource.OPEN; this.onopen?.({}) }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

const NOTICE = {
  type: 'session_notice', kind: 'failed', reason_code: 'TASK_FAILED_BY_OBSERVER',
  reason_text: '观察者判定：输出缺少关键字段', failures: [], created_at: 't1',
}

describe('useSessionSSE session_notice pipeline', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource
  })
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource
  })

  function setup() {
    const hook = renderHook(() => useSessionSSE('s1'))
    act(() => { MockEventSource.instances[0].open() })
    return hook
  }

  it('captures a live session_notice into state and NOT into items', () => {
    const { result } = setup()
    act(() => { MockEventSource.instances[0].emit(NOTICE) })
    expect(result.current.notice).toMatchObject({
      kind: 'failed', reason_code: 'TASK_FAILED_BY_OBSERVER',
      reason_text: '观察者判定：输出缺少关键字段',
    })
    expect(result.current.items).toHaveLength(0)
  })

  it('takes the LAST notice from a history replay, and keeps it out of items', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'history',
        events: [
          { ...NOTICE, kind: 'interrupted', reason_code: 'llm_outage', reason_text: '', created_at: 't0' },
          { type: 'message', role: 'user', content: 'hi', created_at: 't0.5' },
          NOTICE,
        ],
      })
    })
    expect(result.current.notice).toMatchObject({ kind: 'failed', reason_code: 'TASK_FAILED_BY_OBSERVER' })
    expect(result.current.items.every(i => i.kind === 'message')).toBe(true)
  })

  it('history replay with no notice clears a previously captured one (full replay wins)', () => {
    const { result } = setup()
    act(() => { MockEventSource.instances[0].emit(NOTICE) })
    act(() => { MockEventSource.instances[0].emit({ type: 'history', events: [] }) })
    expect(result.current.notice).toBeNull()
  })

  it('parses defensively: missing fields fall back to empty values', () => {
    const { result } = setup()
    act(() => { MockEventSource.instances[0].emit({ type: 'session_notice' }) })
    expect(result.current.notice).toMatchObject({
      kind: 'failed', reason_code: '', reason_text: '', failures: [],
    })
  })
})
