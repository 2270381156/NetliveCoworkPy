/**
 * 应用内浏览器「取当前页面内容」的跨组件小桥。
 *
 * 抓取函数在 BrowserPanel（它持有 webview ref），而"响应后端请求"的逻辑在 useSessionSSE，
 * 两者无父子关系。用模块级注册表打通：BrowserPanel 挂载时 setWebviewExtractor(fn)，
 * SSE 收到 webview_content_request 时调 extractWebviewContent()。
 */

export interface WebviewContent {
  url: string
  title: string
  text: string
  headings: string[]
  links: { text: string; href: string }[]
}

type Extractor = () => Promise<WebviewContent | null>

let _extractor: Extractor | null = null

export function setWebviewExtractor(fn: Extractor | null): void {
  _extractor = fn
}

/** 取当前 webview 页面内容；无 BrowserPanel / 没开网页 → null。 */
export async function extractWebviewContent(): Promise<WebviewContent | null> {
  if (!_extractor) return null
  try { return await _extractor() } catch { return null }
}
