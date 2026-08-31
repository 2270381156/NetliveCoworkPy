import { type ReactNode, useEffect } from 'react'
import { clsx } from 'clsx'
import { X } from 'lucide-react'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  width?: string
}

export function Drawer({ open, onClose, title, children, width = 'w-[480px]' }: DrawerProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      )}
      <div
        className={clsx(
          'fixed right-0 top-0 h-full bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300',
          width,
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          {title && <h2 className="text-base font-semibold text-gray-900">{title}</h2>}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors ml-auto"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </>
  )
}
