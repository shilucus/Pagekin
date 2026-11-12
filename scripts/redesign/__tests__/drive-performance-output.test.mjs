import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it, vi } from 'vitest'
import { performanceArtifactPath, performanceError, projectPerformanceResult } from '../drive-performance-output.mjs'
import { MATERIAL_DECISION_OMISSION_REASONS } from '../../../src/shared/generation-owner-contract.ts'
import { PERFORMANCE_METRICS } from '../../../src/shared/performance-baseline.ts'

vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { driveSessions, releaseSessionRoot } from '../drive.mjs'

const directories = []
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-output-test-'))
  directories.push(directory)
  return directory
}
function frozenSelection() {
  const hash = 'a'.repeat(64)
  return {
    secret: 'draft',
    sourceRefs: { coverage: 'recorded', counts: [{ kind: 'import', count: 3, secretCount: 17 }] },
    materialDecision: { coverage: 'recorded', receipt: { version: 1, verdict: 'admitted', promptHash: hash,
      capacity: { maxInputUnits: 100, methodVersion: 'utf8-bytes-v1', admittedUnits: 20, secret: 'private-capacity' },
      coverage: { required: 1, included: 1, complete: true },
      included: [{ sourceId: 'finalized:2', revision: 3, contentHash: hash, category: 'finalized-history', required: true, units: 20,
        content: 'private-content' }],
      omitted: MATERIAL_DECISION_OMISSION_REASONS.map((reason, index) => ({ sourceId: `reference:${index}`, revision: 0,
        contentHash: hash, category: 'reference', required: false, reason, title: 'private-title' })),
      promptText: 'private-prompt' } },
    import: { coverage: 'recorded', source: { kind: 'import', manifestFingerprint: hash, totalChapters: 100, totalWords: 1000,
      selectedChapters: [1, 3, 99].map(number => ({ number, contentHash: hash, wordCount: number, title: 'private-title' })),
      checkpointRange: { startChapter: 1, endChapter: 100, secretCount: 7 }, path: 'private-path' } },
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

it('projects the six no-model parse scenes and only their bounded inspection fields', () => {
  const scenarios = ['perf-parse-author-10', 'perf-parse-author-100', 'perf-parse-author-1000',
    'perf-parse-reference-10', 'perf-parse-reference-100', 'perf-parse-reference-1000']
  const inspection = { purpose: 'reference', sourceCount: 1, chapterCount: 1000, totalBytes: 5000, totalWords: 700,
    classification: 'new', stage: 'prepared', status: 'ready', completedSources: 1, totalSources: 1,
    newCount: 1, duplicateCount: 0, conflictCount: 0 }
  for (const scenario of scenarios) {
    const raw = { scenario, session: scenario, measured: { scenario, corpusSha256: 'a'.repeat(64), corpusBytes: 5000,
      inspection: { ...inspection, filename: 'private-path', title: 'private-title', text: 'private-text', id: 'private-id' } } }
    const result = projectPerformanceResult(raw, 'C:/fictional/out')
    assert.equal(result.scenario, scenario)
    assert.equal(result.session, scenario)
    assert.equal(result.measured.scenario, scenario)
    assert.equal(result.measured.corpusSha256, 'a'.repeat(64))
    assert.equal(result.measured.corpusBytes, 5000)
    assert.deepEqual(result.measured.inspection, inspection)
    assert.equal(JSON.stringify(result).includes('private-'), false)
  }
  const author = projectPerformanceResult({ measured: { inspection: { purpose: 'author-manuscript', sourceCount: 1 } } })
  assert.deepEqual(author.measured.inspection, { purpose: 'author-manuscript', sourceCount: 1 })
})

it('distinguishes observed zero, missing and poisoned CPU and RSS evidence', () => {
  const zero = projectPerformanceResult({ measured: { measurements: {
    main: { cpu: { userUs: 0, systemUs: 0, windowMs: 0, secret: 'private-cpu' },
      memory: { rssStart: 0, rssEnd: 0, rssMax: 0, rssSamples: 0, rssIntervalMs: 250, secret: 'private-rss' } },
    coverage: { main: 'live_zero_events', cpu: 'observed', secret: 'private-coverage' },
  } } })
  assert.deepEqual(zero.measured.measurements.main.cpu, { userUs: 0, systemUs: 0, windowMs: 0 })
  assert.deepEqual(zero.measured.measurements.main.memory, { rssStart: 0, rssEnd: 0, rssMax: 0, rssIntervalMs: 250, rssSamples: 0 })
  assert.deepEqual(zero.measured.measurements.coverage, { main: 'live_zero_events', cpu: 'observed' })
  assert.equal(JSON.stringify(zero).includes('private-'), false)
  const elapsed = projectPerformanceResult({ measured: { measurements: { main: { cpu: { windowMs: 250.5 } } } } })
  assert.deepEqual(elapsed.measured.measurements.main.cpu, { windowMs: 250.5 })

  const missing = projectPerformanceResult({ measured: { measurements: { main: { cpu: {}, memory: {} }, coverage: { cpu: 'unavailable' } } } })
  assert.deepEqual(missing.measured.measurements.main, { cpu: {}, memory: {} })
  assert.deepEqual(missing.measured.measurements.coverage, { cpu: 'unavailable' })
  const unavailable = projectPerformanceResult({ measured: { measurements: { main: { cpu: null, memory: { rssStart: null } } } } })
  assert.deepEqual(unavailable.measured.measurements.main, { memory: { rssStart: null }, cpu: null })
  assert.equal(Object.hasOwn(unavailable.measured.measurements, 'coverage'), false)

  const poisoned = projectPerformanceResult({ measured: { corpusBytes: -1, inspection: {
    purpose: 'private-purpose', classification: 'private-classification', stage: 'private-stage', status: 'private-status',
    sourceCount: -1, chapterCount: 1.5, totalBytes: Infinity, totalWords: '0', completedSources: NaN,
    totalSources: Number.MAX_SAFE_INTEGER + 1, newCount: false, duplicateCount: {}, conflictCount: null, extra: 'private-extra',
  }, measurements: { main: { cpu: { userUs: -1, systemUs: Infinity, windowMs: 'private-window' },
    memory: { rssStart: NaN, rssEnd: '0', rssMax: -1, rssSamples: 0.5, rssIntervalMs: null } }, coverage: { cpu: 'private-cpu' } } } })
  assert.equal(poisoned.measured.corpusBytes, null)
  assert.deepEqual(poisoned.measured.inspection, { purpose: null, sourceCount: null, chapterCount: null, totalBytes: null,
    totalWords: null, classification: null, stage: null, status: null, completedSources: null, totalSources: null,
    newCount: null, duplicateCount: null, conflictCount: null })
  assert.deepEqual(poisoned.measured.measurements.main, { cpu: { userUs: null, systemUs: null, windowMs: null },
    memory: { rssStart: null, rssEnd: null, rssMax: null, rssIntervalMs: null, rssSamples: null } })
  assert.deepEqual(poisoned.measured.measurements.coverage, { cpu: null })
  assert.equal(JSON.stringify(poisoned).includes('private-'), false)
})

it('requires lexical and real containment for Windows, UNC and prefix traps', () => {
  const options = { pathApi: path.win32, contained: () => true }
  const out = 'C:\\Users\\alice\\out'
  assert.equal(performanceArtifactPath('C:\\Users\\alice\\out\\shot.png', out, options), 'shot.png')
  for (const value of ['C:\\Users\\alice\\outside\\shot.png', 'D:\\out\\shot.png',
    '\\\\server\\share\\shot.png', 'C:\\Users\\alice\\out\\..\\private.png']) {
    const projected = performanceArtifactPath(value, out, options)
    assert.match(projected, /^opaque:[a-f0-9]{64}$/)
    assert.equal(projected.includes('alice'), false)
  }
  assert.equal(performanceArtifactPath('\\\\server\\share\\out\\shot.png', '\\\\server\\share\\out', options), 'shot.png')
  assert.match(performanceArtifactPath('C:\\Users\\alice\\out\\linked.png', out,
    { ...options, contained: () => false }), /^opaque:/)
  assert.match(performanceArtifactPath('C:\\Users\\alice\\out\\linked.png', out,
    { ...options, contained: () => { throw new Error('private path') } }), /^opaque:/)
})

it('projects exception and external evidence without changing input or dropping denominators', () => {
  const raw = { scenario: 'perf-import-10', error: 'Error: C:\\Users\\alice\\secret',
    isolationRoot: 'C:\\Users\\alice\\scratch', externalWrites: ['D:\\Users\\alice\\a', 'D:\\Users\\alice\\b'],
    externalWritesIgnored: ['\\\\server\\share\\cache'], measured: { attempted: 2, failed: 1 }, residualProcesses: [] }
  const before = structuredClone(raw)
  const projected = projectPerformanceResult(raw, 'C:\\Users\\alice\\out', { pathApi: path.win32, contained: () => true })
  assert.deepEqual(raw, before)
  assert.equal(projected.error, 'PERFORMANCE_FAILURE:Error:UNCLASSIFIED_ERROR')
  assert.equal(projected.externalWrites.length, 2)
  assert.equal(projected.externalWritesIgnored.length, 1)
  assert.deepEqual(projected.measured, { attempted: 2, failed: 1 })
  assert.equal(JSON.stringify(projected).includes('alice'), false)
  assert.equal(performanceError(Object.assign(new Error('private'), { code: 'EACCES' })), 'PERFORMANCE_FAILURE:Error:EACCES')
  const boundary = performanceError(Object.assign(new Error('C:\\Users\\alice\\private'), { code: 'ISOLATION_CLEANUP_BOUNDARY' }))
  assert.equal(boundary, 'PERFORMANCE_FAILURE:Error:ISOLATION_CLEANUP_BOUNDARY')
  assert.equal(projectPerformanceResult({ error: boundary }).error, boundary)
  assert.equal(boundary.includes('alice'), false)
})

it('preserves bounded receipt hashes, statuses, coverage and attempt totals', () => {
  const hash = 'a'.repeat(64)
  const result = projectPerformanceResult({ measured: { diagnostics: { generation: {
    coverage: 'partial', observed: 2, retained: 1, runs: [{ runId: 'private-run-id', status: 'failed',
      source: { modelIdHash: hash, fingerprint: { modelLeaseRevision: hash, dependencyHash: hash } },
      initialDraftTaskHash: hash, parametersCoverage: 'not_recorded',
      attempts: { observed: 3, retained: 1, items: [{ attemptId: 'private-attempt-id', status: 'settled',
        failureCode: 'GENERATION_PROVIDER_FAILED', transport: { phase: 'stream', errorCode: 'ETIMEDOUT' } }] } }],
  } } } }, '/out')
  const run = result.measured.diagnostics.generation.runs[0]
  assert.equal(result.measured.diagnostics.generation.coverage, 'partial')
  assert.equal(run.source.modelIdHash, hash)
  assert.equal(run.source.fingerprint.modelLeaseRevision, hash)
  assert.equal(run.initialDraftTaskHash, hash)
  assert.equal(run.parametersCoverage, 'not_recorded')
  assert.equal(run.status, 'failed')
  assert.equal(run.attempts.observed, 3)
  assert.equal(run.attempts.items[0].transport.phase, 'stream')
  assert.equal(run.attempts.items[0].failureCode, 'GENERATION_PROVIDER_FAILED')
  assert.match(run.runId, /^opaque:/)
  assert.match(run.attempts.items[0].attemptId, /^opaque:/)
})

it('projects only frozen selection fields at the final export boundary', () => {
  const raw = { measured: { attempted: 2, failed: 1, diagnostics: { generation: { runs: [{ selection: frozenSelection() }] } } } }
  const before = structuredClone(raw)
  const result = projectPerformanceResult(raw, '/out')
  const selection = result.measured.diagnostics.generation.runs[0].selection
  assert.deepEqual(raw, before)
  assert.deepEqual(selection.sourceRefs, { coverage: 'recorded', counts: [{ kind: 'import', count: 3 }] })
  assert.deepEqual(selection.materialDecision.receipt.included[0], { sourceId: 'finalized:2', revision: 3,
    contentHash: 'a'.repeat(64), category: 'finalized-history', required: true, units: 20 })
  assert.deepEqual(selection.materialDecision.receipt.omitted.map(item => item.reason), MATERIAL_DECISION_OMISSION_REASONS)
  assert.deepEqual(selection.materialDecision.receipt.omitted.map(item => item.sourceId),
    MATERIAL_DECISION_OMISSION_REASONS.map((_, index) => `reference:${index}`))
  assert.deepEqual(selection.import.source, { kind: 'import', manifestFingerprint: 'a'.repeat(64), totalChapters: 100, totalWords: 1000,
    selectedChapters: [1, 3, 99].map(number => ({ number, contentHash: 'a'.repeat(64), wordCount: number })),
    checkpointRange: { startChapter: 1, endChapter: 100 } })
  assert.deepEqual(Object.keys(selection), ['sourceRefs', 'materialDecision', 'import'])
  assert.equal(JSON.stringify(selection).includes('private-'), false)
  assert.equal(JSON.stringify(selection).includes('secret'), false)
  assert.equal(JSON.stringify(selection).includes('promptText'), false)
  assert.equal(result.measured.attempted, 2)
  assert.equal(result.measured.failed, 1)
})

it('contains unknown source IDs and reasons in the final export even without the consumer', () => {
  const selection = frozenSelection()
  Object.assign(selection.materialDecision.receipt.omitted[0], { sourceId: 'reference:private-source', reason: 'private-reason' })
  Object.assign(selection.sourceRefs.counts[0], { kind: 'private-kind' })
  const result = projectPerformanceResult({ selection }, '/out').selection
  const item = result.materialDecision.receipt.omitted[0]
  assert.match(item.sourceId, /^opaque:[a-f0-9]{64}$/)
  assert.equal(item.reason, null)
  assert.equal(result.sourceRefs.counts[0].kind, 'unknown')
  assert.equal(JSON.stringify(result).includes('private-'), false)
  assert.deepEqual(projectPerformanceResult({ selection: result }, '/out').selection, result)
})

it('drops unknown scalar keys throughout the known report tree and fixes metric authority to the shared list', () => {
  const secret = { prompt: 'draft', secretNumber: 918273, secretBoolean: true, ['a'.repeat(64)]: false }
  const metric = { count: 1, sum: 0, min: 0, max: 0, p50UpperBound: 0, p95UpperBound: 0, ...secret }
  const raw = { ...secret, measured: { ...secret, metadata: { platform: 'win32', ...secret },
    fixture: { model: 'gpt-4.1', ...secret }, fixtureParameters: { observed: 1, ...secret,
      items: [{ maxTokens: 0, temperature: 0, ...secret }], groups: [{ count: 1, ...secret }] },
    measurements: { ...secret, main: { ...secret, metrics: { schemaVersion: 1, ...secret,
      metrics: { [PERFORMANCE_METRICS[0]]: metric, secretMetric: metric, ['b'.repeat(64)]: metric } },
    memory: { rssMax: 1, ...secret }, eventLoop: { count: 0, ...secret } },
    renderer: { ...secret, metrics: { secretMetric: metric }, heartbeat: { count: 0, ...secret } },
    coverage: { main: 'unavailable', ...secret }, costAttribution: { ...secret, categories: { schemaVersion: 2, ...secret,
      queueWait: { schedulerAcquireCalls: 0, ...secret }, provenance: { attempted: 1, ...secret } } } },
    requestSummary: { coverage: 'guarded_fetch_attempts', ...secret, byRoute: { ...secret,
      '/v1/chat/completions': { count: 0, ...secret }, '/private': { count: 918273 } } },
    diagnostics: { ...secret, generation: { ...secret, operationCounts: [{ operation: 'chapter-draft', count: 1, ...secret }],
      runs: [{ ...secret, source: { ...secret, fingerprint: { ...secret } }, importSlot: { stage: 'global', ...secret },
        finalizationSlot: { ...secret, source: { chapterNumber: 1, ...secret } },
        attempts: { ...secret, items: [{ ...secret, actual: { input: 0, ...secret }, transport: { phase: 'stream', ...secret } }] } }] },
    importRun: { ...secret, runs: [{ ...secret, checkpointCounts: { parsing: 0, ...secret } }] } },
    failureDiagnostics: [{ source: 'scenario', stage: 'workflow', errorClass: 'Error', code: 'TIMEOUT', ...secret }],
    task: { attempted: 1, ...secret }, drain: { status: 'drained', ...secret }, eventCoverage: { ...secret },
    countCoverage: { ...secret }, concurrency: { 1: 'executed', ...secret }, thresholds: { ...secret } },
    keyScan: { hits: [], ...secret, removeFailures: [{ file: '/private', ...secret }] },
    quit: { forced: false, ...secret }, timing: { launchToInteractiveMs: 0, ...secret } }
  const before = structuredClone(raw)
  const result = projectPerformanceResult(raw, '/out')
  assert.deepEqual(raw, before)
  const json = JSON.stringify(result)
  for (const forbidden of ['prompt', 'secretNumber', 'secretBoolean', '918273', 'secretMetric', 'a'.repeat(64), 'b'.repeat(64), '/private']) {
    assert.equal(json.includes(forbidden), false, forbidden)
  }
  assert.deepEqual(Object.keys(result.measured.measurements.main.metrics.metrics), [PERFORMANCE_METRICS[0]])
  assert.deepEqual(result.measured.measurements.main.metrics.metrics[PERFORMANCE_METRICS[0]],
    { count: 1, sum: 0, min: 0, max: 0, p50UpperBound: 0, p95UpperBound: 0 })
  assert.deepEqual(result.measured.measurements.renderer.metrics, {})
})

it('does not accept globally familiar strings, objects, booleans or numbers as another field type', () => {
  const result = projectPerformanceResult({ scenario: 'draft', theme: 'failed', error: { message: 'secret' },
    modelRequests: true, residualProcesses: ['secret', 0, -1], quit: { forced: 'completed' },
    measured: { attempted: '1', failed: false, success: 'failed', failureStage: 'draft', corpusSha256: true,
      metadata: { platform: 'draft', arch: 64, ramBytes: Infinity, sourceSha: 'draft', driverNode: 'draft',
        appRuntime: { node: true } },
      fixture: { model: { secret: true }, temperature: '0', configuredMaxTokens: false, protocol: 'draft' },
      task: { physicalRequests: -1, frozenInitialTaskSha256: 'draft' },
      measurements: { main: { metrics: { schemaVersion: 2, quantiles: 'draft', metrics: {
        [PERFORMANCE_METRICS[0]]: { count: 1.5, sum: NaN, min: -1, max: true, p50UpperBound: {}, p95UpperBound: '0' },
      } } }, coverage: { main: 'draft' } },
      diagnostics: { generation: { runs: [{ runId: 1, operation: true, status: 'draft',
        source: { modelIdHash: 'draft', fingerprint: { dependencyHash: false } },
        attempts: { items: [{ failureCode: 'draft', transport: { phase: 'draft', httpStatus: 999, errorName: 'draft' } }] } }] } } },
  }, '/out')
  assert.equal(result.scenario, null)
  assert.equal(result.theme, null)
  assert.equal(result.error, null)
  assert.equal(result.modelRequests, null)
  assert.deepEqual(result.residualProcesses, [null, 0, null])
  assert.deepEqual(result.quit, { forced: null })
  assert.deepEqual(result.measured.metadata, { platform: null, arch: null, ramBytes: null, sourceSha: null,
    driverNode: null, appRuntime: { node: null } })
  assert.deepEqual(result.measured.fixture, { model: null, temperature: null, configuredMaxTokens: null, protocol: null })
  assert.deepEqual(result.measured.measurements.main.metrics.metrics[PERFORMANCE_METRICS[0]],
    { count: null, sum: null, min: null, max: null, p50UpperBound: null, p95UpperBound: null })
  assert.equal(JSON.stringify(result).includes('draft'), false)
  assert.deepEqual(result.measured.diagnostics.generation.runs[0].attempts.items[0].transport,
    { phase: null, httpStatus: null, errorName: null })
})

it('preserves null versus explicit zero and the additive cost, sampling and parameter-group contracts', () => {
  const result = projectPerformanceResult({ measured: { attempted: 1, failed: 1, importedChapters: null, blueprintChapters: 0,
    countCoverage: { importedChapters: 'unavailable', blueprintChapters: 'observed' },
    fixtureParameters: { coverage: 'observed_http_requests', observed: 40, retained: 32, omitted: 8,
      groupLimit: 32, grouped: 40, overflow: 0, items: [{ model: null, maxTokens: null, temperature: 0 }],
      groups: [{ model: `opaque:${'a'.repeat(64)}`, maxTokens: 0, temperature: null, count: 40 }] },
    diagnostics: { generation: { observed: 40, retained: 32, omitted: 8, samplingRule: 'operation-head-tail-failed-v1',
      operationCounts: [{ operation: 'import-blueprints', count: 40 }],
      runs: [{ attempts: { observed: 35, retained: 32, omitted: 3, items: [] } }] } },
    measurements: { coverage: { main: 'unavailable', renderer: 'live_zero_events' }, main: null,
      costAttribution: { ownership: 'main-plus-renderer-owned-metrics', coverage: { main: 'unavailable', renderer: 'live_zero_events' },
        categories: { schemaVersion: 2, localPreparation: { inspectMs: null, inspectFailed: 0 },
          queueWait: { schedulerAcquireCalls: 0, schedulerAdmitted: 0, schedulerRejected: 0,
            schedulerAdmittedWaitMs: null, schedulerRejectedWaitMs: 0, schedulerQueueSamples: null },
          modelExecution: { providerMs: null, physicalRequests: 0 }, parsingComputation: { parseMs: null },
          persistenceSave: { saveMs: 0 }, provenance: { corpusHash: 'a'.repeat(64), sampleChapters: 10,
            sampleBooks: 1, attempted: 1, failed: 1, multiBookStatus: [{ books: 2, status: 'not_executed' }] } } } } } }, '/out')
  assert.equal(result.measured.importedChapters, null)
  assert.equal(result.measured.blueprintChapters, 0)
  assert.equal(result.measured.measurements.main, null)
  const costs = result.measured.measurements.costAttribution.categories
  assert.deepEqual(costs.localPreparation, { inspectMs: null, inspectFailed: 0 })
  assert.deepEqual(costs.queueWait, { schedulerAcquireCalls: 0, schedulerAdmitted: 0, schedulerRejected: 0,
    schedulerAdmittedWaitMs: null, schedulerRejectedWaitMs: 0, schedulerQueueSamples: null })
  assert.equal(costs.modelExecution.physicalRequests, 0)
  assert.equal(costs.modelExecution.providerMs, null)
  assert.equal(result.measured.fixtureParameters.groups[0].model, `opaque:${'a'.repeat(64)}`)
  assert.deepEqual(result.measured.fixtureParameters.items[0], { model: null, maxTokens: null, temperature: 0 })
  assert.equal(result.measured.fixtureParameters.omitted, 8)
  assert.equal(result.measured.fixtureParameters.overflow, 0)
  assert.equal(result.measured.diagnostics.generation.omitted, 8)
  assert.equal(result.measured.diagnostics.generation.runs[0].attempts.omitted, 3)
  assert.deepEqual(result.measured.diagnostics.generation.operationCounts, [{ operation: 'import-blueprints', count: 40 }])
  for (const coverage of ['not_available_http429', 'not_applicable_embedding']) {
    const fixtureParameters = { coverage, observed: null, retained: 0, omitted: null, grouped: null,
      overflow: null, groupLimit: 32, groups: [], items: [] }
    assert.deepEqual(projectPerformanceResult({ measured: { fixtureParameters } }, '/out').measured.fixtureParameters, fixtureParameters)
  }
})

it('retains every fixed metric name without granting authority to arbitrary hashed or familiar keys', () => {
  const summary = { count: 1, sum: 0, min: 0, max: 0, p50UpperBound: 0, p95UpperBound: 0 }
  const metrics = Object.fromEntries(PERFORMANCE_METRICS.map(name => [name, summary]))
  const result = projectPerformanceResult({ measured: { measurements: {
    main: { metrics: { schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics } }, renderer: { metrics },
  } } }, '/out')
  assert.deepEqual(result.measured.measurements.main.metrics.metrics, metrics)
  assert.deepEqual(result.measured.measurements.renderer.metrics, metrics)
})

for (const scenario of ['perf-import-10', 'perf-import-100', 'perf-import-1000', 'perf-long-stream', 'perf-slow-embedding', 'perf-rate-limit']) {
  it(`retains the declared evidence and actual contained assets for ${scenario}`, () => {
    const raw = { scenario, session: scenario, theme: 'light', shell: 'stage',
      screenshot: 'C:\\out\\scene.failure.png', failureScreenshot: 'C:\\out\\session.failure.png',
      video: 'C:\\out\\scene.webm', isolationRoot: 'C:\\private',
      error: 'PERFORMANCE_FAILURE:scenario:workflow:TimeoutError:TIMEOUT',
      measured: { scenario, attempted: 1, failed: 1, success: false, failureStage: 'workflow',
        cleanupFailures: 0, stopFailures: 0, importedChapters: null, blueprintChapters: null,
        corpusSha256: 'a'.repeat(64), elapsedMs: 0, fixtureAcceptedRequests: 0, finalFixtureAcceptedRequests: 0,
        fixture: { kind: 'local-openai-compatible-fiction', protocol: 'openai', model: 'gpt-4.1', temperature: 0,
          configuredMaxTokens: 0, skill: 'isolated-fixture-default-no-custom-install', corpusSha256: 'b'.repeat(64) },
        requestSummary: { coverage: 'unavailable', byRoute: { '/v1/chat/completions': { count: 0, failed: 0, http429: 0, totalMs: 0, maxMs: 0 } } },
        finalRequestSummary: null, requestSummaryCutoff: 'before_quit', requestsAfterMeasurement: 0,
        drain: { status: 'drained', cancellationRequested: true },
        failureDiagnostics: [{ source: 'scenario', stage: 'workflow', errorClass: 'TimeoutError', code: 'TIMEOUT' }],
        concurrency: { 1: 'executed', 2: 'unsupported_not_executed', 4: 'unsupported_not_executed' } },
      externalRequests: null, externalRequestsCoverage: 'unavailable', externalWrites: [], externalWritesIgnored: [],
      residualProcesses: [], modelRequests: 0, modelRequestsAfterFinalCutoff: 0, quit: { forced: true } }
    const result = projectPerformanceResult(raw, 'C:\\out', { pathApi: path.win32, contained: () => true })
    assert.equal(result.scenario, scenario)
    assert.equal(result.session, scenario)
    assert.equal(result.screenshot, 'scene.failure.png')
    assert.equal(result.failureScreenshot, 'session.failure.png')
    assert.equal(result.video, 'scene.webm')
    assert.match(result.isolationRoot, /^opaque:/)
    assert.deepEqual(result.measured, raw.measured)
    assert.equal(result.error, 'PERFORMANCE_FAILURE:TimeoutError:TIMEOUT')
    assert.equal(result.externalRequests, null)
    assert.equal(result.externalRequestsCoverage, 'unavailable')
    assert.equal(result.modelRequestsAfterFinalCutoff, 0)
    assert.deepEqual(result.quit, { forced: true })
  })
}

it('writes the same projection to stdout and JSON while passing real paths to session cleanup', async () => {
  const out = temporaryDirectory(), root = path.join(out, 'isolated')
  fs.mkdirSync(root)
  const artifact = path.join(out, 'perf-import-10-light.png')
  const lines = []
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { lines.push(String(value)); return true })
  const code = await driveSessions({ sessions: [['perf-import-10', ['perf-import-10']]],
    options: { out, scenario: 'perf-import-10', theme: 'light' }, realKey: null, makeRoots: () => ({ root }),
    run: async (_name, _names, _options, _key, roots) => {
      assert.equal(roots.root, root)
      fs.writeFileSync(artifact, 'image')
      const errors = []
      releaseSessionRoot(roots.root, true, errors)
      assert.deepEqual(errors, [])
      return [{ scenario: 'perf-import-10', isolationRoot: roots.root, screenshot: artifact,
        externalWrites: [], externalWritesIgnored: [], residualProcesses: [], measured: { diagnostics: { generation: {
          scope: 'isolated_project', coverage: 'partial', observed: 2, retained: 2, runs: [{ runId: 'linked-run', status: 'failed', operation: 'finalized-chapter-notes',
            selection: frozenSelection(),
            source: { fingerprint: { skillSnapshotHash: 'b'.repeat(64) } }, initialDraftTaskHash: 'c'.repeat(64),
            parametersCoverage: 'not_recorded', importSlot: { runId: 'linked-run', stage: 'global' },
            attempts: { observed: 5, retained: 5, items: ['HTTP_ERROR', 'RESPONSE_BODY_MISSING', 'PROVIDER_STREAM_ERROR', 'STREAM_INVALID', 'STREAM_INCOMPLETE']
              .map(errorCode => ({ status: 'settled', purpose: 'chapter-draft-short-outline', transport: { phase: 'stream', errorCode } })) } },
          { status: 'completed', operation: 'finalized-character-state', finalizationSlot: { stepKey: 'character_cards' } }],
        } } } }]
    },
  })
  const report = JSON.parse(fs.readFileSync(path.join(out, 'perf-import-10-light.json'), 'utf8'))
  assert.equal(code, 0)
  assert.equal(fs.existsSync(root), false)
  assert.deepEqual(JSON.parse(lines[0]), report[0])
  assert.equal(report[0].screenshot, 'perf-import-10-light.png')
  assert.match(report[0].isolationRoot, /^opaque:/)
  assert.equal(lines[0].includes(root), false)
  const generation = report[0].measured.diagnostics.generation
  const run = generation.runs[0]
  assert.equal(generation.scope, 'isolated_project')
  assert.equal(generation.coverage, 'partial')
  assert.equal(run.status, 'failed')
  assert.equal(run.operation, 'finalized-chapter-notes')
  assert.equal(generation.runs[1].operation, 'finalized-character-state')
  assert.equal(generation.runs[1].finalizationSlot.stepKey, 'character_cards')
  assert.equal(run.parametersCoverage, 'not_recorded')
  assert.deepEqual(run.selection.sourceRefs, { coverage: 'recorded', counts: [{ kind: 'import', count: 3 }] })
  assert.deepEqual(run.selection.import.source.selectedChapters.map(item => item.number), [1, 3, 99])
  assert.deepEqual(run.selection.materialDecision.receipt.omitted.map(item => item.reason), MATERIAL_DECISION_OMISSION_REASONS)
  assert.equal(JSON.stringify(run.selection).includes('private-'), false)
  assert.equal(JSON.stringify(run.selection).includes('secret'), false)
  assert.equal(run.importSlot.stage, 'global')
  assert.equal(run.attempts.items[0].purpose, 'chapter-draft-short-outline')
  assert.deepEqual(run.attempts.items.map(item => item.transport.errorCode),
    ['HTTP_ERROR', 'RESPONSE_BODY_MISSING', 'PROVIDER_STREAM_ERROR', 'STREAM_INVALID', 'STREAM_INCOMPLETE'])
  assert.equal(run.source.fingerprint.skillSnapshotHash, 'b'.repeat(64))
  assert.equal(run.initialDraftTaskHash, 'c'.repeat(64))
  assert.match(run.runId, /^opaque:/)
  assert.equal(run.runId, run.importSlot.runId)
})

it('keeps an outer session failure visible without exporting its message or path', async () => {
  const out = temporaryDirectory()
  const lines = []
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { lines.push(String(value)); return true })
  const code = await driveSessions({ sessions: [['perf-import-10', ['perf-import-10']]],
    options: { out, scenario: 'perf-import-10', theme: 'light' }, realKey: null,
    makeRoots: () => { throw Object.assign(new Error('C:\\Users\\alice\\private'), { code: 'EACCES' }) },
  })
  const report = JSON.parse(fs.readFileSync(path.join(out, 'perf-import-10-light.json'), 'utf8'))
  assert.equal(code, 1)
  assert.equal(report[0].error, 'PERFORMANCE_FAILURE:Error:EACCES')
  assert.deepEqual(JSON.parse(lines[0]), report[0])
  assert.equal(lines[0].includes('alice'), false)
})

it('scans the actual retained isolation directory for secrets before projecting paths', async () => {
  const out = temporaryDirectory(), root = temporaryDirectory()
  const secretFile = path.join(root, 'sensitive.txt')
  const lines = []
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { lines.push(String(value)); return true })
  const code = await driveSessions({ sessions: [['perf-import-10', ['perf-import-10']]],
    options: { out, scenario: 'perf-import-10', theme: 'light' }, realKey: 'fixture-secret', makeRoots: () => ({ root }),
    run: async () => {
      fs.writeFileSync(secretFile, 'fixture-secret')
      return [{ scenario: 'perf-import-10', isolationRoot: root, externalWrites: [], residualProcesses: [] }]
    },
  })
  const report = JSON.parse(fs.readFileSync(path.join(out, 'perf-import-10-light.json'), 'utf8'))
  assert.equal(code, 1)
  assert.equal(fs.existsSync(secretFile), false)
  assert.equal(report[0].keyScan.hits.length, 1)
  assert.match(report[0].keyScan.hits[0], /^opaque:/)
  assert.deepEqual(JSON.parse(lines[0]), report[0])
  assert.equal(lines[0].includes('fixture-secret'), false)
  assert.equal(lines[0].includes(root), false)
})
