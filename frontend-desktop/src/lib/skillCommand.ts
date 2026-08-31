// `/skillName 正文` 指令的解析与 skill 名归一。
//
// 关键约定：后端（core）绑定 skill 时按 **provider-qualified 名**（`provider__name`）查找
// ——见 core/loop/steps/prepare.py 的 capability_cache.get_by_qualified_name，以及
// core/assembler/composer.py 的 _is_named_skill（注释里明确写了"不接受裸名兜底"）。
// 而 GET /skills 返回的 name 是裸名，所以发送前必须由前端补上 provider 前缀：
// 本地自建 skill → local_skill__，云端引用 skill → cloud_skill__。
// 前端补而不是后端补：只有下拉列表这一刻（用户看着描述选的那条）才知道同名时选的到底是哪个。
import type { LocalSkill } from '@/api/skills'

export const LOCAL_SKILL_PREFIX = 'local_skill__'
export const CLOUD_SKILL_PREFIX = 'cloud_skill__'

/** 裸名 → provider-qualified 名（发给后端的 skill_name 用这个）。 */
export function qualifySkillName(skill: Pick<LocalSkill, 'name' | 'origin'>): string {
  return (skill.origin === 'cloud' ? CLOUD_SKILL_PREFIX : LOCAL_SKILL_PREFIX) + skill.name
}

/** qualified 名 → 裸名（给人看的地方用：徽标、提示语）。非 qualified 的原样返回。 */
export function stripSkillPrefix(name: string): string {
  for (const p of [CLOUD_SKILL_PREFIX, LOCAL_SKILL_PREFIX]) {
    if (name.startsWith(p)) return name.slice(p.length)
  }
  return name
}

/** 按裸名（大小写不敏感）挑出唯一一条 skill。
 *
 * 同名可能有两条（本地自建 + 云端引用），与下拉去重同一口径：优先有描述的那条；
 * picked 是用户刚从下拉里点中的那条，名字对得上就以它为准——同名时它才是用户的真实意图。 */
export function pickSkillByName(
  skills: readonly LocalSkill[],
  name: string,
  picked?: LocalSkill | null,
): LocalSkill | null {
  const key = name.toLowerCase()
  if (picked && picked.name.toLowerCase() === key) return picked
  let hit: LocalSkill | null = null
  for (const s of skills) {
    if (s.name.toLowerCase() !== key) continue
    if (!hit || (!hit.description && s.description)) hit = s
  }
  return hit
}

export interface ParsedSkillCommand {
  skill: LocalSkill | null      // 命中的那条（徽标/提示语用裸名）
  skillName: string | null      // provider-qualified，直接发给后端
  prompt: string                // 去掉 /skill 前缀的正文
}

/** 解析开头的 `/skillName` 指令。仅当 skillName 精确命中已装 skill（大小写不敏感）**且其后有
 * 正文**时，才当作技能调用；否则原样当普通消息——非法名不拦截、不报错。 */
export function parseSkillCommand(
  raw: string,
  skills: readonly LocalSkill[],
  picked?: LocalSkill | null,
): ParsedSkillCommand {
  const none = { skill: null, skillName: null, prompt: raw }
  const m = /^\/([^\s/]+)(?:\s+([\s\S]+))?$/.exec(raw.trim())
  if (!m) return none
  const hit = pickSkillByName(skills, m[1], picked)
  const rest = (m[2] ?? '').trim()
  if (!hit || !rest) return none
  return { skill: hit, skillName: qualifySkillName(hit), prompt: rest }
}
