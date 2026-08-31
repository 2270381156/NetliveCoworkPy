/**
 * NetLIVE Cowork 地端 —— 归属与市场那几条验收（需求文档 §7、§H、§G）。
 *
 * ## 覆盖
 *
 *   AC-18   从某 cowork 页签引用 skill → 归属自动是那个 cowork，不弹框追问
 *   AC-19   本地导入不做选择 → 归属为通用，且界面上看得到「通用」标签
 *   H/G8    每个 cowork 只列它自己那家市场；LLM 账号按 llm.allow 分
 *   G3      归属是**执行边界**不只是展示：绕过界面直接调接口也拿不到
 *
 * ## 前提
 *
 * 两个套件各指一家**不同地址**的 mock 市场（dev/mock/mock_mythos_server.py，
 * 端口 9099 / 9098），且 llm.allow 互不重叠。共用一个地址的话两边都能拉到目录、
 * 看起来一模一样，这组用例就分不出对错了。
 *
 * ## 跑法
 *
 *   npx playwright test -c capture.config.ts capture/cowork-ownership.spec.ts
 */
import { expect, test, type APIRequestContext } from '@playwright/test'

import { prep } from './_setup'
import { createSession, dropSessions, listCoworks } from './_cowork'

test.describe.configure({ mode: 'serial' })

/** 本轮造出来的会话，跑完一律收走 —— 开发环境的数据目录就是用户平时在用的那个。 */
const bin: string[] = []
test.afterAll(async ({ request }) => { await dropSessions(request, bin) })

type MarketTab = { cowork: string | null; display_name: string }
type CatalogItem = { id: string; name: string; source: string }
type LocalSkill = { skill_id: string; name: string; origin: string; coworks: string[] }

async function skills(request: APIRequestContext): Promise<LocalSkill[]> {
  const r = await request.get('/api/v1/skills')
  expect(r.status()).toBe(200)
  return (await r.json()) as LocalSkill[]
}

// ── 市场页签 ─────────────────────────────────────────────────────────────────

test('市场页签 = 通用 + 每个有独立市场的 cowork，通用恒在且恒第一', async ({ request }) => {
  const r = await request.get('/api/v1/skills/pull-server/markets')
  expect(r.status()).toBe(200)
  const tabs = (await r.json()) as MarketTab[]

  // 通用恒在：按配置有无来决定它在不在，会让同一个界面在不同部署下少一个页签，
  // 而用户无从知道少的是哪个。
  expect(tabs[0]?.cowork, '通用页签必须恒在且排第一').toBeNull()

  const installed = await listCoworks(request)
  for (const tab of tabs.slice(1)) {
    expect(installed, `页签里出现了没装的 cowork：${tab.cowork}`).toContain(tab.cowork)
  }
})

test('各 cowork 的目录来自**它自己那家**市场，不是共用一个全局地址', async ({ request }) => {
  const installed = await listCoworks(request)
  expect(installed.length, '需要至少两个 cowork').toBeGreaterThan(1)

  const counts: Record<string, number> = {}
  for (const id of installed) {
    const r = await request.get(`/api/v1/skills/pull-server/catalog?username=a001&cowork=${id}`)
    expect(r.status(), `${id} 的市场目录接口挂了`).toBe(200)
    counts[id] = ((await r.json()) as CatalogItem[]).length
  }
  // 每家都拉得到东西 —— 拉不到时下面的"归属跟着页签走"就无从验起。
  // （"确实按套件里的地址去问"这件事，判据是关掉其中一家只有它空，
  //   那要停进程，不适合放在这里跑；见提交 f220863 的实测记录。）
  for (const id of installed) {
    expect(counts[id], `${id} 的市场一条都没有 —— mock 没起来？`).toBeGreaterThan(0)
  }
})

// ── AC-18 ────────────────────────────────────────────────────────────────────

test('AC-18 从某 cowork 页签引用 skill → 归属自动是那个 cowork，不弹框追问', async ({ request }) => {
  const installed = await listCoworks(request)
  const cowork = installed[0]

  const cat = await request.get(`/api/v1/skills/pull-server/catalog?username=a001&cowork=${cowork}`)
  const items = (await cat.json()) as CatalogItem[]
  const pick = items.find(i => !i.name.includes('空内容')) ?? items[0]
  expect(pick, '市场目录是空的，这条验不了').toBeTruthy()

  // **按 skill_id 配对，不按名字**：引用记录里存的是包内 SKILL.md 的 name，
  // 与市场目录的显示名常常不是一回事，按名字找会永远找不到（第一版就栽在这儿）。
  const key = `${pick.source}:${pick.id}`
  const already = (await skills(request)).some(s => s.skill_id === key)

  const pull = await request.post(`/api/v1/skills/pull-server/catalog/${pick.id}/pull`, {
    data: { name: pick.name, source: pick.source, username: 'a001', cowork },
  })
  expect(pull.status(), '引用失败').toBe(200)
  expect((await pull.json()).skill_id, '引用记录的 key 形状变了').toBe(key)

  try {
    const ref = (await skills(request)).find(s => s.skill_id === key)
    expect(ref, '引用完在列表里找不到 —— mythos 按登录用户过滤，用户名没对上也会这样').toBeTruthy()
    // 用户点的那个页签已经表达了意图，不该再弹一个"给谁用"的框让人说第二遍。
    expect(ref!.coworks, '从 cowork 页签引来的，归属就该是那个 cowork').toEqual([cowork])
  } finally {
    if (!already) await request.delete(`/api/v1/skills/${encodeURIComponent(key)}`)
  }
})

test('对照：从通用页签引用 → 归属是通用（`*`）', async ({ request }) => {
  const cat = await request.get('/api/v1/skills/pull-server/catalog?username=a001')
  const items = (await cat.json()) as CatalogItem[]
  test.skip(items.length === 0, '通用市场没配地址，这条对照跑不了')

  const pick = items.find(i => !i.name.includes('空内容')) ?? items[0]
  const key = `${pick.source}:${pick.id}`
  const already = (await skills(request)).some(s => s.skill_id === key)

  const pull = await request.post(`/api/v1/skills/pull-server/catalog/${pick.id}/pull`, {
    data: { name: pick.name, source: pick.source, username: 'a001', cowork: '' },
  })
  expect(pull.status()).toBe(200)
  try {
    const ref = (await skills(request)).find(s => s.skill_id === key)
    expect(ref, '引用完在列表里找不到').toBeTruthy()
    expect(ref!.coworks, '通用页签引来的就该是通用').toEqual(['*'])
  } finally {
    if (!already) await request.delete(`/api/v1/skills/${encodeURIComponent(key)}`)
  }
})

// ── AC-19 ────────────────────────────────────────────────────────────────────

test('AC-19 本地导入不做选择 → 归属为通用，且界面上看得到「通用」', async ({ page, request }) => {
  const name = 'ac19-probe-skill'
  const zip = await makeSkillZip(name)

  const imported = await request.post('/api/v1/skills/import', {
    multipart: {
      file: { name: `${name}.zip`, mimeType: 'application/zip', buffer: zip },
      // coworks 不传 —— 这条验的就是"不做选择"时的缺省
    },
  })
  expect(imported.status(), '导入失败').toBe(200)

  try {
    const body = await imported.json()
    expect(body.coworks, '不做选择时缺省必须是通用 —— 缺省成"谁都不能用"的话，导入完没人用得上')
      .toEqual(['*'])

    await prep(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await openSkills(page)

    const text = await page.locator('body').innerText()
    expect(text, '刚导入的 skill 没出现在技能中心').toContain(name)
    expect(text, '界面上要看得到「通用」这个标签，否则用户不知道它归谁')
      .toMatch(/通用|General/)
  } finally {
    await request.delete(`/api/v1/skills/${encodeURIComponent(name)}`)
  }
})

// ── G8：LLM 按 llm.allow 分 ──────────────────────────────────────────────────

test('每个 cowork 的模型账号按它的 llm.allow 分；不带 cowork 时不设限', async ({ request }) => {
  const installed = await listCoworks(request)
  const all = await accounts(request, null)
  const per: Record<string, string[]> = {}
  for (const id of installed) per[id] = await accounts(request, id)

  for (const id of installed) {
    expect(per[id].length, `${id} 一个账号都没有 —— 套件里的账号名多半对不上现有账号`)
      .toBeGreaterThan(0)
    for (const n of per[id]) expect(all).toContain(n)
  }
  // 配置页问的是"这台机器上有哪些账号"，与归属无关，所以不带 cowork 时必须是全量。
  expect(all.length, '不带 cowork 时应当是全量').toBeGreaterThanOrEqual(
    Math.max(...installed.map(id => per[id].length)),
  )
})

test('G3 归属是执行边界：绕过界面直接指定别的 cowork 的模型账号 → 403', async ({ request }) => {
  const installed = await listCoworks(request)
  const [a, b] = installed
  test.skip(!b, '需要两个 cowork')

  const mine = await accounts(request, a)
  const theirs = await accounts(request, b)
  const exclusive = theirs.find(n => !mine.includes(n))
  test.skip(!exclusive, '两个 cowork 的账号没有互斥项，这条验不出边界')

  const r = await createSession(request, bin, { template_id: `agent:${a}`, llm_account: exclusive })
  // 只做列表过滤的话这里会 200 —— 边界就只是体验，不是权限。
  expect(r.status, '列表里看不到 ≠ 用不了').toBe(403)
})

// ── 小工具 ───────────────────────────────────────────────────────────────────

async function accounts(request: APIRequestContext, cowork: string | null): Promise<string[]> {
  const r = await request.get(cowork ? `/api/v1/llms?cowork=${cowork}` : '/api/v1/llms')
  expect(r.status()).toBe(200)
  return ((await r.json()) as Array<{ name: string }>).map(a => a.name)
}

/**
 * 打开技能中心。
 *
 * ⚠ 入口随**有没有登录用户**而变：`prep()` 桩了 electronAPI.getSession，侧栏底部那格
 * 就成了用户名（点它展开设置菜单）；没有用户时才是那个写着「设置」的按钮。
 * 只按文字找「设置」会在有用户时超时 —— 而超时看起来像"页面没加载出来"，
 * 和真正的加载失败分不开。
 */
async function openSkills(page: import('@playwright/test').Page) {
  const trigger = page.getByRole('button')
    .filter({ hasText: /Tester|设置|Settings/ }).last()
  await trigger.click()
  await page.waitForTimeout(600)
  await page.getByText(/^技能中心$|^Skills$/).first().click()
  await page.waitForTimeout(2000)
}

/** 造一个最小的合规 skill zip（只有 SKILL.md）。用 zip 的 store 模式，零依赖。 */
async function makeSkillZip(name: string): Promise<Buffer> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file(`${name}/SKILL.md`, [
    '---',
    `name: ${name}`,
    'description: 验收用的探针 skill（AC-19）',
    'version: "1.0"',
    '---',
    '',
    '这个 skill 只用于验证"本地导入不做选择时归属为通用"，不做任何事。',
  ].join('\n'))
  return zip.generateAsync({ type: 'nodebuffer' })
}
