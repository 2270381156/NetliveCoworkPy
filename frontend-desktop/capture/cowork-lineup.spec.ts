/**
 * cowork 阵容 —— 界面真的拿到并用上了吗（对着**真实后端**跑）。
 *
 * 接口对不等于界面对：阵容是**异步到达**的，任何在模块顶层捕获它的写法都会永远拿到空，
 * 而那不报错，只表现为"界面一个 cowork 都没有"。所以这里验的是渲染出来的东西。
 *
 * 跑法（后端要开着，装了套件）：
 *   BACKEND_PORT=17926 npx playwright test -c capture.config.ts capture/cowork-lineup.spec.ts
 */
import { expect, test } from '@playwright/test'

import { prep } from './_setup'

test('阵容从后端拉到并按次序渲染', async ({ page }) => {
  const seen: number[] = []
  page.on('response', r => { if (r.url().includes('/coworks')) seen.push(r.status()) })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // 界面拿到清单了
  expect(seen, '前端没去拉 /coworks —— 阵容那条链没接上').toContain(200)

  const lineup = await page.evaluate(async () => {
    const r = await fetch('/api/v1/coworks')
    return (await r.json()) as Array<{ id: string; display_name: string; order: number }>
  })
  expect(lineup.map(c => c.id)).toEqual(['ipmaster', 'coremaster'])
  expect(lineup[0].order).toBeLessThan(lineup[1].order)
})

test('每个 cowork 的名字都出现在切换器里', async ({ page }) => {
  // prep() 会把首次引导的 localStorage 标记打上。**不打的话引导遮罩盖住整页**，
  // 任何点击都超时，而超时看起来像"元素没渲染出来"——与真正的渲染失败分不开。
  await prep(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)      // 阵容异步到达，等它广播完

  // ⚠ 顶栏只显示**当前**那一个，别的在下拉里。
  // 这条最初写的是「body 里两个名字都在」——那是切换器出现之前的形态；
  // 加了切换器之后它会红，而红的原因是界面变对了，不是变坏了。
  const lineup = await page.evaluate(async () => {
    const r = await fetch('/api/v1/coworks')
    return (await r.json()) as Array<{ display_name: string }>
  })

  const trigger = page.locator('button[title*="switch"], button[title*="切换"]').first()
  await trigger.click()
  const menu = await trigger.locator('xpath=../div').innerText()
  for (const c of lineup) {
    expect(menu, c.display_name + ' 没出现在切换器里').toContain(c.display_name)
  }
})

test('没有渲染错误', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)

  // 忽略与本次改动无关的噪声（字体、资源 404 等）
  const real = errors.filter(e => !/favicon|font|net::ERR_/i.test(e))
  expect(real, `控制台有错误：\n${real.join('\n')}`).toEqual([])
})
