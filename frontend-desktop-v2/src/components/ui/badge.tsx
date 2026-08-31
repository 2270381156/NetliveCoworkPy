import { cn } from '@/lib/utils'
import type { SessionStatus } from '@/types'
import { useI18n } from '@/i18n'

const STATUS_STYLES: Record<SessionStatus, string> = {
  QUEUED:        'bg-[#eaf0fb] text-[#8aa3bf]',
  RUNNING:       'bg-[rgba(37,99,235,0.09)] text-[#2563eb] animate-pulse',
  WAITING_INPUT: 'bg-amber-50 text-amber-600 animate-pulse',
  PAUSED_HITL:   'bg-amber-50 text-amber-600',
  PAUSED:        'bg-[#eaf0fb] text-[#8aa3bf]',
  SUCCEEDED:     'bg-emerald-50 text-emerald-600',
  FAILED:        'bg-red-50 text-red-600',
  CANCELED:      'bg-[#eaf0fb] text-[#8aa3bf]',
  INTERRUPTED:   'bg-[#eaf0fb] text-[#8aa3bf]',
}

export function StatusBadge({ status, className }: { status: SessionStatus; className?: string }) {
  const { t } = useI18n()
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS_STYLES[status], className)}>
      {t('status.' + status)}
    </span>
  )
}
