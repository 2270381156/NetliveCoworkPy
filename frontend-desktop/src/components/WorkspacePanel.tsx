import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  FolderIcon, FileIcon, FileCodeIcon, FileTextIcon, FileImageIcon,
  FileTypeIcon, FileSpreadsheetIcon, PresentationIcon,
  ChevronRightIcon, RefreshCwIcon, FolderOpenIcon, ArrowLeftIcon, FolderInputIcon, XIcon,
  CloudIcon, UploadCloudIcon, DownloadIcon, Trash2Icon,
} from 'lucide-react'
import { fileType, getExt, type PreviewType } from '@/preview/fileType'

import { workspaceApi } from '@/api/workspace'
import type { BackendId } from '@/api/backends'
import { Spinner } from '@/components/ui/spinner'
import { formatBytes } from '@/lib/utils'
import { useI18n } from '@/i18n'

interface Props {
  /** 定址用：这个会话在哪个后端上，工作区就向谁要（见 api/backends.ts）。 */
  sessionId: string | null
  workingDir: string
  onClose?: () => void
  onPreviewFile?: (path: string) => void   // 点文件 → 在右侧「预览」tab 打开（父组件托管）
  // 本面板是否为当前可见 tab；仅可见时才轮询自动刷新文件列表（默认 true，兼容独立使用）。
  active?: boolean
  /** 云端会话：只影响外观（云图标/标题）与上传入口，数据源和地端是同一套接口。 */
  cloud?: boolean
  /** 云端实例尚未就绪（被回收过、正在冷启动）。此时列不出文件，给用户一个交代。 */
  cloudWarmingUp?: boolean
  /**
   * 云端草稿（会话尚未创建）待上传的文件。给了就渲染"待上传"清单——此刻文件还在
   * 本机、云上还没有目录，和"浏览工作区"是两件事，不该硬塞进同一个视图。
   */
}

function normalizeSep(p: string) {
  return p.replace(/\\/g, '/')
}

// 草稿期（会话未建）与建成之后**用同一套交互**：本地看本地那个目录，云端看云端那个
// 文件夹。此前云端草稿另走一个"待上传"暂存区，文件只存在内存里、建会话时才真传——
// 结果是界面显示"上传成功"而云上什么都没有，用户无从分辨。既然云端的文件夹在选定/新建
// 那一刻就已经存在（CloudFolderPicker 会建它），就没有理由再造一个假的中间态。
export function WorkspacePanel(props: Props) {
  return <Workspace {...props} />
}

/**
 * 工作区浏览。**地端与云端共用这一个实现**——云端会话的工作区是后端在容器里派生
 * 的真实目录，同样由 /workspace/files 列出，所以除了图标与标题，两者没有区别。
 * 早期 demo 曾为云端另写一套 UI，那只是因为当时数据是前端假的。
 */
function Workspace({ sessionId, workingDir, onClose, onPreviewFile, active = true, cloud = false, cloudWarmingUp = false }: Props) {
  const { t } = useI18n()
  // 草稿期没有 sessionId，而 baseOf(null) 会回落到地端——云端草稿必须显式指名，
  // 否则会把云端的路径拿去问本机后端，得到 403「不在任何已登记工作区内」。
  const backend: BackendId | undefined = !sessionId && cloud ? 'cloud' : undefined
  const [browsePath, setBrowsePath] = useState(workingDir || '')
  const uploadRef = useRef<HTMLInputElement>(null)
  // 上传与下载共用一条错误提示：同一处的操作反馈，没必要分两个位置显示。
  const [actionError, setActionError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const rootPath = workingDir || ''
  const sep = rootPath.includes('\\') ? '\\' : '/'

  useEffect(() => {
    setBrowsePath(workingDir || '')
  }, [workingDir])

  const { data: listing, isLoading, refetch } = useQuery({
    // sessionId 进 key：同一路径在不同后端是不同的东西，缓存不能串。
    queryKey: ['workspace-files', sessionId, backend ?? 'auto', browsePath],
    queryFn: () => workspaceApi.listFiles(sessionId, browsePath, backend),
    staleTime: 5000,
    // 自动刷新：仅本 tab 可见时轮询（agent 新建/删除文件即时反映）。窗口失焦时 react-query 默认
    // 暂停轮询（refetchIntervalInBackground=false），聚焦回来自动刷（refetchOnWindowFocus）。
    // 背景重取不置 isLoading，故列表原地更新、不闪 spinner。
    refetchInterval: active ? 3000 : false,
  })

  // 从别的 tab 切回文件 tab → 立即刷一次（轮询本身要等下个周期）。仅在 false→true 时触发。
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) refetch()
    wasActive.current = active
  }, [active, refetch])

  function navigateTo(path: string) {
    setBrowsePath(path)
  }

  const normalizedBrowse = normalizeSep(browsePath)
  // 去掉根路径尾部分隔符再比较：盘符根 "D:\" 归一成 "D:/"，若直接拼 "+ '/'" 会得到 "D://"，
  // 子目录 "D:/sub" 的 startsWith 匹配失败 → relPath 恒空 → 误判为根目录、不显示"返回上级"。
  const normalizedRoot = normalizeSep(rootPath).replace(/\/+$/, '')

  const relPath =
    normalizedBrowse === normalizedRoot || normalizedBrowse === normalizedRoot + '/'
      ? ''
      : normalizedBrowse.startsWith(normalizedRoot + '/')
        ? normalizedBrowse.slice(normalizedRoot.length + 1)
        : ''

  const relParts = relPath ? relPath.split('/').filter(Boolean) : []

  const rootName = normalizedRoot
    ? normalizedRoot.split('/').filter(Boolean).pop() ?? '/'
    : '/'

  const isAtRoot = relPath === ''
  const parentPath = isAtRoot ? null : (() => {
    const parts = normalizedBrowse.split('/')
    parts.pop()
    let joined = parts.join('/')
    // 盘符根的父级需带分隔符：Windows 下 "D:" 是"D 盘当前目录"、"D:\" 才是根盘符。
    if (/^[A-Za-z]:$/.test(joined)) joined += '/'
    return joined.replace(/\//g, sep) || rootPath
  })()

  const entries = listing?.entries ?? []
  const dirs = entries.filter(e => e.is_dir)
  const files = entries.filter(e => !e.is_dir)
  const totalCount = entries.length

  // 打包下载当前浏览的目录。大目录可能要等一会儿，故有独立的忙态。
  const [downloading, setDownloading] = useState(false)
  async function downloadCurrentFolder() {
    if (downloading) return
    setDownloading(true)
    setActionError(null)
    try {
      const name = (normalizeSep(browsePath).split('/').filter(Boolean).pop() || 'workspace') + '.zip'
      await workspaceApi.downloadFolder(sessionId, browsePath, name, backend)
    } catch (e) {
      setActionError((e as Error).message || t('workspace.downloadFailed'))
    } finally {
      setDownloading(false)
    }
  }

  // 删除云端工作区里的文件。**只在云端给**：地端的工作区是用户自己电脑上的目录，
  // 他有资源管理器；而云端那些文件除了这里没有别的入口。
  // 删除不可撤销，故先确认——这一行是悬停才出现的小按钮，误点代价太大。
  async function deleteOne(path: string, name: string, isDir = false) {
    // 目录是递归删，措辞要更重——用户得知道里面的东西一起没。
    const msg = isDir ? t('workspace.deleteDirConfirm', { name }) : t('workspace.deleteConfirm', { name })
    if (!window.confirm(msg)) return
    setActionError(null)
    try {
      if (isDir) await workspaceApi.deleteDir(sessionId, path, backend)
      else await workspaceApi.deleteFile(sessionId, path, backend)
      await refetch()
    } catch (e) {
      setActionError((e as Error).message || t('workspace.deleteFailed'))
    }
  }

  async function downloadOne(path: string, name: string) {
    setActionError(null)
    try {
      await workspaceApi.downloadFile(sessionId, path, name, backend)
    } catch (e) {
      setActionError((e as Error).message || t('workspace.downloadFailed'))
    }
  }

  // 上传落在**当前浏览的目录**，与用户所见一致；传完立刻刷新列表。
  async function uploadInto(list: FileList | null) {
    const picked = list ? Array.from(list) : []
    if (picked.length === 0) return
    setActionError(null)
    setUploading(true)
    try {
      await workspaceApi.upload(sessionId, browsePath, picked, backend)
      await refetch()
    } catch (e) {
      const err = e as Error & { status?: number }
      // 413 = 单文件超限或空间用满，后端给的 detail 已足够具体，直接呈现。
      // 状态码要带上：没有它，"上传失败"这四个字既可能是后端拒绝、也可能是连接层就没成，
      // 两者查的方向完全不同。完整响应体由 api/client.ts 的 failure() 落进 electron.log。
      const where = err.status ? `HTTP ${err.status}` : '连接失败'
      setActionError(`${err.message || t('workspace.uploadFailed')}（${where}）`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div
      className="flex h-full flex-col text-xs"
      onDragOver={e => { if (cloud) e.preventDefault() }}
      onDrop={e => { if (!cloud) return; e.preventDefault(); void uploadInto(e.dataTransfer.files) }}
    >
      {/* Header —— 透明无边线，跟卡片白底一体 */}
      <div>
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {cloud
              ? <CloudIcon size={16} style={{ color: 'var(--teal)', flexShrink: 0 }} />
              : <FolderOpenIcon size={16} style={{ color: 'var(--blue)', flexShrink: 0 }} />}
            <span className="truncate text-sm font-semibold" style={{ color: 'var(--t1)' }}>
              {cloud ? t('workspace.cloudTitle') : t('workspace.title')}
            </span>
          </div>
          <div className="ml-1 flex flex-shrink-0 items-center gap-1">
            {!isLoading && listing && (
              <span className="text-[10px] mr-1" style={{ color: 'var(--t3)' }}>{t('workspace.items', { count: totalCount })}</span>
            )}
            {cloud && (
              <IconBtn title={t('workspace.cloudUpload')} onClick={() => uploadRef.current?.click()}>
                {uploading ? <Spinner className="w-3 h-3" /> : <UploadCloudIcon size={13} />}
              </IconBtn>
            )}
            {window.electronAPI?.openPath && browsePath && !cloud && (
              <IconBtn title={t('workspace.openInExplorer')} onClick={() => window.electronAPI!.openPath!(browsePath)}>
                <FolderInputIcon size={12} />
              </IconBtn>
            )}
            <IconBtn title={t('workspace.downloadFolder')} onClick={() => void downloadCurrentFolder()}>
              {downloading ? <Spinner className="w-3 h-3" /> : <DownloadIcon size={12} />}
            </IconBtn>
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
        {cloudWarmingUp && (
          <div className="mx-3 mb-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
               style={{ color: 'var(--teal)', background: 'var(--bg3)' }}>
            <Spinner className="w-2.5 h-2.5" />
            <span>{t('cloud.warmingUp')}</span>
          </div>
        )}
        {actionError && (
          <div className="mx-3 mb-2 rounded-md px-2 py-1 text-[11px]"
               style={{ color: 'var(--red)', background: 'var(--red-dim)' }}>
            {actionError}
          </div>
        )}
      </div>

      {cloud && (
        <input
          ref={uploadRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={e => { void uploadInto(e.target.files); e.target.value = '' }}
        />
      )}

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
            onRemove={cloud ? (() => void deleteOne(entry.path, entry.name, true)) : undefined}
            removeDestructive
          />
        ))}

        {/* Files */}
        {files.map(entry => (
          <FileRow
            key={entry.path}
            name={entry.name}
            isDir={false}
            size={entry.size}
            onOpen={() => onPreviewFile?.(entry.path)}
            onDownload={() => void downloadOne(entry.path, entry.name)}
            onRemove={cloud ? (() => void deleteOne(entry.path, entry.name)) : undefined}
            removeDestructive
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
    </div>
  )
}

// ── 云端草稿：待上传清单 ────────────────────────────────────
// 会话还没建，云上就还没有工作区；这里展示的是用户已选、等会话建成后才会真正上传
// 的文件。它与「浏览工作区」是两回事，所以单独一个视图；外观沿用同一套 FileRow，
// 用户感受不到差别。文件本体存在父组件的草稿状态里，本组件不持有。

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

function FileRow({ name, isDir, size, onNavigate, onOpen, onRemove, onDownload, removeDestructive }: {
  name: string
  isDir: boolean
  size?: number | null
  onNavigate?: () => void
  onOpen?: () => void
  onRemove?: () => void      // 给了就在行尾显示移除/删除按钮（草稿待上传清单、云端工作区）
  onDownload?: () => void    // 给了就在行尾显示下载按钮（悬停可见）
  /** 真删文件（垃圾桶 + 危险色）；缺省是"从清单里移除"（X），后者不动磁盘。 */
  removeDestructive?: boolean
}) {
  const { Icon, color } = isDir
    ? { Icon: FolderIcon, color: '#f59e0b' }
    : getFileStyle(name)

  const accentColor = isDir ? '#f59e0b' : 'var(--blue)'

  return (
    <div
      onClick={() => { if (isDir) onNavigate?.(); else onOpen?.() }}
      // 拖到聊天输入框 → 在光标处插入文件名（输入框的 onDrop 接收）
      draggable
      onDragStart={e => { e.dataTransfer.setData('text/plain', name); e.dataTransfer.effectAllowed = 'copy' }}
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
      {onDownload && (
        <button
          onClick={e => { e.stopPropagation(); onDownload() }}
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100"
          style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <DownloadIcon size={11} />
        </button>
      )}
      {onRemove && (
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100"
          style={{
            color: removeDestructive ? 'var(--red)' : 'var(--t3)',
            background: 'none', border: 'none', cursor: 'pointer',
          }}
        >
          {removeDestructive ? <Trash2Icon size={11} /> : <XIcon size={11} />}
        </button>
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
  html:     { Icon: FileCodeIcon,        color: 'var(--amber)' },
  image:    { Icon: FileImageIcon,       color: 'var(--green)' },
  code:     { Icon: FileCodeIcon,        color: 'var(--blue)' },
  markdown: { Icon: FileTextIcon,        color: 'var(--teal)' },
  text:     { Icon: FileTextIcon,        color: 'var(--teal)' },
  binary:   { Icon: FileIcon,            color: 'var(--t3)' },
}

function getFileStyle(name: string): { Icon: FileIconComponent; color: string } {
  return FILE_ICONS[fileType(getExt(name))]
}
