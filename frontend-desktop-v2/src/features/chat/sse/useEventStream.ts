import { useEffect, useRef, useCallback, useState } from 'react'
import { reduceSse } from './reducer'
import { EMPTY_SSE_STATE, type SSEHandle, type SSEState } from './types'

// ── DEV ONLY: 原始 SSE 帧录制(Playwright smoke/capture driver 依赖 window.__sseDump)──
// `import.meta.env.DEV` 守卫 → 生产构建里整段被 tree-shake。与旧 useSessionSSE 的钩子等价,
// 迁移(Step 4b 切 App 到新 hook)后采集仍可用。
interface SseDumpEntry { sessionId: string; frame: unknown }
const __sseDump: SseDumpEntry[] = []
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>
  w.__sseDump = __sseDump
  w.__sseClear = () => { __sseDump.length = 0 }
  w.__sseSave = (name: string) => {
    const blob = new Blob([JSON.stringify(__sseDump, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name || 'sse'}.json`
    a.click()
  }
}

// 薄 hook:只负责 EventSource 的连接/重连/僵尸看门狗等**副作用**,状态转换全部委托给纯
// reducer `reduceSse`(见 reducer.ts)。是旧 useSessionSSE 的等价替代——同样的生命周期,
// 但把 ~200 行事件处理逻辑挪进了可单测的纯函数。
//
// 与旧码一致的副作用:
//  - 'done' 帧:reducer 更新状态后,这里主动 close() EventSource(阻止浏览器对已结束会话
//    每 3s 自动重连导致反复重发 init/history → 闪动);恢复运行靠 reconnect()。
//  - onopen/onerror:设置 connected/error(这两个不是帧,由连接层维护)。
//  - 僵尸看门狗:OPEN 但 >5s 无任何事件(含 ping)→ 判死,强制 reconnect。

export function useEventStream(sessionId: string | null): SSEHandle {
  const [state, setState] = useState<SSEState>(EMPTY_SSE_STATE)
  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const lastEventTimeRef = useRef<number>(0) // 在连接副作用里赋 Date.now();不在 render 期调(纯度)
  const [epoch, setEpoch] = useState(0)

  const close = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
  }, [])

  const reconnect = useCallback(() => setEpoch(e => e + 1), [])
  const clearLlmError = useCallback(() => setState(s => (s.llmError ? { ...s, llmError: null } : s)), [])

  useEffect(() => {
    // 订阅目标(sessionId)变化时重置状态 —— 这是订阅型 effect 的合法用法(对外部系统
    // EventSource 重新同步),非 render 派生态级联,故按行豁免 set-state-in-effect。
    if (!sessionId) {
      close()
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(EMPTY_SSE_STATE)
      return
    }

    close()
    const isNewSession = sessionIdRef.current !== sessionId
    sessionIdRef.current = sessionId
    // 仅切换会话时清空;同会话重连(epoch)保留已渲染内容,靠稳定 key 原地协调,避免空屏闪烁。
    if (isNewSession) setState(EMPTY_SSE_STATE)

    const es = new EventSource(`/api/v1/sessions/${sessionId}/stream`)
    esRef.current = es
    lastEventTimeRef.current = Date.now()

    es.onopen = () => { lastEventTimeRef.current = Date.now(); setState(s => ({ ...s, connected: true, error: null })) }
    es.onerror = () => setState(s => ({ ...s, connected: false, error: '连接断开，正在重连…' }))

    es.onmessage = (event) => {
      lastEventTimeRef.current = Date.now()
      let frame: Record<string, unknown>
      try { frame = JSON.parse(event.data as string) } catch { return }
      setState(s => reduceSse(s, frame))
      if (import.meta.env.DEV) __sseDump.push({ sessionId, frame })
      // 'done' 是终态副作用:关连接(reducer 是纯函数,不碰 EventSource)。
      if (frame.type === 'done') close()
    }

    return () => { close() }
  }, [sessionId, epoch, close])

  // 僵尸连接看门狗:EventSource 仍 OPEN 但代理把死连接挂住(无 onerror、无事件)→ 浏览器不会
  // 自动重连。后端每 3s 发 ping;若 >5s 无任何事件,判定连接已死,强制 reconnect(凭 Last-Event-ID
  // 拉回错过的事件,如服务重启后的 INTERRUPTED 状态)。
  useEffect(() => {
    if (!sessionId) return
    const id = setInterval(() => {
      const OPEN = (globalThis as { EventSource?: { OPEN: number } }).EventSource?.OPEN ?? 1
      if (esRef.current?.readyState === OPEN && Date.now() - lastEventTimeRef.current > 5_000) {
        reconnect()
      }
    }, 2_000)
    return () => clearInterval(id)
  }, [sessionId, reconnect])

  return { ...state, reconnect, clearLlmError }
}
