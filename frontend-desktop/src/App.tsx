import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { llmsApi } from '@/api/llms'
import { skillsApi } from '@/api/skills'
import { workspaceApi } from '@/api/workspace'
import { SessionList } from '@/components/SessionList'
import { ChatPanel } from '@/components/ChatPanel'
import { WorkspacePanel } from '@/components/WorkspacePanel'
import { BrowserPanel } from '@/components/BrowserPanel'
import { FilePreviewContent } from '@/components/FilePreviewModal'
import { PanelLeftIcon } from 'lucide-react'
import { SkillsPage } from '@/components/SkillsPage'
import { LLMSettingsPage } from '@/components/LLMSettingsPage'
import { FaqPage } from '@/components/FaqPage'
import { useSessionSSE } from '@/hooks/useSessionSSE'
import { useUpdateNag, UpdateNagBoundary } from '@/hooks/useUpdateNag'
import { useSessionNotifications } from '@/hooks/useSessionNotifications'
import { useQueueDrainer } from '@/hooks/useQueueDrainer'
import { useFirstVisitTour, mainTourSteps, workspaceTourSteps } from '@/hooks/useOnboarding'
import { useI18n } from '@/i18n'
import { LoginGate } from '@/components/LoginGate'
import { useAgentActivity } from '@/hooks/useAgentActivity'
import { useCurrentAgent } from '@/agents/useCurrentAgent'
import { AgentSwitcher } from '@/components/AgentSwitcher'
import { isCloudSession } from '@/api/backends'
import { useCloudBackend } from '@/hooks/useCloudBackend'
import type { PendingSession, AuthUser } from '@/types'
import branding from '@branding'   // 品牌显示名唯一来源，见 electron/branding.json

// ── 草稿持久化 ────────────────────────────────────────────────────────────────
// pendingSession 是 Smart B 阶段唯一不入后端的状态，关掉 app 就丢。
// 用 localStorage 落盘（Electron 下落在 userData 里，即 %APPDATA%\<branding.npmName>\
// Local Storage\——注意不是放业务数据的 %APPDATA%\<branding.appDataDir>\，两者是不同目录）。

// 顶栏品牌名分段：按连字符/空格拆，供 · 分隔排版用。
const brandParts: string[] = String(branding.productName).split(/[-\s]+/).filter(Boolean)

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

export type CenterView = 'chat' | 'skills' | 'llm' | 'faq'

// file:// URL → 本地文件路径（供工作区预览端点用）。
//   file:///D:/a/b.html → D:/a/b.html ；file://server/share → //server/share
function fileUrlToPath(u: string): string {
  let p = u.replace(/^file:\/\//i, '')
  try { p = decodeURIComponent(p) } catch { /* 已是明文 */ }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)   // 去掉盘符前多余的斜杠
  return p
}

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

  // 登录/切换账号后，把当前用户名注入后端；退出登录时也立即清空，避免恢复会话在
  // 下一位用户完成登录前短暂继承上一位用户。失败不阻断 UI。
  useEffect(() => {
    if (user !== undefined) {
      skillsApi.setCurrentUser(user?.username ?? '').catch(() => {})
    }
  }, [user])

  async function handleLogout() {
    try {
      await window.electronAPI?.logout?.()
      setUser(null)
    } catch (error) {
      // Keep the visible user when auth.bin could not be invalidated. Showing a
      // fake logged-out screen would restore the old account on next launch.
      console.error('logout failed', error)
    }
  }

  if (user === undefined) {
    return <div className="h-screen" style={{ background: 'var(--bg2)' }} />   // 加载占位
  }
  if (hasElectron && user === null) {
    return <LoginGate onLogin={setUser} />
  }
  return <Desktop user={user} onLogout={hasElectron ? handleLogout : undefined} />
}

// ── Resizable panels ─────────────────────────────────────────────────────────
function readLS(key: string, def: number, min: number, max: number): number {
  try { const n = Number(localStorage.getItem(key)); return n > 0 ? Math.min(max, Math.max(min, n)) : def } catch { return def }
}
function startHDrag(e: React.MouseEvent, cb: (d: number) => void) {
  e.preventDefault()
  let last = e.clientX
  // 关键：拖拽时铺一层全窗口透明遮罩接住指针事件。否则光标一旦划过 <webview>/iframe，
  // 事件被它们吞掉，父窗口的 mousemove/mouseup 收不到 → 快速拖拽时手柄不跟手、松手也停不下来。
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:col-resize'
  document.body.appendChild(overlay)
  const mv = (ev: MouseEvent) => { cb(ev.clientX - last); last = ev.clientX }
  const up = () => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up)
    window.removeEventListener('blur', up)
    document.body.style.userSelect = ''
    overlay.remove()          // 幂等：重复调用无害
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
  // 光靠 mouseup 收尾不够稳：拖拽中窗口若失去输入焦点（最小化、Alt+Tab、被别的窗口抢焦点），
  // mouseup 可能永远送不到，遮罩就会永久留在页面上，之后所有点击全被它吞掉——表现为
  // 「界面正常但点哪都没反应」。blur 一并收尾，把这条死路堵上。
  window.addEventListener('blur', up)
}
function VResizeHandle({ onStart }: { onStart: (e: React.MouseEvent) => void }) {
  const [hov, setHov] = useState(false)
  return (
    <div onMouseDown={onStart} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ width: 8, flexShrink: 0, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 2, height: '40%', minHeight: 40, borderRadius: 1, background: hov ? 'var(--border2)' : 'transparent', transition: 'background .15s' }} />
    </div>
  )
}

function PanelTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
      style={{
        background: active ? 'var(--blue-dim)' : 'none',
        color: active ? 'var(--blue)' : 'var(--t3)',
        border: 'none', cursor: active ? 'default' : 'pointer',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--t2)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
    >
      {label}
    </button>
  )
}

function Desktop({ user, onLogout }: { user: AuthUser | null; onLogout?: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 启动时从 localStorage 恢复草稿
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(loadPendingSession)
  const [centerView, setCenterView] = useState<CenterView>('chat')
  // 每个会话各自的模型选择，按 sessionId 隔离（未发送的选择也各留各的、互不影响）。
  // 当前会话的有效模型 = 该会话的暂存选择 override，否则回退会话后端模型（仅可见账号）。
  const [modelBySession, setModelBySession] = useState<Record<string, { provider: string; model: string }>>({})
  // providers 仅用于判断会话的 llm_account 是否"可见"（env 默认账号对用户隐藏）。
  // 账号按会话所属后端取：云端实例有自己的一份账号库，与地端不同（见 api/llms.ts）。
  // 草稿期看草稿选的位置，已有会话看它来自哪个后端。
  const llmBackend = (selectedId === null && pendingSession?.location === 'cloud')
    || (!!selectedId && isCloudSession(selectedId)) ? 'cloud' : 'local'
  // 这里**刻意不按 cowork 过滤**：这份 providers 只用来判断"会话的 llm_account 是不是一个
  // 可见账号"（acctVisible），不是给用户选的。按 cowork 过滤会把属于别的 cowork 的会话误判
  // 成"账号不可见"。真正要过滤的是选择器——见 ChatPanel 与 NewSessionDialog。
  const { data: providers = [] } = useQuery({
    queryKey: ['llms', llmBackend],
    queryFn: () => llmsApi.listOn(llmBackend),
  })
  // 工作区面板显隐（全局偏好，跨会话保持；用户可在 chat 头部切换、在面板里关闭）
  const [workspaceOpen, setWorkspaceOpen] = useState(true)
  // 右侧面板 tab（文件 / 预览 / 网页）。点 chat 链接 → 网页 tab；点文件 → 预览 tab。
  const [rightTab, setRightTab] = useState<'files' | 'preview' | 'web'>('files')
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  // 预览/网页面板宽度：null=跟随「可用区一半」动态；用户拖过 → 固定成具体值。打开时重置为 null。
  const [viewOverrideW, setViewOverrideW] = useState<number | null>(null)
  // 左侧会话列表可收起
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [leftW, setLeftW] = useState(() => readLS('ipmc.ui.leftW', 240, 160, 400))
  // 文件 tab 的面板宽度（可拖、持久化）。预览/网页 tab 不用它——那两个按「可用区一半」动态算。
  const [filesW, setFilesW] = useState(() => readLS('ipmc.ui.rightW', 288, 200, 800))
  useEffect(() => { localStorage.setItem('ipmc.ui.leftW', String(leftW)) }, [leftW])
  useEffect(() => { localStorage.setItem('ipmc.ui.rightW', String(filesW)) }, [filesW])
  // 窗口宽度：用于把「预览/网页」面板动态算成可用区(窗口宽 − 侧栏)的一半。
  const [winW, setWinW] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 草稿任何变更都落盘
  useEffect(() => {
    savePendingSession(pendingSession)
  }, [pendingSession])

  // 首次进入主界面（chat 视图）引导侧栏部分（此时无会话，聊天区/工作区还没出现）
  const { lang, t: tt } = useI18n()
  useFirstVisitTour('main', mainTourSteps(lang), { enabled: centerView === 'chat' })
  // 选定工作目录、有了会话/草稿（聊天区+工作区出现）后，再引导这两块
  useFirstVisitTour('workspace', workspaceTourSteps(lang), {
    enabled: centerView === 'chat' && (!!selectedId || !!pendingSession),
  })

  // 别的 agent 名下有多少会话在跑/等输入 —— 喂给切换行上的活动提示。
  const agentActivity = useAgentActivity()

  // 切换 cowork：清掉选中会话与不属于新 cowork 的草稿。
  // 会话列表按当前 cowork 过滤，若不清，聊天区会继续开着上一个 cowork 的会话——
  // 出现「列表里根本没有这条会话，中间栏却开着它」的错位。用 ref 记上一个 id 而不是直接
  // 在 effect 里无条件清：否则首次挂载也会跑一遍，把恢复出来的草稿误清掉。
  const currentAgent = useCurrentAgent()
  const prevAgentIdRef = useRef(currentAgent?.id)
  useEffect(() => {
    const nextId = currentAgent?.id
    if (prevAgentIdRef.current === nextId) return
    prevAgentIdRef.current = nextId
    setSelectedId(null)
    setPendingSession(p => (p && p.agentId && p.agentId !== nextId ? null : p))
  }, [currentAgent])

  // 更新催升级：更新下好后，用户每有「想干活」的动作就弹居中升级窗（5 分钟冷却）。
  const { poke: pokeUpdate, modalNode: updateModal } = useUpdateNag()

  const sse = useSessionSSE(centerView === 'chat' ? selectedId : null)
  // 草稿优先取自己的 workingDir；否则取选中会话的；都没有就空
  const draftActive = selectedId === null && pendingSession !== null
  // 草稿期：本地用所选目录，云端用所选文件夹的绝对路径——两者都是"已经存在的、可浏览的
  // 落脚处"，于是工作区面板一套实现两边通用（见 WorkspacePanel 头部注释）。
  const workingDir = draftActive
    ? (pendingSession?.location === 'cloud'
        ? pendingSession?.cloudFolderPath ?? ''
        : pendingSession?.workingDir ?? '')
    : sse.session?.workspace ?? ''
  // 云地协同：会话是云端的 → 工作区面板向云端后端要文件（定址由 api/backends 负责，
  // 面板本身两种形态共用同一套实现）。草稿期还没有会话，展示的是"待上传"清单。
  // 云端后端的连接状态：整个 App 只探测这一处，其余组件同步读 api/backends。
  const cloud = useCloudBackend()
  const draftIsCloud = draftActive && pendingSession?.location === 'cloud'
  const isCloud = draftIsCloud || (!draftActive && !!selectedId && isCloudSession(selectedId))

  // 草稿工作区登记：草稿期把所选目录登记到后端，右侧文件面板立即可浏览
  // （/workspace/files 只放行已登记根；session 要等首条消息才创建）。
  // 用 effect 而非挂在 handleNewSession：后端重启、页面刷新（localStorage 恢复草稿）后也要补登记。
  const draftWorkingDir = draftActive ? pendingSession?.workingDir : undefined
  useEffect(() => {
    if (!draftWorkingDir) return
    workspaceApi.registerDraftRoot(draftWorkingDir)
      .then(() => queryClient.invalidateQueries({ queryKey: ['workspace-files'] }))
      .catch(() => { /* 3s 轮询兜底，登记失败不打扰用户 */ })
  }, [draftWorkingDir])

  // 当前选中会话的有效模型：优先该会话的暂存选择 override；否则回退会话后端模型，
  // 且只在账号"可见"时显示其真名（env 默认账号对用户隐藏 → 回落空串=默认模型）。
  const modelOverride = selectedId ? modelBySession[selectedId] : undefined
  const acctVisible = !!sse.session?.llm_account && providers.some(p => p.name === sse.session!.llm_account)
  const nextProvider = modelOverride ? modelOverride.provider : (acctVisible ? sse.session!.llm_account! : '')
  const nextModel = modelOverride ? modelOverride.model : (acctVisible ? (sse.session!.llm_model ?? '') : '')

  // 切换会话/草稿时重置右侧面板。browserUrl / previewPath / rightTab 是 Desktop 级
  // 状态、不随会话派生（不像 workingDir 那样从 selectedId 取）；不重置的话，在会话 A 打开
  // 的网页/预览会残留到会话 B——右侧显示的仍是上一个会话的内容。切走时统一回到文件列表。
  // 注意：仅用于「真正切到别的会话/草稿」，不含「草稿→刚建好的同一会话」(handleSessionCreated)。
  function resetSidePanel() {
    setRightTab('files')
    setBrowserUrl(null)
    setPreviewPath(null)
    setViewOverrideW(null)
  }

  // 切到已有会话：保留 pendingSession 不清空（修草稿丢失 bug）
  // 用户可通过 PendingSessionItem 切回草稿，或 X 显式取消
  function handleSelect(id: string) {
    if (id !== selectedId) resetSidePanel()   // 切到不同会话才重置（重复点当前会话不动）
    pokeUpdate()   // 进入/切换会话 → 触发升级窗
    setSelectedId(id)
    setCenterView('chat')
  }

  // 桌面通知：HITL 待应答 / 任务结束 → 系统 toast + 任务栏闪烁 + 角标。
  // 点 toast 走 handleSelect 跳到对应会话；会话已被删则 SessionList 不含它，
  // 选中态落空但界面不崩（与手动点一个刚被删的会话表现一致）。
  useSessionNotifications(handleSelect)

  // 排队待发送消息的统一发送方：会话一空闲就发，不管用户此刻在看哪个会话/哪个页面。
  // 正在看的那个会话由 ChatPanel 的 SSE 边沿另行催发（省掉轮询延迟），两条路共用同一把锁。
  useQueueDrainer(user, id => { if (id === selectedId && centerView === 'chat') sse.reconnect() })

  function handleNewSession(pending: PendingSession) {
    resetSidePanel()   // 进入新草稿 → 右侧回到文件列表，不带上一个会话的网页/预览
    pokeUpdate()   // 新建会话 → 触发升级窗
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
    // 会话已真正创建（workspace 随 POST /sessions 登记），草稿根用完了
    workspaceApi.clearDraftRoot().catch(() => {})
  }

  // 点 PendingSessionItem：切回草稿视图（清 selectedId）
  function handlePendingSelect() {
    if (selectedId !== null) resetSidePanel()   // 从某会话切回草稿才重置
    setSelectedId(null)
    setCenterView('chat')
  }

  // 显式取消草稿（X 按钮）
  function handleDismissDraft() {
    setPendingSession(null)
    workspaceApi.clearDraftRoot().catch(() => {})
  }

  function handleNextLLMChange(provider: string, model: string) {
    // 草稿态：写进草稿自身（其模型选择器读 pendingSession）。
    // 已有会话：只写进该 sessionId 的暂存，绝不影响别的会话。
    if (pendingSession) {
      setPendingSession({ ...pendingSession, provider, model })
    } else if (selectedId) {
      setModelBySession(prev => ({ ...prev, [selectedId]: { provider, model } }))
    }
  }

  // 是否具备显示工作区的条件（chat 视图下，有选中会话或活跃草稿即可；
  // 不要求 workingDir 已设置——用户可能刚进入会话尚未设定目录）
  const canShowWorkspace = centerView === 'chat' && (!!selectedId || draftActive)
  // 实际是否显示 = 条件满足 且 用户没关掉
  const showWorkspace = canShowWorkspace && workspaceOpen

  // 左侧占位宽度：收起时约为展开按钮那一小列，展开时为列表宽 + 拖拽手柄。
  const sidebarSpace = leftCollapsed ? 36 : leftW + 8
  const viewMax = Math.max(320, winW - sidebarSpace - 380)   // 上限：给聊天区留 ~380
  // 预览/网页默认宽 = 可用区(窗口宽 − 侧栏)的一半，随侧栏/窗口动态；用户拖过则用固定值。
  const halfW = Math.max(320, Math.min((winW - sidebarSpace - 16) / 2, viewMax))
  const viewW = viewOverrideW != null ? Math.max(280, Math.min(viewOverrideW, viewMax)) : halfW
  const filesWClamped = Math.min(filesW, Math.max(280, viewMax))
  const rightPanelW = rightTab === 'files' ? filesWClamped : viewW

  // 点 chat 里的链接：file:// 本地文件 → 右侧「预览」tab；http(s) → 应用内浏览器「网页」tab。
  // 首次切入时重置为默认半宽。
  function openUrl(url: string) {
    if (/^file:\/\//i.test(url)) { openPreview(fileUrlToPath(url)); return }
    if (!workspaceOpen || rightTab !== 'web') setViewOverrideW(null)
    setBrowserUrl(url)
    setRightTab('web')
    setWorkspaceOpen(true)
  }
  // 点工作区文件 → 在「预览」tab 打开（替代原浮动模态）。首次切入时重置为默认半宽。
  function openPreview(path: string) {
    if (!workspaceOpen || rightTab !== 'preview') setViewOverrideW(null)
    setPreviewPath(path)
    setRightTab('preview')
    setWorkspaceOpen(true)
  }

  return (
   <UpdateNagBoundary poke={pokeUpdate}>
    {/* 整个窗口是淡灰"边框"底 */}
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
        <BrandBlock agentActivity={agentActivity} />
      </div>

      {/* 主体 —— 侧边栏贴左（不额外加宽），右/下 8px 灰边，顶部 8px 透气 */}
      <div className="flex min-h-0 flex-1" style={{ paddingTop: 8, paddingRight: 8, paddingBottom: 8 }}>
        {/* 左侧栏 —— 透明融进灰框；可收起（列表头部按钮收起，收起后左边缘按钮展开）。 */}
        {leftCollapsed ? (
          <div style={{ flexShrink: 0, paddingLeft: 4, paddingTop: 2 }}>
            <button
              onClick={() => setLeftCollapsed(false)}
              title={tt('sidebar.expand')}
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
              style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
            >
              <PanelLeftIcon size={16} />
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col" style={{ width: leftW, flexShrink: 0, paddingLeft: 4 }}>
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
                onCollapse={() => setLeftCollapsed(true)}
              />
            </div>
            <VResizeHandle onStart={e => startHDrag(e, d => setLeftW(w => Math.min(400, Math.max(160, w + d))))} />
          </>
        )}

        {/* 中间内容卡片 —— 白底圆角 + 细边框，浮在灰框里 */}
        <div
          data-tour="chat-area"
          className="flex min-w-0 flex-1 flex-col"
          style={{
            background: 'var(--bg1)',
            borderRadius: 12,
            border: '1px solid var(--border)',
            overflow: 'hidden',
          }}
        >
          {centerView === 'skills' ? (
            <SkillsPage onClose={() => setCenterView('chat')} user={user} />
          ) : centerView === 'llm' ? (
            <LLMSettingsPage onClose={() => setCenterView('chat')} />
          ) : centerView === 'faq' ? (
            <FaqPage onClose={() => setCenterView('chat')} />
          ) : (
            <ChatPanel
              sessionId={selectedId}
              sse={sse}
              pendingSession={draftActive ? pendingSession : null}
              user={user}
              onSessionCreated={handleSessionCreated}
              onNewSession={handleNewSession}
              nextProvider={nextProvider}
              nextModel={nextModel}
              onNextLLMChange={handleNextLLMChange}
              canShowWorkspace={canShowWorkspace}
              workspaceOpen={workspaceOpen}
              onToggleWorkspace={() => setWorkspaceOpen(v => !v)}
              onOpenUrl={openUrl}
            />
          )}
        </div>

        {/* 右侧 workspace —— 独立白卡片，跟中间卡片间隔 8px */}
        {showWorkspace && (
          <>
            {/* 拖拽手柄：文件 tab 调 filesW，预览/网页调 viewOverrideW（从当前半宽起拖）。 */}
            <VResizeHandle onStart={e => startHDrag(e, d => {
              if (rightTab === 'files') setFilesW(w => Math.min(800, Math.max(200, w - d)))
              else setViewOverrideW(w => Math.max(280, Math.min((w ?? halfW) - d, viewMax)))
            })} />
            <div
              data-tour="workspace"
              className="flex flex-col"
              style={{
                width: rightPanelW,
                flexShrink: 0,
                background: 'var(--bg1)',
                borderRadius: 12,
                border: '1px solid var(--border)',
                overflow: 'hidden',
              }}
            >
              {/* Tab 条：文件 / 预览（有选中文件时）/ 网页 */}
              <div className="flex items-center gap-1 px-2 pt-2" style={{ flexShrink: 0 }}>
                <PanelTab active={rightTab === 'files'} onClick={() => setRightTab('files')} label={tt('workspace.tabFiles')} />
                {previewPath && (
                  <PanelTab active={rightTab === 'preview'} onClick={() => setRightTab('preview')} label={tt('workspace.tabPreview')} />
                )}
                <PanelTab active={rightTab === 'web'} onClick={() => setRightTab('web')} label={tt('workspace.tabWeb')} />
              </div>
              <div className="flex-1 min-h-0">
                {/* 三个面板都常挂载、用 display 切换：保留各自状态（浏览历史/滚动位置/预览内容），
                    切 tab 不重新加载。 */}
                <div style={{ display: rightTab === 'files' ? 'block' : 'none', height: '100%' }}>
                  <WorkspacePanel
                    sessionId={draftActive ? null : selectedId}
                    workingDir={workingDir}
                    active={rightTab === 'files'}
                    onClose={() => setWorkspaceOpen(false)}
                    onPreviewFile={openPreview}
                    cloud={isCloud}
                    cloudWarmingUp={isCloud && cloud.warmingUp}
                  />
                </div>
                <div style={{ display: rightTab === 'preview' ? 'block' : 'none', height: '100%' }}>
                  {previewPath && (
                    <FilePreviewContent
                      sessionId={selectedId}
                      path={previewPath}
                      active={rightTab === 'preview'}
                      onNavigate={setPreviewPath}
                      onClose={() => { setPreviewPath(null); setRightTab('files') }}
                    />
                  )}
                </div>
                <div style={{ display: rightTab === 'web' ? 'block' : 'none', height: '100%' }}>
                  {/* 关网页 → 回到文件 tab，而不是关掉整个面板。 */}
                  <BrowserPanel url={browserUrl} onClose={() => setRightTab('files')} />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    {updateModal}
   </UpdateNagBoundary>
  )
}

/** 页眉那一行里所有项共用的盒子高度。见 BrandBlock 里的说明。 */
const ROW_H = 20

function BrandBlock({ agentActivity }: { agentActivity?: Record<string, number> }) {
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.electronAPI?.getVersion?.().then(setVersion).catch(() => {})
  }, [])

  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: '0 12px',
        height: '100%',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      {/* 这一行里每一项都用**同一个高度的盒子**（ROW_H）再各自内部居中。
          只写 align-items:center 是不够的：居中的是各自的盒子，而这里的盒子高矮差很多
          （13px 文字 / 14px 竖线 / 24px 按钮 / 带边框的 9px 徽章 / 11px 等宽数字），
          字形看起来就高高低低。等高之后各自的视觉中心才落在同一条线上。 */}
      <img src="/icon.svg" alt="" style={{ width: 20, height: ROW_H, flexShrink: 0 }} />
      <div className="flex items-center" style={{ gap: 3, height: ROW_H }}>
        {/* 品牌名按分隔符（连字符/空格）拆成多段，段间以 · 分隔——"IPMaster-Cowork"
            与 "NetLIVE Cowork" 都能得到原来的两段式排版；单段名则原样显示。 */}
        {brandParts.map((part, i) => (
          <span key={part} className="contents">
            {i > 0 && (
              <span style={{ fontSize: 13, fontWeight: 400, lineHeight: 1, color: 'var(--t3)', letterSpacing: '0.2px' }}>·</span>
            )}
            <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1, color: 'var(--t1)', letterSpacing: '0.2px' }}>{part}</span>
          </span>
        ))}
      </div>
      {/* 外壳名之后是当前 cowork：外壳是产品招牌（对外形象），cowork 是用户每时每刻
          需要知道的上下文，两者都值得占位，竖线分出「外壳 / 当前」的层级。 */}
      <span aria-hidden style={{ width: 1, height: 12, background: 'var(--border2)', margin: '0 3px', flexShrink: 0 }} />
      <AgentSwitcher activity={agentActivity} />
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 15,
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
        padding: '0 4px',
      }}>beta</span>
      {version && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: ROW_H,
          fontSize: 11,
          fontWeight: 400,
          lineHeight: 1,
          fontFamily: 'monospace',
          color: 'var(--t3)',
          // 等宽数字里 V 与数字的视觉重心偏低半格，抬一点点才与左边的文字齐。
          position: 'relative',
          top: -0.5,
        }}>V{version}</span>
      )}
    </div>
  )
}
