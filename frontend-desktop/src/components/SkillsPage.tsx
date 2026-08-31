import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon, SearchIcon, PackageIcon, ZapIcon, ChevronLeftIcon } from 'lucide-react'
import { skillsApi, ALL_COWORKS, isCommonSkill } from '@/api/skills'
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

  // 选完文件先攒着，弹框里问归属，确认了才真导。
  //
  // **归属必须问在导入动作里面**：它是"这个 skill 属于谁"的从属关系。放在列表上方当一个
  // 常驻控件，第一反应会被读成"按 agent 筛选列表"——位置决定了人怎么理解它，说明文字改不动
  // 这个第一反应。
  const [pendingFile, setPendingFile] = useState<File | null>(null)
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
      setPendingFile(file)
      setPendingCoworks([ALL_COWORKS])   // 每次都回到默认，不继承上一次的选择
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
          onCoworksChange={coworks => ownerMut.mutate({ skillId: opened.skill_id, coworks })}
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
  const marketName = cowork
    ? t('skills.marketOfCowork').replace('{name}',
        markets.find(m => m.cowork === cowork)?.display_name ?? cowork)
    : t('skills.marketCommonShort')

  /** 当前技能 —— 两个子簇，按**它是怎么来的**分：本机的文件 / 市场里引的。
   *
   * 上一版把它们混成一块，是因为"来路是次要信息"；但两者能做的事其实不同（本地的能删、能
   * 传回市场、能改归属；引用的只能取消引用），混在一起点开才知道是哪种。分两簇是**同一块
   * 里的两组**，不是两块——标题仍然只有「当前技能」一个。
   */
  const usableLocal: TileItem[] = useMemo(() => {
    const out: TileItem[] = []
    for (const sk of mine) {
      if (sk.origin !== 'local') continue
      const ownedHere = cowork ? sk.coworks.includes(cowork) : false
      // 通用页签只看通用的；cowork 页签看"归属它的"+"通用的"——后者它同样用得上。
      if (!(isCommonSkill(sk.coworks) || ownedHere)) continue
      if (!matches(sk.name, sk.description)) continue
      out.push(tileFromLocal(sk, t, { showFrom: false }))
    }
    return out
  }, [mine, cowork, q])

  const usableRefs: TileItem[] = useMemo(() => {
    // 引用库只存名字和描述，**没有作者/发布时间/下载量**——那些只在市场目录里。所以这里按
    // key 去目录里配一份补上。
    //
    // 用 key 而不是名字配对：引用的 skill_id 就是 `<source>:<remote_id>`，与目录条目的
    // `source:id` 同一形状，能精确对上。按名字配会在两个市场有同名 skill 时配错人——那时
    // 卡片上会显示另一个市场的作者和下载量，而且没有任何地方露馅。
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
      out.push(tileFromCatalog(item, marketName, true))
    }
    return out
  }, [mine, filtered, catalog, cowork, q, marketName])

  const usable = useMemo(() => [...usableLocal, ...usableRefs], [usableLocal, usableRefs])

  // 三块各自翻各自的页：它们长短差很多，共用一个页码会让翻到第 2 页时另外两块莫名变空。
  const [pgLocal, setPgLocal] = usePage(q)
  const [pgRefs, setPgRefs] = usePage(q)
  const [pgAdd, setPgAdd] = usePage(q)
  const addGrid = useTileGrid()

  /** 能加的：这个市场里还没引的。 */
  const addable: TileItem[] = useMemo(
    () => filtered.filter(i => !i.is_pulled).map(i => tileFromCatalog(i, marketName, false)),
    [filtered, marketName],
  )
  const nothingAtAll = usable.length === 0 && addable.length === 0 && catalog.length === 0

  // 点开的那一条。市场项与本地项都能点开，详情层按 kind 决定给哪些操作。
  const [opened, setOpened] = useState<TileItem | null>(null)
  // 添加**必须**在目录里找到条目：要把 source 和名字传给后端去下载。取消则不用（见上）。
  const byKey = (k: string) => catalog.find(i => keyOf(i) === k)
  const addByKey = (k: string) => { const it = byKey(k); if (it) pullMut.mutate(it) }

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
                label={t('skills.clusterLocal')} onOpen={setOpened} />
              <PagedTiles items={usableRefs} page={pgRefs} onPage={setPgRefs}
                label={t('skills.clusterReferenced')} onOpen={setOpened} />
            </div>
          </SkillSection>

          {/* 标题不再带市场名：页签本身已经写着是哪个市场了，标题里再写一遍是重复。
              市场名改放在每张卡片的副标题上——那里才需要区分，因为「当前技能」那一块里
              混着好几个来路。 */}
          <SkillSection title={t('skills.groupAddable')} count={addable.length}>
            {(() => {
              const pg = paginate(addable, pgAdd, addGrid.pageSize)
              return (
                <>
                  <TileGrid gridRef={addGrid.ref}>
                    {pg.slice.map(it => (
                      <SkillTile key={it.key} item={it}
                        onOpen={() => setOpened(it)}
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

      {opened && (
        <SkillDetailDialog
          item={opened}
          onClose={() => setOpened(null)}
          onAdd={opened.kind === 'market' ? () => { addByKey(opened.key); setOpened(null) } : undefined}
          adding={pullMut.isPending}
          onUnreference={opened.kind === 'referenced'
            ? () => { unpullMut.mutate(opened.key); setOpened(null) }
            : undefined}
          unreferencing={unpullMut.isPending}
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
function SkillSection({ title, count, hint, children }: {
  title: string; count: number; hint?: string; children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2.5">
        <h2 className="text-[13px] font-semibold" style={{ color: 'var(--t1)' }}>{title}</h2>
        <span className="rounded-full px-1.5 text-[10px]"
          style={{ background: 'var(--bg3)', color: 'var(--t3)', fontFamily: 'monospace' }}>{count}</span>
        {hint && <span className="text-[11px]" style={{ color: 'var(--t3)' }}>{hint}</span>}
      </div>
      {children}
    </section>
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

/** 市场条目的复合键。两个市场可能发出相同 id，只用 id 会串台。 */
function keyOf(item?: RemoteCatalogItem): string {
  return item ? `${item.source}:${item.id}` : ''
}

function tileFromCatalog(item: RemoteCatalogItem, marketName: string, pulled: boolean): TileItem {
  return {
    key: keyOf(item),
    name: item.name,
    description: item.description || '',
    kind: pulled ? 'referenced' : 'market',
    // 只有**已引用**的才标来路：它们会和本地导入的、别的市场引来的混在「已安装」里，不标
    // 就分不清。未引用的那批全都躺在自己市场的页签下，页签已经说了是哪个市场，再标一遍
    // 是每张卡片重复一次同样的信息。
    from: pulled ? marketName : undefined,
    author: item.updater || undefined,
    createdAt: item.create_time || undefined,
    // `?? undefined` 而不是 `|| undefined`：0 是有效值（有数据、确实没人下过），要显示出来。
    downloads: item.download_count ?? undefined,
  }
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


