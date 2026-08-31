import { useState } from 'react'
import { UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

export function ReportSessionButton({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(null)

  async function submit() {
    setBusy(true)
    setStatus(null)
    try {
      const r = await window.electronAPI?.reportSession?.(sessionId, note)
      if (r?.ok) {
        setStatus({ ok: true, msg: t('chat.reportSessionDone') })
        setOpen(false)
        setNote('')
      } else {
        setStatus({ ok: false, msg: r?.error || t('chat.reportSessionFail') })
      }
    } catch (e) {
      setStatus({ ok: false, msg: String((e as Error)?.message || e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => { setStatus(null); setOpen(true) }}
        title={t('chat.reportSession')}
        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        style={{ background: 'none', color: 'var(--t3)', border: 'none', cursor: 'pointer' }}
        onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
        onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
      >
        <UploadIcon size={15} />
      </button>
      {status && !open && (
        <span className="mr-1 text-xs" style={{ color: status.ok ? 'var(--teal, #0d9488)' : 'var(--red, #dc2626)' }}>{status.msg}</span>
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
            {status && !status.ok && (
              <p className="mb-2 text-xs" style={{ color: 'var(--red, #dc2626)' }}>{status.msg}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setOpen(false); setNote('') }} disabled={busy}>{t('common.cancel')}</Button>
              <Button variant="default" size="sm" onClick={submit} disabled={busy}>{busy ? t('chat.reportSessionSending') : t('chat.reportSessionSubmit')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
