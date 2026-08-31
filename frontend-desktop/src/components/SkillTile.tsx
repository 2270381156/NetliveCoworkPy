/**
 * 技能卡片 —— 技能中心里**唯一**的一种展示单元。
 *
 * 之前本地 skill 是通栏长条、市场 skill 是双列方卡，同一个页面里两种几何、两套间距，滚下去
 * 像两个产品拼起来的。现在统一成一种：同样的尺寸、同样的信息位次，差别只用"处理方式"表达
 * ——已在手上的实心描边，市场里还没添加的虚线描边 + 图标去饱和。**形状一致、状态可辨**，
 * 比换一种卡片形状更容易扫。
 *
 * 信息位次固定，扫视时眼睛不用重新找：
 *
 *     ┌────────────────────────────────┐
 *     │ ▣  名称                    ✓ │   图标 + 名称 + 状态点
 *     │    来路 · 归属                 │   次级信息（灰、小）
 *     │                                │
 *     │ 描述最多两行，超出打点………      │
 *     │                     [ 动作 ]   │
 *     └────────────────────────────────┘
 *
 * 配色一律走既有 CSS 变量，不引入新色板 —— 这个页面没有理由长得与产品其它部分不同。
 */
import { useEffect, useRef, useState } from 'react'
import { CheckIcon, DownloadIcon, PlusIcon, ZapIcon } from 'lucide-react'

import { useAgents } from '@/agents/useAgents'
import { isCommonSkill, type SkillCoworks } from '@/api/skills'
import { useI18n } from '@/i18n'

/** 归一化之后的一条。本地 skill 与市场条目都先转成它，卡片只认这一种形状。 */
export interface TileItem {
  key: string
  name: string
  description: string
  /** local=本地文件；referenced=市场引来的（本地无内容）；market=市场里还没添加的 */
  kind: 'local' | 'referenced' | 'market'
  coworks?: SkillCoworks
  version?: string
  /** 来路的人话说明，如「MBB Cowork 市场」「本地导入」。 */
  from?: string
  triggers?: string[]
  /** 以下三项只有市场条目有。缺了就不占位——留一个空的"作者："比不显示更糟。 */
  author?: string
  /** 市场给的时间。netcowork 只有创建时间，没有更新时间（见 Skill 实体）。**只在详情层显示。** */
  createdAt?: string
  /** 下载量。市场同时有引用数与下载数，界面只用这一个——摆两个数上去，第一个问题永远是
   *  "哪个才算数"。 */
  downloads?: number
}

export function SkillTile({ item, onOpen, onAdd, adding, error }: {
  item: TileItem
  onOpen: () => void
  /** 仅 kind=market：添加（引用）到本机。 */
  onAdd?: () => void
  adding?: boolean
  error?: string
}) {
  const { t } = useI18n()
  const agents = useAgents()
  const pending = item.kind === 'market'
  const subtitle = [item.from, ownerLabel(item.coworks, t, agents)].filter(Boolean).join(' · ')

  return (
    <div
      onClick={onOpen}
      className="group flex flex-col rounded-xl transition-all"
      style={{
        // 未添加的用虚线：一眼看出"还不是你的"，而不用换一种卡片形状。
        border: `1px ${pending ? 'dashed' : 'solid'} var(--border)`,
        background: pending ? 'transparent' : 'var(--bg1)',
        boxShadow: pending ? 'none' : 'var(--shadow)',
        cursor: 'pointer',
        minHeight: 132,
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.borderColor = 'var(--blue)'
        el.style.background = pending ? 'var(--bg1)' : 'var(--bg1)'
        el.style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.borderColor = 'var(--border)'
        el.style.background = pending ? 'transparent' : 'var(--bg1)'
        el.style.transform = 'none'
      }}
    >
      <div className="flex items-start gap-2.5 px-3.5 pt-3.5">
        <span
          className="flex-shrink-0 flex items-center justify-center rounded-lg"
          style={{
            width: 30, height: 30,
            background: pending ? 'var(--bg3)' : 'var(--blue-dim)',
            color: pending ? 'var(--t3)' : 'var(--blue)',
          }}
        >
          <ZapIcon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-tight" style={{ color: 'var(--t1)' }}>
            {item.name}
          </p>
          {/* 两项都没有就整行不渲染 —— 留一个空段落会在名称下面压出一道空隙，那一列卡片
              的标题就不齐了。 */}
          {subtitle && (
            <p className="truncate text-[11px] mt-0.5" style={{ color: 'var(--t3)' }}>{subtitle}</p>
          )}
        </div>
        {!pending && (
          <span title={t('skills.stateReady')}
            className="flex-shrink-0 flex items-center justify-center rounded-full"
            style={{ width: 16, height: 16, background: 'rgba(22,163,74,.12)', color: 'var(--green)' }}>
            <CheckIcon size={10} />
          </span>
        )}
      </div>

      <p
        className="px-3.5 mt-2 text-[11.5px] leading-relaxed"
        style={{
          color: 'var(--t2)',
          // 两行截断：描述长短差很多，不截的话卡片高度参差，一屏扫下来很乱。
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden', minHeight: '2.9em',
        }}
      >
        {item.description || t('skills.noDescription')}
      </p>

      <div className="mt-auto flex items-center gap-2 px-3.5 pb-3 pt-2.5">
        {/* 元信息一行，缺哪项就不占位。发布时间**不放这里**——挑 skill 时看的是作者和有多少
            人下过，日期是确认细节时才关心的，放进详情层。 */}
        <span className="truncate text-[10px]" style={{ color: 'var(--t3)' }}>
          {[item.author, item.version ? `v${item.version}` : ''].filter(Boolean).join(' · ')}
        </span>
        {typeof item.downloads === 'number' && (
          <span title={t('skills.usesTitle')} className="flex flex-shrink-0 items-center gap-0.5 text-[10px]"
            style={{ color: 'var(--t3)' }}>
            <DownloadIcon size={10} />{item.downloads}
          </span>
        )}
        <div className="ml-auto">
          {pending && onAdd && (
            <button
              onClick={e => { e.stopPropagation(); onAdd() }}
              disabled={adding}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                color: 'var(--blue)', background: 'var(--blue-dim)',
                border: '1px solid transparent', cursor: adding ? 'default' : 'pointer',
                opacity: adding ? 0.6 : 1,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}
            >
              <PlusIcon size={11} />{adding ? t('skills.adding') : t('skills.add')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="px-3.5 pb-3 text-[11px] leading-snug" style={{ color: 'var(--red)' }}>{error}</p>
      )}
    </div>
  )
}

/**
 * 归属的人话。
 *
 * **必须查显示名**：归属里存的是 id（`mbb`），而页签、切换器、别处一律显示 `MBB Cowork`。
 * 直接把 id 印出来的话，同一个东西在同一页上有两种写法，用户会以为是两回事——这正是词表
 * 乱掉的根源。查不到（阵容里已经没有这个 cowork，比如权限刚被收回）才退回 id：显示 id 也
 * 比显示空白强，空白会让人以为它是通用的。
 */
export function ownerLabel(
  coworks: SkillCoworks | undefined,
  t: (k: string) => string,
  agents: readonly { id: string; displayName: string }[] = [],
): string {
  if (!coworks) return ''
  if (isCommonSkill(coworks)) return t('skills.ownerCommon')
  return coworks.map(id => agents.find(a => a.id === id)?.displayName || id).join(' / ')
}

/** 只到日，不到分秒 —— 卡片那一行放不下，而"哪天发布的"已经够判断新旧。 */
export function formatDay(raw: string): string {
  const d = new Date(raw.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

const TILE_MIN = 232
const GRID_GAP = 12

/** 等宽自适应网格。窄侧栏展开时自动降列，不写死列数。 */
export function TileGrid({ children, gridRef }: {
  children: React.ReactNode
  /** 传了就能被 useTileGrid 量宽度，用来把每页凑成整行（见那里）。 */
  gridRef?: React.RefObject<HTMLDivElement | null>
}) {
  return (
    <div ref={gridRef} style={{
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN}px, 1fr))`,
      gap: GRID_GAP,
    }}>
      {children}
    </div>
  )
}

// ── 分页 ──────────────────────────────────────────────────────────────────────
// 一个市场几十上百条是常态，全量铺开会让页面长到滚不完，而且每次切页签都要重新渲染一大片。
//
// **搜索必须先于分页**：先按关键词筛出全集，再对结果分页。反过来（只在当前页里搜）的结果是
// "明明有这个 skill 却搜不到"，而用户完全不知道是分页造成的。
// 与之配套：**关键词一变就回到第 1 页**，否则搜出 3 条却停在第 2 页，看到的是空白。

export const PAGE_SIZE = 12

/** 一页几行。行数固定、列数随宽度变——这样每页永远是个完整的矩形。 */
export const PAGE_ROWS = 3

/**
 * 让每页正好铺满整行。
 *
 * 每页固定 12 张时，一行放几张却是按窗口宽度自适应的（auto-fill），两者对不上：窗口宽到
 * 一行放 5 张时，12 张 = 两整行 + 孤零零的 2 张，最后一行空着一大块，看起来像"这页没加载完"。
 * 所以反过来——先量出这次能排几列，再让每页 = 列数 × 行数。窗口一拉宽，每页自动多装几张，
 * 版面始终是个完整的矩形。
 *
 * 量不到宽度时（首帧、或没有 ResizeObserver 的环境如单测）回落到固定 12：宁可版面不齐，
 * 也不能因为量不到就渲染出 0 张。
 */
/** auto-fill 实际会排出几列。加一个 GRID_GAP 再除，是因为 n 列之间只有 n-1 个间隔。 */
export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GRID_GAP) / (TILE_MIN + GRID_GAP)))
}

export function useTileGrid(rows: number = PAGE_ROWS) {
  const ref = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // auto-fill 的列数：每列至少 TILE_MIN 宽，列间隔 GRID_GAP。加一个 GRID_GAP 再除，
    // 是因为 n 列之间只有 n-1 个间隔。
    const measure = () => setCols(columnsFor(el.clientWidth))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, pageSize: cols > 0 ? cols * rows : PAGE_SIZE }
}

/** 纯函数，便于单测。page 从 1 起；越界一律夹回有效范围，不返回空页。 */
export function paginate<T>(items: T[], page: number, size: number = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const safe = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  const start = (safe - 1) * size
  return { slice: items.slice(start, start + size), page: safe, pages, total: items.length }
}

export function Pager({ page, pages, onChange }: {
  page: number; pages: number; onChange: (p: number) => void
}) {
  // 只有一页就不显示：一个点不动的翻页器只是噪声。
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-end gap-1.5 mt-3">
      <PagerBtn disabled={page <= 1} onClick={() => onChange(page - 1)}>‹</PagerBtn>
      <span className="text-[11px] tabular-nums" style={{ color: 'var(--t3)', fontFamily: 'monospace' }}>
        {page} / {pages}
      </span>
      <PagerBtn disabled={page >= pages} onClick={() => onChange(page + 1)}>›</PagerBtn>
    </div>
  )
}

function PagerBtn({ children, disabled, onClick }: {
  children: React.ReactNode; disabled: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center rounded-lg transition-colors"
      style={{
        width: 22, height: 22, fontSize: 13, lineHeight: 1,
        color: disabled ? 'var(--t3)' : 'var(--t2)',
        background: 'none', border: '1px solid var(--border)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={e => { if (!disabled) { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--blue)'; el.style.color = 'var(--blue)' } }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.color = disabled ? 'var(--t3)' : 'var(--t2)' }}
    >
      {children}
    </button>
  )
}
