import type { SessionStatus, TaskStatus, ToolCallStatus } from '@/types'

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  QUEUED: '排队中',
  RUNNING: '运行中',
  INTERRUPTED: '已中断',
  WAITING_INPUT: '等待输入',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELED: '已取消',
  PAUSED_HITL: '等待输入',
  PAUSED: '暂停',
}

export const SESSION_STATUS_VARIANT = (status: SessionStatus) => {
  switch (status) {
    case 'RUNNING': return 'info'
    case 'INTERRUPTED': return 'warning'
    case 'SUCCEEDED': return 'success'
    case 'FAILED': return 'error'
    case 'CANCELED': return 'muted'
    case 'WAITING_INPUT': return 'warning'
    case 'PAUSED_HITL': return 'warning'
    case 'PAUSED': return 'muted'
    default: return 'muted'
  }
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: '待执行',
  ACTIVE: '执行中',
  FINISHED: '完成',
  FAILED: '失败',
  CANCELED: '已取消',
}

export const TASK_STATUS_VARIANT = (status: TaskStatus) => {
  switch (status) {
    case 'ACTIVE': return 'info'
    case 'FINISHED': return 'success'
    case 'FAILED': return 'error'
    case 'CANCELED': return 'muted'
    default: return 'muted'
  }
}

export const TOOL_CALL_STATUS_VARIANT = (status: ToolCallStatus) => {
  switch (status) {
    case 'SUCCEEDED': return 'success'
    case 'FAILED': return 'error'
    default: return 'info'
  }
}

export function isTerminalSession(status: SessionStatus) {
  return ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)
}

export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '...'
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatRelativeTime(dateStr: string): string {
  // If no timezone offset or Z suffix, assume UTC (SQLite may omit it)
  const normalized = /[+Z]/.test(dateStr.slice(10)) ? dateStr : dateStr + 'Z'
  const diff = Date.now() - new Date(normalized).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
