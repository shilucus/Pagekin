import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { countDraftUnits } from '../../src/shared/draft-units.ts'
import * as stage from './pages/stage.mjs'
import { corpusSha256, performanceCorpus } from './performance-scenarios.mjs'
import { appendPerformanceFailureDiagnostic, assertPerformanceProbeCoverage, boundedObservation,
  performanceMetadata, readModelRequestSummary, startPerformanceBaseline, stopPerformanceBaseline } from './performance-baseline.mjs'
import { setupParseProject, validateInspection, validateReference } from './performance-parse-scenarios.mjs'

const BOOK = '解析测量作品'
const CHAPTERS = 1000
const SELECTION_PROMISE = '__inspectionLifecycleSelectionPromise'
const CLOSE_PROMISE = '__inspectionLifecycleClosePromise'
const OBSERVATION_TIMEOUT_MS = 15_000
const CHOOSER_HOLD_MS = 50
const METRICS_WITHOUT_SELECTION = ['import.read.ms', 'import.parse.ms', 'import.hash.ms', 'import.save.ms']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function networkCounts(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests) || !Array.isArray(globalThis.__driveExternalRequests)) {
      throw new Error('PERFORMANCE_INSPECTION_NETWORK_COVERAGE_MISSING')
    }
    return { model: globalThis.__driveModelRequests.length, external: globalThis.__driveExternalRequests.length }
  })
}

async function installChooser(app, file, cancelled) {
  await app.evaluate(({ dialog }, selection) => {
    if (globalThis.__inspectionLifecycleChooser) throw new Error('PERFORMANCE_INSPECTION_CHOOSER_ALREADY_SET')
    const original = dialog.showOpenDialog
    const state = { original, entered: false, released: false }
    const replacement = async () => {
      state.entered = true
      if (selection.cancelled) return { canceled: true, filePaths: [] }
      return new Promise(resolve => { state.resolve = resolve })
    }
    state.replacement = replacement
    globalThis.__inspectionLifecycleChooser = state
    dialog.showOpenDialog = replacement
  }, { file, cancelled })
}

async function releaseChooser(app, result) {
  await app.evaluate((_event, chooserResult) => {
    const state = globalThis.__inspectionLifecycleChooser
    if (!state) throw new Error('PERFORMANCE_INSPECTION_CHOOSER_MISSING')
    if (state.released) return
    state.released = true
    if (state.resolve) state.resolve(chooserResult)
  }, result)
}

async function restoreChooser(app) {
  await app.evaluate(({ dialog }) => {
    const state = globalThis.__inspectionLifecycleChooser
    if (!state || dialog.showOpenDialog !== state.replacement) throw new Error('PERFORMANCE_INSPECTION_CHOOSER_CHANGED')
    dialog.showOpenDialog = state.original
    delete globalThis.__inspectionLifecycleChooser
  })
}

async function chooserEntered(app) {
  return app.evaluate(() => globalThis.__inspectionLifecycleChooser?.entered === true)
}

async function chooserHeld(app) {
  return app.evaluate(() => {
    const state = globalThis.__inspectionLifecycleChooser
    return state?.entered === true && state.released === false
  })
}

async function installCloseObserver(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('db:close')
    if (typeof original !== 'function' || globalThis.__inspectionLifecycleClose) {
      throw new Error('PERFORMANCE_INSPECTION_CLOSE_HANDLER_INVALID')
    }
    const state = { original, entered: false, forwarded: false, completed: false, result: null }
    const observer = (...args) => {
      state.entered = true
      let pending
      try {
        pending = original(...args)
        state.forwarded = true
      } catch (error) {
        state.forwarded = true
        state.completed = true
        throw error
      }
      return Promise.resolve(pending).then(result => {
        state.result = result
        state.completed = true
        return result
      }, error => {
        state.completed = true
        throw error
      })
    }
    state.observer = observer
    globalThis.__inspectionLifecycleClose = state
    handlers.set('db:close', observer)
  })
}

async function closeState(app) {
  return app.evaluate(() => {
    const state = globalThis.__inspectionLifecycleClose
    return state ? { entered: state.entered, forwarded: state.forwarded,
      completed: state.completed, result: state.result } : null
  })
}

async function restoreCloseObserver(app) {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis.__inspectionLifecycleClose
    if (!state || ipcMain._invokeHandlers.get('db:close') !== state.observer) {
      throw new Error('PERFORMANCE_INSPECTION_CLOSE_HANDLER_CHANGED')
    }
    ipcMain._invokeHandlers.set('db:close', state.original)
    delete globalThis.__inspectionLifecycleClose
  })
}

async function waitFor(read, wait, code) {
  for (let attempt = 0; attempt < OBSERVATION_TIMEOUT_MS / 10; attempt++) {
    if (await read()) return
    await wait(10)
  }
  throw new Error(code)
}

async function storeInvoke(page, key, channel, args) {
  await page.evaluate(({ storageKey, invokeChannel, invokeArgs }) => {
    if (Object.hasOwn(globalThis, storageKey)) throw new Error('PERFORMANCE_INSPECTION_PROMISE_ALREADY_SET')
    const stateKey = `${storageKey}State`
    const startedAt = performance.now()
    globalThis[stateKey] = { settled: false, elapsedMs: null }
    const settle = outcome => {
      globalThis[stateKey].settled = true
      globalThis[stateKey].elapsedMs = performance.now() - startedAt
      return { ...outcome, elapsedMs: globalThis[stateKey].elapsedMs }
    }
    let invocation
    try {
      invocation = window.aiNovelAPI.invoke(invokeChannel, ...invokeArgs)
    } catch (error) {
      invocation = Promise.reject(error)
    }
    globalThis[storageKey] = Promise.resolve(invocation).then(
      value => settle({ state: 'fulfilled', value }),
      error => settle({ state: 'rejected', error: error instanceof Error ? error.message : String(error) }),
    )
  }, { storageKey: key, invokeChannel: channel, invokeArgs: args })
}

async function storedSettled(page, key) {
  return page.evaluate(storageKey => globalThis[`${storageKey}State`]?.settled === true, key)
}

async function settleStored(page, keys) {
  return boundedObservation(() => page.evaluate(async storageKeys => Promise.all(storageKeys.map(async key => {
    const pending = globalThis[key]
    if (!pending) return { state: 'missing', elapsedMs: null }
    const result = await pending
    delete globalThis[key]
    return result
  })), keys), OBSERVATION_TIMEOUT_MS)
}

async function clearStored(page, keys) {
  if (page.isClosed()) return
  await page.evaluate(storageKeys => {
    for (const key of storageKeys) {
      delete globalThis[key]
      delete globalThis[`${key}State`]
    }
  }, keys)
}

async function reopenFromLibrary(context) {
  const { app, page } = context
  await context.reload()
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    if (typeof original !== 'function' || globalThis.__inspectionLifecycleOpen) {
      throw new Error('PERFORMANCE_INSPECTION_OPEN_HANDLER_INVALID')
    }
    const state = { original, session: null }
    const observer = async (...args) => {
      const result = await original(...args)
      if (result?.success && result.project?.id && result.project?.path && result.project?.sessionLease) {
        state.session = { projectId: result.project.id, projectPath: result.project.path,
          leaseId: result.project.sessionLease }
      }
      return result
    }
    state.observer = observer
    globalThis.__inspectionLifecycleOpen = state
    handlers.set('project:open', observer)
  })
  try {
    await stage.openFromLibrary(page, BOOK)
    return await app.evaluate(() => globalThis.__inspectionLifecycleOpen?.session ?? null)
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis.__inspectionLifecycleOpen
      if (!state || ipcMain._invokeHandlers.get('project:open') !== state.observer) {
        throw new Error('PERFORMANCE_INSPECTION_OPEN_HANDLER_CHANGED')
      }
      ipcMain._invokeHandlers.set('project:open', state.original)
      delete globalThis.__inspectionLifecycleOpen
    })
  }
}

function metric(measurements, name) {
  return measurements?.main?.metrics?.metrics?.[name]
}

function validateProbe(measurements, expectParse) {
  assertPerformanceProbeCoverage(measurements)
  assert.equal(measurements?.coverage?.cpu, 'observed')
  const cpu = measurements?.main?.cpu
  assert.ok(Number.isFinite(cpu?.userUs) && cpu.userUs >= 0
    && Number.isFinite(cpu?.systemUs) && cpu.systemUs >= 0
    && Number.isFinite(cpu?.windowMs) && cpu.windowMs > 0)
  const memory = measurements?.main?.memory
  assert.ok(Number.isFinite(memory?.rssStart) && Number.isFinite(memory?.rssEnd)
    && memory.rssIntervalMs === 250 && Number.isSafeInteger(memory?.rssSamples) && memory.rssSamples >= 3)
  assert.ok(metric(measurements, 'import.inspect.calls')?.count >= 1)
  if (expectParse) assert.ok(metric(measurements, 'import.parse.ms')?.count > 0)
}

function assertNoMetric(measurements, name) {
  assert.equal(metric(measurements, name), undefined, `PERFORMANCE_INSPECTION_UNEXPECTED_METRIC:${name}`)
}

export async function runInspectionLifecycleScenario(kind, context, dependencies = {}) {
  assert.ok(['author-close', 'reference-close', 'reference-cancel'].includes(kind))
  const purpose = kind === 'author-close' ? 'author-manuscript' : 'reference'
  const closing = kind !== 'reference-cancel'
  const corpus = performanceCorpus(CHAPTERS)
  const body = corpus.split('\n')[1]
  const expectedBytes = Buffer.byteLength(body, 'utf8') * CHAPTERS
  const chapterWords = countDraftUnits(body)
  const report = {
    metadata: performanceMetadata(CHAPTERS), corpusSha256: corpusSha256(corpus),
    corpusBytes: Buffer.byteLength(corpus, 'utf8'), attempted: 1, failed: 1, success: false,
    elapsedMs: null, inspectionElapsedMs: null, measurements: null, inspection: null,
    lifecycle: {
      mode: closing ? 'close-drain' : 'chooser-cancel', closeRequested: false, closeWaitMs: null,
      settledBeforeReload: false, runtimeClosed: false, reopened: false, sessionRotated: null,
      chooserResult: null, runReadback: null,
    },
    cleanupFailures: 0, stopFailures: 0, failureStage: null, failureDiagnostics: [],
    requestSummary: null, finalRequestSummary: null, requestSummaryCutoff: null, requestsAfterMeasurement: null,
  }
  const { app, page, roots, invoke } = context
  const setup = dependencies.setup ?? setupParseProject
  const start = dependencies.start ?? startPerformanceBaseline
  const stop = dependencies.stop ?? stopPerformanceBaseline
  const readNetwork = dependencies.networkCounts ?? networkCounts
  const readRequests = dependencies.readRequests ?? readModelRequestSummary
  const wait = dependencies.wait ?? sleep
  const write = dependencies.write ?? ((file, content) => fs.writeFileSync(file, content, 'utf8'))
  const runtimeInfo = dependencies.runtime ?? (async () => app.evaluate(() => ({
    electron: process.versions.electron ?? null, node: process.versions.node ?? null, chrome: process.versions.chrome ?? null,
  })))
  const reopen = dependencies.reopen ?? reopenFromLibrary
  let session, file, runId, chooserInstalled = false, closeObserverInstalled = false
  let probeStarted = false, probeStopped = false, chooserReleased = false, callsSettled = false
  let selectionStarted = false, closePromiseStarted = false
  let selection, closeResult, scenarioFailure = null
  let currentStage = 'fixture'
  const cleanupErrors = []
  const failCleanup = (error, at) => {
    cleanupErrors.push(error)
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'cleanup', at)
  }
  const stopProbe = async () => {
    if (!probeStarted || probeStopped) return
    report.measurements = await stop(app, page)
    probeStopped = true
    report.stopFailures = (report.measurements?.stopFailures?.main ?? 1)
      + (report.measurements?.stopFailures?.renderer ?? 1)
    validateProbe(report.measurements, closing)
  }

  try {
    file = path.join(roots.temp, 'performance-parse-fiction.txt')
    write(file, corpus)
    currentStage = 'session'
    session = await setup(context)
    report.metadata.appRuntime = await runtimeInfo()
    assert.deepEqual(await readNetwork(app), { model: 0, external: 0 })

    currentStage = 'preview'
    await installChooser(app, file, !closing)
    chooserInstalled = true
    if (closing) {
      await installCloseObserver(app)
      closeObserverInstalled = true
    }
    currentStage = 'probe_start'
    await start(app, page)
    probeStarted = true
    await wait(300)

    currentStage = 'import'
    runId = randomUUID()
    const request = { runId, purpose, locale: 'zh-CN', expectedProjectPath: session.projectPath }
    await storeInvoke(page, SELECTION_PROMISE, 'dialog:select-novel-files', [request, session])
    selectionStarted = true
    await waitFor(() => chooserEntered(app), wait, 'PERFORMANCE_INSPECTION_CHOOSER_TIMEOUT')

    if (closing) {
      await storeInvoke(page, CLOSE_PROMISE, 'db:close', [session.projectPath, session])
      closePromiseStarted = true
      await waitFor(async () => {
        const state = await closeState(app)
        return state?.entered === true && state.forwarded === true
      }, wait,
        'PERFORMANCE_INSPECTION_CLOSE_NOT_ENTERED')
      await wait(CHOOSER_HOLD_MS)
      const pendingClose = await closeState(app)
      assert.equal(pendingClose?.completed, false, 'PERFORMANCE_INSPECTION_CLOSE_DID_NOT_DRAIN')
      assert.equal(await chooserHeld(app), true, 'PERFORMANCE_INSPECTION_CHOOSER_NOT_HELD')
      assert.equal(await storedSettled(page, SELECTION_PROMISE), false,
        'PERFORMANCE_INSPECTION_SETTLED_BEFORE_CHOOSER_RELEASE')
      report.lifecycle.closeRequested = true
      await releaseChooser(app, { canceled: false, filePaths: [file] })
      chooserReleased = true
      const settled = await settleStored(page, [SELECTION_PROMISE, CLOSE_PROMISE])
      callsSettled = true
      report.lifecycle.settledBeforeReload = true
      report.inspectionElapsedMs = settled[0].elapsedMs
      report.lifecycle.closeWaitMs = settled[1].elapsedMs
      assert.ok(Number.isFinite(report.inspectionElapsedMs) && report.inspectionElapsedMs >= 0)
      assert.ok(Number.isFinite(report.lifecycle.closeWaitMs) && report.lifecycle.closeWaitMs >= 0)
      assert.deepEqual(settled.map(result => result.state), ['fulfilled', 'fulfilled'])
      ;[selection, closeResult] = settled.map(result => result.value)
      assert.equal(closeResult?.success, true, 'PERFORMANCE_INSPECTION_DB_CLOSE_FAILED')
      assert.equal(selection?.success, true, 'PERFORMANCE_INSPECTION_SELECTION_FAILED')
      report.lifecycle.chooserResult = 'selected'
      const runtime = await invoke(page, 'project:get-runtime-context')
      assert.deepEqual(runtime, { activeProjectPath: null, dbReady: true })
      report.lifecycle.runtimeClosed = true
    } else {
      const settled = await settleStored(page, [SELECTION_PROMISE])
      callsSettled = true
      assert.equal(settled[0]?.state, 'fulfilled')
      selection = settled[0].value
      assert.equal(selection, null, 'PERFORMANCE_INSPECTION_CANCEL_NOT_NULL')
      report.inspectionElapsedMs = settled[0].elapsedMs
      assert.ok(Number.isFinite(report.inspectionElapsedMs) && report.inspectionElapsedMs >= 0)
      report.lifecycle.chooserResult = 'cancelled'
    }

    await stopProbe()
    await restoreChooser(app)
    chooserInstalled = false
    if (closeObserverInstalled) {
      await restoreCloseObserver(app)
      closeObserverInstalled = false
    }

    currentStage = 'verify'
    if (closing) {
      assert.equal(selection?.success, true)
      const rawInspection = purpose === 'reference' ? selection.preparation?.inspection : selection.inspection
      const inspection = validateInspection(rawInspection, purpose, CHAPTERS, expectedBytes,
        chapterWords * CHAPTERS, chapterWords)
      report.inspection = inspection
      const reopened = await reopen(context, session)
      const newSession = reopened?.session ?? reopened
      assert.ok(typeof newSession?.projectId === 'string' && newSession.projectId.length > 0)
      assert.ok(typeof newSession?.projectPath === 'string' && newSession.projectPath.length > 0)
      assert.ok(typeof newSession?.leaseId === 'string' && newSession.leaseId.length > 0)
      assert.equal(newSession.projectId, session.projectId)
      assert.equal(newSession.projectPath, session.projectPath)
      assert.notEqual(newSession.leaseId, session.leaseId)
      report.lifecycle.reopened = true
      report.lifecycle.sessionRotated = true
      if (purpose === 'reference') {
        const runIdFromPreparation = selection.preparation?.run?.id
        assert.equal(runIdFromPreparation, runId)
        const readback = reopened && Object.hasOwn(reopened, 'readback')
          ? reopened.readback
          : await invoke(page, 'db:import-run-get', runId, newSession.projectPath, newSession)
        report.inspection = validateReference(selection.preparation, readback, runId, CHAPTERS, inspection)
        report.lifecycle.runReadback = 'prepared'
      }
    } else {
      const readback = await invoke(page, 'db:import-run-get', runId, session.projectPath, session)
      assert.equal(readback, null, 'PERFORMANCE_INSPECTION_CANCEL_CREATED_RUN')
      report.lifecycle.runReadback = 'absent'
    }

    assert.equal(metric(report.measurements, 'import.inspect.calls')?.count, 1)
    if (!closing) {
      assert.equal(metric(report.measurements, 'import.inspect.cancelled')?.count, 1)
      for (const name of METRICS_WITHOUT_SELECTION) assertNoMetric(report.measurements, name)
    }
  } catch (error) {
    scenarioFailure = error
    report.failureStage = currentStage
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', currentStage)
  } finally {
    if (chooserInstalled && !chooserReleased) {
      try {
        await releaseChooser(app, { canceled: true, filePaths: [] })
        chooserReleased = true
      } catch (error) { failCleanup(error, 'cleanup') }
    }
    const startedKeys = [
      ...(selectionStarted ? [SELECTION_PROMISE] : []),
      ...(closePromiseStarted ? [CLOSE_PROMISE] : []),
    ]
    if (!callsSettled && startedKeys.length && page && !page.isClosed()) {
      try {
        const settled = await settleStored(page, startedKeys)
        callsSettled = true
        if (settled.some(result => result.state !== 'fulfilled')) {
          failCleanup(new Error(`PERFORMANCE_INSPECTION_DRAIN_NOT_FULFILLED:${settled.map(result => result.state).join(',')}`), 'drain')
        }
      } catch (error) { failCleanup(error, 'drain') }
    }
    if (probeStarted && !probeStopped) {
      try { await stopProbe() } catch (error) { failCleanup(error, 'probe_stop') }
    }
    if (chooserInstalled) {
      try { await restoreChooser(app) } catch (error) { failCleanup(error, 'cleanup') }
    }
    if (closeObserverInstalled) {
      try { await restoreCloseObserver(app) } catch (error) { failCleanup(error, 'cleanup') }
    }
    if (callsSettled && startedKeys.length && page && !page.isClosed()) {
      try { await clearStored(page, startedKeys) }
      catch (error) { failCleanup(error, 'cleanup') }
    }
  }

  report.elapsedMs = report.inspectionElapsedMs
  try {
    assert.deepEqual(await readNetwork(app), { model: 0, external: 0 })
    report.requestSummary = await readRequests(app)
    assert.equal(report.requestSummary?.coverage, 'guarded_fetch_attempts')
    assert.ok(Object.values(report.requestSummary.byRoute).every(row => row.count === 0))
    report.requestSummaryCutoff = 'after_drain_and_probe_stop'
  } catch (error) { failCleanup(error, 'request_summary') }

  report.cleanupFailures = cleanupErrors.length
  report.failed = scenarioFailure || cleanupErrors.length ? 1 : 0
  report.success = report.failed === 0
  context.finalizePerformanceEvidence = async () => {
    try {
      assert.deepEqual(await readNetwork(app), { model: 0, external: 0 })
      report.finalRequestSummary = await readRequests(app)
      assert.equal(report.finalRequestSummary?.coverage, 'guarded_fetch_attempts')
      assert.ok(Object.values(report.finalRequestSummary.byRoute).every(row => row.count === 0))
      report.requestsAfterMeasurement = 0
    } catch (error) {
      report.cleanupFailures++
      report.failed = 1
      report.success = false
      report.failureStage ??= 'final_request_summary'
      appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'cleanup', 'final_request_summary')
      const wrapped = new Error('PERFORMANCE_FINAL_REQUEST_SUMMARY_FAILED', { cause: error })
      wrapped.performanceBaseline = report
      throw wrapped
    } finally { report.requestSummaryCutoff = 'before_quit' }
  }

  if (!report.success) {
    report.failureStage ??= 'cleanup'
    const error = new Error('PERFORMANCE_INSPECTION_LIFECYCLE_SCENARIO_FAILED', {
      cause: scenarioFailure ?? cleanupErrors[0],
    })
    error.performanceBaseline = report
    throw error
  }
  return report
}

export const PERFORMANCE_INSPECTION_LIFECYCLE_SCENARIOS = Object.fromEntries([
  ['perf-parse-author-close-1000', 'author-close'],
  ['perf-parse-reference-close-1000', 'reference-close'],
  ['perf-parse-reference-cancel-1000', 'reference-cancel'],
].map(([name, kind]) => [name, {
  performance: true,
  model: false,
  shell: 'stage',
  timeout: 120_000,
  run: context => runInspectionLifecycleScenario(kind, context),
}]))
