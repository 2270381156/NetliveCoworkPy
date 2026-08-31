import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon, FolderIcon, CloudIcon, FolderOpenIcon, FolderTreeIcon, ClockIcon, Wand2Icon, ZapIcon, ChevronRightIcon, ChevronDownIcon, PlusIcon, XIcon, SettingsIcon, GlobeIcon, DownloadIcon, LogOutIcon, PanelLeftCloseIcon, SearchIcon, HelpCircleIcon, PinIcon, PinOffIcon, ArchiveIcon, ArchiveRestoreIcon } from 'lucide-react'
import { sessionsApi } from '@/api/sessions'
import type { Session, PendingSession, AuthUser } from '@/types'
import { StatusBadge } from '@/components/ui/badge'
import { CloudBadge } from '@/components/ui/LocationBadge'
import { isCloudSession } from '@/api/backends'
import { Button } from '@/components/ui/button'
import { formatTime } from '@/lib/utils'
import { NewSessionDialog } from './NewSessionDialog'
import { useProjectGroups, sessionActivityTime, NO_PROJECT_ID, type Project } from '@/hooks/useProjectGroups'
import { useCurrentAgent } from '@/agents/useCurrentAgent'
import { canStartSession, isSessionReadOnly, useLineupState } from '@/agents/lineup'
import { agentOfSession } from '@/agents/registry'
import { useI18n, LANGUAGES, type Lang } from '@/i18n'
import type { CenterView } from '@/App'

interface Props {
  selectedId: string | null
  pendingSession: PendingSession | null
  centerView: CenterView
  onViewChange: (view: CenterView) => void
  onSelect: (id: string) => void
  onNewSession: (pending: PendingSession) => void
  onPendingSelect: () => void
  onDismissDraft: () => void
  user?: AuthUser | null            // 登录用户（浏览器调试下为 null）
  onLogout?: () => void             // 登出（Electron 下提供）
  onCollapse?: () => void           // 收起会话列表
}

// 置顶 / 归档：前端本地状态，按会话 id 存 localStorage。
function loadIdSet(key: string): Set<string> {
  try {
    const a = JSON.parse(localStorage.getItem(key) || '[]')
    return new Set(Array.isArray(a) ? a.filter((x: unknown): x is string => typeof x === 'string') : [])
  } catch { return new Set() }
}
function saveIdSet(key: string, s: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...s])) } catch { /* 配额满等，忽略 */ }
}
function toggleInSet(s: Set<string>, id: string): Set<string> {
  const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n
}

/** 带草稿的目录组：草稿不是 Session，单独挂一个字段，渲染时作为组内第一行。 */
type ProjectWithDraft = Project & { draft?: PendingSession }

export function SessionList({ selectedId, pendingSession, centerView, onViewChange, onSelect, onNewSession, onPendingSelect, onDismissDraft, user, onLogout, onCollapse }: Props) {
  const qc = useQueryClient()
  const { t, lang, setLang } = useI18n()
  const [showNew, setShowNew] = useState(false)
  const [createInitialWd, setCreateInitialWd] = useState<string>('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // 折叠状态：默认全展开；"未指定目录" 默认折叠
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set([NO_PROJECT_ID]))
  const [search, setSearch] = useState('')
  // 会话列表视图：'workspace' 按工作区分组（默认），'time' 全部平铺按最后活动时间倒序。
  const [groupMode, setGroupMode] = useState<'workspace' | 'time'>(
    () => (localStorage.getItem('ipmc.sessionGroupMode') === 'time' ? 'time' : 'workspace'),
  )
  useEffect(() => { localStorage.setItem('ipmc.sessionGroupMode', groupMode) }, [groupMode])
  // 置顶 / 归档（按会话 id，localStorage 持久化）
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadIdSet('ipmc.pinnedSessions'))
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => loadIdSet('ipmc.archivedSessions'))
  const [showArchived, setShowArchived] = useState(false)
  useEffect(() => { saveIdSet('ipmc.pinnedSessions', pinnedIds) }, [pinnedIds])
  useEffect(() => { saveIdSet('ipmc.archivedSessions', archivedIds) }, [archivedIds])
  const togglePin = (id: string) => setPinnedIds(prev => toggleInSet(prev, id))
  // 归档时顺带取消置顶（两者互斥）
  const toggleArchive = (id: string) => {
    setArchivedIds(prev => toggleInSet(prev, id))
    setPinnedIds(prev => (prev.has(id) ? toggleInSet(prev, id) : prev))
  }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<{ status: string; percent?: number; version?: string; message?: string } | null>(null)
  // Banner dismissed (× clicked) for current process only — resets on app restart.
  // Tracked by version so a *newer* downloaded update re-surfaces the banner.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)

  // Any update state worth surfacing outside the popup (drives the gear's blue dot).
  const hasActiveUpdate = update?.status === 'available' || update?.status === 'downloading' || update?.status === 'downloaded'
  // Downloaded + user hasn't dismissed *this* version's banner.
  const showUpdateBanner = update?.status === 'downloaded' && (update.version ?? '__downloaded__') !== dismissedVersion

  // 取应用版本号（Electron 下）
  useEffect(() => {
    window.electronAPI?.getVersion?.().then(setVersion).catch(() => {})
  }, [])

  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const off = window.electronAPI?.onUpdateStatus?.((p) => {
      setUpdate(p)
      // Auto-dismiss transient "up to date" / error states the moment they arrive,
      // independent of render timing.
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
      if (p.status === 'not-available' || p.status === 'error') {
        dismissTimer.current = setTimeout(() => setUpdate(null), 4000)
      }
    })
    return () => { off?.(); if (dismissTimer.current) clearTimeout(dismissTimer.current) }
  }, [])

  // 点设置区外面自动收起
  useEffect(() => {
    if (!settingsOpen) return
    function onClickOutside(e: MouseEvent) {
      const btn = settingsBtnRef.current
      if (!btn) return
      const target = e.target as Node
      // 点击按钮自身不关闭（让按钮自己 toggle）
      if (btn.contains(target)) return
      // 点击弹出菜单内部不关闭
      const menu = document.getElementById('settings-popup-menu')
      if (menu && menu.contains(target)) return
      setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [settingsOpen])

  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: sessionsApi.list,
    refetchInterval: 3000,
  })

  // 只看当前 agent 的会话：agent 是「用户此刻在哪个世界里」，切过去就该像换了个应用，
  // 而不是在一个混合列表里自己找。别的 agent 若有会话在跑，靠边缘抽屉上的活动提示告知。
  // 阵容为空（衍生品牌没配 agent）→ currentAgent 为 null → 不过滤，退回原来的单 agent 形态。
  const currentAgent = useCurrentAgent()
  // 没开通/没拉到时不让建：这里不拦的话，聊天区那边拦了也白拦——同一个动作两个入口。
  // 历史会话照常能看能开，禁的只是"新建"。
  const lineup = useLineupState()
  const canStart = canStartSession(lineup)

  // 权限被收回的 cowork 的会话 —— 一律收进「已归档」。
  //
  // **为什么不能让它们跟着当前 cowork 过滤走**：被收回的 cowork 没法成为当前 cowork（它不在
  // 阵容里，切换器也列不出它），于是它的会话永远够不着——比"打开就报错"更彻底的变相删除，
  // 而设计 §3 明确要求记录不能看起来像丢了。
  //
  // **推导，不写归档标记**：归档标记是用户自己的意思（localStorage 里那份），混进来就得在
  // 权限恢复时替他清掉，而"该清没清"是个静默故障。这里只是在**显示**上把它们算进归档区，
  // 套件装回来判据自动变假，会话自己回到主列表。
  const revokedIds = useMemo(
    () => new Set(sessions.filter(s => isSessionReadOnly(s, lineup)).map(s => s.id)),
    [sessions, lineup],
  )
  const agentSessions = useMemo(() => {
    const revoked = sessions.filter(s => revokedIds.has(s.id))
    const live = sessions.filter(s => !revokedIds.has(s.id))
    return [
      ...(currentAgent ? live.filter(s => agentOfSession(s)?.id === currentAgent.id) : live),
      ...revoked,
    ]
  }, [sessions, currentAgent, revokedIds])

  // 会话搜索：匹配 目标 / 首条消息 / 工作目录 / id。过滤后仍走原有的按目录分组渲染。
  const searchQuery = search.trim().toLowerCase()
  const filteredSessions = useMemo(() => {
    if (!searchQuery) return agentSessions
    return agentSessions.filter(s =>
      (s.goal || '').toLowerCase().includes(searchQuery)
      || (s.user_prompt || '').toLowerCase().includes(searchQuery)
      || (s.workspace || '').toLowerCase().includes(searchQuery)
      || (s.id || '').toLowerCase().includes(searchQuery),
    )
  }, [agentSessions, searchQuery])
  const byActivity = (a: Session, b: Session) =>
    sessionActivityTime(b).localeCompare(sessionActivityTime(a)) || a.id.localeCompare(b.id)
  // 归档的从主列表移除；置顶的单独提到顶部区，主列表/分组只含「非置顶且非归档」。
  // 「归档」= 用户自己归的 ∪ 权限被收回的（见 revokedIds）。
  const isArchived = useMemo(
    () => (s: Session) => archivedIds.has(s.id) || revokedIds.has(s.id),
    [archivedIds, revokedIds],
  )
  const pinnedList = useMemo(
    () => filteredSessions.filter(s => pinnedIds.has(s.id) && !isArchived(s)).sort(byActivity),
    [filteredSessions, pinnedIds, isArchived],
  )
  const archivedList = useMemo(
    () => filteredSessions.filter(isArchived).sort(byActivity),
    [filteredSessions, isArchived],
  )
  const normalSessions = useMemo(
    () => filteredSessions.filter(s => !pinnedIds.has(s.id) && !isArchived(s)),
    [filteredSessions, pinnedIds, isArchived],
  )
  // 两层：项目空间 → 会话。agent 不再是列表里的一层——列表本来就只显示当前 agent 的会话，
  // 再套一个「IPMaster Cowork」分组头是纯冗余；当前身份由列表顶部那一行常驻显示。
  const projects = useProjectGroups(normalSessions)
  // 草稿归到它所属的工作目录组里。
  //
  // 草稿条自带「文件夹图标 + 目录名」，顶在列表最上面时长得跟该目录的分组头一模一样——
  // 用户看到同一个目录列了两遍（一条是草稿、一条是真分组），以为多出来一个目录。它真正
  // 该在的位置是那个目录组内部的第一行。
  //
  // 目录还没有任何会话时（全新目录）合成一个只含草稿的组，这样两种情况的呈现一致；
  // 带草稿的组提到最前，因为用户刚选了它、下一步就要在里面发消息。
  const projectsWithDraft = useMemo<ProjectWithDraft[]>(() => {
    if (!pendingSession) return projects
    const id = pendingSession.workingDir || NO_PROJECT_ID
    const idx = projects.findIndex(pj => pj.id === id)
    if (idx >= 0) {
      const rest = projects.slice()
      const [hit] = rest.splice(idx, 1)
      return [{ ...hit, draft: pendingSession }, ...rest]
    }
    return [{
      id,
      display_name: pendingSession.workingDir.split(/[\/]/).filter(Boolean).pop()
        || pendingSession.workingDir || t('sidebar.noProject'),
      working_dir: pendingSession.workingDir,
      sessions: [],
      session_count: 0,
      last_accessed_at: '',
      draft: pendingSession,
    }, ...projects]
  }, [projects, pendingSession, t])
  // 平铺视图：忽略分组，全部按最后活动时间倒序（id 兜底，保证稳定）。
  const flatSessions = useMemo(() => [...normalSessions].sort(byActivity), [normalSessions])

  const deleteMut = useMutation({
    mutationFn: (id: string) => sessionsApi.delete(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      if (selectedId === id) onSelect('')
    },
  })

  function handleNewSession(pending: PendingSession) {
    setShowNew(false)
    setCreateInitialWd('')
    onNewSession(pending)
  }

  function openCreate(initialWd: string = '') {
    // 收在这一个口子上：新建会话有好几个入口（顶部按钮、项目分组里的"在此新建"），逐个
    // 记得加判断迟早漏一个，而漏掉的那个会建出一条不属于任何 cowork 的会话。
    if (!canStart) return
    setCreateInitialWd(initialWd)
    setShowNew(true)
  }

  function toggleProject(id: string) {
    setCollapsedProjects(prev => toggleInSet(prev, id))
  }

  return (
    <>
      <div className="flex h-full flex-col">
        {/* 固定头部：标题+收起、新建会话——列表滚动时它们不动 */}
        <div className="flex-shrink-0 pt-1">
          {/* Session list title + 收起按钮 */}
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-xs font-semibold" style={{ color: 'var(--t3)', letterSpacing: '1px', textTransform: 'uppercase' }}>{t('sidebar.sessions')}</span>
            <div className="flex items-center gap-1">
              {/* 视图切换：单按钮，图标=点击后将切到的视图，tooltip 说明。 */}
              <button
                title={groupMode === 'workspace' ? t('sidebar.flatByTime') : t('sidebar.groupByWorkspace')}
                aria-label={groupMode === 'workspace' ? t('sidebar.flatByTime') : t('sidebar.groupByWorkspace')}
                onClick={() => setGroupMode(m => (m === 'workspace' ? 'time' : 'workspace'))}
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
                style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
              >
                {groupMode === 'workspace' ? <ClockIcon size={14} /> : <FolderTreeIcon size={14} />}
              </button>
              {onCollapse && (
                <button
                  onClick={onCollapse}
                  title={t('sidebar.collapse')}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors"
                  style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
                >
                  <PanelLeftCloseIcon size={15} />
                </button>
              )}
            </div>
          </div>
          {/* New session button */}
          <div className="px-2 pb-1.5">
            <button
              data-tour="new-session"
              disabled={!canStart}
              title={canStart ? undefined : t('agent.lineupNone')}
              onClick={() => canStart && openCreate('')}
              style={{
                display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'center', gap: 6,
                height: 34, borderRadius: 'var(--r)',
                border: '1px solid var(--blue)', background: 'var(--blue-dim)', color: 'var(--blue)',
                fontSize: 13, fontWeight: 500, cursor: canStart ? 'pointer' : 'not-allowed',
                opacity: canStart ? 1 : 0.45,
                transition: 'background var(--tr), color var(--tr)',
              }}
              onMouseEnter={e => { if (canStart) { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--blue)'; el.style.color = '#fff' } }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--blue-dim)'; el.style.color = 'var(--blue)' }}
            >
              <PlusIcon size={14} strokeWidth={2.5} />
              {t('sidebar.newSession')}
            </button>
          </div>
          {/* 会话搜索 —— 定位父级只包 input（不含下方间距），图标/×才能相对 input 上下居中 */}
          <div className="px-2 pb-2">
            <div style={{ position: 'relative' }}>
              <SearchIcon size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--t3)', pointerEvents: 'none' }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('sidebar.searchPlaceholder')}
                spellCheck={false}
                style={{
                  width: '100%', height: 28, lineHeight: '28px', padding: '0 24px 0 26px',
                  borderRadius: 'var(--r)', border: '1px solid var(--border)',
                  background: 'var(--bg1)', color: 'var(--t1)', outline: 'none', fontSize: 12,
                }}
                onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
                onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  title={t('common.close')}
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: 'none', background: 'none', color: 'var(--t3)', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t1)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
                >
                  <XIcon size={12} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 可滚动的会话列表（只有这块滚，头部固定） */}
        <div data-tour="session-list" className="flex-1 overflow-y-auto pb-1">
          {/* 平铺视图没有分组可归，草稿留在最上面（它是最新的东西）；分组视图下它已经
              进了对应的目录组，见 projectsWithDraft。 */}
          {pendingSession && groupMode === 'time' && (
            <PendingSessionItem
              pending={pendingSession}
              selected={selectedId === null && centerView === 'chat'}
              onClick={onPendingSelect}
              onDismiss={onDismissDraft}
            />
          )}

          {filteredSessions.length === 0 && !pendingSession && (
            <p className="px-3 py-4 text-center text-xs" style={{ color: 'var(--t3)' }}>
              {searchQuery ? t('sidebar.noSearchResults') : t('sidebar.noSessions')}
            </p>
          )}

          {/* 置顶区（浮在最上，不受分组/视图影响） */}
          {pinnedList.length > 0 && (
            <div className="mb-1">
              <div className="flex items-center gap-1.5 px-3 py-1" style={{ color: 'var(--t3)' }}>
                <PinIcon size={10} />
                <span className="text-[10px] font-semibold uppercase" style={{ letterSpacing: '.5px' }}>{t('sidebar.pinned')}</span>
              </div>
              {pinnedList.map(s => (
                <SessionItem
                  key={s.id}
                  session={s}
                  selected={s.id === selectedId && centerView === 'chat'}
                  onSelect={() => onSelect(s.id)}
                  onDelete={() => setConfirmDelete(s.id)}
                  pinned
                  archived={false}
                  onTogglePin={() => togglePin(s.id)}
                  onToggleArchive={() => toggleArchive(s.id)}
                  showWorkspace={groupMode === 'time'}
                />
              ))}
            </div>
          )}

          {/* 主列表（排除置顶与归档） */}
          {groupMode === 'time'
            ? flatSessions.map(s => (
                <SessionItem
                  key={s.id}
                  session={s}
                  selected={s.id === selectedId && centerView === 'chat'}
                  onSelect={() => onSelect(s.id)}
                  onDelete={() => setConfirmDelete(s.id)}
                  pinned={false}
                  archived={false}
                  onTogglePin={() => togglePin(s.id)}
                  onToggleArchive={() => toggleArchive(s.id)}
                  showWorkspace
                />
              ))
            : projectsWithDraft.map(project => {
                // 搜索时强制展开所有分组，否则命中项若落在默认折叠的"未指定目录"里就看不到。
                const collapsed = searchQuery ? false : collapsedProjects.has(project.id)
                return (
                  <div key={project.id}>
                    <ProjectGroupHeader
                      project={project}
                      collapsed={collapsed}
                      onToggle={() => toggleProject(project.id)}
                      onCreateInProject={() => openCreate(project.working_dir)}
                    />
                    {!collapsed && project.draft && (
                      <DraftRow
                        selected={selectedId === null && centerView === 'chat'}
                        onClick={onPendingSelect}
                        onDismiss={onDismissDraft}
                      />
                    )}
                    {!collapsed && project.sessions.map(s => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        selected={s.id === selectedId && centerView === 'chat'}
                        onSelect={() => onSelect(s.id)}
                        onDelete={() => setConfirmDelete(s.id)}
                        pinned={false}
                        archived={false}
                        onTogglePin={() => togglePin(s.id)}
                        onToggleArchive={() => toggleArchive(s.id)}
                      />
                    ))}
                  </div>
                )
              })}

          {/* 已归档区（可折叠，默认收起） */}
          {archivedList.length > 0 && (
            <div className="mt-1">
              <button
                onClick={() => setShowArchived(v => !v)}
                className="flex w-full items-center gap-1 px-3 py-1.5"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
              >
                {showArchived ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
                <ArchiveIcon size={11} />
                <span className="text-[11px] font-medium">{t('sidebar.archived')}</span>
                <span className="text-[10px]" style={{ fontFamily: 'monospace', marginLeft: 'auto' }}>{archivedList.length}</span>
              </button>
              {showArchived && archivedList.map(s => (
                <SessionItem
                  key={s.id}
                  session={s}
                  selected={s.id === selectedId && centerView === 'chat'}
                  onSelect={() => onSelect(s.id)}
                  onDelete={() => setConfirmDelete(s.id)}
                  pinned={false}
                  archived
                  onTogglePin={() => togglePin(s.id)}
                  // 权限收回而进来的不给"取消归档"：按了也回不到主列表（判据是推导的），
                  // 一个按下去没反应的按钮比没有这个按钮更糟。
                  onToggleArchive={revokedIds.has(s.id) ? undefined : () => toggleArchive(s.id)}
                  showWorkspace={groupMode === 'time'}
                />
              ))}
            </div>
          )}
        </div>

        {/* Bottom: 设置 —— 无上边线，靠侧边栏 bg2 整体色块自身包裹感分隔 */}
        <div data-tour="user-menu" className="relative" style={{ padding: '4px' }}>
          {settingsOpen && (
            <div
              id="settings-popup-menu"
              style={{
                position: 'absolute', bottom: 'calc(100% + 2px)', left: 4, right: 4,
                background: 'var(--bg1)', border: '1px solid var(--border)',
                borderRadius: 'var(--r)', boxShadow: '0 8px 24px rgba(15,31,61,.12)',
                overflow: 'hidden', zIndex: 20,
              }}
            >
              <NavItem
                icon={<ZapIcon size={14} />}
                label={t('sidebar.skillMarket')}
                active={centerView === 'skills'}
                onClick={() => {
                  onViewChange(centerView === 'skills' ? 'chat' : 'skills')
                  setSettingsOpen(false)
                }}
              />
              <NavItem
                icon={<Wand2Icon size={14} />}
                label={t('sidebar.llmConfig')}
                active={centerView === 'llm'}
                onClick={() => {
                  onViewChange(centerView === 'llm' ? 'chat' : 'llm')
                  setSettingsOpen(false)
                }}
              />

              {/* 语言切换 */}
              <div style={{ borderTop: '1px solid var(--border)' }} />
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                  <GlobeIcon size={14} style={{ color: 'var(--t3)' }} />
                  <span style={{ fontSize: 13, color: 'var(--t2)' }}>{t('settings.language')}</span>
                </div>
                <div className="flex items-center gap-0.5" style={{ background: 'var(--bg3)', borderRadius: 6, padding: 2, flexShrink: 0 }}>
                  {LANGUAGES.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setLang(opt.value as Lang)}
                      style={{
                        // 字号 10 + 横边距 6：英文模式下选中项字重变粗、按钮组整体变宽，
                        // 11px/8px 时按钮组会宽到把左侧「Language」标签挤压换行。收窄后按钮组
                        // 占用变小，标签得以完整显示。nowrap + flexShrink:0 则保证按钮本身不换行。
                        fontSize: 10, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer',
                        whiteSpace: 'nowrap', flexShrink: 0,
                        background: lang === opt.value ? 'var(--bg1)' : 'transparent',
                        color: lang === opt.value ? 'var(--blue)' : 'var(--t3)',
                        fontWeight: lang === opt.value ? 600 : 400,
                        boxShadow: lang === opt.value ? '0 1px 2px rgba(15,31,61,.1)' : 'none',
                        transition: 'var(--tr)',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 版本号 */}
              <div className="flex items-center justify-between px-3 pb-1" style={{ fontSize: 11, color: 'var(--t3)' }}>
                <span>{t('settings.version')}</span>
                <span style={{ fontFamily: 'monospace' }}>{version ? `V${version}` : '—'}</span>
              </div>

              {/* 更新 */}
              {window.electronAPI?.checkForUpdates && (
                <div className="flex items-center justify-between px-3 pb-2" style={{ fontSize: 11 }}>
                  <span style={{ color: 'var(--t3)' }}>
                    {update?.status === 'checking' && t('update.checking')}
                    {update?.status === 'available' && `${t('update.available')} ${update.version ?? ''}`}
                    {update?.status === 'downloading' && `${t('update.downloading')} ${update.percent ?? 0}%`}
                    {update?.status === 'downloaded' && t('update.downloaded')}
                    {update?.status === 'not-available' && t('update.uptodate')}
                    {update?.status === 'error' && t('update.error')}
                    {!update && ' '}
                  </span>
                  {update?.status === 'downloaded' ? (
                    <button onClick={() => window.electronAPI?.installUpdate?.()}
                      style={{ flexShrink: 0, whiteSpace: 'nowrap', fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: 'var(--blue)', color: '#fff' }}>
                      {t('update.restart')}
                    </button>
                  ) : (
                    <button onClick={() => window.electronAPI?.checkForUpdates?.()}
                      style={{ flexShrink: 0, whiteSpace: 'nowrap', fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--bg3)', color: 'var(--t2)' }}>
                      {t('update.check')}
                    </button>
                  )}
                </div>
              )}

              {/* 登出（Electron 下显示） */}
              {user && onLogout && (
                <>
                  <div style={{ borderTop: '1px solid var(--border)' }} />
                  <NavItem
                    icon={<LogOutIcon size={14} />}
                    label={lang === 'en' ? 'Sign out' : '登出'}
                    active={false}
                    onClick={() => { setSettingsOpen(false); onLogout() }}
                  />
                </>
              )}
            </div>
          )}
          {/* Update-ready banner — visible above the settings button, dismissable
              for the current process (next launch re-surfaces if still downloaded). */}
          {showUpdateBanner && (
            <div
              style={{
                marginBottom: 4,
                padding: '8px 10px',
                background: 'var(--blue-dim)',
                border: '1px solid var(--blue)',
                borderRadius: 'var(--r)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                boxShadow: 'var(--shadow)',
              }}
            >
              <DownloadIcon size={14} style={{ color: 'var(--blue)', flexShrink: 0 }} />
              <span style={{ color: 'var(--t1)', flex: 1, lineHeight: 1.3, minWidth: 0 }}>
                {t('update.readyTitle')}{update?.version ? ` v${update.version}` : ''}
              </span>
              <button
                onClick={() => window.electronAPI?.installUpdate?.()}
                style={{
                  flexShrink: 0, fontSize: 11, padding: '3px 10px',
                  borderRadius: 4, border: 'none', cursor: 'pointer',
                  background: 'var(--blue)', color: '#fff', fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                {t('update.restart')}
              </button>
              <button
                onClick={() => setDismissedVersion(update?.version ?? '__downloaded__')}
                aria-label={t('update.dismiss')}
                title={t('update.dismiss')}
                style={{
                  flexShrink: 0, padding: 2, border: 'none', background: 'transparent',
                  cursor: 'pointer', color: 'var(--t3)', display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center', borderRadius: 4,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t1)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
              >
                <XIcon size={14} />
              </button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {user ? (
            // 用户区：首字母头像 + 完整用户名，点击弹出二级菜单（设置项 + 登出）
            <button
              ref={settingsBtnRef}
              onClick={() => setSettingsOpen(v => !v)}
              title={user.username}
              style={{
                display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', gap: 8,
                padding: '6px 8px',
                background: settingsOpen ? 'var(--blue-dim)' : 'transparent',
                border: 'none', cursor: 'pointer', borderRadius: 'var(--r)',
                transition: 'var(--tr)',
              }}
              onMouseEnter={e => { if (!settingsOpen) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
              onMouseLeave={e => { if (!settingsOpen) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                <span style={{
                  width: 26, height: 26, borderRadius: '50%',
                  background: 'var(--blue)', color: '#fff',
                  display: 'grid', placeItems: 'center',
                  fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                }}>{(user.username || '?').trim().charAt(0)}</span>
                {hasActiveUpdate && (
                  <span aria-hidden style={{
                    position: 'absolute', top: -2, right: -3, width: 6, height: 6,
                    borderRadius: '50%', background: 'var(--blue)', boxShadow: '0 0 0 1.5px var(--bg2)',
                  }} />
                )}
              </span>
              <span style={{
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap', textAlign: 'left', fontSize: 13, fontWeight: 500, color: 'var(--t1)',
              }}>{user.username}</span>
              <SettingsIcon size={13} style={{ flexShrink: 0, color: settingsOpen ? 'var(--blue)' : 'var(--t3)' }} />
            </button>
          ) : (
            // 无用户（纯浏览器调试）：保留原「设置」按钮
            <button
              ref={settingsBtnRef}
              onClick={() => setSettingsOpen(v => !v)}
              style={{
                display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', gap: 8,
                padding: '8px 10px', fontSize: 13, fontWeight: settingsOpen ? 600 : 500,
                color: settingsOpen ? 'var(--blue)' : 'var(--t2)',
                background: settingsOpen ? 'var(--blue-dim)' : 'transparent',
                border: 'none', cursor: 'pointer', borderRadius: 'var(--r)',
                transition: 'var(--tr)',
              }}
              onMouseEnter={e => { if (!settingsOpen) { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)'; (e.currentTarget as HTMLElement).style.color = 'var(--t1)' } }}
              onMouseLeave={e => { if (!settingsOpen) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--t2)' } }}
            >
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <SettingsIcon size={14} />
                {hasActiveUpdate && (
                  <span aria-hidden style={{
                    position: 'absolute', top: -2, right: -3, width: 6, height: 6,
                    borderRadius: '50%', background: 'var(--blue)', boxShadow: '0 0 0 1.5px var(--bg2)',
                  }} />
                )}
              </span>
              {t('sidebar.settings')}
            </button>
          )}
            {/* 显眼的「帮助 / 常见问题」入口：设置图标旁边，一键直达，hover 有原生提示。 */}
            <button
              title={t('sidebar.faq')}
              aria-label={t('sidebar.faq')}
              onClick={() => onViewChange(centerView === 'faq' ? 'chat' : 'faq')}
              style={{
                flexShrink: 0, width: 34, height: 34, display: 'grid', placeItems: 'center',
                borderRadius: 'var(--r)', border: 'none', cursor: 'pointer', transition: 'var(--tr)',
                background: centerView === 'faq' ? 'var(--blue-dim)' : 'transparent',
                color: centerView === 'faq' ? 'var(--blue)' : 'var(--t3)',
              }}
              onMouseEnter={e => { if (centerView !== 'faq') { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t1)' } }}
              onMouseLeave={e => { if (centerView !== 'faq') { const el = e.currentTarget as HTMLElement; el.style.background = 'transparent'; el.style.color = 'var(--t3)' } }}
            >
              <HelpCircleIcon size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.35)', backdropFilter: 'blur(4px)' }}>
          <div className="w-72 p-4" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 24px 80px rgba(15,31,61,.18)' }}>
            <p className="mb-4 text-sm" style={{ color: 'var(--t2)' }}>{t('sidebar.deleteSessionConfirm')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="sm" onClick={() => { deleteMut.mutate(confirmDelete); setConfirmDelete(null) }}>{t('common.delete')}</Button>
            </div>
          </div>
        </div>
      )}

      {/* 侧边栏建的会话也要归当前 cowork —— 不传 agent 的话后端拿默认模板（agent:default），
          该会话就被判成历史会话、认领给主 agent：在 CoreMaster 下建的会话会显示成 IPMaster。 */}
      <NewSessionDialog
        open={showNew}
        agent={currentAgent}
        initialWorkingDir={createInitialWd}
        recentSessions={sessions}
        onClose={() => { setShowNew(false); setCreateInitialWd('') }}
        onCreated={handleNewSession}
      />
    </>
  )
}

// ── ProjectGroupHeader ────────────────────────────────────────────────────────

function ProjectGroupHeader({ project, collapsed, onToggle, onCreateInProject }: {
  project: Project; collapsed: boolean; onToggle: () => void; onCreateInProject: () => void
}) {
  const { t } = useI18n()
  const isNoProject = project.id === NO_PROJECT_ID
  // 云端工作区用云图标标出来：同一份列表里本地与云端的文件夹混在一起，
  // 光看名字分不出这堆会话跑在哪边。
  const isCloud = !!project.is_cloud
  const Icon = isNoProject ? FolderIcon : (isCloud ? CloudIcon : FolderOpenIcon)
  const iconColor = isNoProject ? 'var(--t3)' : (isCloud ? 'var(--teal)' : '#eab308')
  const displayName = isNoProject ? t('sidebar.noProject') : project.display_name
  return (
    <div
      className="group flex cursor-pointer items-center gap-1"
      onClick={onToggle}
      style={{
        padding: '5px 9px', margin: '0 4px 1px',
        transition: 'var(--tr)',
      }}
      title={(isCloud ? t('workspace.cloudTitle') + ' · ' : '') + (project.working_dir || t('sidebar.noProject'))}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
    >
      {collapsed ? <ChevronRightIcon size={11} style={{ color: 'var(--t3)' }} /> : <ChevronDownIcon size={11} style={{ color: 'var(--t3)' }} />}
      <Icon size={11} style={{ color: iconColor }} />
      <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, fontWeight: 500, color: 'var(--t2)' }}>
        {displayName}
      </span>
      <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'monospace' }}>{project.session_count}</span>
      {!isNoProject && (
        <button
          onClick={e => { e.stopPropagation(); onCreateInProject() }}
          className="invisible group-hover:visible"
          title={t('sidebar.createInProject', { name: project.display_name })}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--t3)', padding: 0, display: 'grid', placeItems: 'center',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--blue)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
        >
          <PlusIcon size={11} />
        </button>
      )}
    </div>
  )
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', width: '100%', alignItems: 'center', gap: 8,
        padding: '7px 12px', fontSize: 13, fontWeight: active ? 600 : 400,
        color: active ? 'var(--blue)' : 'var(--t2)',
        background: active ? 'var(--blue-dim)' : 'transparent',
        border: 'none', cursor: 'pointer', transition: 'var(--tr)',
      }}
      onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)'; (e.currentTarget as HTMLElement).style.color = 'var(--t1)' } }}
      onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--t2)' } }}
    >
      {icon}
      {label}
    </button>
  )
}

/** 目录组内的草稿行。与 PendingSessionItem 的区别：不重复目录名——组头已经写了，
 *  再写一遍正是「同一个目录看着列了两遍」的由来。 */
function DraftRow({ selected, onClick, onDismiss }: {
  selected: boolean; onClick: () => void; onDismiss: () => void
}) {
  const { t } = useI18n()
  return (
    <div
      onClick={onClick}
      className="group"
      style={{
        cursor: 'pointer', padding: '5px 12px 5px 22px', transition: 'var(--tr)',
        background: selected ? 'var(--blue-dim)' : undefined,
        borderRadius: 'var(--r)', margin: '0 4px 2px',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <div className="flex items-center gap-1.5">
        <p className="min-w-0 flex-1 truncate text-sm" style={{ color: selected ? 'var(--blue)' : 'var(--t2)' }}>
          {t('sidebar.draftWaiting')}
        </p>
        <button
          onClick={e => { e.stopPropagation(); onDismiss() }}
          className="invisible flex-shrink-0 group-hover:visible"
          title={t('sidebar.dismissDraft')}
          style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
        >
          <XIcon size={11} />
        </button>
      </div>
    </div>
  )
}

function PendingSessionItem({ pending, selected, onClick, onDismiss }: { pending: PendingSession; selected: boolean; onClick: () => void; onDismiss: () => void }) {
  const { t } = useI18n()
  const dirName = pending.workingDir.split(/[\\/]/).filter(Boolean).pop() ?? pending.workingDir
  return (
    <div
      onClick={onClick}
      className="group"
      style={{
        cursor: 'pointer', padding: '6px 12px', transition: 'var(--tr)',
        background: selected ? 'var(--blue-dim)' : undefined,
        borderRadius: 'var(--r)', margin: '0 4px 2px',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <div className="flex items-center gap-1.5">
        <FolderIcon size={12} className="flex-shrink-0 text-yellow-500" />
        <p className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--t1)' }}>{dirName}</p>
        <button
          onClick={e => { e.stopPropagation(); onDismiss() }}
          className="invisible flex-shrink-0 group-hover:visible"
          title={t('sidebar.dismissDraft')}
          style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
        >
          <XIcon size={11} />
        </button>
      </div>
      <p className="mt-0.5 text-[10px]" style={{ color: 'var(--t3)' }}>{t('sidebar.draftWaiting')}</p>
    </div>
  )
}

function RowActionBtn({ title, onClick, hoverColor, children }: {
  title: string; onClick: () => void; hoverColor: string; children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = hoverColor }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
    >
      {children}
    </button>
  )
}

function SessionItem({ session, selected, onSelect, onDelete, onTogglePin, onToggleArchive, pinned, archived, showWorkspace }: {
  session: Session; selected: boolean; onSelect: () => void; onDelete: () => void
  onTogglePin?: () => void; onToggleArchive?: () => void; pinned?: boolean; archived?: boolean; showWorkspace?: boolean
}) {
  const { t } = useI18n()
  const title = session.goal || session.user_prompt || session.id.slice(0, 8)
  const isCloud = isCloudSession(session.id)
  // 云端也显示**真实文件夹名**：文件夹现在是用户自己命名的，一律显示「云端工作区」
  // 等于把这个信息抹掉了；云端身份由旁边的云图标表达。
  const wsName = session.workspace
    ? (session.workspace.split(/[\\/]/).filter(Boolean).pop() ?? session.workspace)
    : isCloud
      ? t('workspace.cloudTitle')
      : t('sidebar.noProject')
  return (
    <div
      onClick={onSelect}
      className="group relative cursor-pointer"
      style={{
        padding: '7px 9px', margin: '0 4px 2px', borderRadius: 'var(--r)',
        background: selected ? 'var(--bg3)' : undefined,
        border: selected ? '1px solid var(--border2)' : '1px solid transparent',
        transition: 'var(--tr)',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <div className="flex items-start gap-1.5">
        {pinned && <PinIcon size={11} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 3 }} />}
        <p className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--t1)', fontWeight: 500 }}>{title}</p>
        {/* hover 操作：置顶/取消、归档/取消、删除 */}
        <div className="invisible flex flex-shrink-0 items-center gap-1.5 group-hover:visible">
          {!archived && onTogglePin && (
            <RowActionBtn title={pinned ? t('sidebar.unpin') : t('sidebar.pin')} onClick={onTogglePin} hoverColor="var(--blue)">
              {pinned ? <PinOffIcon size={12} /> : <PinIcon size={12} />}
            </RowActionBtn>
          )}
          {onToggleArchive && (
            <RowActionBtn title={archived ? t('sidebar.unarchive') : t('sidebar.archive')} onClick={onToggleArchive} hoverColor="var(--blue)">
              {archived ? <ArchiveRestoreIcon size={12} /> : <ArchiveIcon size={12} />}
            </RowActionBtn>
          )}
          <RowActionBtn title={t('common.delete')} onClick={onDelete} hoverColor="var(--red)">
            <Trash2Icon size={12} />
          </RowActionBtn>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <StatusBadge status={session.status} />
        {/* 云端会话标识：本地不标（本地是常态），只把"跑在云上"点出来 */}
        {isCloud && <CloudBadge compact />}
        {/* 显示"最后活动时间"，与列表排序键保持一致，避免看着顺序乱 */}
        <span className="text-[10px]" style={{ color: 'var(--t3)' }}>{formatTime(sessionActivityTime(session))}</span>
      </div>
      {/* 平铺（按时间）视图下，标出会话所属工作区，便于分辨 */}
      {showWorkspace && (
        <p className="mt-0.5 flex items-center gap-1 truncate" style={{ color: 'var(--t3)', fontSize: 10 }} title={isCloud ? t('workspace.cloudTitle') : (session.workspace || t('sidebar.noProject'))}>
          {isCloud
            ? <CloudIcon size={9} style={{ flexShrink: 0, color: 'var(--teal)' }} />
            : <FolderIcon size={9} style={{ flexShrink: 0 }} />}
          <span className="truncate">{wsName}</span>
        </p>
      )}
    </div>
  )
}
