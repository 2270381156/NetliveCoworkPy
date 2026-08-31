/**
 * agent 注册表 —— 「有哪些 agent」「这条会话属于谁」的唯一真值来源。
 *
 * 产品外壳叫 NetLIVE Cowork，但用户对话的对象永远是某一个 agent（IPMaster / CoreMaster
 * / …）。外壳本身不参与对话，所以它不在这个列表里，也永远不该被当成一个 agent 渲染。
 *
 * 阵容**运行期从后端拉**（`GET /api/v1/coworks`），不再由 branding.json 构建期内联。
 * 原因：能用哪几个 cowork 是按**这个用户的权限**下发的，装了几个就是几个；内联那份是打包
 * 时固定的全量阵容，装几个都显示七个。
 *
 * 阵容是**异步到达**的。不要在模块顶层捕获它（`const X = AGENTS.map(...)` 那种写法会永远
 * 拿到空数组），一律用 `getAgents()` 现取；要跟着变化重渲染就订阅 `subscribeAgents`。
 *
 * 与后端的契约：agent id 必须与 resources/agents/<id>/ 目录同名，会话的 template_id 是
 * `agent:<id>`。这层负责两个方向的翻译，别在组件里手工拼字符串。
 */

import branding from '@branding'   // 只用来读 legacyAgentId：历史会话认领给谁

export interface Agent {
  /** 与后端 resources/agents/<id>/ 目录同名。 */
  id: string
  /** 界面上显示的全名，如 "IPMaster Cowork"。 */
  displayName: string
  /** 一句话领域说明，卡片副标题用。 */
  subtitle: string
  /** 色标（卡片、会话列表分组）。 */
  accent: string
  /** 套件自带 logo 的地址。**没有就没有** —— 界面回落到首字母标记。 */
  logoUrl?: string
}

/** 后端 /api/v1/coworks 的一条。 */
export interface CoworkDTO {
  id: string
  display_name: string
  subtitle: string
  accent: string
  order: number
  /** 取套件自带 logo 的地址；**没有 logo 时后端给 null**。 */
  logo_url?: string | null
}

const TEMPLATE_PREFIX = 'agent:'
/** branding 里没配 accent 时的兜底色，取中性灰蓝而不是报错——少个颜色不该让界面开天窗。 */
const FALLBACK_ACCENT = '#64748b'

/**
 * 当前阵容。**运行期填充**（见 hydrateAgents），未拉到之前是空的。
 *
 * 用 `let` + 取值函数而不是导出常量：导出常量会被调用方在模块顶层捕获，那一份永远停在
 * 初始的空数组上——这种错不报任何东西，只表现为"界面上一个 cowork 都没有"。
 */
let agents: readonly Agent[] = []

type Listener = () => void
const listeners = new Set<Listener>()

/** 订阅阵容变化（组件用 useSyncExternalStore 接它）。 */
export function subscribeAgents(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 现取阵容。**不要把返回值存进模块级常量**——见上。 */
export function getAgents(): readonly Agent[] {
  return agents
}

/** 主 agent = 阵容第一个；还没拉到时为 null。用函数而非常量，理由同 getAgents。 */
export function defaultAgent(): Agent | null {
  return agents[0] ?? null
}

/**
 * 用后端返回的清单填充阵容。启动引导调用一次（见 main.tsx）。
 *
 * 去重按 id：同 id 出现两次意味着两张卡片指向同一个模板，点哪张都一样，是配置错误。
 * 顺序沿用后端给的（它按套件 order 排），前端不再自己排——两处排序迟早会不一致。
 */
export function hydrateAgents(rows: readonly CoworkDTO[] | null | undefined): void {
  const seen = new Set<string>()
  const out: Agent[] = []
  for (const r of rows ?? []) {
    const id = (r?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      displayName: (r.display_name || '').trim() || id,   // 名字缺失退回 id，好过显示空白
      subtitle: (r.subtitle || '').trim(),
      accent: (r.accent || '').trim() || FALLBACK_ACCENT,
      logoUrl: (r.logo_url || '').trim() || undefined,
    })
  }
  agents = out
  for (const fn of listeners) fn()
}

export function agentById(id: string | null | undefined): Agent | null {
  if (!id) return null
  return agents.find(a => a.id === id) ?? null
}

/** agent id → 建会话时传给后端的 template_id。 */
export function templateIdOf(agentId: string): string {
  return `${TEMPLATE_PREFIX}${agentId}`
}

/**
 * template_id → agent id。只认 `agent:` 前缀，其余（null、空串、别的前缀）一律 null。
 *
 * 注意 `agent:default` 会返回 'default'，而 'default' 通常不在阵容里——历史会话就是这样。
 * 所以调用方要区分「解析不出 id」和「解析出了但阵容里没有」，别把两者都当成未知：见
 * agentOfSession 的处理。
 */
export function agentIdFromTemplate(templateId: string | null | undefined): string | null {
  if (typeof templateId !== 'string') return null
  if (!templateId.startsWith(TEMPLATE_PREFIX)) return null
  const id = templateId.slice(TEMPLATE_PREFIX.length).trim()
  return id || null
}

/**
 * agent 上线前的历史会话 → 归到哪个 agent。
 *
 * 这些会话的 template_id 是 `default` / `agent:default`（本机实测 56 + 18 条），当时产品只有
 * 一个 agent，就是 IPMaster。全局切换模式下「不属于任何 agent」等于永远不显示——历史会话会
 * 凭空消失，所以必须显式认领。
 *
 * 认领对象取阵容第一个（defaultAgent()）而不是硬编码 'ipmaster'：衍生品牌的第一个 agent
 * 就是它自己的主 agent，历史会话本来也只会属于它。
 */
const LEGACY_TEMPLATE_IDS = new Set(['default', 'agent:default'])

/**
 * 这条会话属于哪个 agent。
 *
 * 顺序：先认历史会话（见上），再按 `agent:<id>` 解析。两者都认不出返回 null（阵容里已被
 * 删掉的 agent 会走到这里），调用方决定是隐藏还是单独成组。
 */
export function agentOfSession(session: { template_id?: string | null }): Agent | null {
  const raw = typeof session.template_id === 'string' ? session.template_id.trim() : ''
  if (LEGACY_TEMPLATE_IDS.has(raw) || !raw) return legacyClaimAgent()
  return agentById(agentIdFromTemplate(raw))
}

/**
 * 历史会话认领给谁。
 *
 * 先按 branding.legacyAgentId 找（当时产品只有一个 agent，就是它），找不到才退回阵容第一个。
 *
 * **不能只靠「阵容第一个」**：谁排第一由云端下发的 order 决定，管理员调一次顺序，
 * 一批历史会话就会跑到别的 agent 名下；而阵容还没加载好时第一个是 null，
 * 那些会话会变成没有归属、直接平铺在列表里——用户看到的是"没有任何权限，但会话都在"。
 */
function legacyClaimAgent(): Agent | null {
  const id = String((branding as { legacyAgentId?: string }).legacyAgentId || '').trim()
  return (id ? agentById(id) : null) ?? defaultAgent()
}
