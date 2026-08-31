/**
 * NetLIVE Cowork 地端 —— 验收标准里**用户能看见的那些**（需求文档 §7）。
 *
 * 对着**真实后端**跑，不 mock。每条测试对应验收表里的一行，测试名带上编号，
 * 失败时能直接回到需求那一条。
 *
 * ## 这里覆盖哪几条
 *
 *   AC-1   只授权两个 → 界面恰好两个、数据目录恰好两个
 *   AC-2   直接调接口用没授权的 cowork 建会话 → 明确的不可用，不是 500
 *   AC-6   收回后对账 → 套件文件消失；历史会话仍可打开、可读
 *   AC-7   继续被收回的会话 → 明确的"权限已收回"，不是 404 / 500
 *   AC-8   套件放回去 → 同一条会话直接能继续，**无需任何数据迁移**
 *   AC-9   部分收回后 → 那些会话仍有入口（归档区），不是消失
 *   AC-11  拿不到授权凭据 → 不装不删
 *   AC-20  一个都没授权 → 说"尚未开通"，且不能新建会话
 *
 * ## 这里**不**覆盖的，以及为什么
 *
 *   AC-3   模型实际拿到的 MCP 工具集 —— 没有接口能吐出"某条会话的工具集"，
 *          那是模型侧的东西。见 tests/test_cowork_guard_mcp.py（retrieve 那几条）。
 *   AC-4   按名字调别的 cowork 的 skill 文件 —— 同上，是模型工具不是 HTTP 接口。
 *          见 tests/test_cowork_guard_local_skill.py 的 test_by_name_access_is_denied。
 *   AC-5   断云端重启 / AC-10 版本回滚 —— 要重启后端或重新打包。
 *          回滚见 tests/test_cowork_reconcile.py 的 test_a_rollback_to_a_smaller_version_is_installed。
 *   AC-12~14  登录态（未登录 / 换账号 / 令牌过期）—— dev 入口恒跳过鉴权，这里测不出真的。
 *   AC-15~17  验签 —— 见 tests/test_cowork_signature.py；AC-17（发布构建无绕过开关）
 *          是构建期检查，不是运行期行为。
 *   AC-21~30  存量导入 —— 要有一份真的旧版安装。见 tests/test_migration_legacy_import.py。
 *   AC-31~35  日志与打点 —— 不经界面。
 *
 * ## 跑法
 *
 *   后端要开着、套件已装（ipmaster + coremaster）：
 *   npx playwright test -c capture.config.ts capture/cowork-acceptance.spec.ts
 *
 * ⚠ 用例会**改动开发环境里已装的套件**，每条自己 finally 复原，afterAll 再兜一次底。
 */
import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { prep } from './_setup'
import {
  COWORKS_DIR, createSession, dropSessions, installedOnDisk, listCoworks,
  packagesAvailable, recheck, restore, setEntitled, snapshot, type Snapshot,
} from './_cowork'

test.describe.configure({ mode: 'serial' })   // 共用一份磁盘状态，不能并行

let snap: Snapshot

/** 本轮造出来的会话，跑完一律收走（见 _cowork.createSession 的注释）。 */
const bin: string[] = []

test.beforeAll(() => {
  snap = snapshot()
  expect(snap.installed.length, '开发环境里一个套件都没装，这组用例无从谈起').toBeGreaterThan(0)
  expect(packagesAvailable().length, '暂存目录里没有包，收回之后装不回来').toBeGreaterThan(0)
})

test.afterAll(async ({ request }) => {
  await dropSessions(request, bin)
  await restore(request, snap)
})

// ── AC-1 ─────────────────────────────────────────────────────────────────────

test('AC-1 只授权两个 → 界面恰好两个、数据目录里也恰好两个', async ({ page, request }) => {
  const api = await listCoworks(request)
  expect(api.sort(), '接口给的阵容与磁盘上装的对不上').toEqual(installedOnDisk())

  await prep(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)          // 阵容异步到达

  // 看**渲染出来的**，不是接口返回值：阵容在模块顶层捕获的话永远是空的，
  // 而那不报错，只表现为"界面一个 cowork 都没有"。
  const trigger = page.locator('button[title*="switch"], button[title*="切换"]').first()
  await trigger.click()
  const options = trigger.locator('xpath=../div').locator('button')
  await expect(options, '切换器里的条数与已装数量对不上').toHaveCount(api.length)
})

// ── AC-2 ─────────────────────────────────────────────────────────────────────

test('AC-2 直接调接口用没授权的 cowork 建会话 → 明确的不可用，不是 500', async ({ request }) => {
  // 权限是**执行边界**不只是展示：绕过界面直接调接口也拿不到（需求 G3）。
  const r = await createSession(request, bin, { template_id: 'agent:sitemaster' })
  expect(r.status, '500 看起来像"系统坏了"，用户会去重试、报故障，而不是去申请权限')
    .not.toBe(500)
  expect(r.status).toBe(404)
})

// ── AC-6 / AC-7 / AC-8 / AC-9：收回 → 继续 → 放回 ────────────────────────────

test('AC-6/7/8 收回 → 套件消失、会话可读不可继续；放回 → 同一条会话直接能继续', async ({ request }) => {
  const victim = 'coremaster'
  const survivor = snap.installed.find(id => id !== victim)
  expect(survivor, '需要至少两个套件才能验"部分收回"').toBeTruthy()

  // 先建一条属于 victim 的会话
  const created = await createSession(request, bin, { template_id: `agent:${victim}` })
  expect(created.status, '建会话失败，后面的收回场景无从验起').toBe(200)
  const sid = created.id!

  try {
    // ── AC-6 收回 ────────────────────────────────────────────────────────────
    setEntitled([survivor!])
    const res = await recheck(request)
    expect(res.removed, '收回没生效').toContain(victim)
    expect(existsSync(join(COWORKS_DIR, victim)), '套件文件应当消失').toBe(false)

    // 会话仍**可打开、可读** —— 收回的是继续它的权限，不是这条记录
    const read = await request.get(`/api/v1/sessions/${sid}`)
    expect(read.status(), '被收回的 cowork 的历史会话应当仍可读').toBe(200)

    // ── AC-7 继续它 ──────────────────────────────────────────────────────────
    const resume = await request.post(`/api/v1/sessions/${sid}/resume`, { data: {} })
    expect(resume.status(), '404 会让人以为记录没了；500 会让人去报故障').toBe(403)

    // ── AC-8 放回去 ──────────────────────────────────────────────────────────
    // **不做任何数据迁移**：判据是推导式的（套件装着吗），装回来自己就活了。
    setEntitled(snap.installed)
    const back = await recheck(request)
    expect(back.installed, '套件没装回来').toHaveProperty(victim)

    const resumeAgain = await request.post(`/api/v1/sessions/${sid}/resume`, { data: {} })
    expect(resumeAgain.status(), '权限恢复后这条会话应当自己就能继续，不该还要迁移什么')
      .not.toBe(403)
  } finally {
    setEntitled(snap.installed)
    await recheck(request)
  }
})

test('AC-9 部分收回后，那些会话仍有入口（在归档区），不是消失', async ({ page, request }) => {
  const victim = 'coremaster'
  const survivor = snap.installed.find(id => id !== victim)!

  expect((await createSession(request, bin, { template_id: `agent:${victim}` })).status).toBe(200)

  try {
    setEntitled([survivor])
    await recheck(request)

    await prep(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // 归档区必须**在**：会话消失会让人以为记录被删了，而它只是暂时不能继续。
    const body = await page.locator('body').innerText()
    expect(body, '被收回 cowork 的会话应当收进「已归档」，不是从列表里消失')
      .toMatch(/已归档|Archived/)
  } finally {
    setEntitled(snap.installed)
    await recheck(request)
  }
})

// ── AC-11 ────────────────────────────────────────────────────────────────────

test('AC-11 拿不到授权凭据 → 一个都不装、一个都不删', async ({ request }) => {
  const before = installedOnDisk()
  try {
    setEntitled(null)                 // 凭据文件都没有 = 这次没核对上
    const res = await recheck(request)
    expect(res.removed, '"没核对上"被当成了"你没权限" —— 一次网络抖动会清空用户的全部 cowork')
      .toEqual([])
    expect(installedOnDisk()).toEqual(before)
  } finally {
    setEntitled(snap.installed)
    await recheck(request)
  }
})

test('AC-11 对照：核对上了但一个都没开通 → 全删（与"没核对上"处置相反）', async ({ request }) => {
  // 这一条是上一条的**对照**。两者在数据上都是"没有"，但一个不能删、一个必须删；
  // 只测其中一条的话，把两者混为一谈的实现照样能过。
  try {
    setEntitled([])
    await recheck(request)
    expect(installedOnDisk(), '拿到空清单就该全删 —— 否则权限收回永远不生效').toEqual([])
  } finally {
    setEntitled(snap.installed)
    await recheck(request)
    expect(installedOnDisk()).toEqual(snap.installed)
  }
})

// ── AC-20 ────────────────────────────────────────────────────────────────────

test('AC-20 一个都没授权 → 说的是"尚未开通"，且不能新建会话', async ({ page, request }) => {
  try {
    setEntitled([])
    await recheck(request)
    expect(await listCoworks(request)).toEqual([])

    await prep(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    const body = await page.locator('body').innerText()
    // 说"尚未开通/联系管理员"，而不是"加载失败/重试" —— 后者会让没权限的人去重试一万次。
    expect(body, '一个都没开通时，文案必须指向"去申请权限"而不是"重试"')
      .toMatch(/尚未开通|未开通|联系管理员|not.*enabled|administrator/i)

    // 不拦的话会建出一条跑母版模板的会话：它不属于任何 cowork，界面上无名无姓，
    // 用户却以为自己在正常使用产品。
    const newBtn = page.getByRole('button', { name: /新建会话|New session/i }).first()
    if (await newBtn.count()) {
      await expect(newBtn, '一个 cowork 都没有时不该还能新建会话').toBeDisabled()
    }
  } finally {
    setEntitled(snap.installed)
    await recheck(request)
  }
})
