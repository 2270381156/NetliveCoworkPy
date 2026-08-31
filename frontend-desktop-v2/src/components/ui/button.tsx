import { cn } from '@/lib/utils'
import { type ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'icon'
  loading?: boolean
}

export function Button({ variant = 'default', size = 'md', loading, className, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2563eb] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm'   && 'h-7 px-2.5 text-xs',
        size === 'md'   && 'h-8 px-3 text-sm',
        size === 'icon' && 'h-7 w-7 p-0',
        variant === 'default' && 'bg-[#2563eb] text-white hover:bg-[#1d4ed8]',
        variant === 'ghost'   && 'hover:bg-[#eaf0fb]',
        variant === 'outline' && 'border border-[#dde6f3] text-[#3d5a80] hover:bg-[#eaf0fb] hover:border-[#c6d5eb]',
        variant === 'danger'  && 'bg-red-50 text-red-600 hover:bg-red-100',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
