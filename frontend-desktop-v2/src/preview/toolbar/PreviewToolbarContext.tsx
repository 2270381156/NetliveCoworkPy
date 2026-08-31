import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import type { ViewerCapabilities } from './capabilities'

interface Ctx {
  caps: ViewerCapabilities
  setCapabilities: (c: ViewerCapabilities) => void
  tocOpen: boolean
  setTocOpen: (v: boolean) => void
}
const PreviewToolbarContext = createContext<Ctx | null>(null)

export function PreviewToolbarProvider({ children }: { children: ReactNode }) {
  const [caps, setCaps] = useState<ViewerCapabilities>({})
  // The TOC sidebar is sticky across files (Acrobat-style). The sidebar component
  // itself guards rendering on `caps.toc?.items.length > 0`, so a stale `tocOpen`
  // is harmless for viewers without an outline.
  const [tocOpen, setTocOpenState] = useState(false)
  const setCapabilities = useCallback((c: ViewerCapabilities) => setCaps(c), [])
  const setTocOpen = useCallback((v: boolean) => setTocOpenState(v), [])
  return (
    <PreviewToolbarContext.Provider value={{ caps, setCapabilities, tocOpen, setTocOpen }}>
      {children}
    </PreviewToolbarContext.Provider>
  )
}

// Read current capabilities (used by the toolbar).
export function usePreviewToolbarState(): ViewerCapabilities {
  const ctx = useContext(PreviewToolbarContext)
  if (!ctx) throw new Error('usePreviewToolbarState must be used within PreviewToolbarProvider')
  return ctx.caps
}

// Shared open/close state for the TOC left sidebar (toggled by the toolbar
// Contents button, read by the modal that actually renders the sidebar).
export function useTocSidebar(): { open: boolean; setOpen: (v: boolean) => void } {
  const ctx = useContext(PreviewToolbarContext)
  if (!ctx) throw new Error('useTocSidebar must be used within PreviewToolbarProvider')
  return { open: ctx.tocOpen, setOpen: ctx.setTocOpen }
}

// Register capabilities (used by a viewer). Re-registers when `deps` change,
// and clears on unmount so a switched viewer never inherits stale controls.
export function usePreviewToolbar(caps: ViewerCapabilities, deps: unknown[]): void {
  const ctx = useContext(PreviewToolbarContext)
  if (!ctx) throw new Error('usePreviewToolbar must be used within PreviewToolbarProvider')
  const { setCapabilities } = ctx
  useEffect(() => {
    setCapabilities(caps)
    return () => setCapabilities({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
