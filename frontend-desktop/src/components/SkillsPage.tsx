import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon, SearchIcon, PackageIcon, ZapIcon, ChevronLeftIcon, ArrowUpDownIcon, XIcon, UserIcon } from 'lucide-react'
import { skillsApi, ALL_COWORKS, isCommonSkill, catalogReferenceId } from '@/api/skills'
import type { LocalSkill, RemoteCatalogItem, SkillCoworks } from '@/api/skills'
import { useAgents } from '@/agents/useAgents'
import { Pager, SkillTile, TileGrid, paginate, useTileGrid, type TileItem } from '@/components/SkillTile'
import { SkillDetailDialog } from '@/components/SkillDetailDialog'
import type { AuthUser } from '@/types'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useFirstVisitTour, skillsTourSteps } from '@/hooks/useOnboarding'

/** 顶栏页签：本地 + 每个市场（通用 / 各 cowork）。
 *
 * 市场页签原先是"技能市场"里面的二级页签，现在提到同一层——这个页面的定位已经从"市场"变成
 * "用户所有 skill 相关东西的集中管理"，本地与各市场是**并列的三类**，不是主次。 */
type Tab = { kind: 'local' } | { kind: 'market'; cowork: string | null }

const sameTab = (a: Tab, b: Tab) =>
  a.kind === b.kind && (a.kind !== 'market' || b.kind !== 'market' || a.cowork === b.cowork)

// 这几个内置 skill（docx/pdf/pptx/skill-creator/skill-edit/xlsx）已作为「默认引用」随包
// 预置给所有用户，无需在市场里再让人手动引用，故在市场列表里对用户隐藏。仅前端过滤显示，
// 后端 catalog 照常返回、pull 接口照常可用（默认引用底层仍指向这些 cowork skill）。
const HIDDEN_MARKET_COWORK_IDS = new Set([
  '111bc4b63df1753ae49d6d46b906183e', // docx
  '2df175f505ff3ee595e5c84ecff0b52b', // pdf
  '578165d0805e0b73ae03fb7b24580ec5', // pptx
  'c88c65fd36a707e313e35879a24eca29', // skill-creator
  '07f37fb475c0e32266128991a91ec491', // skill-edit
  '00a6d3e3483f9644aab3a1d70394b902', // xlsx
])
const isHiddenMarketItem = (item: RemoteCatalogItem) =>
  item.source === 'cowork' && HIDDEN_MARKET_COWORK_IDS.has(item.id)

export function SkillsPage({ onClose, user }: { onClose?: () => void; user?: AuthUser | null }) {
  const { t, lang } = useI18n()
  const [tab, setTab] = useState<Tab>({ kind: 'local' })

  // 有哪几个市场页签由后端说了算（哪个 cowork 有自己的市场只有它知道）。没有市场的 cowork
  // 不开页签——开了也只有一句"它没有专属市场"，白占一格。
  const { data: markets = [] } = useQuery({
    queryKey: ['skill-markets'],
    queryFn: skillsApi.markets,
    staleTime: 5 * 60 * 1000,
  })

  // 首次进入 skill 页跑一次引导
  useFirstVisitTour('skills', skillsTourSteps(lang))

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg0)' }}>
      {/* Header */}
      <div style={{ background: 'var(--bg1)', borderBottom: '1px solid var(--border)' }}>
        <div className="px-6 pt-5 pb-0">
          <div className="flex items-center gap-2 mb-4">
            {onClose && <CloseButton onClick={onClose} title={t('common.close')} />}
            <ZapIcon size={18} style={{ color: 'var(--blue)' }} />
            <h1 className="text-base font-semibold" style={{ color: 'var(--t1)' }}>{t('skills.pageTitle')}</h1>
          </div>
          {/* Tabs：本地 + 通用 + 每个有市场的 cowork */}
          <div data-tour="skills-tabs" className="flex gap-0 flex-wrap">
            <TabButton active={tab.kind === 'local'} onClick={() => setTab({ kind: 'local' })}>
              {t('skills.localTab')}
            </TabButton>
            {markets.map(m => {
              const next: Tab = { kind: 'market', cowork: m.cowork ?? null }
              return (
                <TabButton key={m.cowork ?? '*'} active={sameTab(tab, next)} onClick={() => setTab(next)}>
                  {m.cowork === null ? t('skills.marketCommonTab') : m.display_name}
                </TabButton>
              )
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab.kind === 'local'
          ? <LocalPanel />
          : <MarketPanel key={tab.cowork ?? '*'} cowork={tab.cowork} username={user?.username ?? ''} />}
      </div>
    </div>
  )
}

/** 归属选择器：勾「通用」= 所有 cowork，或勾具体的若干个。
 *
 * **为什么是勾选清单而不是下拉**：归属是"这个 skill 属于谁"，是**多对一**的从属关系，一个
 * skill 可以同时归几个 cowork（引用库本来就存一组，见 reference_store）。下拉只能选一个，
 * 逼着用户为"给两个 cowork 用"导入两次。
 *
 * **通用与具体项互斥**：`["*"]` 已经涵盖所有 cowork，再叠一个具体的没有意义，还会让归属
 * 标签显示成"通用 / MBB"这种自相矛盾的样子。所以勾通用即清空其余，勾任一具体项即取消通用。
 * 一个都没勾 = 通用（与后端的缺省一致，见 local_ownership）。
 */
export function CoworkChooser({ value, onChange, disabled }: {
  value: SkillCoworks; onChange: (v: SkillCoworks) => void; disabled?: boolean
}) {
  const { t } = useI18n()
  const agents = useAgents()
  const common = isCommonSkill(value)

  function toggle(id: string) {
    const next = value.includes(id) ? value.filter(x => x !== id) : [...value.filter(x => x !== ALL_COWORKS), id]
    onChange(next.length ? next : [ALL_COWORKS])
  }

  const row = (checked: boolean, label: string, onClick: () => void, key: string) => (
    <label key={key}
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs"
      style={{ cursor: disabled ? 'default' : 'pointer', color: 'var(--t1)',
               background: checked ? 'var(--blue-dim)' : 'transparent' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onClick}
        style={{ accentColor: 'var(--blue)' }} />
      {label}
    </label>
  )

  return (
    <div className="flex flex-col gap-0.5">
      {row(common, t('skills.ownerCommon'), () => onChange([ALL_COWORKS]), '*')}
      <div style={{ height: 1, background: 'var(--border)', margin: '4px 8px' }} />
      {agents.map(a => row(value.includes(a.id), a.displayName, () => toggle(a.id), a.id))}
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
  const [confirmSkill, setConfirmSkill] = useState<{ id: string; name: string } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  const { data: all = [], isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: skillsApi.list,
  })
  // 「本地」页签只列**真正在本地存在**的（origin=local，磁盘上有文件）。
  //
  // 市场引来的那些（origin=cloud）本地并没有内容，只是一条"用时去市场下载"的记录——把它们
  // 混在这里，用户会以为自己有一份可以打开看的东西。它们在各自的市场页签里以「已引用」出现，
  // 取消引用也在那儿，与"从哪儿来的回哪儿去"一致。
  const allLocal = useMemo(() => all.filter(sk => sk.origin === 'local'), [all])

  // 搜索 + 分页。**先搜后分页**：只在当前页里搜的话，"明明有这个 skill 却搜不到"，而用户
  // 完全不知道是分页造成的。
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const skills = useMemo(
    () => !q ? allLocal : allLocal.filter(sk =>
      sk.name.toLowerCase().includes(q) || (sk.description || '').toLowerCase().includes(q)),
    [allLocal, q],
  )
  const [page, setPage] = usePage(q)
  // 每页装几张跟着列数走，见 useTileGrid —— 固定 12 张排不满整行，看起来像没加载完。
  const localGrid = useTileGrid()

  // 点开的那一条按 id 存，不存对象：改完归属之后列表会重新拉，存对象的话弹层里还是旧值。
  const [openedId, setOpenedId] = useState<string | null>(null)
  const opened = useMemo(() => skills.find(sk => sk.skill_id === openedId) ?? null, [skills, openedId])

  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [highlightId, skills])

  const deleteMut = useMutation({
    mutationFn: (skillId: string) => skillsApi.delete(skillId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['skills'] }); setConfirmSkill(null) },
  })

  // 发布：把某个本地 skill 直接上传到市场，按 skill_id 定位反馈到对应卡片。
  const [publishState, setPublishState] = useState<{ id: string; ok: boolean; msg: string } | null>(null)
  const publishMut = useMutation({
    mutationFn: (skillId: string) => skillsApi.publish(skillId),
    onMutate: () => setPublishState(null),
    onSuccess: (_r, skillId) => setPublishState({ id: skillId, ok: true, msg: t('skills.publishOk') }),
    onError: (e: Error, skillId) => {
      // 重名 → 友好提示；其它一律"上传失败"（真实原因记在后端日志，不抛给用户）。
      const code = (e as Error & { code?: string }).code
      const msg = code === 'SKILL_NAME_EXISTS' ? t('skills.publishNameExists') : t('skills.publishFail')
      setPublishState({ id: skillId, ok: false, msg })
    },
  })

  const agents = useAgents()   // 只用来算归属默认值（见 defaultCoworks）
  // 选完文件先攒着，弹框里问归属，确认了才真导。
  //
  // **归属必须问在导入动作里面**：它是"这个 skill 属于谁"的从属关系。放在列表上方当一个
  // 常驻控件，第一反应会被读成"按 agent 筛选列表"——位置决定了人怎么理解它，说明文字改不动
  // 这个第一反应。
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  // 只有一个 cowork 时默认就给它 —— 见 defaultCoworks。阵容是异步到达的，
  // 所以在打开导入弹窗那一刻再算，不能在这里定死。
  const [pendingCoworks, setPendingCoworks] = useState<SkillCoworks>([ALL_COWORKS])

  // 改归属：导入后反悔、或从市场引来之后想收窄。同步会把它带到云端，两边可见范围保持一致。
  const ownerMut = useMutation({
    mutationFn: ({ skillId, coworks }: { skillId: string; coworks: SkillCoworks }) =>
      skillsApi.setCoworks(skillId, coworks),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })

  const importMut = useMutation({
    mutationFn: ({ file, coworks }: { file: File; coworks: SkillCoworks }) =>
      skillsApi.importLocal(file, coworks),
    onSuccess: (skill) => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      setImportError(null)
      setPendingFile(null)
      setHighlightId(skill.skill_id)      // 导完滚到它、高亮一下：归属标签就在那张卡片上
      setTimeout(() => setHighlightId(null), 3000)
    },
    onError: (e: Error) => setImportError(e.message),
  })

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      // 单 agent 且它没有自己的市场：给谁用、传哪个市场都只有一个答案（通用），
      // 弹选择框纯属添堵 —— 直接按通用导入，跳过那一步。
      if (soleAgentNoMarket(agents)) {
        importMut.mutate({ file, coworks: [ALL_COWORKS] })
      } else {
        setPendingFile(file)
        setPendingCoworks(defaultCoworks(agents))
      }
    }
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
              {t('skills.importZip')}
            </Button>
            {/* 弹框开着时错误显示在框里，这里就不要再重一遍——同一句话在遮罩前后各出现一次，
                看起来像出了两个错。 */}
            {importError && !pendingFile && (
              <p className="text-[11px]" style={{ color: 'var(--red)' }}>{importError}</p>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleFileChange} />
        </div>
        {/* 搜索框：本地也会攒到几十条，没有它就只能靠滚。 */}
        {!isLoading && allLocal.length > 0 && (
          <div className="relative mb-4">
            <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--t3)' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('skills.searchPlaceholder')}
              className="w-full rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none transition-colors"
              style={{ background: 'var(--bg1)', border: '1px solid var(--border)', color: 'var(--t1)' }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
              onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
            />
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
          </div>
        ) : allLocal.length === 0 ? (
          <EmptyState icon={<PackageIcon size={32} />} title={t('skills.emptyLocalTitle')} desc={t('skills.emptyLocalDesc')} />
        ) : skills.length === 0 ? (
          <EmptyState icon={<SearchIcon size={32} />} title={t('skills.noMatchTitle')} desc={t('skills.noMatchDesc', { q: search })} />
        ) : (
          // 与市场页签同一种卡片、同一套网格。之前这里是通栏长条、那边是双列方卡，切个页签
          // 就像换了个产品。
          (() => {
            const pg = paginate(skills, page, localGrid.pageSize)
            return (
              <>
                <TileGrid gridRef={localGrid.ref}>
                  {/* 不写来路：这一页里每一条都是本地导入的，每张卡片再标一遍是纯噪声。 */}
                  {pg.slice.map(sk => (
                    <SkillTile key={sk.skill_id} item={tileFromLocal(sk, t, { showFrom: false })}
                      onOpen={() => setOpenedId(sk.skill_id)} />
                  ))}
                </TileGrid>
                <Pager page={pg.page} pages={pg.pages} onChange={setPage} />
              </>
            )
          })()
        )}
      </div>

      {opened && (
        <SkillDetailDialog
          item={tileFromLocal(opened, t)}
          onClose={() => setOpenedId(null)}
          onDelete={() => { setConfirmSkill({ id: opened.skill_id, name: opened.name }); setOpenedId(null) }}
          onPublish={opened.origin === 'local' ? () => publishMut.mutate(opened.skill_id) : undefined}
          publishing={publishMut.isPending}
          publishStatus={publishState?.id === opened.skill_id ? publishState : undefined}
          onCoworksChange={soleAgentNoMarket(agents)
            ? undefined
            : coworks => ownerMut.mutate({ skillId: opened.skill_id, coworks })}
          coworksSaving={ownerMut.isPending}
        />
      )}

      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.4)', backdropFilter: 'blur(4px)' }}>
          <div className="w-96 p-5" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.2)' }}>
            <div className="flex items-center gap-2 mb-1">
              <PackageIcon size={15} style={{ color: 'var(--blue)' }} />
              <p className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('skills.importTitle')}</p>
            </div>
            <p className="mt-2 text-xs truncate" style={{ color: 'var(--t2)' }}>{pendingFile.name}</p>

            <p className="mt-4 mb-1 text-xs font-medium" style={{ color: 'var(--t1)' }}>{t('skills.importOwnerLabel')}</p>
            <p className="mb-2 text-[11px] leading-relaxed" style={{ color: 'var(--t3)' }}>{t('skills.ownerHint')}</p>
            <div className="max-h-56 overflow-y-auto rounded-xl p-1" style={{ border: '1px solid var(--border)' }}>
              <CoworkChooser value={pendingCoworks} onChange={setPendingCoworks} disabled={importMut.isPending} />
            </div>

            {importError && <p className="mt-2 text-[11px]" style={{ color: 'var(--red)' }}>{importError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={importMut.isPending}
                onClick={() => { setPendingFile(null); setImportError(null) }}>{t('common.cancel')}</Button>
              <Button size="sm" loading={importMut.isPending}
                onClick={() => importMut.mutate({ file: pendingFile, coworks: pendingCoworks })}>
                {t('skills.importConfirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmSkill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.4)', backdropFilter: 'blur(4px)' }}>
          <div className="w-80 p-5" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.2)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Trash2Icon size={15} style={{ color: 'var(--red)' }} />
              <p className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('skills.deleteTitle')}</p>
            </div>
            <p className="mt-2 mb-5 text-xs leading-relaxed" style={{ color: 'var(--t2)' }}>
              {t('skills.deleteConfirmPre')}<span className="font-semibold" style={{ color: 'var(--t1)' }}>{confirmSkill.name}</span>{t('skills.deleteConfirmPost')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmSkill(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="sm" loading={deleteMut.isPending}
                onClick={() => deleteMut.mutate(confirmSkill.id)}>{t('common.delete')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
function MarketPanel({ cowork, username }: { cowork: string | null; username: string }) {
  const qc = useQueryClient()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const market = cowork
  // 市场显示名：卡片上要写清"这条来自哪个市场"，否则同一块里混着几个来路看不出区别。
  const { data: markets = [] } = useQuery({
    queryKey: ['skill-markets'], queryFn: skillsApi.markets, staleTime: 5 * 60 * 1000,
  })

  const { data: catalog = [], isLoading, isError, error } = useQuery({
    queryKey: ['skill-catalog', username, market],
    queryFn: () => skillsApi.catalog(username, market),
    retry: 1,
  })

  // 本地那份也要：cowork 页签里第一组是"归属这个 cowork 的本地 skill"，第三组是"通用的"。
  // 两者都不在市场目录里——目录只知道市场上有什么，不知道用户本地有什么。
  const { data: mine = [] } = useQuery({ queryKey: ['skills'], queryFn: skillsApi.list })

  // 取消引用。删的是"引用记录"，不是市场上的那份东西——所以两个列表都要刷新：
  // 本地清单少一条，市场目录里那条的 is_pulled 变回 false。
  // 参数是**引用键**（`<source>:<remote_id>`），不是市场目录里的条目。
  //
  // 原先要求先在当前页签的目录里找到那一条才给取消——于是"从别的市场引来的"就取消不了：
  // 通用市场引来的那批在 MBB 页签里同样列着（它们对 MBB 也可用），但 MBB 的目录里没有它们。
  // 表现就是"有些点开能取消、有些不能"，而且看不出规律。
  // 取消引用删的是本地那条记录，跟目录没关系，键够了。
  const unpullMut = useMutation({
    mutationFn: (key: string) => skillsApi.delete(key),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      qc.invalidateQueries({ queryKey: ['skill-catalog'] })
    },
  })

  // 改归属。**市场页签里也要能改** —— 用户在哪个页签点开这条 skill 是偶然的，
  // 归属却是这条 skill 的固有属性；只在「本地」页签给编辑框，等于逼他先去另一个页签找一遍。
  //
  // ⚠ 只对**已经存在的**记录开放（本地导入的、已引用的）。市场里还没引用的那些，
  // 后端 set_labels 找不到记录会直接 no-op —— 给了编辑框却存不进去，是静默失败。
  const ownerMut = useMutation({
    mutationFn: ({ key, coworks }: { key: string; coworks: SkillCoworks }) =>
      skillsApi.setCoworks(key, coworks),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      qc.invalidateQueries({ queryKey: ['skill-catalog'] })
    },
  })

  // pull 失败信息，按 source:id 复合键定位到具体卡片（例如 mythos 某些 skill 内容为空）。
  const [pullError, setPullError] = useState<{ key: string; msg: string } | null>(null)

  const pullMut = useMutation({
    // 把整条 item（含 source）传给后端，由它派发到对应数据源的下载接口。
    // 归属跟着页签走：从某个 cowork 的市场引来的只给那个 cowork，通用页签引来的都能用。
    mutationFn: (item: RemoteCatalogItem) => skillsApi.pull(item, username, market),
    onMutate: () => setPullError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      qc.invalidateQueries({ queryKey: ['skill-catalog'] })
    },
    onError: (e: Error, item) => setPullError({ key: `${item.source}:${item.id}`, msg: e.message }),
  })

  // 默认隐藏随包默认 skill（docx/pdf/... 已预置为默认引用）；但用户一旦在搜索框输入，
  // 就在全量（含隐藏项）里搜，让他仍能搜到并引用。仅前端显示逻辑，后端 catalog 不变。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return catalog.filter(item => !isHiddenMarketItem(item))   // 不搜索：隐藏默认项
    return catalog.filter(item =>                                       // 搜索：全量里搜（含隐藏项）
      item.name.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
      item.updater?.toLowerCase().includes(q)
    )
  }, [catalog, search])

  // ── 两块：能用的 / 能加的 ──────────────────────────────────────────────────
  const q = search.trim().toLowerCase()
  const matches = (name: string, desc?: string | null) =>
    !q || name.toLowerCase().includes(q) || (desc || '').toLowerCase().includes(q)
  // 卡片副标题里的「来路」。**"市场"两个字只在这儿出现**——页签是按"归谁"命名的（本地 /
  // 通用 / MBB Cowork），归属标签也是；只有这一处真的在说"从哪个市场来的"。
  // 通用页签留空 —— 见 tileFromCatalog 里 from 那行的说明。
  const marketName = cowork
    ? t('skills.marketOfCowork').replace('{name}',
        markets.find(m => m.cowork === cowork)?.display_name ?? cowork)
    : ''

  /** 当前技能 —— 两个子簇，按**它是怎么来的**分：本机的文件 / 市场里引的。
   *
   * 上一版把它们混成一块，是因为"来路是次要信息"；但两者能做的事其实不同（本地的能删、能
   * 传回市场、能改归属；引用的只能取消引用），混在一起点开才知道是哪种。分两簇是**同一块
   * 里的两组**，不是两块——标题仍然只有「当前技能」一个。
   */
  const usableLocal: TileItem[] = useMemo(() => {
    // 通用页签**不列本地导入**的 skill：这里只呈现"已引用"和"市场里的东西"。
    // 本地导入的统一去「本地」页签管理，避免同一条在两处都出现、也让通用页签更贴合"市场"。
    // （cowork 页签仍列归属它的本地 skill + 通用的——那些它确实用得上。）
    if (cowork === null) return []
    const out: TileItem[] = []
    for (const sk of mine) {
      if (sk.origin !== 'local') continue
      const ownedHere = sk.coworks.includes(cowork)
      // cowork 页签看"归属它的"+"通用的"——后者它同样用得上。
      if (!(isCommonSkill(sk.coworks) || ownedHere)) continue
      if (!matches(sk.name, sk.description)) continue
      out.push(tileFromLocal(sk, t, { showFrom: false }))
    }
    return out
  }, [mine, cowork, q])

  const usableRefs: TileItem[] = useMemo(() => {
    // 引用库只存名字和描述，**没有作者/发布时间/下载量**——那些只在市场目录里。所以这里按
    // 引用身份去目录里配一份补上。
    //
    // 用后端的 reference_id 而不是名字配对：已引用记录的 skill_id 就是这个确定性 ID，
    // 与目录条目的 reference_id 同源，能精确对上。按名字配会在两个市场有同名 skill 时配错人
    // ——那时卡片上会显示另一个市场的作者和下载量，而且没有任何地方露馅。
    const inMarket = new Map(catalog.map(i => [keyOf(i), i]))
    const out: TileItem[] = []
    for (const sk of mine) {
      if (sk.origin !== 'cloud') continue
      const ownedHere = cowork ? sk.coworks.includes(cowork) : false
      if (!(isCommonSkill(sk.coworks) || ownedHere)) continue
      if (!matches(sk.name, sk.description)) continue
      const hit = inMarket.get(sk.skill_id)
      out.push({
        ...tileFromLocal(sk, t, { showFrom: false }),
        // 配不上就只有本地那点信息——比如它引自**另一个**市场（当前页签的目录里当然没有）。
        // 那几格就不显示，而不是显示空的"作者："。
        author: hit?.updater || undefined,
        createdAt: hit?.create_time || undefined,
        downloads: hit?.download_count ?? undefined,
      })
    }
    for (const item of filtered) {
      if (!item.is_pulled) continue
      if (out.some(x => x.key === keyOf(item))) continue
      // 归属只有本地那份记录知道，目录里没有——按 key 去 mine 里取。
      const local = mine.find(sk => sk.skill_id === keyOf(item))
      out.push(tileFromCatalog(item, marketName, true, local?.coworks))
    }
    return out
  }, [mine, filtered, catalog, cowork, q, marketName])

  const usable = useMemo(() => [...usableLocal, ...usableRefs], [usableLocal, usableRefs])

  // 三块各自翻各自的页：它们长短差很多，共用一个页码会让翻到第 2 页时另外两块莫名变空。
  const [pgLocal, setPgLocal] = usePage(q)
  const [pgRefs, setPgRefs] = usePage(q)
  const [pgAdd, setPgAdd] = usePage(q)
  const addGrid = useTileGrid()

  // 市场里动辄几十条，光靠搜索框得先知道自己要找什么。
  //
  // 排序与作者只作用在下面「技能市场」那一组（还没引的）：上面已安装的那组是"我的东西"，
  // 被作者筛掉反而让人以为丢了。控件就挂在那一组的标题行上，作用域一目了然。
  const [sortBy, setSortBy] = useState<'default' | 'downloads'>('default')
  const [author, setAuthor] = useState('')

  /** 市场组里出现过的作者（去重）—— 筛选框的选项。 */
  const authors = useMemo(() => {
    const seen = new Set<string>()
    for (const i of catalog) if (!i.is_pulled && i.updater) seen.add(i.updater)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [catalog])

  // 各 cowork 自带的市场未必回下载量 / 上传时间（字段可能整列缺失）。
  // **数据里没有的排序就别提供** —— 摆一个永远排不动的"下载量"按钮只会让人以为坏了。
  const hasDownloads = useMemo(
    () => catalog.some(i => !i.is_pulled && i.download_count != null),
    [catalog],
  )
  const hasCreateTime = useMemo(
    () => catalog.some(i => !i.is_pulled && !!i.create_time),
    [catalog],
  )

  /** 能加的：这个市场里还没引的。 */
  const addable: TileItem[] = useMemo(() => {
    let list = filtered.filter(i => !i.is_pulled)
    // 模糊匹配：输入框允许打片段（datalist 只是建议），精确相等会让打一半的输入筛不出东西。
    if (author.trim()) {
      const a = author.trim().toLowerCase()
      list = list.filter(i => (i.updater || '').toLowerCase().includes(a))
    }
    if (sortBy === 'downloads') list = [...list].sort(byDownloadsDesc)
    return list.map(i => tileFromCatalog(i, marketName, false))
  }, [filtered, marketName, author, sortBy])
  // 换了排序/作者却停在第 3 页，看到的是一片空白。
  useEffect(() => { setPgAdd(1) }, [sortBy, author, setPgAdd])
  // 这个市场没有下载量却停在"按下载量"（上个市场切过来的残留）→ 复位，否则按不存在的字段排。
  useEffect(() => { if (!hasDownloads && sortBy === 'downloads') setSortBy('default') }, [hasDownloads, sortBy])

  const nothingAtAll = usable.length === 0 && addable.length === 0 && catalog.length === 0

  // 点开的那一条。市场项与本地项都能点开，详情层按 kind 决定给哪些操作。
  // 点开的那一条。**只存 key，条目每次从活列表里现取。**
  //
  // 原先直接把整个 TileItem 存进 useState —— 那是一份快照。改完归属之后列表重新拉了，
  // 弹窗里那份还停在改动之前：勾选框纹丝不动，而后端其实已经写进去了。用户看到的是
  // 「勾不上，但它默默跑到那个 agent 下面去了」。「本地」页签一直是按 id 现取的,
  // 所以那边从来没有这个毛病。
  const [openedKey, setOpenedKey] = useState<string | null>(null)
  // ⚠ **从未过滤的源里取**，不能用 usable/addable —— 那两个是按当前页签筛过的。
  //
  // 在通用页签把一条 skill 勾给某个 cowork：保存 → 列表刷新 → 这条不再满足
  // "通用页签只看通用的"这个条件 → 它从 usable 里消失 → opened 变 null →
  // 勾选框弹回去。用户看到的是"勾不上，可它确实跑到那个 agent 页签里去了"。
  //
  // 归属是这条 skill 的固有属性，跟"我此刻站在哪个页签"无关；弹窗要一直看得见它。
  const openedPool = useMemo(
    () => [
      ...mine.map(sk => tileFromLocal(sk, t, { showFrom: false })),
      ...catalog.map(i => tileFromCatalog(i, marketName, i.is_pulled)),
    ],
    [mine, catalog, marketName, t],
  )
  const opened = useMemo(
    () => openedPool.find(i => i.key === openedKey) ?? null,
    [openedPool, openedKey],
  )
  // 添加**必须**在目录里找到条目：要把 source 和名字传给后端去下载。取消则不用（见上）。
  const byKey = (k: string) => catalog.find(i => keyOf(i) === k)
  const agents = useAgents()
  // 引用之前先定归属。
  //
  // 原先归属**固定跟着页签走**（通用页签 → 通用，cowork 页签 → 那个 cowork），
  // 用户在通用页签里想引给某一个 agent 是做不到的。
  //
  // ⚠ **只有一个 cowork 时不问** —— 那时"选给谁"只有一个答案，弹一个只有一项的
  // 选择框纯属添堵。这条同样适用于本地导入那边（见 defaultCoworks）。
  const [pendingPull, setPendingPull] = useState<RemoteCatalogItem | null>(null)
  const [pullCoworks, setPullCoworks] = useState<SkillCoworks>([ALL_COWORKS])

  const addByKey = (k: string) => {
    const it = byKey(k)
    if (!it) return
    if (agents.length <= 1 || cowork) {
      // 只有一个 cowork，或本来就站在某个 cowork 的页签里 —— 答案唯一，直接拉。
      pullMut.mutate(it)
      return
    }
    setPullCoworks(defaultCoworks(agents))
    setPendingPull(it)
  }

  return (
    <div className="p-5">
      {/* Search bar */}
      {!isLoading && !isError && (catalog.length > 0 || mine.length > 0) && (
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
      ) : nothingAtAll ? (
        <EmptyState icon={<PackageIcon size={32} />} title={t('skills.emptyRemoteTitle')} desc={t('skills.emptyRemoteDesc')} />
      ) : usable.length === 0 && addable.length === 0 ? (
        <EmptyState icon={<SearchIcon size={32} />} title={t('skills.noMatchTitle')} desc={t('skills.noMatchDesc', { q: search })} />
      ) : (
        <div className="flex flex-col gap-6">
          <SkillSection title={t('skills.groupUsable')} count={usable.length}>
            <div className="flex flex-col gap-4">
              <PagedTiles items={usableLocal} page={pgLocal} onPage={setPgLocal}
                label={t('skills.clusterLocal')} onOpen={it => setOpenedKey(it.key)} />
              <PagedTiles items={usableRefs} page={pgRefs} onPage={setPgRefs}
                label={t('skills.clusterReferenced')} onOpen={it => setOpenedKey(it.key)} />
            </div>
          </SkillSection>

          {/* 标题不再带市场名：页签本身已经写着是哪个市场了，标题里再写一遍是重复。
              市场名改放在每张卡片的副标题上——那里才需要区分，因为「当前技能」那一块里
              混着好几个来路。 */}
          <SkillSection title={t('skills.groupAddable')} count={addable.length}
            extra={(hasDownloads || authors.length > 0) && (
              <div className="flex items-center gap-2.5">
                {/* 排序：图标 + 排序二字点题。**只有市场真回了下载量才出现** —— 没有下载量时
                    唯一"排序"就是列表自带的次序（后端按上传时间倒序），没有可切的第二种，不摆控件。
                    基准项：有上传时间叫"最新"（名副其实），没有就老老实实叫"默认"。 */}
                {hasDownloads && (
                  <div className="flex items-center gap-1.5">
                    <ArrowUpDownIcon size={13} style={{ color: 'var(--t3)' }} />
                    <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--t3)' }}>{t('skills.sortLabel')}</span>
                    <Segmented
                      value={sortBy} onChange={v => setSortBy(v as 'default' | 'downloads')}
                      options={[
                        { value: 'default', label: hasCreateTime ? t('skills.sortLatest') : t('skills.sortDefault') },
                        { value: 'downloads', label: t('skills.sortDownloads') },
                      ]} />
                  </div>
                )}
                {/* 作者：**纯筛选输入框，不带下拉**。
                    上一版用了 datalist，Chromium 会在右侧画个又粗又丑的下拉三角，还跟 × 打架；
                    而且作者动辄几十上百，弹一整列作者当建议毫无意义。这里就是打字即过滤，
                    左侧一个作者图标点题，右侧 × 清空。 */}
                {authors.length > 0 && (
                  <div className="relative flex items-center">
                    <UserIcon size={12} className="absolute left-2 pointer-events-none" style={{ color: 'var(--t3)' }} />
                    <input
                      value={author}
                      onChange={e => setAuthor(e.target.value)}
                      placeholder={t('skills.authorFilter')}
                      className="rounded-lg pl-6 pr-6 py-1 text-[11px] outline-none transition-colors"
                      style={{
                        width: 140, background: 'var(--bg1)',
                        border: `1px solid ${author ? 'var(--blue)' : 'var(--border)'}`,
                        color: author ? 'var(--blue)' : 'var(--t1)',
                      }}
                      onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
                      onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = author ? 'var(--blue)' : 'var(--border)' }} />
                    {author && (
                      <button
                        onClick={() => setAuthor('')}
                        title={t('skills.authorAll')}
                        className="absolute right-1.5 flex items-center justify-center rounded transition-colors"
                        style={{ width: 15, height: 15, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t1)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}>
                        <XIcon size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}>
            {(() => {
              const pg = paginate(addable, pgAdd, addGrid.pageSize)
              return (
                <>
                  <TileGrid gridRef={addGrid.ref}>
                    {pg.slice.map(it => (
                      <SkillTile key={it.key} item={it}
                        onOpen={() => setOpenedKey(it.key)}
                        onAdd={() => addByKey(it.key)}
                        adding={pullMut.isPending && keyOf(pullMut.variables) === it.key}
                        error={pullError?.key === it.key ? pullError.msg : undefined} />
                    ))}
                  </TileGrid>
                  <Pager page={pg.page} pages={pg.pages} onChange={setPgAdd} />
                </>
              )
            })()}
          </SkillSection>
        </div>
      )}

      {pendingPull && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.4)', backdropFilter: 'blur(4px)' }}>
          <div className="w-96 p-5" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.2)' }}>
            <div className="flex items-center gap-2 mb-1">
              <PackageIcon size={15} style={{ color: 'var(--blue)' }} />
              <p className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('skills.importOwnerLabel')}</p>
            </div>
            <p className="mt-2 text-xs truncate" style={{ color: 'var(--t2)' }}>{pendingPull.name}</p>
            <p className="mb-2 mt-4 text-[11px] leading-relaxed" style={{ color: 'var(--t3)' }}>{t('skills.ownerHint')}</p>
            <div className="max-h-56 overflow-y-auto rounded-xl p-1" style={{ border: '1px solid var(--border)' }}>
              <CoworkChooser value={pullCoworks} onChange={setPullCoworks} disabled={pullMut.isPending} />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={pullMut.isPending}
                onClick={() => setPendingPull(null)}>{t('common.cancel')}</Button>
              <Button size="sm" loading={pullMut.isPending}
                onClick={() => {
                  const it = pendingPull
                  const labels = pullCoworks
                  setPendingPull(null)
                  // pull 接口只接受单个 cowork（归属跟页签走那套留下的形状），
                  // 所以先按"通用"拉下来，再把用户选的归属补一刀写上去。
                  pullMut.mutate(it, {
                    onSuccess: () => {
                      if (!isCommonSkill(labels)) {
                        ownerMut.mutate({ key: keyOf(it), coworks: labels })
                      }
                    },
                  })
                }}>
                {t('skills.importConfirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {opened && (
        <SkillDetailDialog
          item={opened}
          onClose={() => setOpenedKey(null)}
          onAdd={opened.kind === 'market' ? () => { addByKey(opened.key); setOpenedKey(null) } : undefined}
          adding={pullMut.isPending}
          onUnreference={opened.kind === 'referenced'
            ? () => { unpullMut.mutate(opened.key); setOpenedKey(null) }
            : undefined}
          unreferencing={unpullMut.isPending}
          onCoworksChange={opened.kind === 'market' || soleAgentNoMarket(agents)
            ? undefined                       // 还没引用（无记录），或单 agent 无市场（没得选）
            : coworks => ownerMut.mutate({ key: opened.key, coworks })}
          coworksSaving={ownerMut.isPending}
        />
      )}
    </div>
  )
}

/**
 * 分页页码。**关键词一变就回到第 1 页** —— 否则搜出 3 条却停在第 2 页，看到的是空白，
 * 而用户以为"没搜到"。
 */
function usePage(resetKey: unknown) {
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [resetKey])
  return [page, setPage] as const
}

/** 一组，空的就整组不渲染 —— 一个只写着"0 项"的标题只是噪声。 */
function SkillSection({ title, count, hint, extra, children }: {
  title: string; count: number; hint?: string
  /** 标题行右侧的控件（排序/筛选）。挂在这里而不是搜索框旁边，
   *  是为了让"只对这一组生效"看得出来。 */
  extra?: React.ReactNode
  children: React.ReactNode
}) {
  // count 为 0 也要把控件留着：作者筛到空结果时整组消失，用户就找不到那个筛选框把它改回来了。
  if (count === 0 && !extra) return null
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2.5">
        <h2 className="text-[13px] font-semibold" style={{ color: 'var(--t1)' }}>{title}</h2>
        <span className="rounded-full px-1.5 text-[10px]"
          style={{ background: 'var(--bg3)', color: 'var(--t3)', fontFamily: 'monospace' }}>{count}</span>
        {hint && <span className="text-[11px]" style={{ color: 'var(--t3)' }}>{hint}</span>}
        {extra && <div className="ml-auto self-center">{extra}</div>}
      </div>
      {children}
    </section>
  )
}

/** 下载量从高到低。
 *
 *  ⚠ **null 不是 0**：null = 这个市场根本不给下载量（自建那套就不给），
 *  0 = 确实没人下过。把 null 当 0 排，会把一整批「没数据」的条目和真的冷门
 *  混在一起；这里一律排到最后。 */
export function byDownloadsDesc(a: RemoteCatalogItem, b: RemoteCatalogItem): number {
  const x = a.download_count, y = b.download_count
  if (x == null && y == null) return 0
  if (x == null) return 1
  if (y == null) return -1
  return y - x
}

/** 两三项的小分段器。选中项要在**不 hover 时**就看得出来。 */
function Segmented({ value, onChange, options }: {
  value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex rounded-lg p-0.5" style={{ background: 'var(--bg2)', border: '1px solid var(--border)' }}>
      {options.map(o => {
        const on = o.value === value
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            className="rounded-md px-2 py-0.5 text-[11px] transition-colors"
            style={{
              background: on ? 'var(--bg1)' : 'transparent',
              color: on ? 'var(--blue)' : 'var(--t2)',
              fontWeight: on ? 600 : 400,
              boxShadow: on ? '0 1px 2px rgba(15,31,61,.08)' : 'none',
              border: 'none', cursor: 'pointer',
            }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 一个带标题与翻页的簇。空了整簇不渲染。 */
function PagedTiles({ items, page, onPage, label, onOpen }: {
  items: TileItem[]; page: number; onPage: (p: number) => void
  label: string; onOpen: (it: TileItem) => void
}) {
  const grid = useTileGrid()
  const pg = paginate(items, page, grid.pageSize)
  return (
    <Cluster label={label} count={items.length}>
      <TileGrid gridRef={grid.ref}>
        {pg.slice.map(it => <SkillTile key={it.key} item={it} onOpen={() => onOpen(it)} />)}
      </TileGrid>
      <Pager page={pg.page} pages={pg.pages} onChange={onPage} />
    </Cluster>
  )
}

/** 「当前技能」里的一组。比分区标题轻一档 —— 它是同一块里的分组，不是另起一块。 */
function Cluster({ label, count, children }: {
  label: string; count: number; children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[11px]" style={{ color: 'var(--t3)' }}>{label}</span>
        <span className="text-[10px]" style={{ color: 'var(--t3)', fontFamily: 'monospace' }}>{count}</span>
        <span className="flex-1" style={{ height: 1, background: 'var(--border)' }} />
      </div>
      {children}
    </div>
  )
}

/** 市场条目的引用身份 = 后端按页签作用域算好的 reference_id。
 *
 * 原先前端自己拼 `${source}:${id}`——v3 起同一 source:id 在通用与专属市场是**两条不同
 * 的引用**（不同服务器），自拼键会把两个市场的"已引用"状态串台：用户以为专属版已就绪，
 * 实际点开的是通用那份。配对、删除、改归属一律用后端给的身份；`${source}:${id}` 只
 * 留给纯 UI 用途（请求去重、报错定位），不得决定引用身份。 */
function keyOf(item?: RemoteCatalogItem): string {
  return item ? catalogReferenceId(item) : ''
}

function tileFromCatalog(
  item: RemoteCatalogItem, marketName: string, pulled: boolean, coworks?: SkillCoworks,
): TileItem {
  return {
    key: keyOf(item),
    // 已引用的要带归属：不带的话卡片和详情里那一栏是空的，
    // 而这条 skill 明明归属着某个 cowork——用户会以为归属没保存上。
    coworks: pulled ? coworks : undefined,
    name: item.name,
    description: item.description || '',
    kind: pulled ? 'referenced' : 'market',
    // 只有**已引用**的才标来路：它们会和本地导入的、别的市场引来的混在「已安装」里，不标
    // 就分不清。未引用的那批全都躺在自己市场的页签下，页签已经说了是哪个市场，再标一遍
    // 是每张卡片重复一次同样的信息。
    // 只有**已引用**的才标来路，而且**只在 cowork 页签标**：通用页签里标"通用市场"
    // 等于把页签名字在每张卡片上再写一遍——页签已经说了这是通用，卡片再说一次是噪声。
    from: pulled && marketName ? marketName : undefined,
    author: item.updater || undefined,
    createdAt: item.create_time || undefined,
    // `?? undefined` 而不是 `|| undefined`：0 是有效值（有数据、确实没人下过），要显示出来。
    downloads: item.download_count ?? undefined,
  }
}

/**
 * 归属选择的**默认值**（不是唯一值）。
 *
 * 只有一个 cowork 时默认给它 —— 那时「这条 skill 给谁用」只有一个答案，默认成「通用」
 * 反而多一层没意义的概念（通用 = 所有 cowork，而所有 = 这一个）。
 *
 * ⚠ **它只改默认值，不该被用来隐藏选项。** 本地导入时归属还决定**上传到哪个市场**
 * （publish 按归属路由），所以哪怕只有一个 agent，「通用」和「那个 agent」仍是两个
 * 不同的去处，两项都要列出来。真正可以省掉选择的只有「从市场引用」那一步——那里归属
 * 就是「给谁用」，没有第二层含义。
 */
/** 只有一个 cowork、且它连自己的 skill 市场都没有。
 *
 *  此时"上传到哪个市场""给哪个 cowork 用"都只有一个答案，归属选择框没有可选项 ——
 *  导入、点开详情都不该再弹它。
 *
 *  ⚠ 单 agent 但**有**自己市场时不算：那时仍要区分"传通用还是传它自己的市场"，
 *  选择框得留着（这正是之前"一个 agent 也显示通用/XX"的由来）。 */
function soleAgentNoMarket(agents: readonly { hasOwnMarket?: boolean }[]): boolean {
  return agents.length === 1 && agents[0].hasOwnMarket !== true
}

export function defaultCoworks(agents: readonly { id: string }[]): SkillCoworks {
  return agents.length === 1 ? [agents[0].id] : [ALL_COWORKS]
}

function tileFromLocal(
  sk: LocalSkill, t: (k: string) => string, opts: { showFrom?: boolean } = {},
): TileItem {
  const showFrom = opts.showFrom !== false
  return {
    key: sk.skill_id,
    name: sk.name,
    description: sk.description || '',
    kind: sk.origin === 'local' ? 'local' : 'referenced',
    coworks: sk.coworks,
    version: sk.version || undefined,
    // 分到子簇里之后来路已经写在簇标题上了，卡片再写一遍是重复——那一行留给归属。
    from: showFrom ? (sk.origin === 'local' ? t('skills.fromLocal') : t('skills.fromMarket')) : undefined,
    triggers: sk.triggers,
  }
}

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


