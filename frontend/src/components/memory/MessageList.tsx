import { clsx } from 'clsx'
import { User, Bot, Wrench } from 'lucide-react'
import type { MemoryMessage } from '@/types'
import { Spinner } from '@/components/ui/spinner'
import { formatTime } from '@/lib/status'
import { MarkdownContent } from '@/components/chat/MarkdownContent'

function MessageBubble({ message }: { message: MemoryMessage }) {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'

  if (isTool) {
    return (
      <div className="flex items-start gap-2 px-1">
        <div className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Wrench size={12} className="text-gray-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="bg-gray-900 rounded-lg px-3 py-2">
            <pre className="text-xs text-green-300 overflow-x-auto whitespace-pre-wrap break-words">
              {message.content}
            </pre>
          </div>
          <p className="text-xs text-gray-400 mt-1">{formatTime(message.created_at)}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={clsx('flex items-start gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={clsx(
          'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
          isUser ? 'bg-blue-500' : 'bg-gray-200'
        )}
      >
        {isUser ? (
          <User size={12} className="text-white" />
        ) : (
          <Bot size={12} className="text-gray-600" />
        )}
      </div>
      <div className={clsx('flex flex-col max-w-[80%]', isUser ? 'items-end' : 'items-start')}>
        <div
          className={clsx(
            'rounded-xl px-3 py-2 text-sm leading-relaxed',
            isUser
              ? 'bg-blue-600 text-white rounded-tr-sm'
              : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm'
          )}
        >
          {isUser
            ? <p className="whitespace-pre-wrap break-words">{message.content}</p>
            : <MarkdownContent content={message.content} />
          }
        </div>
        <p className="text-xs text-gray-400 mt-1 px-1">{formatTime(message.created_at)}</p>
      </div>
    </div>
  )
}

interface MessageListProps {
  messages: MemoryMessage[]
  isLoading: boolean
}

export function MessageList({ messages, isLoading }: MessageListProps) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-gray-400">
        暂无消息记录
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  )
}
