export const MAX_WEB_SOURCES = 32

export type WebSourceKind = 'fetch' | 'search'

export interface WebSource {
  url: string
  title: string
  domain: string
  kind: WebSourceKind
  provider?: string
  rank?: number
}

const MAX_URL_LENGTH = 4096
const MAX_TITLE_LENGTH = 200
const MAX_PROVIDER_LENGTH = 48
const MAX_INPUT_SOURCES = 64

// Control and bidirectional-control characters can make an untrusted title look
// like a different URL or UI label. React escapes markup; this additionally
// keeps visible text direction predictable.
const UNSAFE_TEXT_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g
const UNAVAILABLE_TITLE = /^(?:404(?:\s*[-:：]?\s*(?:not found|page not found|error))?|410(?:\s*[-:：]?\s*gone)?|not found|page not found|content not found|页面不存在|页面未找到|网页已删除|内容不存在|内容已失效|文章已删除|资源不存在|链接已失效)[!！。.]?$/i

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(UNSAFE_TEXT_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function isUnavailableTitle(value: string): boolean {
  const withoutPipeSuffix = value.replace(/\s*[|｜_]\s*[^|｜_]{1,80}$/, '').trim()
  if (UNAVAILABLE_TITLE.test(withoutPipeSuffix)) return true
  const dashSuffix = value.match(/^(page not found|页面不存在)\s+-\s+(.+)$/i)
  return Boolean(dashSuffix && !/(?:\bhow\b|\bwhy\b|\bfix\b|\bguide\b|解决|修复|含义|原因)/i.test(dashSuffix[2]))
}

function isPublicHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!hostname || hostname === 'localhost' || hostname === 'localhost.localdomain' ||
      hostname === 'ip6-localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) return false

  const ipv4 = hostname.split('.').map(Number)
  if (ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = ipv4
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)))
  }

  if (hostname.includes(':')) {
    return !(hostname === '::' || hostname === '::1' || hostname.startsWith('fc') ||
      hostname.startsWith('fd') || /^fe[89ab]/.test(hostname) || hostname.startsWith('::ffff:'))
  }
  return true
}

/** Parse untrusted `text_done.sources` into the small renderer contract. */
export function parseWebSources(value: unknown): WebSource[] {
  if (!Array.isArray(value)) return []

  const candidates: WebSource[] = []
  const indexByUrl = new Map<string, number>()

  for (const raw of value.slice(0, MAX_INPUT_SOURCES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const rawUrl = typeof record.url === 'string' ? record.url.trim() : ''
    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) continue

    let parsed: URL
    try { parsed = new URL(rawUrl) } catch { continue }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) continue
    parsed.hash = ''

    if (record.kind !== 'fetch' && record.kind !== 'search') continue
    const kind: WebSourceKind = record.kind

    const url = parsed.toString()
    if (url.length > MAX_URL_LENGTH) continue
    const domain = parsed.hostname.toLowerCase()
    if (!isPublicHostname(domain)) continue

    const title = cleanText(record.title, MAX_TITLE_LENGTH) || domain
    if (isUnavailableTitle(title)) continue

    const candidate: WebSource = {
      url,
      title,
      domain,
      kind,
      provider: cleanText(record.provider, MAX_PROVIDER_LENGTH) || undefined,
      rank: typeof record.rank === 'number' && Number.isSafeInteger(record.rank) && record.rank > 0
        ? record.rank
        : undefined,
    }

    const previousIndex = indexByUrl.get(url)
    if (previousIndex === undefined) {
      indexByUrl.set(url, candidates.length)
      candidates.push(candidate)
    } else {
      candidates[previousIndex] = candidate
    }
  }

  return candidates.slice(0, MAX_WEB_SOURCES)
}

/** Build the site's conventional favicon URL without using a third-party service. */
export function webSourceFaviconUrl(source: WebSource): string | null {
  const safe = parseWebSources([source])[0]
  if (!safe) return null
  try {
    return new URL('/favicon.ico', new URL(safe.url).origin).toString()
  } catch {
    return null
  }
}
