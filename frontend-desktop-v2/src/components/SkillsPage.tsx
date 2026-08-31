import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon, TagIcon, DownloadIcon, CheckCircle2Icon, SearchIcon, PackageIcon, ZapIcon, UploadIcon, ChevronLeftIcon } from 'lucide-react'
import { skillsApi } from '@/api/skills'
import type { LocalSkill, RemoteCatalogItem } from '@/api/skills'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useFirstVisitTour, skillsTourSteps } from '@/hooks/useOnboarding'

type Tab = 'local' | 'remote'

export function SkillsPage({ onClose }: { onClose?: () => void }) {
  const { t, lang } = useI18n()
  const [tab, setTab] = useState<Tab>('local')

  // 首次进入技能页跑一次引导
  useFirstVisitTour('skills', skillsTourSteps(lang))

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg0)' }}>
      {/* Header */}
      <div style={{ background: 'var(--bg1)', borderBottom: '1px solid var(--border)' }}>
        <div className="px-6 pt-5 pb-0">
          <div className="flex items-center gap-2 mb-4">
            {onClose && <CloseButton onClick={onClose} title={t('common.close')} />}
            <ZapIcon size={18} style={{ color: 'var(--blue)' }} />
            <h1 className="text-base font-semibold" style={{ color: 'var(--t1)' }}>Skills</h1>
          </div>
          {/* Tabs */}
          <div data-tour="skills-tabs" className="flex gap-0">
            <TabButton active={tab === 'local'} onClick={() => setTab('local')}>{t('skills.localTab')}</TabButton>
            <TabButton active={tab === 'remote'} onClick={() => setTab('remote')}>{t('skills.marketTab')}</TabButton>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'local' ? <LocalPanel /> : <RemotePanel />}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="relative px-1 pb-3 mr-6 text-sm font-medium transition-colors"
      style={{
        color: active ? 'var(--blue)' : 'var(--t3)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
      }}
    >
      {children}
    </button>
  )
}

// ── 本地 Skills ────────────────────────────────────────────────────────────

function LocalPanel() {
  const qc = useQueryClient()
  const { t } = useI18n()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  const { data: skills = [], isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: skillsApi.list,
  })

  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [highlightId, skills])

  const deleteMut = useMutation({
    mutationFn: (skillId: string) => skillsApi.delete(skillId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['skills'] }); setConfirmId(null) },
  })

  const importMut = useMutation({
    mutationFn: (file: File) => skillsApi.importLocal(file),
    onSuccess: (skill) => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      setImportError(null)
      setHighlightId(skill.skill_id)
      setTimeout(() => setHighlightId(null), 3000)
    },
    onError: (e: Error) => setImportError(e.message),
  })

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) importMut.mutate(file)
    e.target.value = ''
  }

  return (
    <>
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <span />
          <div data-tour="skills-import" className="flex flex-col items-end gap-1">
            <Button size="sm" style={{ width: 150 }} loading={importMut.isPending}
              onClick={() => { setImportError(null); fileInputRef.current?.click() }}>
              <UploadIcon size={13} />{t('skills.importZip')}
            </Button>
            {importError && (
              <p className="text-[11px]" style={{ color: 'var(--red)' }}>{importError}</p>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleFileChange} />
        </div>
        {isLoading ? (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
          </div>
        ) : skills.length === 0 ? (
          <EmptyState icon={<PackageIcon size={32} />} title={t('skills.emptyLocalTitle')} desc={t('skills.emptyLocalDesc')} />
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map(s => (
              <SkillCard key={s.skill_id} skill={s} highlighted={s.skill_id === highlightId}
                containerRef={s.skill_id === highlightId ? highlightRef : undefined}
                onDelete={() => setConfirmId(s.skill_id)} />
            ))}
          </div>
        )}
      </div>

      {confirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.4)', backdropFilter: 'blur(4px)' }}>
          <div className="w-80 p-5" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.2)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Trash2Icon size={15} style={{ color: 'var(--red)' }} />
              <p className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('skills.deleteTitle')}</p>
            </div>
            <p className="mt-2 mb-5 text-xs leading-relaxed" style={{ color: 'var(--t2)' }}>
              {t('skills.deleteConfirmPre')}<span className="font-mono font-semibold" style={{ color: 'var(--t1)' }}>{confirmId}</span>{t('skills.deleteConfirmPost')}<br />
              {t('skills.deleteConfirmNote')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmId(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="sm" loading={deleteMut.isPending}
                onClick={() => deleteMut.mutate(confirmId)}>{t('common.delete')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function SkillCard({ skill, highlighted = false, containerRef, onDelete }: {
  skill: LocalSkill; highlighted?: boolean; containerRef?: React.RefObject<HTMLDivElement | null>; onDelete: () => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(highlighted)

  return (
    <div
      ref={containerRef}
      className="rounded-xl"
      style={{
        border: `1px solid ${highlighted ? 'var(--blue)' : 'var(--border)'}`,
        background: highlighted ? 'var(--blue-dim)' : 'var(--bg1)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow)',
        transition: 'border-color .4s, background .4s',
      }}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
        style={{ userSelect: 'none' }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--blue-dim)' }}>
            <ZapIcon size={13} style={{ color: 'var(--blue)' }} />
          </div>
          <p className="truncate text-sm font-medium" style={{ color: 'var(--t1)' }}>{skill.name}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="rounded-full px-2 py-0.5 text-[10px] font-mono" style={{ background: 'var(--bg3)', color: 'var(--t2)' }}>
            v{skill.version}
          </span>
          <span style={{ color: 'var(--t3)', fontSize: 11 }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4" style={{ borderTop: '1px solid var(--border)' }}>
          {skill.description && (
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--t2)' }}>{skill.description}</p>
          )}
          {skill.triggers.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {skill.triggers.map(t => (
                <span key={t} className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'var(--blue-dim)', color: 'var(--blue)' }}>
                  <TagIcon size={9} />{t}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              onClick={e => { e.stopPropagation(); onDelete() }}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
              style={{ color: 'var(--t3)', background: 'none', border: '1px solid transparent', cursor: 'pointer' }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLElement
                el.style.color = 'var(--red)'
                el.style.background = 'rgba(220,38,38,.06)'
                el.style.borderColor = 'rgba(220,38,38,.2)'
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLElement
                el.style.color = 'var(--t3)'
                el.style.background = 'none'
                el.style.borderColor = 'transparent'
              }}
            >
              <Trash2Icon size={12} />{t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Skill 市场 ─────────────────────────────────────────────────────────────

function RemotePanel() {
  const qc = useQueryClient()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  // 当前登录用户名 —— mythos 市场的请求头要带它（cowork 不需要）。浏览器调试无
  // electron 时为空字符串，mythos 会降级、只显示 cowork。
  const { data: username = '' } = useQuery({
    queryKey: ['auth-session'],
    queryFn: async () => (await window.electronAPI?.getSession?.())?.username ?? '',
    staleTime: Infinity,
  })

  const { data: catalog = [], isLoading, isError, error } = useQuery({
    queryKey: ['skill-catalog', username],
    queryFn: () => skillsApi.catalog(username),
    retry: 1,
  })

  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [highlightId, catalog])

  // pull 失败信息，按 source:id 复合键定位到具体卡片（例如 mythos 某些 skill 内容为空）。
  const [pullError, setPullError] = useState<{ key: string; msg: string } | null>(null)

  const pullMut = useMutation({
    // 把整条 item（含 source）传给后端，由它派发到对应数据源的下载接口。
    mutationFn: (item: RemoteCatalogItem) => skillsApi.pull(item, username),
    onMutate: () => setPullError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      qc.invalidateQueries({ queryKey: ['skill-catalog'] })
    },
    onError: (e: Error, item) => setPullError({ key: `${item.source}:${item.id}`, msg: e.message }),
  })

  const importMut = useMutation({
    mutationFn: (file: File) => skillsApi.importRemote(file),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['skill-catalog'] })
      setImportError(null)
      // 上传只走 cowork，高亮键用 cowork:<id> 复合键对齐卡片。
      setHighlightId(`cowork:${result.skill_id}`)
      setTimeout(() => setHighlightId(null), 3000)
    },
    onError: (e: Error) => setImportError(e.message),
  })

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) importMut.mutate(file)
    e.target.value = ''
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return catalog
    const q = search.toLowerCase()
    return catalog.filter(item =>
      item.name.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
      item.updater?.toLowerCase().includes(q)
    )
  }, [catalog, search])

  return (
    <div className="p-5">
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-2 mb-4">
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" style={{ width: 150 }} loading={importMut.isPending}
            onClick={() => { setImportError(null); fileInputRef.current?.click() }}>
            <UploadIcon size={13} />{t('skills.uploadRemote')}
          </Button>
          {importError && (
            <p className="text-[11px]" style={{ color: 'var(--red)' }}>{importError}</p>
          )}
        </div>
        <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleFileChange} />
      </div>
      {/* Search bar */}
      {!isLoading && !isError && catalog.length > 0 && (
        <div className="relative mb-4">
          <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--t3)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('skills.searchPlaceholder')}
            className="w-full rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none transition-colors"
            style={{
              background: 'var(--bg1)',
              border: '1px solid var(--border)',
              color: 'var(--t1)',
            }}
            onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
            onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
          />
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => <SkeletonCard key={i} tall />)}
        </div>
      ) : isError ? (
        <EmptyState
          icon={<span style={{ fontSize: 32 }}>⚠️</span>}
          title={t('skills.fetchFailed')}
          desc={(error as Error)?.message ?? t('skills.fetchFailedDesc')}
          variant="error"
        />
      ) : catalog.length === 0 ? (
        <EmptyState icon={<PackageIcon size={32} />} title={t('skills.emptyRemoteTitle')} desc={t('skills.emptyRemoteDesc')} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<SearchIcon size={32} />} title={t('skills.noMatchTitle')} desc={t('skills.noMatchDesc', { q: search })} />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {filtered.map(item => {
            // 两个市场可能发出相同 id，用 source:id 作复合键，避免 React key 与
            // pulling/highlight 判断在跨源同 id 时串台。
            const key = `${item.source}:${item.id}`
            return (
              <CatalogCard
                key={key}
                item={item}
                highlighted={key === highlightId}
                containerRef={key === highlightId ? highlightRef : undefined}
                pulling={pullMut.isPending && pullMut.variables ? `${pullMut.variables.source}:${pullMut.variables.id}` === key : false}
                error={pullError?.key === key ? pullError.msg : undefined}
                onPull={() => pullMut.mutate(item)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function CatalogCard({ item, highlighted = false, containerRef, pulling, error, onPull }: {
  item: RemoteCatalogItem; highlighted?: boolean; containerRef?: React.RefObject<HTMLDivElement | null>; pulling: boolean; error?: string; onPull: () => void
}) {
  const { t } = useI18n()
  return (
    <div
      ref={containerRef}
      className="rounded-xl flex flex-col"
      style={{
        border: `1px solid ${highlighted ? 'var(--blue)' : 'var(--border)'}`,
        background: highlighted ? 'var(--blue-dim)' : 'var(--bg1)',
        boxShadow: 'var(--shadow)',
        overflow: 'hidden',
        transition: 'box-shadow var(--tr), border-color .4s, background .4s',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.boxShadow = 'var(--shadow2)'
        if (!highlighted) el.style.borderColor = 'var(--border2)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.boxShadow = 'var(--shadow)'
        el.style.borderColor = highlighted ? 'var(--blue)' : 'var(--border)'
      }}
    >
      {/* Card body */}
      <div className="flex-1 p-4">
        {/* Name */}
        <p className="truncate text-sm font-semibold leading-snug mb-1.5" style={{ color: 'var(--t1)' }}>{item.name}</p>

        {/* Description */}
        {item.description ? (
          <p className="text-xs leading-relaxed" style={{ color: 'var(--t2)', margin: 0, height: '4.875em', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.description}</p>
        ) : (
          <p className="text-xs italic" style={{ color: 'var(--t3)', margin: 0, height: '4.875em' }}>{t('skills.noDescription')}</p>
        )}
      </div>

      {/* Card footer */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg2)' }}>
        <div className="flex items-center justify-between">
          {item.create_time && (
            <span className="text-[10px]" style={{ color: 'var(--t3)' }}>
              {formatDate(item.create_time)}
            </span>
          )}
          <div className="ml-auto">
            {item.is_pulled ? (
              <span className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full" style={{ color: 'var(--green)', background: 'rgba(22,163,74,.08)' }}>
                <CheckCircle2Icon size={12} />{t('skills.installed')}
              </span>
            ) : (
              <Button size="sm" variant="default" loading={pulling} onClick={onPull}>
                <DownloadIcon size={11} />{t('skills.install')}
              </Button>
            )}
          </div>
        </div>
        {/* 安装失败提示（如 mythos 某些 skill 内容为空、无法下载）。 */}
        {error && (
          <p className="mt-2 text-[11px] leading-snug" style={{ color: 'var(--red)' }}>{error}</p>
        )}
      </div>
    </div>
  )
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function EmptyState({ icon, title, desc, variant = 'default' }: {
  icon: React.ReactNode
  title: string
  desc: string
  variant?: 'default' | 'error'
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <div style={{ color: variant === 'error' ? 'var(--red)' : 'var(--t3)', opacity: .6 }}>{icon}</div>
      <p className="text-sm font-medium" style={{ color: variant === 'error' ? 'var(--red)' : 'var(--t2)' }}>{title}</p>
      <p className="text-xs text-center max-w-xs" style={{ color: 'var(--t3)' }}>{desc}</p>
    </div>
  )
}

function CloseButton({ onClick, title }: { onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-7 h-7 flex items-center justify-center rounded-md transition-colors"
      style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t1)' }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
    >
      <ChevronLeftIcon size={18} />
    </button>
  )
}

function SkeletonCard({ tall = false }: { tall?: boolean }) {
  return (
    <div className="rounded-xl animate-pulse" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', height: tall ? 140 : 72 }} />
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}
