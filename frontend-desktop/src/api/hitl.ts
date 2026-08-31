import { httpFor } from './client'
import type { AskQuestion } from '@/hooks/useSessionSSE'

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
  arguments: Record<string, unknown>
  questions: AskQuestion[]
  created_at: string
}

// 每个方法都要 sessionId：审批单存在**跑这条会话的那个后端**上。后四个方法本身只需
// hitlId 就能定位，sessionId 纯粹是拿来问路的——所以别图省事把它去掉。
//
// 写死地端时并不会明着坏：地端对不认识的 hitlId 返 404，调用方 catch 住、退回旧的
// answerInput/sendMessage 通道（那条是按会话定址的），于是云端会话的审批**永远走降级
// 路径**——面板不清、reject 的理由被丢掉、answer 的模型选择被丢掉，还每次白搭一个
// 失败往返。坏得不响，最难查。
export const hitlApi = {
  pending: (sessionId: string) =>
    httpFor(sessionId).get<HitlPendingItem[]>(`/hitl/pending?session_id=${encodeURIComponent(sessionId)}`),
  answer: (sessionId: string, hitlId: string, answer: string, llmAccount?: string | null, llmModel?: string | null) =>
    httpFor(sessionId).post<{ id: string; status: string }>(
      `/hitl/${hitlId}/answer`,
      // llm 字段只在显式给出时进 body(缺席=后端不动会话 LLM)
      llmAccount === undefined
        ? { answer }
        : { answer, llm_account: llmAccount, llm_model: llmModel ?? null },
    ),
  approve: (sessionId: string, hitlId: string) =>
    httpFor(sessionId).post<{ id: string; status: string }>(`/hitl/${hitlId}/approve`, {}),
  reject: (sessionId: string, hitlId: string, message = '') =>
    httpFor(sessionId).post<{ id: string; status: string }>(`/hitl/${hitlId}/reject`, { message }),
  // 目前无 UI 调用方:面板期 composer 隐藏;保留给 API/将来 UX
  reply: (sessionId: string, hitlId: string, content: string) =>
    httpFor(sessionId).post<{ id: string; status: string; action: string }>(`/hitl/${hitlId}/reply`, { content }),
}
