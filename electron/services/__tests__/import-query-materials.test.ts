import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { ImportGenerationContext } from '../../../src/shared/import-generation'
import { getImportInferenceTopics } from '../../../src/shared/import-inference-materials'
import { importQueryContextFingerprint, type ImportQueryPlan, type ImportQueryReceipt, type ImportQueryTopic } from '../import-query-contract'
import type { ImportQueryRepository } from '../../repositories/import-query-repository'
import type { ReferenceImportResources } from '../../knowledge-base'
import { captureReferenceImportKnowledge, type ReferenceImportKnowledgeSnapshot } from '../reference-import-knowledge-source'
import { ImportQueryMaterialsService } from '../import-query-materials'
import { EmbeddingDispatchBarrierError } from '../reference-embedding-dispatch-contract'
import { withKnowledgeSourceGate } from '../knowledge-source-gate'

const knowledge = vi.hoisted(() => ({ capture: vi.fn(), verify: vi.fn() }))
const locator = vi.hoisted(() => ({ getProjectDataRoot: vi.fn(() => 'D:\\fictional\\project-data') }))
const sourceCapture = vi.mocked(captureReferenceImportKnowledge)

vi.mock('../../knowledge-base', () => ({
  captureReferenceImportKnowledgeSnapshot: knowledge.capture,
  verifyDurableReferenceImportKnowledgeSnapshot: knowledge.verify,
}))
vi.mock('../project-data-locator', () => locator)
vi.mock('../reference-import-knowledge-source')

const context = {
  slot: { runId: 'import-run-1', stage: 'global', batchId: 'batch-1' },
  manifestFingerprint: 'a'.repeat(64),
  totalChapters: 1,
  totalWords: 10,
  core: { writingLanguage: 'en-US' },
  prompts: {},
  chapters: [],
} as unknown as ImportGenerationContext

const snapshot = (query: string): ReferenceImportKnowledgeSnapshot => ({
  version: 1, state: 'stored', projectStorageRoot: 'C:\\fictional\\data', runtimeEpoch: 'epoch-1', query, topK: 5,
  storageState: 'absent', canonicalRevision: null, documentsRevision: null, tableRevisions: [], registryHash: null,
  results: [{ text: `hit:${query}`, score: 0.75, fileName: 'fictional.txt' }],
  items: [{ text: `hit:${query}`, score: 0.75, fileName: 'fictional.txt', chunkId: 'chunk-1', documentId: 'document-1',
    chunkIndex: 0, corpusKind: 'reference', contentHash: 'c'.repeat(64), documentChunkSetHash: 'd'.repeat(64),
    documentChunks: [{ chunkId: 'chunk-1', chunkIndex: 0, contentHash: 'c'.repeat(64) }] }],
})

function makePlan(binding?: ImportQueryPlan['binding']): ImportQueryPlan {
  const topics = getImportInferenceTopics('en-US')
  return {
    record: { import_root_run_id: 'import-run-1', generation_run_id: 'first-generation-run', root_action_id: 'root-action-1',
      manifest_fingerprint: 'a'.repeat(64), binding_json: null, binding_fingerprint: null, state: 'ready', created_at_ms: 1 },
    binding: binding ?? {
      version: 1, slot: { stage: 'global', batchId: 'batch-1', writingLanguage: 'en-US' },
      contextFingerprint: importQueryContextFingerprint(context), configurationFingerprint: 'b'.repeat(64),
      topics: topics.map(({ key, query, topK }) => ({ key, query, topK })),
    },
    topics: topics.map(({ key }) => ({ query_id: `id-${key}`, import_root_run_id: 'import-run-1', topic_key: key,
      state: 'completed', marked_at_ms: null, outcome_json: null, settled_at_ms: null, physical_closed_at_ms: null,
      receipt_json: null, receipt_fingerprint: null })),
  }
}

function resources(): ReferenceImportResources {
  return { database: {} as Database.Database, canonicalRoot: 'C:\\fictional\\project', databaseIdentity: {},
    executionEpoch: 'epoch-1', assertResources: vi.fn(), acquireWork: () => vi.fn() } as unknown as ReferenceImportResources
}

function makeQueries(plan: ImportQueryPlan, completed = false) {
  const receipts = new Map(plan.binding.topics.map(({ key, query }) => [key, completed
    ? { version: 1, state: 'available', snapshot: (({ projectStorageRoot: _root, runtimeEpoch: _epoch, ...durable }) => { void _root; void _epoch; return durable })(snapshot(query)) } as ImportQueryReceipt
    : null]))
  const queries = {
    get: vi.fn(() => completed ? plan : null),
    preflight: vi.fn(),
    prepare: vi.fn(({ binding }: { binding: ImportQueryPlan['binding'] }) => completed ? plan : { ...plan, binding }),
    readReceipt: vi.fn((_plan: ImportQueryPlan, key: ImportQueryTopic) => receipts.get(key) ?? null),
    openFlight: vi.fn((_plan: ImportQueryPlan, topic: string) => ({ queryId: `id-${topic}` })),
    beforeDispatch: vi.fn(),
    settle: vi.fn(),
    releasePhysical: vi.fn(),
    complete: vi.fn((_plan: ImportQueryPlan, key: string, receipt: ImportQueryReceipt) => {
      receipts.set(key as ImportQueryPlan['binding']['topics'][number]['key'], receipt)
      return receipt
    }),
  }
  return queries as unknown as ImportQueryRepository & typeof queries
}

const embeddingConfiguration = (concurrencyLimit = 1) => ({ modelId: 'fictional-model', protocol: 'openai' as const,
  model: { provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fictional-key', modelName: 'embed-test',
    embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50, concurrencyLimit } } })
let actualKnowledgeCapture: typeof import('../../knowledge-base')['captureReferenceImportKnowledgeSnapshot']

beforeAll(async () => {
  actualKnowledgeCapture = (await vi.importActual<typeof import('../../knowledge-base')>('../../knowledge-base'))
    .captureReferenceImportKnowledgeSnapshot
})

describe('ImportQueryMaterialsService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    knowledge.capture.mockReset()
    knowledge.verify.mockReset().mockResolvedValue(undefined)
    sourceCapture.mockReset()
    locator.getProjectDataRoot.mockReturnValue('D:\\fictional\\project-data')
  })

  it('runs fixed topics serially through the shared dispatch observer and stores durable receipts', async () => {
    const plan = makePlan()
    const queries = makeQueries(plan)
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    const releasePhysical = vi.fn()
    knowledge.capture.mockImplementation(async ({ query, observer }: { query: string; observer?: { forBatch(ordinal: number, count: number): { beforeDispatch(): void; settled(outcome: { kind: 'response_received'; httpStatus: number }): void } } }) => {
      const lifecycle = observer?.forBatch(0, 1)
      lifecycle?.beforeDispatch()
      lifecycle?.settled({ kind: 'response_received', httpStatus: 200 })
      return snapshot(query)
    })
    const service = new ImportQueryMaterialsService({
      database: {} as Database.Database, queries, resources, loadConfiguration: embeddingConfiguration,
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => permit) } as never, projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 },
      onPhysicalStart: vi.fn(() => releasePhysical),
    })

    const result = await service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

    expect(result.topics.map(topic => topic.key)).toEqual(['worldview', 'protagonist', 'conflict', 'style'])
    expect(knowledge.capture).toHaveBeenCalledTimes(4)
    expect(queries.beforeDispatch).toHaveBeenCalledTimes(4)
    expect(queries.settle).toHaveBeenCalledTimes(4)
    expect(queries.releasePhysical).toHaveBeenCalledTimes(4)
    expect(permit.finish).toHaveBeenCalledTimes(4)
    expect(releasePhysical).toHaveBeenCalledTimes(4)
    for (const [, , receipt] of queries.complete.mock.calls) {
      expect(receipt.state).toBe('available')
      if (receipt.state === 'available') {
        expect(receipt.snapshot).not.toHaveProperty('projectStorageRoot')
        expect(receipt.snapshot).not.toHaveProperty('runtimeEpoch')
      }
    }
  })

  it.each([1, 2, 4])('bounds topic workers at configured concurrency %i and assembles reverse completions in topic order', async limit => {
    const queries = makeQueries(makePlan())
    const topics = getImportInferenceTopics('en-US')
    const gates = new Map<string, () => void>()
    const started: string[] = []
    let draining = false
    let active = 0
    let peak = 0
    knowledge.capture.mockImplementation(({ query, observer }: { query: string; observer: { forBatch(ordinal: number, count: number): {
      beforeDispatch(): void; settled(outcome: { kind: 'response_received'; httpStatus: number }): void
    } } }) => {
      const lifecycle = observer.forBatch(0, 1)
      lifecycle.beforeDispatch()
      started.push(query)
      active += 1
      peak = Math.max(peak, active)
      return new Promise(resolve => {
        let released = false
        const release = () => {
          if (released) return
          released = true
          gates.delete(query)
          lifecycle.settled({ kind: 'response_received', httpStatus: 200 })
          active -= 1
          resolve(snapshot(query))
        }
        gates.set(query, release)
        if (draining) release()
      })
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(limit),
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => ({ finish: vi.fn(), quarantine: vi.fn(() => true) })) } as never,
        projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })
    const pending = service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })
    try {
      for (let offset = 0; offset < topics.length; offset += limit) {
        const expected = Math.min(limit, topics.length - offset)
        await vi.waitFor(() => expect(gates.size).toBe(expected))
        const wave = [...gates.entries()].reverse()
        for (const [, release] of wave) {
          release()
        }
      }
      const result = await pending

      expect(peak).toBe(limit)
      expect(result.topics.map(topic => topic.key)).toEqual(topics.map(topic => topic.key))
      expect(result.topics.map(topic => topic.results?.[0]?.text)).toEqual(topics.map(topic => `hit:${topic.query}`))
      expect(queries.beforeDispatch).toHaveBeenCalledTimes(4)
      expect(queries.releasePhysical).toHaveBeenCalledTimes(4)
    } finally {
      draining = true
      for (const release of [...gates.values()]) release()
      await pending.catch(() => {})
    }
  })

  it('stops queued admissions on the first observed hard barrier, drains marked peers, and preserves that error object', async () => {
    const queries = makeQueries(makePlan())
    const topics = getImportInferenceTopics('en-US')
    const primary = new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_RECEIPT_INVALID')
    const later = new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_PLAN_CONFLICT')
    let releaseFirst: (() => void) | undefined
    let firstReleased = false
    let acquireCount = 0
    let primaryObserved = false
    knowledge.capture.mockImplementation(({ query, observer }: { query: string; observer: { forBatch(ordinal: number, count: number): {
      beforeDispatch(): void; settled(outcome: { kind: 'response_received'; httpStatus: number }): void
    } } }) => {
      const lifecycle = observer.forBatch(0, 1)
      lifecycle.beforeDispatch()
      if (query === topics[0]?.query) return new Promise((_resolve, reject) => {
        releaseFirst = () => {
          if (firstReleased) return
          firstReleased = true
          lifecycle.settled({ kind: 'response_received', httpStatus: 200 })
          reject(later)
        }
      })
      if (query === topics[1]?.query) {
        primaryObserved = true
        lifecycle.settled({ kind: 'response_received', httpStatus: 200 })
        throw primary
      }
      throw new Error('unexpected queued topic dispatched')
    })
    const admission = vi.fn(({ signal }: { signal: AbortSignal }) => {
      acquireCount += 1
      if (acquireCount <= 2) return Promise.resolve({ finish: vi.fn(), quarantine: vi.fn(() => true) })
      return new Promise((_resolve, reject) => {
        const cancel = () => reject(new Error('queue cancelled'))
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      })
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(4),
      scheduling: { admission: { acquireEmbedding: admission } as never, projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })
    const controller = new AbortController()
    const pending = service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: controller.signal })

    try {
      await vi.waitFor(() => {
        expect(acquireCount).toBe(4)
        expect(releaseFirst).toBeTypeOf('function')
        expect(primaryObserved).toBe(true)
      })
      releaseFirst!()
      await expect(pending).rejects.toBe(primary)
      expect(queries.openFlight).toHaveBeenCalledTimes(2)
      expect(queries.beforeDispatch).toHaveBeenCalledTimes(2)
      expect(queries.settle).toHaveBeenCalledTimes(2)
      expect(queries.releasePhysical).toHaveBeenCalledTimes(2)
      expect(queries.complete).not.toHaveBeenCalled()
    } finally {
      controller.abort()
      releaseFirst?.()
      await pending.catch(() => {})
    }
  })

  it('keeps a later low-index commit fence from replacing an earlier high-index transport-unknown', async () => {
    const queries = makeQueries(makePlan())
    const topics = getImportInferenceTopics('en-US')
    let releaseLower: (() => void) | undefined
    let unknownError: unknown
    const derivedFence = new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
    const originalComplete = queries.complete.getMockImplementation()!
    queries.complete.mockImplementation((plan, key, receipt) => {
      if (unknownError && key === topics[0]?.key) throw derivedFence
      return originalComplete(plan, key, receipt)
    })
    knowledge.capture.mockImplementation(({ query, observer }: { query: string; observer: { forBatch(ordinal: number, count: number): {
      beforeDispatch(): void; settled(outcome: { kind: 'response_received'; httpStatus: number } | { kind: 'transport_unknown' }): void
    } } }) => {
      const lifecycle = observer.forBatch(0, 1)
      lifecycle.beforeDispatch()
      if (query === topics[0]?.query) return new Promise(resolve => {
        releaseLower = () => {
          lifecycle.settled({ kind: 'response_received', httpStatus: 200 })
          resolve(snapshot(query))
        }
      })
      try { lifecycle.settled({ kind: 'transport_unknown' }) }
      catch (error) { unknownError = error; throw error }
      return Promise.resolve(snapshot(query))
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(2),
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => ({ finish: vi.fn(), quarantine: vi.fn(() => true) })) } as never,
        projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })
    const pending = service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

    try {
      for (let attempt = 0; !unknownError && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
      expect(unknownError).toBeInstanceOf(EmbeddingDispatchBarrierError)
      releaseLower?.()
      await expect(pending).rejects.toBe(unknownError)
      expect(queries.settle).toHaveBeenCalledWith(expect.anything(), { kind: 'transport_unknown' })
      expect(queries.complete).toHaveBeenCalledTimes(1)
      expect(queries.releasePhysical).toHaveBeenCalledTimes(2)
      expect(derivedFence).not.toBe(unknownError)
    } finally {
      releaseLower?.()
      await pending.catch(() => {})
    }
  })

  it('does not dispatch queued topics or fall back to FTS after a real KB pre-dispatch barrier', async () => {
    const queries = makeQueries(makePlan())
    let acquireCount = 0
    queries.beforeDispatch = vi.fn(() => {
      throw new EmbeddingDispatchBarrierError('ROOT_BUDGET_EXHAUSTED')
    }) as typeof queries.beforeDispatch
    knowledge.capture.mockImplementation(actualKnowledgeCapture)
    sourceCapture.mockImplementation(async ({ query, runtimeEpoch }: { query: string; runtimeEpoch: string }) => ({
      ...snapshot(query), runtimeEpoch,
    }))
    const admission = vi.fn(({ signal }: { signal: AbortSignal }) => {
      acquireCount += 1
      if (acquireCount === 1) return Promise.resolve({ finish: vi.fn(), quarantine: vi.fn(() => true) })
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('queue cancelled')), { once: true }))
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[1,2]', { status: 200 })))
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(4),
      scheduling: { admission: { acquireEmbedding: admission } as never, projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })

    try {
      const pending = service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
        execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })
      for (let attempt = 0; attempt < 100 && acquireCount < 4; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
      await expect(pending).rejects.toThrow('ROOT_BUDGET_EXHAUSTED')

      expect(acquireCount).toBe(4)
      expect(queries.openFlight).toHaveBeenCalledTimes(1)
      expect(queries.beforeDispatch).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
      expect(sourceCapture).not.toHaveBeenCalled()
      expect(queries.settle).not.toHaveBeenCalled()
      expect(queries.complete).not.toHaveBeenCalled()
      expect(queries.releasePhysical).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps an opened peer prepared when a prior hard error stops it before the real KB observer mark', async () => {
    const queries = makeQueries(makePlan())
    const topics = getImportInferenceTopics('en-US')
    const primary = new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_RECEIPT_INVALID')
    let releaseLower!: () => void
    let topicCalls = 0
    knowledge.capture.mockImplementation(async (rawInput: unknown) => {
      const input = rawInput as Parameters<typeof actualKnowledgeCapture>[0]
      topicCalls += 1
      if (input.query === topics[0]?.query) {
        await new Promise<void>(resolve => { releaseLower = resolve })
        return actualKnowledgeCapture(input)
      }
      throw primary
    })
    sourceCapture.mockImplementation(async ({ query, runtimeEpoch }: { query: string; runtimeEpoch: string }) => ({
      ...snapshot(query), runtimeEpoch,
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[1,2]', { status: 200 })))
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(2),
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => ({ finish: vi.fn(), quarantine: vi.fn(() => true) })) } as never,
        projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })
    const pending = service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

    try {
      for (let attempt = 0; attempt < 100 && topicCalls < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
      expect(topicCalls).toBe(2)
      await new Promise(resolve => setTimeout(resolve, 0))
      releaseLower()
      await expect(pending).rejects.toBe(primary)

      expect(queries.openFlight).toHaveBeenCalledTimes(2)
      expect(queries.beforeDispatch).not.toHaveBeenCalled()
      expect(queries.settle).not.toHaveBeenCalled()
      expect(queries.releasePhysical).toHaveBeenCalledTimes(2)
      expect(fetch).not.toHaveBeenCalled()
      expect(sourceCapture).not.toHaveBeenCalled()
      expect(queries.complete).not.toHaveBeenCalled()
    } finally {
      releaseLower?.()
      await pending.catch(() => {})
      vi.unstubAllGlobals()
    }
  })

  it('externally cancels queued admissions but waits for every started topic to physically drain', async () => {
    const queries = makeQueries(makePlan())
    const controller = new AbortController()
    const cancellation = new EmbeddingDispatchBarrierError('GENERATION_ACTION_CANCELLED')
    const gates = new Map<string, () => void>()
    const topics = getImportInferenceTopics('en-US')
    let acquireCount = 0
    let pendingSettled = false
    knowledge.capture.mockImplementation(({ query, observer }: { query: string; observer: { forBatch(ordinal: number, count: number): {
      beforeDispatch(): void; settled(outcome: { kind: 'response_received'; httpStatus: number }): void
    } } }) => {
      const lifecycle = observer.forBatch(0, 1)
      lifecycle.beforeDispatch()
      return new Promise(resolve => gates.set(query, () => {
        lifecycle.settled({ kind: 'response_received', httpStatus: 200 })
        resolve(snapshot(query))
      }))
    })
    const admission = vi.fn(({ signal }: { signal: AbortSignal }) => {
      acquireCount += 1
      if (acquireCount <= 2) return Promise.resolve({ finish: vi.fn(), quarantine: vi.fn(() => true) })
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(cancellation), { once: true }))
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(2),
      scheduling: { admission: { acquireEmbedding: admission } as never, projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })
    const pending = service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: () => { if (controller.signal.aborted) throw cancellation }, signal: controller.signal })
    void pending.then(() => { pendingSettled = true }, () => { pendingSettled = true })

    try {
      for (let attempt = 0; attempt < 100 && gates.size < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
      expect(gates.size).toBe(2)
      expect([...gates.keys()]).toEqual(topics.slice(0, 2).map(topic => topic.query))
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(pendingSettled).toBe(false)
      expect(queries.releasePhysical).not.toHaveBeenCalled()

      gates.get(topics[1]!.query)?.()
      gates.get(topics[0]!.query)?.()
      await expect(pending).rejects.toBe(cancellation)
      expect(queries.releasePhysical).toHaveBeenCalledTimes(2)
      expect(queries.complete).not.toHaveBeenCalled()
    } finally {
      for (const release of gates.values()) release()
      await pending.catch(() => {})
    }
  })

  it('replays completed materials on a same-root retry without loading config or repeating search', async () => {
    const plan = makePlan()
    const queries = makeQueries(plan, true)
    const loadConfiguration = vi.fn(() => null)
    const reopenedResources = () => ({ ...resources(), canonicalRoot: 'D:\\fictional\\reopened', executionEpoch: 'epoch-2' })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources: reopenedResources,
      loadConfiguration, scheduling: undefined })

    const result = await service.prepare({ context, generationRunId: 'known-length-retry-run', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 2 }, assertActive: vi.fn(), signal: new AbortController().signal })

    expect(result.topics).toHaveLength(4)
    expect(loadConfiguration).not.toHaveBeenCalled()
    expect(knowledge.capture).not.toHaveBeenCalled()
    expect(knowledge.verify).toHaveBeenCalledTimes(4)
    expect(knowledge.verify.mock.calls[0]?.[0]).not.toHaveProperty('snapshot.projectStorageRoot')
    expect(knowledge.verify.mock.calls[0]?.[0]).not.toHaveProperty('snapshot.runtimeEpoch')
    expect(knowledge.verify.mock.calls[0]?.[0].resources.canonicalRoot).toBe('D:\\fictional\\reopened')
    expect(queries.readReceipt).toHaveBeenCalledTimes(4)
    expect(queries.prepare).toHaveBeenCalledWith(expect.objectContaining({ generationRunId: 'known-length-retry-run' }))
  })

  it('validates durable sources under the gate, then starts dispatch without awaiting its provider promise', async () => {
    const plan = makePlan()
    const queries = makeQueries(plan, true)
    const pending = new Promise<void>(() => {})
    let releaseWriter!: () => void
    const writer = withKnowledgeSourceGate('D:\\fictional\\project-data', () => new Promise<void>(resolve => { releaseWriter = resolve }))
    while (!releaseWriter) await Promise.resolve()
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => null, scheduling: undefined })

    const operation = vi.fn(() => ({ promise: pending }))
    const work = service.withSources({ context, rootActionId: 'root-action-1', assertActive: vi.fn() }, operation)
    await Promise.resolve()
    expect(operation).not.toHaveBeenCalled()
    releaseWriter()
    await writer
    const started = await work

    expect(knowledge.verify).toHaveBeenCalledTimes(4)
    expect(locator.getProjectDataRoot).toHaveBeenCalledWith('C:\\fictional\\project')
    expect(started.promise).toBe(pending)
  })

  it.each([1, 2])('records an unavailable topic and continues the remaining fixed topics at concurrency %i', async limit => {
    const plan = makePlan()
    const queries = makeQueries(plan)
    const topics = getImportInferenceTopics('en-US')
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    knowledge.capture.mockImplementation(async ({ query }: { query: string }) => {
      if (query === topics[0]?.query) throw new Error('REFERENCE_IMPORT_KNOWLEDGE_SEARCH_UNAVAILABLE')
      return snapshot(query)
    })
    const admission = vi.fn(async () => permit)
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(limit),
      scheduling: { admission: { acquireEmbedding: admission } as never, projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })

    const result = await service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

    expect(result.topics.map(topic => topic.results === null)).toEqual([true, false, false, false])
    expect(knowledge.capture).toHaveBeenCalledTimes(4)
    expect(queries.complete.mock.calls.find(([, key]) => key === topics[0]?.key)?.[2]).toEqual({ version: 1, state: 'unavailable' })
    expect(admission).toHaveBeenCalledTimes(4)
    expect(queries.openFlight).toHaveBeenCalledTimes(4)
    expect(queries.releasePhysical).toHaveBeenCalledTimes(4)
    expect(permit.finish).toHaveBeenCalledTimes(4)
  })

  it('keeps a known HTTP embedding failure on the existing FTS-result path', async () => {
    const queries = makeQueries(makePlan())
    knowledge.capture.mockImplementation(async ({ query, observer }: { query: string; observer: { forBatch(ordinal: number, count: number): {
      beforeDispatch(): void; settled(outcome: { kind: 'http_failed'; httpStatus: number }): void
    } } }) => {
      const lifecycle = observer.forBatch(0, 1)
      lifecycle.beforeDispatch()
      lifecycle.settled({ kind: 'http_failed', httpStatus: 429 })
      // The KB boundary converts this known embedding failure to its existing FTS search.
      return snapshot(query)
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: embeddingConfiguration,
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => ({ finish: vi.fn(), quarantine: vi.fn(() => true) })) } as never,
        projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })

    const result = await service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

    expect(result.topics.every(topic => topic.results?.[0]?.text.startsWith('hit:'))).toBe(true)
    expect(queries.settle).toHaveBeenCalledWith(expect.anything(), { kind: 'http_failed', httpStatus: 429 })
    expect(queries.complete).toHaveBeenCalledTimes(4)
  })

  it.each([1, 2])('uses the actual KB observer and preserves its known-HTTP FTS fallback at concurrency %i', async limit => {
    const queries = makeQueries(makePlan())
    knowledge.capture.mockImplementation(actualKnowledgeCapture)
    sourceCapture.mockImplementation(async ({ query, runtimeEpoch }: { query: string; runtimeEpoch: string }) => ({
      ...snapshot(query), runtimeEpoch,
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"fictional"}', { status: 429 })))
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => embeddingConfiguration(limit),
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => ({ finish: vi.fn(), quarantine: vi.fn(() => true) })) } as never,
        projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })

    try {
      const result = await service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
        execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

      expect(result.topics.every(topic => topic.results?.[0]?.text.startsWith('hit:'))).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(queries.settle).toHaveBeenCalledTimes(4)
      expect(queries.settle).toHaveBeenCalledWith(expect.anything(), { kind: 'http_failed', httpStatus: 429 })
      expect(sourceCapture).toHaveBeenCalledTimes(4)
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps revoked authority and shared-budget rejection as hard barriers', async () => {
    const contextQueries = makeQueries(makePlan())
    const contextService = new ImportQueryMaterialsService({ database: {} as Database.Database, queries: contextQueries, resources,
      loadConfiguration: () => null, scheduling: undefined })
    for (const code of ['GENERATION_ACTION_CANCELLED', 'KNOWLEDGE_BASE_REFERENCE_GRANT_REVOKED']) {
      const revoked = () => { throw new Error(code) }
      await expect(contextService.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
        execution: { owner: 'owner-1', epoch: 1 }, assertActive: revoked, signal: new AbortController().signal })).rejects.toThrow(code)
    }
    expect(knowledge.capture).not.toHaveBeenCalled()

    const plan = makePlan()
    const queries = makeQueries(plan)
    queries.beforeDispatch = vi.fn(() => { throw new Error('ROOT_BUDGET_EXHAUSTED') }) as typeof queries.beforeDispatch
    knowledge.capture.mockImplementation(async ({ observer }: { observer: { forBatch(ordinal: number, count: number): { beforeDispatch(): void } } }) => {
      observer.forBatch(0, 1).beforeDispatch()
      return snapshot('unreachable')
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: embeddingConfiguration,
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => ({ finish: vi.fn(), quarantine: vi.fn(() => true) })) } as never,
        projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })
    await expect(service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })).rejects.toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(queries.complete).not.toHaveBeenCalled()
  })

  it('records transport-unknown and releases only after the fetch closes, without FTS fallback', async () => {
    const queries = makeQueries(makePlan())
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    knowledge.capture.mockImplementation(async ({ observer }: { observer: { forBatch(ordinal: number, count: number): {
      beforeDispatch(): void; settled(outcome: { kind: 'transport_unknown' }): void
    } } }) => {
      const lifecycle = observer.forBatch(0, 1)
      lifecycle.beforeDispatch()
      lifecycle.settled({ kind: 'transport_unknown' })
      throw new Error('network failed')
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: embeddingConfiguration,
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => permit) } as never, projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })

    await expect(service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal }))
      .rejects.toThrow('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
    expect(queries.settle).toHaveBeenCalledWith(expect.anything(), { kind: 'transport_unknown' })
    expect(queries.releasePhysical).toHaveBeenCalledTimes(1)
    expect(permit.finish).toHaveBeenCalledTimes(1)
    expect(queries.complete).not.toHaveBeenCalled()
  })

  it('quarantines a still-open scheduler permit after its grace period and drains it on real close', async () => {
    vi.useFakeTimers()
    let releaseFirstFetch: (() => void) | undefined
    let pending: Promise<unknown> | undefined
    let firstFetchClosed = false
    try {
      const queries = makeQueries(makePlan())
      const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
      const controller = new AbortController()
      const releaseOwner = vi.fn()
      let callCount = 0
      knowledge.capture.mockImplementation(({ query, observer }: { query: string; observer: { forBatch(ordinal: number, count: number): {
        beforeDispatch(): void; settled(outcome: { kind: 'response_received'; httpStatus: number }): void
      } } }) => {
        const lifecycle = observer.forBatch(0, 1)
        lifecycle.beforeDispatch()
        callCount++
        if (callCount === 1) return new Promise(resolve => {
          releaseFirstFetch = () => {
            if (firstFetchClosed) return
            firstFetchClosed = true
            lifecycle.settled({ kind: 'response_received', httpStatus: 200 })
            resolve(snapshot(query))
          }
        })
        lifecycle.settled({ kind: 'response_received', httpStatus: 200 })
        return Promise.resolve(snapshot(query))
      })
      const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
        loadConfiguration: embeddingConfiguration,
        scheduling: { admission: { acquireEmbedding: vi.fn(async () => permit) } as never, projectKey: 'project-1', lane: 'background', quarantineAfterMs: 10 },
        onPhysicalStart: () => releaseOwner })
      pending = service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
        execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: controller.signal })
      while (!releaseFirstFetch) await Promise.resolve()

      await vi.advanceTimersByTimeAsync(20)
      expect(permit.quarantine).not.toHaveBeenCalled()
      controller.abort()
      await vi.advanceTimersByTimeAsync(10)
      expect(permit.quarantine).toHaveBeenCalledTimes(1)
      expect(queries.releasePhysical).not.toHaveBeenCalled()
      expect(permit.finish).not.toHaveBeenCalled()
      expect(releaseOwner).not.toHaveBeenCalled()

      releaseFirstFetch()
      await pending
      expect(queries.releasePhysical).toHaveBeenCalledTimes(4)
      expect(permit.finish).toHaveBeenCalledTimes(4)
      expect(releaseOwner).toHaveBeenCalledTimes(4)
    } finally {
      releaseFirstFetch?.()
      await pending?.catch(() => {})
      vi.useRealTimers()
    }
  })
})
