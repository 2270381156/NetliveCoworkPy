import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionSSE } from './useSessionSSE'

// Minimal EventSource stand-in (jsdom has none). Mirrors the watchdog test's mock.
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

describe('useSessionSSE finish_task deliverables_summary bubble', () => {
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

  it('renders a non-empty deliverables_summary as an assistant message bubble', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'control_tool_call',
        tool_name: 'control__finish_task',
        arguments: { deliverables_summary: '改了 foo.ts 与 bar.ts' },
        created_at: '2026-07-01T00:00:00Z',
      })
    })
    const msgs = result.current.items.filter(i => i.kind === 'message')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'assistant', content: '改了 foo.ts 与 bar.ts' })
  })

  it('skips an empty / whitespace-only deliverables_summary', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'control_tool_call',
        tool_name: 'control__finish_task',
        arguments: { deliverables_summary: '   ' },
        created_at: '2026-07-01T00:00:00Z',
      })
    })
    expect(result.current.items).toHaveLength(0)
  })

  it('skips a finish_task with no deliverables_summary at all', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'control_tool_call',
        tool_name: 'control__finish_task',
        arguments: {},
        created_at: '2026-07-01T00:00:00Z',
      })
    })
    expect(result.current.items).toHaveLength(0)
  })

  it('ignores control_tool_call events that are not finish_task', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'control_tool_call',
        tool_name: 'control__update_task_metadata',
        arguments: { deliverables_summary: 'should not render' },
        created_at: '2026-07-01T00:00:00Z',
      })
    })
    expect(result.current.items).toHaveLength(0)
  })

  it('replays a finish_task summary from history as an assistant bubble', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'history',
        events: [
          { type: 'control_tool_call', tool_name: 'control__finish_task', arguments: { deliverables_summary: '历史小结' }, created_at: '2026-07-01T00:00:00Z' },
        ],
      })
    })
    const msgs = result.current.items.filter(i => i.kind === 'message')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'assistant', content: '历史小结' })
  })

  // ── 早期旧数据兼容:答复在 arguments.result,仅根任务(is_root)展示 ──

  it('renders a legacy root finish_task answer from arguments.result', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'control_tool_call',
        tool_name: 'control__finish_task',
        arguments: { result: '你好！👋' },
        result: 'Task result submitted.',   // 顶层回执:绝不能被渲染
        is_root: true,
        created_at: '2026-07-01T00:00:00Z',
      })
    })
    const msgs = result.current.items.filter(i => i.kind === 'message')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'assistant', content: '你好！👋' })
  })

  it('skips a legacy non-root finish_task result (only root answer is shown)', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'control_tool_call',
        tool_name: 'control__finish_task',
        arguments: { result: '子任务结果' },   // 无 is_root
        created_at: '2026-07-01T00:00:00Z',
      })
    })
    expect(result.current.items).toHaveLength(0)
  })

  it('never renders the top-level result ack ("Task finished.")', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'control_tool_call',
        tool_name: 'control__finish_task',
        arguments: {},
        result: 'Task finished.',   // 只有顶层回执、无答复 → 不渲染
        created_at: '2026-07-01T00:00:00Z',
      })
    })
    expect(result.current.items).toHaveLength(0)
  })
})
