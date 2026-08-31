import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }) }))
import { useUpdateNag, UpdateNagBoundary, SNOOZE_MS } from './useUpdateNag'

// 把 hook 挂进一个探针组件：暴露一个「动作」按钮调 poke，并渲染 modalNode。
function Harness() {
  const { poke, modalNode } = useUpdateNag()
  return (
    <UpdateNagBoundary poke={poke}>
      <button onClick={() => poke()}>act</button>
      {modalNode}
    </UpdateNagBoundary>
  )
}

type Cb = (p: { status: string; version?: string }) => void
let listeners: Cb[] = []
function emit(p: { status: string; version?: string }) { act(() => { listeners.forEach(cb => cb(p)) }) }

beforeEach(() => {
  listeners = []
  vi.useFakeTimers()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    onUpdateStatus: (cb: Cb) => { listeners.push(cb); return () => { listeners = listeners.filter(x => x !== cb) } },
    installUpdate: vi.fn(),
  }
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('useUpdateNag', () => {
  test('未下载完成前，任何动作都不弹', () => {
    render(<Harness />)
    emit({ status: 'available', version: '9.9.9' })
    fireEvent.click(screen.getByText('act'))
    expect(screen.queryByText('update.nagInstall')).toBeNull()
  })

  test('下载完成即弹一次（首轮提醒）', () => {
    render(<Harness />)
    emit({ status: 'downloaded', version: '9.9.9' })
    expect(screen.getByText('update.nagInstall')).toBeTruthy()
    expect(screen.getByText(/9\.9\.9/)).toBeTruthy()
  })

  test('点「稍后」关掉；5 分钟冷却内动作不再弹', () => {
    render(<Harness />)
    emit({ status: 'downloaded', version: '9.9.9' })
    fireEvent.click(screen.getByText('update.nagLater'))
    expect(screen.queryByText('update.nagInstall')).toBeNull()

    // 冷却期内触发动作：不弹（相对常量，冷却时长改动不影响本用例）
    act(() => { vi.advanceTimersByTime(SNOOZE_MS - 1000) })
    fireEvent.click(screen.getByText('act'))
    expect(screen.queryByText('update.nagInstall')).toBeNull()
  })

  test('冷却过后，下一个动作重新弹', () => {
    render(<Harness />)
    emit({ status: 'downloaded', version: '9.9.9' })
    fireEvent.click(screen.getByText('update.nagLater'))

    act(() => { vi.advanceTimersByTime(SNOOZE_MS + 1000) })
    fireEvent.click(screen.getByText('act'))
    expect(screen.getByText('update.nagInstall')).toBeTruthy()
  })

  test('点「立即重启升级」调用 installUpdate', () => {
    render(<Harness />)
    emit({ status: 'downloaded', version: '9.9.9' })
    fireEvent.click(screen.getByText('update.nagInstall'))
    const api = (window as unknown as { electronAPI: { installUpdate: ReturnType<typeof vi.fn> } }).electronAPI
    expect(api.installUpdate).toHaveBeenCalled()
  })
})
