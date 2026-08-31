import { CloudIcon } from 'lucide-react'
import { useI18n } from '@/i18n'

// 云端会话标识。本地会话不加徽标——本地是常态，只给"跑在云上"这件事一个显式提示，
// 免得列表里每条都挂个牌子反而看不清。
export function CloudBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n()
  if (compact) {
    return (
      <CloudIcon
        size={12}
        aria-label={t('session.locCloud')}
        style={{ flexShrink: 0, color: 'var(--teal)' }}
      />
    )
  }
  return (
    <span
      className="inline-flex items-center rounded"
      style={{
        gap: 3,
        padding: '2px 5px',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--teal)',
        background: 'rgba(8,145,178,.10)',
        border: '1px solid rgba(8,145,178,.25)',
      }}
    >
      <CloudIcon size={11} />
      {t('session.locCloud')}
    </span>
  )
}
