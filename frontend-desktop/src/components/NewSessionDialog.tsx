import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { XIcon, FolderOpenIcon } from 'lucide-react'
import { llmsApi } from '@/api/llms'
import { ModelPickerButton } from '@/components/ui/ModelPickerButton'
import { Button } from '@/components/ui/button'
import type { PendingSession, Session } from '@/types'
import { pickLastUsedDefaults } from '@/hooks/useProjectGroups'
import { useI18n } from '@/i18n'
import { AgentMark } from '@/components/AgentHome'
import type { Agent } from '@/agents/registry'

declare global {
  interface Window {
    electronAPI?: {
      selectDirectory: () => Promise<string | null>
      openPath: (p: string) => Promise<void>
      openExternal: (url: string) => Promise<void>
      getVersion?: () => Promise<string>
      checkForUpdates?: () => Promise<void>
      installUpdate?: () => Promise<void>
      onUpdateStatus?: (cb: (p: { status: string; version?: string; percent?: number; message?: string }) => void) => (() => void)
      convertEmf?: (items: { key: string; b64: string }[]) => Promise<{ key: string; png: string | null }[]>
      // 桌面端浏览器登录（OAuth）
      login?: () => Promise<{ id: string; username: string; role: string }>
      getLoginError?: () => Promise<string | null>
      logout?: () => Promise<void>
      getSession?: () => Promise<{ id: string; username: string; role: string } | null>
      getToken?: () => Promise<string | null>
      reportSession?: (sessionId: string, note: string) => Promise<{ ok: boolean; error?: string }>
      // 桌面通知（见 hooks/useSessionNotifications.ts）
      notify?: (p: { title: string; body: string; sessionId?: string; flash?: boolean; force?: boolean }) => Promise<boolean>
      setPending?: (p: { count: number }) => Promise<boolean>
      onNotificationClick?: (cb: (p: { sessionId?: string }) => void) => (() => void)
    }
  }
}

interface Props {
  open: boolean
  initialWorkingDir?: string         // 从某项目"新建会话"时预填
  /** 空态里选中的 agent（决定 template_id）。null = 没有 agent 这一层，走旧形态。 */
  agent?: Agent | null
  recentSessions?: Session[]         // 用于取「上一次用过的」provider/model 作默认值
  onClose: () => void
  onCreated: (pending: PendingSession) => void
}

export function NewSessionDialog({ open, initialWorkingDir = '', agent = null, recentSessions = [], onClose, onCreated }: Props) {
  const { t } = useI18n()
  const [workingDir, setWorkingDir] = useState('')
  const [selProvider, setSelProvider] = useState('')
  const [selModel, setSelModel] = useState('')

  const { data: providers = [] } = useQuery({
    queryKey: ['llms', 'local', agent?.id ?? null],
    // 带上 agent：新建会话时选的模型必须是这个 cowork 允许的，否则用户选完、建会话时被
    // 后端 403 拒掉——那时他已经填完一整个表单了。
    queryFn: () => llmsApi.listOn('local', agent?.id ?? null),
  })

  // 打开时重置，并把「上一次用过的模型」填进去。
  //
  // 只在打开这一刻取一次，之后换工作目录不再改动选择——默认值与目录无关，用户手动改过
  // 的选择也不会被后续动作覆盖。
  useEffect(() => {
    if (open) {
      setWorkingDir(initialWorkingDir)
      const last = pickLastUsedDefaults(recentSessions)
      setSelProvider(last?.llm_account || '')
      setSelModel(last?.llm_model || '')
    }
    // 故意只依赖 open / initialWorkingDir，避免 recentSessions 引用变化反复重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWorkingDir])

  async function pickDirectory() {
    if (window.electronAPI) {
      const dir = await window.electronAPI.selectDirectory()
      if (dir) setWorkingDir(dir)
    } else {
      alert(t('newSession.dirNeedsElectron'))
    }
  }

  function handleProviderModelChange(p: string, m: string) {
    setSelProvider(p)
    setSelModel(m)
  }

  const canCreate = !!workingDir.trim()

  function handleCreate() {
    if (!canCreate) return
    // location 仍然发 'local'：会话记录里这个字段还在（列表的来源徽章读它），
    // 本分支恒为 local。
    onCreated({
      workingDir: workingDir.trim(),
      provider: selProvider,
      model: selModel,
      location: 'local',
      agentId: agent?.id,
    })
    setWorkingDir('')
    setSelProvider('')
    setSelModel('')
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.35)', backdropFilter: 'blur(4px)' }}>
      <div className="w-[420px]" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.18)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          {agent ? (
            <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <AgentMark agent={agent} size={22} />
              <span className="truncate">
                <span className="block text-sm font-semibold truncate" style={{ color: 'var(--t1)' }}>{agent.displayName}</span>
                <span className="block text-[11px] truncate" style={{ color: 'var(--t3)' }}>{t('newSession.title')}</span>
              </span>
            </span>
          ) : (
            <h2 className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('newSession.title')}</h2>
          )}
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
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!canCreate} onClick={handleCreate}>
            {t('newSession.create')}
          </Button>
        </div>
      </div>
    </div>
  )
}
