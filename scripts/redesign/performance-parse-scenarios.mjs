import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { countDraftUnits } from '../../src/shared/draft-units.ts'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import * as stage from './pages/stage.mjs'
import { corpusSha256, performanceCorpus } from './performance-scenarios.mjs'
import { appendPerformanceFailureDiagnostic, assertPerformanceProbeCoverage, performanceMetadata,
  readModelRequestSummary, startPerformanceBaseline, stopPerformanceBaseline } from './performance-baseline.mjs'

const BOOK = '解析测量作品'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const variants = ['author', 'reference']
const sizes = [10, 100, 1000]

export async function setupParseProject(context) {
  const { app, page, roots, invoke, reload } = context
  const grant = await chooseProjectDirectoryGrant(app, page, roots.projects)
  const created = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name: BOOK,
    genre: '', targetAudience: '', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, 'PERFORMANCE_PARSE_PROJECT_CREATE_FAILED')
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    if (typeof original !== 'function' || globalThis.__parseOpenObserver) throw new Error('PERFORMANCE_PARSE_OPEN_HANDLER_INVALID')
    const observer = async (event, root, ...args) => {
      const result = await original(event, root, ...args)
      if (result?.success) globalThis.__parseOpenedSession = {
        projectId: result.project.id, projectPath: root, leaseId: result.project.sessionLease,
      }
      return result
    }
    globalThis.__parseOpenObserver = { original, observer }
    handlers.set('project:open', observer)
  })
  try {
    await reload()
    await stage.openFromLibrary(page, BOOK)
    const session = await app.evaluate(() => globalThis.__parseOpenedSession ?? null)
    assert.ok(session?.projectId && session?.projectPath && session?.leaseId, 'PERFORMANCE_PARSE_SESSION_MISSING')
    return Object.freeze({ ...session })
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis.__parseOpenObserver
      if (!state || ipcMain._invokeHandlers.get('project:open') !== state.observer) throw new Error('PERFORMANCE_PARSE_OPEN_HANDLER_CHANGED')
      ipcMain._invokeHandlers.set('project:open', state.original)
      delete globalThis.__parseOpenObserver
      delete globalThis.__parseOpenedSession
    })
  }
}

async function installChooser(app, file) {
  await app.evaluate(({ dialog }, selected) => {
    if (globalThis.__parseChooser) throw new Error('PERFORMANCE_PARSE_CHOOSER_ALREADY_SET')
    const original = dialog.showOpenDialog
    const replacement = async () => ({ canceled: false, filePaths: [selected] })
    globalThis.__parseChooser = { original, replacement }
    dialog.showOpenDialog = replacement
  }, file)
}

async function restoreChooser(app) {
  await app.evaluate(({ dialog }) => {
    const state = globalThis.__parseChooser
    if (!state || dialog.showOpenDialog !== state.replacement) throw new Error('PERFORMANCE_PARSE_CHOOSER_CHANGED')
    dialog.showOpenDialog = state.original
    delete globalThis.__parseChooser
  })
}

async function networkCounts(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests) || !Array.isArray(globalThis.__driveExternalRequests)) {
      throw new Error('PERFORMANCE_PARSE_NETWORK_COVERAGE_MISSING')
    }
    return { model: globalThis.__driveModelRequests.length, external: globalThis.__driveExternalRequests.length }
  })
}

function validateInspection(inspection, purpose, chapters, expectedBytes, expectedWords, chapterWords) {
  assert.ok(inspection && typeof inspection === 'object', 'PERFORMANCE_PARSE_INSPECTION_MISSING')
  assert.equal(inspection.purpose, purpose)
  assert.equal(inspection.sourceCount, 1)
  assert.equal(inspection.chapterCount, chapters)
  assert.equal(inspection.totalBytes, expectedBytes)
  assert.equal(inspection.totalWords, expectedWords)
  assert.ok(Array.isArray(inspection.preview) && inspection.preview.length === Math.min(8, chapters))
  inspection.preview.forEach((chapter, index) => {
    assert.equal(chapter.number, index + 1)
    assert.equal(chapter.wordCount, chapterWords)
    if (purpose === 'reference') assert.equal(chapter.targetStatus, 'new')
  })
  if (purpose === 'reference') assert.equal(inspection.previewRemaining, chapters - inspection.preview.length)
  return { purpose, sourceCount: inspection.sourceCount, chapterCount: inspection.chapterCount,
    totalBytes: inspection.totalBytes, totalWords: inspection.totalWords }
}

function validateReference(preparation, readback, runId, chapters, inspection) {
  assert.equal(preparation?.classification, 'new')
  for (const [field, length] of [['newChapterNumbers', chapters], ['duplicateChapterNumbers', 0], ['conflictChapterNumbers', 0]]) {
    assert.ok(Array.isArray(preparation[field]))
    assert.equal(preparation[field].length, length)
  }
  assert.deepEqual(preparation.newChapterNumbers, Array.from({ length: chapters }, (_, index) => index + 1))
  const run = preparation.run
  assert.ok(run && readback)
  assert.equal(run.id, runId)
  assert.equal(run.purpose, 'reference')
  assert.equal(run.stage, 'prepared')
  assert.equal(run.status, 'ready')
  assert.equal(run.totalChapters, chapters)
  assert.equal(run.manifestChapterCount, chapters)
  assert.equal(run.completedSources, 1)
  assert.equal(run.totalSources, 1)
  assert.equal(run.manifestWordCount, inspection.totalWords)
  assert.equal(run.manifestContentSize, inspection.totalBytes)
  for (const key of ['id', 'purpose', 'stage', 'status', 'totalChapters', 'manifestChapterCount',
    'manifestWordCount', 'manifestContentSize', 'completedSources', 'totalSources']) assert.equal(readback[key], run[key])
  return { ...inspection, classification: preparation.classification, stage: run.stage, status: run.status,
    completedSources: run.completedSources, totalSources: run.totalSources,
    newCount: preparation.newChapterNumbers.length, duplicateCount: 0, conflictCount: 0 }
}

export async function runParseInspectionScenario(purpose, chapters, context, dependencies = {}) {
  assert.ok(['author-manuscript', 'reference'].includes(purpose))
  const corpus = performanceCorpus(chapters)
  const body = corpus.split('\n')[1]
  const expectedBytes = Buffer.byteLength(body, 'utf8') * chapters
  const chapterWords = countDraftUnits(body)
  const report = { metadata: performanceMetadata(chapters), corpusSha256: corpusSha256(corpus),
    corpusBytes: Buffer.byteLength(corpus, 'utf8'), attempted: 1, failed: 1, success: false,
    elapsedMs: null, measurements: null, inspection: null, cleanupFailures: 0, stopFailures: 0,
    failureStage: null, failureDiagnostics: [], requestSummary: null, finalRequestSummary: null,
    requestSummaryCutoff: null, requestsAfterMeasurement: null }
  const { app, page, roots, invoke } = context
  const setup = dependencies.setup ?? setupParseProject
  const start = dependencies.start ?? startPerformanceBaseline
  const stop = dependencies.stop ?? stopPerformanceBaseline
  const install = dependencies.installChooser ?? installChooser
  const restore = dependencies.restoreChooser ?? restoreChooser
  const readNetwork = dependencies.networkCounts ?? networkCounts
  const readRequests = dependencies.readRequests ?? readModelRequestSummary
  const wait = dependencies.wait ?? sleep
  const write = dependencies.write ?? ((file, content) => fs.writeFileSync(file, content, 'utf8'))
  let session, selection, selectedRunId, chooserInstalled = false, probeStarted = false, failure = null
  let currentStage = 'fixture'
  const cleanupErrors = []
  const failCleanup = (error, at) => {
    cleanupErrors.push(error)
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'cleanup', at)
  }
  try {
    const file = path.join(roots.temp, 'performance-parse-fiction.txt')
    write(file, corpus)
    currentStage = 'session'
    session = await setup(context)
    report.metadata.appRuntime = await (dependencies.runtime ?? (async () => app.evaluate(() => ({
      electron: process.versions.electron ?? null, node: process.versions.node ?? null, chrome: process.versions.chrome ?? null,
    }))))()
    assert.deepEqual(await readNetwork(app), { model: 0, external: 0 })
    currentStage = 'preview'
    await install(app, file); chooserInstalled = true
    currentStage = 'probe_start'
    await start(app, page); probeStarted = true
    await wait(300)
    currentStage = 'import'
    const startedAt = performance.now()
    try {
      selectedRunId = randomUUID()
      selection = await invoke(page, 'dialog:select-novel-files', {
        runId: selectedRunId, purpose, locale: 'zh-CN', expectedProjectPath: session.projectPath,
      }, session)
    } finally { report.elapsedMs = performance.now() - startedAt }
    await wait(300)
  } catch (error) {
    failure = error
    report.failureStage = currentStage
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', currentStage)
  } finally {
    if (probeStarted) {
      try {
        report.measurements = await stop(app, page)
        report.stopFailures = (report.measurements?.stopFailures?.main ?? 1) + (report.measurements?.stopFailures?.renderer ?? 1)
        assertPerformanceProbeCoverage(report.measurements)
        assert.equal(report.measurements?.coverage?.cpu, 'observed')
        const cpu = report.measurements?.main?.cpu
        assert.ok(Number.isFinite(cpu?.userUs) && cpu.userUs >= 0 && Number.isFinite(cpu?.systemUs) && cpu.systemUs >= 0
          && Number.isFinite(cpu?.windowMs) && cpu.windowMs > 0)
        const memory = report.measurements?.main?.memory
        assert.ok(Number.isFinite(memory?.rssStart) && Number.isFinite(memory?.rssEnd) && memory.rssIntervalMs === 250
          && Number.isSafeInteger(memory?.rssSamples) && memory.rssSamples >= 3)
        assert.ok(report.measurements?.main?.metrics?.metrics?.['import.parse.ms']?.count > 0)
      } catch (error) { failCleanup(error, 'probe_stop') }
    }
    if (chooserInstalled) try { await restore(app) } catch (error) { failCleanup(error, 'cleanup') }
  }
  if (!failure && !cleanupErrors.length) try {
    currentStage = 'verify'
    assert.equal(selection?.success, true, 'PERFORMANCE_PARSE_SELECTION_FAILED')
    const rawInspection = purpose === 'reference' ? selection.preparation?.inspection : selection.inspection
    const inspection = validateInspection(rawInspection, purpose, chapters, expectedBytes, chapterWords * chapters, chapterWords)
    if (purpose === 'reference') {
      const runId = selection.preparation?.run?.id
      assert.ok(typeof runId === 'string')
      const readback = await invoke(page, 'db:import-run-get', runId, session.projectPath, session)
      report.inspection = validateReference(selection.preparation, readback, selectedRunId, chapters, inspection)
    } else report.inspection = inspection
  } catch (error) {
    failure = error; report.failureStage = currentStage
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', currentStage)
  }
  try {
    assert.deepEqual(await readNetwork(app), { model: 0, external: 0 })
    report.requestSummary = await readRequests(app)
    assert.equal(report.requestSummary?.coverage, 'guarded_fetch_attempts')
    assert.ok(Object.values(report.requestSummary.byRoute).every(row => row.count === 0))
    report.requestSummaryCutoff = 'after_drain_and_probe_stop'
  } catch (error) { failCleanup(error, 'request_summary') }
  report.cleanupFailures = cleanupErrors.length
  report.failed = failure || cleanupErrors.length ? 1 : 0
  report.success = report.failed === 0
  context.finalizePerformanceEvidence = async () => {
    try {
      assert.deepEqual(await readNetwork(app), { model: 0, external: 0 })
      report.finalRequestSummary = await readRequests(app)
      assert.equal(report.finalRequestSummary?.coverage, 'guarded_fetch_attempts')
      assert.ok(Object.values(report.finalRequestSummary.byRoute).every(row => row.count === 0))
      report.requestsAfterMeasurement = 0
    } catch (error) {
      report.cleanupFailures++; report.failed = 1; report.success = false; report.failureStage ??= 'final_request_summary'
      appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'cleanup', 'final_request_summary')
      const wrapped = new Error('PERFORMANCE_FINAL_REQUEST_SUMMARY_FAILED', { cause: error })
      wrapped.performanceBaseline = report
      throw wrapped
    } finally { report.requestSummaryCutoff = 'before_quit' }
  }
  if (!report.success) {
    report.failureStage ??= 'cleanup'
    const error = new Error('PERFORMANCE_PARSE_SCENARIO_FAILED', { cause: failure ?? cleanupErrors[0] })
    error.performanceBaseline = report
    throw error
  }
  return report
}

export const PERFORMANCE_PARSE_SCENARIOS = Object.fromEntries(variants.flatMap(variant => sizes.map(chapters => [
  `perf-parse-${variant}-${chapters}`, { performance: true, model: false, shell: 'stage', timeout: 120_000,
    run: context => runParseInspectionScenario(variant === 'author' ? 'author-manuscript' : 'reference', chapters, context) },
])))
