// Parse kinds handled by the shared worker. DOCX (docx-preview, DOM-bound) and
// PDF (pdfjs's own worker) do NOT go through here. PPTX used to go through
// here in 0.2.10–0.2.23 but the spike's xmldom-based parser was so slow on
// heavy layouts that we moved it to the main thread (where native DOMParser
// is available) — see file-rendering-upgrade memory entry for context.
export type ParseKind = 'xlsx'

export interface ParseProgress {
  phase: string
  loaded?: number
  total?: number
}

export interface ParseRequestMsg {
  type: 'parse'
  id: string
  kind: ParseKind
  buffer: ArrayBuffer
  options?: Record<string, unknown>
}
export interface ParseProgressMsg { type: 'progress'; id: string; progress: ParseProgress }
export interface ParseResultMsg { type: 'result'; id: string; kind: ParseKind; data: unknown }
export interface ParseErrorMsg { type: 'error'; id: string; error: string }

export type WorkerOutMsg = ParseProgressMsg | ParseResultMsg | ParseErrorMsg

// Result shape for kind 'xlsx'
export interface SheetData { name: string; rows: string[][] }

// Maps each ParseKind to its result payload type. The parse client uses this
// to type its return value.
export interface ParseResultData {
  xlsx: SheetData[]
}
