/**
 * 聊天区空态 —— 没选会话时那一屏。
 *
 * 只负责「开始」，**不负责选 agent**：跟谁聊由全局当前 agent 决定（左缘的 AgentDrawer）。
 * 原来这里铺满整个 agent 阵容，有两个毛病——选完就再也回不去（有会话后这屏不再出现），
 * 而且把一个长期存在的导航维度塞进了一个转瞬即逝的空状态。
 */

import { useEffect, useState } from 'react'

import type { Agent } from '@/agents/registry'
import { canStartSession, useLineupState } from '@/agents/lineup'
import { refreshCoworks } from '@/api/coworks'
import { useI18n } from '@/i18n'

export function AgentEmptyState({ agent, onStart }: {
  /** 当前 agent；阵容为空时为 null，此时按阵容状态给不同文案（见 agents/lineup）。 */
  agent: Agent | null
  onStart: () => void
}) {
  const { t } = useI18n()
  const state = useLineupState()
  const [retrying, setRetrying] = useState(false)

  // 一个 cowork 都没有时，"为什么没有"决定了用户下一步该做什么，所以三种状态各给各的话。
  // 都显示成"开始对话"的话，权限没配好的人会以为产品就长这样。
  const blocked = !canStartSession(state)
  const title = agent ? agent.displayName
    : state === 'pending' ? t('agent.lineupLoading')
    : state === 'unreachable' ? t('agent.lineupUnreachable')
    : state === 'none' ? t('agent.lineupNone')
    : t('chat.startConversation')
  const desc = agent || state === 'brandless' ? t('chat.selectOrCreate')
    : state === 'pending' ? ''
    : state === 'unreachable' ? t('agent.lineupUnreachableDesc')
    : t('agent.lineupNoneDesc')

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5" style={{ background: 'var(--bg0)' }}>
      {/* 这页正中就这一个图形，没 logo 也要有东西——落到首字母方块。空着的话整页
          只剩一行标题加一行说明，看着像没加载出来。 */}
      {agent
        ? <AgentMark agent={agent} size={44} fallback="letter" />
        : <img src="/icon.svg" alt="" style={{ width: 44, height: 44, opacity: 0.35 }} />}
      <div className="text-center" style={{ lineHeight: 1.7, maxWidth: 380 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t2)' }}>{title}</div>
        {desc && <p style={{ fontSize: 13, color: 'var(--t3)' }}>{desc}</p>}
      </div>
      {/* 没开通/没拉到时不给"新建会话"：点下去会建出一个跑母版模板的会话——它不属于任何
          cowork，界面上无名无姓，而用户以为自己在正常使用产品。 */}
      {!blocked && <PrimaryButton onClick={onStart}>{t('sidebar.newSession')}</PrimaryButton>}
      {/* 挡住了就给一条出路。**两种状态都要给**：没拉到当然该重试；"一个都没开通"同样该
          给——管理员刚给他开通、或者他刚在应用里登录完，重来一次就有了，否则他唯一的办法
          是重启应用，而没人会想到要重启。 */}
      {blocked && state !== 'pending' && (
        <PrimaryButton
          onClick={() => { setRetrying(true); void refreshCoworks().finally(() => setRetrying(false)) }}
          disabled={retrying}
        >
          {retrying ? t('agent.lineupRetrying') : t('agent.lineupRetry')}
        </PrimaryButton>
      )}
    </div>
  )
}

/**
 * cowork 的小标记：**显示套件自带的 logo**；没有 logo 时看 `fallback`。
 *
 * - `none`（默认）：整个不渲染。用在列表、下拉、首页——那些地方一行里本来就有文字，
 *   留个等大的空位反而把文字推出去一截，看着像对齐错了。
 * - `letter`：accent 底色方块 + 名字首字母。用在新建会话弹窗——那儿它是弹窗标题左边
 *   唯一的图形，没了就剩孤零零一行字，太单薄。
 *
 * ⚠ 图加载失败走的是同一条路（套件是下发来的，logo 可能没打进包、格式不对、后端刚好在
 * 重启）—— 半张破图比回落更糟，所以 onError 直接把它降级掉，而不是听天由命。
 */
export function AgentMark({ agent, size = 24, fallback = 'none' }: {
  agent: Agent; size?: number; fallback?: 'none' | 'letter'
}) {
  const [logoBroken, setLogoBroken] = useState(false)

  // agent 变了要重置：上一个的 logo 挂了，不该连累下一个也不显示。
  useEffect(() => { setLogoBroken(false) }, [agent.logoUrl])

  if (agent.logoUrl && !logoBroken) {
    return (
      <img
        src={agent.logoUrl}
        alt=""
        aria-hidden
        onError={() => setLogoBroken(true)}
        style={{
          flexShrink: 0,
          width: size, height: size,
          borderRadius: size * 0.3,
          objectFit: 'cover',      // 非正方形的 logo 裁成方的，不拉变形
          display: 'block',
        }}
      />
    )
  }

  if (fallback === 'none') return null

  // 首字母而不是整个名字：方块就这么大，塞中文名会挤出去。取第一个字母数字，
  // 「「MBB」Cowork」这种才不会取到引号；一个字母数字都没有（纯中文名）再退回首字符。
  const letter = (agent.displayName.match(/[A-Za-z0-9]/)?.[0] ?? agent.displayName.charAt(0)).toUpperCase()
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: size, height: size,
        borderRadius: size * 0.3,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        // 半透明底 + 实色字：同一个 accent 在浅深色主题下都够对比，不必各配一套色。
        background: `${agent.accent}22`,
        color: agent.accent,
        fontSize: size * 0.46,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  )
}

function PrimaryButton({ onClick, children, disabled }: {
  onClick: () => void; children: React.ReactNode; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '9px 22px', borderRadius: 8,
        background: 'var(--blue)', color: '#fff',
        border: 'none', fontSize: 13.5, fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        boxShadow: '0 2px 10px rgba(37,99,235,.3)',
      }}
    >
      {children}
    </button>
  )
}
