import { cn } from '@/lib/utils'
import type { SessionStatus } from '@/types'
import { useI18n } from '@/i18n'

// 会话状态统一归并为 4 类展示:失败 / 运行中 / 等待输入 / 已就绪。
//  - SUCCEEDED(完成)与 PAUSED(软停/暂停)都归「已就绪」——软停多是「干完没正规收尾」,不代表异常,
//    用「已就绪」比「暂停」更不易让用户误解。
//  - WAITING_INPUT 与 PAUSED_HITL(HITL 待应答)归「等待输入」。
//  - INTERRUPTED(被异常打断/服务重启,会弹「恢复/重试」通告条)归「失败」——避免"提示要重试却显示已就绪"。
//  - QUEUED / CANCELED 几乎不作为会话态出现,防御性归入最近一类(CANCELED 是主动取消、非错误 → 已就绪)。
export type Bucket = 'running' | 'waiting' | 'failed' | 'ready'

// 导出供桌面通知复用（useSessionNotifications）：状态归类只此一份，
// 徽标显示与通知触发不会各写一套后漂移。
export const STATUS_BUCKET: Record<SessionStatus, Bucket> = {
  RUNNING:       'running',
  QUEUED:        'running',
  WAITING_INPUT: 'waiting',
  PAUSED_HITL:   'waiting',
  FAILED:        'failed',
  SUCCEEDED:     'ready',
  PAUSED:        'ready',
  CANCELED:      'ready',
  INTERRUPTED:   'failed',
}

const BUCKET_STYLE: Record<Bucket, string> = {
  running: 'bg-[rgba(37,99,235,0.09)] text-[#2563eb] animate-pulse',
  waiting: 'bg-amber-50 text-amber-600 animate-pulse',
  failed:  'bg-red-50 text-red-600',
  ready:   'bg-emerald-50 text-emerald-600',
}

const BUCKET_I18N: Record<Bucket, string> = {
  running: 'status.RUNNING',
  waiting: 'status.WAITING_INPUT',
  failed:  'status.FAILED',
  ready:   'status.READY',
}

export function StatusBadge({ status, className }: { status: SessionStatus; className?: string }) {
  const { t } = useI18n()
  const bucket = STATUS_BUCKET[status]
  if (!bucket) return null
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium', BUCKET_STYLE[bucket], className)}>
      {t(BUCKET_I18N[bucket])}
    </span>
  )
}
