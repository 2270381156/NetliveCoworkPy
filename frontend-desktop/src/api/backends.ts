/**
 * 后端定址 —— **本分支只有地端**。
 *
 * demo/experimental 上这个模块管的是"这条会话跑在本机还是云上"（云地协同）。
 * 本分支不做云地协同（需求 §2.2 非目标），所以这里保留**同样的接口面**，
 * 但云端那一半一律返回"没有"。
 *
 * ## 为什么保留整个接口面而不是把调用点删掉
 *
 * 调用点散在 client / sessions / workspace / SessionList / ChatPanel 等十几处。
 * 删的话：
 *
 *   · 现在要在那些刚整份取过来的组件里逐处动刀，**改错不报错**——
 *     只是某条会话向错误的地址要数据，或者来源徽章显示错；
 *   · 将来接云地协同时还要一处处加回来，同样的风险再来一遍。
 *
 * 留着的话，接云端 = 把这个文件换回真实实现，**调用点一处都不用动**。
 * 代价只是这几十行恒定返回值。
 */

/** 后端标识。**本分支恒为 `local`**，但类型保留两种值，免得调用点的判断被优化掉。 */
export type BackendId = 'local' | 'cloud'

export interface Backend {
  id: BackendId
  base: string
  label: string
}

export const LOCAL_BASE = '/api/v1'

const LOCAL: Backend = { id: 'local', base: LOCAL_BASE, label: 'Local' }

// ── 云端：一律"没有" ─────────────────────────────────────────────────────────

export function applyFactoryConfig(_cfg?: { cloudBackendUrl?: string } | null): void {}
export function applyCloudSession(_s?: { connectUrl?: string; user?: string | null } | null): void {}
export function getCloudUrl(): string { return '' }
export function setCloudUrl(_raw: string): void {}
export function hasCloudBackend(): boolean { return false }
export function setExpectedUsername(_name?: string | null): void {}
export function getCloudIdentityMismatch(): string | null { return null }

/** 探活云端。**恒为不可用** —— 界面据此不显示云端入口。 */
export async function probeCloud(_signal?: AbortSignal): Promise<boolean> { return false }

// ── 定址：永远是本地 ─────────────────────────────────────────────────────────

export function getBackend(_id: BackendId): Backend { return LOCAL }
export function activeBackends(): Backend[] { return [LOCAL] }
export function backendOf(_sessionId?: string | null): BackendId { return 'local' }
export function isCloudSession(_sessionId?: string | null): boolean { return false }
export function baseOf(_sessionId?: string | null): string { return LOCAL_BASE }

/** 记住某条会话在哪个后端。本分支无处可记，留空实现让调用点不必判断。 */
export function rememberSessionBackend(_sessionId: string, _id: BackendId): void {}
export function forgetSessionBackend(_sessionId: string): void {}

/** 订阅后端变化。本分支后端集合恒定，订阅永不触发；返回一个可调用的退订。 */
export function subscribeBackends(_fn: () => void): () => void {
  return () => {}
}
