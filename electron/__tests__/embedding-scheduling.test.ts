import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateEmbeddings } from '../embedding'
import { MainGenerationScheduler } from '../services/generation-scheduler'
import type { EmbeddingBatchObserver } from '../services/reference-embedding-dispatch-contract'

const model = { provider: 'custom', baseUrl: 'https://embedding.example/v1', apiKey: 'fictional-key', modelName: 'fictional-model' }
const policy = { global: 1, provider: 1, credential: 1, model: 1, project: 1,
  maxQueued: 8, maxQuarantined: 1, interactiveBurst: 1 }
type Context = { admission: MainGenerationScheduler; projectKey: string; lane: 'background';
  assertActive: () => void; signal?: AbortSignal; quarantineAfterMs?: number }
const scheduledGenerate = generateEmbeddings as unknown as (
  texts: string[], protocol: 'openai', configuredModel: typeof model, batchSize: number,
  assertActive: undefined, signal: AbortSignal | undefined, concurrency: number,
  observer: EmbeddingBatchObserver | undefined, scheduling: Context,
) => Promise<number[][]>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('embedding scheduling at physical batch dispatch', () => {
  it('waits for the shared broker before the synchronous receipt mark and fetch', async () => {
    const scheduler = new MainGenerationScheduler(policy, 16)
    const signal = new AbortController().signal
    const held = await scheduler.acquireEmbedding({ projectKey: 'other-runtime', configuration: { protocol: 'openai', model }, lane: 'background', signal })
    const events: string[] = []
    const observer: EmbeddingBatchObserver = { forBatch: () => ({ beforeDispatch: () => { events.push('mark') }, settled: () => { events.push('settled') } }) }
    const fetchMock = vi.fn(async () => { events.push('fetch'); return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })) })
    vi.stubGlobal('fetch', fetchMock)
    const result = scheduledGenerate(['fictional'], 'openai', model, 1, undefined, signal, 1, observer,
      { admission: scheduler, projectKey: 'runtime-a', lane: 'background', assertActive: () => {} })
    try {
      await vi.waitFor(() => expect(scheduler.getStats().queued).toBe(1))
      expect(events).toEqual([])
      held.finish()
      await expect(result).resolves.toEqual([[0.1, 0.2]])
      expect(events).toEqual(['mark', 'fetch', 'settled'])
      expect(scheduler.getStats().occupied).toBe(0)
    } finally { held.finish(); await result.catch(() => {}); scheduler.close() }
  })

  it('revalidates after waiting and never marks or dispatches a revoked batch', async () => {
    const scheduler = new MainGenerationScheduler(policy, 16)
    const signal = new AbortController().signal
    const held = await scheduler.acquireEmbedding({ projectKey: 'other-runtime', configuration: { protocol: 'openai', model }, lane: 'background', signal })
    const mark = vi.fn(), fetchMock = vi.fn()
    const observer: EmbeddingBatchObserver = { forBatch: () => ({ beforeDispatch: mark, settled: vi.fn() }) }
    vi.stubGlobal('fetch', fetchMock)
    let current = true
    const result = scheduledGenerate(['fictional'], 'openai', model, 1, undefined, signal, 1, observer,
      { admission: scheduler, projectKey: 'runtime-a', lane: 'background', assertActive: () => { if (!current) throw new Error('FICTIONAL_REVOKED') } })
      .then(() => null, error => error)
    try {
      await vi.waitFor(() => expect(scheduler.getStats().queued).toBe(1))
      current = false
      held.finish()
      expect(await result).toBeTruthy()
      expect(mark).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(scheduler.getStats().occupied).toBe(0)
    } finally { held.finish(); await result; scheduler.close() }
  })

  it('retains the physical permit after abort until the delayed response body finishes', async () => {
    const scheduler = new MainGenerationScheduler(policy, 16)
    const controller = new AbortController()
    const body = deferred<unknown>()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: () => body.promise }))
    vi.stubGlobal('fetch', fetchMock)
    const result = scheduledGenerate(['fictional'], 'openai', model, 1, undefined, controller.signal, 1, undefined,
      { admission: scheduler, projectKey: 'runtime-a', lane: 'background', assertActive: () => {}, signal: controller.signal, quarantineAfterMs: 60_000 })
      .then(() => null, error => error)
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      controller.abort()
      expect(scheduler.getStats().occupied).toBe(1)
    } finally {
      body.resolve({ data: [{ index: 0, embedding: [0.1, 0.2] }] })
      await result
      expect(scheduler.getStats().occupied).toBe(0)
      scheduler.close()
    }
  })
})
