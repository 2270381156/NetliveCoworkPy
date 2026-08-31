import { useState, useRef, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, ChevronDown, ChevronRight, Wrench, Bot, User, Loader2, CheckCircle2, XCircle, MessageCircleQuestion, Eye, Code2, Paperclip, X, ListChecks, Settings, Square } from 'lucide-react'
import { clsx } from 'clsx'
import { sessionsApi } from '@/api/sessions'
import { hitlApi } from '@/api/hitl'
import type { ContentPart, ImagePart } from '@/api/sessions'
import { MarkdownContent } from './MarkdownContent'
import { llmsApi } from '@/api/llms'
import type { Session } from '@/types'
import { useSessionSSE } from '@/hooks/useSessionSSE'
import type { ChatItem, ChatMessage, ChatToolCall, ChatControlToolCall, ChatWaitingInput, ChatLLMPrompt, ChatObserverMessage, ChatObserverToolCall, ChatObserverControlToolCall, ChatDaemonMessage, ChatDaemonPrompt, ChatDaemonToolCall, ChatDaemonControlToolCall, ChatImageData, ChatErrorEvent, ChatCompactMarker } from '@/hooks/useSessionSSE'
import { formatTime } from '@/lib/status'
import { activityLabel, formatDuration } from '@/lib/activity'
import type { ActivityState } from '@/lib/activity'
import { SessionStatusBadge } from '@/components/session/StatusBadge'
import { Spinner } from '@/components/ui/spinner'
import { TaskTimeline } from '@/components/task/TaskTimeline'
import { SessionNoticeBar } from './SessionNoticeBar'

// ── Individual item renderers ─────────────────────────────────────────────────

function imageUrl(img: ChatImageData): string {
  return img.source_type === 'url' ? img.data : `data:${img.media_type};base64,${img.data}`
}

function ImageGrid({ images }: { images: ChatImageData[] }) {
  return (
    <div className={clsx('grid gap-1 mt-1', images.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {images.map((img, i) => (
        <a key={i} href={imageUrl(img)} target="_blank" rel="noopener noreferrer">
          <img
            src={imageUrl(img)}
            alt=""
            className="rounded-lg max-h-48 w-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
          />
        </a>
      ))}
    </div>
  )
}

function ReasoningBlock({
  reasoning,
  tone = 'actor',
  defaultOpen = false,
}: {
  reasoning: string
  tone?: 'actor' | 'observer'
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const styles = tone === 'observer'
    ? {
        button: 'text-purple-500 hover:text-purple-700',
        panel: 'bg-purple-100/80 border-purple-200 text-purple-900',
        label: 'text-purple-700',
      }
    : {
        button: 'text-slate-500 hover:text-slate-700',
        panel: 'bg-slate-100 border-slate-200 text-slate-800',
        label: 'text-slate-700',
      }

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className={clsx('flex items-center gap-1.5 text-xs transition-colors', styles.button)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="font-medium">Reasoning</span>
      </button>
      {open && (
        <div className={clsx('mt-1 rounded-lg border px-3 py-2 text-xs leading-5', styles.panel)}>
          <p className={clsx('mb-1 font-medium', styles.label)}>Model reasoning</p>
          <p className="whitespace-pre-wrap break-words">{reasoning}</p>
        </div>
      )}
    </div>
  )
}

function MessageBubble({ item }: { item: ChatMessage }) {
  const isUser = item.role === 'user'
  return (
    <div className={clsx('flex items-start gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div className={clsx(
        'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
        isUser ? 'bg-blue-500' : 'bg-gray-200'
      )}>
        {isUser
          ? <User size={12} className="text-white" />
          : <Bot size={12} className="text-gray-600" />}
      </div>
      <div className={clsx('flex flex-col max-w-[80%]', isUser ? 'items-end' : 'items-start')}>
        <div className={clsx(
          'rounded-xl px-3 py-2 text-sm leading-relaxed',
          isUser
            ? 'bg-blue-600 text-white rounded-tr-sm'
            : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm'
        )}>
          {item.images && item.images.length > 0 && <ImageGrid images={item.images} />}
          {!isUser && item.reasoning && <ReasoningBlock reasoning={item.reasoning} />}
          {item.content && (
            isUser
              ? <p className="whitespace-pre-wrap break-words mt-1">{item.content}</p>
              : <MarkdownContent content={item.content} />
          )}
        </div>
        {item.created_at && (
          <p className="text-xs text-gray-400 mt-1 px-1">{formatTime(item.created_at)}</p>
        )}
      </div>
    </div>
  )
}

function ToolCallCard({ item }: { item: ChatToolCall }) {
  const [open, setOpen] = useState(false)
  const argStr = (() => {
    try { return JSON.stringify(item.arguments, null, 2) } catch { return String(item.arguments) }
  })()

  return (
    <div className="flex items-start gap-2 px-1">
      <div className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Wrench size={11} className="text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors w-full text-left"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-mono font-medium text-gray-700">{item.tool_name}</span>
          {item.status === 'pending'
            ? <span className="ml-auto flex-shrink-0 text-[10px] text-blue-400">执行中…</span>
            : item.is_error
              ? <XCircle size={11} className="text-red-400 ml-auto flex-shrink-0" />
              : <CheckCircle2 size={11} className="text-green-400 ml-auto flex-shrink-0" />}
        </button>
        {open && (
          <div className="mt-1.5 bg-gray-900 rounded-lg overflow-hidden text-xs">
            {argStr !== '{}' && (
              <div className="px-3 py-2 border-b border-gray-700">
                <p className="text-gray-400 mb-1">参数</p>
                <pre className="text-yellow-300 overflow-x-auto whitespace-pre-wrap break-words">{argStr}</pre>
              </div>
            )}
            {item.status !== 'pending' && (
              <div className="px-3 py-2">
                <p className="text-gray-400 mb-1">{item.is_error ? '错误' : '结果'}</p>
                <pre className={clsx(
                  'overflow-x-auto whitespace-pre-wrap break-words',
                  item.is_error ? 'text-red-400' : 'text-green-300'
                )}>{item.result || '(空)'}</pre>
              </div>
            )}
          </div>
        )}
        {item.created_at && (
          <p className="text-xs text-gray-400 mt-1">{formatTime(item.created_at)}</p>
        )}
      </div>
    </div>
  )
}

function StreamingBubble({ text, images, reasoning }: { text: string; images?: ChatImageData[]; reasoning?: string }) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot size={12} className="text-gray-600" />
      </div>
      <div className="flex flex-col items-start max-w-[80%]">
        <div className="rounded-xl px-3 py-2 text-sm leading-relaxed bg-white border border-gray-200 text-gray-800 rounded-tl-sm">
          {images && images.length > 0 && <ImageGrid images={images} />}
          {reasoning && <ReasoningBlock reasoning={reasoning} defaultOpen />}
          {(text || !reasoning) && (
            <MarkdownContent content={text} streaming />
          )}
        </div>
      </div>
    </div>
  )
}

type PromptBody = {
  system_prompt: string
  messages: Array<{ role: string; content: string | object[] }>
  tool_names: string[]
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** prompt 正文的按需加载。
 *
 *  后端 ?prompts=stub 只下发 prompt 的头部（见 useSessionSSE 里的 EventSource url）：长会话里
 *  prompt 占历史 95%，全量塞进首屏那一个 SSE frame 会把浏览器压死。正文改成展开时按
 *  event_index 单条回取，取一次缓存在卡片里。full 模式（帧自带内联正文）不发请求。
 */
function usePromptBody(item: ChatLLMPrompt | ChatDaemonPrompt, open: boolean) {
  const [loaded, setLoaded] = useState<PromptBody | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const isStub = item.stub === true
  const sessionId = item.session_id
  const eventIndex = item.event_index
  // 存根缺回取凭据（后端版本不匹配之类）：直接算成错误态，不进 effect 里 setState。
  const missingRef = isStub && (!sessionId || eventIndex === undefined)
  const error = missingRef ? '缺 event_index，无法回取正文' : fetchError

  useEffect(() => {
    if (!open || !isStub || missingRef || loaded || error) return
    if (!sessionId || eventIndex === undefined) return
    let alive = true
    sessionsApi.getEvent(sessionId, eventIndex)
      .then(evt => {
        if (!alive) return
        setLoaded({
          system_prompt: (evt.system_prompt as string) || '',
          messages: (evt.messages as PromptBody['messages']) || [],
          tool_names: (evt.tool_names as string[]) || [],
        })
      })
      .catch((e: unknown) => {
        if (alive) setFetchError(e instanceof Error ? e.message : '加载失败')
      })
    return () => { alive = false }
  }, [open, isStub, missingRef, loaded, error, sessionId, eventIndex])

  const body: PromptBody | null = isStub
    ? loaded
    : { system_prompt: item.system_prompt, messages: item.messages, tool_names: item.tool_names }
  return { body, loading: isStub && !loaded && !error, error }
}

/** 存根正文的占位行（加载中 / 失败）；正文已就绪时不渲染。 */
function PromptBodyStatus({ loading, error, className }: { loading: boolean; error: string | null; className: string }) {
  if (!loading && !error) return null
  return (
    <div className="px-3 py-2 flex items-center gap-1.5">
      {loading && <Loader2 size={11} className={clsx('animate-spin', className)} />}
      <span className={error ? 'text-red-400' : className}>
        {error ? `正文加载失败：${error}` : '加载正文…'}
      </span>
    </div>
  )
}

function LLMPromptCard({ item }: { item: ChatLLMPrompt }) {
  const [open, setOpen] = useState(false)
  const { body, loading, error } = usePromptBody(item, open)
  const isObserver = item.source === 'observer'
  const sublabel = item.round_label ? ` · ${item.round_label}` : ''

  if (isObserver) {
    return (
      <div className="border-l-2 border-purple-300 pl-3 ml-8">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-600 transition-colors w-full text-left py-0.5"
        >
          <Eye size={11} className="text-purple-400 flex-shrink-0" />
          <span className="font-mono font-medium text-purple-600">Observer prompt</span>
          <span className="text-purple-300 font-normal">{sublabel}</span>
          {item.tool_names.length > 0 && (
            <span className="ml-auto text-purple-300 font-normal shrink-0">
              {item.tool_names.length} tools{item.bytes ? ` · ${formatBytes(item.bytes)}` : ''}
            </span>
          )}
          {open ? <ChevronDown size={11} className="ml-1 shrink-0" /> : <ChevronRight size={11} className="ml-1 shrink-0" />}
        </button>
        {open && (
          <div className="mt-1.5 bg-purple-950 rounded-lg overflow-hidden text-xs font-mono">
            {(item.task_id || item.agent_id) && (
              <div className="px-3 py-2 border-b border-purple-800 flex flex-col gap-0.5">
                {item.task_id && (
                  <p className="text-purple-400">task: <span className="text-purple-200 select-all">{item.task_id}</span></p>
                )}
                {item.agent_id && (
                  <p className="text-purple-400">agent: <span className="text-purple-200 select-all">{item.agent_id}</span></p>
                )}
              </div>
            )}
            <PromptBodyStatus loading={loading} error={error} className="text-purple-400" />
            {body?.system_prompt && (
              <div className="px-3 py-2 border-b border-purple-800">
                <p className="text-purple-500 mb-1 text-[10px] uppercase tracking-wide">system</p>
                <pre className="text-purple-100 whitespace-pre-wrap break-words">{body.system_prompt}</pre>
              </div>
            )}
            {(body?.messages ?? []).map((m, i) => (
              <div key={i} className="px-3 py-2 border-b border-purple-900 last:border-b-0">
                <p className="text-purple-500 mb-1 text-[10px] uppercase tracking-wide">{m.role}</p>
                <pre className="text-purple-100 whitespace-pre-wrap break-words">
                  {typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}
                </pre>
              </div>
            ))}
            {item.tool_names.length > 0 && (
              <div className="px-3 py-2 border-t border-purple-800">
                <p className="text-purple-500 mb-1 text-[10px] uppercase tracking-wide">tools</p>
                <p className="text-purple-300">{item.tool_names.join(', ')}</p>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="border-l-2 border-slate-300 pl-3 ml-8">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors w-full text-left py-0.5"
      >
        <Code2 size={11} className="text-slate-400 flex-shrink-0" />
        <span className="font-mono font-medium text-slate-600">Actor prompt</span>
        <span className="text-slate-400 font-normal">{sublabel}</span>
        {item.tool_names.length > 0 && (
          <span className="ml-auto text-slate-400 font-normal shrink-0">
            {item.tool_names.length} tools{item.bytes ? ` · ${formatBytes(item.bytes)}` : ''}
          </span>
        )}
        {open ? <ChevronDown size={11} className="ml-1 shrink-0" /> : <ChevronRight size={11} className="ml-1 shrink-0" />}
      </button>
      {open && (
        <div className="mt-1.5 bg-slate-900 rounded-lg overflow-hidden text-xs font-mono">
          {(item.task_id || item.agent_id) && (
            <div className="px-3 py-2 border-b border-slate-700 flex flex-col gap-0.5">
              {item.task_id && (
                <p className="text-slate-400">task: <span className="text-slate-200 select-all">{item.task_id}</span></p>
              )}
              {item.agent_id && (
                <p className="text-slate-400">agent: <span className="text-slate-200 select-all">{item.agent_id}</span></p>
              )}
            </div>
          )}
          <PromptBodyStatus loading={loading} error={error} className="text-slate-400" />
          {body?.system_prompt && (
            <div className="px-3 py-2 border-b border-slate-700">
              <p className="text-slate-500 mb-1 text-[10px] uppercase tracking-wide">system</p>
              <pre className="text-slate-200 whitespace-pre-wrap break-words">{body.system_prompt}</pre>
            </div>
          )}
          {(body?.messages ?? []).map((m, i) => (
            <div key={i} className="px-3 py-2 border-b border-slate-800 last:border-b-0">
              <p className="text-slate-500 mb-1 text-[10px] uppercase tracking-wide">{m.role}</p>
              <pre className="text-slate-200 whitespace-pre-wrap break-words">
                {typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}
              </pre>
            </div>
          ))}
          {item.tool_names.length > 0 && (
            <div className="px-3 py-2 border-t border-slate-700">
              <p className="text-slate-500 mb-1 text-[10px] uppercase tracking-wide">tools</p>
              <p className="text-slate-300">{item.tool_names.join(', ')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ObserverBubble({ item }: { item: ChatObserverMessage }) {
  const roundNum = parseInt(item.round_label.replace('round_', ''), 10)
  const sublabel = isNaN(roundNum) || roundNum === 0 ? '评估' : `复核 · r${roundNum}`
  return (
    <div className="flex items-start gap-2">
      <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Eye size={12} className="text-purple-600" />
      </div>
      <div className="flex flex-col items-start max-w-[80%]">
        <p className="text-xs text-purple-400 mb-0.5">Observer · {sublabel}</p>
        <div className="rounded-xl px-3 py-2 text-sm leading-relaxed bg-purple-50 border border-purple-200 text-purple-900 rounded-tl-sm">
          {item.reasoning && <ReasoningBlock reasoning={item.reasoning} tone="observer" />}
          <MarkdownContent content={item.content} />
        </div>
        {item.created_at && (
          <p className="text-xs text-gray-400 mt-1 px-1">{formatTime(item.created_at)}</p>
        )}
      </div>
    </div>
  )
}

function ObserverToolCallCard({ item }: { item: ChatObserverToolCall | ChatObserverControlToolCall }) {
  const [open, setOpen] = useState(false)
  const argStr = (() => {
    try { return JSON.stringify(item.arguments, null, 2) } catch { return String(item.arguments) }
  })()
  const isControl = item.kind === 'observer_control_tool_call'

  return (
    <div className="flex items-start gap-2 px-1 pl-8">
      <div className="w-6 h-6 rounded bg-purple-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        {isControl
          ? <Settings size={11} className="text-purple-500" />
          : <Wrench size={11} className="text-purple-500" />}
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-600 transition-colors w-full text-left"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-mono font-medium text-purple-700">{item.tool_name}</span>
          {item.is_error
            ? <XCircle size={11} className="text-red-400 ml-auto flex-shrink-0" />
            : <CheckCircle2 size={11} className="text-purple-400 ml-auto flex-shrink-0" />}
        </button>
        {open && (
          <div className="mt-1.5 bg-purple-950 rounded-lg overflow-hidden text-xs">
            {argStr !== '{}' && (
              <div className="px-3 py-2 border-b border-purple-800">
                <p className="text-purple-400 mb-1">参数</p>
                <pre className="text-yellow-300 overflow-x-auto whitespace-pre-wrap break-words">{argStr}</pre>
              </div>
            )}
            <div className="px-3 py-2">
              <p className="text-purple-400 mb-1">{item.is_error ? '错误' : '结果'}</p>
              <pre className={clsx(
                'overflow-x-auto whitespace-pre-wrap break-words',
                item.is_error ? 'text-red-400' : 'text-purple-200'
              )}>{item.result || '(空)'}</pre>
            </div>
          </div>
        )}
        {item.created_at && (
          <p className="text-xs text-purple-300 mt-1">{formatTime(item.created_at)}</p>
        )}
      </div>
    </div>
  )
}

function ControlToolCallCard({ item }: { item: ChatControlToolCall }) {
  const [open, setOpen] = useState(false)
  const argStr = (() => {
    try { return JSON.stringify(item.arguments, null, 2) } catch { return String(item.arguments) }
  })()

  return (
    <div className="flex items-start gap-2 px-1">
      <div className="w-6 h-6 rounded bg-indigo-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Settings size={11} className="text-indigo-500" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-600 transition-colors w-full text-left"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-mono font-medium text-indigo-700">{item.tool_name}</span>
          {item.is_error
            ? <XCircle size={11} className="text-red-400 ml-auto flex-shrink-0" />
            : <CheckCircle2 size={11} className="text-indigo-400 ml-auto flex-shrink-0" />}
        </button>
        {open && (
          <div className="mt-1.5 bg-indigo-950 rounded-lg overflow-hidden text-xs">
            {argStr !== '{}' && (
              <div className="px-3 py-2 border-b border-indigo-800">
                <p className="text-indigo-400 mb-1">参数</p>
                <pre className="text-yellow-300 overflow-x-auto whitespace-pre-wrap break-words">{argStr}</pre>
              </div>
            )}
            <div className="px-3 py-2">
              <p className="text-indigo-400 mb-1">{item.is_error ? '错误' : '结果'}</p>
              <pre className={clsx(
                'overflow-x-auto whitespace-pre-wrap break-words',
                item.is_error ? 'text-red-400' : 'text-indigo-200'
              )}>{item.result || '(空)'}</pre>
            </div>
          </div>
        )}
        {item.created_at && (
          <p className="text-xs text-indigo-300 mt-1">{formatTime(item.created_at)}</p>
        )}
      </div>
    </div>
  )
}

function ObserverStreamingBubble({ text, reasoning }: { text: string; reasoning?: string }) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Eye size={12} className="text-purple-600" />
      </div>
      <div className="flex flex-col items-start max-w-[80%]">
        <p className="text-xs text-purple-400 mb-0.5">Observer</p>
        <div className="rounded-xl px-3 py-2 text-sm leading-relaxed bg-purple-50 border border-purple-200 text-purple-900 rounded-tl-sm">
          {reasoning && <ReasoningBlock reasoning={reasoning} tone="observer" defaultOpen />}
          {(text || !reasoning) && (
            <MarkdownContent content={text} streaming />
          )}
        </div>
      </div>
    </div>
  )
}

function DaemonMessageCard({ item }: { item: ChatDaemonMessage }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-start gap-2 px-1 opacity-60">
      <div className="w-6 h-6 rounded-full border border-dashed border-gray-300 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot size={11} className="text-gray-400" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors w-full text-left"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="italic">daemon{item.round_label ? ` · ${item.round_label}` : ''}</span>
        </button>
        {open && (
          <div className="mt-1 rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-500 bg-gray-50">
            <MarkdownContent content={item.text} />
          </div>
        )}
      </div>
    </div>
  )
}

function DaemonPromptCard({ item }: { item: ChatDaemonPrompt }) {
  const [open, setOpen] = useState(false)
  const { body, loading, error } = usePromptBody(item, open)
  return (
    <div className="flex items-start gap-2 px-1 opacity-50">
      <div className="w-6 h-6 rounded border border-dashed border-gray-300 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Code2 size={11} className="text-gray-400" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-500 transition-colors w-full text-left"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-mono italic">daemon prompt — {item.round_label}</span>
          {item.tool_names.length > 0 && (
            <span className="ml-auto text-gray-400 font-normal shrink-0">
              {item.tool_names.length} tools{item.bytes ? ` · ${formatBytes(item.bytes)}` : ''}
            </span>
          )}
        </button>
        {open && (
          <div className="mt-1.5 bg-gray-800 rounded-lg overflow-hidden text-xs font-mono">
            <PromptBodyStatus loading={loading} error={error} className="text-gray-400" />
            {body?.system_prompt && (
              <div className="px-3 py-2 border-b border-gray-700">
                <p className="text-gray-500 mb-1">system</p>
                <pre className="text-gray-300 whitespace-pre-wrap break-words">{body.system_prompt}</pre>
              </div>
            )}
            {(body?.messages ?? []).map((m, i) => (
              <div key={i} className="px-3 py-2 border-b border-gray-800 last:border-b-0">
                <p className="text-gray-500 mb-1">{m.role}</p>
                <pre className="text-gray-300 whitespace-pre-wrap break-words">
                  {typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}
                </pre>
              </div>
            ))}
            {item.tool_names.length > 0 && (
              <div className="px-3 py-2 border-t border-gray-700">
                <p className="text-gray-500 mb-1">tools</p>
                <p className="text-gray-300">{item.tool_names.join(', ')}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DaemonToolCallCard({ item }: { item: ChatDaemonToolCall | ChatDaemonControlToolCall }) {
  const [open, setOpen] = useState(false)
  const argStr = (() => {
    try { return JSON.stringify(item.arguments, null, 2) } catch { return String(item.arguments) }
  })()
  const isControl = item.kind === 'daemon_control_tool_call'
  return (
    <div className="flex items-start gap-2 px-1 opacity-50">
      <div className="w-6 h-6 rounded border border-dashed border-gray-300 flex items-center justify-center flex-shrink-0 mt-0.5">
        {isControl
          ? <Settings size={11} className="text-gray-400" />
          : <Wrench size={11} className="text-gray-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-500 transition-colors w-full text-left"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="font-mono italic">{item.tool_name}</span>
          {item.is_error
            ? <XCircle size={11} className="text-red-300 ml-auto flex-shrink-0" />
            : <CheckCircle2 size={11} className="text-gray-300 ml-auto flex-shrink-0" />}
        </button>
        {open && (
          <div className="mt-1.5 bg-gray-800 rounded-lg overflow-hidden text-xs">
            {argStr !== '{}' && (
              <div className="px-3 py-2 border-b border-gray-700">
                <p className="text-gray-500 mb-1">参数</p>
                <pre className="text-yellow-400/70 overflow-x-auto whitespace-pre-wrap break-words">{argStr}</pre>
              </div>
            )}
            <div className="px-3 py-2">
              <p className="text-gray-500 mb-1">{item.is_error ? '错误' : '结果'}</p>
              <pre className={clsx(
                'overflow-x-auto whitespace-pre-wrap break-words',
                item.is_error ? 'text-red-400/70' : 'text-gray-400'
              )}>{item.result || '(空)'}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ErrorEventCard({ item }: { item: ChatErrorEvent }) {
  return (
    <div className="flex items-start gap-2 px-1">
      <div className="w-6 h-6 rounded bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <XCircle size={13} className="text-red-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-red-600">
            {item.will_retry ? '任务失败，正在重试…' : '任务失败'}
          </span>
          {item.error_type && (
            <span className="text-xs font-mono text-red-400 bg-red-50 px-1.5 py-0.5 rounded">
              {item.error_type}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-red-500 break-words">{item.error}</p>
        {item.created_at && (
          <p className="text-xs text-gray-400 mt-1">{formatTime(item.created_at)}</p>
        )}
      </div>
    </div>
  )
}

function CompactMarker({ item }: { item: ChatCompactMarker }) {
  const k = item.freed_tokens >= 1000
    ? `${(item.freed_tokens / 1000).toFixed(1)}k`
    : `${item.freed_tokens}`
  return (
    <div className="flex justify-center my-1">
      <div className="flex items-center gap-1.5 text-[11px] text-gray-400 select-none">
        <span className="h-px w-8 bg-gray-200" />
        <span>
          上下文已压缩 · 精简 {item.total_superseded} 条
          {item.freed_tokens > 0 ? ` · 省 ~${k} token` : ''}
        </span>
        <span className="h-px w-8 bg-gray-200" />
      </div>
    </div>
  )
}

// ── Activity strip (above input): vibe word / tool name + live duration ───────

function ActivityStrip({ activity }: { activity: ActivityState | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!activity) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [activity])
  if (!activity) return null
  const elapsed = Date.now() - new Date(activity.started_at).getTime()
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-gray-500">
      <Loader2 size={12} className="animate-spin text-blue-500" />
      <span>{activityLabel(activity, elapsed)}</span>
      <span className="text-gray-400">· {formatDuration(elapsed)}</span>
    </div>
  )
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'message': return <MessageBubble item={item} />
    case 'tool_call': return <ToolCallCard item={item} />
    case 'control_tool_call': return <ControlToolCallCard item={item} />
    case 'task_event': return null
    case 'waiting_input': return null // handled by input area
    case 'llm_prompt': return <LLMPromptCard item={item} />
    case 'observer_message': return <ObserverBubble item={item} />
    case 'observer_tool_call': return <ObserverToolCallCard item={item} />
    case 'observer_control_tool_call': return <ObserverToolCallCard item={item} />
    case 'daemon_message': return <DaemonMessageCard item={item} />
    case 'daemon_prompt': return <DaemonPromptCard item={item} />
    case 'daemon_tool_call': return <DaemonToolCallCard item={item} />
    case 'daemon_control_tool_call': return <DaemonToolCallCard item={item} />
    case 'error_event': return <ErrorEventCard item={item} />
    case 'compact_marker': return <CompactMarker item={item} />
  }
}

// ── Input area ────────────────────────────────────────────────────────────────

interface Attachment {
  file: File
  dataUrl: string   // base64 data URL for preview + sending
  mediaType: string
}

function AttachmentPreview({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (i: number) => void }) {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {attachments.map((a, i) => (
        <div key={i} className="relative group w-14 h-14 rounded-lg overflow-hidden border border-gray-200 flex-shrink-0">
          <img src={a.dataUrl} alt="" className="w-full h-full object-cover" />
          <button
            onClick={() => onRemove(i)}
            className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X size={14} className="text-white" />
          </button>
        </div>
      ))}
    </div>
  )
}

function TextInput({
  sessionId,
  session,
  disabled,
  onReconnect,
  onInterrupt,
  interruptPending,
}: {
  sessionId: string
  session: Session | null
  disabled?: boolean
  onReconnect?: () => void
  onInterrupt?: () => void
  interruptPending?: boolean
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [llmProvider, setLlmProvider] = useState<string>('')
  const [llmModel, setLlmModel] = useState<string>('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const { data: llms } = useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })

  // Sync LLM selectors with session when session loads or changes
  useEffect(() => {
    setLlmProvider(session?.llm_account ?? '')
    setLlmModel(session?.llm_model ?? '')
  }, [session?.llm_account, session?.llm_model])

  const selectedProvider = llms?.find(l => l.name === llmProvider)

  const mutation = useMutation({
    mutationFn: (content: string | ContentPart[]) =>
      sessionsApi.sendMessage(sessionId, content, null, llmProvider || null, llmModel || null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      setText('')
      setAttachments([])
      textareaRef.current?.focus()
      // Re-open SSE stream when continuing a terminal session
      onReconnect?.()
    },
  })

  const submit = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || mutation.isPending || disabled) return

    if (attachments.length > 0) {
      const parts: ContentPart[] = [
        ...attachments.map((a): ImagePart => ({
          type: 'image',
          data: a.dataUrl.split(',')[1],
          media_type: a.mediaType,
          source_type: 'base64',
        })),
        ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
      ]
      mutation.mutate(parts)
    } else {
      mutation.mutate(trimmed)
    }
  }

  const handleFiles = (files: FileList | null) => {
    if (!files) return
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = e => {
        const dataUrl = e.target?.result as string
        setAttachments(prev => [...prev, { file, dataUrl, mediaType: file.type }])
      }
      reader.readAsDataURL(file)
    })
  }

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [text])

  const canSend = (text.trim() || attachments.length > 0) && !mutation.isPending && !disabled

  return (
    <div className="border-t border-gray-200 bg-white p-3">
      {mutation.isError && <p className="text-xs text-red-500 mb-2">发送失败，请重试</p>}
      {/* LLM switcher */}
      {llms && llms.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-xs text-gray-400 flex-shrink-0">LLM</span>
          <select
            value={llmProvider}
            onChange={e => { setLlmProvider(e.target.value); setLlmModel('') }}
            disabled={disabled}
            className="text-xs border border-gray-200 rounded px-1.5 py-0.5 text-gray-600 bg-white focus:outline-none focus:border-blue-400 disabled:opacity-50 disabled:bg-gray-50"
          >
            <option value="">默认</option>
            {llms.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
          {selectedProvider && selectedProvider.models.length > 0 && (
            <select
              value={llmModel}
              onChange={e => setLlmModel(e.target.value)}
              disabled={disabled}
              className="text-xs border border-gray-200 rounded px-1.5 py-0.5 text-gray-600 bg-white focus:outline-none focus:border-blue-400 disabled:opacity-50 disabled:bg-gray-50"
            >
              <option value="">默认（{selectedProvider.default_model}）</option>
              {selectedProvider.models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          )}
        </div>
      )}
      <AttachmentPreview attachments={attachments} onRemove={i => setAttachments(prev => prev.filter((_, idx) => idx !== i))} />
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0 disabled:opacity-40"
          title="附加图片"
        >
          <Paperclip size={15} />
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          onPaste={e => {
            const items = e.clipboardData?.items
            if (!items) return
            const imageItems = Array.from(items).filter(it => it.type.startsWith('image/'))
            if (imageItems.length === 0) return
            e.preventDefault()
            imageItems.forEach(it => {
              const file = it.getAsFile()
              if (file) handleFiles(Object.assign(new DataTransfer(), { files: [file] as unknown as FileList }).files)
            })
          }}
          placeholder={disabled ? 'Agent 正在运行中...' : '向 Agent 发送消息… (Enter 发送，Shift+Enter 换行)'}
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 leading-5 disabled:bg-gray-50 disabled:text-gray-400"
        />
        {disabled && onInterrupt ? (
          <button
            onClick={onInterrupt}
            disabled={interruptPending}
            title="中断 Agent"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors flex-shrink-0 bg-red-100 text-red-500 hover:bg-red-200 disabled:opacity-40"
          >
            {interruptPending
              ? <Loader2 size={14} className="animate-spin" />
              : <Square size={14} />}
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            className={clsx(
              'flex items-center justify-center w-8 h-8 rounded-lg transition-colors flex-shrink-0',
              canSend ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            )}
          >
            {mutation.isPending ? <Spinner size="sm" /> : <Send size={14} />}
          </button>
        )}
      </div>
    </div>
  )
}

async function resolveHitlId(sessionId: string, wi: ChatWaitingInput): Promise<string | null> {
  if (wi.hitl_id) return wi.hitl_id
  try {
    const pending = await hitlApi.pending(sessionId)
    if (wi.form) return (pending.find(p => p.form === wi.form) ?? pending[0])?.id ?? null
    return pending[0]?.id ?? null
  } catch {
    return null
  }
}

function BashExecConfirmArea({
  sessionId,
  waitingInput,
}: {
  sessionId: string
  waitingInput: ChatWaitingInput
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const queryClient = useQueryClient()

  const mutation = useMutation({
    // 审批走精确端点:approved→approve / 其余文本→reject(message);拿不到 id → 旧 /messages 兜底
    mutationFn: async (answer: string) => {
      const id = await resolveHitlId(sessionId, waitingInput)
      if (id) {
        try {
          if (answer === 'approved') return await hitlApi.approve(id)
          return await hitlApi.reject(id, answer === 'rejected' ? '' : answer)
        } catch { /* fall through */ }
      }
      // 兜底走 /messages 词表路由:拒绝理由必须以 reject 词开头,否则会被误判为 approve(放行!)
      const fallbackText = answer === 'approved' || answer === 'rejected' ? answer : `rejected ${answer}`
      return sessionsApi.sendMessage(sessionId, fallbackText)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      setReason('')
      setRejecting(false)
    },
  })

  return (
    <div className="border-t border-orange-200 bg-orange-50 p-3">
      <div className="flex items-start gap-2 mb-2">
        <div className="w-5 h-5 rounded bg-orange-100 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Wrench size={11} className="text-orange-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-orange-800">Agent 请求执行命令</p>
          <pre className="mt-1.5 bg-gray-900 text-green-300 text-xs rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all">
            {waitingInput.command || ''}
          </pre>
        </div>
      </div>
      {mutation.isError && <p className="text-xs text-red-500 mb-2">提交失败，请重试</p>}
      {!rejecting ? (
        <div className="flex gap-2">
          <button
            onClick={() => mutation.mutate('approved')}
            disabled={mutation.isPending}
            className="flex-1 rounded-lg bg-green-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? <Spinner size="sm" /> : '允许执行'}
          </button>
          <button
            onClick={() => setRejecting(true)}
            disabled={mutation.isPending}
            className="flex-1 rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
          >
            拒绝
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                mutation.mutate(reason.trim() || 'rejected')
              }
            }}
            placeholder="（可选）说明拒绝原因… (Enter 提交)"
            rows={1}
            className="resize-none rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-400 focus:ring-1 focus:ring-red-300 leading-5"
          />
          <div className="flex gap-2">
            <button onClick={() => setRejecting(false)} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">返回</button>
            <button
              onClick={() => mutation.mutate(reason.trim() || 'rejected')}
              disabled={mutation.isPending}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
            >
              {mutation.isPending ? <Spinner size="sm" /> : <><Send size={12} />确认拒绝</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function WaitingInputArea({
  sessionId,
  waitingInput,
}: {
  sessionId: string
  waitingInput: ChatWaitingInput
}) {
  const [text, setText] = useState('')
  const [rejected, setRejected] = useState(false)
  const [feedback, setFeedback] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const queryClient = useQueryClient()

  if (waitingInput.input_type === 'bash_exec_confirm') {
    return <BashExecConfirmArea sessionId={sessionId} waitingInput={waitingInput} />
  }

  const isTaskConfirm = waitingInput.input_type === 'task_completion_confirm'

  const mutation = useMutation({
    // 提问/软待命面板应答走精确端点;拿不到 id → 旧 /messages 兜底
    mutationFn: async (content: string) => {
      const id = await resolveHitlId(sessionId, waitingInput)
      if (id) {
        try { return await hitlApi.answer(id, content) } catch { /* fall through */ }
      }
      return sessionsApi.sendMessage(sessionId, content)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      setText('')
    },
  })

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [text, feedback])

  if (isTaskConfirm) {
    return (
      <div className="border-t border-amber-200 bg-amber-50 p-3">
        <div className="flex items-start gap-2 mb-3">
          <MessageCircleQuestion size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm text-amber-800 font-medium">请确认任务是否完成</p>
            <p className="text-xs text-amber-700 mt-0.5 truncate">任务：{waitingInput.task_title}</p>
          </div>
        </div>
        {mutation.isError && <p className="text-xs text-red-500 mb-2">提交失败，请重试</p>}
        {!rejected ? (
          <div className="flex gap-2">
            <button
              onClick={() => mutation.mutate('用户已确认任务完成。')}
              disabled={mutation.isPending}
              className="flex-1 rounded-lg bg-green-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              {mutation.isPending ? <Spinner size="sm" /> : '已完成'}
            </button>
            <button
              onClick={() => setRejected(true)}
              disabled={mutation.isPending}
              className="flex-1 rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
            >
              未完成，需重试
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              ref={textareaRef}
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="（可选）补充说明… (Enter 提交)"
              rows={1}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  const msg = feedback.trim()
                    ? `用户表示任务未完成，请重试。用户补充说明：${feedback.trim()}`
                    : '用户表示任务未完成，请重试。'
                  mutation.mutate(msg)
                }
              }}
              className="resize-none rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-400 focus:ring-1 focus:ring-red-300 leading-5"
            />
            <div className="flex gap-2">
              <button onClick={() => setRejected(false)} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">返回</button>
              <button
                onClick={() => {
                  const msg = feedback.trim()
                    ? `用户表示任务未完成，请重试。用户补充说明：${feedback.trim()}`
                    : '用户表示任务未完成，请重试。'
                  mutation.mutate(msg)
                }}
                disabled={mutation.isPending}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                {mutation.isPending ? <Spinner size="sm" /> : <><Send size={12} />提交</>}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Normal user input
  return (
    <div className="border-t border-amber-200 bg-amber-50 p-3">
      <div className="flex items-start gap-2 mb-2">
        <MessageCircleQuestion size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
        <p className="text-sm text-amber-800 font-medium">{waitingInput.prompt || '请输入您的回复'}</p>
      </div>
      {mutation.isError && <p className="text-xs text-red-500 mb-2">提交失败，请重试</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mutation.mutate(text.trim()) } }}
          placeholder="输入您的回复… (Enter 提交，Shift+Enter 换行)"
          rows={1}
          className="flex-1 resize-none rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-400 leading-5"
        />
        <button
          onClick={() => { if (text.trim()) mutation.mutate(text.trim()) }}
          disabled={!text.trim() || mutation.isPending}
          className={clsx(
            'flex items-center justify-center w-8 h-8 rounded-lg transition-colors flex-shrink-0',
            text.trim() && !mutation.isPending
              ? 'bg-amber-500 text-white hover:bg-amber-600'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          )}
        >
          {mutation.isPending ? <Spinner size="sm" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  )
}

// ── Main ChatPanel ────────────────────────────────────────────────────────────

interface ChatPanelProps {
  sessionId: string
  onReconnected?: () => void
}

export function ChatPanel({ sessionId, onReconnected }: ChatPanelProps) {
  const {
    session,
    tasks,
    daemonTasks,
    items,
    waitingInput,
    streamingText,
    streamingReasoning,
    streamingImages,
    observerStreamingText,
    observerStreamingReasoning,
    currentActivity,
    connected,
    notice,
    reconnect,
  } = useSessionSSE(sessionId)
  const [showTasks, setShowTasks] = useState(false)
  // FAILED 框「继续对话」的本地关栏标记：不持久化，刷新后若仍 FAILED 框重现；换会话复位。
  // 会话离开 FAILED（继续对话后重跑）也复位——否则同会话第二次失败会被上次的关栏吞掉。
  // 复位用 render 期调整（React 官方模式）而非 effect：避免 set-state-in-effect lint，
  // 且不多一帧闪烁。
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const [noticeSessionId, setNoticeSessionId] = useState(sessionId)
  if (noticeSessionId !== sessionId) {
    setNoticeSessionId(sessionId)
    setNoticeDismissed(false)
  }
  if (noticeDismissed && session?.status !== 'FAILED') {
    setNoticeDismissed(false)
  }
  const queryClient = useQueryClient()

  const interruptMutation = useMutation({
    mutationFn: () => sessionsApi.interrupt(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })

  const resumeMutation = useMutation({
    mutationFn: (body?: { llm_account?: string; llm_model?: string }) =>
      sessionsApi.resume(sessionId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      reconnect()
    },
  })
  // SSE 重连（断后恢复）时通知父组件重新挂载，等同于刷新页面效果
  // 用 hadDisconnect 区分「首次连接」和「断后重连」，避免无限循环
  const prevConnectedRef = useRef(false)
  const hadDisconnectRef = useRef(false)
  useEffect(() => {
    if (prevConnectedRef.current && !connected) {
      hadDisconnectRef.current = true
    }
    if (!prevConnectedRef.current && connected && hadDisconnectRef.current && items.length > 0) {
      hadDisconnectRef.current = false
      onReconnected?.()
    }
    prevConnectedRef.current = connected
  }, [connected]) // eslint-disable-line react-hooks/exhaustive-deps

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  const handleScroll = () => {
    const el = scrollContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    userScrolledUp.current = !atBottom
  }

  // Auto-scroll to bottom on new items or streaming updates, unless user scrolled up
  useEffect(() => {
    if (userScrolledUp.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [items.length, streamingText, streamingReasoning, observerStreamingText, observerStreamingReasoning])

  // When new message items arrive, reset scroll lock and jump to bottom
  useEffect(() => {
    userScrolledUp.current = false
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items.length])

  const { data: llms } = useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })
  const sessionContextLimit = llms?.find(l => l.name === session?.llm_account)
    ?.models.find(m => m.name === session?.llm_model)?.context_limit ?? 0

  const isRunning = session?.status === 'RUNNING' || session?.status === 'QUEUED'
  const isInterrupted = session?.status === 'INTERRUPTED'
  const activeTaskCount = tasks.filter(t => t.status === 'ACTIVE').length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{session?.goal || '加载中…'}</p>
          <div className="flex items-center gap-2 mt-0.5">
            {session && <SessionStatusBadge status={session.status} />}
            {session && session.output_tokens_used > 0 && (
              <span className="text-xs text-gray-400">
                ↓ {(session.output_tokens_used / 1000).toFixed(1)}k{session.token_budget > 0 && ` / ${(session.token_budget / 1000).toFixed(0)}k`}
                {session.input_tokens_used > 0 && (
                  <span className="ml-1 text-gray-300">· ↑ {(session.input_tokens_used / 1000).toFixed(1)}k</span>
                )}
                {session.context_tokens > 0 && (
                  <span className="ml-1 text-blue-400">
                    · 窗口 {(session.context_tokens / 1000).toFixed(1)}k{sessionContextLimit > 0 ? ` / ${(sessionContextLimit / 1000).toFixed(0)}k` : ''}
                  </span>
                )}
              </span>
            )}
            {session?.llm_account && (
              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                {session.llm_account}{session.llm_model ? ` / ${session.llm_model}` : ''}
              </span>
            )}
            {!connected && (
              <span className="text-xs text-orange-500 flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                连接中
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isRunning && (
            <div className="flex items-center gap-1 text-xs text-blue-600">
              <Loader2 size={12} className="animate-spin" />
              <span>运行中</span>
            </div>
          )}
          {(tasks.length > 0 || daemonTasks.length > 0) && (
            <button
              onClick={() => setShowTasks(v => !v)}
              className={clsx(
                'relative flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors',
                showTasks
                  ? 'bg-blue-100 text-blue-700'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
              )}
              title="查看任务列表"
            >
              <ListChecks size={14} />
              <span>{tasks.length}</span>
              {daemonTasks.length > 0 && (
                <span className="opacity-50">· d{daemonTasks.length}</span>
              )}
              {activeTaskCount > 0 && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Body: message list + task panel overlay */}
      <div className="relative flex-1 overflow-hidden flex flex-col">

      {/* Message list */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {!session ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
            <Bot size={32} />
            <p className="text-sm">等待 Agent 开始工作…</p>
          </div>
        ) : (
          items.map(item => (
            <ChatItemView key={item.id} item={item} />
          ))
        )}

        {/* Actor streaming bubble */}
        {(streamingText || streamingReasoning || (streamingImages?.length ?? 0) > 0) && (
          <StreamingBubble text={streamingText ?? ''} reasoning={streamingReasoning ?? undefined} images={streamingImages ?? []} />
        )}

        {/* Observer streaming bubble */}
        {(observerStreamingText || observerStreamingReasoning) && (
          <ObserverStreamingBubble text={observerStreamingText ?? ''} reasoning={observerStreamingReasoning ?? undefined} />
        )}

        {/* Terminal status（FAILED 由底部 SessionNoticeBar 呈现）*/}
        {session && (session.status === 'SUCCEEDED' || session.status === 'CANCELED') && (
          <div className="flex justify-center">
            <div className={clsx(
              'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full',
              session.status === 'SUCCEEDED' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
            )}>
              {session.status === 'SUCCEEDED' && <CheckCircle2 size={11} />}
              <span>{session.status === 'SUCCEEDED' ? '会话已完成' : '会话已取消'}</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Task panel overlay */}
      {showTasks && (
        <div className="absolute inset-y-0 right-0 w-80 bg-white border-l border-gray-200 shadow-lg flex flex-col z-10">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <ListChecks size={14} className="text-gray-500" />
              <span className="text-sm font-medium text-gray-900">Tasks</span>
              <span className="text-xs text-gray-400">
                ({tasks.length}{daemonTasks.length > 0 ? ` · d${daemonTasks.length}` : ''})
              </span>
            </div>
            <button
              onClick={() => setShowTasks(false)}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <TaskTimeline tasks={tasks} daemonTasks={daemonTasks} isLoading={false} />
          </div>
        </div>
      )}

      </div>{/* end body wrapper */}

      {/* Activity strip —— 输入框上方，显示当前在干嘛 + 时长 */}
      {!waitingInput && <ActivityStrip activity={currentActivity} />}

      {/* Input area：FAILED（未点继续）/INTERRUPTED 时由通告框整体替换输入框 */}
      {waitingInput ? (
        <WaitingInputArea sessionId={sessionId} waitingInput={waitingInput} />
      ) : isInterrupted || (session?.status === 'FAILED' && !noticeDismissed) ? (
        <SessionNoticeBar
          status={isInterrupted ? 'INTERRUPTED' : 'FAILED'}
          notice={notice}
          onContinue={() => setNoticeDismissed(true)}
          onResume={llm => resumeMutation.mutate(llm)}
          resumePending={resumeMutation.isPending}
        />
      ) : (
        <TextInput
          sessionId={sessionId}
          session={session ?? null}
          disabled={isRunning}
          onReconnect={reconnect}
          onInterrupt={() => interruptMutation.mutate()}
          interruptPending={interruptMutation.isPending}
        />
      )}
    </div>
  )
}
