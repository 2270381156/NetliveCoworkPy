import { cloudAuthHeaders } from '@/api/client'

/**
 * 触发浏览器保存一个远端文件。
 *
 * **为什么不用 `<a href download>`**：`download` 属性只对**同源** URL 生效，跨域时被
 * 浏览器忽略，点击变成普通导航（文件被打开或直接跳走，而不是保存）。云端后端是另一个
 * 源，所以那条路在云端会话上必然失效。
 *
 * 顺带解决第二件事：`<a>` / `<img>` 的请求由浏览器直接发出，**带不了 Authorization 头**。
 * 这里走 fetch，等网关鉴权上线时只需在这一处加头，不必把每个下载入口改一遍。
 */
export async function downloadUrl(url: string, filename: string, init?: RequestInit): Promise<void> {
  // 云端后端的下载同样要自证身份。这里就是注释里说的那个"唯一入口"——所有下载入口
  // （工作区单文件、整包 zip、预览工具栏）最终都落到这一行。
  const res = await fetch(url, {
    ...init,
    headers: { ...cloudAuthHeaders(url), ...(init?.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) {
    // 后端错误体是 {detail: "..."}（工作区端点用的是 FastAPI 默认形态）
    let detail = ''
    try {
      const body = await res.text()
      try { detail = (JSON.parse(body) as { detail?: string })?.detail || body } catch { detail = body }
    } catch { /* 读不出 body 就算了 */ }
    const e = new Error(detail ? detail.slice(0, 200) : `HTTP ${res.status}`) as Error & { status?: number }
    e.status = res.status
    throw e
  }
  saveBlob(await res.blob(), filename)
}

/** 把一个已经拿到的 blob 存成文件。对象 URL 用完即回收，否则整页生命周期内都占着内存。 */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename          // 同源的 blob: URL，download 一定生效
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 在部分浏览器上会打断下载，推迟一拍最稳。
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}
