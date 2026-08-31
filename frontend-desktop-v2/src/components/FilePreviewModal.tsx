import { useEffect } from 'react'
import { XIcon, FileIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { getExt, fileType, CODE_LANGS } from '@/preview/fileType'
import { PreviewToolbarProvider } from '@/preview/toolbar/PreviewToolbarContext'
import { PreviewToolbar } from '@/preview/toolbar/PreviewToolbar'
import { TocSidebar } from '@/preview/toolbar/TocSidebar'
import { ImageViewer } from '@/preview/viewers/ImageViewer'
import { MarkdownViewer } from '@/preview/viewers/MarkdownViewer'
import { CodeViewer } from '@/preview/viewers/CodeViewer'
import { TextViewer } from '@/preview/viewers/TextViewer'
import { DocxViewer } from '@/preview/viewers/DocxViewer'
import { ExcelViewer } from '@/preview/viewers/ExcelViewer'
import { PdfViewer } from '@/preview/viewers/PdfViewer'
import { PptxViewer } from '@/preview/viewers/PptxViewer'

interface Props {
  path: string
  onClose: () => void
  // Swap the previewed file to another workspace document (in-markdown links).
  onNavigate?: (path: string) => void
}

export function FilePreviewModal({ path, onClose, onNavigate }: Props) {
  const { t } = useI18n()
  const ext = getExt(path)
  const type = fileType(ext)
  const name = path.split(/[/\\]/).pop() ?? path

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ background: 'rgba(15,31,61,.35)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative flex flex-col rounded-xl"
        style={{ width: '82vw', height: '85vh', maxWidth: 1200, background: 'var(--bg1)', boxShadow: '0 24px 80px rgba(15,31,61,.22)' }}>
        <PreviewToolbarProvider>
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <FileIcon size={15} className="flex-shrink-0" style={{ color: 'var(--t3)' }} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: 'var(--t2)' }}>{name}</span>
            <Button variant="ghost" size="icon" onClick={onClose}><XIcon size={16} /></Button>
          </div>

          {/* Toolbar (renders nothing if the active viewer declares no capabilities) */}
          <PreviewToolbar />

          {/* Content row: optional left sidebar (TOC) + main content */}
          <div className="flex-1 flex flex-row overflow-hidden">
            <TocSidebar />
            <div className="flex-1 overflow-auto">
              {type === 'image' && <ImageViewer path={path} filename={name} />}
              {type === 'markdown' && <MarkdownViewer path={path} filename={name} onNavigate={onNavigate} />}
              {type === 'docx' && <DocxViewer path={path} filename={name} />}
              {type === 'excel' && <ExcelViewer path={path} filename={name} />}
              {type === 'code' && <CodeViewer path={path} lang={CODE_LANGS[ext]} filename={name} />}
              {type === 'text' && <TextViewer path={path} filename={name} />}
              {type === 'pdf' && <PdfViewer path={path} filename={name} />}
              {type === 'pptx' && <PptxViewer path={path} filename={name} />}
              {type === 'binary' && (
                <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--t3)' }}>
                  {t('filePreview.unsupported', { ext: ext || t('filePreview.unknownExt') })}
                </div>
              )}
            </div>
          </div>
        </PreviewToolbarProvider>
      </div>
    </div>
  )
}
