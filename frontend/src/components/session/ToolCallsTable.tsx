import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { clsx } from 'clsx'
import type { ToolCall } from '@/types'
import { Spinner } from '@/components/ui/spinner'
import { formatDuration, formatTime } from '@/lib/status'

function ToolCallRow({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const duration = formatDuration(call.started_at, call.finished_at)

  return (
    <>
      <tr
        className="hover:bg-gray-50 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
          {formatTime(call.started_at)}
        </td>
        <td className="px-3 py-2">
          <span className="text-xs font-mono font-medium text-gray-800">{call.tool_name}</span>
        </td>
        <td className="px-3 py-2">
          {call.status === 'SUCCEEDED' ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-600">
              <CheckCircle2 size={12} /> 成功
            </span>
          ) : call.status === 'FAILED' ? (
            <span className="inline-flex items-center gap-1 text-xs text-red-600">
              <XCircle size={12} /> 失败
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-blue-600">
              <Loader2 size={12} className="animate-spin" /> 运行中
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap tabular-nums">
          {duration}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 max-w-[200px] truncate">
          {Object.entries(call.arguments)
            .slice(0, 2)
            .map(([k, v]) => `${k}: ${String(v).slice(0, 30)}`)
            .join(', ')}
        </td>
        <td className="px-3 py-2 text-gray-400">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="px-4 pb-3 bg-gray-50">
            <div className="grid grid-cols-2 gap-3 pt-2">
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">参数</p>
                <pre className="text-xs bg-gray-900 text-green-300 rounded-md p-2 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(call.arguments, null, 2)}
                </pre>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">
                  {call.error ? '错误' : '结果'}
                </p>
                <pre
                  className={clsx(
                    'text-xs rounded-md p-2 overflow-x-auto whitespace-pre-wrap max-h-40',
                    call.error
                      ? 'bg-red-50 text-red-700'
                      : 'bg-gray-100 text-gray-700'
                  )}
                >
                  {call.error ?? call.result ?? '(无输出)'}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

interface ToolCallsTableProps {
  toolCalls: ToolCall[]
  isLoading: boolean
}

export function ToolCallsTable({ toolCalls, isLoading }: ToolCallsTableProps) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    )
  }

  if (toolCalls.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-gray-400">
        暂无工具调用记录
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-gray-200">
            {['时间', '工具', '状态', '耗时', '参数摘要', ''].map((h) => (
              <th key={h} className="px-3 py-2 text-xs font-medium text-gray-400 whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {toolCalls.map((call) => (
            <ToolCallRow key={call.id} call={call} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
