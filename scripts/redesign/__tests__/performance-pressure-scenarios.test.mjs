import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERFORMANCE_PRESSURE_SCENARIOS, runPerformancePressureScenario } from '../performance-pressure-scenarios.mjs'
import { streamingProse } from '../fake-model.mjs'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function measurements(empty = false) {
  const summary = sum => ({ count: 1, sum, min: sum, max: sum, p50UpperBound: sum, p95UpperBound: sum })
  return { main: { metrics: { schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: empty ? {} : {
    'transport.requests': summary(2), 'transport.visible.events': summary(401), 'transport.reasoning.events': summary(20),
    'transport.first_response.ms': summary(1), 'transport.first_reasoning.ms': summary(2), 'transport.first_visible.ms': summary(3),
    'generation.snapshot.calls': summary(20), 'generation.snapshot.utf8_bytes': summary(100),
    'ipc.snapshot.calls': summary(20), 'ipc.snapshot.utf8_bytes': summary(100), 'generation.usage.known': summary(2),
  } }, memory: { rssSamples: 3, rssMax: 1024 }, eventLoop: { count: 4 } },
  renderer: { metrics: empty ? {} : Object.fromEntries(['renderer.snapshot.accepted', 'renderer.snapshot.utf8_bytes',
    'renderer.snapshot.queue', 'renderer.snapshot.queue_ms', 'renderer.snapshot.hash_ms', 'renderer.snapshot.processing_ms',
    'renderer.snapshot.total_ms'].map(name => [name, summary(20)])), heartbeat: { count: 5 } },
  stopFailures: { main: 0, renderer: 0 }, coverage: { main: empty ? 'live_zero_events' : 'observed_metrics',
    renderer: empty ? 'live_zero_events' : 'observed_metrics' } }
}

function fixture(kind = 'perf-long-stream') {
  const m = measurements(kind === 'perf-slow-embedding')
  const route = (count = 0, failed = 0, http429 = 0, maxMs = 1) => ({ count, failed, http429, totalMs: maxMs, maxMs })
  const requests = { coverage: 'guarded_fetch_attempts', byRoute: {
    '/v1/chat/completions': route(kind === 'perf-long-stream' ? 2 : kind === 'perf-rate-limit' ? 1 : 0,
      Number(kind === 'perf-rate-limit'), Number(kind === 'perf-rate-limit')),
    '/v1/embeddings': route(Number(kind === 'perf-slow-embedding'), 0, 0, 2100), '/v1/messages': route(),
  } }
  if (kind === 'perf-rate-limit') {
    m.main.metrics.metrics['transport.requests'].sum = 1
    m.main.metrics.metrics['transport.http_429'] = { count: 1, sum: 1 }
  }
  const fake = { requests: [], gate: { release: vi.fn() }, rejectRateLimit: vi.fn(), streamProse: vi.fn() }
  const context = { app: {}, page: {}, fake, invoke: vi.fn(async () => ({})) }
  const dependencies = { session: async () => ({ projectId: 'fiction', projectPath: '/fiction', leaseId: 'fixture-lease' }),
    runtime: async () => ({ node: 'fixture', electron: 'fixture', chrome: 'fixture' }),
    start: vi.fn(async () => {}), stop: vi.fn(async () => m), readRequests: vi.fn(async () => requests),
    cancel: vi.fn(async () => {}),
    work: vi.fn(async (_kind, _context, state) => { state.task = { attempted: 1, failed: Number(kind === 'perf-rate-limit'),
      settled: Number(kind !== 'perf-rate-limit'), unknown: Number(kind === 'perf-rate-limit') } }),
  }
  return { context, dependencies, m, requests }
}

describe('performance pressure driver orchestration (not Electron qualification)', () => {
  it('registers only the three bounded isolated producers', () => {
    expect(Object.keys(PERFORMANCE_PRESSURE_SCENARIOS)).toEqual(['perf-long-stream', 'perf-slow-embedding', 'perf-rate-limit'])
    for (const scenario of Object.values(PERFORMANCE_PRESSURE_SCENARIOS)) {
      expect(scenario).toMatchObject({ performance: true, model: true, shell: 'stage', timeout: 360_000 })
      expect(typeof scenario.setup).toBe('function')
    }
  })

  it.each(['perf-long-stream', 'perf-slow-embedding', 'perf-rate-limit'])('retains raw probes and task denominators for %s', async kind => {
    const f = fixture(kind)
    const result = await runPerformancePressureScenario(kind, f.context, f.dependencies)
    expect(result).toMatchObject({ attempted: 1, failed: 0, success: true, cleanupFailures: 0,
      task: { attempted: 1, failed: Number(kind === 'perf-rate-limit'), settled: Number(kind !== 'perf-rate-limit'),
        unknown: Number(kind === 'perf-rate-limit') } })
    expect(result.measurements).toBe(f.m)
    expect(f.dependencies.start).toHaveBeenCalledOnce()
    expect(f.dependencies.stop).toHaveBeenCalledOnce()
    expect(f.context.fake.gate.release).toHaveBeenCalledOnce()
    expect(f.context.fake.rejectRateLimit).toHaveBeenLastCalledWith(false)
    expect(f.context.fake.streamProse).toHaveBeenLastCalledWith(null)
    expect(JSON.stringify(result)).not.toContain('fixture-lease')
    expect(JSON.stringify(result)).not.toContain('/fiction')
    if (kind === 'perf-rate-limit') {
      expect(result.fixture.dispatchedParameters).toEqual([])
      expect(result.fixture.dispatchedParametersCoverage).toBe('not_available_http429')
      expect(result.fixture.usage).toBe('not_available_http429')
    }
  })

  it('consumes explicit live-zero coverage without manufacturing a renderer snapshot', async () => {
    const f = fixture('perf-slow-embedding')
    const result = await runPerformancePressureScenario('perf-slow-embedding', f.context, f.dependencies)
    expect(result.measurements.coverage).toEqual({ main: 'live_zero_events', renderer: 'live_zero_events' })
    expect(result.measurements.renderer.metrics).toEqual({})
    expect(result.measurements.stopFailures).toEqual({ main: 0, renderer: 0 })
    expect(result.notApplicable).toContain('renderer-snapshot-queue')
  })

  it.each([['perf-long-stream', null], ['perf-long-stream', 'missing-purpose'], ['perf-rate-limit', null], ['perf-rate-limit', 'settled'],
    ['perf-rate-limit', 'missing-artifact'], ['perf-rate-limit', 'foreign-attempt']])('checks registered generation readback for %s; invalid history=%s (mock only)', async (kind, invalidHistory) => {
    const f = fixture(kind)
    delete f.dependencies.work
    const locator = { click: vi.fn(async () => {}), waitFor: vi.fn(async () => {}) }
    for (const method of ['getByRole', 'getByText', 'locator', 'filter', 'first', 'or']) locator[method] = () => locator
    f.context.page = locator
    const handle = { runId: 'new-fixture-run' }
    const long = kind === 'perf-long-stream'
    const text = streamingProse(400, 24).join('')
    const view = { handle, artifacts: long ? [{ text, status: 'completed' }]
      : [{ attemptId: 'rate-limit-attempt', text: '', status: 'failed', compositionEligible: false }],
      ledger: { physicalRequests: long ? 2 : 1 }, budgetDiagnostics: long
        ? [{ actualState: 'settled' }, { actualState: 'settled' }]
        : [{ attemptId: 'rate-limit-attempt', actualState: invalidHistory === 'settled' ? 'settled' : 'unknown', failureCode: 'GENERATION_PROVIDER_FAILED' }] }
    if (invalidHistory === 'missing-artifact') view.artifacts = []
    if (invalidHistory === 'foreign-attempt') view.artifacts[0].attemptId = 'another-attempt'
    let lists = 0
    f.context.invoke.mockImplementation(async (_page, channel) => {
      if (channel === 'generation:list') return lists++ ? [{ handle, operation: 'chapter-draft' }] : []
      if (channel === 'generation:read') return view
      if (channel === 'generation:read-diagnostics') return { schemaVersion: 1, handle, operation: 'chapter-draft',
        source: {}, importSlot: null, initialDraftTaskHash: 'fixture-task-hash', parametersCoverage: 'not_recorded',
        attempts: (long && invalidHistory !== 'missing-purpose' ? ['chapter-draft-short-outline', 'chapter-draft'] : ['chapter-draft-short-outline'])
          .map((purpose, index) => ({ attemptId: `attempt-${index}`, purpose })) }
      throw new Error('UNEXPECTED_FIXTURE_CHANNEL')
    })
    f.context.fake.streamProse.mockImplementation(plan => { if (plan) f.context.fake.streamLog = plan.chunks.map(() => ({})) })
    if (invalidHistory === 'missing-purpose') {
      await expect(runPerformancePressureScenario(kind, f.context, f.dependencies)).rejects.toMatchObject({
        performanceBaseline: { failed: 1, failureStage: 'evidence', task: { attempted: 2, settled: 2, physicalRequests: 2 } },
      })
      const index = f.context.invoke.mock.calls.findIndex(call => call[1] === 'generation:read-diagnostics')
      expect(f.dependencies.stop.mock.invocationCallOrder[0]).toBeLessThan(f.context.invoke.mock.invocationCallOrder[index])
      return
    }
    if (invalidHistory) {
      await expect(runPerformancePressureScenario(kind, f.context, f.dependencies)).rejects.toMatchObject({
        performanceBaseline: { failed: 1, failureStage: 'producer', task: {
          unknown: Number(invalidHistory !== 'settled'), settled: Number(invalidHistory === 'settled'),
          artifactCount: Number(invalidHistory !== 'missing-artifact'),
        } },
      })
      return
    }
    const result = await runPerformancePressureScenario(kind, f.context, f.dependencies)
    expect(result.task).toMatchObject({ attempted: long ? 2 : 1, settled: long ? 2 : 0, failed: long ? 0 : 1,
      unknown: long ? 0 : 1, artifactCount: 1 })
    expect(f.context.invoke.mock.calls.map(call => call[1])).not.toContain('generation:execute')
    expect(f.context.invoke.mock.calls.map(call => call[1])).not.toContain('generation:resume')
    expect(f.context.invoke.mock.calls.map(call => call[1])).not.toContain('generation:read-context')
    const diagnosticCall = f.context.invoke.mock.calls.findIndex(call => call[1] === 'generation:read-diagnostics')
    expect(diagnosticCall).toBeGreaterThanOrEqual(0)
    expect(f.dependencies.stop.mock.invocationCallOrder[0]).toBeLessThan(f.context.invoke.mock.invocationCallOrder[diagnosticCall])
    expect(result.task.frozenInitialTaskSha256).toBe('fixture-task-hash')
    if (long) {
      expect(f.context.fake.streamProse.mock.calls[0][0].reasoningChunks).toHaveLength(20)
      expect(result.diagnostics.generation.runs[0].attempts.items.map(item => item.purpose)).toContain('chapter-draft')
    }
    else expect(f.context.fake.rejectRateLimit).toHaveBeenNthCalledWith(1)
  })

  it.each(['success', 'rejected', 'wrapped-documents', 'not-gated'])('runs default embedding producer with %s (mock IPC orchestration only)', async outcome => {
    vi.useFakeTimers()
    const f = fixture('perf-slow-embedding')
    delete f.dependencies.work
    // Do not create a real file or touch configuration in this orchestration unit test.
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    f.context.roots = { temp: '/fictional-pressure-temp' }
    f.context.app.evaluate = vi.fn(async () => {})
    const pending = Promise.withResolvers(), original = new Error('private-embedding-rejection')
    let released = false
    f.context.fake.gate.waiting = 0
    f.context.fake.gate.hold = vi.fn(() => { f.context.fake.gate.waiting = outcome === 'not-gated' ? 0 : 1 })
    f.context.fake.gate.release.mockImplementation(() => {
      if (released) return
      released = true
      f.context.fake.gate.waiting = 0
      f.context.fake.requests.push('embedding')
      if (outcome === 'rejected') pending.reject(original)
      else pending.resolve({ success: true, docId: 'fictional-document', chunkCount: 1 })
    })
    f.context.invoke.mockImplementation(async (_page, channel) => {
      if (channel === 'dialog:select-knowledge-files') return [{ grantId: 'fictional-file-grant' }]
      if (channel === 'kb:import-document') return pending.promise
      if (channel === 'kb:list-documents') return outcome === 'wrapped-documents'
        ? { success: true, data: [{ id: 'fictional-document', chunkCount: 1 }] }
        : [{ id: 'fictional-document', chunkCount: 1 }]
      throw new Error('UNEXPECTED_FIXTURE_CHANNEL')
    })
    const result = runPerformancePressureScenario('perf-slow-embedding', f.context, f.dependencies)
      .then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.context.fake.gate.release).not.toHaveBeenCalled()
    expect(f.dependencies.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(outcome === 'not-gated' ? 28_002 : 301)
    const settled = await result
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/performance-pressure-fiction\.txt$/u), expect.stringContaining('fictional cartographer'), 'utf8')
    expect(f.context.fake.gate.hold).toHaveBeenCalledWith({ embeddings: true })
    expect(f.context.fake.gate.release).toHaveBeenCalled()
    expect(f.context.invoke).toHaveBeenCalledWith(f.context.page, 'kb:import-document', 'fictional-file-grant', '/fiction',
      { projectId: 'fiction', projectPath: '/fiction', leaseId: 'fixture-lease' })
    if (outcome === 'success') {
      expect(settled.value.task).toMatchObject({ attempted: 1, failed: 0, settled: 1, importedDocuments: 1, importedChunks: 1 })
      expect(settled.value.fixtureAcceptedRequests).toBe(1)
      expect(f.context.invoke).toHaveBeenCalledWith(f.context.page, 'kb:list-documents', '/fiction', expect.objectContaining({ leaseId: 'fixture-lease' }))
    } else {
      expect(settled.error.performanceBaseline).toMatchObject({ failed: 1, failureStage: 'producer', cleanupFailures: 0 })
      if (outcome === 'rejected') {
        expect(settled.error.cause).toBe(original)
        expect(settled.error.performanceBaseline.task).toMatchObject({ attempted: 1, failed: 1, settled: 1 })
        expect(f.context.invoke.mock.calls.map(call => call[1])).not.toContain('kb:list-documents')
        expect(JSON.stringify(settled.error.performanceBaseline)).not.toContain('private-embedding-rejection')
      } else expect(settled.error.cause.code).toBe('ERR_ASSERTION')
    }
    expect(f.dependencies.stop).toHaveBeenCalledOnce()
    expect(f.context.fake.gate.release.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.stop.mock.invocationCallOrder[0])
    expect(f.dependencies.cancel).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not accept an unexpected retry count as successful rate-limit evidence', async () => {
    const f = fixture('perf-rate-limit')
    f.requests.byRoute['/v1/chat/completions'].count = 2
    await expect(runPerformancePressureScenario('perf-rate-limit', f.context, f.dependencies)).rejects.toMatchObject({
      performanceBaseline: { failureStage: 'evidence', failed: 1 },
    })
  })

  it.each(['coverage-missing', 'main-unavailable', 'renderer-unavailable', 'heartbeat', 'rss', 'event-loop', 'stop-error'])('rejects %s instead of relabelling lost evidence n/a', async corruption => {
    const f = fixture('perf-slow-embedding'), m = f.m
    if (corruption === 'coverage-missing') delete m.coverage
    if (corruption === 'main-unavailable') { m.main = null; m.coverage.main = 'unavailable'; m.stopFailures.main = 1 }
    if (corruption === 'renderer-unavailable') { m.renderer = null; m.coverage.renderer = 'unavailable'; m.stopFailures.renderer = 1 }
    if (corruption === 'heartbeat') m.renderer.heartbeat.count = 0
    if (corruption === 'rss') m.main.memory.rssSamples = 0
    if (corruption === 'event-loop') m.main.eventLoop.count = 0
    if (corruption === 'stop-error') m.stopFailures.renderer = 1
    await expect(runPerformancePressureScenario('perf-slow-embedding', f.context, f.dependencies)).rejects.toMatchObject({
      performanceBaseline: { failed: 1 },
    })
  })

  it('preserves the original producer error together with cleanup failures without copying either into the report', async () => {
    const f = fixture()
    const original = new Error('private-original'), cleanup = new Error('private-stop')
    f.dependencies.work.mockRejectedValue(original)
    f.dependencies.stop.mockRejectedValue(cleanup)
    let caught
    try { await runPerformancePressureScenario('perf-long-stream', f.context, f.dependencies) } catch (error) { caught = error }
    expect(caught.cause.errors).toEqual([original, cleanup])
    expect(caught.performanceBaseline).toMatchObject({ failed: 1, failureStage: 'producer', cleanupFailures: 1 })
    expect(JSON.parse(JSON.stringify(caught.performanceBaseline)).failureDiagnostics).toEqual([
      { source: 'scenario', stage: 'producer', errorClass: 'Error', code: 'UNCLASSIFIED_ERROR' },
      { source: 'cleanup', stage: 'probe_stop', errorClass: 'Error', code: 'UNCLASSIFIED_ERROR' },
    ])
    expect(JSON.stringify(caught.performanceBaseline)).not.toMatch(/private-original|private-stop/u)
    expect(f.context.fake.gate.release).toHaveBeenCalledOnce()
  })

  it('does not stop an unstarted probe, and still releases fixture controls after startup failure', async () => {
    const f = fixture()
    f.dependencies.start.mockRejectedValue(new Error('fixture-start-failed'))
    await expect(runPerformancePressureScenario('perf-long-stream', f.context, f.dependencies)).rejects.toMatchObject({
      performanceBaseline: { failureStage: 'probe_start', attempted: 1, failed: 1 },
    })
    expect(f.dependencies.stop).not.toHaveBeenCalled()
    expect(f.dependencies.work).not.toHaveBeenCalled()
    expect(f.context.fake.gate.release).toHaveBeenCalledOnce()
  })

  it.each([false, true])('cancels the actual owned RunCard on producer failure; cancel throws=%s', async throws => {
    const f = fixture(), original = new Error('original-producer'), cancelError = new Error('cancel-failed')
    delete f.dependencies.cancel
    const locator = { count: async () => 1, click: vi.fn(async () => { if (throws) throw cancelError }), evaluateAll: vi.fn(async () => []) }
    for (const method of ['getByRole', 'first']) locator[method] = () => locator
    f.context.page = { getByRole: () => locator }
    f.dependencies.work.mockImplementation(async (_kind, _context, state) => { state.workflowStarted = true; throw original })
    let caught
    try { await runPerformancePressureScenario('perf-long-stream', f.context, f.dependencies) } catch (error) { caught = error }
    expect(locator.click).toHaveBeenCalledOnce()
    expect(locator.evaluateAll).toHaveBeenCalledTimes(throws ? 0 : 1)
    expect(caught.performanceBaseline).toMatchObject({ failureStage: 'producer', failed: 1, cleanupFailures: Number(throws) })
    if (throws) expect(caught.cause.errors).toEqual([original, cancelError])
    else expect(caught.cause).toBe(original)
    const channels = f.context.invoke.mock.calls.map(call => call[1])
    expect(channels).toEqual(['generation:list'])
    expect(channels).not.toContain('generation:execute')
    expect(channels).not.toContain('generation:resume')
    expect(channels).not.toContain('generation:retry')
    expect(f.dependencies.stop.mock.invocationCallOrder[0]).toBeLessThan(f.context.invoke.mock.invocationCallOrder[0])
  })

  it('retains the before-quit request cutoff and rejects actual post-measurement increments', async () => {
    const f = fixture()
    const report = await runPerformancePressureScenario('perf-long-stream', f.context, f.dependencies)
    await f.context.finalizePerformanceEvidence()
    expect(report.requestSummaryCutoff).toBe('before_quit')
    expect(report.fixtureAcceptedRequests).toBe(0)
    expect(report.finalFixtureAcceptedRequests).toBe(0)
    expect(Object.values(report.requestsAfterMeasurement)).toEqual([0, 0, 0])
    const late = structuredClone(f.requests)
    late.byRoute['/v1/chat/completions'].count++
    f.dependencies.readRequests.mockResolvedValue(late)
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({
      performanceBaseline: { success: false, failed: 1, failureStage: 'final_request_summary', cleanupFailures: 1 },
    })
    expect(report.requestsAfterMeasurement['/v1/chat/completions']).toBe(1)
  })

  it('rejects newly accepted fixture HTTP work even before the guarded fetch summary settles', async () => {
    const f = fixture()
    const report = await runPerformancePressureScenario('perf-long-stream', f.context, f.dependencies)
    f.context.fake.requests.push('prose')
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({
      performanceBaseline: { success: false, failed: 1, fixtureAcceptedRequests: 0, finalFixtureAcceptedRequests: 1,
        failureStage: 'final_request_summary', cleanupFailures: 1 },
    })
    expect(Object.values(report.requestsAfterMeasurement)).toEqual([0, 0, 0])
    expect(JSON.parse(JSON.stringify(report)).failureDiagnostics).toEqual([
      { source: 'cleanup', stage: 'final_request_summary', errorClass: 'AssertionError', code: 'ERR_ASSERTION' },
    ])
  })

  it('does not let unavailable final evidence erase the original producer failure', async () => {
    const f = fixture()
    f.dependencies.work.mockRejectedValue(new Error('primary'))
    let original
    try { await runPerformancePressureScenario('perf-long-stream', f.context, f.dependencies) } catch (error) { original = error }
    f.dependencies.readRequests.mockResolvedValue({ coverage: 'unavailable', byRoute: {} })
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({
      performanceBaseline: { failed: 1, failureStage: 'producer', cleanupFailures: 1 },
    })
    expect(original.performanceBaseline.finalRequestSummary.coverage).toBe('unavailable')
    expect(original.performanceBaseline.success).toBe(false)
  })

  it('bounds a hanging producer, cancels only its captured handle, and never resumes an unknown attempt', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const handle = { projectId: 'fiction', epoch: 'epoch', rootActionId: 'root', runId: 'owned-run' }
    f.dependencies.work.mockImplementation(async (_kind, _context, state) => { state.handle = handle; await new Promise(() => {}) })
    f.context.invoke.mockResolvedValue({ artifacts: [], ledger: { physicalRequests: 1 }, budgetDiagnostics: [{ actualState: 'unknown' }] })
    const result = runPerformancePressureScenario('perf-long-stream', f.context, f.dependencies)
    const rejected = expect(result).rejects.toMatchObject({ performanceBaseline: { failureStage: 'producer', failed: 1 } })
    await vi.advanceTimersByTimeAsync(270_001)
    await rejected
    expect(f.dependencies.cancel).toHaveBeenCalledOnce()
    expect(f.dependencies.cancel.mock.calls[0][1].handle).toBe(handle)
    expect(f.context.invoke.mock.calls.map(call => call[1])).toEqual(['generation:read'])
    expect(f.context.fake.gate.release).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
