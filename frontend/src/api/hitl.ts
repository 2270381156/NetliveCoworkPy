import { http } from './client'

export interface HitlPendingItem {
  id: string
  kind: 'approval' | 'input'
  status: string
  capability_id: string
  question: string
  task_id: string
  session_id: string
  agent_id: string
  form: 'approval' | 'question' | 'wait' | ''
}

export const hitlApi = {
  pending: (sessionId: string) =>
    http.get<HitlPendingItem[]>(`/hitl/pending?session_id=${encodeURIComponent(sessionId)}`),
  answer: (hitlId: string, answer: string, llmAccount?: string | null, llmModel?: string | null) =>
    http.post<{ id: string; status: string }>(
      `/hitl/${hitlId}/answer`,
      // llm 字段只在显式给出时进 body(缺席=后端不动会话 LLM)
      llmAccount === undefined
        ? { answer }
        : { answer, llm_account: llmAccount, llm_model: llmModel ?? null },
    ),
  approve: (hitlId: string) =>
    http.post<{ id: string; status: string }>(`/hitl/${hitlId}/approve`, {}),
  reject: (hitlId: string, message = '') =>
    http.post<{ id: string; status: string }>(`/hitl/${hitlId}/reject`, { message }),
}
