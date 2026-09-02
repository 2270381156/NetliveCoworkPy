import { http, httpForBackend } from './client'
import { scheduleSkillSync } from '@/lib/skillSyncTrigger'
import type { BackendId } from './backends'

// source 标明这条 skill 来自哪个市场（cowork / mythos）。
export type SkillSource = 'cowork' | 'mythos'

/** 归属通配：这条 skill 所有 cowork 都能用（通用市场引来的、导入时选"通用"的）。 */
export const ALL_COWORKS = '*'

/** 归属：哪些 cowork 能用这条 skill。`['*']` = 全部。 */
export type SkillCoworks = string[]

export const isCommonSkill = (coworks?: SkillCoworks | null) =>
  !coworks?.length || coworks.includes(ALL_COWORKS)

export interface LocalSkill {
  skill_id: string
  name: string
  description: string
  version: string
  triggers: string[]
  // origin=local：本地自建（永久存）；origin=cloud：市场引用（用时从云端下载、用完删）。
  origin: 'local' | 'cloud'
  source?: SkillSource | null   // 仅 cloud：来源市场，前端徽章用
  // 归属：哪些 cowork 能用它。`['*']` = 通用。决定卡片上的归属标签，以及"上传"传到哪个市场。
  coworks: SkillCoworks
}

/** 技能市场的一个页签。cowork=null 是通用市场（不属于任何 cowork，恒在且排第一）。 */
export interface SkillMarketTab {
  cowork: string | null
  display_name: string
}

export interface RemoteCatalogItem {
  source: SkillSource
  id: string
  /** 这条目录项在**当前页签作用域**下的确定性引用 ID（后端算好的不透明字符串）。
   * 同一 source/id 在通用与专属市场是两条不同的引用（背后是不同服务器）——
   * 已引用状态的配对必须用它，前端不得自己拼 `source:id` 猜身份。 */
  reference_id: string
  name: string
  description: string | null
  /** 作者。netcowork 回 creatorName、自建那套回 updater，后端归一到这一个字段。 */
  updater: string | null
  create_time: string | null
  is_pulled: boolean
  /** 下载量。**null 与 0 是两回事**：null = 这个市场没这项数据（不显示），0 = 确实没人下过。 */
  download_count?: number | null
}

/** 市场条目的引用身份：后端按页签作用域算好的确定性 reference_id。
 * 目录卡片与已引用列表的配对一律经它；`source:id` 只可用于纯 UI 用途（请求去重键）。 */
export const catalogReferenceId = (item: RemoteCatalogItem): string => item.reference_id

export interface PullSkillResponse {
  skill_id: string
  name: string
}

/** 凡是改变了「地端有哪些 skill」的写操作，成功后都静默同步到云端实例。
 *
 *  包在这里而不是各页面的 onSuccess 里：入口不止一处（导入/删除/从市场引用），以后
 *  还会加，逐个记得调是迟早要漏的。对用户完全不可见，见 lib/skillSyncTrigger。 */
async function andSync<T>(p: Promise<T>): Promise<T> {
  const r = await p
  scheduleSkillSync()
  return r
}

/** 归属数组 → 表单字段（逗号分隔）。空/通用一律发 `*`，让后端只有一种"通用"的写法。 */
const coworksField = (coworks?: SkillCoworks | null) =>
  isCommonSkill(coworks) ? ALL_COWORKS : (coworks as string[]).join(',')

export const skillsApi = {
  list:         () => http.get<LocalSkill[]>('/skills'),
  // 云端引用的 skill_id 是不透明 reference_id（含冒号，需编码）。
  delete:       (skillId: string) => andSync(http.delete<void>(`/skills/${encodeURIComponent(skillId)}`)),
  // 导入时定归属：用户此刻正拿着这个 skill，最清楚它是通用的还是某个专业领域的。
  importLocal:  (file: File, coworks?: SkillCoworks) =>
    andSync(http.upload<LocalSkill>('/skills/import', file, undefined, { coworks: coworksField(coworks) })),

  // 改归属（导入后反悔、或从卡片上直接改）。同步会把它带到云端，两边可见范围保持一致。
  setCoworks:   (skillId: string, coworks: SkillCoworks) =>
    andSync(http.post<void>(`/skills/${encodeURIComponent(skillId)}/coworks`, { coworks })),

  // 登录/切换账号后把当前用户名注入后端（运行时 mythos 按用户过滤列表 + 下载带正确身份）。
  setCurrentUser: (username: string) =>
    http.post<void>('/skills/current-user', { username }),

  // 市场页要开几个页签：通用 + 每个「有独立市场的已开通 cowork」一个。
  markets:      () => http.get<SkillMarketTab[]>('/skills/pull-server/markets'),

  // username 给 mythos 用（其请求头要带当前登录用户名）；cowork 忽略它。
  // cowork 为空 = 通用页签（通用市场 + 个人 mythos skill）；给了就只看那个 cowork 的市场。
  catalog:      (username: string, cowork?: string | null) =>
    http.get<RemoteCatalogItem[]>(
      `/skills/pull-server/catalog?username=${encodeURIComponent(username)}`
      + (cowork ? `&cowork=${encodeURIComponent(cowork)}` : '')),
  // 安装时把 source 原样回传（后端据此派发下载），并带上**从哪个页签引的**——那决定归属。
  pull:         (item: { id: string; name: string; source: SkillSource }, username: string, cowork?: string | null) =>
    andSync(http.post<PullSkillResponse>(`/skills/pull-server/catalog/${item.id}/pull`, {
      name: item.name, source: item.source, username, cowork: cowork || '',
    })),
  // 把某个本地 skill 发布到市场（本地 skill 卡片上的"上传"按钮）。
  // **传到哪个市场由它的归属决定**（后端查归属表），否则用户在归属上花的心思在上传这一步
  // 就丢了——skill 进了通用市场，对所有人都成了通用的。
  // 带上当前用户 token → 市场写 creator；未登录/无 token 则匿名。
  publish: async (skillId: string) => {
    const token = await window.electronAPI?.getToken?.()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    return http.post<PullSkillResponse>(`/skills/${encodeURIComponent(skillId)}/publish`, undefined, headers)
  },
}
// ── 同步用（按**后端**定址）──────────────────────────────────────────────────
// skill 是跟着人走的，不是随镜像固定的：用户在地端导入/引用了什么，云端实例也该有。
// 这几个方法显式指明操作哪个后端，供 lib/skillSync 使用。
export const skillsSyncApi = {
  list: (backend: BackendId) => httpForBackend(backend).get<LocalSkill[]>('/skills'),

  /** 导出一个本地 skill 的 zip（仅 origin=local；引用式的本地没有内容）。 */
  // 走 createHttp 而不是裸 fetch：裸 fetch 绕开唯一的请求出口，加鉴权头时正好会漏掉
  // 这一处，而漏掉的表现是"同步 skill 到云端静默失败"。
  exportZip: (backend: BackendId, skillId: string): Promise<Blob> =>
    httpForBackend(backend).blob(`/skills/${encodeURIComponent(skillId)}/export`),

  importZip: (backend: BackendId, zip: Blob, filename: string, coworks?: SkillCoworks) =>
    httpForBackend(backend).upload<LocalSkill>(
      '/skills/import', new File([zip], filename), undefined, { coworks: coworksField(coworks) }),

  /** 只改归属，不重传内容（云端已有这个 skill，只是归属变了）。 */
  setCoworks: (backend: BackendId, skillId: string, coworks: SkillCoworks) =>
    httpForBackend(backend).post<void>(`/skills/${encodeURIComponent(skillId)}/coworks`, { coworks }),

  remove: (backend: BackendId, skillId: string) =>
    httpForBackend(backend).delete<void>(`/skills/${encodeURIComponent(skillId)}`),

  upsertReference: (backend: BackendId, ref: {
    source: SkillSource; remote_id: string; name: string
    description?: string | null; triggers?: string[]; skill_version?: string | null
    // 归属必须一起过去：地端分了归属、云端全是通用的话，同一个 skill 两边可见范围不同。
    coworks?: SkillCoworks
  }) => httpForBackend(backend).post<void>('/skills/references', ref),
}

