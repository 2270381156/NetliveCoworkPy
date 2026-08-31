/**
 * useAgentActivity —— 每个 agent 名下「需要注意」的会话数。
 *
 * 切到某个 agent 后，别的 agent 的会话在列表里完全不可见，但它们仍在后台跑（排队发送、
 * 会话空闲后自动发那套）。没有这个计数，就会出现"任务停在等你回答、而你根本不知道"——
 * 边缘抽屉上的红点就是靠它亮起来的。
 *
 * 复用 SessionList 已有的 ['sessions'] 查询（React Query 按 key 去重，3s 轮询那份缓存
 * 直接拿来用），不额外发请求。
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sessionsApi } from '@/api/sessions'
import { agentOfSession } from '@/agents/registry'
import type { Session } from '@/types'

/** 算「需要注意」的状态：正在跑，或停下来等用户。终态（完成/失败/取消）不计。 */
const ATTENTION = new Set(['RUNNING', 'QUEUED', 'WAITING_INPUT', 'PAUSED_HITL'])

export function useAgentActivity(): Record<string, number> {
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: sessionsApi.list,
    refetchInterval: 3000,
  })
  return useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of sessions as Session[]) {
      if (!ATTENTION.has(s.status)) continue
      const a = agentOfSession(s)
      if (!a) continue
      out[a.id] = (out[a.id] ?? 0) + 1
    }
    return out
  }, [sessions])
}
