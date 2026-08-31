import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { clsx } from 'clsx'

interface MarkdownContentProps {
  content: string
  invert?: boolean // true when on a dark/colored background (e.g. blue user bubble)
  streaming?: boolean
}

export function MarkdownContent({ content, invert = false, streaming = false }: MarkdownContentProps) {
  return (
    <div className={clsx('markdown-body text-sm leading-relaxed', invert && 'markdown-invert')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0 whitespace-pre-wrap break-words">{children}</p>,
          h1: ({ children }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-bold mb-1.5 mt-3 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc list-outside pl-4 mb-2 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-outside pl-4 mb-2 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="break-words">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className={clsx(
              'border-l-2 pl-3 my-2 italic',
              invert ? 'border-blue-300 text-blue-100' : 'border-gray-300 text-gray-500'
            )}>{children}</blockquote>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.startsWith('language-')
            if (isBlock) {
              const lang = className?.replace('language-', '') ?? ''
              return (
                <div className="my-2 rounded-lg overflow-hidden bg-gray-900 text-xs">
                  {lang && <div className="px-3 py-1 text-gray-400 border-b border-gray-700 font-mono">{lang}</div>}
                  <pre className="px-3 py-2 overflow-x-auto">
                    <code className="text-green-300 whitespace-pre break-normal">{children}</code>
                  </pre>
                </div>
              )
            }
            return (
              <code className={clsx(
                'rounded px-1 py-0.5 font-mono text-xs',
                invert ? 'bg-blue-700 text-blue-100' : 'bg-gray-100 text-gray-800'
              )}>{children}</code>
            )
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={clsx(
                'underline underline-offset-2 hover:opacity-80',
                invert ? 'text-blue-200' : 'text-blue-600'
              )}
            >{children}</a>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          hr: () => <hr className={clsx('my-3', invert ? 'border-blue-400' : 'border-gray-200')} />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse w-full">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className={invert ? 'bg-blue-700' : 'bg-gray-50'}>{children}</thead>,
          th: ({ children }) => (
            <th className={clsx('border px-2 py-1 text-left font-medium', invert ? 'border-blue-500' : 'border-gray-200')}>{children}</th>
          ),
          td: ({ children }) => (
            <td className={clsx('border px-2 py-1', invert ? 'border-blue-500' : 'border-gray-200')}>{children}</td>
          ),
        }}
      >
        {streaming ? content + '​' : content}
      </ReactMarkdown>
      {streaming && (
        <span className="inline-block w-0.5 h-4 bg-gray-400 ml-0.5 align-text-bottom animate-pulse" />
      )}
    </div>
  )
}
