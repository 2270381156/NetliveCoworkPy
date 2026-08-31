import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Wrench, X, Plus, Folder, Trash2 } from 'lucide-react'
import { templatesApi } from '@/api/templates'
import type { AgentTemplate } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'

// ── Detail drawer ─────────────────────────────────────────────────────────────

function TemplateDrawer({
  templateId,
  onClose,
}: {
  templateId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data: detail, isLoading } = useQuery({
    queryKey: ['template', templateId],
    queryFn: () => templatesApi.get(templateId),
  })

  const deleteMutation = useMutation({
    mutationFn: () => templatesApi.delete(templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] })
      onClose()
    },
  })

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[520px] bg-white shadow-2xl z-50 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {detail?.name ?? templateId}
            </h2>
            {detail && (
              <p className="text-xs text-gray-400 mt-0.5">v{detail.version} · {detail.id}</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner />
          </div>
        ) : detail ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
            {detail.description && (
              <p className="text-sm text-gray-600">{detail.description}</p>
            )}

            {/* Identity */}
            <div className="flex gap-2">
              <Badge variant={detail.has_soul ? 'info' : 'muted'}>SOUL.md</Badge>
              <Badge variant={detail.has_role ? 'info' : 'muted'}>ROLE.md</Badge>
            </div>

            {/* Capability refs */}
            {detail.tool_refs.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">
                  Capability Refs（{detail.tool_refs.length}）
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {detail.tool_refs.map((ref) => (
                    <span
                      key={ref}
                      className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded text-xs font-mono text-gray-700"
                    >
                      <Wrench size={10} />
                      {ref}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Template dir */}
            {detail.template_dir && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">目录路径</p>
                <p className="text-xs text-gray-500 font-mono break-all bg-gray-50 rounded px-3 py-2">
                  {detail.template_dir}
                </p>
              </div>
            )}

            {/* Delete */}
            <div className="mt-auto pt-4 border-t border-gray-100">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 flex-1">确认注销此模板记录？</span>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate()}
                  >
                    确认
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-gray-400 hover:text-red-500"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={13} />
                  注销模板
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

// ── Register dialog ───────────────────────────────────────────────────────────

function RegisterTemplateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [templateDir, setTemplateDir] = useState('')
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: () => templatesApi.register({ template_dir: templateDir }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] })
      onClose()
      setTemplateDir('')
      setError('')
    },
    onError: (e: Error) => setError(e.message),
  })

  function handleSubmit() {
    if (!templateDir.trim()) { setError('请输入目录路径'); return }
    setError('')
    mutation.mutate()
  }

  return (
    <Dialog open={open} onClose={onClose} title="注册 Template 目录" size="sm">
      <div className="flex flex-col gap-4">
        <Input
          label="目录路径 *"
          placeholder="/path/to/agents/default"
          value={templateDir}
          onChange={(e) => setTemplateDir(e.target.value)}
          hint="包含 SOUL.md 的目录绝对路径"
          error={error}
        />
        <p className="text-xs text-gray-400">
          注册后，runtime 在下次 get() 时从该目录读取 SOUL.md / ROLE.md。
          删除模板目录前请先注销。
        </p>
        {mutation.error instanceof Error && !error && (
          <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">
            {mutation.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={handleSubmit} loading={mutation.isPending}>注册</Button>
        </div>
      </div>
    </Dialog>
  )
}

// ── Template card ─────────────────────────────────────────────────────────────

function TemplateCard({
  template,
  onView,
}: {
  template: AgentTemplate
  onView: () => void
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3 hover:border-blue-200 hover:shadow-sm transition-all cursor-pointer" onClick={onView}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-50 to-purple-50 flex items-center justify-center flex-shrink-0">
          <Bot size={20} className="text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{template.name}</h3>
            <span className="text-xs text-gray-400">v{template.version}</span>
          </div>
          {template.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{template.description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between pt-1 border-t border-gray-100">
        <span className="text-xs font-mono text-gray-400">{template.id}</span>
        <span className="inline-flex items-center gap-1 text-xs text-gray-400">
          <Folder size={11} />
          查看详情
        </span>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function TemplatesPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showRegister, setShowRegister] = useState(false)

  const { data: templates, isLoading, error } = useQuery({
    queryKey: ['templates'],
    queryFn: templatesApi.list,
  })

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Agent Templates</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              从磁盘按需加载（SOUL.md + ROLE.md）。修改文件后无需重启，下次会话自动生效。
            </p>
          </div>
          <Button onClick={() => setShowRegister(true)}>
            <Plus size={15} />
            注册目录
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : error ? (
          <div className="text-sm text-red-600 bg-red-50 rounded-xl p-4">
            加载失败：{(error as Error).message}
          </div>
        ) : !templates?.length ? (
          <div className="text-center py-12 text-gray-400">
            <Bot size={32} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">暂无模板。</p>
            <p className="text-xs mt-1">设置 IPMC_AGENTS_DIR 或点击「注册目录」添加。</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((t) => (
              <TemplateCard key={t.id} template={t} onView={() => setSelectedId(t.id)} />
            ))}
          </div>
        )}
      </div>

      {selectedId && (
        <TemplateDrawer templateId={selectedId} onClose={() => setSelectedId(null)} />
      )}
      <RegisterTemplateDialog open={showRegister} onClose={() => setShowRegister(false)} />
    </div>
  )
}
