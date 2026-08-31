import { http } from './client'
import type { AgentTemplate, AgentTemplateDetail, RegisterTemplateRequest } from '@/types'

export const templatesApi = {
  list: () => http.get<AgentTemplate[]>('/agent-templates'),
  get: (id: string) => http.get<AgentTemplateDetail>(`/agent-templates/${id}`),
  register: (data: RegisterTemplateRequest) =>
    http.post<AgentTemplate>('/agent-templates/register', data),
  delete: (id: string) => http.delete(`/agent-templates/${id}`),
}
