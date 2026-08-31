/**
 * useProjectGroups —— 把 sessions 按 working_dir 聚合成 Project 列表。
 *
 * 桌面端 Smart B：前端聚合，无后端实体。
 * 未来升级到方案 C 时：换成调 /api/v1/projects API 即可，UI 完全不动。
 */

import { useMemo } from 'react'
import type { Session } from '@/types'

export const NO_PROJECT_ID = '_no_project'

import { isCloudSession } from '@/api/backends'

export interface ProjectDefaults {
  llm_account?: string | null
  llm_model?: string | null
}

export interface Project {
  id: string                    // Smart B：= working_dir 或 NO_PROJECT_ID；C 阶段：UUID
  display_name: string          // Smart B：路径尾段；C 阶段：用户可改
  working_dir: string
  sessions: Session[]
  session_count: number
  last_accessed_at: string
  /** 这个工作区在云端（组内会话来自云端实例）。用于在列表里标出来。 */
  is_cloud?: boolean
  // C-prep 字段：Smart B 始终 undefined
  description?: string
  pinned?: boolean
  defaults?: ProjectDefaults
}

/** 会话的「最后活动时间」：优先后端算出的 last_activity_at，回退 updated_at / created_at。 */
export function sessionActivityTime(s: Session): string {
  return s.last_activity_at || s.updated_at || s.created_at || ''
}

function pathParts(wd: string): string[] {
  return wd.split(/[\\/]/).filter(Boolean)
}

/**
 * 生成项目显示名：
 *   - 空 working_dir → '未指定目录'
 *   - basename 在所有项目中唯一 → 直接用 basename
 *   - basename 冲突 → 逐级往上加路径段消歧
 */
function buildDisplayName(wd: string, allWds: Set<string>): string {
  if (!wd) return '未指定目录'
  const myParts = pathParts(wd)
  const others = Array.from(allWds)
    .filter(w => w && w !== wd)
    .map(pathParts)
  for (let depth = 1; depth <= myParts.length; depth++) {
    const tail = myParts.slice(-depth).join('/')
    const conflict = others.some(p => p.slice(-depth).join('/') === tail)
    if (!conflict) return tail
  }
  return wd
}

/**
 * 纯函数版：把一批 sessions 聚成 Project[]。
 *
 * 从 hook 里剥出来是因为 agent 分组要在**每个 agent 的会话子集**上再跑一遍（见
 * useAgentGroups）。共用这一份实现，别写第二套「怎么算项目」——两套规则迟早漂移。
 */
export function buildProjects(sessions: Session[]): Project[] {
  {
    const groups = new Map<string, Session[]>()
    for (const s of sessions) {
      const id = s.workspace || NO_PROJECT_ID
      const list = groups.get(id) ?? []
      list.push(s)
      groups.set(id, list)
    }
    const allWds = new Set(
      Array.from(groups.keys()).filter(k => k !== NO_PROJECT_ID)
    )
    const projects: Project[] = []
    for (const [id, sess] of groups) {
      const wd = id === NO_PROJECT_ID ? '' : id
      // 组内按"最后活动时间"倒序；时间相同再按 id 兜底，保证重启前后顺序稳定、不抖动。
      const sorted = [...sess].sort((a, b) =>
        sessionActivityTime(b).localeCompare(sessionActivityTime(a)) || a.id.localeCompare(b.id))
      projects.push({
        id,
        display_name: buildDisplayName(wd, allWds),
        working_dir: wd,
        sessions: sorted,
        session_count: sorted.length,
        last_accessed_at: sorted[0] ? sessionActivityTime(sorted[0]) : '',
        // 组内任一会话来自云端即算云端工作区。地端与云端的工作区路径不可能相同
        // （一个是用户机器上的目录，一个是容器内 /data/workspace/…），不会混进同一组。
        is_cloud: id !== NO_PROJECT_ID && sorted.some(s => s.location === 'cloud' || isCloudSession(s.id)),
      })
    }
    // 最近访问的项目在前，"未指定目录" 永远在最后；时间相同再按 id 兜底，保证顺序稳定。
    projects.sort((a, b) => {
      if (a.id === NO_PROJECT_ID) return 1
      if (b.id === NO_PROJECT_ID) return -1
      return b.last_accessed_at.localeCompare(a.last_accessed_at) || a.id.localeCompare(b.id)
    })
    return projects
  }
}

export function useProjectGroups(sessions: Session[]): Project[] {
  return useMemo(() => buildProjects(sessions), [sessions])
}

/**
 * 取用户「上一次用过的」模型：全部会话里最近活动的那条的 provider/model。
 *
 * 刻意**不看工作目录**——新建会话时不管选哪个目录（甚至还没选目录），默认都是上次用的
 * 那个，用户不用每次去核对下拉框里到底存的是谁。
 *
 * 早先是按目录套用「该目录最近一次的设置」，目录没历史（新目录、或还没选）时就什么都不
 * 设，下拉框显示列表里的第一个、实际提交的却是空值由后端兜底——显示和真正生效的未必是
 * 同一个模型，这正是要修掉的。
 */
export function pickLastUsedDefaults(sessions: Session[]): ProjectDefaults | null {
  const latest = sessions
    .filter(s => s.llm_account)
    .sort((a, b) => sessionActivityTime(b).localeCompare(sessionActivityTime(a)))[0]
  if (!latest) return null
  return { llm_account: latest.llm_account, llm_model: latest.llm_model }
}
