import * as pdfjsLib from 'pdfjs-dist'
// Vite resolves this to a bundled worker asset URL; the worker version matches
// the main bundle because it's the same npm package (avoids version-mismatch errors).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// pdfjs-dist/web/pdf_viewer.mjs reads `globalThis.pdfjsLib` at module load time
// (it destructures `AbortException`, `PDFViewer`, etc. from it). This file MUST
// be imported (and evaluated) before any module that imports 'pdfjs-dist/web/
// pdf_viewer.mjs'. Without this assignment, production builds crash with
// "Cannot destructure property 'AbortException' of 'globalThis.pdfjsLib' as it
// is undefined." (dev mode happens to work due to a different evaluation order).
;(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib

// CMaps are copied to `<base>/cmaps/` by vite-plugin-static-copy (see vite.config.ts).
export const CMAP_URL = `${import.meta.env.BASE_URL}cmaps/`
export const CMAP_PACKED = true

export { pdfjsLib }
