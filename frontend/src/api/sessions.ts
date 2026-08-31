import { http } from './client'
import type { Session, CreateSessionRequest, InitialTaskConfig, Task } from '@/types'

export type TextPart = { type: 'text'; text: string }
export type ImagePart = { type: 'image'; data: string; media_type: string; source_type: 'base64' | 'url' }
export type ContentPart = TextPart | ImagePart
export type MessageContent = string | ContentPart[]

export const sessionsApi = {
  list: () => http.get<Session[]>('/sessions'),
  get: (id: string) => http.get<Session>(`/sessions/${id}`),
  create: (data: CreateSessionRequest) => http.post<Session>('/sessions', data),
  interrupt: (id: string) =>
    http.post<{ session: Session; signaled: boolean }>(`/sessions/${id}/interrupt`),
  resume: (id: string, body?: { llm_account?: string | null; llm_model?: string | null }) =>
    http.post<Session>(`/sessions/${id}/resume`, body),
  getTasks: (id: string) => http.get<Task[]>(`/sessions/${id}/tasks`),
  sendMessage: (
    id: string,
    content: MessageContent,
    initialTask?: InitialTaskConfig | null,
    llmAccount?: string | null,
    llmModel?: string | null,
  ) =>
    http.post<Session>(`/sessions/${id}/messages`, {
      content,
      initial_task: initialTask ?? null,
      llm_provider: llmAccount ?? null,
      llm_model: llmModel ?? null,
    }),
  delete: (id: string) => http.delete<void>(`/sessions/${id}`),
  /** 按 sse_events 下标取单条原始事件——prompt 卡片是存根，展开时用它回取全文。 */
  getEvent: (id: string, index: number) =>
    http.get<Record<string, unknown>>(`/sessions/${id}/events/${index}`),
  import: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return http.upload<Session>('/sessions/import', fd)
  },
}
