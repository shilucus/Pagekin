import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
import type { PerformanceBaselineSnapshot, PerformanceMetric } from '../../../src/shared/performance-baseline'
import type { ImportGenerationSlot } from '../../../src/shared/import-generation'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { GenerationRunRepository, textHash, type OpenGenerationRunRequest } from '../../repositories/generation-run-repository'
import { StreamTransportDiagnostics } from '../../llm/transport-diagnostics'
import { OpenAIProvider } from '../../llm/openai-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { captureImportGenerationContext } from '../import-generation-source'
import { createGenerationRunService } from '../generation-run-service'
import { measurePerformanceOperation, performanceStarted, readPerformanceDiagnostics, recordPerformanceComputedMetric, recordPerformanceCount, recordPerformanceTextBytes } from '../performance-diagnostics'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

const total = (snapshot: PerformanceBaselineSnapshot, name: PerformanceMetric) => snapshot.metrics[name]?.sum ?? 0
const delta = (before: PerformanceBaselineSnapshot, name: PerformanceMetric) => total(readPerformanceDiagnostics(), name) - total(before, name)

it('is disabled without the explicit environment flag and does not evaluate samples', () => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '')
  const before = readPerformanceDiagnostics()
  const globalBefore = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('pagekin.performance-baseline'))
  const sample = vi.fn(() => 1)
  recordPerformanceComputedMetric('source.read.ms', sample)
  recordPerformanceTextBytes('source.read.utf8_bytes', 'private-input')
  recordPerformanceCount('source.capture.calls')
  expect(performanceStarted()).toBeNull()
  expect(sample).not.toHaveBeenCalled()
  expect(readPerformanceDiagnostics()).toEqual(before)
  expect(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('pagekin.performance-baseline'))).toEqual(globalBefore)
})

it('exposes only an immutable numeric snapshot and ignores sample or clock failure', () => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '1')
  const before = readPerformanceDiagnostics()
  recordPerformanceCount('source.capture.calls')
  recordPerformanceComputedMetric('source.read.ms', () => { throw new Error('private-provider-body-and-key') })
  const error = new Error('original-operation-error')
  vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('clock-failure') })
  expect(measurePerformanceOperation('source.read.ms', () => 7)).toBe(7)
  expect(() => measurePerformanceOperation('source.read.ms', () => { throw error })).toThrow(error)
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('pagekin.performance-baseline'))!
  expect(descriptor.writable).toBe(false)
  const snapshot = (descriptor.value as () => PerformanceBaselineSnapshot)()
  expect(Object.isFrozen(snapshot.metrics)).toBe(true)
  expect(delta(before, 'source.capture.calls')).toBe(1)
  expect(JSON.stringify(snapshot)).not.toMatch(/private|provider-body|clock-failure|original-operation/)
})

it('separates headers, first response, reasoning and visible output without changing durable diagnostics', async () => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '1')
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const before = readPerformanceDiagnostics()
  const notifications: unknown[] = []
  const transport = new StreamTransportDiagnostics(value => notifications.push(value))
  now = 20
  await transport.response(Promise.resolve(new Response('synthetic')))
  now = 40
  await transport.read(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } }).getReader())
  now = 60
  transport.output('reasoningEvents')
  now = 90
  transport.output('visibleEvents')
  now = 100
  transport.output('visibleEvents')
  transport.completed()
  expect(delta(before, 'transport.headers.ms')).toBe(20)
  expect(delta(before, 'transport.first_response.ms')).toBe(40)
  expect(delta(before, 'transport.first_reasoning.ms')).toBe(60)
  expect(delta(before, 'transport.first_visible.ms')).toBe(90)
  expect(delta(before, 'transport.visible.events')).toBe(2)
  expect(notifications.at(-1)).not.toHaveProperty('firstVisibleMs')
  expect(notifications.at(-1)).not.toHaveProperty('firstReasoningMs')
})

it('separates diagnostic sessions from requests while retaining 429, cancellation and failure', async () => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '1')
  const before = readPerformanceDiagnostics()
  const failed = new StreamTransportDiagnostics()
  await failed.response(Promise.resolve(new Response(null, { status: 429 })))
  failed.fail('FIXTURE_REJECTED')
  new StreamTransportDiagnostics().interrupted(new Error('private-raw-provider-error'), true)
  expect(delta(before, 'transport.sessions')).toBe(2)
  expect(delta(before, 'transport.requests')).toBe(1)
  expect(delta(before, 'transport.http_429')).toBe(1)
  expect(delta(before, 'transport.failed')).toBe(1)
  expect(delta(before, 'transport.cancelled')).toBe(1)
  expect(JSON.stringify(readPerformanceDiagnostics())).not.toContain('private-raw-provider-error')
})

it.each(['url', 'body'] as const)('does not count a transport request when %s construction fails before fetch', async kind => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '1')
  const before = readPerformanceDiagnostics()
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('FIXTURE_FETCH_MUST_NOT_RUN'))
  const model: ModelProfile = { id: 'synthetic', name: 'synthetic', provider: 'custom', protocol: 'openai', modelName: 'synthetic',
    apiKey: 'synthetic', baseUrl: kind === 'url' ? 'not-a-url' : 'https://example.invalid/v1', temperature: 0.7, maxTokens: 100, purposes: ['generation'] }
  const message = { role: 'user', content: 'synthetic' }
  if (kind === 'body') Object.defineProperty(message, 'toJSON', { value: () => { throw new Error('FIXTURE_BODY_INVALID') } })
  const onError = vi.fn()
  await new OpenAIProvider().generateStream(model, [message], { temperature: 0.7, maxTokens: 100,
    signal: new AbortController().signal, onChunk: vi.fn(), onDone: vi.fn(), onError })
  expect(onError).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
  expect(delta(before, 'transport.sessions')).toBe(1)
  expect(delta(before, 'transport.requests')).toBe(0)
})

it('does not count a request for cancellation before a request promise is supplied', () => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '1')
  const before = readPerformanceDiagnostics()
  const transport = new StreamTransportDiagnostics()
  transport.interrupted(new DOMException('synthetic', 'AbortError'), true)
  expect(delta(before, 'transport.sessions')).toBe(1)
  expect(delta(before, 'transport.requests')).toBe(0)
  expect(delta(before, 'transport.cancelled')).toBe(1)
})

function sourceFixture(chapterCount: number) {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE import_runs(id TEXT PRIMARY KEY, manifest_fingerprint TEXT, manifest_chapter_count INTEGER, manifest_word_count INTEGER);
    CREATE TABLE import_run_chapters(run_id TEXT, chapter_number INTEGER, title TEXT, content_snapshot TEXT, content_fingerprint TEXT);
    CREATE TABLE project_core(id TEXT PRIMARY KEY, project_name TEXT, writing_language TEXT);
    INSERT INTO project_core VALUES('main','synthetic','en-US');`)
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const content = `Synthetic harbor chapter ${index + 1}. A fictional cartographer follows a lantern.\n`.repeat(32)
    return { number: index + 1, title: `Synthetic chapter ${index + 1}`, content, contentFingerprint: textHash(content) }
  })
  const hash = createHash('sha256')
  for (const chapter of chapters) hash.update(chapter.content)
  const corpusHash = hash.digest('hex')
  db.prepare('INSERT INTO import_runs VALUES(?,?,?,?)').run('synthetic-run', corpusHash, chapterCount, chapterCount * 32)
  const insert = db.prepare('INSERT INTO import_run_chapters VALUES(?,?,?,?,?)')
  db.transaction(() => { for (const chapter of chapters) insert.run('synthetic-run', chapter.number, chapter.title, chapter.content, chapter.contentFingerprint) })()
  return { db, chapters, corpusHash, corpusBytes: chapters.reduce((sum, chapter) => sum + Buffer.byteLength(chapter.content), 0) }
}

it.each([10, 100, 1000])('PERF-001 samples %i fixed fictional chapters through authoritative source capture', chapterCount => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '1')
  const fixture = sourceFixture(chapterCount)
  const before = readPerformanceDiagnostics()
  let attempted = 0, failed = 0
  const capture = (slot: ImportGenerationSlot) => {
    attempted++
    try { return captureImportGenerationContext(fixture.db, slot) }
    catch (error) { failed++; throw error }
  }
  try {
    for (const temperature of ['cold', 'warm'] as const) {
      const reportBefore = readPerformanceDiagnostics()
      const global = capture({ runId: 'synthetic-run', stage: 'global', batchId: 'done' })
      const style = capture({ runId: 'synthetic-run', stage: 'style', batchId: 'done' })
      const batch = fixture.chapters.slice(0, 3)
      const blueprints = capture({ runId: 'synthetic-run', stage: 'blueprints', batchId: createImportRunChapterBatchCheckpointId(batch) })
      expect(global.chapters.map(chapter => chapter.number)).toEqual([1, chapterCount])
      expect(style.chapters.map(chapter => chapter.number)).toEqual([1, 2, 3, chapterCount - 1, chapterCount])
      expect(blueprints.chapters.map(chapter => chapter.number)).toEqual([1, 2, 3])
      expect(delta(reportBefore, 'source.read.utf8_bytes')).toBe(fixture.corpusBytes * 3)
      console.info('PERF-001', JSON.stringify({ schemaVersion: 1, kind: 'authoritative-source-microbenchmark', chapterCount, books: 1,
        temperature, corpusHash: fixture.corpusHash, platform: process.platform, arch: process.arch, node: process.version,
        attempted: 3, failed: 0, readUtf8Bytes: delta(reportBefore, 'source.read.utf8_bytes'),
        selectedUtf8Bytes: delta(reportBefore, 'source.selected.utf8_bytes'), elapsedMs: delta(reportBefore, 'source.capture.ms'),
        multiBook: [{ books: 2, status: 'not_executed' }, { books: 4, status: 'not_executed' }],
        limitations: ['in-memory-sqlite', 'cold-means-first-capture-not-disk-cache', 'not-desktop-performance', 'no-real-model'] }))
    }
    fixture.db.prepare('UPDATE import_run_chapters SET content_fingerprint=? WHERE chapter_number=1').run('0'.repeat(64))
    expect(() => capture({ runId: 'synthetic-run', stage: 'global', batchId: 'done' })).toThrow('GENERATION_IMPORT_CONTENT_CHANGED')
    expect(delta(before, 'source.capture.calls')).toBe(7)
    expect(delta(before, 'source.capture.failed')).toBe(1)
    expect(delta(before, 'source.read.chapters')).toBe(chapterCount * 7)
    expect(JSON.stringify(readPerformanceDiagnostics())).not.toMatch(/Synthetic harbor|Synthetic chapter|synthetic-run/)
  } finally {
    console.info('PERF-001', JSON.stringify({ schemaVersion: 1, kind: 'authoritative-source-denominator', chapterCount,
      corpusHash: fixture.corpusHash, attempted, failed, failureCase: 'source-fingerprint-changed' }))
    fixture.db.close()
  }
})

it('counts logical generation dispatch, flushes and trusted usage without claiming mock HTTP requests', async () => {
  vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', '1')
  const db = new Database(':memory:')
  db.exec(M01_GENERATION_SQL)
  try {
    const hash = textHash('synthetic-frozen')
    const repository = new GenerationRunRepository(() => db)
    const open: OpenGenerationRunRequest = { projectId: 'synthetic-project', epoch: 'synthetic-epoch', operation: 'write', uiActionNonce: 'synthetic-click', frozenInputHash: hash,
      fingerprint: { chapterBriefHash: hash, authorGuidanceHash: hash, dependencyHash: hash, contextSnapshotHash: hash, templateHash: hash, skillSnapshotHash: hash, modelLeaseRevision: hash, policyHash: hash, outputContractHash: hash },
      contextSnapshotId: 'synthetic-context', sourceManifest: { kind: 'synthetic-frozen-sources' }, sourceRefs: [],
      budget: { maxPhysicalRequests: 2, maxTokenLiability: 1000, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } }
    const service = createGenerationRunService({ repository, dispatch: async (_request, options) => {
      options.onReasoning?.('private-synthetic-reasoning')
      options.onVisible({ kind: 'delta', text: 'x'.repeat(4096) })
      options.onVisible({ kind: 'delta', text: 'tail' })
      return { finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 20, reasoningTokens: 5, totalTokens: 30,
        accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true } }
    } })
    const run = service.open(open)
    const before = readPerformanceDiagnostics()
    const request = { runId: run.runId, invocationNonce: 'synthetic-call', requestHash: textHash('synthetic-call'), providerRequest: { prompt: 'private-synthetic-prompt' },
      reservedTokens: 200, requestedOutputTokens: 100, inputUpperBoundTokens: 90, reasoningUpperBoundTokens: 0,
      usagePolicy: { estimatorVersion: 'fixture-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true } }
    const receipt = await service.execute(request)
    await service.execute(request)
    expect(receipt.artifact?.text).toBe('x'.repeat(4096) + 'tail')
    expect(receipt.artifact?.revision).toBe(2)
    expect(delta(before, 'generation.execute.calls')).toBe(2)
    expect(delta(before, 'generation.dispatch.calls')).toBe(1)
    expect(delta(before, 'transport.requests')).toBe(0)
    expect(delta(before, 'generation.snapshot.calls')).toBe(2)
    expect(delta(before, 'generation.usage.total_tokens')).toBe(30)
    expect(delta(before, 'generation.reasoning.events')).toBe(1)
    const failedService = createGenerationRunService({ repository, dispatch: async () => { throw new Error('private-synthetic-provider-error') } })
    const failed = await failedService.execute({ ...request, invocationNonce: 'synthetic-failure', requestHash: textHash('synthetic-failure') })
    expect(failed.failureCode).toBe('GENERATION_PROVIDER_FAILED')
    expect(delta(before, 'generation.dispatch.calls')).toBe(2)
    expect(delta(before, 'transport.requests')).toBe(0)
    expect(delta(before, 'generation.usage.unknown')).toBe(1)
    expect(JSON.stringify(readPerformanceDiagnostics())).not.toMatch(/private-synthetic|synthetic-project|synthetic-call/)
  } finally { db.close() }
})
