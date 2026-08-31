import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, MessageSquarePlus, RotateCcw, XCircle } from 'lucide-react'
import { llmsApi } from '@/api/llms'
import type { SessionNotice } from '@/hooks/useSessionSSE'

// INTERRUPTED 成因 → 人话文案；未知 code 走模板，无 code 沿旧文案（存量会话无 notice）。
const INTERRUPT_TEXT: Record<string, string> = {
  llm_outage: 'LLM 连接中断，任务已挂起',
  CONTEXT_OVERFLOW: '上下文超出模型窗口，建议换更大窗口的模型后恢复',
}

function interruptText(notice: SessionNotice | null): string {
  if (!notice || !notice.reason_code) return '服务重启导致任务中断'
  return INTERRUPT_TEXT[notice.reason_code] ?? `服务异常导致任务中断（${notice.reason_code}）`
}

export function SessionNoticeBar({
  status,
  notice,
  onContinue,
  onResume,
  resumePending,
}: {
  status: 'FAILED' | 'INTERRUPTED'
  notice: SessionNotice | null
  onContinue: () => void
  onResume: (llm?: { llm_account?: string; llm_model?: string }) => void
  resumePending: boolean
}) {
  // kind 与当前状态不匹配的陈旧 notice（如中断→恢复→失败的旧帧）不当作素材。
  const wanted = status === 'FAILED' ? 'failed' : 'interrupted'
  const n = notice && notice.kind === wanted ? notice : null

  const [showFailures, setShowFailures] = useState(false)
  const [llmAccount, setLlmAccount] = useState('')
  const [llmModel, setLlmModel] = useState('')
  const { data: llms = [] } = useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })
  const selectedProvider = llms.find(l => l.name === llmAccount)

  if (status === 'FAILED') {
    return (
      <div className="border-t border-red-200 bg-red-50 p-3">
        <div className="flex items-start gap-2">
          <XCircle size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-red-700">会话失败</p>
            <p className="mt-0.5 text-xs text-red-600 break-words">
              {n?.reason_text || '会话失败'}
            </p>
            {n && n.failures.length > 0 && (
              <div className="mt-1.5">
                <button
                  onClick={() => setShowFailures(v => !v)}
                  className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 transition-colors"
                >
                  {showFailures ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  查看 {n.failures.length} 条失败记录
                </button>
                {showFailures && (
                  <ul className="mt-1 space-y-1">
                    {n.failures.map((f, i) => (
                      <li key={i} className="text-xs text-red-600 pl-4">
                        <span className="font-medium">{f.title || '（未命名任务）'}</span>
                        {f.reason ? `：${f.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onContinue}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs hover:bg-red-600 transition-colors flex-shrink-0"
          >
            <MessageSquarePlus size={12} />
            继续对话
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-orange-200 bg-orange-50 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-orange-700 flex-1 min-w-0">{interruptText(n)}</span>
        {n?.reason_code === 'CONTEXT_OVERFLOW' && (
          <>
            <select
              value={llmAccount}
              onChange={e => { setLlmAccount(e.target.value); setLlmModel('') }}
              className="text-xs border border-orange-200 rounded px-1.5 py-0.5 text-gray-600 bg-white focus:outline-none focus:border-orange-400"
            >
              <option value="">沿用当前账号</option>
              {llms.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
            </select>
            {selectedProvider && selectedProvider.models.length > 0 && (
              <select
                value={llmModel}
                onChange={e => setLlmModel(e.target.value)}
                className="text-xs border border-orange-200 rounded px-1.5 py-0.5 text-gray-600 bg-white focus:outline-none focus:border-orange-400"
              >
                <option value="">默认（{selectedProvider.default_model}）</option>
                {selectedProvider.models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            )}
          </>
        )}
        <button
          onClick={() => onResume(llmAccount
            ? { llm_account: llmAccount, ...(llmModel ? { llm_model: llmModel } : {}) }
            : undefined)}
          disabled={resumePending}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-orange-500 text-white text-xs hover:bg-orange-600 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          {resumePending ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          恢复会话
        </button>
      </div>
    </div>
  )
}
