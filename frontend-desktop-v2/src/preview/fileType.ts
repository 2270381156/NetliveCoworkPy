export type PreviewType =
  | 'image' | 'markdown' | 'docx' | 'excel'
  | 'code' | 'text' | 'pdf' | 'pptx' | 'binary'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'svg'])
const MD_EXTS = new Set(['md', 'markdown'])
const DOCX_EXTS = new Set(['docx'])
const EXCEL_EXTS = new Set(['xlsx', 'xls', 'csv'])
const PDF_EXTS = new Set(['pdf'])
const PPTX_EXTS = new Set(['pptx'])
const TEXT_EXTS = new Set(['txt', 'log', 'rst', 'xml', 'html', 'htm', 'less', 'vue', 'php', 'rb', 'swift'])

// Maps file extension -> highlight.js language id.
export const CODE_LANGS: Record<string, string> = {
  py: 'python', js: 'javascript', ts: 'typescript',
  jsx: 'javascript', tsx: 'typescript', sh: 'bash', bash: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  css: 'css', scss: 'scss', go: 'go', rs: 'rust',
  java: 'java', cpp: 'cpp', c: 'c', kt: 'kotlin',
}

export function getExt(p: string): string {
  const name = p.split(/[/\\]/).pop() ?? p
  return name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : ''
}

export function fileType(ext: string): PreviewType {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (MD_EXTS.has(ext)) return 'markdown'
  if (DOCX_EXTS.has(ext)) return 'docx'
  if (EXCEL_EXTS.has(ext)) return 'excel'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (PPTX_EXTS.has(ext)) return 'pptx'
  if (ext in CODE_LANGS) return 'code'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}
