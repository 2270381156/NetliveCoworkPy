/**
 * 技能市场端到端 —— skills 包重构（provider + adapter 两层）之后的实测。
 *
 * 单元测试证明的是"每一层自己对"；这里证明的是**整条链路接起来还对**：
 *
 *     界面点技能中心 → REST /skills/pull-server/catalog
 *       → SkillMarketService 合并几家
 *         → registry 装出来的 adapter 各自去取（mythos 翻页/鉴权/过滤/缓存）
 *           → 归一成 MarketItem → 打 source/is_pulled → 回到界面
 *
 * 重构里有三处会**静默出错**的地方，正是本文件要盯的：
 *   1. 字段归一漏了一个 → 界面上那一列空着，不报错
 *   2. source 标错 → 点"添加"时下载路由到错误的市场
 *   3. 一家挂了拖垮全部 → 本该只少一家，结果整页空白
 *
 * 跑之前要起两样（见 capture/README.md）：
 *   1. dev/mock/mock_mythos_server.py —— 顶替 mythos（内网服务，本机连不通）
 *   2. 后端，环境变量指向它：
 *      NLC_SKILL_MYTHOS_BASE_URL=http://127.0.0.1:9099
 *      NLC_SKILL_PULL_SERVER_URL=http://127.0.0.1:9098/api  ← 故意没人监听，用来验降级
 */
import { expect, test } from '@playwright/test'

import { prep } from './_setup'

// 端口跟着环境走：写死 15926 的话，后端起在别的端口时整组 ECONNREFUSED，
// 看起来像「后端挂了」，其实只是敲错了门。
const API = `http://127.0.0.1:${process.env.BACKEND_PORT ?? '15926'}/api/v1`
const USER = 'a001'

/**
 * 直接问后端要目录。绕开界面，先确认数据层是对的——界面对不上时好分清是谁的问题。
 *
 * ⚠ **要问哪一家由页签定。** 这组用例最初写于"只有一家全局市场"的年代；现在市场
 * 随 cowork 套件走（H1），全局那家默认没地址、目录恒空。写死问全局的话整组会红，
 * 而红的原因是配置形态变了，不是市场坏了。
 */
async function fetchCatalog(request: any, username = USER, cowork: string | null = null) {
  const q = cowork ? `&cowork=${encodeURIComponent(cowork)}` : ''
  const r = await request.get(`${API}/skills/pull-server/catalog?username=${username}${q}`)
  expect(r.ok(), `catalog 应当 200，实际 ${r.status()}`).toBeTruthy()
  return await r.json()
}

/** 找一家**真有目录**的市场：优先全局，没有就取第一个有内容的 cowork 页签。 */
async function marketWithContent(request: any): Promise<string | null> {
  if ((await fetchCatalog(request)).length > 0) return null
  const r = await request.get(`${API}/skills/pull-server/markets`)
  const tabs = (await r.json()) as Array<{ cowork: string | null }>
  for (const t of tabs) {
    if (t.cowork && (await fetchCatalog(request, USER, t.cowork)).length > 0) return t.cowork
  }
  test.skip(true, '一家有目录的市场都没有 —— mock 没起来？这组用例的前提不成立')
  return null
}

test.describe('技能市场（重构后）', () => {
  test('目录接口：字段齐全、来源标对、id 是字符串', async ({ request }) => {
    const mkt = await marketWithContent(request)
    const items = await fetchCatalog(request, USER, mkt)
    expect(items.length, 'mock 市场里有 3 条 baseline skill').toBeGreaterThan(0)

    for (const it of items) {
      // 归一后的五个字段 + 市场层加的两个。少任何一个都是"界面上那列空着"的静默错。
      expect(Object.keys(it).sort()).toEqual(
        ['create_time', 'description', 'id', 'is_pulled', 'name', 'source', 'updater'].sort(),
      )
      expect(typeof it.id, 'id 统一成字符串（mythos 源里是数字）').toBe('string')
      expect(it.source, 'source 来自 adapter 的名字').toMatch(/^(cowork|mythos)$/)
      expect(typeof it.is_pulled).toBe('boolean')
      expect(it.name, '名字不能空——空了用户在市场里看到一行白').toBeTruthy()
    }
  })

  test('baseline 过滤生效：mock 给 4 条，只有带 tag 的 3 条进来', async ({ request }) => {
    // 过滤规则在 adapters/mythos.py 里。它挪进 adapter 之后，市场层不再知道有这回事，
    // 所以要在端到端这层确认它还在生效。
    const items = await fetchCatalog(request, USER, await marketWithContent(request))
    const names = items.map((i: any) => i.name)
    expect(names).not.toContain('天气查询')      // mock 里 tag_names=['test']，该被滤掉
    expect(items.length).toBe(3)
  })

  test('一家连不上时只少那一家，不拖垮整页', async ({ request }) => {
    // 这个页签下配了 mythos、没配（或配了个连不上的）cowork 源。
    // 重构前这条规则写死成"仅显示 mythos"，现在对任意多家成立。
    const items = await fetchCatalog(request, USER, await marketWithContent(request))
    const sources = new Set(items.map((i: any) => i.source))
    expect(sources.has('mythos'), '活着的那家必须照常显示').toBeTruthy()
    expect(sources.has('cowork'), '连不上的那家不出现，但不影响别人').toBeFalsy()
  })

  test('缓存不串号：换个用户名重新问，走的是这个人自己的目录', async ({ request }) => {
    // 缓存在第 3 步下沉进 adapter，按用户名分桶。共用一份的话第二个人会看到第一个人的
    // 目录——两边看着都"正常"，只是不对。
    const mkt = await marketWithContent(request)
    const a = await fetchCatalog(request, 'a001', mkt)
    const b = await fetchCatalog(request, 'b002', mkt)
    expect(a.length).toBe(b.length)          // mock 对谁都返回同一批，条数应当一致
    const again = await fetchCatalog(request, 'a001', mkt)
    expect(again.map((i: any) => i.id)).toEqual(a.map((i: any) => i.id))
  })

  test('缺用户名时这家自己拒绝，接口不 500', async ({ request }) => {
    // "必须有用户名"是 mythos 自己的前置条件（第 3 步从市场层下沉）。它抛错，市场层降级，
    // 接口仍应当是 200——**用户看到的是空市场，不是一个红色报错页**。
    const r = await request.get(`${API}/skills/pull-server/catalog`)
    expect(r.status(), '缺用户名不该让整个接口挂掉').toBe(200)
    expect(await r.json()).toEqual([])
  })

  test('界面：技能中心能打开，市场页签列出后端返回的那几条', async ({ page, request }) => {
    const mkt = await marketWithContent(request)
    const items = await fetchCatalog(request, USER, mkt)   // 先拿到期望值，再看界面对不对得上
    // 设当前用户（mythos 靠它鉴权）。真实流程由登录设置，这里直接调接口。
    await request.post(`${API}/skills/current-user`, { data: { username: USER } })

    await prep(page)                                // 伪造登录态，跳过登录门
    await page.goto('/')

    // 入口在左侧栏的设置菜单里（与 smoke.spec 同一走法）。
    // 侧栏入口的文案从「Skill 市场」改成了「技能中心」（这个页面的定位从"市场"
    // 变成了"用户所有 skill 相关东西的集中管理"）。写死旧文案的话这里会超时，
    // 而超时看起来像页面没加载出来。
    await page.getByRole('button').filter({ hasText: /Tester|设置|Settings/ }).last().click()
    await page.getByText(/^技能中心$|^Skills$/).first().click()

    // 切到市场页签（默认停在「本地」那页）。页签名就是那个 cowork 的显示名。
    const tabName = mkt
      ? (await (await request.get(`${API}/coworks`)).json())
          .find((c: any) => c.id === mkt)?.display_name
      : '通用'
    await page.getByRole('button', { name: tabName, exact: true }).click()

    // **逐条核对**：界面少显示一条是最常见的"看起来没问题"的错，只断言"有列表"抓不到。
    for (const it of items) {
      await expect(
        page.getByText(it.name, { exact: false }).first(),
        `市场页应当显示 ${it.name}`,
      ).toBeVisible({ timeout: 15_000 })
    }
  })
})
