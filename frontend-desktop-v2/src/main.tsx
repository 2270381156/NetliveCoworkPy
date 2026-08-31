// MUST be the first import: pdfSetup sets `globalThis.pdfjsLib` via side effect,
// which pdfjs-dist/web/pdf_viewer.mjs destructures at module load time. Placing
// it at the application entry guarantees the global is installed before any
// later import path reaches pdf_viewer.mjs (a second-line defence; PdfViewer.tsx
// also imports pdfSetup before pdf_viewer).
import './preview/viewers/pdf/pdfSetup'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { LanguageProvider } from './i18n'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)

// Tell the Electron main process the renderer mounted (clears its white-screen
// watchdog). The IPC is idempotent on the main side, so firing it more than once
// is harmless. We fire via TWO paths because each alone has a failure mode:
//   - requestAnimationFrame fires after first paint (nice when visible) BUT is
//     SUSPENDED by Chromium when the window is occluded/minimized/background.
//     On first launch after install the backend wait is long and the NSIS finish
//     window often sits on top, so the window is frequently occluded at the
//     moment the UI loads → rAF never fires → renderer-ready never sent → the
//     20s watchdog falsely reports "界面已打开但未能正常显示".
//   - setTimeout is throttled in the background (clamped to ~1s) but, unlike rAF,
//     still FIRES while occluded — so it guarantees the signal regardless of
//     window visibility.
// Guard for the browser/dev case where the preload bridge isn't present.
const signalReady = () => {
  try {
    ;(window as unknown as { electronAPI?: { signalReady?: () => void } }).electronAPI?.signalReady?.()
  } catch {
    /* not running under Electron */
  }
}
requestAnimationFrame(signalReady) // fast path when visible
setTimeout(signalReady, 0) // visibility-independent fallback (occluded/background)
