import { http } from './client'
import type { LLMProvider, RegisterLLMRequest } from '@/types'

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
  list:          () => http.get<LLMProvider[]>('/llms'),
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
