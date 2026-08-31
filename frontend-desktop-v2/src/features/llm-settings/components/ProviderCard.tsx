import { useState } from 'react'
import { XIcon, PlusIcon, Trash2Icon, StarIcon, ServerIcon, CheckCircle2Icon, AlertCircleIcon, WifiIcon } from 'lucide-react'
import type { LLMProvider } from '@/shared/types'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useAddModel, useRemoveModel, useSetDefaultModel, usePingModel } from '../api/hooks'

export type ModelPingMap = Record<string, { state: 'idle' | 'loading' | 'ok' | 'error'; latency?: number; error?: string }>

export function ProviderCard({ provider: p, onDelete }: { provider: LLMProvider; onDelete: () => void }) {
  const { t } = useI18n()
  const [newModel, setNewModel] = useState('')
  const [addError, setAddError] = useState('')
  const [modelPings, setModelPings] = useState<ModelPingMap>({})

  const addMut = useAddModel(p.name)
  const removeModelMut = useRemoveModel(p.name)
  const setDefaultMut = useSetDefaultModel(p.name)
  const pingMut = usePingModel(p.name)

  function addModel(name: string) {
    setAddError('')
    addMut.mutate(name, {
      onSuccess: ({ latency }) => {
        setNewModel('')
        setModelPings(prev => ({ ...prev, [name]: { state: 'ok', latency } }))
      },
      onError: (err: Error) => setAddError(err.message || t('llm.connectFailed')),
    })
  }
  function removeModel(model: string) {
    removeModelMut.mutate(model, {
      onSuccess: () => setModelPings(prev => { const next = { ...prev }; delete next[model]; return next }),
    })
  }
  function pingModel(model: string) {
    setModelPings(prev => ({ ...prev, [model]: { state: 'loading' } }))
    pingMut.mutate(model, {
      onSuccess: (data) => setModelPings(prev => ({
        ...prev,
        [model]: data.ok
          ? { state: 'ok', latency: data.latency_ms }
          : { state: 'error', error: data.error || t('llm.connectFailed') },
      })),
      onError: (err: Error) => setModelPings(prev => ({ ...prev, [model]: { state: 'error', error: err.message || t('llm.connectFailed') } })),
    })
  }

  const isOpenAI = p.style === 'openai'

  return (
    <div className="rounded-xl overflow-hidden border border-border bg-bg1 shadow-[var(--shadow)]">
      {/* Card header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold text-t1">{p.name}</p>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0 ${isOpenAI ? 'bg-[rgba(37,99,235,0.09)] text-blue' : 'bg-[rgba(217,119,6,0.1)] text-amber'}`}>
            {isOpenAI ? t('llm.openaiCompat') : 'Anthropic'}
          </span>
          {p.base_url && (
            <span className="flex items-center gap-0.5 text-xs truncate text-t3">
              <ServerIcon size={10} className="flex-shrink-0" />{p.base_url}
            </span>
          )}
        </div>
        <button
          onClick={onDelete}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-colors cursor-pointer text-t3 hover:text-red hover:bg-[rgba(220,38,38,0.06)]"
        >
          <Trash2Icon size={12} />
        </button>
      </div>

      {/* Models section */}
      <div className="px-4 pb-3 border-t border-border">
        <p className="text-[11px] font-semibold mt-2.5 mb-2 text-t3 uppercase tracking-[0.07em]">{t('llm.models')}</p>

        {p.models.length > 0 && (
          <div className="flex flex-wrap items-start gap-1.5 mb-2">
            {p.models.map(m => {
              const isDefault = m.name === p.default_model
              const ping = modelPings[m.name] ?? { state: 'idle' as const }
              const isPinging = ping.state === 'loading' && pingMut.variables === m.name && pingMut.isPending
              const borderCls = ping.state === 'ok' ? 'border-[rgba(22,163,74,0.25)]'
                : ping.state === 'error' ? 'border-[rgba(220,38,38,0.25)]'
                : isDefault ? 'border-[rgba(37,99,235,0.18)]' : 'border-border'
              return (
                <div key={m.name} className="flex flex-col gap-1 w-[184px] flex-shrink-0">
                  <div className={`group flex items-center gap-1 rounded-md px-2 py-1 text-xs w-full min-w-0 border ${borderCls} ${isDefault ? 'bg-[rgba(37,99,235,0.07)] text-blue' : 'bg-bg2 text-t2'}`}>
                    <StarIcon
                      size={9}
                      fill={isDefault ? 'currentColor' : 'none'}
                      className={`cursor-pointer flex-shrink-0 ${isDefault ? 'text-amber' : 'text-t3'}`}
                      onClick={() => !isDefault && setDefaultMut.mutate(m.name)}
                    />
                    <span className="font-mono text-xs truncate flex-1 min-w-0" title={m.name}>{m.name}</span>
                    {/* Ping 状态 */}
                    {ping.state === 'ok' && (
                      <span className="flex items-center gap-0.5 ml-0.5 text-green">
                        <CheckCircle2Icon size={9} />
                        <span className="text-[10px]">{ping.latency}ms</span>
                      </span>
                    )}
                    {ping.state === 'error' && (
                      <AlertCircleIcon size={9} className="ml-0.5 flex-shrink-0 text-red" />
                    )}
                    {/* Ping 按钮 */}
                    <button
                      onClick={() => pingModel(m.name)}
                      disabled={isPinging}
                      title={t('llm.testConnection')}
                      className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 flex-shrink-0 text-t3 leading-none p-0 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                    >
                      <WifiIcon size={9} />
                    </button>
                    <button
                      onClick={() => removeModel(m.name)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-t3 leading-none p-0 cursor-pointer"
                    >
                      <XIcon size={9} />
                    </button>
                  </div>
                  {ping.state === 'error' && ping.error && (
                    <p className="text-xs rounded px-2 py-1 ml-1 leading-relaxed text-red bg-[rgba(220,38,38,0.06)] border border-[rgba(220,38,38,0.12)]">
                      {ping.error}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <input
              value={newModel}
              onChange={e => { setNewModel(e.target.value); setAddError('') }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const name = newModel.trim()
                  if (name && !p.models.some(m => m.name === name) && !addMut.isPending) addModel(name)
                }
              }}
              placeholder={t('llm.modelNamePlaceholder')}
              className={`h-7 flex-1 rounded-md border px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-bg2 text-t1 ${addError ? 'border-[rgba(220,38,38,0.5)]' : 'border-border'}`}
            />
            <Button
              size="sm"
              variant="outline"
              loading={addMut.isPending}
              disabled={!newModel.trim() || p.models.some(m => m.name === newModel.trim())}
              onClick={() => addModel(newModel.trim())}
            >
              <PlusIcon size={11} />{t('llm.verifyAndAdd')}
            </Button>
          </div>
          {addError && (
            <div className="flex items-start gap-2 text-xs rounded px-2 py-1 leading-relaxed text-red bg-[rgba(220,38,38,0.06)] border border-[rgba(220,38,38,0.12)]">
              <span className="flex-1 min-w-0 break-words">{addError}</span>
              <button onClick={() => setAddError('')} title={t('common.close')} className="flex-shrink-0 text-red leading-none p-0 cursor-pointer opacity-70">
                <XIcon size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
