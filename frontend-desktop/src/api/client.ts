import { LOCAL_BASE, baseOf, getBackend } from './backends'
import type { BackendId } from './backends'

// ── 云端凭据 ──────────────────────────────────────────────────────────────────
// 云端后端在别人的机器上，请求必须自证身份；地端后端跑在本机 127.0.0.1、由 Electron
// 亲手拉起，不需要也不该带令牌（带了只会把它多暴露一处）。
//
// 令牌由接入流程用 ticket 换来后写进这里（见 api/cloudAccess），只存内存：它几小时就
// 过期，落盘除了扩大泄露面没有好处。
//
// 收口在 createHttp 这一层的原因：它是**唯一**的请求工厂，request 与 postForm 都从这里
// 出去。散到各 api 模块去加头，迟早漏掉一个——而漏掉的那个会静默地以匿名身份发出去。
let cloudAuthToken = ''

export function setCloudAuthToken(token: string | null | undefined): void {
  cloudAuthToken = (token || '').trim()
}

export function hasCloudAuthToken(): boolean {
  return cloudAuthToken !== ''
}

/**
 * 该后端要带的认证头。地端恒为空。
 *
 * 导出是给**同样发往后端、但不经过 createHttp 的那几处**用的（打包下载走 blob、
 * skill 导出）。注意这只覆盖得了 JS 发起的 fetch —— 浏览器原生发起的加载
 * （EventSource、`<img src>`）不经过这一层，加不上头，那部分方案见三方对接设计
 * v2.1 的 A/B/C/D，尚未定。别以为加了这个就全覆盖了。
 *
 * 传完整 URL 或 base 都行：判据是"是不是发往地端"。
 */
export function cloudAuthHeaders(urlOrBase: string): Record<string, string> {
  return authHeadersFor(urlOrBase)
}

function authHeadersFor(base: string): Record<string, string> {
  if (!cloudAuthToken) return {}
  // 用 base 判断而不是传 BackendId：createHttp 拿到的就是 base，且 httpForBackend /
  // httpFor 最终都归到它。以地址判断能保证"只要发往地端就绝不带令牌"。
  if (base === LOCAL_BASE || base.startsWith(LOCAL_BASE)) return {}
  return { Authorization: `Bearer ${cloudAuthToken}` }
}

/**
 * 请求失败时的统一出口：**先把响应体原样读成文本**，再尝试当 JSON 解。
 *
 * 原先是 `await res.json().catch(() => ({ message: res.statusText }))` —— 响应体不是
 * JSON 时（nginx 的 HTML 错误页、代理的纯文本），正文被 catch 吞掉，只剩一个 statusText。
 * 而"这条 500 是 FastAPI 抛的还是中间某层 nginx 抛的"，恰恰只能从正文形态看出来：
 * FastAPI 回 `{"detail":…}`，nginx 回 `<html><head><title>500 …`。丢了它就只能靠猜。
 *
 * 顺带把失败详情写进 electron.log —— console.error 只进 DevTools，用户机器上查不到。
 */
async function failure(res: Response, url: string, method: string): Promise<HttpError> {
  const text = await res.text().catch(() => '')
  let parsed: { detail?: string | { code?: string; message?: string }; message?: string } = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { /* 不是 JSON，保持空对象，正文另行记录 */ }

  // 一眼看出是谁抛的：JSON 体多半是 agent（FastAPI），HTML 体多半是中间的 nginx/代理。
  const shape = !text ? '空响应体'
    : text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? 'JSON（多半来自 agent/FastAPI）'
    : /^\s*<(!doctype|html)/i.test(text) ? 'HTML（多半来自中间层 nginx/代理，请求可能没到 agent）'
    : '纯文本'
  logToFile(
    `HTTP ${res.status} ${res.statusText} ${method} ${url}\n`
    + `  server=${res.headers.get('server') || '(无)'} content-type=${res.headers.get('content-type') || '(无)'}\n`
    + `  正文形态=${shape}\n`
    + `  正文=${text.slice(0, 1200)}`,
  )
  const e = toError(parsed, res.statusText, res.status)
  if (!parsed.detail && !parsed.message && text) e.message = text.slice(0, 300)
  return e
}

/** 写进 electron.log；不在 Electron 里（纯浏览器 dev）时退回 console。 */
function logToFile(line: string): void {
  const api = (window as unknown as { electronAPI?: { logToFile?: (s: string) => void } }).electronAPI
  try { api?.logToFile ? api.logToFile(line) : console.error(line) } catch { console.error(line) }
}

async function request<T>(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const url = `${base}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeadersFor(base),
      ...headers,     // 显式传入的头优先：上传 skill 到市场要带的是用户 token，不是云端令牌
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw await failure(res, url, method)
  if (res.status === 204) return undefined as T
  return res.json()
}

// 把后端错误体 {detail:{code,message}} 转成 Error，并把 code 挂上去，供调用方按 code
// 做本地化友好提示（如上传 skill 重名 → SKILL_NAME_EXISTS）。detail 也可能是纯字符串
// （FastAPI 的默认形态，如工作区 403 / 413），一并接住，否则会退化成 statusText。
export type HttpError = Error & { code?: string; status?: number }

function toError(
  body: { detail?: string | { code?: string; message?: string }; message?: string },
  fallback: string,
  status: number,
): HttpError {
  const d = body.detail
  const detailText = typeof d === 'string' ? d : d?.message
  const e = new Error(detailText ?? body.message ?? fallback) as HttpError
  e.code = typeof d === 'string' ? undefined : d?.code
  e.status = status          // 上传要按 413（超限/配额）给专门文案，故状态码不能丢
  return e
}

async function postForm<T>(base: string, path: string, form: FormData, headers?: Record<string, string>): Promise<T> {
  // 不手动设 Content-Type：交给浏览器带上 multipart boundary。headers 仅用于透传
  // Authorization 等（如上传 skill 到市场时带用户 token，让 cowork 写 creator）。
  const url = `${base}${path}`
  // 上传是最难查的一条：体大、走 multipart、云端还多穿两层代理。先把"发了什么"记下来，
  // 好和失败那行对上——只记文件名与大小，不碰内容。
  const files = form.getAll('files').concat(form.getAll('file'))
    .filter((v): v is File => v instanceof File)
  if (files.length) {
    logToFile(`上传开始 POST ${url}\n  ${files.length} 个文件：`
      + files.map(f => `${f.name}(${f.size}B)`).join(', '))
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: form, headers: { ...authHeadersFor(base), ...headers } })
  } catch (e) {
    // fetch 本身抛 = 连接层就没成（CORS 被拒、DNS、连接重置）。这类失败**没有状态码**，
    // 与"服务端回了错误码"是两回事，日志里必须分得开，否则会被当成后端故障去查。
    const msg = (e as Error)?.message || String(e)
    logToFile(`上传失败（连接层，没有 HTTP 响应）POST ${url}\n  ${msg}\n`
      + '  这类失败常见于 CORS 被拒 / 证书 / 连接被中断；请看 DevTools 的 Network 与 Console')
    throw e
  }
  if (!res.ok) throw await failure(res, url, 'POST')
  return res.json()
}

export interface Http {
  get:    <T>(path: string) => Promise<T>
  post:   <T>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>
  put:    <T>(path: string, body?: unknown) => Promise<T>
  delete: <T>(path: string, body?: unknown) => Promise<T>
  /** 上传一个文件。fields 是随文件同走 multipart 的普通表单字段（如 skill 导入时的归属）。 */
  upload: <T>(path: string, file: File, headers?: Record<string, string>, fields?: Record<string, string>) => Promise<T>
  uploadMany: <T>(path: string, files: File[], headers?: Record<string, string>) => Promise<T>
  /** 取二进制（skill 导出的 zip）。走同一条出口，才不会漏掉认证头。 */
  blob: (path: string) => Promise<Blob>
}

/** 绑定到某个后端地址的一组请求方法。地端与云端各持一份，互不影响。 */
export function createHttp(base: string): Http {
  return {
    get:    <T>(path: string) => request<T>(base, 'GET', path),
    post:   <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>(base, 'POST', path, body, headers),
    put:    <T>(path: string, body?: unknown) => request<T>(base, 'PUT', path, body),
    delete: <T>(path: string, body?: unknown) => request<T>(base, 'DELETE', path, body),
    blob: async (path: string) => {
      const res = await fetch(`${base}${path}`, { headers: { ...authHeadersFor(base) } })
      if (!res.ok) throw toError(await res.json().catch(() => ({ message: res.statusText })), res.statusText, res.status)
      return res.blob()
    },
    upload: <T>(path: string, file: File, headers?: Record<string, string>, fields?: Record<string, string>) => {
      const form = new FormData()
      form.append('file', file)
      for (const [k, v] of Object.entries(fields || {})) form.append(k, v)
      return postForm<T>(base, path, form, headers)
    },
    uploadMany: <T>(path: string, files: File[], headers?: Record<string, string>) => {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      return postForm<T>(base, path, form, headers)
    },
  }
}

/** 地端后端。与会话无关的接口（LLM 账号、skill 市场、模板）都走它。 */
export const http = createHttp(LOCAL_BASE)

/** 按会话定址：该会话在哪个后端上，请求就发给谁。 */
export function httpFor(sessionId: string | null | undefined): Http {
  return createHttp(baseOf(sessionId))
}

/** 按后端定址：会话还不存在时用（如新建会话前浏览云端存储里的文件夹）。 */
export function httpForBackend(id: BackendId): Http {
  return createHttp(getBackend(id).base || LOCAL_BASE)
}
