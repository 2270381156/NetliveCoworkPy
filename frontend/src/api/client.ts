import type { ApiError } from '@/types'

const BASE_URL = '/api/v1'

class ApiException extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiException'
    this.code = code
    this.status = status
  }
}

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })

  if (!res.ok) {
    if (res.status === 204) return undefined as T
    const err: ApiError = await res.json().catch(() => ({
      code: 'UNKNOWN',
      message: `HTTP ${res.status}`,
    }))
    throw new ApiException(err.code, err.message, res.status)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function uploadRequest<T>(path: string, formData: FormData): Promise<T> {
  // 不设 Content-Type，让浏览器自带 multipart boundary
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', body: formData })
  if (!res.ok) {
    const err: ApiError = await res.json().catch(() => ({
      code: 'UNKNOWN',
      message: `HTTP ${res.status}`,
    }))
    throw new ApiException(err.code, err.message, res.status)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const http = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T = void>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
  upload: <T>(path: string, formData: FormData) => uploadRequest<T>(path, formData),
}

export { ApiException }
