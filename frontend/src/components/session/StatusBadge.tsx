import { clsx } from 'clsx'
import type { SessionStatus, TaskStatus } from '@/types'
import { SESSION_STATUS_LABEL, TASK_STATUS_LABEL } from '@/lib/status'

interface SessionStatusBadgeProps {
  status: SessionStatus
}

const sessionColors: Record<SessionStatus, string> = {
  QUEUED: 'bg-gray-100 text-gray-600',
  RUNNING: 'bg-blue-100 text-blue-700',
  INTERRUPTED: 'bg-orange-100 text-orange-700',
  WAITING_INPUT: 'bg-amber-100 text-amber-700',
  SUCCEEDED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  CANCELED: 'bg-gray-100 text-gray-400',
  PAUSED_HITL: 'bg-yellow-100 text-yellow-700',
  PAUSED: 'bg-gray-100 text-gray-600',
}

const sessionDot: Record<SessionStatus, string> = {
  QUEUED: 'bg-gray-400',
  RUNNING: 'bg-blue-500 animate-pulse',
  INTERRUPTED: 'bg-orange-400',
  WAITING_INPUT: 'bg-amber-500 animate-pulse',
  SUCCEEDED: 'bg-green-500',
  FAILED: 'bg-red-500',
  CANCELED: 'bg-gray-300',
  PAUSED_HITL: 'bg-yellow-500',
  PAUSED: 'bg-gray-400',
}

export function SessionStatusBadge({ status }: SessionStatusBadgeProps) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium', sessionColors[status])}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', sessionDot[status])} />
      {SESSION_STATUS_LABEL[status]}
    </span>
  )
}

interface TaskStatusBadgeProps {
  status: TaskStatus
}

const taskColors: Record<TaskStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-500',
  ACTIVE: 'bg-blue-100 text-blue-700',
  FINISHED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  CANCELED: 'bg-gray-100 text-gray-400',
}

export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
  return (
    <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium', taskColors[status])}>
      {TASK_STATUS_LABEL[status]}
    </span>
  )
}
