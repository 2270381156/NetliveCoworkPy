import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { XIcon, PlusIcon, Trash2Icon, StarIcon, Wand2Icon, ChevronLeftIcon, KeyRoundIcon, ServerIcon, CheckCircle2Icon, AlertCircleIcon, WifiIcon } from 'lucide-react'
import { llmsApi } from '@/api/llms'
import type { LLMProvider } from '@/types'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { useFirstVisitTour, llmTourSteps } from '@/hooks/useOnboarding'

export function LLMSettingsPage({ onClose }: { onClose?: () => void }) {
  const qc = useQueryClient()
  const { t, lang } = useI18n()
  const [view, setView] = useState<'list' | 'add'>('list')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // 首次进入大模型配置页跑一次引导（仅 list 视图）
  useFirstVisitTour('llm', llmTourSteps(lang), { enabled: view === 'list' })

  // 随包默认账号（locked）只在模型选择器出现、不进 LLM 配置页——这里过滤掉，用户无删/改入口。
  const { data: allProviders = [] } = useQuery({ queryKey: ['llms'], queryFn: () => llmsApi.list() })
  const providers = allProviders.filter(p => !p.locked)

  const deleteMut = useMutation({
    mutationFn: (name: string) => llmsApi.delete(name),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llms'] }); setConfirmDelete(null) },
  })

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg0)' }}>
      {/* Header */}
      <div style={{ background: 'var(--bg1)', borderBottom: '1px solid var(--border)' }}>
        <div className="px-6 pt-5 pb-4">
          {view === 'list' ? (
            <div className="flex items-center gap-2">
              {onClose && <CloseButton onClick={onClose} title={t('common.close')} />}
              <Wand2Icon size={16} style={{ color: 'var(--blue)' }} />
              <h1 className="text-base font-semibold" style={{ color: 'var(--t1)' }}>{t('llm.title')}</h1>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setView('list')}
                className="flex items-center gap-1 text-xs transition-colors"
                style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t1)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
              >
                <ChevronLeftIcon size={14} />{t('common.back')}
              </button>
              <span style={{ color: 'var(--border2)', fontSize: 12 }}>|</span>
              <h1 className="text-base font-semibold" style={{ color: 'var(--t1)' }}>{t('llm.addProvider')}</h1>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div data-tour="llm-list" className="flex-1 overflow-y-auto p-5">
        {view === 'add' ? (
          <AddProviderForm onDone={() => setView('list')} />
        ) : (
          <>
            <div data-tour="llm-add" className="flex justify-end mb-4">
              <Button size="sm" style={{ width: 150 }} onClick={() => setView('add')}>
                <PlusIcon size={13} />{t('llm.addProvider')}
              </Button>
            </div>
            {providers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Wand2Icon size={32} style={{ color: 'var(--t3)', opacity: .4 }} />
                <p className="text-sm font-medium" style={{ color: 'var(--t2)' }}>{t('llm.emptyTitle')}</p>
                <p className="text-xs" style={{ color: 'var(--t3)' }}>{t('llm.emptyDesc')}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {providers.map(p => (
                  <ProviderCard key={p.name} provider={p} onDelete={() => setConfirmDelete(p.name)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.4)', backdropFilter: 'blur(4px)' }}>
          <div className="w-80 p-5" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: '0 24px 80px rgba(15,31,61,.2)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Trash2Icon size={14} style={{ color: 'var(--red)' }} />
              <p className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('llm.deleteTitle')}</p>
            </div>
            <p className="mt-2 mb-5 text-xs leading-relaxed" style={{ color: 'var(--t2)' }}>
              {t('llm.deleteConfirmPre')}<span className="font-mono font-semibold" style={{ color: 'var(--t1)' }}>{confirmDelete}</span>{t('llm.deleteConfirmPost')}<br />
              {t('llm.deleteConfirmNote')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="sm" loading={deleteMut.isPending} onClick={() => deleteMut.mutate(confirmDelete)}>{t('common.delete')}</Button>
            </div>
          </div>
        </div>
      )}
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

// ── Provider Card ───────────────────────────────────────────────────────────

type ModelPingMap = Record<string, { state: 'idle' | 'loading' | 'ok' | 'error'; latency?: number; error?: string }>

function ProviderCard({ provider: p, onDelete }: { provider: LLMProvider; onDelete: () => void }) {
  const qc = useQueryClient()
  const { t } = useI18n()
  const [newModel, setNewModel] = useState('')
  const [addError, setAddError] = useState('')
  const [modelPings, setModelPings] = useState<ModelPingMap>({})

  // 添加模型：先 ping（含模型可用性），成功再持久化
  const addMut = useMutation({
    mutationFn: async (modelName: string) => {
      const pingResult = await llmsApi.pingRegistered(p.name, modelName)
      if (!pingResult.ok) throw new Error(pingResult.error || t('llm.connectFailed'))
      const provider = await llmsApi.addModel(p.name, modelName)
      return { provider, latency: pingResult.latency_ms }
    },
    onMutate: () => setAddError(''),
    onSuccess: ({ latency }, modelName) => {
      qc.invalidateQueries({ queryKey: ['llms'] })
      setNewModel('')
      setModelPings(prev => ({ ...prev, [modelName]: { state: 'ok', latency } }))
    },
    onError: (err: Error) => setAddError(err.message || t('llm.connectFailed')),
  })
  const removeModelMut = useMutation({
    mutationFn: (model: string) => llmsApi.removeModel(p.name, model),
    onSuccess: (_, model) => {
      qc.invalidateQueries({ queryKey: ['llms'] })
      setModelPings(prev => { const next = { ...prev }; delete next[model]; return next })
    },
  })
  const setDefaultMut = useMutation({
    mutationFn: (model: string) => llmsApi.setDefault(p.name, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llms'] }),
  })
  const pingMut = useMutation({
    mutationFn: (model: string) => llmsApi.pingRegistered(p.name, model),
    onMutate: (model) => setModelPings(prev => ({ ...prev, [model]: { state: 'loading' } })),
    onSuccess: (data, model) => setModelPings(prev => ({
      ...prev,
      [model]: data.ok
        ? { state: 'ok', latency: data.latency_ms }
        : { state: 'error', error: data.error || t('llm.connectFailed') },
    })),
    onError: (err: Error, model) => setModelPings(prev => ({ ...prev, [model]: { state: 'error', error: err.message || t('llm.connectFailed') } })),
  })

  const isOpenAI = p.style === 'openai'

  return (
    <div className="rounded-xl" style={{ border: '1px solid var(--border)', background: 'var(--bg1)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
      {/* Card header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{p.name}</p>
          <span className="rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0"
            style={{
              background: isOpenAI ? 'rgba(37,99,235,.09)' : 'rgba(217,119,6,.1)',
              color: isOpenAI ? 'var(--blue)' : 'var(--amber)',
            }}>
            {isOpenAI ? t('llm.openaiCompat') : 'Anthropic'}
          </span>
          {p.base_url && (
            <span className="flex items-center gap-0.5 text-xs truncate" style={{ color: 'var(--t3)' }}>
              <ServerIcon size={10} className="flex-shrink-0" />{p.base_url}
            </span>
          )}
        </div>
        <button
          onClick={onDelete}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-colors"
          style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.color = 'var(--red)'; el.style.background = 'rgba(220,38,38,.06)' }}
          onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.color = 'var(--t3)'; el.style.background = 'none' }}
        >
          <Trash2Icon size={12} />
        </button>
      </div>

      {/* Models section */}
      <div className="px-4 pb-3" style={{ borderTop: '1px solid var(--border)' }}>
        <p className="text-[11px] font-semibold mt-2.5 mb-2" style={{ color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{t('llm.models')}</p>

        {p.models.length > 0 && (
          <div className="flex flex-wrap items-start gap-1.5 mb-2">
            {p.models.map(m => {
              const isDefault = m.name === p.default_model
              const ping = modelPings[m.name] ?? { state: 'idle' }
              const isPinging = ping.state === 'loading' && pingMut.variables === m.name && pingMut.isPending
              return (
                <div key={m.name} className="flex flex-col gap-1" style={{ width: 184, flexShrink: 0 }}>
                  <div
                    className="group flex items-center gap-1 rounded-md px-2 py-1 text-xs w-full min-w-0"
                    style={{
                      background: isDefault ? 'rgba(37,99,235,.07)' : 'var(--bg2)',
                      border: `1px solid ${ping.state === 'ok' ? 'rgba(22,163,74,.25)' : ping.state === 'error' ? 'rgba(220,38,38,.25)' : isDefault ? 'rgba(37,99,235,.18)' : 'var(--border)'}`,
                      color: isDefault ? 'var(--blue)' : 'var(--t2)',
                    }}
                  >
                    <StarIcon
                      size={9}
                      fill={isDefault ? 'currentColor' : 'none'}
                      className="cursor-pointer flex-shrink-0"
                      style={{ color: isDefault ? 'var(--amber)' : 'var(--t3)' }}
                      onClick={() => !isDefault && setDefaultMut.mutate(m.name)}
                    />
                    <span className="font-mono text-xs truncate flex-1 min-w-0" title={m.name}>{m.name}</span>
                    {/* Ping 状态 */}
                    {ping.state === 'ok' && (
                      <span className="flex items-center gap-0.5 ml-0.5" style={{ color: 'var(--green, #16a34a)' }}>
                        <CheckCircle2Icon size={9} />
                        <span style={{ fontSize: 10 }}>{ping.latency}ms</span>
                      </span>
                    )}
                    {ping.state === 'error' && (
                      <AlertCircleIcon size={9} className="ml-0.5 flex-shrink-0" style={{ color: 'var(--red)' }} />
                    )}
                    {/* Ping 按钮 */}
                    <button
                      onClick={() => pingMut.mutate(m.name)}
                      disabled={isPinging}
                      title={t('llm.testConnection')}
                      className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 flex-shrink-0"
                      style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: isPinging ? 'default' : 'pointer', lineHeight: 0, padding: 0, opacity: isPinging ? 0.4 : undefined }}
                    >
                      <WifiIcon size={9} />
                    </button>
                    <button
                      onClick={() => removeModelMut.mutate(m.name)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 0, padding: 0 }}
                    >
                      <XIcon size={9} />
                    </button>
                  </div>
                  {ping.state === 'error' && ping.error && (
                    <p className="text-xs rounded px-2 py-1 ml-1 leading-relaxed" style={{ color: 'var(--red)', background: 'rgba(220,38,38,.06)', border: '1px solid rgba(220,38,38,.12)' }}>
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
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  const name = newModel.trim()
                  if (name && !p.models.some(m => m.name === name) && !addMut.isPending)
                    addMut.mutate(name)
                }
              }}
              placeholder={t('llm.modelNamePlaceholder')}
              className="h-7 flex-1 rounded-md border px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
              style={{ borderColor: addError ? 'rgba(220,38,38,.5)' : 'var(--border)', background: 'var(--bg2)', color: 'var(--t1)' }}
            />
            <Button
              size="sm"
              variant="outline"
              loading={addMut.isPending}
              disabled={!newModel.trim() || p.models.some(m => m.name === newModel.trim())}
              onClick={() => addMut.mutate(newModel.trim())}
            >
              <PlusIcon size={11} />{t('llm.verifyAndAdd')}
            </Button>
          </div>
          {addError && (
            <div className="flex items-start gap-2 text-xs rounded px-2 py-1 leading-relaxed" style={{ color: 'var(--red)', background: 'rgba(220,38,38,.06)', border: '1px solid rgba(220,38,38,.12)' }}>
              <span className="flex-1 min-w-0 break-words">{addError}</span>
              <button onClick={() => setAddError('')} title={t('common.close')} className="flex-shrink-0" style={{ color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 0, padding: 0, opacity: 0.7 }}>
                <XIcon size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Add Provider Form ───────────────────────────────────────────────────────

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const { t } = useI18n()
  const [form, setForm] = useState({ name: '', style: 'openai' as 'openai' | 'anthropic', api_key: '', base_url: '' })
  const [models, setModels] = useState<{ name: string; isDefault: boolean }[]>([])
  const [newModel, setNewModel] = useState('')
  const [modelPings, setModelPings] = useState<ModelPingMap>({})
  const [addError, setAddError] = useState('')

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

  // 添加时先 ping，成功才入列表
  const addMut = useMutation({
    mutationFn: (modelName: string) => llmsApi.ping({
      style: form.style,
      api_key: form.api_key.trim(),
      base_url: form.base_url.trim() || undefined,
      model: modelName,
    }),
    onMutate: () => setAddError(''),
    onSuccess: (data, modelName) => {
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
  })

  const defaultModel = models.find(m => m.isDefault)?.name || models[0]?.name

  const mut = useMutation({
    mutationFn: () => llmsApi.register({
      name: form.name.trim(),
      style: form.style,
      api_key: form.api_key.trim(),
      base_url: form.base_url.trim() || undefined,
      models: models.map(m => ({ name: m.name })),
      default_model: defaultModel,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llms'] }); onDone() },
  })

  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--bg1)', boxShadow: 'var(--shadow)' }}>
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

        <div style={{ borderTop: '1px solid var(--border)' }} />

        {/* 认证与端点 */}
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center gap-1.5 mb-0.5">
            <KeyRoundIcon size={11} style={{ color: 'var(--t3)' }} />
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--t3)' }}>{t('llm.authEndpoint')}</span>
          </div>
          <Input label="API Key" type="password" value={form.api_key} onChange={e => set('api_key', e.target.value)} placeholder="sk-..." />
          <Input label={t('llm.baseUrlOptional')} value={form.base_url} onChange={e => set('base_url', e.target.value)} placeholder="https://api.openai.com/v1" />
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} />

        {/* 模型 */}
        <div className="p-4 flex flex-col gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--t3)' }}>{t('llm.models')}</span>
          {models.length > 0 && (
            <div className="flex flex-wrap items-start gap-1.5">
              {models.map(m => {
                const ping = modelPings[m.name] ?? { state: 'idle' }
                return (
                  <div
                    key={m.name}
                    className="group flex items-center gap-1 rounded-md px-2 py-1 text-xs min-w-0"
                    style={{
                      width: 184,
                      flexShrink: 0,
                      background: m.isDefault ? 'rgba(37,99,235,.07)' : 'var(--bg2)',
                      border: `1px solid ${m.isDefault ? 'rgba(37,99,235,.18)' : 'var(--border)'}`,
                      color: m.isDefault ? 'var(--blue)' : 'var(--t2)',
                    }}
                  >
                    <StarIcon
                      size={9}
                      fill={m.isDefault ? 'currentColor' : 'none'}
                      className="cursor-pointer flex-shrink-0"
                      style={{ color: m.isDefault ? 'var(--amber)' : 'var(--t3)' }}
                      onClick={() => !m.isDefault && setDefault(m.name)}
                    />
                    <span className="font-mono text-xs truncate flex-1 min-w-0" title={m.name}>{m.name}</span>
                    <span className="flex items-center gap-0.5 ml-0.5" style={{ color: 'var(--green, #16a34a)' }}>
                      <CheckCircle2Icon size={9} />
                      <span style={{ fontSize: 10 }}>{ping.latency}ms</span>
                    </span>
                    <button
                      onClick={() => removeModel(m.name)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 0, padding: 0 }}
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
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    const name = newModel.trim()
                    if (name && !models.some(m => m.name === name) && form.api_key.trim() && !addMut.isPending)
                      addMut.mutate(name)
                  }
                }}
                placeholder={t('llm.modelNamePlaceholder')}
                className="h-7 flex-1 rounded-md border px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
                style={{ borderColor: addError ? 'rgba(220,38,38,.5)' : 'var(--border)', background: 'var(--bg2)', color: 'var(--t1)' }}
              />
              <Button
                size="sm"
                variant="outline"
                loading={addMut.isPending}
                disabled={!newModel.trim() || models.some(m => m.name === newModel.trim()) || !form.api_key.trim()}
                onClick={() => addMut.mutate(newModel.trim())}
              >
                <PlusIcon size={11} />{t('llm.verifyAndAdd')}
              </Button>
            </div>
            {addError && (
              <div className="flex items-start gap-2 text-xs rounded px-2 py-1 leading-relaxed" style={{ color: 'var(--red)', background: 'rgba(220,38,38,.06)', border: '1px solid rgba(220,38,38,.12)' }}>
                <span className="flex-1 min-w-0 break-words">{addError}</span>
                <button onClick={() => setAddError('')} title={t('common.close')} className="flex-shrink-0" style={{ color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 0, padding: 0, opacity: 0.7 }}>
                  <XIcon size={12} />
                </button>
              </div>
            )}
          </div>
          {models.length > 0 && (
            <p className="text-xs" style={{ color: 'var(--t3)' }}>{t('llm.defaultHint')}</p>
          )}
        </div>
      </div>

      {mut.isError && (
        <p className="text-xs px-1" style={{ color: 'var(--red)' }}>{mut.error?.message}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>{t('common.cancel')}</Button>
        <Button
          disabled={!form.name.trim() || !form.api_key.trim() || models.length === 0 || mut.isPending}
          loading={mut.isPending}
          onClick={() => mut.mutate()}
        >
          {t('llm.saveProvider')}
        </Button>
      </div>
    </div>
  )
}
