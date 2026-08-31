import { cn } from '@/lib/utils'

export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cn('inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300', className)} />
  )
}
