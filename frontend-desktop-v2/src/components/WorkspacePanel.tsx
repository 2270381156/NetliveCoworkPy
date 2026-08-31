import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  FolderIcon, FileIcon, FileCodeIcon, FileTextIcon, FileImageIcon,
  FileTypeIcon, FileSpreadsheetIcon, PresentationIcon,
  ChevronRightIcon, RefreshCwIcon, FolderOpenIcon, ArrowLeftIcon, FolderInputIcon, XIcon,
} from 'lucide-react'
import { fileType, getExt, type PreviewType } from '@/preview/fileType'

import { workspaceApi } from '@/api/workspace'
import { Spinner } from '@/components/ui/spinner'
import { FilePreviewModal } from '@/components/FilePreviewModal'
import { formatBytes } from '@/lib/utils'
import { useI18n } from '@/i18n'

interface Props {
  workingDir: string
  onClose?: () => void
}

function normalizeSep(p: string) {
  return p.replace(/\\/g, '/')
}

export function WorkspacePanel({ workingDir, onClose }: Props) {
  const { t } = useI18n()
  const [browsePath, setBrowsePath] = useState(workingDir || '')
  const [previewFile, setPreviewFile] = useState<string | null>(null)

  const rootPath = workingDir || ''
  const sep = rootPath.includes('\\') ? '\\' : '/'

  useEffect(() => {
    setBrowsePath(workingDir || '')
    setPreviewFile(null)
  }, [workingDir])

  const { data: listing, isLoading, refetch } = useQuery({
    queryKey: ['workspace-files', browsePath],
    queryFn: () => workspaceApi.listFiles(browsePath),
    staleTime: 5000,
  })

  function navigateTo(path: string) {
    setBrowsePath(path)
  }

  const normalizedBrowse = normalizeSep(browsePath)
  const normalizedRoot = normalizeSep(rootPath)

  const relPath =
    normalizedBrowse === normalizedRoot
      ? ''
      : normalizedBrowse.startsWith(normalizedRoot + '/')
        ? normalizedBrowse.slice(normalizedRoot.length + 1)
        : ''

  const relParts = relPath ? relPath.split('/').filter(Boolean) : []

  const rootName = rootPath
    ? normalizeSep(rootPath).split('/').filter(Boolean).pop() ?? '/'
    : '/'

  const isAtRoot = relPath === ''
  const parentPath = isAtRoot ? null : (() => {
    const parts = normalizedBrowse.split('/')
    parts.pop()
    const joined = parts.join('/')
    return joined.replace(/\//g, sep) || rootPath
  })()

  const entries = listing?.entries ?? []
  const dirs = entries.filter(e => e.is_dir)
  const files = entries.filter(e => !e.is_dir)
  const totalCount = entries.length

  return (
    <div className="flex h-full flex-col text-xs">
      {/* Header —— 透明无边线，跟卡片白底一体 */}
      <div>
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <FolderOpenIcon size={16} style={{ color: 'var(--blue)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--t1)' }}>{t('workspace.title')}</span>
          </div>
          <div className="flex items-center gap-1">
            {!isLoading && listing && (
              <span className="text-[10px] mr-1" style={{ color: 'var(--t3)' }}>{t('workspace.items', { count: totalCount })}</span>
            )}
            {window.electronAPI?.openPath && rootPath && (
              <IconBtn title={t('workspace.openInExplorer')} onClick={() => window.electronAPI!.openPath!(rootPath)}>
                <FolderInputIcon size={12} />
              </IconBtn>
            )}
            <IconBtn title={t('workspace.refresh')} onClick={() => refetch()}>
              <RefreshCwIcon size={12} />
            </IconBtn>
            {onClose && (
              <IconBtn title={t('workspace.close')} onClick={onClose}>
                <XIcon size={13} />
              </IconBtn>
            )}
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="relative px-3 pb-2.5">
          <div className="flex items-center gap-0.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            <BreadcrumbChip
              label={rootName}
              active={relParts.length === 0}
              onClick={() => navigateTo(rootPath)}
            />
            {relParts.map((part, i) => (
              <span key={i} className="flex items-center gap-0.5 flex-shrink-0">
                <ChevronRightIcon size={9} style={{ color: 'var(--border2)' }} />
                <BreadcrumbChip
                  label={part}
                  active={i === relParts.length - 1}
                  onClick={() => {
                    const target = normalizedRoot + '/' + relParts.slice(0, i + 1).join('/')
                    navigateTo(target.replace(/\//g, sep))
                  }}
                />
              </span>
            ))}
            {isLoading && <Spinner className="ml-1 flex-shrink-0 w-2.5 h-2.5" />}
          </div>
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {/* Back row */}
        {!isAtRoot && parentPath && (
          <div
            onClick={() => navigateTo(parentPath)}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 mx-2 rounded-lg mb-1 transition-colors"
            style={{ color: 'var(--t3)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)'; (e.currentTarget as HTMLElement).style.color = 'var(--t2)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
          >
            <ArrowLeftIcon size={12} />
            <span className="text-xs">{t('workspace.backToParent')}</span>
          </div>
        )}

        {/* Empty / unconfigured states */}
        {!isLoading && listing && entries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <FolderOpenIcon size={28} style={{ color: 'var(--t3)', opacity: .5 }} />
            <p style={{ color: 'var(--t3)' }}>{t('workspace.empty')}</p>
          </div>
        )}
        {!listing && !isLoading && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <FolderIcon size={28} style={{ color: 'var(--t3)', opacity: .5 }} />
            <p style={{ color: 'var(--t3)' }}>{t('workspace.notConfigured')}</p>
          </div>
        )}

        {/* Directories first */}
        {dirs.map(entry => (
          <FileRow
            key={entry.path}
            name={entry.name}
            isDir
            onNavigate={() => navigateTo(entry.path)}
          />
        ))}

        {/* Files */}
        {files.map(entry => (
          <FileRow
            key={entry.path}
            name={entry.name}
            isDir={false}
            size={entry.size}
            onOpen={() => setPreviewFile(entry.path)}
          />
        ))}
      </div>

      {/* Footer —— 透明无边线 */}
      {listing && entries.length > 0 && (
        <div
          className="flex items-center justify-center gap-2 px-3 py-2 text-[10px]"
          style={{ color: 'var(--t3)' }}
        >
          <span>{t('workspace.folders', { count: dirs.length })}</span>
          <span style={{ color: 'var(--border2)' }}>·</span>
          <span>{t('workspace.files', { count: files.length })}</span>
        </div>
      )}

      {previewFile && (
        <FilePreviewModal path={previewFile} onClose={() => setPreviewFile(null)} onNavigate={setPreviewFile} />
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function BreadcrumbChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 truncate max-w-[90px] rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors"
      style={{
        background: active ? 'var(--blue-dim)' : 'none',
        color: active ? 'var(--blue)' : 'var(--t3)',
        border: 'none',
        cursor: active ? 'default' : 'pointer',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--t2)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
    >
      {label}
    </button>
  )
}

function FileRow({ name, isDir, size, onNavigate, onOpen }: {
  name: string
  isDir: boolean
  size?: number | null
  onNavigate?: () => void
  onOpen?: () => void
}) {
  const { Icon, color } = isDir
    ? { Icon: FolderIcon, color: '#f59e0b' }
    : getFileStyle(name)

  const accentColor = isDir ? '#f59e0b' : 'var(--blue)'

  return (
    <div
      onClick={() => { if (isDir) onNavigate?.(); else onOpen?.() }}
      className="group relative flex cursor-pointer items-center gap-2 px-3 py-1.5 mx-2 rounded-lg"
      style={{ transition: 'background var(--tr)' }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'var(--bg3)'
        const bar = el.querySelector('.accent-bar') as HTMLElement | null
        if (bar) bar.style.opacity = '1'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = ''
        const bar = el.querySelector('.accent-bar') as HTMLElement | null
        if (bar) bar.style.opacity = '0'
      }}
    >
      {/* Left accent bar */}
      <div
        className="accent-bar absolute left-0 top-1 bottom-1 rounded-full"
        style={{ width: 2, background: accentColor, opacity: 0, transition: 'opacity var(--tr)' }}
      />
      <Icon size={13} className="flex-shrink-0" style={{ color }} />
      <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--t2)' }}>{name}</span>
      {size !== null && size !== undefined && (
        <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--t3)' }}>{formatBytes(size)}</span>
      )}
    </div>
  )
}

function IconBtn({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
      style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
    >
      {children}
    </button>
  )
}

// Workspace file-icon mapping. Keyed by the same PreviewType the preview
// platform uses (see src/preview/fileType.ts), so any new format added there
// (Phase 2/3 etc.) just needs a row here — the ext lists stay in one place.
type FileIconComponent = React.FC<{ size?: number; className?: string; style?: React.CSSProperties }>
const FILE_ICONS: Record<PreviewType, { Icon: FileIconComponent; color: string }> = {
  pdf:      { Icon: FileTypeIcon,        color: 'var(--red)' },
  docx:     { Icon: FileTextIcon,        color: 'var(--blue)' },
  excel:    { Icon: FileSpreadsheetIcon, color: 'var(--green)' },
  pptx:     { Icon: PresentationIcon,    color: 'var(--amber)' },
  image:    { Icon: FileImageIcon,       color: 'var(--green)' },
  code:     { Icon: FileCodeIcon,        color: 'var(--blue)' },
  markdown: { Icon: FileTextIcon,        color: 'var(--teal)' },
  text:     { Icon: FileTextIcon,        color: 'var(--teal)' },
  binary:   { Icon: FileIcon,            color: 'var(--t3)' },
}

function getFileStyle(name: string): { Icon: FileIconComponent; color: string } {
  return FILE_ICONS[fileType(getExt(name))]
}
