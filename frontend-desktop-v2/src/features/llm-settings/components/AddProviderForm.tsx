import { useState } from 'react'
import { XIcon, PlusIcon, StarIcon, KeyRoundIcon, CheckCircle2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { usePingAdhoc, useRegisterProvider } from '../api/hooks'
import type { ModelPingMap } from './ProviderCard'

export function AddProviderForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
  const [form, setForm] = useState({ name: '', style: 'openai' as 'openai' | 'anthropic', api_key: '', base_url: '' })
  const [models, setModels] = useState<{ name: string; isDefault: boolean }[]>([])
  const [newModel, setNewModel] = useState('')
  const [modelPings, setModelPings] = useState<ModelPingMap>({})
  const [addError, setAddError] = useState('')

  const pingAdhoc = usePingAdhoc()
  const registerMut = useRegisterProvider()

  const set = (k: keyof typeof form, v: string) => {
    setForm(f => ({ ...f, [k]: v }))
    if (k === 'api_key' || k === 'base_url' || k === 'style') {
      setModels([])
      setModelPings({})
      setAddError('')
    }
  }

  const removeModel = (name: string) => {
    setModels(prev => {
      const next = prev.filter(m => m.name !== name)
      if (next.length > 0 && !next.some(m => m.isDefault)) next[0].isDefault = true
      return next
    })
    setModelPings(prev => { const next = { ...prev }; delete next[name]; return next })
  }

  const setDefault = (name: string) =>
    setModels(prev => prev.map(m => ({ ...m, isDefault: m.name === name })))

  function addModel(modelName: string) {
    setAddError('')
    pingAdhoc.mutate(
      { style: form.style, api_key: form.api_key.trim(), base_url: form.base_url.trim() || undefined, model: modelName },
      {
        onSuccess: (data) => {
          if (!data.ok) {
            const error = data.error || t('llm.connectFailed')
            setAddError(error)
            setModelPings(prev => ({ ...prev, [modelName]: { state: 'error', error } }))
            return
          }
          setModels(prev => [...prev, { name: modelName, isDefault: prev.length === 0 }])
          setModelPings(prev => ({ ...prev, [modelName]: { state: 'ok', latency: data.latency_ms } }))
          setNewModel('')
        },
        onError: (err: Error) => setAddError(err.message || t('llm.connectFailed')),
      },
    )
  }

  const defaultModel = models.find(m => m.isDefault)?.name || models[0]?.name

  function save() {
    registerMut.mutate(
      {
        name: form.name.trim(),
        style: form.style,
        api_key: form.api_key.trim(),
        base_url: form.base_url.trim() || undefined,
        models: models.map(m => ({ name: m.name })),
        default_model: defaultModel,
      },
      { onSuccess: onDone },
    )
  }

  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <div className="rounded-xl overflow-hidden border border-border bg-bg1 shadow-[var(--shadow)]">
        {/* 基本信息 */}
        <div className="p-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Input label={t('llm.name')} value={form.name} onChange={e => set('name', e.target.value)} placeholder={t('llm.namePlaceholder')} />
            <Select label={t('llm.type')} value={form.style} onChange={e => set('style', e.target.value as 'openai' | 'anthropic')}>
              <option value="openai">{t('llm.openaiCompat')}</option>
              <option value="anthropic">Anthropic</option>
            </Select>
          </div>
        </div>

        <div className="border-t border-border" />

        {/* 认证与端点 */}
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center gap-1.5 mb-0.5">
            <KeyRoundIcon size={11} className="text-t3" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-t3">{t('llm.authEndpoint')}</span>
          </div>
          <Input label="API Key" type="password" value={form.api_key} onChange={e => set('api_key', e.target.value)} placeholder="sk-..." />
          <Input label={t('llm.baseUrlOptional')} value={form.base_url} onChange={e => set('base_url', e.target.value)} placeholder="https://api.openai.com/v1" />
        </div>

        <div className="border-t border-border" />

        {/* 模型 */}
        <div className="p-4 flex flex-col gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-t3">{t('llm.models')}</span>
          {models.length > 0 && (
            <div className="flex flex-wrap items-start gap-1.5">
              {models.map(m => {
                const ping = modelPings[m.name] ?? { state: 'idle' as const }
                return (
                  <div
                    key={m.name}
                    className={`group flex items-center gap-1 rounded-md px-2 py-1 text-xs min-w-0 w-[184px] flex-shrink-0 border ${m.isDefault ? 'border-[rgba(37,99,235,0.18)] bg-[rgba(37,99,235,0.07)] text-blue' : 'border-border bg-bg2 text-t2'}`}
                  >
                    <StarIcon
                      size={9}
                      fill={m.isDefault ? 'currentColor' : 'none'}
                      className={`cursor-pointer flex-shrink-0 ${m.isDefault ? 'text-amber' : 'text-t3'}`}
                      onClick={() => !m.isDefault && setDefault(m.name)}
                    />
                    <span className="font-mono text-xs truncate flex-1 min-w-0" title={m.name}>{m.name}</span>
                    <span className="flex items-center gap-0.5 ml-0.5 text-green">
                      <CheckCircle2Icon size={9} />
                      <span className="text-[10px]">{ping.latency}ms</span>
                    </span>
                    <button
                      onClick={() => removeModel(m.name)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-t3 leading-none p-0 cursor-pointer"
                    >
                      <XIcon size={9} />
                    </button>
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
                    if (name && !models.some(m => m.name === name) && form.api_key.trim() && !pingAdhoc.isPending) addModel(name)
                  }
                }}
                placeholder={t('llm.modelNamePlaceholder')}
                className={`h-7 flex-1 rounded-md border px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-bg2 text-t1 ${addError ? 'border-[rgba(220,38,38,0.5)]' : 'border-border'}`}
              />
              <Button
                size="sm"
                variant="outline"
                loading={pingAdhoc.isPending}
                disabled={!newModel.trim() || models.some(m => m.name === newModel.trim()) || !form.api_key.trim()}
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
          {models.length > 0 && (
            <p className="text-xs text-t3">{t('llm.defaultHint')}</p>
          )}
        </div>
      </div>

      {registerMut.isError && (
        <p className="text-xs px-1 text-red">{registerMut.error?.message}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>{t('common.cancel')}</Button>
        <Button
          disabled={!form.name.trim() || !form.api_key.trim() || models.length === 0 || registerMut.isPending}
          loading={registerMut.isPending}
          onClick={save}
        >
          {t('llm.saveProvider')}
        </Button>
      </div>
    </div>
  )
}
