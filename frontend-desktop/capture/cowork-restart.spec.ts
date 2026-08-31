/**
 * 需要**跨重启**才看得出来的那几条（需求 C11 / E3 / E7 / F1 / AC-5 / AC-10 / AC-32）。
 *
 * 与 `cowork-acceptance.spec.ts` 的分工：那边靠 `POST /coworks/recheck` 在同一个进程里
 * 对账，够验"收回/放回"；这边验的是**启动时才发生的事** —— 模板表在启动时建、
 * 播种在启动时做、"这次跳过了"只写在启动那次对账的日志里。
 *
 * ⚠ 本文件会**停掉并重起你正在用的后端**。跑完 `afterAll` 会把它以脱离父进程的方式起回来；
 * 但中途 Ctrl-C 会留下一个停掉的后端 —— 那时手工再起一次即可。
 */
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { backendLog, handBackToManual, restartBackend, startBackend, stopBackend, BASE } from './_backend'
import {
  COWORKS_DIR, PACKAGES_DIR, installedOnDisk, setEntitled, snapshot, type Snapshot,
} from './_cowork'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)          // 每条都要起停后端

let snap: Snapshot

test.beforeAll(() => {
  snap = snapshot()
  expect(snap.installed.length, '一个套件都没装，这组用例无从谈起').toBeGreaterThan(0)
})

test.afterAll(async () => {
  setEntitled(snap.installed)
  await handBackToManual()
  expect(installedOnDisk(), '跑完之后套件状态没回到原样').toEqual(snap.installed)
})

async function api(path: string) {
  const r = await fetch(`${BASE}/api/v1${path}`)
  return { status: r.status, body: r.ok ? await r.json() : null }
}

// ── C11 / AC-5：连不上云端时不得增加任何闸门 ─────────────────────────────────

test('AC-5/C11 云端连不上时重启 → 应用照常开、历史照常看、套件不增不删', async ({ page }) => {
  const before = installedOnDisk()

  // **后端并不直接连云端**：取包由客户端主进程做（C3），两者以暂存目录交接。
  // 所以"云端连不上"在后端这一侧的形态就是**凭据没拿到**——把它模拟成删掉凭据文件，
  // 而不是去改一个后端根本不读的地址。（改地址那种写法会"通过"，但什么都没验到。）
  setEntitled(null)
  await restartBackend()

  expect(installedOnDisk(), '连不上云端时动了本地套件 —— 把网络故障当成了权限收回').toEqual(before)

  const coworks = await api('/coworks')
  expect(coworks.status, '连不上云端不该让阵容接口挂掉').toBe(200)
  expect((coworks.body as unknown[]).length, '套件还在，阵容就该照常列出来').toBe(before.length)

  // 历史会话照常查看 —— 真要对话时网络不通自然会失败，不需要再造一道门去拦。
  const sessions = await api('/sessions')
  expect(sessions.status, '连不上云端时历史会话应当照常读得到').toBe(200)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  const body = await page.locator('body').innerText()
  expect(body.length, '界面成了一块白 —— 顶层没兜住（I10）').toBeGreaterThan(50)

  setEntitled(snap.installed)
})

// ── E3：播种只增不覆盖 ───────────────────────────────────────────────────────

test('E3 用户改过的提示词，重启后不被播种覆盖', async () => {
  const cid = snap.installed[0]
  const dir = join(COWORKS_DIR, cid)
  const facet = readdirSync(dir).find(f => f.endsWith('.md'))
  expect(facet, `${cid} 里一个提示词文件都没有？`).toBeTruthy()

  const path = join(dir, facet!)
  const original = readFileSync(path, 'utf-8')
  const marked = original + '\n<!-- 用户改过的一行（E3 探针） -->\n'
  writeFileSync(path, marked)

  try {
    await restartBackend()
    // 版本没变 → 应当整个跳过，用户的改动一个字都不动。
    expect(readFileSync(path, 'utf-8'), '用户改过的提示词被播种覆盖了 —— E3 反了')
      .toBe(marked)
  } finally {
    writeFileSync(path, original)
  }
})

// ── E7 / AC-32：改了内容却没改版本，日志里要看得出「跳过了」 ────────────────

test('E7/AC-32 改内容不改版本 → 日志说得出「版本相同已跳过」', async () => {
  // 安装判据是版本相等就跳过，所以内容改了不动版本的话重启后还是旧的，**且不报任何错**。
  // 日志里那一句是"改了没生效"时唯一的线索。
  setEntitled(snap.installed)
  await restartBackend()

  const log = backendLog()
  expect(log, '日志里找不到"跳过"的记录 —— "改了没生效"就无从查起').toMatch(/跳过|skip/i)
})

// ── C5 / AC-11 的重启版：没有凭据时一个都不删 ────────────────────────────────

test('C5 重启时拿不到凭据 → 一个都不删，且日志写明是哪一种「不做」', async () => {
  const before = installedOnDisk()
  try {
    setEntitled(null)
    await restartBackend()
    expect(installedOnDisk(), '没有凭据却删了东西 —— 手工摆目录的开发态会被清空').toEqual(before)
    // K2：「什么都不做」的分支也要留日志，且要写明是哪一种不做。
    expect(backendLog(), 'K2：没留下"为什么什么都没做"的线索')
      .toMatch(/没有授权凭据|不增不删/)
  } finally {
    setEntitled(snap.installed)
  }
})

// ── C6 / AC-10：版本回滚要装回去 ─────────────────────────────────────────────

test('AC-10/C6 云端把版本回滚 → 客户端装回旧版（写成"变大才装"这里不会变）', async () => {
  const cid = snap.installed[0]
  const manifest = JSON.parse(readFileSync(join(COWORKS_DIR, cid, 'cowork.json'), 'utf-8'))
  const current = String(manifest.version)

  // 用当前已装的内容重打一个**版本更小**的包，摆进暂存目录。
  const rolledBack = '0.0.1'
  const src = join(PACKAGES_DIR, '__rollback_src__', cid)
  execFileSync('powershell', ['-NoProfile', '-Command',
    `New-Item -ItemType Directory -Force '${src}' | Out-Null; ` +
    `Copy-Item -Recurse -Force '${join(COWORKS_DIR, cid)}\\*' '${src}'`])
  const m2 = JSON.parse(readFileSync(join(src, 'cowork.json'), 'utf-8'))
  m2.version = rolledBack
  writeFileSync(join(src, 'cowork.json'), JSON.stringify(m2, null, 2))

  const repo = join(process.cwd(), '..')
  const py = existsSync(join(repo, '.venv', 'Scripts', 'python.exe'))
    ? join(repo, '.venv', 'Scripts', 'python.exe') : 'python'

  const madeZips: string[] = []
  try {
    execFileSync(py, [join(repo, 'dev', 'pack_cowork.py'), src, PACKAGES_DIR], { cwd: repo })
    madeZips.push(join(PACKAGES_DIR, `${cid}-${rolledBack}.zip`))
    // 原来那个更高版本的包要挪开，否则"取最新"会挑回它（E2）。
    const higher = join(PACKAGES_DIR, `${cid}-${current}.zip`)
    const stash = `${higher}.stash`
    if (existsSync(higher)) execFileSync('powershell', ['-NoProfile', '-Command',
      `Move-Item -Force '${higher}' '${stash}'`])

    await restartBackend()
    const now = JSON.parse(readFileSync(join(COWORKS_DIR, cid, 'cowork.json'), 'utf-8'))
    expect(String(now.version), '回滚没装回去 —— 判据多半写成了"变大才装"').toBe(rolledBack)

    if (existsSync(stash)) execFileSync('powershell', ['-NoProfile', '-Command',
      `Move-Item -Force '${stash}' '${higher}'`])
  } finally {
    for (const z of madeZips) {
      if (existsSync(z)) execFileSync('powershell', ['-NoProfile', '-Command', `Remove-Item -Force '${z}'`])
    }
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Remove-Item -Recurse -Force '${join(PACKAGES_DIR, '__rollback_src__')}' -ErrorAction SilentlyContinue`])
    await restartBackend()     // 装回原版本
  }
})

// ── F1：模板从「已装套件」目录加载 ───────────────────────────────────────────

test('F1 模板从已装套件目录加载 —— 收回之后就真的建不出会话', async () => {
  const victim = snap.installed[snap.installed.length - 1]
  const survivor = snap.installed.find(id => id !== victim)
  test.skip(!survivor, '需要两个套件')

  try {
    setEntitled([survivor!])
    await restartBackend()

    // 出厂资源目录里可能还有同名模板。**从那儿加载的话这里会 200** ——
    // 那正是 F1 要挡的：装了哪几个既决定界面列什么，也决定实际能跑什么。
    const r = await fetch(`${BASE}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: `agent:${victim}`, workspace: 'D:/__nlc_test_ws__', user_prompt: '' }),
    })
    expect(r.status, '收回之后还建得出会话 —— 模板多半还在从出厂资源目录加载').toBe(404)
  } finally {
    setEntitled(snap.installed)
    await restartBackend()
  }
})

// ── llm.define：套件自带的 LLM 账号 ──────────────────────────────────────────

test('套件自带的 LLM 账号被注册；收回之后随之消失（不落盘）', async () => {
  // 云端下发的清单里带 llm.define（账号名 → style/base_url/api_key/模型表）。
  // 不读它的话，allow 里的名字指不到任何账号，界面显示「没有可用模型」，
  // 而真实原因是账号从没装进来。
  const victim = snap.installed[0]

  setEntitled(snap.installed)
  await restartBackend()

  const before = await accountsOf(victim)
  const fromSuite = before.filter(n => n.endsWith('-cloud-model'))
  test.skip(fromSuite.length === 0, '这套开发套件没配 llm.define，这条验不了')

  try {
    // 收回 → 重启：套件账号必须**跟着消失**。
    // 落盘的话它会留下来，而它带着可用的凭据 —— 一次实打实的越权，且没有任何现象提示。
    const survivor = snap.installed.find(id => id !== victim)
    test.skip(!survivor, '需要两个套件')
    setEntitled([survivor!])
    await restartBackend()

    const all = await accountsOf(null)
    for (const n of fromSuite) {
      expect(all, `${n} 在套件被收回后还在 —— 多半 persist 成 true 了`).not.toContain(n)
    }
  } finally {
    setEntitled(snap.installed)
    await restartBackend()
  }
})

test('套件自带的账号是锁定的：不能删', async () => {
  const all = await accountsOf(null)
  const suiteAcct = all.find(n => n.endsWith('-cloud-model'))
  test.skip(!suiteAcct, '这套开发套件没配 llm.define')

  const r = await fetch(`${BASE}/api/v1/llms/${encodeURIComponent(suiteAcct!)}`, { method: 'DELETE' })
  expect(r.status, '套件账号被删掉了 —— 改了也留不住（下次启动按套件重来），应当直接不给删')
    .not.toBe(204)
})

async function accountsOf(cowork: string | null): Promise<string[]> {
  const r = await fetch(`${BASE}/api/v1/llms${cowork ? `?cowork=${cowork}` : ''}`)
  return ((await r.json()) as Array<{ name: string }>).map(a => a.name)
}

// ── A8：母版不得以 cowork 的身份出现 ─────────────────────────────────────────

test('A8 母版装在同一个目录下，但不进阵容', async () => {
  await startBackendIfDown()
  expect(existsSync(join(COWORKS_DIR, 'default')), '母版必须和套件装在一起，facet 兜底要用它')
    .toBe(true)
  const coworks = await api('/coworks')
  expect((coworks.body as Array<{ id: string }>).map(c => c.id), '母版混进阵容了')
    .not.toContain('default')
})

async function startBackendIfDown() {
  try {
    const r = await fetch(`${BASE}/api/v1/coworks`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) return
  } catch { /* 没起来 */ }
  await startBackend()
}
