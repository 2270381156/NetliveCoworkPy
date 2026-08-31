import { useEffect, useRef, useState } from 'react'
import { UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

/** 成功提示自动消失的时间(ms)——上报已改成后台跑，弹窗不再等结果。失败不自动消失。 */
const DONE_TTL = 6000

export function ReportSessionButton({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [inflight, setInflight] = useState(0)
  const [done, setDone] = useState(false)
  // 失败常驻，直到用户自己处理掉：点一下重开弹窗、备注原样带回去重报。
  const [failed, setFailed] = useState<null | { note: string }>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // 点完就关窗，上传在后台跑，不挡用户操作。
  function submit() {
    const payload = note
    setOpen(false)
    setNote('')
    setDone(false)
    setFailed(null)
    if (timer.current) clearTimeout(timer.current)
    setInflight(n => n + 1)
    void (async () => {
      let ok = false
      // 统一友好提示；技术原因(HTTP 状态码/异常)记在 electron.log,不抛给用户。
      try { ok = !!(await window.electronAPI?.reportSession?.(sessionId, payload))?.ok } catch { ok = false }
      setInflight(n => n - 1)
      if (!ok) { setFailed({ note: payload }); return }
      setDone(true)
      timer.current = setTimeout(() => setDone(false), DONE_TTL)
    })()
  }

  // 失败条点一下重开弹窗、带回上次备注；失败标记留到下一次提交才清，
  // 中途取消不会把"上次没报上去"这件事悄悄抹掉。
  function retry() {
    setNote(failed?.note || '')
    setOpen(true)
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true) }}
        title={t('chat.reportSession')}
        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        style={{ background: 'none', color: 'var(--t3)', border: 'none', cursor: 'pointer' }}
        onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
        onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
      >
        <UploadIcon size={15} />
      </button>
      {inflight > 0 && (
        <span className="mr-1 text-xs" style={{ color: 'var(--t2)' }}>{t('chat.reportSessionSending')}</span>
      )}
      {inflight === 0 && done && (
        <span className="mr-1 text-xs" style={{ color: 'var(--teal, #0d9488)' }}>{t('chat.reportSessionDone')}</span>
      )}
      {inflight === 0 && failed && (
        <button
          onClick={retry}
          title={t('chat.reportSessionRetry')}
          className="mr-1 text-xs underline underline-offset-2"
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--red, #dc2626)', cursor: 'pointer' }}
        >
          {t('chat.reportSessionFail')} · {t('chat.reportSessionRetry')}
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.35)', backdropFilter: 'blur(4px)' }}>
          <div className="w-96 p-4" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 24px 80px rgba(15,31,61,.18)' }}>
            <p className="mb-2 text-sm font-medium" style={{ color: 'var(--t1)' }}>{t('chat.reportSession')}</p>
            <p className="mb-3 text-xs" style={{ color: 'var(--t2)' }}>{t('chat.reportSessionConsent')}</p>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('chat.reportSessionNote')}
              className="mb-3 w-full rounded-md p-2 text-sm"
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--t1)', minHeight: 60, resize: 'vertical' }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button variant="default" size="sm" onClick={submit}>{t('chat.reportSessionSubmit')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
