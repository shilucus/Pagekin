import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EMPTY_BOOK, inferenceReply, openAuthorImport, seedEmptyBook } from './import-infer-scenarios.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { appendPerformanceFailureDiagnostic, assertPerformanceProbeCoverage, boundedObservation, performanceMetadata, readModelRequestSummary, readPerformanceRunDiagnostics, startPerformanceBaseline, stopPerformanceBaseline, summarizeFixtureChats } from './performance-baseline.mjs'

export function performanceCorpus(chapters) {
  if (![10, 100, 1000].includes(chapters)) throw new Error('PERFORMANCE_CHAPTER_COUNT_UNSUPPORTED')
  const line = '沈默在雨夜里翻看卷宗，逐一核对证人的口供。窗外的电车缓缓经过，桌上的灯光照着一封没有署名的信。'
  return Array.from({ length: chapters }, (_, index) => `第${index + 1}章 雨夜记录\n${line.repeat(20)}\n`).join('\n')
}

export function corpusSha256(corpus) { return createHash('sha256').update(corpus, 'utf8').digest('hex') }

export async function cancelPerformanceImport(page, chapters) {
  let timer
  try {
    return await Promise.race([(async () => {
      await runSheet.sheet(page).waitFor({ state: 'visible', timeout: 5_000 })
      const title = `导入作者原稿（${chapters} 章）`
      const card = runSheet.anyCard(page).filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      await card.waitFor({ state: 'visible', timeout: 5_000 })
      const active = card.and(page.locator('[data-state="idle"], [data-state="running"], [data-state="waiting"], [data-state="paused"], [data-state="cancelling"]'))
      const requested = await active.count() > 0
      if (requested && await active.getAttribute('data-state') !== 'cancelling') {
        await active.getByRole('button', { name: `取消「${title}」`, exact: true }).click({ timeout: 5_000 })
      }
      // A terminal status can precede activeRuns cleanup; the uncaptained card must leave too.
      await page.waitForFunction(expectedTitle => [...document.querySelectorAll('.run-card')].every(node =>
        node.querySelector('h3')?.textContent !== expectedTitle || node.querySelector('.run-card-kicker')),
      title, { timeout: 25_000 })
      return { status: 'drained', cancellationRequested: requested }
    })(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PERFORMANCE_IMPORT_DRAIN_TIMEOUT')), 30_000)
    })])
  } finally { clearTimeout(timer) }
}

const requestCount = summary => summary?.coverage === 'guarded_fetch_attempts'
  ? Object.values(summary.byRoute).reduce((sum, row) => sum + row.count, 0) : null

async function trackPreparedImport(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('db:import-run-prepare-inspection')
    if (typeof original !== 'function') throw new Error('PERFORMANCE_IMPORT_OBSERVER_UNAVAILABLE')
    const observer = async (...args) => {
      const result = await original(...args)
      if (result?.success && typeof result.preparation?.run?.id === 'string') globalThis.__performancePreparedImportId = result.preparation.run.id
      return result
    }
    globalThis.__performanceImportObserver = { original, observer }
    globalThis.__performancePreparedImportId = null
    handlers.set('db:import-run-prepare-inspection', observer)
  })
}

async function stopTrackingPreparedImport(app) {
  return app.evaluate(({ ipcMain }) => {
    const state = globalThis.__performanceImportObserver
    if (state && ipcMain._invokeHandlers.get('db:import-run-prepare-inspection') === state.observer)
      ipcMain._invokeHandlers.set('db:import-run-prepare-inspection', state.original)
    const id = globalThis.__performancePreparedImportId
    delete globalThis.__performanceImportObserver
    delete globalThis.__performancePreparedImportId
    return typeof id === 'string' ? id : null
  })
}

export async function runPerformanceImportScenario(chapters, context, dependencies = {}) {
    const { app, page, roots, fake, invoke } = context
    const startProbe = dependencies.start ?? startPerformanceBaseline
    const stopProbe = dependencies.stop ?? stopPerformanceBaseline
    const readRequests = dependencies.readRequests ?? readModelRequestSummary
    const openImport = dependencies.openImport ?? openAuthorImport
    const waitDone = dependencies.waitDone ?? (async () => { await runSheet.waitUntilOpen(page); await runSheet.waitForRunDone(page, 600_000) })
    const cancelImport = dependencies.cancelImport ?? cancelPerformanceImport
    const metadata = performanceMetadata(chapters)
    let corpusHash = null, measurements = null, requestSummary = null, diagnostics = null, elapsedMs = null, fixtureAcceptedRequests = null, started = false, importedChapters = null, blueprintChapters = null
    let failureStage = null, stage = 'fixture', stopFailures = 0, trackingImport = false
    let originalError = null, workflowMayRun = false, drain = { status: 'not_needed', cancellationRequested: false }
    const cleanupErrors = []
    const failureDiagnostics = []
    const start = performance.now()
    try {
      const corpus = performanceCorpus(chapters)
      corpusHash = corpusSha256(corpus)
      const file = path.join(roots.temp, 'performance-manuscript.txt')
      fs.writeFileSync(file, corpus, 'utf8')
      fake.replyReview(inferenceReply)
      page.setDefaultTimeout(600_000)
      stage = 'runtime'
      metadata.appRuntime = await app.evaluate(() => ({ electron: process.versions.electron ?? null,
        node: process.versions.node ?? null, chrome: process.versions.chrome ?? null }))
      try { await trackPreparedImport(app); trackingImport = true } catch { /* Diagnostics remain unavailable. */ }
      stage = 'probe_start'
      await startProbe(app, page); started = true
      stage = 'preview'
      const dialog = await openImport(app, page, EMPTY_BOOK, file)
      assert.equal(await dialog.getByRole('checkbox', { name: /同时反推设定、架构、角色和蓝图/u }).isChecked(), true)
      stage = 'import'
      workflowMayRun = true
      await dialog.getByRole('button', { name: `确认导入（${chapters} 章）`, disabled: false }).click({ timeout: 600_000 })
      await dialog.waitFor({ state: 'hidden', timeout: 600_000 })
      stage = 'workflow'
      await waitDone()
      stage = 'verify'
      const session = await app.evaluate(() => globalThis.__driveOpened)
      assert.ok(session?.leaseId)
      const drafts = await invoke(page, 'db:draft-list-all', session.projectPath, session)
      assert.ok(Array.isArray(drafts), 'PERFORMANCE_DRAFT_READ_UNAVAILABLE')
      importedChapters = drafts.filter(draft => draft.status === 'finalized').length
      const blueprints = await invoke(page, 'db:blueprint-get-all', session.projectPath, session)
      assert.ok(Array.isArray(blueprints), 'PERFORMANCE_BLUEPRINT_READ_UNAVAILABLE')
      blueprintChapters = blueprints.length
      assert.equal(importedChapters, chapters); assert.equal(blueprintChapters, chapters)
    } catch (error) {
      failureStage = stage
      originalError = error
      appendPerformanceFailureDiagnostic(failureDiagnostics, error, 'scenario', stage)
    } finally {
      if (failureStage && workflowMayRun) {
        try { drain = await cancelImport(page, chapters) }
        catch (error) {
          drain = { status: 'unavailable', cancellationRequested: null }; cleanupErrors.push(error)
          appendPerformanceFailureDiagnostic(failureDiagnostics, error, 'cleanup', 'drain')
        }
      }
      let probeStopped = false
      try {
        if (started) {
          measurements = await stopProbe(app, page)
          stopFailures = measurements.stopFailures.main + measurements.stopFailures.renderer
          probeStopped = true
          assertPerformanceProbeCoverage(measurements)
        }
      } catch (error) {
        if (!probeStopped && !stopFailures) stopFailures++
        cleanupErrors.push(error)
        const failedStage = probeStopped && stopFailures === 0 ? 'probe_coverage' : 'probe_stop'
        appendPerformanceFailureDiagnostic(failureDiagnostics, error, 'cleanup', failedStage)
        if (!failureStage) failureStage = failedStage
      } finally {
        page.setDefaultTimeout(20_000)
      }
      elapsedMs = performance.now() - start
      try { requestSummary = await readRequests(app) }
      catch (error) {
        cleanupErrors.push(error); requestSummary = { coverage: 'unavailable', byRoute: {} }
        appendPerformanceFailureDiagnostic(failureDiagnostics, error, 'cleanup', 'request_summary')
      }
      fixtureAcceptedRequests = fake.requests.length
      if (requestSummary?.coverage !== 'guarded_fetch_attempts') {
        appendPerformanceFailureDiagnostic(failureDiagnostics, new Error('PERFORMANCE_REQUEST_SUMMARY_UNAVAILABLE'), 'cleanup', 'request_summary')
        if (!failureStage) failureStage = 'request_summary'
      }
      let diagnosticSession = null
      let preparedImportId = null
      if (trackingImport) {
        try { preparedImportId = await boundedObservation(() => stopTrackingPreparedImport(app)) } catch { /* Keep the original scenario result. */ }
      }
      if (workflowMayRun) {
        try { diagnosticSession = await boundedObservation(() => app.evaluate(() => globalThis.__driveOpened)) } catch { /* Report unavailable without replacing the scenario failure. */ }
      }
      diagnostics = await readPerformanceRunDiagnostics(context, diagnosticSession, workflowMayRun, preparedImportId)
    }
    const eventCoverage = {
      importInspection: measurements?.main?.metrics?.metrics?.['import.inspect.calls']?.count > 0 ? 'observed' : 'not_observed',
      rendererSnapshots: measurements?.renderer?.metrics?.['renderer.snapshot.accepted']?.count > 0 ? 'observed' : 'not_observed',
    }
    if (!failureStage && Object.values(eventCoverage).some(value => value !== 'observed')) {
      failureStage = 'event_coverage'
      appendPerformanceFailureDiagnostic(failureDiagnostics, new Error('PERFORMANCE_EVENT_COVERAGE_MISSING'), 'scenario', 'event_coverage')
    }
    const report = { metadata, corpusSha256: corpusHash, importedChapters, blueprintChapters,
      elapsedMs, fixtureAcceptedRequests, requestSummary,
      countCoverage: { importedChapters: importedChapters === null ? 'unavailable' : 'observed', blueprintChapters: blueprintChapters === null ? 'unavailable' : 'observed' },
      cleanupFailures: cleanupErrors.length, failureDiagnostics, drain, eventCoverage, diagnostics,
      fixtureParameters: summarizeFixtureChats(fake.chats),
      requestSummaryCutoff: 'after_drain_and_probe_stop', finalRequestSummary: null, requestsAfterMeasurement: null,
      finalFixtureAcceptedRequests: null,
      requestEvidence: 'local_observation_not_proof_of_remote_execution',
      success: failureStage === null, attempted: 1, failed: failureStage === null ? 0 : 1, failureStage, stopFailures, measurements,
      concurrency: { 1: 'executed', 2: 'unsupported_not_executed', 4: 'unsupported_not_executed' },
      thresholds: { target100Ms: 'candidate_only', target500Ms: 'candidate_only' } }
    // The driver calls this after failure capture, immediately before quitting the isolated app.
    context.finalizePerformanceEvidence = async () => {
      try {
        report.finalRequestSummary = await readRequests(app)
        report.finalFixtureAcceptedRequests = fake.requests.length
        const before = requestCount(requestSummary), final = requestCount(report.finalRequestSummary)
        report.requestsAfterMeasurement = before === null || final === null ? null : final - before
        assert.ok(report.requestsAfterMeasurement !== null && report.requestsAfterMeasurement === 0, 'PERFORMANCE_REQUEST_CUTOFF_CHANGED')
        assert.equal(report.finalFixtureAcceptedRequests, report.fixtureAcceptedRequests, 'PERFORMANCE_FIXTURE_REQUEST_CUTOFF_CHANGED')
      } catch (error) {
        report.cleanupFailures++
        report.failureStage ??= 'final_request_summary'
        report.success = false; report.failed = 1
        appendPerformanceFailureDiagnostic(failureDiagnostics, error, 'cleanup', 'final_request_summary')
        const failure = new Error('PERFORMANCE_FINAL_REQUEST_SUMMARY_FAILED', { cause: error })
        failure.performanceBaseline = report
        throw failure
      } finally { report.requestSummaryCutoff = 'before_quit' }
    }
    if (failureStage) {
      const causes = [originalError, ...cleanupErrors].filter(Boolean)
      const error = new Error(`PERFORMANCE_SCENARIO_FAILED:${failureStage}`, { cause: causes.length === 1 ? causes[0] : new AggregateError(causes) })
      error.performanceBaseline = report
      throw error
    }
    return report
}

function scenario(chapters) {
  return { performance: true, model: true, shell: 'stage', timeout: 600_000, setup: seedEmptyBook,
    run: context => runPerformanceImportScenario(chapters, context) }
}

export const PERFORMANCE_SCENARIOS = Object.fromEntries([10, 100, 1000].map(chapters => [`perf-import-${chapters}`, scenario(chapters)]))
