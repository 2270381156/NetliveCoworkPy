import { http } from './client'
import type { LLMAccount, RegisterLLMAccountRequest } from '@/types'

export const llmsApi = {
  list: () => http.get<LLMAccount[]>('/llms'),
  get: (name: string) => http.get<LLMAccount>(`/llms/${name}`),
  register: (data: RegisterLLMAccountRequest) => http.post<LLMAccount>('/llms', data),
  delete: (name: string) => http.delete(`/llms/${name}`),
  addModel: (name: string, model: string, context_limit?: number | null) =>
    http.post<LLMAccount>(`/llms/${name}/models`, { model, context_limit }),
  removeModel: (name: string, model: string) =>
    http.delete<LLMAccount>(`/llms/${name}/models`, { model }),
  setDefaultModel: (name: string, model: string) =>
    http.put<LLMAccount>(`/llms/${name}/default_model`, { model }),
}
