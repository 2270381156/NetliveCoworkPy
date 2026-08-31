import { httpFor, httpForBackend } from './client'
import { LOCAL_BASE, baseOf, getBackend } from './backends'
import type { BackendId } from './backends'
import { downloadUrl } from '@/lib/download'
import type { WorkspaceEntry, WorkspaceListing } from '@/types'

/** 云端存储里一个用户命名的工作区文件夹。 */
export interface WorkspaceFolder {
  name: string
  path: string
  updated_at: number
  entry_count: number
}

export interface WorkspaceUploadResult {
  root: string
  path: string
  uploaded: WorkspaceEntry[]
}

// 工作区接口一律按会话定址：云端会话的文件在云上那个实例里，地端会话的在本机。
// 组件层只管传 sessionId，不需要知道有两个后端（见 api/backends.ts）。
// **草稿期是个例外**：会话还没建、没有 sessionId 可依附，而 baseOf(null) 会回落到地端。
// 本地草稿正好要地端，云端草稿却要云端——所以多给一个显式 backend 形参覆盖它。
// 不传时行为与从前完全一致。
function at(sessionId: string | null | undefined, backend?: BackendId) {
  return backend ? httpForBackend(backend) : httpFor(sessionId)
}
function baseAt(sessionId: string | null | undefined, backend?: BackendId): string {
  return backend ? (getBackend(backend).base || LOCAL_BASE) : baseOf(sessionId)
}

export const workspaceApi = {
  listFiles: (sessionId: string | null | undefined, path = '', backend?: BackendId) =>
    at(sessionId, backend).get<WorkspaceListing>(`/workspace/files?path=${encodeURIComponent(path)}`),
  readFile: (sessionId: string | null | undefined, path: string) =>
    httpFor(sessionId).get<{ path: string; content: string }>(`/workspace/file?path=${encodeURIComponent(path)}`),
  upload: (sessionId: string | null | undefined, path: string, files: File[], backend?: BackendId) =>
    at(sessionId, backend).uploadMany<WorkspaceUploadResult>(
      `/workspace/upload?path=${encodeURIComponent(path)}`,
      files,
    ),
  deleteFile: (sessionId: string | null | undefined, path: string, backend?: BackendId) =>
    at(sessionId, backend).delete<{ path: string; deleted: boolean }>(
      `/workspace/file?path=${encodeURIComponent(path)}`,
    ),

  /** 递归删除工作区内的一个目录。后端会拦：根自身、以及仍被活跃会话占用的目录。 */
  deleteDir: (sessionId: string | null | undefined, path: string, backend?: BackendId) =>
    at(sessionId, backend).delete<{ path: string; deleted: boolean }>(
      `/workspace/dir?path=${encodeURIComponent(path)}`,
    ),

  // 下载一律走 fetch+blob（见 lib/download.ts）：<a download> 跨域失效，而云端后端
  // 就是另一个源；同时为将来加鉴权头留了唯一入口。
  downloadFile: (sessionId: string | null | undefined, path: string, filename: string, backend?: BackendId) =>
    downloadUrl(`${baseAt(sessionId, backend)}/workspace/file/raw?path=${encodeURIComponent(path)}`, filename),
  /** 把一个目录打包成 zip 下载。 */
  downloadFolder: (sessionId: string | null | undefined, path: string, filename: string, backend?: BackendId) =>
    downloadUrl(`${baseAt(sessionId, backend)}/workspace/download?path=${encodeURIComponent(path)}`, filename),

  // 文件夹相关按**后端**定址：新建会话时还没有会话可依附，只能直接问云端那份。
  listFolders: () => httpForBackend('cloud').get<WorkspaceFolder[]>('/workspace/folders'),
  deleteFolder: (name: string) =>
    httpForBackend('cloud').delete<{ name: string; deleted: boolean }>(
      `/workspace/folders/${encodeURIComponent(name)}`,
    ),
  createFolder: (name: string) =>
    httpForBackend('cloud').post<WorkspaceFolder>('/workspace/folders', { name }),

  // 草稿工作区：新建会话选完目录、session 创建前，先让面板能浏览所选目录
  // （/workspace/files 只放行已登记根；session 要等首条消息才创建）。
  //
  // 按**后端**定址而且只可能是 local：草稿期还没有会话可依附，而草稿根登记的是一个
  // **本机目录**——云端草稿不选本地目录（workingDir 恒为空，见 types/PendingSession），
  // 调用方那个 effect 因此对云端草稿根本不会触发。
  registerDraftRoot: (path: string) =>
    httpForBackend('local').post<{ path: string }>('/workspace/draft-root', { path }),
  clearDraftRoot: () =>
    httpForBackend('local').delete<{ cleared: boolean }>('/workspace/draft-root'),
}
