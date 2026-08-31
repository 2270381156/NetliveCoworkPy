/**
 * AgentSwitcher —— 顶栏里「当前 cowork」那一块：既显示身份，也是切换入口。
 *
 * 放顶栏而不是侧边栏，有两个实打实的理由：
 *   · 侧边栏可以整个收起（leftCollapsed），放那儿的话身份提示和活动红点会跟着消失；
 *   · 顶栏本来就写着外壳名（NetLIVE Cowork），当前 cowork 紧随其后，「外壳 / 当前」的
 *     从属关系一眼可见；否则两处各写一个名字，用户得自己拼出层级。
 *
 * 活动提示：切走之后别的 cowork 的会话在列表里完全不可见，但它们仍在后台跑。名字旁的
 * 小圆点就是唯一的告知渠道，否则会出现「任务停在等你回答、而你根本不知道」。
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { useAgentSwitch } from '@/agents/useCurrentAgent'
import { AgentMark } from '@/components/AgentHome'
import { useI18n } from '@/i18n'

export function AgentSwitcher({ activity = {} }: { activity?: Record<string, number> }) {
  const { t } = useI18n()
  const { current, agents, switchTo } = useAgentSwitch()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!current) return null                    // 阵容为空 → 退回没有 agent 这一层的旧形态

  const multi = agents.length > 1
  const elsewhere = agents.reduce((n, a) => (a.id === current.id ? n : n + (activity[a.id] ?? 0)), 0)

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        onClick={() => multi && setOpen(o => !o)}
        title={multi ? t('agent.switchTitle', { name: current.displayName }) : current.displayName}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          // 与页眉里其它项同高（见 App.tsx 的 ROW_H）：这一排是靠"等高盒子各自内部居中"
          // 对齐的，这里高出 4px 会把它的文字压低半格。
          height: 20, padding: '0 6px',
          background: 'none', border: 'none', borderRadius: 6,
          cursor: multi ? 'pointer' : 'default',
          transition: 'background var(--tr)',
        }}
        onMouseEnter={e => { if (multi) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
      >
        <AgentMark agent={current} size={16} />
        <span style={{
          maxWidth: 150, fontSize: 12.5, fontWeight: 600, lineHeight: 1, color: 'var(--t1)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {current.displayName}
        </span>
        {elsewhere > 0 && (
          <span
            title={t('agent.elsewhereBusy', { count: elsewhere })}
            style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0 }}
          />
        )}
        {multi && (
          <ChevronDownIcon
            size={12}
            style={{
              flexShrink: 0, color: 'var(--t3)',
              transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s',
            }}
          />
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', left: 0, top: '100%', zIndex: 60,
            minWidth: 216, padding: 5, marginTop: 4,
            background: 'var(--bg1)', border: '1px solid var(--border)',
            borderRadius: 9, boxShadow: 'var(--shadow2)',
          }}
        >
          {agents.map(a => {
            const isCurrent = a.id === current.id
            const busy = activity[a.id] ?? 0
            return (
              <button
                key={a.id}
                onClick={() => { switchTo(a.id); setOpen(false) }}
                style={{
                  display: 'flex', width: '100%', alignItems: 'center', gap: 8,
                  padding: '6px 7px', marginBottom: 1,
                  background: isCurrent ? 'var(--blue-dim)' : 'none',
                  border: 'none', borderRadius: 7,
                  cursor: isCurrent ? 'default' : 'pointer', textAlign: 'left',
                }}
                onMouseEnter={e => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
                onMouseLeave={e => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'none' }}
              >
                <AgentMark agent={a} size={20} />
                <span style={{
                  flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--t1)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {a.displayName}
                </span>
                {busy > 0 && !isCurrent && <span style={{ fontSize: 10.5, color: 'var(--blue)', flexShrink: 0 }}>{busy}</span>}
                {isCurrent && <span style={{ fontSize: 11, color: 'var(--blue)', flexShrink: 0 }}>✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
