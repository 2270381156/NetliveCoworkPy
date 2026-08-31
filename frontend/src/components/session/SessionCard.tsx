import { clsx } from 'clsx'
import { Trash2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Session } from '@/types'
import { SessionStatusBadge } from './StatusBadge'
import { formatRelativeTime } from '@/lib/status'
import { sessionsApi } from '@/api/sessions'

interface SessionCardProps {
  session: Session
  selected: boolean
  onClick: () => void
  onDeleted: () => void
}

export function SessionCard({ session, selected, onClick, onDeleted }: SessionCardProps) {
  const queryClient = useQueryClient()
  const tokenUsed = session.output_tokens_used
  const tokenPct = session.token_budget > 0
    ? Math.min((tokenUsed / session.token_budget) * 100, 100)
    : 0

  const deleteMutation = useMutation({
    mutationFn: () => sessionsApi.delete(session.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      onDeleted()
    },
  })

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.confirm(`确认删除会话「${session.goal.slice(0, 30)}...」？此操作不可撤销。`)) return
    deleteMutation.mutate()
  }

  return (
    <div
      className={clsx(
        'px-4 py-3 cursor-pointer border-b border-gray-100 hover:bg-gray-50 transition-colors group',
        selected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent'
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-gray-900 line-clamp-2 flex-1 leading-snug">
          {session.goal}
        </p>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <SessionStatusBadge status={session.status} />
          <button
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all disabled:opacity-30"
            title="删除会话"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-xs text-gray-400 font-mono">
          {session.id.slice(0, 14)}...
        </span>
        <span className="text-xs text-gray-300">·</span>
        <span className="text-xs text-gray-400">
          {formatRelativeTime(session.created_at)}
        </span>
      </div>
      {tokenPct > 0 && (
        <div className="mt-2 h-0.5 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={clsx(
              'h-full rounded-full transition-all',
              tokenPct >= 95 ? 'bg-red-400' : tokenPct >= 80 ? 'bg-yellow-400' : 'bg-blue-400'
            )}
            style={{ width: `${tokenPct}%` }}
          />
        </div>
      )}
    </div>
  )
}
