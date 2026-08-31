import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, BookOpen, GitBranch } from 'lucide-react'
import { skillSourceApi } from '@/api/skills'
import type { RemoteSkillSource } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'

// ── Register dialog ───────────────────────────────────────────────────────────

function RegisterSkillSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ source_name: '', repo_url: '', branch: 'main' })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mutation = useMutation({
    mutationFn: () => skillSourceApi.registerGit(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skill-sources'] })
      onClose()
      setForm({ source_name: '', repo_url: '', branch: 'main' })
      setErrors({})
    },
  })

  function validate() {
    const errs: Record<string, string> = {}
    if (!form.source_name.trim()) errs.source_name = '请输入名称'
    if (!form.repo_url.trim()) errs.repo_url = '请输入仓库地址'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  return (
    <Dialog open={open} onClose={onClose} title="添加 Git Skill Source" size="sm">
      <div className="flex flex-col gap-4">
        <Input
          label="名称 *"
          placeholder="my-skills"
          value={form.source_name}
          onChange={(e) => setForm((f) => ({ ...f, source_name: e.target.value }))}
          error={errors.source_name}
        />
        <Input
          label="Git 仓库地址 *"
          placeholder="https://github.com/org/skills"
          value={form.repo_url}
          onChange={(e) => setForm((f) => ({ ...f, repo_url: e.target.value }))}
          error={errors.repo_url}
        />
        <Input
          label="分支"
          placeholder="main"
          value={form.branch}
          onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
        />
        <p className="text-xs text-gray-400">
          首次 list() 时触发 git clone；后续按需 pull。技能目录同步到服务器本地缓存。
        </p>
        {mutation.error instanceof Error && (
          <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">
            {mutation.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button
            onClick={() => { if (validate()) mutation.mutate() }}
            loading={mutation.isPending}
          >
            添加
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────────

function SkillSourceRow({ source }: { source: RemoteSkillSource }) {
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const deleteMutation = useMutation({
    mutationFn: () => skillSourceApi.delete(source.source_name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4">
      <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
        <BookOpen size={18} className="text-emerald-600" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900 text-sm">{source.source_name}</span>
          <span className="inline-flex items-center gap-1 text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
            <GitBranch size={10} />
            {source.branch}
          </span>
        </div>
        <p className="text-xs text-gray-400 mt-0.5 truncate font-mono">
          {source.repo_url ?? '—'}
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {confirmDelete ? (
          <>
            <Button size="sm" variant="danger" loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
              确认
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="text-gray-400 hover:text-red-500" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} />
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SkillSourcesPage() {
  const [showAdd, setShowAdd] = useState(false)

  const { data: sources, isLoading, error } = useQuery({
    queryKey: ['skill-sources'],
    queryFn: skillSourceApi.list,
  })

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Skill Sources</h1>
          <p className="text-sm text-gray-500 mt-0.5">管理远端 Git Skill 来源</p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus size={15} />
          添加 Skill Source
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : error ? (
        <div className="text-sm text-red-600 bg-red-50 rounded-xl p-4">
          加载失败：{(error as Error).message}
        </div>
      ) : !sources?.length ? (
        <div className="text-center py-12 text-gray-400">
          <BookOpen size={32} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">暂无 Skill Source</p>
          <p className="text-xs mt-1">添加 Git 仓库，技能将在首次使用时自动同步。</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sources.map((s) => <SkillSourceRow key={s.source_name} source={s} />)}
        </div>
      )}

      <RegisterSkillSourceDialog open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  )
}
