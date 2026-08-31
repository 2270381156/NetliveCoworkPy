import { useEffect } from 'react'
import { AlertCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

interface Props {
  /** 后端原始错误串(LLMCallError 的消息)。 */
  message: string
  onClose: () => void
}

/**
 * 终态 LLM 调用错误弹窗。后端 task_failed(error_type=LLMCallError, will_retry=false)
 * 时由 ChatPanel 渲染:告知用户这是 LLM 侧(模型/供应商/网络)返回的预料之外错误,而非
 * 任务本身的问题,并建议上报会话供开发者排查。只提供「关闭」,不在此恢复运行。
 * 叠加层样式沿用 FilePreviewModal 约定(非 Radix)。
 */
export function LLMErrorModal({ message, onClose }: Props) {
  const { t } = useI18n()

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ background: 'rgba(15,31,61,.35)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="relative flex flex-col rounded-xl"
        style={{ width: 'min(440px, 90vw)', background: 'var(--bg1)', boxShadow: '0 24px 80px rgba(15,31,61,.22)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-1">
          <AlertCircleIcon size={18} className="flex-shrink-0" style={{ color: '#dc2626' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('llmError.title')}</span>
        </div>

        {/* Body */}
        <div className="px-5 pt-2 pb-1">
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--t2)' }}>{t('llmError.body')}</p>
        </div>

        {/* Error detail */}
        <div className="px-5 pt-3">
          <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--t3)' }}>{t('llmError.detail')}</div>
          <div
            className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-auto rounded-md px-3 py-2"
            style={{ maxHeight: 160, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--t2)' }}
          >
            {message || '—'}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <Button size="sm" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </div>
    </div>
  )
}
