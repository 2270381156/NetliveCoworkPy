import { http, httpFor, httpForBackend } from './client'
import type { BackendId } from './backends'
import type { LLMProvider, RegisterLLMRequest } from '@/types'

// ⚠️ LLM 账号是**按后端各存各的**：地端的账号库在用户电脑上，云端实例有自己的一份。
// 所以列账号必须指明问谁——把云端会话的模型选择器接到地端账号列表上，用户会选到
// 一个云端根本没有的账号，建出来的会话一调模型就失败（而且错误信息毫无线索）。
// 账号的增删改（register/delete/addModel…）暂时仍走地端：云端账号怎么来是个未定的
// 产品问题（见 docs 的待定项），不该在这里悄悄决定。

export interface PingRequest {
  style: string
  api_key: string
  base_url?: string
  model?: string
}

export interface PingResponse {
  ok: boolean
  latency_ms: number
  error?: string  // 失败原因（ok=false 时），供 UI 展示
}

export interface ListModelsRequest {
  style: string
  api_key: string
  base_url?: string
}

export interface AvailableModelsResponse {
  models: string[]
}

export const llmsApi = {
  /** 某会话所属后端上的账号；不传 sessionId = 地端。 */
  list:          (sessionId?: string | null) => httpFor(sessionId).get<LLMProvider[]>('/llms'),
  /** 指定后端上的账号——新建会话时会话还不存在，只能按后端问。 */
  // 带上 cowork：只列它允许的账号（套件 llm.allow）。**按 cowork 而不是按会话**——
  // 模型是在建会话之前选的，那时还没有 session。不传则不过滤。
  listOn: (backend: BackendId, cowork?: string | null) =>
    httpForBackend(backend).get<LLMProvider[]>(
      cowork ? `/llms?cowork=${encodeURIComponent(cowork)}` : '/llms'),
  register:      (data: RegisterLLMRequest) => http.post<LLMProvider>('/llms', data),
  delete:        (name: string) => http.delete(`/llms/${name}`),
  addModel:      (name: string, model: string, context_limit?: number | null) =>
    http.post<LLMProvider>(`/llms/${name}/models`, { model, context_limit }),
  removeModel:   (name: string, model: string) =>
    http.delete<LLMProvider>(`/llms/${name}/models`, { model }),
  setDefault:    (name: string, model: string) =>
    http.put<LLMProvider>(`/llms/${name}/default_model`, { model }),
  ping:                  (data: PingRequest) => http.post<PingResponse>('/llms/ping', data),
  pingRegistered:        (name: string, model: string) => http.post<PingResponse>(`/llms/${encodeURIComponent(name)}/ping?model=${encodeURIComponent(model)}`),
  listAvailableModels:   (data: ListModelsRequest) => http.post<AvailableModelsResponse>('/llms/available-models', data),
  listAvailableModelsOf: (name: string) => http.get<AvailableModelsResponse>(`/llms/${encodeURIComponent(name)}/available-models`),
}
