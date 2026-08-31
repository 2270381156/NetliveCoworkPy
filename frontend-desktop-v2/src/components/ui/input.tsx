import { cn } from '@/lib/utils'
import { type InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export function Input({ label, error, className, ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs" style={{ color: 'var(--t2)' }}>{label}</label>}
      <input
        className={cn(
          'h-8 rounded-md border px-3 text-sm',
          'focus:outline-none focus:ring-1 focus:ring-[#2563eb]',
          'disabled:opacity-50',
          error && 'border-red-400',
          className,
        )}
        style={{ borderColor: 'var(--border)', background: 'var(--bg2)', color: 'var(--t1)' }}
        {...props}
      />
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  )
}

export function Select({ label, error, className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string; error?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs" style={{ color: 'var(--t2)' }}>{label}</label>}
      <select
        className={cn(
          'h-8 rounded-md border px-2 text-sm',
          'focus:outline-none focus:ring-1 focus:ring-[#2563eb]',
          className,
        )}
        style={{ borderColor: 'var(--border)', background: 'var(--bg2)', color: 'var(--t1)' }}
        {...props}
      >
        {children}
      </select>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  )
}
