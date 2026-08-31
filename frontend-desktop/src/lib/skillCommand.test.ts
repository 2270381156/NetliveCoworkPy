import { describe, it, expect } from 'vitest'
import type { LocalSkill } from '@/api/skills'
import {
  parseSkillCommand, pickSkillByName, qualifySkillName, stripSkillPrefix,
} from './skillCommand'

function skill(p: Partial<LocalSkill> & { name: string }): LocalSkill {
  return {
    skill_id: p.skill_id ?? p.name,
    name: p.name,
    description: p.description ?? '',
    version: '1',
    triggers: [],
    origin: p.origin ?? 'local',
    source: p.source ?? null,
    coworks: p.coworks ?? ['*'],   // 归属：`*` = 通用，与后端缺省一致
  }
}

const LOCAL = skill({ name: 'pdf', description: '本地 pdf' })
const CLOUD = skill({ name: 'pptx', skill_id: 'cowork:9', origin: 'cloud', source: 'cowork' })

describe('qualifySkillName', () => {
  it('本地 skill 补 local_skill__', () => {
    expect(qualifySkillName(LOCAL)).toBe('local_skill__pdf')
  })
  it('云端引用 skill 补 cloud_skill__', () => {
    expect(qualifySkillName(CLOUD)).toBe('cloud_skill__pptx')
  })
})

describe('stripSkillPrefix', () => {
  it('去掉 provider 前缀', () => {
    expect(stripSkillPrefix('local_skill__pdf')).toBe('pdf')
    expect(stripSkillPrefix('cloud_skill__pptx')).toBe('pptx')
  })
  it('裸名原样返回', () => {
    expect(stripSkillPrefix('pdf')).toBe('pdf')
  })
})

describe('pickSkillByName', () => {
  const bare = skill({ name: 'pdf', skill_id: 'cowork:1', origin: 'cloud' })
  it('同名两条时优先有描述的那条', () => {
    expect(pickSkillByName([bare, LOCAL], 'pdf')).toBe(LOCAL)
    expect(pickSkillByName([LOCAL, bare], 'pdf')).toBe(LOCAL)
  })
  it('picked 名字对得上就以它为准（用户下拉里选的那条）', () => {
    expect(pickSkillByName([LOCAL, bare], 'pdf', bare)).toBe(bare)
  })
  it('picked 名字对不上则忽略', () => {
    expect(pickSkillByName([LOCAL], 'pdf', CLOUD)).toBe(LOCAL)
  })
  it('大小写不敏感', () => {
    expect(pickSkillByName([LOCAL], 'PDF')).toBe(LOCAL)
  })
  it('查不到返回 null', () => {
    expect(pickSkillByName([LOCAL], 'nope')).toBeNull()
  })
})

describe('parseSkillCommand', () => {
  const skills = [LOCAL, CLOUD]

  it('命中且有正文 → 返回 qualified 名 + 去前缀正文', () => {
    expect(parseSkillCommand('/pdf 帮我读一下', skills)).toEqual({
      skill: LOCAL, skillName: 'local_skill__pdf', prompt: '帮我读一下',
    })
  })
  it('云端 skill 走 cloud_skill__', () => {
    expect(parseSkillCommand('/pptx 做份汇报', skills).skillName).toBe('cloud_skill__pptx')
  })
  it('只有 /name 没正文 → 当普通消息', () => {
    expect(parseSkillCommand('/pdf', skills)).toEqual({
      skill: null, skillName: null, prompt: '/pdf',
    })
  })
  it('未安装的名字 → 当普通消息，不报错', () => {
    expect(parseSkillCommand('/nope 干活', skills)).toEqual({
      skill: null, skillName: null, prompt: '/nope 干活',
    })
  })
  it('不以 / 开头 → 原样', () => {
    expect(parseSkillCommand('随便说点什么', skills).skillName).toBeNull()
  })
  it('路径样的输入（含 /）不当指令', () => {
    expect(parseSkillCommand('/a/b 看看', skills).skillName).toBeNull()
  })
  it('picked 决定同名时用哪条的前缀', () => {
    const dupe = skill({ name: 'pdf', skill_id: 'cowork:1', origin: 'cloud', description: '云端 pdf' })
    expect(parseSkillCommand('/pdf 读一下', [LOCAL, dupe], dupe).skillName).toBe('cloud_skill__pdf')
  })
  it('多行正文保留换行', () => {
    expect(parseSkillCommand('/pdf 第一行\n第二行', skills).prompt).toBe('第一行\n第二行')
  })
})
