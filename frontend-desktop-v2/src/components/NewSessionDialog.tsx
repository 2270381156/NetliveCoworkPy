import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { XIcon, FolderOpenIcon } from 'lucide-react'
import { llmsApi } from '@/api/llms'
import { ModelPickerButton } from '@/components/ui/ModelPickerButton'
import { Button } from '@/components/ui/button'
import type { PendingSession, Session } from '@/types'
import { pickDefaultsFromRecentSession } from '@/hooks/useProjectGroups'
import { useI18n } from '@/i18n'

declare global {
  interface Window {
    electronAPI?: {
      selectDirectory: () => Promise<string | null>
      openPath: (p: string) => Promise<void>
      getVersion?: () => Promise<string>
      checkForUpdates?: () => Promise<void>
      installUpdate?: () => Promise<void>
      onUpdateStatus?: (cb: (p: { status: string; version?: string; percent?: number; message?: string }) => void) => (() => void)
      convertEmf?: (items: { key: string; b64: string }[]) => Promise<{ key: string; png: string | null }[]>
      // 桌面端浏览器登录（OAuth）
      login?: () => Promise<{ id: string; username: string; role: string }>
      logout?: () => Promise<void>
      getSession?: () => Promise<{ id: string; username: string; role: string } | null>
      reportSession?: (sessionId: string, note: string) => Promise<{ ok: boolean; error?: string }>
    }
  }
}

interface Props {
  open: boolean
  initialWorkingDir?: string         // 从某项目"新建会话"时预填
  recentSessions?: Session[]         // 用于按工作目录套用最近使用的 provider/model
  onClose: () => void
  onCreated: (pending: PendingSession) => void
}

export function NewSessionDialog({ open, initialWorkingDir = '', recentSessions = [], onClose, onCreated }: Props) {
  const { t } = useI18n()
  const [workingDir, setWorkingDir] = useState('')
  const [selProvider, setSelProvider] = useState('')
  const [selModel, setSelModel] = useState('')
  // 提示：套用了来自哪个会话的设置
  const [appliedFromSession, setAppliedFromSession] = useState<string>('')
  // 跟踪用户是否手动改过 provider/model，避免覆盖
  const [providerTouched, setProviderTouched] = useState(false)

  const { data: providers = [] } = useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })

  // 工作目录变化时，从最近一次用过该 wd 的会话提取 provider/model
  function applyDefaultsFor(wd: string) {
    if (!wd) {
      setAppliedFromSession('')
      return
    }
    const pick = pickDefaultsFromRecentSession(recentSessions, wd)
    if (!pick) {
      setAppliedFromSession('')
      return
    }
    if (!providerTouched) {
      if (pick.defaults.llm_account) setSelProvider(pick.defaults.llm_account)
      if (pick.defaults.llm_model) setSelModel(pick.defaults.llm_model)
      setAppliedFromSession(pick.session.id)
    }
  }

  // 打开时重置 + 应用 initialWorkingDir
  useEffect(() => {
    if (open) {
      setWorkingDir(initialWorkingDir)
      setSelProvider('')
      setSelModel('')
      setProviderTouched(false)
      setAppliedFromSession('')
      if (initialWorkingDir) {
        // 套用最近设置；这里 providerTouched 还是 false
        const pick = pickDefaultsFromRecentSession(recentSessions, initialWorkingDir)
        if (pick) {
          if (pick.defaults.llm_account) setSelProvider(pick.defaults.llm_account)
          if (pick.defaults.llm_model) setSelModel(pick.defaults.llm_model)
          setAppliedFromSession(pick.session.id)
        }
      }
    }
    // 故意只依赖 open / initialWorkingDir，避免 recentSessions 引用变化反复重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWorkingDir])

  async function pickDirectory() {
    if (window.electronAPI) {
      const dir = await window.electronAPI.selectDirectory()
      if (dir) {
        setWorkingDir(dir)
        applyDefaultsFor(dir)
      }
    } else {
      alert(t('newSession.dirNeedsElectron'))
    }
  }

  function handleProviderModelChange(p: string, m: string) {
    setProviderTouched(true)
    setSelProvider(p)
    setSelModel(m)
    setAppliedFromSession('')   // 用户已手动改，套用提示失效
  }

  function handleCreate() {
    if (!workingDir.trim()) return
    onCreated({ workingDir: workingDir.trim(), provider: selProvider, model: selModel })
    setWorkingDir('')
    setSelProvider('')
    setSelModel('')
    setProviderTouched(false)
    setAppliedFromSession('')
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.35)', backdropFilter: 'blur(4px)' }}>
      <div className="w-[420px]" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.18)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('newSession.title')}</h2>
          <button onClick={onClose} style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
            <XIcon size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 p-4">
          {/* Working dir — required, picker only */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--t2)' }}>{t('newSession.workingDir')} <span className="text-red-500">*</span></label>
            <div
              onClick={pickDirectory}
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm"
              style={{ border: '1px solid var(--border)', background: 'var(--bg2)', transition: 'background var(--tr)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
            >
              <FolderOpenIcon size={14} className="flex-shrink-0 text-yellow-500" />
              {workingDir ? (
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--t1)' }}>{workingDir}</span>
              ) : (
                <span style={{ color: 'var(--t3)' }}>{t('newSession.selectDir')}</span>
              )}
            </div>
          </div>

          {/* Model picker */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--t2)' }}>{t('newSession.model')}</label>
            <ModelPickerButton
              variant="field"
              providers={providers}
              selectedProvider={selProvider}
              selectedModel={selModel}
              onChange={handleProviderModelChange}
              placeholder={t('newSession.useDefault')}
            />
            {appliedFromSession && (
              <p className="text-[11px]" style={{ color: 'var(--blue)' }}>
                {t('newSession.appliedRecent', { id: appliedFromSession.slice(0, 12) })}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!workingDir.trim()} onClick={handleCreate}>
            {t('newSession.create')}
          </Button>
        </div>
      </div>
    </div>
  )
}
