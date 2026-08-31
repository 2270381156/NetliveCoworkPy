import { http } from './client'

export interface LocalSkill {
  skill_id: string
  name: string
  description: string
  version: string
  triggers: string[]
}

// source 标明这条 skill 来自哪个市场（cowork / mythos）。用户不感知，程序用它
// 决定下载时调哪个数据源的接口。
export type SkillSource = 'cowork' | 'mythos'

export interface RemoteCatalogItem {
  source: SkillSource
  id: string
  name: string
  description: string | null
  updater: string | null
  create_time: string | null
  is_pulled: boolean
}

export interface PullSkillResponse {
  skill_id: string
  name: string
}

export const skillsApi = {
  list:         () => http.get<LocalSkill[]>('/skills'),
  delete:       (skillId: string) => http.delete<void>(`/skills/${skillId}`),
  importLocal:  (file: File) => http.upload<LocalSkill>('/skills/import', file),

  // username 给 mythos 用（其请求头要带当前登录用户名）；cowork 忽略它。
  catalog:      (username: string) =>
    http.get<RemoteCatalogItem[]>(`/skills/pull-server/catalog?username=${encodeURIComponent(username)}`),
  // 安装时把这条 skill 的 source 原样回传，后端据此派发到对应数据源的下载接口。
  pull:         (item: { id: string; name: string; source: SkillSource }, username: string) =>
    http.post<PullSkillResponse>(`/skills/pull-server/catalog/${item.id}/pull`, {
      name: item.name, source: item.source, username,
    }),
  importRemote: (file: File) => http.upload<PullSkillResponse>('/skills/pull-server/import', file),
}
