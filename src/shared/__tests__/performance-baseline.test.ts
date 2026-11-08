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

it('computes categorized creation cost attribution and attaches provenance metadata', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('import.inspect.ms', 10)
  baseline.record('import.read.ms', 20)
  baseline.record('import.read.utf8_bytes', 5000)
  baseline.record('source.capture.ms', 15)
  baseline.record('renderer.snapshot.queue_ms', 5)
  baseline.record('generation.provider.ms', 1200)
  baseline.record('transport.first_response.ms', 400)
  baseline.record('transport.first_visible.ms', 650)
  baseline.record('transport.requests', 1)
  baseline.record('transport.visible.events', 12)
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

  expect(attribution.schemaVersion).toBe(1)
  expect(attribution.localPreparation.elapsedMs).toBe(45) // 10 + 20 + 15
  expect(attribution.localPreparation.readUtf8Bytes).toBe(5000)
  expect(attribution.queueWait.queueMs).toBe(5)
  expect(attribution.modelExecution.providerMs).toBe(1200)
  expect(attribution.modelExecution.firstResponseMs).toBe(400)
  expect(attribution.modelExecution.firstVisibleMs).toBe(650)
  expect(attribution.modelExecution.totalTokens).toBe(450)
  expect(attribution.modelExecution.isNetworkWaiting).toBe(false)
  expect(attribution.parsingComputation.parseMs).toBe(30)
  expect(attribution.persistenceSave.saveMs).toBe(45)
  expect(attribution.persistenceSave.snapshotMs).toBe(8)
  expect(attribution.provenance.corpusHash).toBe('abc123corpus')
  expect(attribution.provenance.sampleChapters).toBe(100)
  expect(attribution.provenance.multiBookStatus).toEqual([
    { books: 2, status: 'not_executed' },
    { books: 4, status: 'not_executed' },
  ])
  expect(Object.isFrozen(attribution)).toBe(true)
})

it('distinguishes remote network/reasoning waiting from UI freezing', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('transport.requests', 1)
  baseline.record('generation.provider.ms', 2000)
  // No visible events emitted yet -> waiting for remote response
  const inFlightSnapshot = baseline.snapshot()
  const inFlightAttribution = computeCreationCostAttribution(inFlightSnapshot)

  const inFlightDiag = isNetworkWaitingVsUiFreeze(inFlightAttribution)
  expect(inFlightDiag.isNetworkWaiting).toBe(true)
  expect(inFlightDiag.isUiFrozen).toBe(false)
  expect(inFlightDiag.explanation).toContain('Network transport/model reasoning is in flight')

  // UI stall without in-flight network request
  const stalledBaseline = createPerformanceBaseline()
  stalledBaseline.record('renderer.snapshot.queue_ms', 850)
  const stalledAttribution = computeCreationCostAttribution(stalledBaseline.snapshot())
  const stallDiag = isNetworkWaitingVsUiFreeze(stalledAttribution)
  expect(stallDiag.isNetworkWaiting).toBe(false)
  expect(stallDiag.isUiFrozen).toBe(true)
  expect(stallDiag.explanation).toContain('Main thread/queue processing delay exceeded 500ms')
})

it('evaluates p95 100ms and main thread 500ms as candidate targets without hard rejection', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('renderer.snapshot.processing_ms', 40)
  baseline.record('renderer.snapshot.queue_ms', 120)

  const evaluation = evaluateCandidateTargets(baseline.snapshot())
  expect(evaluation.p95CandidateTargetMs).toBe(100)
  expect(evaluation.mainThreadCandidateTargetMs).toBe(500)
  expect(evaluation.isHardThreshold).toBe(false)
  expect(evaluation.isCandidateTargetMet).toBe(true)
  expect(evaluation.notice).toContain('candidate optimization goals, not hard gates')

  // When latency exceeds candidate goals, it reports them without throwing or marking failure
  const slowerBaseline = createPerformanceBaseline()
  for (let i = 0; i < 100; i++) slowerBaseline.record('renderer.snapshot.processing_ms', 150)
  const slowerEval = evaluateCandidateTargets(slowerBaseline.snapshot())
  expect(slowerEval.isCandidateTargetMet).toBe(false)
  expect(slowerEval.isHardThreshold).toBe(false)
  expect(slowerEval.observations.exceededTargets.length).toBeGreaterThan(0)
})
