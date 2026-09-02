/**
 * 技能详情 —— 点卡片打开的那一层。
 *
 * **为什么是弹层不是就地展开**：卡片排在等宽网格里，就地展开会把那一行撑高、把后面的卡片
 * 挤到别处去，每点一次版面就跳一次。弹层不动版面，而且能一次把描述、触发词、归属、来路
 * 摆全 —— 卡片上只放扫视需要的，细节都在这里。
 *
 * 所有会改东西的操作也收在这里（删除、上传到市场、改归属、取消引用）。卡片上只留一个
 * 「添加」——那是浏览时的高频动作；其余都是"想清楚了才做"的，多一次点击是好事。
 */
import { Trash2Icon, UploadIcon, XIcon, ZapIcon } from 'lucide-react'

import type { SkillCoworks } from '@/api/skills'
import { Button } from '@/components/ui/button'
import { CoworkChooser } from '@/components/SkillsPage'
import { formatDay, ownerLabel, type TileItem } from '@/components/SkillTile'
import { useAgents } from '@/agents/useAgents'
import { useI18n } from '@/i18n'

export function SkillDetailDialog({
  item, onClose,
  onDelete, onPublish, publishing, publishStatus,
  onCoworksChange, coworksSaving,
  onUnreference, unreferencing,
  onAdd, adding,
}: {
  item: TileItem
  onClose: () => void
  onDelete?: () => void
  onPublish?: () => void
  publishing?: boolean
  publishStatus?: { ok: boolean; msg: string }
  onCoworksChange?: (v: SkillCoworks) => void
  coworksSaving?: boolean
  onUnreference?: () => void
  unreferencing?: boolean
  onAdd?: () => void
  adding?: boolean
}) {
  const { t } = useI18n()
  const agents = useAgents()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(15,31,61,.4)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col"
        style={{
          width: 480, maxHeight: '78vh',
          background: 'var(--bg1)', border: '1px solid var(--border)',
          borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.2)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* 头：与卡片同一套图标/字号，点开之后不该像换了个东西 */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-4">
          <span className="flex-shrink-0 flex items-center justify-center rounded-lg"
            style={{ width: 34, height: 34, background: 'var(--blue-dim)', color: 'var(--blue)' }}>
            <ZapIcon size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight" style={{ color: 'var(--t1)' }}>{item.name}</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--t3)' }}>
              {[item.from, item.version ? `v${item.version}` : ''].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button onClick={onClose} title={t('common.close')}
            className="flex-shrink-0 rounded-lg p-1 transition-colors"
            style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}>
            <XIcon size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-1" style={{ borderTop: '1px solid var(--border)' }}>
          <Field label={t('skills.fieldDescription')}>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--t2)' }}>
              {item.description || t('skills.noDescription')}
            </p>
          </Field>

          {item.triggers && item.triggers.length > 0 && (
            <Field label={t('skills.fieldTriggers')}>
              <div className="flex flex-wrap gap-1.5">
                {item.triggers.map(x => (
                  <span key={x} className="rounded-full px-2 py-0.5 text-[10px]"
                    style={{ background: 'var(--bg3)', color: 'var(--t2)' }}>{x}</span>
                ))}
              </div>
            </Field>
          )}

          {(item.author || item.createdAt || typeof item.downloads === 'number') && (
            <Field label={t('skills.fieldSource')}>
              <div className="flex flex-col gap-1 text-xs" style={{ color: 'var(--t2)' }}>
                {item.author && <Row k={t('skills.fieldAuthor')} v={item.author} />}
                {item.createdAt && <Row k={t('skills.fieldCreated')} v={formatDay(item.createdAt)} />}
                {typeof item.downloads === 'number' && <Row k={t('skills.fieldUses')} v={String(item.downloads)} />}
              </div>
            </Field>
          )}

          {/* 还没引用的市场 skill 没有归属可言 —— 它还不属于任何人。
              显示一栏“归属：—”只会让人以为这里漏了数据。引用之后这一栏自然出现。 */}
          {item.kind !== 'market' && (
          <Field label={t('skills.ownerLabel')}>
            {onCoworksChange ? (
              <>
                <p className="mb-2 text-[11px] leading-relaxed" style={{ color: 'var(--t3)' }}>
                  {t('skills.ownerHint')}
                </p>
                <div className="rounded-xl p-1" style={{ border: '1px solid var(--border)' }}>
                  <CoworkChooser value={item.coworks || ['*']} onChange={onCoworksChange} disabled={coworksSaving} />
                </div>
              </>
            ) : (
              <p className="text-xs" style={{ color: 'var(--t2)' }}>{ownerLabel(item.coworks, t, agents) || '—'}</p>
            )}
          </Field>
          )}
        </div>

        {/* 操作条。改动性的操作都在这儿，卡片上只留「引用」。 */}
        <div className="flex items-center gap-2 px-5 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          {publishStatus && (
            <span className="text-[11px]" style={{ color: publishStatus.ok ? 'var(--green)' : 'var(--red)' }}>
              {publishStatus.msg}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {onDelete && (
              <GhostButton danger onClick={onDelete}>
                <Trash2Icon size={12} />{t('common.delete')}
              </GhostButton>
            )}
            {onUnreference && (
              <GhostButton danger onClick={onUnreference} disabled={unreferencing}>
                <Trash2Icon size={12} />{t('skills.unreference')}
              </GhostButton>
            )}
            {onPublish && (
              <GhostButton onClick={onPublish} disabled={publishing}>
                <UploadIcon size={12} />{t('skills.publish')}
              </GhostButton>
            )}
            {onAdd && (
              <Button size="sm" loading={adding} onClick={onAdd}>{t('skills.add')}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex-shrink-0" style={{ color: 'var(--t3)', width: 56 }}>{k}</span>
      <span className="min-w-0 flex-1 truncate">{v}</span>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <p className="mb-1.5 text-[10px] font-semibold uppercase" style={{ color: 'var(--t3)', letterSpacing: '.4px' }}>
        {label}
      </p>
      {children}
    </div>
  )
}

function GhostButton({ children, onClick, danger, disabled }: {
  children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean
}) {
  const hover = danger ? 'var(--red)' : 'var(--blue)'
  const tint = danger ? 'rgba(220,38,38,.06)' : 'rgba(37,99,235,.06)'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors"
      style={{
        // ⚠ 静止态不能用 --t3（#8aa3bf，最淡的那档）+ 无边框：
        // 那正是本产品里“禁用”的长相，用户会以为按钮点不了、压根不去点。
        // 可点的东西必须在**不 hover 时**就看得出来。
        color: disabled ? 'var(--t3)' : 'var(--t2)',
        background: 'none',
        border: `1px solid ${disabled ? 'transparent' : 'var(--border)'}`,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={e => {
        if (disabled) return
        const el = e.currentTarget as HTMLElement
        el.style.color = hover; el.style.background = tint; el.style.borderColor = hover
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.color = 'var(--t3)'; el.style.background = 'none'; el.style.borderColor = 'transparent'
      }}
    >
      {children}
    </button>
  )
}
