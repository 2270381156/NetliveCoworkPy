/**
 * 后端进程的起停 —— 让「重启之后…」那一类验收也能自动跑。
 *
 * 有几条需求只有跨重启才看得出来，靠 `POST /coworks/recheck` 是验不到的：
 *
 *   C11  连不上云端时不得增加任何闸门 —— 要真的断掉再启一次
 *   E3   播种只增不覆盖 —— 改过的提示词要在重启后还在
 *   E7   改了内容没改版本 —— 判据在启动那次对账的日志里
 *   F1   模板从**已装套件**目录加载 —— 模板表在启动时建
 *   I2   「还没拉到」这个中间态 —— 只在启动早期存在
 *
 * ⚠ **它操作的是用户平时在用的那个后端进程。** 起不来的话开发环境就没了，
 * 所以每处失败都带上"接下来该怎么办"的话，别只抛一个超时。
 */
import { expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 仓库根。capture 跑在 frontend-desktop/ 下。 */
const REPO = join(process.cwd(), '..')

const PORT = process.env.BACKEND_PORT ?? '17926'
export const BASE = `http://127.0.0.1:${PORT}`

/** 起后端用的解释器。venv 优先 —— 系统 python 多半没装依赖。 */
function python(): string {
  const venv = join(REPO, '.venv', 'Scripts', 'python.exe')
  return existsSync(venv) ? venv : (process.env.PYTHON ?? 'python')
}

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // ⚠ **必须显式指定**：stdout 是管道时，Windows 上的 Python 按系统码页（cp936）写，
    // 而 Node 按 UTF-8 解 —— 日志里的中文全成乱码，于是"日志里有没有那句话"这类断言
    // 永远失败，而失败信息里那一坨乱码根本看不出是编码问题。
    PYTHONIOENCODING: 'utf-8',
    NLC_DATA_DIR: process.env.NLC_DATA_DIR
      ?? join(process.env.APPDATA ?? '', 'IPMaster-Cowork', 'data'),
    NLC_COWORKS_DIR: process.env.NLC_COWORKS_DIR ?? join(tmpdir(), 'nlc-dev', 'coworks'),
    NLC_COWORK_PACKAGES_DIR:
      process.env.NLC_COWORK_PACKAGES_DIR ?? join(tmpdir(), 'nlc-dev', 'packages'),
  }
}

let child: ChildProcess | null = null
/** 启动后的日志。E7/K2 那几条要在里面找证据。 */
let logBuf = ''

export function backendLog(): string { return logBuf }

async function alive(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/v1/coworks`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

/** 等到活/等到死。轮询而不是 sleep 固定时长：机器快慢差很多。 */
async function waitFor(want: boolean, ms = 60_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await alive() === want) return true
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

/**
 * 停掉后端。**按端口杀，不只杀我们自己 spawn 的那个** —— 环境多半是人手工起的，
 * 只杀自己起的会留着旧进程占着端口，下一步 spawn 直接 bind 失败，
 * 而失败信息（address already in use）看起来跟测试内容毫无关系。
 */
export async function stopBackend(): Promise<void> {
  if (child) { try { child.kill() } catch { /* 已经没了 */ } child = null }
  const killer = spawn(
    'powershell',
    ['-NoProfile', '-Command',
     `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue ` +
     `| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore' },
  )
  await new Promise(r => killer.on('exit', r))
  expect(await waitFor(false, 20_000), `后端没停下来（端口 ${PORT} 仍在监听）`).toBe(true)
}

/** 起后端并等到就绪。`extraEnv` 用来造场景（比如把云端地址指向一个连不上的地方）。 */
export async function startBackend(extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  logBuf = ''
  child = spawn(
    python(),
    ['-m', 'netlivecowork.cli', 'serve', '--host', '127.0.0.1', '--port', PORT],
    { cwd: REPO, env: { ...env(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout?.on('data', d => { logBuf += String(d) })
  child.stderr?.on('data', d => { logBuf += String(d) })

  const ok = await waitFor(true)
  expect(ok, `后端没起来。日志尾部：\n${logBuf.slice(-1200)}`).toBe(true)
}

export async function restartBackend(extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  await stopBackend()
  await startBackend(extraEnv)
}

/**
 * 把后端交还给"手工起的那种状态"。
 *
 * 整组跑完必须调 —— 否则测试进程一退，spawn 出来的后端跟着死，
 * 用户的应用会突然连不上后端，而他完全不知道刚才发生了什么。
 */
export async function handBackToManual(): Promise<void> {
  await stopBackend()

  // ⚠ **必须 detached + stdio:'ignore' + unref，三样缺一不可。**
  // 只 unref 不够：子进程仍在同一个进程组里，测试进程一退它跟着死 —— 实测踩过，
  // 跑完整组之后用户的后端就没了，而他完全不知道刚才发生了什么。
  // 保留管道也会让父进程等它，所以这一次不接日志（这时也不需要了）。
  const detached = spawn(
    python(),
    ['-m', 'netlivecowork.cli', 'serve', '--host', '127.0.0.1', '--port', PORT],
    { cwd: REPO, env: env(), stdio: 'ignore', detached: true },
  )
  detached.unref()
  child = null

  expect(await waitFor(true), '后端没能交还给手工态 —— 请手工再起一次').toBe(true)
}
