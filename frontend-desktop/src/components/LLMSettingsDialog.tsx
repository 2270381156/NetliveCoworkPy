import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { XIcon, PlusIcon, Trash2Icon, StarIcon } from 'lucide-react'
import { llmsApi } from '@/api/llms'
import type { LLMProvider } from '@/types'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'

interface Props { open: boolean; onClose: () => void }

export function LLMSettingsDialog({ open, onClose }: Props) {
  const qc = useQueryClient()
  const [view, setView] = useState<'list' | 'add'>('list')
  const { data: providers = [] } = useQuery({ queryKey: ['llms'], queryFn: () => llmsApi.list() })

  const deleteMut = useMutation({
    mutationFn: (name: string) => llmsApi.delete(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llms'] }),
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[500px] max-h-[80vh] flex flex-col rounded-xl border border-gray-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">LLM 配置</h2>
          <div className="flex items-center gap-2">
            {view === 'list' && (
              <Button size="sm" onClick={() => setView('add')}>
                <PlusIcon size={13} /> 添加 Provider
              </Button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {view === 'add' ? (
            <AddProviderForm onDone={() => setView('list')} />
          ) : providers.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">尚未配置任何 LLM Provider</p>
          ) : (
            <div className="flex flex-col gap-3">
              {providers.map(p => (
                <ProviderCard key={p.name} provider={p} onDelete={() => deleteMut.mutate(p.name)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProviderCard({ provider: p, onDelete }: { provider: LLMProvider; onDelete: () => void }) {
  const qc = useQueryClient()
  const [newModel, setNewModel] = useState('')
  const addModelMut = useMutation({
    mutationFn: () => llmsApi.addModel(p.name, newModel.trim()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llms'] }); setNewModel('') },
  })
  const removeModelMut = useMutation({
    mutationFn: (model: string) => llmsApi.removeModel(p.name, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llms'] }),
  })
  const setDefaultMut = useMutation({
    mutationFn: (model: string) => llmsApi.setDefault(p.name, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llms'] }),
  })

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">{p.name}</p>
          <p className="text-xs text-gray-500">{p.style} · {p.base_url || '默认端点'}</p>
        </div>
        <button onClick={onDelete} className="text-gray-400 hover:text-red-500">
          <Trash2Icon size={13} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {p.models.map(m => (
          <div key={m.name} className="group flex items-center gap-1 rounded bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-700">
            {m.name === p.default_model && <StarIcon size={10} className="text-amber-500" />}
            <span>{m.name}</span>
            <button onClick={() => setDefaultMut.mutate(m.name)} className="invisible text-gray-400 hover:text-amber-500 group-hover:visible" title="设为默认">
              <StarIcon size={10} />
            </button>
            <button onClick={() => removeModelMut.mutate(m.name)} className="invisible text-gray-400 hover:text-red-500 group-hover:visible">
              <XIcon size={10} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={newModel}
          onChange={e => setNewModel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && newModel.trim()) addModelMut.mutate() }}
          placeholder="添加模型名称，回车确认"
          className="h-7 flex-1 rounded border border-gray-300 bg-white px-2 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <Button size="sm" variant="outline" disabled={!newModel.trim()} onClick={() => addModelMut.mutate()}>添加</Button>
      </div>
    </div>
  )
}

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({ name: '', style: 'openai' as 'openai' | 'anthropic', api_key: '', base_url: '' })
  const [models, setModels] = useState<{ name: string; isDefault: boolean }[]>([])
  const [newModel, setNewModel] = useState('')
  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }))

  const addModel = () => {
    const name = newModel.trim()
    if (!name || models.some(m => m.name === name)) return
    setModels(prev => [...prev, { name, isDefault: prev.length === 0 }])
    setNewModel('')
  }

  const removeModel = (name: string) => {
    setModels(prev => {
      const next = prev.filter(m => m.name !== name)
      if (next.length > 0 && !next.some(m => m.isDefault)) next[0].isDefault = true
      return next
    })
  }

  const setDefault = (name: string) =>
    setModels(prev => prev.map(m => ({ ...m, isDefault: m.name === name })))

  const defaultModel = models.find(m => m.isDefault)?.name

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
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Input label="名称" value={form.name} onChange={e => set('name', e.target.value)} placeholder="my-provider" />
        <Select label="类型" value={form.style} onChange={e => set('style', e.target.value as 'openai' | 'anthropic')}>
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic</option>
        </Select>
      </div>
      <Input label="API Key" type="password" value={form.api_key} onChange={e => set('api_key', e.target.value)} placeholder="sk-..." />
      <Input label="Base URL（可选）" value={form.base_url} onChange={e => set('base_url', e.target.value)} placeholder="https://api.openai.com/v1" />

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-gray-700">模型</label>
        {models.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {models.map(m => (
              <div key={m.name} className="group flex items-center gap-1 rounded bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-700">
                {m.isDefault && <StarIcon size={10} className="text-amber-500" />}
                <span>{m.name}</span>
                {!m.isDefault && (
                  <button onClick={() => setDefault(m.name)} className="invisible text-gray-400 hover:text-amber-500 group-hover:visible" title="设为默认">
                    <StarIcon size={10} />
                  </button>
                )}
                <button onClick={() => removeModel(m.name)} className="invisible text-gray-400 hover:text-red-500 group-hover:visible">
                  <XIcon size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={newModel}
            onChange={e => setNewModel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addModel() }}
            placeholder="输入模型名称，回车添加"
            className="h-7 flex-1 rounded border border-gray-300 bg-white px-2 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
          <Button size="sm" variant="outline" disabled={!newModel.trim()} onClick={addModel}>添加</Button>
        </div>
      </div>

      {mut.isError && <p className="text-xs text-red-500">{mut.error?.message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>取消</Button>
        <Button disabled={!form.name.trim() || !form.api_key.trim() || mut.isPending} loading={mut.isPending} onClick={() => mut.mutate()}>保存</Button>
      </div>
    </div>
  )
}
