import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModelPickerButton } from '@/components/ui/ModelPickerButton'
import { Spinner } from '@/components/ui/spinner'
import { useI18n } from '@/i18n'
import type { SessionNotice } from '@/hooks/useSessionSSE'
import type { LLMProvider } from '@/types'
import { OBS_PURPLE } from '@/lib/observerStyle'

/**
 * 会话通告框：FAILED 死因 / INTERRUPTED 成因，替换输入区（原内联 INTERRUPTED 横幅收编于此）。
 * - FAILED：死因 + 熔断连败清单（默认折叠）+「继续对话」（本地关栏，由 ChatPanel 持有）。
 * - INTERRUPTED：按 interruptReason 分型文案；恢复按钮旁挂账号/模型选择器（所有中断
 *   成因均可换模型恢复，恢复时把选择传给 /resume）；CONTEXT_OVERFLOW 文案特别提示换大窗口。
 *   选择器默认勾选**当前模型**（initialProvider/initialModel，与输入框同源同显示——
 *   中断时输入框不在，用户不该猜"当前"是哪个），可直接换选。
 * 陈旧 notice（kind 与当前状态不符，如中断→恢复→失败的旧帧）不作素材。
 */
export function SessionNoticeBar({
  status, notice, interruptReason, providers, initialProvider, initialModel,
  onContinue, onResume, resumePending,
}: {
  status: 'FAILED' | 'INTERRUPTED'
  notice: SessionNotice | null
  interruptReason: string | null
  providers: LLMProvider[]
  /** 会话当前模型（与 Composer 的 nextProvider/nextModel 同源）：选择器的初始勾选。 */
  initialProvider: string
  initialModel: string
  onContinue: () => void
  onResume: (llm?: { llm_account?: string; llm_model?: string }) => void
  resumePending: boolean
}) {
  const { t } = useI18n()
  const wanted = status === 'FAILED' ? 'failed' : 'interrupted'
  const n = notice && notice.kind === wanted ? notice : null

  const [showFailures, setShowFailures] = useState(false)
  const [llmAccount, setLlmAccount] = useState(initialProvider)
  const [llmModel, setLlmModel] = useState(initialModel)

  if (status === 'FAILED') {
    // observer 判定的失败（agent 自评未达成 / 重试耗尽）是【正常质检流程】，不是系统报错 →
    // 用中性灰配色 + 「任务未达成」标题，别用红色报错框吓用户（详细复盘见时间线里的观察者卡片）。
    // 其它 code（熔断、真实错误等）仍红。
    // agent 自检判定的失败：用与「自检」卡片一致的紫色主题(OBS_PURPLE)，不用红/灰——保证 observer
    // 事件视觉统一；真实系统错误仍红。
    const agentJudged = n?.reason_code === 'TASK_FAILED_BY_OBSERVER'
      || n?.reason_code === 'TASK_FAILED_RETRY_EXHAUSTED'
    const c = agentJudged
      ? { border: OBS_PURPLE.noticeBorder, bg: OBS_PURPLE.bg, title: OBS_PURPLE.badgeText, text: OBS_PURPLE.text, link: OBS_PURPLE.accent }
      : { border: 'rgba(220,38,38,.3)', bg: 'rgba(254,242,242,.7)', title: '#b91c1c', text: '#b91c1c', link: '#dc2626' }
    // agent 判定类死因由前端按 reason_code + reason_data 本地化拼文案（后端 reason_text 仅兜底）。
    const reasonText = ((): string => {
      if (!n) return t('notice.failedGeneric')
      const suffix = agentJudged ? t('notice.agentJudgedSuggestion') : ''
      if (n.reason_code === 'TASK_FAILED_RETRY_EXHAUSTED') {
        const rc = n.reason_data?.retry_count
        const base = rc ? t('notice.retryExhausted', { n: rc }) : t('notice.retryExhaustedNoCount')
        const msg = n.reason_data?.message
        return base + (msg ? t('notice.lastBlockedBy', { msg }) : '') + suffix
      }
      if (n.reason_code === 'TASK_FAILED_BY_OBSERVER') {
        return (n.reason_data?.message || t('notice.observerFailFallback')) + suffix
      }
      return n.reason_text || t('notice.failedGeneric')
    })()
    return (
      <div style={{ padding: '10px 14px 14px', flexShrink: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
          borderRadius: 'var(--r)', border: `1px solid ${c.border}`, background: c.bg,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: c.title }}>
              {agentJudged ? t('notice.agentJudgedTitle') : t('notice.failedTitle')}
            </div>
            <div style={{ marginTop: 2, fontSize: 12.5, color: c.text, overflowWrap: 'break-word' }}>
              {reasonText}
            </div>
            {n && n.failures.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={() => setShowFailures(v => !v)}
                  style={{ fontSize: 12, color: c.link, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  {showFailures ? t('notice.hideFailures') : t('notice.showFailures', { n: n.failures.length })}
                </button>
                {showFailures && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {n.failures.map((f, i) => (
                      <li key={i} style={{ fontSize: 12, color: c.text }}>
                        <span style={{ fontWeight: 600 }}>{f.title || t('notice.unnamedTask')}</span>
                        {f.reason ? `：${f.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <Button size="sm" onClick={onContinue}
            style={agentJudged ? { background: OBS_PURPLE.accent, borderColor: OBS_PURPLE.accent } : undefined}
            onMouseEnter={agentJudged ? e => { const el = e.currentTarget as HTMLElement; el.style.background = OBS_PURPLE.accentHover; el.style.borderColor = OBS_PURPLE.accentHover } : undefined}
            onMouseLeave={agentJudged ? e => { const el = e.currentTarget as HTMLElement; el.style.background = OBS_PURPLE.accent; el.style.borderColor = OBS_PURPLE.accent } : undefined}>
            {/* agent 判死=任务已停止，按钮只是关栏露出输入框，别用「继续对话」暗示接着跑原任务 */}
            {agentJudged ? t('notice.dismiss') : t('notice.continue')}
          </Button>
        </div>
      </div>
    )
  }

  // INTERRUPTED：文案分型沿旧横幅语义（llm_outage 专属文案+红调），新增 CONTEXT_OVERFLOW/其他 code。
  const code = interruptReason || n?.reason_code || ''
  const isLlmOutage = code === 'llm_outage'
  const isOverflow = code === 'CONTEXT_OVERFLOW'
  const text = isLlmOutage ? t('llmError.interrupted')
    : isOverflow ? t('notice.overflowHint')
    : code ? t('notice.interruptedCode', { code })
    : t('chat.interruptedHint')
  const tint = isLlmOutage || isOverflow

  return (
    <div style={{ padding: '10px 14px 14px', flexShrink: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', flexWrap: 'wrap',
        borderRadius: 'var(--r)',
        border: `1px solid ${tint ? 'rgba(220,38,38,.3)' : 'rgba(138,163,191,.3)'}`,
        background: tint ? 'rgba(254,242,242,.7)' : 'rgba(234,240,251,.5)',
      }}>
        <span style={{ flex: 1, minWidth: 160, fontSize: 12.5, color: tint ? '#b91c1c' : 'var(--t2)' }}>
          {text}
        </span>
        {/* 换模型恢复对所有中断成因开放（llm_outage 换账号绕开故障供应商、重启后换更强模型
            续跑等都是合理诉求），不再限定 CONTEXT_OVERFLOW——溢出只是文案上特别提示。
            选择器沿用输入框同款 ModelPickerButton（账号+模型一次点选），默认勾选当前模型；
            会话跑在 env 默认账号时与输入框同显「默认模型」。 */}
        {providers.length > 0 && (
          <ModelPickerButton
            providers={providers}
            selectedProvider={llmAccount}
            selectedModel={llmModel}
            onChange={(p, m) => { setLlmAccount(p); setLlmModel(m) }}
          />
        )}
        <Button
          size="sm" disabled={resumePending}
          onClick={() => onResume(llmAccount
            ? { llm_account: llmAccount, ...(llmModel ? { llm_model: llmModel } : {}) }
            : undefined)}
        >
          {resumePending ? <Spinner className="h-3 w-3" /> : t('chat.resume')}
        </Button>
      </div>
    </div>
  )
}
