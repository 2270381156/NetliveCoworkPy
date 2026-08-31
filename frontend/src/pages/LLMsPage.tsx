import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, AlertTriangle, KeyRound, Cpu, Star, X } from 'lucide-react'
import { llmsApi } from '@/api/llms'
import type { LLMAccount, ModelConfig, RegisterLLMAccountRequest, LLMStyle } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'

function formatCtx(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// ── 注册 Account 弹窗 ─────────────────────────────────────────────────────────

function RegisterAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<RegisterLLMAccountRequest>({
    name: '',
    style: 'anthropic',
    api_key: '',
    base_url: '',
    models: [],
    default_model: '',
    timeout_sec: 120,
  })
  const [modelName, setModelName] = useState('')
  const [modelCtxLimit, setModelCtxLimit] = useState('')
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({})

  const mutation = useMutation({
    mutationFn: llmsApi.register,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llms'] })
      onClose()
      setForm({ name: '', style: 'anthropic', api_key: '', base_url: '', models: [], default_model: '', timeout_sec: 120 })
      setModelName('')
      setModelCtxLimit('')
      setErrors({})
    },
  })

  function addModel() {
    const name = modelName.trim()
    if (!name || form.models?.some(m => m.name === name)) return
    const ctx = modelCtxLimit.trim() ? Number(modelCtxLimit.trim()) : undefined
    const models = [...(form.models ?? []), { name, context_limit: ctx ?? null }]
    setForm(f => ({ ...f, models, default_model: f.default_model || name }))
    setModelName('')
    setModelCtxLimit('')
  }

  function removeModel(name: string) {
    const models = (form.models ?? []).filter(m => m.name !== name)
    setForm(f => ({
      ...f,
      models,
      default_model: f.default_model === name ? (models[0]?.name ?? '') : f.default_model,
    }))
  }

  function validate() {
    const errs: typeof errors = {}
    if (!form.name.trim()) errs.name = '请输入名称'
    if (!form.api_key.trim()) errs.api_key = '请输入 API Key'
    if (!form.models?.length) errs.models = '至少添加一个模型'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSubmit() {
    if (!validate()) return
    mutation.mutate(form)
  }

  return (
    <Dialog open={open} onClose={onClose} title="注册 LLM Account" size="md">
      <div className="flex flex-col gap-4">
        <Input
          label="名称 *"
          placeholder="claude"
          value={form.name}
          onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
          error={errors.name}
        />
        <Select
          label="类型 *"
          value={form.style}
          onChange={(e) => setForm(f => ({ ...f, style: e.target.value as LLMStyle }))}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI 兼容</option>
        </Select>
        <Input
          label="API Key *"
          type="password"
          placeholder="sk-..."
          value={form.api_key}
          onChange={(e) => setForm(f => ({ ...f, api_key: e.target.value }))}
          error={errors.api_key}
        />
        <Input
          label="Base URL"
          placeholder="留空使用官方默认地址"
          value={form.base_url ?? ''}
          onChange={(e) => setForm(f => ({ ...f, base_url: e.target.value }))}
        />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">模型 *</label>
          <div className="flex gap-2">
            <input
              className="flex-1 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={form.style === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6'}
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addModel())}
            />
            <input
              className="w-28 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Context（默认）"
              type="number"
              value={modelCtxLimit}
              onChange={(e) => setModelCtxLimit(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addModel())}
            />
            <Button size="sm" variant="secondary" onClick={addModel}>添加</Button>
          </div>
          {errors.models && <p className="text-xs text-red-500 mt-1">{errors.models}</p>}
          {!!form.models?.length && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {form.models.map(m => (
                <span
                  key={m.name}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border cursor-pointer
                    ${m.name === form.default_model
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-gray-50 border-gray-200 text-gray-600 hover:border-blue-300'}`}
                  onClick={() => setForm(f => ({ ...f, default_model: m.name }))}
                  title="点击设为默认"
                >
                  {m.name === form.default_model && <Star size={10} className="text-blue-500" />}
                  {m.name}
                  {m.context_limit != null && (
                    <span className="text-gray-400 ml-0.5">· {formatCtx(m.context_limit)}</span>
                  )}
                  <button
                    className="ml-0.5 hover:text-red-500"
                    onClick={(e) => { e.stopPropagation(); removeModel(m.name) }}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-400 mt-1">点击模型标签设为默认（蓝色 ★）</p>
        </div>

        <Input
          label="超时（秒）"
          type="number"
          value={form.timeout_sec}
          onChange={(e) => setForm(f => ({ ...f, timeout_sec: Number(e.target.value) }))}
        />
        {mutation.error instanceof Error && (
          <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{mutation.error.message}</p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={handleSubmit} loading={mutation.isPending}>注册</Button>
        </div>
      </div>
    </Dialog>
  )
}

// ── Account 卡片 ──────────────────────────────────────────────────────────────

function LLMAccountCard({ account }: { account: LLMAccount }) {
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [modelName, setModelName] = useState('')
  const [modelCtxLimit, setModelCtxLimit] = useState('')
  const [showAddModel, setShowAddModel] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['llms'] })

  const deleteMutation = useMutation({
    mutationFn: () => llmsApi.delete(account.name),
    onSuccess: invalidate,
  })

  const addModelMutation = useMutation({
    mutationFn: ({ model, context_limit }: { model: string; context_limit?: number | null }) =>
      llmsApi.addModel(account.name, model, context_limit),
    onSuccess: () => { invalidate(); setModelName(''); setModelCtxLimit(''); setShowAddModel(false) },
  })

  const removeModelMutation = useMutation({
    mutationFn: (model: string) => llmsApi.removeModel(account.name, model),
    onSuccess: invalidate,
  })

  const setDefaultMutation = useMutation({
    mutationFn: (model: string) => llmsApi.setDefaultModel(account.name, model),
    onSuccess: invalidate,
  })

  function handleAddModel() {
    const name = modelName.trim()
    if (!name) return
    const ctx = modelCtxLimit.trim() ? Number(modelCtxLimit.trim()) : undefined
    addModelMutation.mutate({ model: name, context_limit: ctx })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start gap-4">
        <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
          <Cpu size={18} className="text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900 text-sm">{account.name}</span>
            <Badge variant="info">{account.style}</Badge>
          </div>
          <div className="flex items-center gap-1 mt-0.5 text-xs text-gray-400">
            <KeyRound size={11} />
            <span>API Key 已配置</span>
            {account.base_url && (
              <><span className="mx-1">·</span><span className="truncate max-w-[200px]">{account.base_url}</span></>
            )}
            <span className="mx-1">·</span>
            <span>超时 {account.timeout_sec}s</span>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {account.models.map((m: ModelConfig) => (
              <span
                key={m.name}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border group
                  ${m.name === account.default_model
                    ? 'bg-blue-50 border-blue-300 text-blue-700'
                    : 'bg-gray-50 border-gray-200 text-gray-600'}`}
              >
                {m.name === account.default_model && <Star size={10} className="text-blue-500" />}
                <button
                  className="hover:underline"
                  onClick={() => m.name !== account.default_model && setDefaultMutation.mutate(m.name)}
                  title={m.name === account.default_model ? '当前默认' : '设为默认'}
                >
                  {m.name}
                </button>
                <span className="text-gray-400">· {formatCtx(m.context_limit)}</span>
                <button
                  className="ml-0.5 text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => removeModelMutation.mutate(m.name)}
                  title="移除模型"
                >
                  <X size={10} />
                </button>
              </span>
            ))}

            {showAddModel ? (
              <span className="inline-flex items-center gap-1">
                <input
                  autoFocus
                  className="border border-blue-300 rounded-full px-2 py-0.5 text-xs w-32 focus:outline-none"
                  placeholder="模型名"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddModel()
                    if (e.key === 'Escape') { setShowAddModel(false); setModelName(''); setModelCtxLimit('') }
                  }}
                />
                <input
                  className="border border-blue-300 rounded-full px-2 py-0.5 text-xs w-24 focus:outline-none"
                  placeholder="Context"
                  type="number"
                  value={modelCtxLimit}
                  onChange={(e) => setModelCtxLimit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddModel()
                    if (e.key === 'Escape') { setShowAddModel(false); setModelName(''); setModelCtxLimit('') }
                  }}
                />
                <button
                  className="text-gray-400 hover:text-gray-600"
                  onClick={() => { setShowAddModel(false); setModelName(''); setModelCtxLimit('') }}
                >
                  <X size={12} />
                </button>
              </span>
            ) : (
              <button
                className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs border border-dashed border-gray-300 text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors"
                onClick={() => setShowAddModel(true)}
              >
                <Plus size={10} />
                添加模型
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {confirmDelete ? (
            <div className="flex gap-1">
              <Button size="sm" variant="danger" loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                确认删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="text-gray-400 hover:text-red-500" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 页面 ──────────────────────────────────────────────────────────────────────

export function LLMsPage() {
  const [showRegister, setShowRegister] = useState(false)

  const { data: accounts, isLoading, error } = useQuery({
    queryKey: ['llms'],
    queryFn: llmsApi.list,
    refetchInterval: 30_000,
  })

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">LLM Accounts</h1>
          <p className="text-sm text-gray-500 mt-0.5">管理 AI 模型服务连接</p>
        </div>
        <Button onClick={() => setShowRegister(true)}>
          <Plus size={15} />
          注册 Account
        </Button>
      </div>

      {!isLoading && accounts?.length === 0 && (
        <div className="flex items-start gap-3 bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-5">
          <AlertTriangle size={16} className="text-yellow-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-yellow-800">尚未配置 LLM Account</p>
            <p className="text-xs text-yellow-700 mt-0.5">
              至少需要注册一个 Account 才能启动 Session。可通过下方按钮注册，或在 <code className="bg-yellow-100 px-1 rounded">.env</code> 中配置 <code className="bg-yellow-100 px-1 rounded">IPMC_LLM_ACCOUNT</code> 等变量后重启服务。
            </p>
          </div>
          <Button size="sm" onClick={() => setShowRegister(true)} className="ml-auto flex-shrink-0">立即配置</Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : error ? (
        <div className="text-sm text-red-600 bg-red-50 rounded-xl p-4">加载失败：{(error as Error).message}</div>
      ) : (
        <div className="flex flex-col gap-3">
          {accounts?.map(a => <LLMAccountCard key={a.name} account={a} />)}
        </div>
      )}

      <RegisterAccountDialog open={showRegister} onClose={() => setShowRegister(false)} />
    </div>
  )
}
