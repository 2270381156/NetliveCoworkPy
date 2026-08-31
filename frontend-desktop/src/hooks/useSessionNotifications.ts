// 桌面通知：HITL 待应答 / 任务结束时弹系统 toast + 任务栏闪烁 + 角标。
//
// 信号源为什么是轮询的会话列表，而不是 SSE：
//   App.tsx 只对「当前选中且正在看聊天」的那一个会话开 SSE（useSessionSSE(centerView==='chat' ? selectedId : null)），
//   切走会话或切走视图就断流。而最需要通知的恰恰是「用户没在看的那个会话完成了」。
//   会话列表（GET /sessions，SessionList 里 refetchInterval 3s）是唯一覆盖全部会话的信号源。
//   代价是最多 3s 延迟，对通知场景足够；且 React Query 按 key 去重，这里复用同一份缓存，不增加请求。
//
// 两层触发，缺一不可：
//   1) 运行期跳变：本次运行内状态发生变化 → 逐条即时通知
//   2) 启动盘点：首轮只建基线不逐条通知，但把「当前积压」汇总成一条。
//      必须有这层——后端在 lifespan 启动阶段就把崩溃/关闭时中断的会话恢复成了
//      INTERRUPTED/PAUSED（见 persistence/postgres/reconcile.py 的说明），等前端第一次
//      拿到列表时它们已是终态，没有跳变可言，只靠第 1 层会全部漏掉。
import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sessionsApi } from '@/api/sessions'
import { STATUS_BUCKET } from '@/components/ui/badge'
import type { Session, SessionStatus } from '@/types'
import { useI18n } from '@/i18n'

// 用户主动取消的会话不通知——他自己刚点的，不需要再告诉他一遍。
const SKIP_NOTIFY: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['CANCELED'])

// 判定「显示运行中但其实早就不动了」的阈值。不能只看状态是不是 RUNNING：
// 本 hook 的基线在 Desktop 每次挂载时重置（例如退出登录再登录），那时真在跑的会话
// 会被误判成残留。真在跑的会话 last_activity_at 是新鲜的，据此区分。
// 取值保守（宁可漏报也不误报）：LLM 单次调用远不到 10 分钟。
const STRANDED_IDLE_MS = 10 * 60 * 1000

function isStranded(s: Session, now: number): boolean {
  if (STATUS_BUCKET[s.status] !== 'running') return false
  const ts = s.last_activity_at || s.updated_at
  if (!ts) return true                          // 没有时间戳可依据 → 保守视为残留
  const t = Date.parse(ts)
  return Number.isNaN(t) ? false : now - t > STRANDED_IDLE_MS
}

type Kind = 'waiting' | 'failed' | 'done'

// 归类复用 badge.tsx 的 STATUS_BUCKET（徽标显示与通知同源，不会各写一套后漂移）。
// 'running' 不通知；'ready' 里排除 CANCELED。
function kindOf(status: SessionStatus): Kind | null {
  if (SKIP_NOTIFY.has(status)) return null
  const bucket = STATUS_BUCKET[status]
  if (bucket === 'waiting') return 'waiting'
  if (bucket === 'failed') return 'failed'
  if (bucket === 'ready') return 'done'
  return null                                   // running / 未知
}

export function useSessionNotifications(onOpenSession?: (id: string) => void) {
  const { t } = useI18n()
  // 同 queryKey → 复用 SessionList 那份缓存，不产生额外请求
  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: sessionsApi.list,
    refetchInterval: 3000,
  })

  // 上一轮的状态快照。仅存内存：跨启动的积压由「启动盘点」覆盖，不需要落盘，
  // 落盘反而会在关闭数天后再打开时炸出一串陈年通知。
  const prev = useRef<Map<string, SessionStatus> | null>(null)
  // t 会随语言切换变化，用 ref 取最新值，避免把它放进 effect 依赖导致重复通知
  const tRef = useRef(t)
  tRef.current = t

  // toast 点击 → 跳到对应会话
  const onOpenRef = useRef(onOpenSession)
  onOpenRef.current = onOpenSession
  useEffect(() => {
    const off = window.electronAPI?.onNotificationClick?.((p) => {
      if (p?.sessionId) onOpenRef.current?.(p.sessionId)
    })
    return off
  }, [])

  useEffect(() => {
    if (!sessions) return
    const api = window.electronAPI
    if (!api?.notify) return                     // 纯浏览器调试态：无通知能力，直接跳过

    const cur = new Map(sessions.map(s => [s.id, s.status]))
    // 与 SessionList 的显示口径一致（goal → user_prompt → id 前 8 位），
    // 通知里的名字和列表里看到的是同一个，用户才对得上。
    const titleOf = (s: Session) => s.goal || s.user_prompt || s.id.slice(0, 8)

    if (prev.current === null) {
      // ── 首轮：建基线 + 盘点积压（不逐条弹，关了几天再打开会炸一屏）──
      const waiting = sessions.filter(s => kindOf(s.status) === 'waiting')
      // 显示运行中但久无活动的会话：既不算「待应答」也不算「已结束」，跳变检测抓不到，
      // 不提示的话用户只会看到一个永远转圈的会话（历史上真出过「会话永久卡 RUNNING」的 bug）。
      const now = Date.now()
      const stranded = sessions.filter(s => isStranded(s, now))
      const parts: string[] = []
      if (waiting.length) parts.push(tRef.current('notify.backlog.waiting').replace('{n}', String(waiting.length)))
      if (stranded.length) parts.push(tRef.current('notify.backlog.stranded').replace('{n}', String(stranded.length)))
      if (parts.length) {
        const only = waiting.length + stranded.length === 1 ? (waiting[0] ?? stranded[0]) : null
        void api.notify({
          title: tRef.current('notify.backlog.title'),
          body: parts.join('，'),
          sessionId: only?.id,
          // 启动时窗口必然是聚焦的，不 force 就会被主进程的「聚焦不打扰」吞掉
          force: true,
        })
      }
      prev.current = cur
    } else {
      // ── 后续轮次：只认状态跳变（同一状态会被轮询读到很多次，不去重会反复弹）──
      for (const [id, status] of cur) {
        const before = prev.current.get(id)
        if (before === undefined || before === status) continue
        const kind = kindOf(status)
        if (!kind) continue
        const s = sessions.find(x => x.id === id)
        if (!s) continue
        void api.notify({
          title: tRef.current(`notify.${kind}.title`),
          body: titleOf(s),
          sessionId: id,
        })
      }
      prev.current = cur
    }

    // 上报「待应答」数量 → 托盘悬停提示；归零时主进程顺带停掉托盘闪动。
    // 只计 waiting 类：这是真正需要用户动手的数量。
    void api.setPending?.({ count: sessions.filter(s => kindOf(s.status) === 'waiting').length })
  }, [sessions])
}
