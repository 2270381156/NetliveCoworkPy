import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionSSE, evaluateWatchdog } from './useSessionSSE'

// Minimal EventSource stand-in: jsdom has none. Records instances so the test can
// assert a reconnect (= a new EventSource was constructed).
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

  // test helpers
  open() { this.readyState = MockEventSource.OPEN; this.onopen?.({}) }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

describe('useSessionSSE zombie-connection watchdog', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource
  })

  it('reconnects when the stream is OPEN but silent past the threshold', () => {
    renderHook(() => useSessionSSE('s1'))
    expect(MockEventSource.instances).toHaveLength(1)

    act(() => { MockEventSource.instances[0].open() })

    // No events arrive. After >5s of silence the watchdog must force a reconnect.
    act(() => { vi.advanceTimersByTime(8_000) })

    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2)
  })

  it('does NOT reconnect while events keep arriving (pings reset the timer)', () => {
    renderHook(() => useSessionSSE('s1'))
    act(() => { MockEventSource.instances[0].open() })

    // A ping every 2s keeps the connection alive; the watchdog must not fire.
    act(() => {
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(2_000)
        MockEventSource.instances[0].emit({ type: 'ping' })
      }
    })

    expect(MockEventSource.instances).toHaveLength(1)
  })
})

describe('evaluateWatchdog', () => {
  const PERIOD = 2_000
  const SILENCE = 5_000
  const base = { isOpen: true, periodMs: PERIOD, silenceMs: SILENCE }

  it('reconnects when open and silent past the threshold on a normal tick', () => {
    // tick fired on schedule (~2s gap); no event for 6s → dead connection.
    const r = evaluateWatchdog({ ...base, now: 10_000, lastTick: 8_000, lastEvent: 4_000 })
    expect(r).toEqual({ reconnect: true, starved: false })
  })

  it('does not reconnect when events are fresh', () => {
    const r = evaluateWatchdog({ ...base, now: 10_000, lastTick: 8_000, lastEvent: 9_000 })
    expect(r.reconnect).toBe(false)
    expect(r.starved).toBe(false)
  })

  it('does NOT reconnect when the tick itself was starved (main thread blocked)', () => {
    // The interval fired 8s late (main thread frozen by IME/layout jank). Events look
    // "silent" only because our own handlers could not run — the connection is fine.
    // Reconnecting here would remount the HITL panel and wipe the user's input.
    const r = evaluateWatchdog({ ...base, now: 10_000, lastTick: 2_000, lastEvent: 0 })
    expect(r).toEqual({ reconnect: false, starved: true })
  })

  it('never reconnects a non-open stream even if stale', () => {
    const r = evaluateWatchdog({ ...base, isOpen: false, now: 10_000, lastTick: 8_000, lastEvent: 0 })
    expect(r.reconnect).toBe(false)
  })
})
