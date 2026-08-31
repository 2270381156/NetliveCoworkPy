import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Square, AlertTriangle } from 'lucide-react'
import type { Session } from '@/types'
import { sessionsApi } from '@/api/sessions'
import { llmsApi } from '@/api/llms'
import { SessionStatusBadge } from './StatusBadge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { isTerminalSession } from '@/lib/status'

interface Props {
  session: Session
}

export function SessionStats({ session }: Props) {
  const queryClient = useQueryClient()
  const { data: llms } = useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })
  const contextLimit = llms?.find(l => l.name === session.llm_account)
    ?.models.find(m => m.name === session.llm_model)?.context_limit ?? 0
  const tokenUsed = session.output_tokens_used
  const tokenPct = session.token_budget > 0
    ? (tokenUsed / session.token_budget) * 100
    : 0

  const cancelMutation = useMutation({
    mutationFn: () => sessionsApi.interrupt(session.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session', session.id] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-gray-400">{session.id}</span>
            <SessionStatusBadge status={session.status} />
            {session.failure_counter > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-yellow-600">
                <AlertTriangle size={11} />
                {session.failure_counter} 失败
              </span>
            )}
          </div>
          <p className="text-sm text-gray-800 mt-1.5 leading-snug line-clamp-3">
            {session.goal}
          </p>
        </div>
        {!isTerminalSession(session.status) && (
          <Button
            size="sm"
            variant="outline"
            className="flex-shrink-0 text-red-600 border-red-200 hover:bg-red-50"
            loading={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
          >
            <Square size={13} />
            中断
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-500">Token 用量</span>
          {session.token_budget > 0 && tokenPct >= 80 && (
            <span className={`text-xs font-medium ${tokenPct >= 95 ? 'text-red-600' : 'text-yellow-600'}`}>
              {tokenPct.toFixed(0)}%
            </span>
          )}
        </div>
        {session.token_budget > 0
          ? <Progress value={tokenUsed} max={session.token_budget} showLabel />
          : <div className="text-[10px] text-gray-400">无限制</div>
        }
        <div className="flex gap-2 mt-1 flex-wrap">
          <span className="text-[10px] text-gray-400 tabular-nums">↑ 输入 {(session.input_tokens_used / 1000).toFixed(1)}k</span>
          <span className="text-[10px] text-gray-400 tabular-nums">↓ 输出 {(session.output_tokens_used / 1000).toFixed(1)}k</span>
          {session.context_tokens > 0 && (
            <span className="text-[10px] text-blue-400 tabular-nums">
              窗口 {(session.context_tokens / 1000).toFixed(1)}k{contextLimit > 0 ? ` / ${(contextLimit / 1000).toFixed(0)}k` : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
