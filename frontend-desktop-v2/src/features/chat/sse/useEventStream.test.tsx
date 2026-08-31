import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEventStream } from './useEventStream'

// jsdom 无 EventSource;最小替身,记录实例以断言重连(= 新建了 EventSource)。
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

  constructor(url: string) { this.url = url; MockEventSource.instances.push(this) }
  close() { this.readyState = MockEventSource.CLOSED }
  open() { this.readyState = MockEventSource.OPEN; this.onopen?.({}) }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

describe('useEventStream 僵尸连接看门狗', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource
  })

  it('OPEN 但超阈值静默 → 强制重连', () => {
    renderHook(() => useEventStream('s1'))
    expect(MockEventSource.instances).toHaveLength(1)
    act(() => { MockEventSource.instances[0].open() })
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2)
  })

  it('持续有事件(ping 重置计时)→ 不重连', () => {
    renderHook(() => useEventStream('s1'))
    act(() => { MockEventSource.instances[0].open() })
    act(() => {
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(2_000)
        MockEventSource.instances[0].emit({ type: 'ping' })
      }
    })
    expect(MockEventSource.instances).toHaveLength(1)
  })
})

describe('useEventStream × reducer 集成', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource
  })
  afterEach(() => { delete (globalThis as unknown as { EventSource?: unknown }).EventSource })

  const session = { id: 's1', user_prompt: 'hi', goal: 'g', status: 'RUNNING', template_id: null, root_agent_id: null, token_budget: 0, input_tokens_used: 0, output_tokens_used: 0, context_tokens: 0, failure_counter: 0, llm_account: null, llm_model: null, workspace: '', created_at: '', updated_at: '' }

  it('init 设置 session;text_delta+text_done 产出 assistant 消息;done 关闭连接', () => {
    const { result } = renderHook(() => useEventStream('s1'))
    const es = MockEventSource.instances[0]
    act(() => { es.open(); es.emit({ type: 'init', session, messages: [] }) })
    expect(result.current.session?.id).toBe('s1')

    act(() => { es.emit({ type: 'text_delta', delta: '你好' }) })
    expect(result.current.streamingText).toBe('你好')

    act(() => { es.emit({ type: 'text_done', text: '你好,完成。' }) })
    expect(result.current.streamingText).toBeNull()
    expect(result.current.items.some(i => i.kind === 'message' && i.role === 'assistant' && i.content === '你好,完成。')).toBe(true)

    act(() => { es.emit({ type: 'done', final_status: 'SUCCEEDED' }) })
    expect(es.readyState).toBe(MockEventSource.CLOSED) // 'done' → close()
  })
})
