import { http } from './client'
import type { Session, CreateSessionRequest } from '@/types'

export type TextPart  = { type: 'text'; text: string }
export type ImagePart = { type: 'image'; data: string; media_type: string; source_type: 'base64' | 'url' }
export type MessageContent = string | (TextPart | ImagePart)[]

export const sessionsApi = {
  list:      () => http.get<Session[]>('/sessions'),
  get:       (id: string) => http.get<Session>(`/sessions/${id}`),
  create:    (data: CreateSessionRequest) => http.post<Session>('/sessions', data),
  interrupt: (id: string) => http.post<Session>(`/sessions/${id}/interrupt`),
  // INTERRUPTED 会话(多为后端重启打断)经事件重放续跑;不接受新文本。
  resume:    (id: string) => http.post<Session>(`/sessions/${id}/resume`),
  delete:    (id: string) => http.delete<void>(`/sessions/${id}`),
  sendMessage: (
    id: string,
    content: MessageContent,
    llmProvider?: string | null,
    llmModel?: string | null,
  ) =>
    http.post<Session>(`/sessions/${id}/messages`, {
      content,
      llm_account: llmProvider ?? null,
      llm_model: llmModel ?? null,
    }),
  // 当前后端没有 /input 端点；HITL 文本应答走 /messages 的 PAUSED_HITL 分支。
  answerInput: (id: string, content: string) =>
    http.post<Session>(`/sessions/${id}/messages`, { content }),
  getBashReviewMode: (id: string) =>
    http.get<{ mode: 'auto' | 'manual' }>(`/sessions/${id}/bash-review-mode`),
  setBashReviewMode: (id: string, mode: 'auto' | 'manual') =>
    http.put<{ mode: 'auto' | 'manual' }>(`/sessions/${id}/bash-review-mode`, { mode }),
}
