import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseInWorker, __setWorkerFactory, type WorkerLike } from './parseClient'
import type { WorkerOutMsg, ParseRequestMsg } from './protocol'

interface FakeWorker extends WorkerLike { sent: ParseRequestMsg[]; emit(m: WorkerOutMsg): void }

function makeFake(): FakeWorker {
  return {
    onmessage: null,
    onerror: null,
    sent: [],
    postMessage(m: unknown) { this.sent.push(m as ParseRequestMsg) },
    terminate() {},
    emit(m: WorkerOutMsg) { this.onmessage?.({ data: m } as MessageEvent<WorkerOutMsg>) },
  }
}

afterEach(() => __setWorkerFactory(null))

describe('parseInWorker', () => {
  it('resolves with the result data', async () => {
    let fake!: FakeWorker
    __setWorkerFactory(() => (fake = makeFake()))
    const p = parseInWorker('xlsx', new ArrayBuffer(8))
    const id = fake.sent[0].id
    fake.emit({ type: 'result', id, kind: 'xlsx', data: [{ name: 'S', rows: [] }] })
    await expect(p).resolves.toEqual([{ name: 'S', rows: [] }])
  })

  it('reports progress then resolves', async () => {
    let fake!: FakeWorker
    __setWorkerFactory(() => (fake = makeFake()))
    const onProgress = vi.fn()
    const p = parseInWorker('xlsx', new ArrayBuffer(8), { onProgress })
    const id = fake.sent[0].id
    fake.emit({ type: 'progress', id, progress: { phase: 'parsing' } })
    fake.emit({ type: 'result', id, kind: 'xlsx', data: [] })
    await p
    expect(onProgress).toHaveBeenCalledWith({ phase: 'parsing' })
  })

  it('rejects on error message', async () => {
    let fake!: FakeWorker
    __setWorkerFactory(() => (fake = makeFake()))
    const p = parseInWorker('xlsx', new ArrayBuffer(8))
    const id = fake.sent[0].id
    fake.emit({ type: 'error', id, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    __setWorkerFactory(() => makeFake())
    const ac = new AbortController()
    ac.abort()
    await expect(parseInWorker('xlsx', new ArrayBuffer(8), { signal: ac.signal }))
      .rejects.toThrow(/abort/i)
  })

  it('rejects all pending requests when the worker crashes', async () => {
    let fake!: FakeWorker
    __setWorkerFactory(() => (fake = makeFake()))
    const p1 = parseInWorker('xlsx', new ArrayBuffer(8))
    const p2 = parseInWorker('xlsx', new ArrayBuffer(8))
    fake.onerror?.({ message: 'kaboom', preventDefault() {} })
    await expect(p1).rejects.toThrow(/crash/i)
    await expect(p2).rejects.toThrow(/crash/i)
  })

  // PPTX no longer goes through the worker — it moved to the main thread in
  // the post-0.2.23 pivot so the parser could use native DOMParser. Only
  // 'xlsx' remains as a ParseKind; the typed-result test above for xlsx
  // covers ParseResultData<K> generics.
})
