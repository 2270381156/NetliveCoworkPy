import { http } from './client'
import type { WorkspaceListing } from '@/types'

export const workspaceApi = {
  listFiles: (path = '') =>
    http.get<WorkspaceListing>(`/workspace/files?path=${encodeURIComponent(path)}`),
  readFile: (path: string) =>
    http.get<{ path: string; content: string }>(`/workspace/file?path=${encodeURIComponent(path)}`),
}
