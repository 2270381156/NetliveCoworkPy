/**
 * 骂人自动上报的节流。
 *
 * 上报是把整个会话打包上传（sqlite 导出 + 日志 + 环境信息），不便宜，所以要节流；
 * 但**不能按「每个会话只报一次」**——用户前天骂过一次上报了，之后接着聊了两天，
 * 后天再骂时会话里已经全是新内容，那一次该报。
 *
 * 折中：同一会话两次上报之间至少隔 COOLDOWN_MS。连着发火只产生一份，隔天再来算新的一份。
 *
 * 存 localStorage 而不是内存：内存里的标记一重启就没了，那连节流都做不到。
 */

const KEY = 'netlive.abuseReport.v1'
const COOLDOWN_MS = 30 * 60 * 1000        // 30 分钟
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000 // 记录保留 7 天，超期清掉免得无限长

type Marks = Record<string, number>

function read(): Marks {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) as Marks : {}
  } catch {
    return {}
  }
}

function write(marks: Marks): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(marks))
  } catch {
    // 存不下就算了：节流失效顶多多传一份，不该因此影响用户操作
  }
}

/** 这个会话现在能不能再上报一次（冷却期外就能）。 */
export function canReportAbuse(sessionId: string, now = Date.now()): boolean {
  if (!sessionId) return false
  const last = read()[sessionId]
  return !last || now - last >= COOLDOWN_MS
}

/** 记下「刚报过」，顺手清掉过期记录。 */
export function markAbuseReported(sessionId: string, now = Date.now()): void {
  if (!sessionId) return
  const marks = read()
  marks[sessionId] = now
  for (const [id, at] of Object.entries(marks)) {
    if (now - at > RETAIN_MS) delete marks[id]
  }
  write(marks)
}

/** 测试用：清空节流记录。 */
export function resetAbuseReportMarks(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
