import { http } from './client'
import type { RemoteSkillSource, RegisterGitSkillSourceRequest } from '@/types'

export const skillSourceApi = {
  list: () => http.get<RemoteSkillSource[]>('/skill-sources'),
  get: (name: string) => http.get<RemoteSkillSource>(`/skill-sources/${name}`),
  registerGit: (data: RegisterGitSkillSourceRequest) =>
    http.post<RemoteSkillSource>('/skill-sources/git', data),
  delete: (name: string) => http.delete(`/skill-sources/${name}`),
}
