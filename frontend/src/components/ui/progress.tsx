import { clsx } from 'clsx'

interface ProgressProps {
  value: number
  max: number
  className?: string
  showLabel?: boolean
}

export function Progress({ value, max, className, showLabel = false }: ProgressProps) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  const color =
    pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-blue-500'

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="flex-1 bg-gray-200 rounded-full h-1.5 overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all duration-300', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
          {value.toLocaleString()} / {max.toLocaleString()}
        </span>
      )}
    </div>
  )
}
