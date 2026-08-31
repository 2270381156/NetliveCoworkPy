import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionList } from '@/components/SessionList'
import { ChatPanel } from '@/components/ChatPanel'
import { WorkspacePanel } from '@/components/WorkspacePanel'
import { SkillsPage } from '@/components/SkillsPage'
import { LLMSettingsPage } from '@/features/llm-settings'
import { useSessionSSE } from '@/hooks/useSessionSSE'
import { useFirstVisitTour, mainTourSteps, workspaceTourSteps } from '@/hooks/useOnboarding'
import { useI18n } from '@/i18n'
import { LoginGate } from '@/components/LoginGate'
import type { PendingSession, AuthUser } from '@/types'

// ── 草稿持久化 ────────────────────────────────────────────────────────────────
// pendingSession 是 Smart B 阶段唯一不入后端的状态，关掉 app 就丢。
// 用 localStorage 落盘（Electron 下落在 %APPDATA%\IPMaster-Cowork\Local Storage\）。

const PENDING_STORAGE_KEY = 'netlive.pendingSession.v1'

function loadPendingSession(): PendingSession | null {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // 容错：确保关键字段存在
    if (typeof parsed?.workingDir === 'string' && parsed.workingDir) {
      return {
        workingDir: parsed.workingDir,
        provider: typeof parsed.provider === 'string' ? parsed.provider : '',
        model: typeof parsed.model === 'string' ? parsed.model : '',
      }
    }
    return null
  } catch {
    return null
  }
}

function savePendingSession(p: PendingSession | null): void {
  try {
    if (p) localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(p))
    else localStorage.removeItem(PENDING_STORAGE_KEY)
  } catch {
    // localStorage 不可用或配额满 —— 忽略，不阻断 UI
  }
}

export type CenterView = 'chat' | 'skills' | 'llm'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, retry: 1 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  )
}

// 启动鉴权门：先查本地 session（含云端吊销检查），未登录则显示 LoginGate。
// 纯浏览器调试（无 window.electronAPI）下跳过登录门，直接进界面。
function AuthGate() {
  const hasElectron = !!window.electronAPI?.getSession
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)

  useEffect(() => {
    if (!hasElectron) { setUser(null); return }          // 浏览器调试：跳过
    window.electronAPI!.getSession!()
      .then(u => setUser(u ?? null))
      .catch(() => setUser(null))
  }, [hasElectron])

  async function handleLogout() {
    try { await window.electronAPI?.logout?.() } catch { /* ignore */ }
    setUser(null)
  }

  if (user === undefined) {
    return <div className="h-screen" style={{ background: 'var(--bg2)' }} />   // 加载占位
  }
  if (hasElectron && user === null) {
    return <LoginGate onLogin={setUser} />
  }
  return <Desktop user={user} onLogout={hasElectron ? handleLogout : undefined} />
}

function Desktop({ user, onLogout }: { user: AuthUser | null; onLogout?: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 启动时从 localStorage 恢复草稿
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(loadPendingSession)
  const [centerView, setCenterView] = useState<CenterView>('chat')
  const [nextProvider, setNextProvider] = useState('')
  const [nextModel, setNextModel] = useState('')
  // 工作区面板显隐（全局偏好，跨会话保持；用户可在 chat 头部切换、在面板里关闭）
  const [workspaceOpen, setWorkspaceOpen] = useState(true)

  // 草稿任何变更都落盘
  useEffect(() => {
    savePendingSession(pendingSession)
  }, [pendingSession])

  // 首次进入主界面（chat 视图）引导侧栏部分（此时无会话，聊天区/工作区还没出现）
  const { lang } = useI18n()
  useFirstVisitTour('main', mainTourSteps(lang), { enabled: centerView === 'chat' })
  // 选定工作目录、有了会话/草稿（聊天区+工作区出现）后，再引导这两块
  useFirstVisitTour('workspace', workspaceTourSteps(lang), {
    enabled: centerView === 'chat' && (!!selectedId || !!pendingSession),
  })

  const sse = useSessionSSE(centerView === 'chat' ? selectedId : null)
  // 草稿优先取自己的 workingDir；否则取选中会话的；都没有就空
  const draftActive = selectedId === null && pendingSession !== null
  const workingDir = draftActive
    ? pendingSession?.workingDir ?? ''
    : sse.session?.workspace ?? ''

  // 切到已有会话：保留 pendingSession 不清空（修草稿丢失 bug）
  // 用户可通过 PendingSessionItem 切回草稿，或 X 显式取消
  function handleSelect(id: string) {
    setSelectedId(id)
    setCenterView('chat')
  }

  function handleNewSession(pending: PendingSession) {
    setSelectedId(null)
    setPendingSession({
      ...pending,
      provider: pending.provider || nextProvider,
      model: pending.model || nextModel,
    })
    setCenterView('chat')
  }

  function handleSessionCreated(id: string) {
    setPendingSession(null)
    setSelectedId(id)
  }

  // 点 PendingSessionItem：切回草稿视图（清 selectedId）
  function handlePendingSelect() {
    setSelectedId(null)
    setCenterView('chat')
  }

  // 显式取消草稿（X 按钮）
  function handleDismissDraft() {
    setPendingSession(null)
  }

  function handleNextLLMChange(provider: string, model: string) {
    setNextProvider(provider)
    setNextModel(model)
    if (pendingSession) {
      setPendingSession({ ...pendingSession, provider, model })
    }
  }

  // 是否具备显示工作区的条件（chat 视图下，有选中会话或活跃草稿即可；
  // 不要求 workingDir 已设置——用户可能刚进入会话尚未设定目录）
  const canShowWorkspace = centerView === 'chat' && (!!selectedId || draftActive)
  // 实际是否显示 = 条件满足 且 用户没关掉
  const showWorkspace = canShowWorkspace && workspaceOpen

  return (
    // 整个窗口是淡灰"边框"底
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--bg2)', color: 'var(--t1)' }}>
      {/* 顶部完整一条 —— 全宽、可拖窗口；右上角留给原生控件 overlay */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingRight: 150,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        <BrandBlock />
      </div>

      {/* 主体 —— 侧边栏贴左（不额外加宽），右/下 8px 灰边，顶部 8px 透气 */}
      <div className="flex min-h-0 flex-1" style={{ paddingTop: 8, paddingRight: 8, paddingBottom: 8 }}>
        {/* 左侧栏 —— 透明融进灰框；内部左 padding 给内容透气，但外宽不变（中间卡片不右移） */}
        <div className="w-60 flex-shrink-0 flex flex-col" style={{ paddingLeft: 4 }}>
          <SessionList
            selectedId={centerView === 'chat' ? selectedId : null}
            pendingSession={centerView === 'chat' ? pendingSession : null}
            centerView={centerView}
            onViewChange={setCenterView}
            onSelect={handleSelect}
            onNewSession={handleNewSession}
            onPendingSelect={handlePendingSelect}
            onDismissDraft={handleDismissDraft}
            user={user}
            onLogout={onLogout}
          />
        </div>

        {/* 中间内容卡片 —— 白底圆角 + 细边框，浮在灰框里 */}
        <div
          data-tour="chat-area"
          className="flex min-w-0 flex-1 flex-col"
          style={{
            background: 'var(--bg1)',
            borderRadius: 12,
            border: '1px solid var(--border)',
            overflow: 'hidden',
            marginLeft: 4,
          }}
        >
          {centerView === 'skills' ? (
            <SkillsPage onClose={() => setCenterView('chat')} />
          ) : centerView === 'llm' ? (
            <LLMSettingsPage onClose={() => setCenterView('chat')} />
          ) : (
            <ChatPanel
              sessionId={selectedId}
              sse={sse}
              pendingSession={draftActive ? pendingSession : null}
              onSessionCreated={handleSessionCreated}
              nextProvider={nextProvider}
              nextModel={nextModel}
              onNextLLMChange={handleNextLLMChange}
              canShowWorkspace={canShowWorkspace}
              workspaceOpen={workspaceOpen}
              onToggleWorkspace={() => setWorkspaceOpen(v => !v)}
            />
          )}
        </div>

        {/* 右侧 workspace —— 独立白卡片，跟中间卡片间隔 8px */}
        {showWorkspace && (
          <div
            data-tour="workspace"
            className="w-72 flex-shrink-0 flex flex-col"
            style={{
              background: 'var(--bg1)',
              borderRadius: 12,
              border: '1px solid var(--border)',
              overflow: 'hidden',
              marginLeft: 8,
            }}
          >
            <div className="flex-1 min-h-0">
              <WorkspacePanel workingDir={workingDir} onClose={() => setWorkspaceOpen(false)} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function BrandBlock() {
  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: '0 12px',
        height: '100%',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <img src="/icon.svg" alt="" style={{ width: 20, height: 20, flexShrink: 0 }} />
      <div className="flex items-center" style={{ gap: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.2px' }}>IPMaster</span>
        <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--t3)', letterSpacing: '0.2px' }}>·</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.2px' }}>Cowork</span>
      </div>
      <span style={{
        marginLeft: 2,
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        color: '#2563eb',
        background: 'rgba(37, 99, 235, 0.12)',
        border: '1px solid rgba(37, 99, 235, 0.25)',
        borderRadius: 4,
        padding: '2px 4px',
      }}>beta</span>
    </div>
  )
}
