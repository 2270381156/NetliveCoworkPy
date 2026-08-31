/**
 * cowork 验收用的环境操纵 —— 装/收回/改凭据，都不重启后端。
 *
 * 靠的是 `POST /coworks/recheck`：它读**暂存目录**（假云端）重新对一次账并 reload 策略，
 * 与真下发走的是同一段代码（service.reconcile），区别只是那个目录里的 zip 从哪来。
 *
 * ⚠ **这些测试会改动开发环境里已装的套件。** 跑挂在半路会把环境留在收回状态，
 * 表现是"应用突然一个 cowork 都没有了"。所以每个用例自己 try/finally 复原，
 * `_setup` 里再兜一次底 —— 复原失败要**显式报错**，不能静默留个坏环境给下一轮。
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 已装套件目录。与后端 `paths.coworks_dir()` 同源（NLC_COWORKS_DIR）。 */
export const COWORKS_DIR =
  process.env.NLC_COWORKS_DIR ?? join(tmpdir(), 'nlc-dev', 'coworks')

/** 暂存目录（假云端）。与后端 `paths.cowork_staging_dir()` 同源。 */
export const PACKAGES_DIR =
  process.env.NLC_COWORK_PACKAGES_DIR ?? join(tmpdir(), 'nlc-dev', 'packages')

const ENTITLED = join(PACKAGES_DIR, 'entitled.json')

/** 母版不是 cowork，列清单时按名字排除（后端同一判据，见 store.list_installed）。 */
const MASTER = 'default'

export type Snapshot = { entitled: string | null; installed: string[] }

/** 磁盘上现在装了哪几个（不含母版）。 */
export function installedOnDisk(): string[] {
  if (!existsSync(COWORKS_DIR)) return []
  return readdirSync(COWORKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== MASTER)
    .map(d => d.name)
    .sort()
}

/** 暂存目录里有哪些包可装。 */
export function packagesAvailable(): string[] {
  if (!existsSync(PACKAGES_DIR)) return []
  return readdirSync(PACKAGES_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => f.replace(/-[\d.]+\.zip$/, ''))
    .sort()
}

export function snapshot(): Snapshot {
  return {
    entitled: existsSync(ENTITLED) ? readFileSync(ENTITLED, 'utf-8') : null,
    installed: installedOnDisk(),
  }
}

/**
 * 改授权凭据。
 *
 * `null` = **把凭据文件删掉**，模拟"这次没核对上"（网络断、令牌过期）——
 * 与"核对上了但一个都没开通"（传 `[]`）在数据上都是"没有"，但处置完全相反：
 * 前者一个都不能删，后者要全删。这两条的区别正是 AC-11 要验的。
 */
export function setEntitled(ids: string[] | null): void {
  mkdirSync(PACKAGES_DIR, { recursive: true })
  if (ids === null) {
    if (existsSync(ENTITLED)) rmSync(ENTITLED)
    return
  }
  writeFileSync(ENTITLED, JSON.stringify({ agents: ids, syncedAt: new Date().toISOString() }, null, 2))
}

export type RecheckResult = {
  installed: Record<string, string>
  skipped: Record<string, string>
  removed: string[]
  failed: Record<string, string>
}

export async function recheck(request: APIRequestContext): Promise<RecheckResult> {
  const r = await request.post('/api/v1/coworks/recheck')
  expect(r.status(), '对账接口没通 —— 后端没起来，或路由没注册').toBe(200)
  return (await r.json()) as RecheckResult
}

export async function listCoworks(request: APIRequestContext): Promise<string[]> {
  const r = await request.get('/api/v1/coworks')
  expect(r.status()).toBe(200)
  return ((await r.json()) as Array<{ id: string }>).map(c => c.id)
}

/**
 * 复原到快照状态。**复原不了要报错** —— 静默失败会把坏环境留给下一个用例，
 * 而下一个用例失败的原因看起来会完全不搭边。
 */
export async function restore(request: APIRequestContext, snap: Snapshot): Promise<void> {
  if (snap.entitled === null) {
    if (existsSync(ENTITLED)) rmSync(ENTITLED)
  } else {
    mkdirSync(PACKAGES_DIR, { recursive: true })
    writeFileSync(ENTITLED, snap.entitled)
  }
  await recheck(request)
  expect(installedOnDisk(), '复原失败：开发环境被留在了非原始状态').toEqual(snap.installed)
}

/**
 * 建一条会话，并登记到 `bin` 里等着删。
 *
 * ⚠ **测试造的会话必须自己收走。** 开发环境的数据目录就是用户平时在用的那个
 * （NLC_DATA_DIR 指向真实 AppData），留下来的会话会混进他的会话列表，
 * 标题还是一串 `ses_...` —— 看起来像产品出了什么毛病，而不是测试的残留。
 * 实测就发生过：跑完四条用例，用户在 CoreMaster 里看到四条不明会话。
 */
export async function createSession(
  request: APIRequestContext,
  bin: string[],
  body: Record<string, unknown>,
): Promise<{ status: number; id?: string }> {
  const r = await request.post('/api/v1/sessions', {
    data: { workspace: TEST_WS, user_prompt: '', ...body },
  })
  if (r.status() === 200) {
    const id = (await r.json()).id as string
    bin.push(id)
    return { status: 200, id }
  }
  return { status: r.status() }
}

/** 测试会话的工作目录。写成一个显眼的固定值，万一漏删也一眼看得出是测试造的。 */
export const TEST_WS = 'D:/__nlc_test_ws__'

/** 收走这一批会话。**删不掉也不让整组失败** —— 清理失败不该盖掉真正的断言结果。 */
export async function dropSessions(request: APIRequestContext, bin: string[]): Promise<void> {
  for (const id of bin.splice(0)) {
    try { await request.delete(`/api/v1/sessions/${id}`) } catch { /* 尽力而为 */ }
  }
}
