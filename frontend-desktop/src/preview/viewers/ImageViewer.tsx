import { useRef, useState } from 'react'
import { usePreviewToolbar } from '../toolbar/PreviewToolbarContext'
import { useRawUrl } from './common'

const STEP = 1.25
const MIN = 0.1
const MAX = 8

export function ImageViewer({ path, filename, reloadToken }: { path: string; filename: string; reloadToken?: number }) {
  const raw = useRawUrl()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s))
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }) }

  usePreviewToolbar({
    zoom: {
      in: () => setScale((s) => clamp(s * STEP)),
      out: () => setScale((s) => clamp(s / STEP)),
      reset,
      fit: reset,
      scale,
    },
    download: { url: raw(path), filename },
  }, [scale, path, filename])

  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    setScale((s) => clamp(s * (e.deltaY < 0 ? STEP : 1 / STEP)))
  }
  function onDown(e: React.MouseEvent) {
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
  }
  function onMove(e: React.MouseEvent) {
    if (!drag.current) return
    setOffset({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) })
  }
  function onUp() { drag.current = null }

  return (
    <div
      className="flex h-full items-center justify-center overflow-hidden p-4"
      style={{ background: 'var(--bg2)', cursor: scale > 1 ? 'grab' : 'default' }}
      onWheel={onWheel}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
    >
      <img
        src={raw(path, reloadToken)}
        alt={path}
        draggable={false}
        className="max-h-full max-w-full object-contain rounded shadow select-none"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: 'center' }}
      />
    </div>
  )
}
