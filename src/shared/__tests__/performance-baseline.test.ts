import { expect, it } from 'vitest'
import {
  createPerformanceBaseline,
  computeCreationCostAttribution,
  evaluateCandidateTargets,
  isNetworkWaitingVsUiFreeze,
  PERFORMANCE_METRICS,
  type PerformanceMetric,
} from '../performance-baseline'

it('retains cancellation counts and compressed archive bytes as distinct import metrics', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('import.inspect.cancelled', 1)
  baseline.record('import.read.archive_bytes', 200)
  baseline.record('import.read.utf8_bytes', 800)
  expect(baseline.snapshot().metrics['import.inspect.cancelled']?.sum).toBe(1)
  expect(baseline.snapshot().metrics['import.read.archive_bytes']?.sum).toBe(200)
  expect(baseline.snapshot().metrics['import.read.utf8_bytes']?.sum).toBe(800)
})

it('distinguishes logical dispatch from transport requests and rejects the misleading old metric', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('generation.dispatch.calls', 1)
  baseline.record('transport.sessions', 2)
  baseline.record('transport.requests', 1)
  baseline.record('generation.physical_requests' as PerformanceMetric, 1)
  expect(Object.keys(baseline.snapshot().metrics)).toEqual(['generation.dispatch.calls', 'transport.sessions', 'transport.requests'])
})

it('summarizes the full denominator with explicitly bounded approximate quantiles', () => {
  const baseline = createPerformanceBaseline()
  for (let value = 1; value <= 1000; value++) baseline.record('source.read.ms', value)
  expect(baseline.snapshot().metrics['source.read.ms']).toEqual({ count: 1000, sum: 500500, min: 1, max: 1000, p50UpperBound: 512, p95UpperBound: 1000 })
})

it('retains only fixed names and numeric summaries, regardless of event volume', () => {
  const baseline = createPerformanceBaseline()
  for (let index = 0; index < 10000; index++) {
    baseline.record('transport.visible.events', 1)
    baseline.record(`private-path-and-key-${index}` as PerformanceMetric, 1)
  }
  for (const invalid of [NaN, Infinity, -Infinity, -1]) baseline.record('source.read.ms', invalid)
  expect(Object.keys(baseline.snapshot().metrics)).toEqual(['transport.visible.events'])
  expect(baseline.snapshot().metrics['transport.visible.events']?.count).toBe(10000)
  expect(JSON.stringify(baseline.snapshot())).not.toContain('private-path-and-key')
  expect(Object.keys(baseline.snapshot().metrics).length).toBeLessThanOrEqual(PERFORMANCE_METRICS.length)
})

it('returns detached immutable snapshots and preserves zero observations', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('source.read.ms', 0)
  const first = baseline.snapshot()
  baseline.record('source.read.ms', 2)
  expect(first.metrics['source.read.ms']?.count).toBe(1)
  expect(Object.isFrozen(first.metrics['source.read.ms'])).toBe(true)
  expect(baseline.snapshot().metrics['source.read.ms']).toEqual({ count: 2, sum: 2, min: 0, max: 2, p50UpperBound: 0, p95UpperBound: 2 })
})

it('reports overlapping parent and child measurements separately with provenance', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('import.inspect.ms', 100)
  baseline.record('import.read.ms', 20)
  baseline.record('import.read.utf8_bytes', 5000)
  baseline.record('source.capture.ms', 50)
  baseline.record('source.read.ms', 15)
  baseline.record('source.select.ms', 5)
  baseline.record('source.validate.ms', 3)
  baseline.record('renderer.snapshot.queue_ms', 5)
  baseline.record('generation.provider.ms', 1200)
  baseline.record('transport.first_response.ms', 400)
  baseline.record('transport.first_response.ms', 600)
  baseline.record('transport.first_visible.ms', 650)
  baseline.record('transport.requests', 1)
  baseline.record('transport.visible.events', 12)
  baseline.record('generation.visible.events', 11)
  baseline.record('transport.reasoning.events', 5)
  baseline.record('generation.reasoning.events', 4)
  baseline.record('generation.pending', 1)
  baseline.record('generation.pending', 0)
  baseline.record('generation.usage.total_tokens', 450)
  baseline.record('import.parse.ms', 30)
  baseline.record('import.save.ms', 45)
  baseline.record('generation.snapshot.ms', 8)

  const snapshot = baseline.snapshot()
  const attribution = computeCreationCostAttribution(snapshot, {
    corpusHash: 'abc123corpus',
    sampleChapters: 100,
    sampleBooks: 1,
    sourceSha: 'deadbeef',
    environment: 'Windows x64 test',
    attempted: 1,
    failed: 0,
  })

  expect(snapshot.schemaVersion).toBe(1)
  expect(attribution.schemaVersion).toBe(2)
  expect(attribution.localPreparation).toMatchObject({ inspectMs: 100, importReadMs: 20, sourceCaptureMs: 50,
    sourceReadMs: 15, sourceSelectMs: 5, sourceValidateMs: 3, importReadUtf8Bytes: 5000 })
  expect(attribution.localPreparation).not.toHaveProperty('elapsedMs')
  expect(attribution.queueWait.snapshotQueueMs).toBe(5)
  expect(attribution.queueWait.pendingSamples).toMatchObject({ count: 2, sum: 1, min: 0, max: 1 })
  expect(attribution.queueWait).not.toHaveProperty('pendingCount')
  expect(attribution.modelExecution.providerMs).toBe(1200)
  expect(attribution.modelExecution.firstResponseMinMs).toBe(400)
  expect(attribution.modelExecution.firstVisibleMinMs).toBe(650)
  expect(attribution.modelExecution).toMatchObject({ transportVisibleEvents: 12, generationVisibleEvents: 11,
    transportReasoningEvents: 5, generationReasoningEvents: 4 })
  expect(attribution.modelExecution).not.toHaveProperty('visibleEvents')
  expect(attribution.modelExecution.totalTokens).toBe(450)
  expect(attribution.parsingComputation.parseMs).toBe(30)
  expect(attribution.persistenceSave.saveMs).toBe(45)
  expect(attribution.persistenceSave.snapshotMs).toBe(8)
  expect(attribution.provenance.corpusHash).toBe('abc123corpus')
  expect(attribution.provenance.sampleChapters).toBe(100)
  expect(attribution.provenance.failed).toBe(0)
  expect(attribution.provenance.multiBookStatus).toBeUndefined()
  expect(Object.isFrozen(attribution)).toBe(true)
})

it('distinguishes missing observations from explicitly recorded zero', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('transport.requests', 0)
  baseline.record('generation.pending', 0)
  const attribution = computeCreationCostAttribution(baseline.snapshot(), { failed: 0, sampleBooks: 0 })
  expect(attribution.modelExecution.physicalRequests).toBe(0)
  expect(attribution.modelExecution.http429Count).toBeNull()
  expect(attribution.queueWait.pendingSamples).toMatchObject({ count: 1, min: 0, max: 0 })
  expect(attribution.localPreparation.inspectCalls).toBeNull()
  expect(attribution.provenance).toMatchObject({ failed: 0, sampleBooks: 0 })
  const missing = computeCreationCostAttribution(createPerformanceBaseline().snapshot())
  expect(missing.provenance.failed).toBeUndefined()
  expect(missing.provenance.sampleBooks).toBeUndefined()
  expect(missing.provenance.multiBookStatus).toBeUndefined()
  expect(missing.queueWait.pendingSamples).toBeNull()
})

it.each([
  ['completed', 'transport.completed'],
  ['rate limited', 'transport.http_429'],
  ['failed', 'transport.failed'],
  ['cancelled', 'transport.cancelled'],
  ['reasoning only', 'transport.reasoning.events'],
] as const)('does not infer live network or UI state from %s aggregate counters', (_scenario, metric) => {
  const baseline = createPerformanceBaseline()
  baseline.record('transport.requests', 1)
  baseline.record(metric, 1)
  const snapshot = baseline.snapshot()
  expect(snapshot.metrics[metric]?.sum).toBe(1)
  expect(computeCreationCostAttribution(snapshot).modelExecution.physicalRequests).toBe(1)
  expect(isNetworkWaitingVsUiFreeze()).toMatchObject({ isNetworkWaiting: null, isUiFrozen: null })
})

it('does not classify accumulated short queue waits as an event-loop stall', () => {
  const baseline = createPerformanceBaseline()
  for (let i = 0; i < 10; i++) baseline.record('renderer.snapshot.queue_ms', 60)
  const attribution = computeCreationCostAttribution(baseline.snapshot())
  expect(attribution.queueWait.snapshotQueueMs).toBe(600)
  expect(isNetworkWaitingVsUiFreeze()).toMatchObject({ isNetworkWaiting: null, isUiFrozen: null })
})

it.each([
  ['missing', null, null],
  ['short', 40, 120],
  ['long', 150, 850],
] as const)('reports %s snapshot samples without claiming the candidate targets', (_scenario, processing, queue) => {
  const baseline = createPerformanceBaseline()
  if (processing !== null) baseline.record('renderer.snapshot.processing_ms', processing)
  if (queue !== null) baseline.record('renderer.snapshot.queue_ms', queue)
  const evaluation = evaluateCandidateTargets(baseline.snapshot())
  expect(evaluation).toMatchObject({ p95CandidateTargetMs: 100, mainThreadCandidateTargetMs: 500,
    isHardThreshold: false, isCandidateTargetMet: null,
    observations: { rendererSnapshotProcessingP95UpperBound: processing, rendererSnapshotQueueP95UpperBound: queue } })
})
