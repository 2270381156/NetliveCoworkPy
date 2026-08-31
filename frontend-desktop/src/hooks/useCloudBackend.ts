/**
 * 云端后端的连接状态 —— **本分支恒为"没配"**。
 *
 * 云地协同不在本期范围（需求 §2.2）。`configured: false` 让界面上所有云端字样都不出现，
 * 与"配了但没就绪"是两回事——后者要给"正在准备"的交代，前者应当完全无痕。
 *
 * 保留这个 hook 而不是把 App 里的调用删掉，理由同 `api/backends.ts`：
 * 接云端时换回真实实现即可，调用点不动。
 */

export interface CloudBackendState {
  /** 是否配了云端地址。没配 = 纯桌面版，界面不该出现任何云端字样。 */
  configured: boolean
  online: boolean
  /** 配了但还没就绪。本分支恒为 false —— 没配就谈不上"正在准备"。 */
  warmingUp: boolean
  username: string | null
}

const NOT_CONFIGURED: CloudBackendState = {
  configured: false,
  online: false,
  warmingUp: false,
  username: null,
}

export function useCloudBackend(): CloudBackendState {
  return NOT_CONFIGURED
}
