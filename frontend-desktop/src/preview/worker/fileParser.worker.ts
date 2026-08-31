import type { ParseRequestMsg, WorkerOutMsg } from './protocol'
import { parseXlsx, type XlsxParseOptions } from './parsers/xlsx'

// Minimal local view of the dedicated-worker global scope. Avoids pulling in the
// WebWorker lib (which conflicts with the DOM lib used app-wide).
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<ParseRequestMsg>) => void) | null
  postMessage(msg: WorkerOutMsg): void
}

ctx.onmessage = async (ev) => {
  const msg = ev.data
  if (msg?.type !== 'parse') return
  try {
    post({ type: 'progress', id: msg.id, progress: { phase: 'parsing' } })
    const data = await dispatch(msg)
    post({ type: 'result', id: msg.id, kind: msg.kind, data })
  } catch (e) {
    post({ type: 'error', id: msg.id, error: e instanceof Error ? e.message : String(e) })
  }
}

function post(m: WorkerOutMsg) { ctx.postMessage(m) }

async function dispatch(msg: ParseRequestMsg): Promise<unknown> {
  switch (msg.kind) {
    case 'xlsx': return parseXlsx(msg.buffer, (msg.options ?? {}) as XlsxParseOptions)
    default: {
      // Compile-time exhaustiveness: adding a ParseKind without a case here is a TS error.
      const _never: never = msg.kind
      throw new Error(`Unsupported parse kind: ${String(_never)}`)
    }
  }
}
