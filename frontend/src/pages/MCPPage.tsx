import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, RefreshCw, Server, ChevronDown, ChevronRight, X } from 'lucide-react'
import { mcpApi } from '@/api/mcp'
import type { MCPServer, RegisterMCPStdioRequest, RegisterMCPHttpRequest } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { clsx } from 'clsx'

type RegisterType = 'stdio' | 'http'

function RegisterMCPDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [type, setType] = useState<RegisterType>('stdio')
  const [stdioForm, setStdioForm] = useState<RegisterMCPStdioRequest>({
    name: '',
    command: '',
    args: [],
    env: {},
    timeout_per_call_sec: 60,
    connect_timeout_sec: 10,
  })
  const [httpForm, setHttpForm] = useState<RegisterMCPHttpRequest>({
    name: '',
    url: '',
    timeout_per_call_sec: 60,
    connect_timeout_sec: 10,
  })
  const [argsStr, setArgsStr] = useState('')
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mutation = useMutation({
    mutationFn: () => {
      if (type === 'stdio') {
        const env = Object.fromEntries(
          envPairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value])
        )
        return mcpApi.registerStdio({
          ...stdioForm,
          args: argsStr.trim() ? argsStr.split(' ') : [],
          env,
        })
      }
      return mcpApi.registerHttp(httpForm)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })
      onClose()
    },
  })

  function validate() {
    const errs: Record<string, string> = {}
    if (type === 'stdio') {
      if (!stdioForm.name.trim()) errs.name = '请输入名称'
      if (!stdioForm.command.trim()) errs.command = '请输入命令'
    } else {
      if (!httpForm.name.trim()) errs.name = '请输入名称'
      if (!httpForm.url.trim()) errs.url = '请输入 URL'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSubmit() {
    if (!validate()) return
    mutation.mutate()
  }

  return (
    <Dialog open={open} onClose={onClose} title="注册 MCP Server" size="md">
      <div className="flex flex-col gap-4">
        {/* Type switcher */}
        <div className="flex rounded-lg border border-gray-200 p-0.5 bg-gray-50 w-fit">
          {(['stdio', 'http'] as RegisterType[]).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={clsx(
                'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
                type === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        {type === 'stdio' ? (
          <>
            <Input
              label="名称 *"
              placeholder="my-mcp-server"
              value={stdioForm.name}
              onChange={(e) => setStdioForm((f) => ({ ...f, name: e.target.value }))}
              error={errors.name}
            />
            <Input
              label="命令 *"
              placeholder="npx"
              value={stdioForm.command}
              onChange={(e) => setStdioForm((f) => ({ ...f, command: e.target.value }))}
              error={errors.command}
            />
            <Input
              label="参数"
              placeholder="@my/mcp-server --port 3000"
              value={argsStr}
              onChange={(e) => setArgsStr(e.target.value)}
              hint="空格分隔"
            />
            <Input
              label="调用超时（秒）"
              type="number"
              value={stdioForm.timeout_per_call_sec}
              onChange={(e) => setStdioForm((f) => ({ ...f, timeout_per_call_sec: Number(e.target.value) }))}
              hint="工具调用最长等待时间"
            />
            <Input
              label="连接超时（秒）"
              type="number"
              value={stdioForm.connect_timeout_sec}
              onChange={(e) => setStdioForm((f) => ({ ...f, connect_timeout_sec: Number(e.target.value) }))}
              hint="握手超时，建议 5-15 秒"
            />
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">环境变量</span>
                <button
                  type="button"
                  onClick={() => setEnvPairs((ps) => [...ps, { key: '', value: '' }])}
                  className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                >
                  <Plus size={12} /> 添加
                </button>
              </div>
              {envPairs.length === 0 && (
                <p className="text-xs text-gray-400">无环境变量</p>
              )}
              {envPairs.map((pair, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    className="flex-1 min-w-0 border border-gray-200 rounded-md px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="KEY"
                    value={pair.key}
                    onChange={(e) => setEnvPairs((ps) => ps.map((p, j) => j === i ? { ...p, key: e.target.value } : p))}
                  />
                  <input
                    className="flex-[2] min-w-0 border border-gray-200 rounded-md px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="value"
                    value={pair.value}
                    onChange={(e) => setEnvPairs((ps) => ps.map((p, j) => j === i ? { ...p, value: e.target.value } : p))}
                  />
                  <button
                    type="button"
                    onClick={() => setEnvPairs((ps) => ps.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-500 flex-shrink-0"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <Input
              label="名称 *"
              placeholder="web-search"
              value={httpForm.name}
              onChange={(e) => setHttpForm((f) => ({ ...f, name: e.target.value }))}
              error={errors.name}
            />
            <Input
              label="URL *"
              placeholder="http://localhost:3000/mcp"
              value={httpForm.url}
              onChange={(e) => setHttpForm((f) => ({ ...f, url: e.target.value }))}
              error={errors.url}
            />
            <Input
              label="调用超时（秒）"
              type="number"
              value={httpForm.timeout_per_call_sec}
              onChange={(e) => setHttpForm((f) => ({ ...f, timeout_per_call_sec: Number(e.target.value) }))}
              hint="工具调用最长等待时间"
            />
            <Input
              label="连接超时（秒）"
              type="number"
              value={httpForm.connect_timeout_sec}
              onChange={(e) => setHttpForm((f) => ({ ...f, connect_timeout_sec: Number(e.target.value) }))}
              hint="握手超时，建议 5-15 秒"
            />
          </>
        )}

        {mutation.error instanceof Error && (
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

function MCPServerRow({ server }: { server: MCPServer }) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const refreshMutation = useMutation({
    mutationFn: () => mcpApi.refresh(server.name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => mcpApi.delete(server.name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }),
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="p-4 flex items-center gap-4">
        <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
          <Server size={18} className="text-purple-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900 text-sm">{server.name}</span>
            <Badge variant={server.type === 'stdio' ? 'muted' : 'info'}>{server.type}</Badge>
            <Badge variant={server.status === 'CONNECTED' ? 'success' : 'error'}>
              {server.status}
            </Badge>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {server.tool_count} 个工具
            <span className="ml-2">· 调用 {server.timeout_per_call_sec}s</span>
            <span className="ml-1">· 连接 {server.connect_timeout_sec}s</span>
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            className="text-gray-400"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
          >
            <RefreshCw size={13} />
          </Button>
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

      {expanded && server.tools && server.tools.length > 0 && (
        <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
          <div className="flex flex-col gap-2">
            {server.tools.map((tool) => (
              <div key={tool.name}>
                <span className="text-xs font-mono font-medium text-gray-700">{tool.name}</span>
                {tool.description && (
                  <p className="text-xs text-gray-400 mt-0.5">{tool.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function MCPPage() {
  const [showRegister, setShowRegister] = useState(false)

  const { data: servers, isLoading, error } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: mcpApi.list,
  })

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">MCP Servers</h1>
          <p className="text-sm text-gray-500 mt-0.5">管理 Model Context Protocol 工具服务</p>
        </div>
        <Button onClick={() => setShowRegister(true)}>
          <Plus size={15} />
          注册 MCP Server
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 bg-red-50 rounded-xl p-4">
          加载失败：{(error as Error).message}
        </div>
      ) : servers?.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <Server size={32} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">暂无 MCP Server</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {servers?.map((s) => <MCPServerRow key={s.name} server={s} />)}
        </div>
      )}

      <RegisterMCPDialog open={showRegister} onClose={() => setShowRegister(false)} />
    </div>
  )
}
