import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { ImportGenerationContext } from '../../../src/shared/import-generation'
import { getImportInferenceTopics } from '../../../src/shared/import-inference-materials'
import { importQueryContextFingerprint, type ImportQueryPlan, type ImportQueryReceipt, type ImportQueryTopic } from '../import-query-contract'
import type { ImportQueryRepository } from '../../repositories/import-query-repository'
import type { ReferenceImportResources } from '../../knowledge-base'
import type { ReferenceImportKnowledgeSnapshot } from '../reference-import-knowledge-source'
import { ImportQueryMaterialsService } from '../import-query-materials'
import { withKnowledgeSourceGate } from '../knowledge-source-gate'

const knowledge = vi.hoisted(() => ({ capture: vi.fn(), verify: vi.fn(), sourceCapture: vi.fn(), sourceVerify: vi.fn() }))
const locator = vi.hoisted(() => ({ getProjectDataRoot: vi.fn(() => 'D:\\fictional\\project-data') }))

vi.mock('../../knowledge-base', () => ({
  captureReferenceImportKnowledgeSnapshot: knowledge.capture,
  verifyDurableReferenceImportKnowledgeSnapshot: knowledge.verify,
}))
vi.mock('../project-data-locator', () => locator)
vi.mock('../reference-import-knowledge-source', () => ({
  captureReferenceImportKnowledge: knowledge.sourceCapture,
  verifyDurableReferenceImportKnowledge: knowledge.sourceVerify,
}))

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

const embeddingConfiguration = () => ({ modelId: 'fictional-model', protocol: 'openai' as const,
  model: { provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fictional-key', modelName: 'embed-test' } })
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
    knowledge.sourceCapture.mockReset()
    knowledge.sourceVerify.mockReset().mockResolvedValue(undefined)
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

  it('records an unavailable topic and continues the remaining fixed topics', async () => {
    const plan = makePlan()
    const queries = makeQueries(plan)
    knowledge.capture.mockImplementation(async ({ query }: { query: string }) => {
      if (knowledge.capture.mock.calls.length === 1) throw new Error('REFERENCE_IMPORT_KNOWLEDGE_SEARCH_UNAVAILABLE')
      return snapshot(query)
    })
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: () => null, scheduling: undefined })

    const result = await service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
      execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

    expect(result.topics.map(topic => topic.results === null)).toEqual([true, false, false, false])
    expect(knowledge.capture).toHaveBeenCalledTimes(4)
    expect(queries.complete.mock.calls[0]?.[2]).toEqual({ version: 1, state: 'unavailable' })
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

  it('uses the actual KB observer and preserves its known-HTTP FTS fallback', async () => {
    const queries = makeQueries(makePlan())
    knowledge.capture.mockImplementation(actualKnowledgeCapture)
    knowledge.sourceCapture.mockImplementation(async ({ query, runtimeEpoch }: { query: string; runtimeEpoch: string }) => ({
      ...snapshot(query), runtimeEpoch,
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"fictional"}', { status: 429 })))
    const service = new ImportQueryMaterialsService({ database: {} as Database.Database, queries, resources,
      loadConfiguration: embeddingConfiguration,
      scheduling: { admission: { acquireEmbedding: vi.fn(async () => ({ finish: vi.fn(), quarantine: vi.fn(() => true) })) } as never,
        projectKey: 'project-1', lane: 'background', quarantineAfterMs: 1000 } })

    try {
      const result = await service.prepare({ context, generationRunId: 'generation-run-2', rootActionId: 'root-action-1',
        execution: { owner: 'owner-1', epoch: 1 }, assertActive: vi.fn(), signal: new AbortController().signal })

      expect(result.topics.every(topic => topic.results?.[0]?.text.startsWith('hit:'))).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(queries.settle).toHaveBeenCalledTimes(4)
      expect(queries.settle).toHaveBeenCalledWith(expect.anything(), { kind: 'http_failed', httpStatus: 429 })
      expect(knowledge.sourceCapture).toHaveBeenCalledTimes(4)
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
