import { createHttp, httpFor } from './client'
import { activeBackends, getBackend, rememberSessionBackend, forgetSessionBackend } from './backends'
import type { BackendId } from './backends'
import type { Session, CreateSessionRequest } from '@/types'

// bash 审核模式：semiauto=半自动（安全命令自动放行、高风险弹确认）、manual=逐条人工确认、
// strict-auto=全自动（准入层一律放行、边界交给 Windows Low 完整性写入边界，见后端 low_integrity/）。
// 注：semiauto 旧名为 auto，为消除与 strict-auto 的歧义已改名（后端亦同步）。
export type BashReviewMode = 'semiauto' | 'manual' | 'strict-auto'

export type TextPart  = { type: 'text'; text: string }
export type ImagePart = { type: 'image'; data: string; media_type: string; source_type: 'base64' | 'url' }
export type MessageContent = string | (TextPart | ImagePart)[]

export const sessionsApi = {
  // 会话列表向**所有在线后端**各拉一次并合并：本机那份和云上那份各存各的会话，
  // 合并后用户在同一个列表里看到全部，云端的带 location='cloud'。
  // 单个后端拉失败不拖垮整体（云端实例可能正在冷启动）——那一边这次就当没有。
  list: async (): Promise<Session[]> => {
    const results = await Promise.all(
      activeBackends().map(async (b) => {
        try {
          const rows = await createHttp(b.base).get<Session[]>('/sessions')
          rows.forEach(s => rememberSessionBackend(s.id, b.id))
          return rows.map(s => ({ ...s, location: b.id }))
        } catch {
          return [] as Session[]
        }
      }),
    )
    return results.flat()
  },
  get:       (id: string) => httpFor(id).get<Session>(`/sessions/${id}`),
  /** 建在哪个后端由调用方指定（新建会话对话框里的「运行位置」）；建成即登记归属。 */
  create: async (data: CreateSessionRequest, backend: BackendId = 'local'): Promise<Session> => {
    const s = await createHttp(getBackend(backend).base).post<Session>('/sessions', data)
    rememberSessionBackend(s.id, backend)
    return { ...s, location: backend }
  },
  interrupt: (id: string) => httpFor(id).post<Session>(`/sessions/${id}/interrupt`),
  // 会话的 task 列表（一句 query 会被拆成 1~N 个 task）。task_created/task_updated 是
  // 瞬时事件、不进 history，故重开会话时靠它补齐各 task 的标题与状态（用于按 task 折叠）。
  tasks:     (id: string) => httpFor(id).get<Array<{ id?: string; title?: string; status?: string }>>(`/sessions/${id}/tasks`),
  // INTERRUPTED 会话(多为后端重启打断)经事件重放续跑;不接受新文本。
  // 可选 body：换模型恢复（如 CONTEXT_OVERFLOW 换更大窗口），后端 /resume 的
  // ResumeSessionRequest 自带可选语义，无 body 行为不变。
  resume:    (id: string, body?: { llm_account?: string | null; llm_model?: string | null }) =>
    httpFor(id).post<Session>(`/sessions/${id}/resume`, body),
  delete: async (id: string): Promise<void> => {
    await httpFor(id).delete<void>(`/sessions/${id}`)
    forgetSessionBackend(id)          // 会话没了，归属记录跟着清，别让登记簿无限长
  },
  sendMessage: (
    id: string,
    content: MessageContent,
    llmProvider?: string | null,
    llmModel?: string | null,
    userInfo?: { id: string; username: string; role: string } | null,
    initialTask?: Record<string, unknown> | null,   // 如 { skill_name }，绑定本轮根 task
  ) =>
    httpFor(id).post<Session>(`/sessions/${id}/messages`, {
      content,
      llm_account: llmProvider ?? null,
      llm_model: llmModel ?? null,
      user_info: userInfo ?? null,
      initial_task: initialTask ?? null,
    }),
  // 当前后端没有 /input 端点；HITL 文本应答走 /messages 的 PAUSED_HITL 分支。
  answerInput: (id: string, content: string) =>
    httpFor(id).post<Session>(`/sessions/${id}/messages`, { content }),
  getBashReviewMode: (id: string) =>
    httpFor(id).get<{ mode: BashReviewMode }>(`/sessions/${id}/bash-review-mode`),
  setBashReviewMode: (id: string, mode: BashReviewMode) =>
    httpFor(id).put<{ mode: BashReviewMode; os_low_integrity?: boolean }>(`/sessions/${id}/bash-review-mode`, { mode }),
}
