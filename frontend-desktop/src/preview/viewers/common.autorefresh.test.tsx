import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useFileText, useAutoRefresh, usePageActive } from './common'

// —— useFileText：平滑重取（reloadToken 变时后台重取、不闪 loading、保留旧内容）——
describe('useFileText — 平滑重取', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchMock: any
  beforeEach(() => {
    // content 回显请求 URL，便于断言带没带版本号 / 路径。
    fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ content: `C(${url})` }) }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reloadToken 变 → 带版本号 &v= 重取', async () => {
    const { result, rerender } = renderHook(({ tk }) => useFileText('p', tk), { initialProps: { tk: 0 } })
    await waitFor(() => expect(result.current.content).toContain('path=p'))
    expect(result.current.content).not.toContain('v=')      // token 0 → 不带版本
    rerender({ tk: 3 })
    await waitFor(() => expect(result.current.content).toContain('v=3'))
  })

  it('刷新期间不清空（不闪 loading）：pending 时保留旧内容', async () => {
    const { result, rerender } = renderHook(({ tk }) => useFileText('p', tk), { initialProps: { tk: 0 } })
    await waitFor(() => expect(result.current.content).not.toBeNull())
    const old = result.current.content
    // 下一次 fetch 挂起
    let resolve!: (v: unknown) => void
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    rerender({ tk: 1 })
    await act(async () => { await Promise.resolve() })       // 让 effect 跑一轮
    expect(result.current.content).toBe(old)                 // 仍是旧内容，未变 null
    await act(async () => { resolve({ ok: true, status: 200, json: async () => ({ content: 'NEW' }) }); await Promise.resolve() })
    await waitFor(() => expect(result.current.content).toBe('NEW'))
  })

  it('path 变 → 清空后加载新文件', async () => {
    const { result, rerender } = renderHook(({ p }) => useFileText(p, 0), { initialProps: { p: 'a' } })
    await waitFor(() => expect(result.current.content).toContain('path=a'))
    rerender({ p: 'b' })
    await waitFor(() => expect(result.current.content).toContain('path=b'))
  })

  it('刷新失败保留旧内容（不覆盖成错误）', async () => {
    const { result, rerender } = renderHook(({ tk }) => useFileText('p', tk), { initialProps: { tk: 0 } })
    await waitFor(() => expect(result.current.content).not.toBeNull())
    const old = result.current.content
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, text: async () => 'boom' }))
    rerender({ tk: 1 })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(result.current.content).toBe(old)                 // 旧内容保留
    expect(result.current.error).toBeNull()                  // 不显示错误
  })
})

// —— useAutoRefresh：轮询 mtime，变了 bump token；门控 & 换文件重置基线 ——
describe('useAutoRefresh — mtime 轮询', () => {
  let mtime = 100
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchMock: any
  beforeEach(() => {
    vi.useFakeTimers()
    mtime = 100
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ mtime }) }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('首周期只记基线不 bump；mtime 变才 bump；不变不 bump', async () => {
    const { result } = renderHook(() => useAutoRefresh('p', true, 1000))
    expect(result.current).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })   // baseline=100
    expect(result.current).toBe(0)
    mtime = 200
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })   // 变了 → bump
    expect(result.current).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })   // 未变 → 不 bump
    expect(result.current).toBe(1)
  })

  it('enabled=false 不轮询', async () => {
    renderHook(() => useAutoRefresh('p', false, 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('换文件重置基线：新文件首周期不误 bump', async () => {
    const { result, rerender } = renderHook(({ p }) => useAutoRefresh(p, true, 1000), { initialProps: { p: 'a' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })   // a baseline=100
    mtime = 500
    rerender({ p: 'b' })                                                 // 换文件 → 基线重置
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })   // b 首周期记 baseline=500，不 bump
    expect(result.current).toBe(0)
    mtime = 600
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })   // b 变了 → bump
    expect(result.current).toBe(1)
  })
})

// —— usePageActive：可见 + 聚焦 ——
describe('usePageActive', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('聚焦 → true；blur → false；focus 回来 → true', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { result } = renderHook(() => usePageActive())
    expect(result.current).toBe(true)
    act(() => { focus.mockReturnValue(false); window.dispatchEvent(new Event('blur')) })
    expect(result.current).toBe(false)
    act(() => { focus.mockReturnValue(true); window.dispatchEvent(new Event('focus')) })
    expect(result.current).toBe(true)
  })
})
