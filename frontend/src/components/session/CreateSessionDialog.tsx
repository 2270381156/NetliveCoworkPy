import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { templatesApi } from '@/api/templates'
import { llmsApi } from '@/api/llms'
import type { SessionConfig } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog } from '@/components/ui/dialog'

interface Props {
  open: boolean
  onClose: () => void
  onConfigured: (config: SessionConfig) => void
}

const DEFAULT_CONFIG: SessionConfig = {
  template_id: null,
  token_budget: 0,
  llm_account: null,
  llm_model: null,
  workspace: null,
  initial_task: null,
}

export function CreateSessionDialog({ open, onClose, onConfigured }: Props) {
  const [config, setConfig] = useState<SessionConfig>(DEFAULT_CONFIG)

  useEffect(() => {
    if (!open) setConfig(DEFAULT_CONFIG)
  }, [open])

  const { data: templates, isFetching: templatesFetching } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list(),
  })

  const { data: llms } = useQuery({
    queryKey: ['llms'],
    queryFn: llmsApi.list,
  })

  function handleConfirm() {
    onConfigured(config)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="新建 Session" size="md">
      <div className="flex flex-col gap-4">

        <Select
          label={templatesFetching ? 'Agent 模板（加载中…）' : 'Agent 模板'}
          value={config.template_id ?? ''}
          onChange={(e) =>
            setConfig((c) => ({ ...c, template_id: e.target.value || null }))
          }
          disabled={templatesFetching}
        >
          <option value="">使用默认模板</option>
          {templates?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}{t.description ? ` — ${t.description}` : ''}
            </option>
          ))}
        </Select>

        <Select
          label="Account"
          value={config.llm_account ?? ''}
          onChange={(e) =>
            setConfig((c) => ({ ...c, llm_account: e.target.value || null, llm_model: null }))
          }
        >
          <option value="">使用默认 Account</option>
          {llms?.map((l) => (
            <option key={l.name} value={l.name}>{l.name}</option>
          ))}
        </Select>

        {config.llm_account && (() => {
          const provider = llms?.find(l => l.name === config.llm_account)
          if (!provider?.models.length) return null
          return (
            <Select
              label="模型"
              value={config.llm_model ?? ''}
              onChange={(e) =>
                setConfig((c) => ({ ...c, llm_model: e.target.value || null }))
              }
            >
              <option value="">默认（{provider.default_model}）</option>
              {provider.models.map(m => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </Select>
          )
        })()}

        <Input
          label="工作目录"
          placeholder="例如 C:\Users\me\project（绝对路径）"
          value={config.workspace ?? ''}
          onChange={(e) =>
            setConfig((c) => ({ ...c, workspace: e.target.value.trim() || null }))
          }
          hint="agent 的工作目录，须为绝对路径；留空则不设置"
        />

        <div>
          <Input
            label="Token 预算"
            type="number"
            value={config.token_budget}
            onChange={(e) =>
              setConfig((c) => ({ ...c, token_budget: Number(e.target.value) }))
            }
          />
          <p className="mt-1 text-[11px] text-gray-400">0 表示不限制；超出后 session 将自动终止</p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={handleConfirm}>确认配置</Button>
        </div>
      </div>
    </Dialog>
  )
}
