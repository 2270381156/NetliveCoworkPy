import type {
  ParseKind, ParseProgress, ParseRequestMsg, ParseResultData, WorkerOutMsg,
} from './protocol'

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((ev: MessageEvent<WorkerOutMsg>) => void) | null
  onerror: ((ev: { message?: string; preventDefault?: () => void }) => void) | null
  terminate(): void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (p: ParseProgress) => void
  cleanup?: () => void
}

function defaultFactory(): WorkerLike {
  return new Worker(new URL('./fileParser.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}

let _factory: () => WorkerLike = defaultFactory
let _worker: WorkerLike | null = null
let _seq = 0
const _pending = new Map<string, Pending>()

// Test seam: swap the worker factory (pass null to restore the default and drop the worker).
export function __setWorkerFactory(f: (() => WorkerLike) | null): void {
  _factory = f ?? defaultFactory
  if (_worker) { _worker.terminate(); _worker = null }
  _pending.clear()
}

// Remove a request from the pending map and run its cleanup (e.g. detach the abort listener).
function settle(id: string): Pending | undefined {
  const p = _pending.get(id)
  if (!p) return undefined
  _pending.delete(id)
  p.cleanup?.()
  return p
}

function ensureWorker(): WorkerLike {
  if (_worker) return _worker
  const w = _factory()
  w.onmessage = (ev) => {
    const msg = ev.data
    if (msg.type === 'progress') { _pending.get(msg.id)?.onProgress?.(msg.progress); return }
    const p = settle(msg.id)
    if (!p) return
    if (msg.type === 'result') p.resolve(msg.data)
    else if (msg.type === 'error') p.reject(new Error(msg.error))
  }
  // If the worker thread crashes or fails to load, reject every pending request and
  // drop the singleton so the next call respawns a fresh worker. Without this, a
  // worker crash would leave callers' promises (and the UI) hanging forever.
  w.onerror = (ev) => {
    ev.preventDefault?.()
    _worker = null
    const err = new Error(`Parse worker crashed: ${ev?.message ?? 'unknown'}`)
    const pendings = [..._pending.values()]
    _pending.clear()
    for (const p of pendings) { p.cleanup?.(); p.reject(err) }
  }
  _worker = w
  return w
}

// NOTE: aborting only drops the client-side pending entry and rejects the promise;
// it does NOT stop work already running inside the worker. The current xlsx parser
// is synchronous so this is harmless today, but a future async parser (e.g. pptx in
// Phase 2) must implement worker-side cancellation if mid-job abort needs to free CPU.
export function parseInWorker<K extends ParseKind>(
  kind: K,
  buffer: ArrayBuffer,
  opts?: { onProgress?: (p: ParseProgress) => void; signal?: AbortSignal; options?: Record<string, unknown> },
): Promise<ParseResultData[K]> {
  return new Promise<ParseResultData[K]>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const id = `p${++_seq}`
    const w = ensureWorker()
    const signal = opts?.signal
    const onAbort = () => {
      const p = _pending.get(id)
      if (p) { _pending.delete(id); p.cleanup?.(); reject(new DOMException('Aborted', 'AbortError')) }
    }
    _pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: opts?.onProgress,
      cleanup: signal ? () => signal.removeEventListener('abort', onAbort) : undefined,
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    const req: ParseRequestMsg = { type: 'parse', id, kind, buffer, options: opts?.options ?? {} }
    w.postMessage(req, [buffer])
  })
}
