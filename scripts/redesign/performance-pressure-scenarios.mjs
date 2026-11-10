import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FAKE_MODEL, streamingProse } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits } from './stage-sample.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { appendPerformanceFailureDiagnostic, assertPerformanceProbeCoverage, performanceMetadata, readModelRequestSummary, readPerformanceRunDiagnostics, startPerformanceBaseline, stopPerformanceBaseline, summarizeFixtureChats } from './performance-baseline.mjs'

const KINDS = ['perf-long-stream', 'perf-slow-embedding', 'perf-rate-limit']
const LONG_CHUNKS = streamingProse(400, 24)
const REASONING = Array.from({ length: 20 }, () => 'Fictional reasoning event. ')
const EMBEDDING_TEXT = 'A fictional cartographer checks a harbor lantern against an imaginary tide chart. No real manuscript is used.'
const EMBEDDING_MODEL = { ...FAKE_MODEL, id: 'pressure-embedding', modelName: 'text-embedding-3-small', purposes: ['embedding'] }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const assertProducerActive = state => assert.notEqual(state.stopped, true, 'PERFORMANCE_PRESSURE_PRODUCER_STOPPED')

async function bounded(operation, ms = 270_000) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PERFORMANCE_PRESSURE_TIMEOUT')), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function setup(context, kind) {
  // Observe the actual successful UI open receipt; never fabricate a project lease.
  await context.app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project:open')
    if (!original) throw new Error('PERFORMANCE_PRESSURE_OPEN_HANDLER_MISSING')
    globalThis.__pressureOpenOriginal = original
    ipcMain._invokeHandlers.set('project:open', async (event, root, ...args) => {
      const result = await original(event, root, ...args)
      if (result?.success) globalThis.__pressureSession = {
        projectId: result.project.id, projectPath: root, leaseId: result.project.sessionLease,
      }
      return result
    })
  })
  try {
    await seedStageSample(context, { beforeReload: async ({ page, invoke, path: root, session }) => {
      if (kind === 'perf-long-stream') {
        assert.equal((await invoke(page, 'db:project-core-update', { wordsPerChapter: countUnits(LONG_CHUNKS.join('')) }, root, session)).success, true)
        assert.equal((await invoke(page, 'llm:save-model', { ...FAKE_MODEL, maxTokens: 32768 })).success, true)
      }
      if (kind === 'perf-slow-embedding') {
        assert.equal((await invoke(page, 'llm:save-model', EMBEDDING_MODEL)).success, true)
        assert.equal((await invoke(page, 'llm:set-default-embedding-model', EMBEDDING_MODEL.id)).success, true)
      }
    } })
  } finally {
    await context.app.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('project:open', globalThis.__pressureOpenOriginal)
      delete globalThis.__pressureOpenOriginal
    })
  }
}

async function generationWork(kind, context, state) {
  const { page, invoke, fake } = context
  const before = new Set((await invoke(page, 'generation:list', state.session)).map(run => run.handle.runId))
  assertProducerActive(state)
  if (kind === 'perf-long-stream') fake.streamProse({ chunks: LONG_CHUNKS, intervalMs: 15,
    reasoningChunks: REASONING, reasoningIntervalMs: 10 })
  else fake.rejectRateLimit()
  await blueprint.open(page)
  assertProducerActive(state)
  state.workflowStarted = true
  await blueprint.writeNext(page)
  assertProducerActive(state)
  await runSheet.waitUntilOpen(page)
  assertProducerActive(state)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const run = (await invoke(page, 'generation:list', state.session))
      .find(item => item.operation === 'chapter-draft' && !before.has(item.handle.runId))
    assertProducerActive(state)
    if (run) {
      state.handle = run.handle
      break
    }
    await delay(100)
    assertProducerActive(state)
  }
  assert.ok(state.handle, 'PERFORMANCE_PRESSURE_RUN_MISSING')
  if (kind === 'perf-long-stream') await runSheet.waitForRunDone(page, 240_000)
  else await runSheet.lastRun(page).getByText(/失败|未完成|出错|Failed/).first().waitFor({ state: 'visible', timeout: 240_000 })
  assertProducerActive(state)
  const view = await invoke(page, 'generation:read', state.handle, state.session)
  assertProducerActive(state)
  state.task = taskSummary(view)
  assert.ok(view.budgetDiagnostics?.length, 'PERFORMANCE_PRESSURE_NO_ATTEMPT')
  if (kind === 'perf-long-stream') {
    assert.ok(view.budgetDiagnostics.every(item => item.actualState === 'settled'), 'PERFORMANCE_PRESSURE_UNKNOWN_ATTEMPT')
    assert.ok(view.artifacts.some(item => item.text === LONG_CHUNKS.join('') && item.status === 'completed'), 'PERFORMANCE_PRESSURE_ARTIFACT_MISMATCH')
    assert.ok(view.artifacts.every(item => !item.text.includes(REASONING[0])))
    assert.equal(fake.streamLog.length, LONG_CHUNKS.length)
    assert.equal(view.ledger.physicalRequests, 2)
  } else {
    assert.equal(view.ledger.physicalRequests, 1)
    assert.equal(view.budgetDiagnostics.length, 1)
    assert.equal(view.budgetDiagnostics[0].failureCode, 'GENERATION_PROVIDER_FAILED')
    assert.equal(view.budgetDiagnostics[0].actualState, 'unknown')
    assert.equal(state.task.settled, 0)
    assert.equal(state.task.unknown, 1)
    assert.equal(view.artifacts.length, 1)
    assert.equal(typeof view.budgetDiagnostics[0].attemptId, 'string')
    assert.ok(view.budgetDiagnostics[0].attemptId.length > 0)
    assert.equal(view.artifacts[0].attemptId, view.budgetDiagnostics[0].attemptId)
    assert.equal(view.artifacts[0].text, '')
    assert.equal(view.artifacts[0].status, 'failed')
    assert.equal(view.artifacts[0].compositionEligible, false)
  }
  state.task = taskSummary(view)
}

function taskSummary(view) {
  const attempts = view.budgetDiagnostics ?? []
  return { attempted: attempts.length, failed: attempts.filter(item => item.failureCode).length,
    settled: attempts.filter(item => item.actualState === 'settled').length,
    unknown: attempts.filter(item => item.actualState === 'unknown').length,
    reserved: attempts.filter(item => item.actualState === 'reserved').length,
    artifactCount: view.artifacts.length, physicalRequests: view.ledger.physicalRequests }
}

async function embeddingWork(_kind, context, state) {
  const { app, page, roots, invoke, fake } = context
  const file = path.join(roots.temp, 'performance-pressure-fiction.txt')
  fs.writeFileSync(file, EMBEDDING_TEXT, 'utf8')
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, file)
  assertProducerActive(state)
  const grants = await invoke(page, 'dialog:select-knowledge-files')
  assertProducerActive(state)
  assert.equal(grants?.length, 1)
  fake.gate.hold({ embeddings: true })
  state.task = { attempted: 1, failed: 0, settled: 0 }
  // Attach both handlers immediately so a gate/timeout failure cannot leak an unhandled rejection.
  state.pending = invoke(page, 'kb:import-document', grants[0].grantId, state.session.projectPath, state.session)
    .then(value => { state.task.failed = value?.success ? 0 : 1; state.task.settled = 1; return { value } },
      error => { state.task.failed = 1; state.task.settled = 1; return { error } })
  const deadline = Date.now() + 30_000
  while (!fake.gate.waiting && Date.now() < deadline) await delay(50)
  assertProducerActive(state)
  assert.ok(fake.gate.waiting > 0, 'PERFORMANCE_PRESSURE_EMBEDDING_NOT_GATED')
  await delay(2000)
  assertProducerActive(state)
  fake.gate.release()
  const settled = await bounded(() => state.pending, 30_000)
  assertProducerActive(state)
  if (settled.error) throw settled.error
  assert.equal(settled.value?.success, true, 'PERFORMANCE_PRESSURE_IMPORT_FAILED')
  assert.equal(settled.value.chunkCount, 1)
  const documents = await invoke(page, 'kb:list-documents', state.session.projectPath, state.session)
  assertProducerActive(state)
  assert.ok(Array.isArray(documents), 'PERFORMANCE_PRESSURE_DOCUMENT_LIST_INVALID')
  assert.ok(documents.some(item => item.id === settled.value.docId && item.chunkCount === 1), 'PERFORMANCE_PRESSURE_DOCUMENT_MISSING')
  assert.equal(fake.requests.filter(kind => kind === 'embedding').length, 1)
  state.task = { attempted: 1, failed: 0, settled: 1, importedDocuments: 1, importedChunks: 1 }
}

function metric(measurements, name) { return measurements?.main?.metrics?.metrics?.[name]?.sum ?? 0 }

async function cancelOwnedWorkflow(context) {
  const buttons = runSheet.sheet(context.page).getByRole('button', { name: /^取消「/ })
  const count = await buttons.count()
  assert.ok(count <= 1, 'PERFORMANCE_PRESSURE_WORKFLOW_OWNERSHIP_AMBIGUOUS')
  if (count) await buttons.first().click()
  const deadline = Date.now() + 25_000
  while ((await runSheet.activeTitles(context.page)).length > 0) {
    assert.ok(Date.now() < deadline, 'PERFORMANCE_PRESSURE_WORKFLOW_DRAIN_TIMEOUT')
    await delay(50)
  }
}

function verifyMeasurements(kind, measurements, requests) {
  assert.equal(requests?.coverage, 'guarded_fetch_attempts')
  assert.ok(measurements?.main?.memory?.rssSamples > 0, 'PERFORMANCE_PRESSURE_MAIN_PROBE_MISSING')
  assert.ok(measurements.main.eventLoop?.count > 0, 'PERFORMANCE_PRESSURE_EVENT_LOOP_EMPTY')
  assert.ok(measurements.renderer?.heartbeat?.count > 0, 'PERFORMANCE_PRESSURE_RENDERER_PROBE_MISSING')
  const chat = requests.byRoute['/v1/chat/completions'], embedding = requests.byRoute['/v1/embeddings']
  if (kind === 'perf-slow-embedding') {
    assert.equal(chat.count, 0); assert.equal(embedding.count, 1); assert.equal(embedding.failed, 0)
    assert.ok(embedding.maxMs >= 1500, 'PERFORMANCE_PRESSURE_EMBEDDING_NOT_SLOW')
  } else if (kind === 'perf-rate-limit') {
    assert.equal(chat.count, 1); assert.equal(chat.http429, 1); assert.equal(chat.failed, 1)
    assert.equal(metric(measurements, 'transport.http_429'), 1)
    assert.equal(metric(measurements, 'transport.requests'), 1)
  } else {
    assert.equal(chat.count, 2); assert.equal(chat.failed, 0)
    assert.equal(metric(measurements, 'transport.requests'), 2)
    assert.ok(metric(measurements, 'transport.visible.events') >= LONG_CHUNKS.length)
    assert.equal(metric(measurements, 'transport.reasoning.events'), REASONING.length)
    for (const name of ['transport.first_response.ms', 'transport.first_reasoning.ms', 'transport.first_visible.ms',
      'generation.snapshot.calls', 'generation.snapshot.utf8_bytes', 'ipc.snapshot.calls', 'ipc.snapshot.utf8_bytes']) {
      assert.ok(measurements.main.metrics.metrics[name]?.count > 0, `PERFORMANCE_PRESSURE_METRIC_MISSING:${name}`)
    }
    for (const name of ['renderer.snapshot.accepted', 'renderer.snapshot.utf8_bytes', 'renderer.snapshot.queue',
      'renderer.snapshot.queue_ms', 'renderer.snapshot.hash_ms', 'renderer.snapshot.processing_ms', 'renderer.snapshot.total_ms']) {
      assert.ok(measurements.renderer.metrics[name]?.count > 0, `PERFORMANCE_PRESSURE_METRIC_MISSING:${name}`)
    }
    assert.equal(metric(measurements, 'generation.usage.known') + metric(measurements, 'generation.usage.unknown'), 2)
  }
}

export async function runPerformancePressureScenario(kind, context, dependencies = {}) {
  if (!KINDS.includes(kind)) throw new Error('PERFORMANCE_PRESSURE_KIND_INVALID')
  const start = dependencies.start ?? startPerformanceBaseline
  const stop = dependencies.stop ?? stopPerformanceBaseline
  const readRequests = dependencies.readRequests ?? readModelRequestSummary
  const work = dependencies.work ?? (kind === 'perf-slow-embedding' ? embeddingWork : generationWork)
  const verify = dependencies.verify ?? verifyMeasurements
  const state = { pending: null, session: null, handle: null, task: { attempted: 0, failed: 0, settled: 0 } }
  const report = { metadata: performanceMetadata(12), scenario: kind, attempted: 1, failed: 0, success: false,
    failureStage: null, cleanupFailures: 0, failureDiagnostics: [], measurements: null, requestSummary: null, task: null, diagnostics: null,
    finalRequestSummary: null, requestsAfterMeasurement: null, requestSummaryCutoff: 'after_drain_probe_stop',
    fixtureAcceptedRequests: null, finalFixtureAcceptedRequests: null,
    fixture: { kind: 'local-openai-compatible-fiction', protocol: 'openai', model: kind === 'perf-slow-embedding' ? EMBEDDING_MODEL.modelName : FAKE_MODEL.modelName,
      temperature: kind === 'perf-slow-embedding' ? null : FAKE_MODEL.temperature,
      configuredMaxTokens: kind === 'perf-long-stream' ? 32768 : kind === 'perf-rate-limit' ? FAKE_MODEL.maxTokens : null,
      skill: 'isolated-fixture-default-no-custom-install',
      corpusSha256: sha256(kind === 'perf-long-stream' ? LONG_CHUNKS.join('') : kind === 'perf-slow-embedding' ? EMBEDDING_TEXT : 'local-http-429'),
      visibleChunks: kind === 'perf-long-stream' ? LONG_CHUNKS.length : 0,
      reasoningChunks: kind === 'perf-long-stream' ? REASONING.length : 0,
      intervalMs: kind === 'perf-long-stream' ? 15 : null, embeddingHoldMs: kind === 'perf-slow-embedding' ? 2000 : null,
      postProducerObservationMs: 250,
      usage: kind === 'perf-rate-limit' ? 'not_available_http429' : kind === 'perf-slow-embedding' ? 'not_available_from_embedding_fixture'
        : 'fixed-fictional-400-input-200-completion-32-reasoning-when-present-not-real-billing' },
    requestEvidence: 'local-guarded-fetch-observation-not-remote-execution',
    notApplicable: kind === 'perf-slow-embedding' ? ['generation-snapshots', 'renderer-snapshot-queue', 'reasoning', 'first-visible', 'generation-token-usage']
      : kind === 'perf-rate-limit' ? ['reasoning', 'first-visible', 'successful-generation-token-usage', 'visible-artifact'] : [],
    limitations: ['fixed-fictional-provider-output-not-literary-quality', 'cache-uncontrolled', 'no-real-model', 'single-book-only'],
    concurrency: { 1: 'executed', 2: 'unsupported_not_executed', 4: 'unsupported_not_executed' } }
  const beganAt = performance.now()
  context.finalizePerformanceEvidence = async () => {
    let finalFailure
    try {
      report.finalRequestSummary = await bounded(() => readRequests(context.app), 10_000)
      assert.ok(Array.isArray(context.fake.requests), 'PERFORMANCE_FIXTURE_REQUEST_CUTOFF_CHANGED')
      report.finalFixtureAcceptedRequests = context.fake.requests.length
      report.requestSummaryCutoff = 'before_quit'
      assert.equal(report.requestSummary?.coverage, 'guarded_fetch_attempts')
      assert.equal(report.finalRequestSummary?.coverage, 'guarded_fetch_attempts')
      report.requestsAfterMeasurement = Object.fromEntries(['/v1/chat/completions', '/v1/embeddings', '/v1/messages'].map(route => [route,
        report.finalRequestSummary.byRoute[route].count - report.requestSummary.byRoute[route].count]))
      assert.ok(Object.values(report.requestsAfterMeasurement).every(count => count === 0), 'PERFORMANCE_PRESSURE_LATE_REQUESTS')
      assert.equal(report.finalFixtureAcceptedRequests, report.fixtureAcceptedRequests, 'PERFORMANCE_FIXTURE_REQUEST_CUTOFF_CHANGED')
    } catch (error) { finalFailure = error }
    if (finalFailure) {
      appendPerformanceFailureDiagnostic(report.failureDiagnostics, finalFailure, 'cleanup', 'final_request_summary')
      report.success = false; report.failed = 1; report.failureStage ??= 'final_request_summary'; report.cleanupFailures++
      const error = new Error('PERFORMANCE_PRESSURE_FINAL_REQUEST_EVIDENCE_FAILED', { cause: finalFailure })
      error.performanceBaseline = report
      throw error
    }
  }
  let failure, stage = 'session', started = false, finished = false
  const cleanupErrors = []
  try {
    state.session = await (dependencies.session ?? (() => context.app.evaluate(() => globalThis.__pressureSession)))()
    assert.ok(state.session?.leaseId, 'PERFORMANCE_PRESSURE_SESSION_MISSING')
    report.metadata.appRuntime = await (dependencies.runtime ?? (() => context.app.evaluate(() => ({ electron: process.versions.electron ?? null,
      node: process.versions.node, chrome: process.versions.chrome ?? null }))))()
    stage = 'probe_start'
    await start(context.app, context.page); started = true
    stage = 'producer'
    await bounded(() => work(kind, context, state))
    await delay(250)
    finished = true
  } catch (error) {
    failure = error; report.failureStage = stage
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', stage)
  }
  state.stopped = true
  const cleanupFailure = (error, failedStage) => {
    cleanupErrors.push(error)
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'cleanup', failedStage)
  }
  try { context.fake.gate.release() } catch (error) { cleanupFailure(error, 'drain') }
  if (!finished && (state.workflowStarted || state.handle)) {
    try { await bounded(() => (dependencies.cancel ?? cancelOwnedWorkflow)(context, state), 30_000) }
    catch (error) { cleanupFailure(error, 'drain') }
  }
  if (state.pending) {
    try { await bounded(() => state.pending, 15_000) } catch (error) { cleanupFailure(error, 'drain') }
  }
  if (!finished && state.handle) {
    try { state.task = taskSummary(await bounded(() => context.invoke(context.page, 'generation:read', state.handle, state.session), 10_000)) }
    catch (error) { cleanupFailure(error, 'drain') }
  }
  try { context.fake.rejectRateLimit(false); context.fake.streamProse(null) }
  catch (error) { cleanupFailure(error, 'cleanup') }
  if (started) {
    let failedStage = 'probe_stop'
    try {
      report.measurements = await bounded(() => stop(context.app, context.page), 15_000)
      failedStage = 'probe_coverage'
      assertPerformanceProbeCoverage(report.measurements)
      if (kind === 'perf-rate-limit' && report.measurements.coverage.renderer === 'live_zero_events') report.notApplicable.push('renderer-snapshot-queue')
    } catch (error) { cleanupFailure(error, failedStage) }
  }
  report.elapsedMs = performance.now() - beganAt
  try {
    report.requestSummary = await bounded(() => readRequests(context.app), 10_000)
    assert.ok(Array.isArray(context.fake.requests), 'PERFORMANCE_FIXTURE_REQUEST_CUTOFF_CHANGED')
    report.fixtureAcceptedRequests = context.fake.requests.length
  } catch (error) { cleanupFailure(error, 'request_summary') }
  report.diagnostics = await readPerformanceRunDiagnostics(context, state.session, state.workflowStarted === true)
  if (state.handle) {
    const own = report.diagnostics.generation.runs.find(run => run.runId === state.handle.runId)
    state.task = { ...state.task, frozenInitialTaskSha256: own?.initialDraftTaskHash ?? null }
    if (kind === 'perf-long-stream' && finished && !failure && !cleanupErrors.length) {
      try { assert.ok(own?.attempts?.items.some(attempt => attempt.purpose === 'chapter-draft'), 'PERFORMANCE_PRESSURE_PURPOSE_UNAVAILABLE') }
      catch (error) { failure = error; report.failureStage = 'evidence'; appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', 'evidence') }
    }
  }
  if (!failure && !cleanupErrors.length) {
    try { verify(kind, report.measurements, report.requestSummary) }
    catch (error) {
      failure = error; report.failureStage = 'evidence'
      appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', 'evidence')
    }
  }
  report.task = state.task
  report.fixture.dispatchedParameters = (context.fake.chats ?? []).slice(0, 32).map(chat => ({
    maxTokens: Number.isSafeInteger(chat.maxTokens) ? chat.maxTokens : null,
    temperature: typeof chat.temperature === 'number' && Number.isFinite(chat.temperature) ? chat.temperature : null,
    messagesSha256: sha256(JSON.stringify(chat.messages)),
  }))
  const httpParameters = summarizeFixtureChats(context.fake.chats)
  report.fixtureParameters = kind === 'perf-rate-limit' || kind === 'perf-slow-embedding'
    ? { ...summarizeFixtureChats(null), coverage: kind === 'perf-rate-limit' ? 'not_available_http429' : 'not_applicable_embedding' }
    : httpParameters
  report.fixture.dispatchedParametersObserved = httpParameters.observed
  report.fixture.dispatchedParametersRetained = httpParameters.retained
  report.fixture.dispatchedParametersCoverage = kind === 'perf-rate-limit' ? 'not_available_http429'
    : kind === 'perf-slow-embedding' ? 'not_applicable_embedding' : httpParameters.coverage
  report.cleanupFailures = cleanupErrors.length
  report.failed = failure || cleanupErrors.length ? 1 : 0
  report.success = report.failed === 0
  if (!report.success) {
    report.failureStage ??= 'cleanup'
    const causes = [...(failure ? [failure] : []), ...cleanupErrors]
    const error = new Error(`PERFORMANCE_PRESSURE_FAILED:${report.failureStage}`, {
      cause: causes.length === 1 ? causes[0] : new AggregateError(causes, 'PERFORMANCE_PRESSURE_ORIGINAL_AND_CLEANUP_FAILURES'),
    })
    error.performanceBaseline = report
    throw error
  }
  return report
}

export const PERFORMANCE_PRESSURE_SCENARIOS = Object.fromEntries(KINDS.map(kind => [kind, {
  performance: true, model: true, shell: 'stage', timeout: 360_000,
  setup: context => setup(context, kind), run: context => runPerformancePressureScenario(kind, context),
}]))
