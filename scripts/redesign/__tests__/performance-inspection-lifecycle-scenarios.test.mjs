import { afterEach, describe, expect, it, vi } from 'vitest'
import { countDraftUnits } from '../../../src/shared/draft-units.ts'
import { performanceCorpus } from '../performance-scenarios.mjs'
import { PERFORMANCE_INSPECTION_LIFECYCLE_SCENARIOS, runInspectionLifecycleScenario } from '../performance-inspection-lifecycle-scenarios.mjs'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function measurement(cancelled = false) {
  const metrics = cancelled ? { 'import.inspect.calls': { count: 1 }, 'import.inspect.cancelled': { count: 1 } }
    : { 'import.inspect.calls': { count: 1 }, 'import.parse.ms': { count: 1 }, 'import.read.ms': { count: 1 },
        'import.hash.ms': { count: 1 }, 'import.save.ms': { count: 1 } }
  return { main: { metrics: { metrics }, cpu: { userUs: 0, systemUs: 0, windowMs: 600 },
    memory: { rssStart: 100, rssEnd: 110, rssMax: 110, rssSamples: 3, rssIntervalMs: 250 }, eventLoop: { count: 1 } },
  renderer: { heartbeat: { count: 2 } }, coverage: { main: 'observed_metrics', renderer: 'live_zero_events', cpu: 'observed' },
  stopFailures: { main: 0, renderer: 0 } }
}

function inspection(purpose) {
  const body = performanceCorpus(1000).split('\n')[1]
  const wordCount = countDraftUnits(body)
  return { purpose, sourceCount: 1, chapterCount: 1000, totalBytes: Buffer.byteLength(body, 'utf8') * 1000,
    totalWords: wordCount * 1000, sourceDisplayNames: ['private-source'], inspectionId: 'private-inspection',
    preview: Array.from({ length: 8 }, (_, i) => ({ number: i + 1, wordCount, title: 'private-title',
      ...(purpose === 'reference' ? { targetStatus: 'new' } : {}) })),
    ...(purpose === 'reference' ? { previewRemaining: 992 } : {}) }
}

function fixture(kind) {
  const closing = kind !== 'reference-cancel', purpose = kind === 'author-close' ? 'author-manuscript' : 'reference'
  const session = { projectId: 'private-project', projectPath: '/private-project', leaseId: 'private-old-lease' }
  const newSession = { ...session, leaseId: 'private-new-lease' }
  const calls = [], selectionFinished = deferred()
  let selectionSettled = false, closeSettled = false, run = null
  const dialog = { showOpenDialog: vi.fn() }
  const originalDialog = dialog.showOpenDialog
  const data = inspection(purpose)
  const close = vi.fn(async () => {
    calls.push('close-enter')
    await selectionFinished.promise
    closeSettled = true
    calls.push('close-finished')
    return { success: true }
  })
  const select = vi.fn(async (_event, request) => {
    calls.push('inspection-enter')
    const selected = await dialog.showOpenDialog()
    calls.push(selected.canceled ? 'chooser-cancelled' : 'chooser-released')
    let result = null
    if (!selected.canceled) {
      if (purpose === 'reference') {
        run = { id: request.runId, purpose, stage: 'prepared', status: 'ready', totalChapters: 1000,
          manifestChapterCount: 1000, manifestWordCount: data.totalWords, manifestContentSize: data.totalBytes,
          completedSources: 1, totalSources: 1 }
        result = { success: true, preparation: { classification: 'new', run, inspection: data,
          newChapterNumbers: Array.from({ length: 1000 }, (_, i) => i + 1), duplicateChapterNumbers: [], conflictChapterNumbers: [] } }
      } else result = { success: true, inspection: data }
    }
    selectionSettled = true
    calls.push('inspection-finished')
    selectionFinished.resolve()
    return result
  })
  const handlers = new Map([['db:close', close], ['dialog:select-novel-files', select]])
  const app = { evaluate: vi.fn(async (fn, arg) => fn({ dialog, ipcMain: { _invokeHandlers: handlers } }, arg)) }
  const page = { isClosed: () => false, evaluate: vi.fn(async (fn, arg) => fn(arg)) }
  vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel, ...args) => handlers.get(channel)({}, ...args) } })
  const invoke = vi.fn(async (_page, channel, ...args) => {
    calls.push(channel)
    if (channel === 'project:get-runtime-context') return { activeProjectPath: null, dbReady: true }
    if (channel === 'db:import-run-get') {
      expect(args[1]).toBe(session.projectPath)
      expect(args[2]).toEqual(closing ? newSession : session)
      return run && { ...run }
    }
    throw new Error('UNEXPECTED_FIXTURE_CHANNEL')
  })
  const metrics = measurement(!closing)
  const context = { app, page, invoke, roots: { temp: '/private-temp' } }
  const dependencies = {
    setup: vi.fn(async () => session), start: vi.fn(async () => { calls.push('start') }),
    stop: vi.fn(async () => { calls.push('stop'); return metrics }),
    write: vi.fn(), runtime: vi.fn(async () => ({ node: 'v24.0.0' })),
    wait: vi.fn(async ms => {
      if (ms === 50) {
        calls.push('both-pending')
        expect(selectionSettled).toBe(false)
        expect(closeSettled).toBe(false)
      }
    }),
    networkCounts: vi.fn(async () => ({ model: 0, external: 0 })),
    readRequests: vi.fn(async () => ({ coverage: 'guarded_fetch_attempts', byRoute: { '/v1/embeddings': { count: 0 } } })),
    reopen: vi.fn(async () => { calls.push('reopen'); expect(closeSettled).toBe(true); return { session: newSession } }),
  }
  return { app, page, context, dependencies, metrics, calls, dialog, originalDialog, handlers, close, select, session, newSession }
}

describe('inspection lifecycle scene orchestration', () => {
  it('registers three bounded no-model lifecycle scenes', () => {
    expect(Object.keys(PERFORMANCE_INSPECTION_LIFECYCLE_SCENARIOS)).toEqual([
      'perf-parse-author-close-1000',
      'perf-parse-reference-close-1000',
      'perf-parse-reference-cancel-1000',
    ])
    for (const scene of Object.values(PERFORMANCE_INSPECTION_LIFECYCLE_SCENARIOS)) {
      expect(scene).toMatchObject({ performance: true, model: false, shell: 'stage' })
      expect(typeof scene.run).toBe('function')
    }
    expect(typeof runInspectionLifecycleScenario).toBe('function')
  })

  it.each(['author-close', 'reference-close'])('drains the real chooser and close observer before reopening %s', async kind => {
    const f = fixture(kind)
    const result = await runInspectionLifecycleScenario(kind, f.context, f.dependencies)
    expect(f.calls).toEqual(['start', 'inspection-enter', 'close-enter', 'both-pending', 'chooser-released',
      'inspection-finished', 'close-finished', 'project:get-runtime-context', 'stop', 'reopen',
      ...(kind === 'reference-close' ? ['db:import-run-get'] : [])])
    expect(result).toMatchObject({ success: true, attempted: 1, failed: 0,
      inspection: { purpose: kind === 'author-close' ? 'author-manuscript' : 'reference', chapterCount: 1000 },
      lifecycle: { mode: 'close-drain', closeRequested: true, settledBeforeReload: true, runtimeClosed: true,
        reopened: true, sessionRotated: true, chooserResult: 'selected',
        runReadback: kind === 'reference-close' ? 'prepared' : null } })
    expect(result.lifecycle.closeWaitMs).toEqual(expect.any(Number))
    expect(f.dependencies.reopen).toHaveBeenCalledWith(f.context, f.session)
    expect(f.handlers.get('db:close')).toBe(f.close)
    expect(f.dialog.showOpenDialog).toBe(f.originalDialog)
    expect(globalThis.__inspectionLifecycleChooser).toBeUndefined()
    expect(globalThis.__inspectionLifecycleClose).toBeUndefined()
    expect(globalThis.__inspectionLifecycleSelectionPromise).toBeUndefined()
    expect(globalThis.__inspectionLifecycleClosePromise).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/private-project|private-source|private-title|private-inspection|private-lease/)
    await f.context.finalizePerformanceEvidence()
    expect(result).toMatchObject({ requestsAfterMeasurement: 0, requestSummaryCutoff: 'before_quit' })
  })

  it('cancels selection without a run, read, parse, hash or save event', async () => {
    const f = fixture('reference-cancel')
    const result = await runInspectionLifecycleScenario('reference-cancel', f.context, f.dependencies)
    expect(f.calls).toEqual(['start', 'inspection-enter', 'chooser-cancelled', 'inspection-finished', 'stop', 'db:import-run-get'])
    expect(f.close).not.toHaveBeenCalled()
    expect(f.dependencies.reopen).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, lifecycle: { mode: 'chooser-cancel', closeRequested: false,
      chooserResult: 'cancelled', runReadback: 'absent', reopened: false } })
    for (const metric of ['import.read.ms', 'import.parse.ms', 'import.hash.ms', 'import.save.ms']) {
      expect(result.measurements.main.metrics.metrics[metric]).toBeUndefined()
    }
    expect(f.dialog.showOpenDialog).toBe(f.originalDialog)
  })

  it.each(['cpu', 'rss', 'samples', 'parse', 'calls'])('rejects missing %s evidence and restores hooks', async missing => {
    const f = fixture('author-close')
    if (missing === 'cpu') f.metrics.coverage.cpu = 'unavailable'
    if (missing === 'rss') delete f.metrics.main.memory.rssEnd
    if (missing === 'samples') f.metrics.main.memory.rssSamples = 2
    if (missing === 'parse') delete f.metrics.main.metrics.metrics['import.parse.ms']
    if (missing === 'calls') delete f.metrics.main.metrics.metrics['import.inspect.calls']
    await expect(runInspectionLifecycleScenario('author-close', f.context, f.dependencies))
      .rejects.toMatchObject({ performanceBaseline: { failed: 1, success: false } })
    expect(f.dialog.showOpenDialog).toBe(f.originalDialog)
    expect(f.handlers.get('db:close')).toBe(f.close)
  })

  it('retains probe stop failures even when coverage validation rejects', async () => {
    const f = fixture('author-close')
    f.metrics.stopFailures.main = 1
    await expect(runInspectionLifecycleScenario('author-close', f.context, f.dependencies))
      .rejects.toMatchObject({ performanceBaseline: { failed: 1, success: false, stopFailures: 1 } })
  })

  it.each(['import.read.ms', 'import.parse.ms', 'import.hash.ms', 'import.save.ms'])('rejects %s on cancel', async metric => {
    const f = fixture('reference-cancel')
    f.metrics.main.metrics.metrics[metric] = { count: 1 }
    await expect(runInspectionLifecycleScenario('reference-cancel', f.context, f.dependencies))
      .rejects.toMatchObject({ performanceBaseline: { failed: 1, success: false } })
  })

  it.each(['author-close', 'reference-close'])('rejects missing, changed or stale reopened identity for %s', async kind => {
    for (const invalid of [null, {}, { projectId: 'private-project', projectPath: '/private-project' },
      { projectId: 'private-other', projectPath: '/private-project', leaseId: 'private-new-lease' },
      { projectId: 'private-project', projectPath: '/private-other', leaseId: 'private-new-lease' },
      { projectId: 'private-project', projectPath: '/private-project', leaseId: 'private-old-lease' }]) {
      const f = fixture(kind)
      f.dependencies.reopen.mockResolvedValue({ session: invalid })
      await expect(runInspectionLifecycleScenario(kind, f.context, f.dependencies))
        .rejects.toMatchObject({ performanceBaseline: { success: false, failed: 1 } })
    }
  })

  it('does not claim observed cancellation or attempt to drain unstarted calls when probe startup fails', async () => {
    const f = fixture('reference-cancel'), failure = new Error('private-probe-start')
    f.dependencies.start.mockRejectedValue(failure)
    let caught
    try { await runInspectionLifecycleScenario('reference-cancel', f.context, f.dependencies) } catch (error) { caught = error }
    expect(caught.cause).toBe(failure)
    expect(caught.performanceBaseline).toMatchObject({ cleanupFailures: 0, lifecycle: { chooserResult: null, runReadback: null } })
    expect(f.select).not.toHaveBeenCalled()
    expect(f.dependencies.stop).not.toHaveBeenCalled()
    expect(f.dialog.showOpenDialog).toBe(f.originalDialog)
    expect(globalThis.__inspectionLifecycleSelectionPromise).toBeUndefined()
  })

  it('does not claim absent run when cancelled readback fails', async () => {
    const f = fixture('reference-cancel'), original = f.context.invoke.getMockImplementation()
    f.context.invoke.mockImplementation(async (...args) => {
      if (args[1] === 'db:import-run-get') throw new Error('private-readback')
      return original(...args)
    })
    let caught
    try { await runInspectionLifecycleScenario('reference-cancel', f.context, f.dependencies) } catch (error) { caught = error }
    expect(caught.performanceBaseline).toMatchObject({ success: false, lifecycle: { chooserResult: 'cancelled', runReadback: null } })
    expect(JSON.stringify(caught.performanceBaseline)).not.toContain('private-readback')
  })

  it('rejects a changed durable reference snapshot after reopening', async () => {
    const f = fixture('reference-close')
    const original = f.context.invoke.getMockImplementation()
    f.context.invoke.mockImplementation(async (...args) => {
      const result = await original(...args)
      return args[1] === 'db:import-run-get' ? { ...result, totalChapters: 999 } : result
    })
    await expect(runInspectionLifecycleScenario('reference-close', f.context, f.dependencies))
      .rejects.toMatchObject({ performanceBaseline: { success: false, failed: 1 } })
  })

  it('releases and drains both calls on failure, restores hooks, and retains the original cause privately', async () => {
    const f = fixture('author-close')
    const original = new Error('private-failure')
    f.dependencies.wait.mockImplementation(async ms => { if (ms === 50) throw original })
    let caught
    try { await runInspectionLifecycleScenario('author-close', f.context, f.dependencies) } catch (error) { caught = error }
    expect(caught.cause).toBe(original)
    expect(caught.performanceBaseline).toMatchObject({ failed: 1, success: false })
    expect(JSON.stringify(caught.performanceBaseline)).not.toContain('private-failure')
    expect(f.calls).toContain('chooser-cancelled')
    expect(f.calls).toContain('inspection-finished')
    expect(f.calls).toContain('close-finished')
    expect(f.dependencies.stop).toHaveBeenCalledOnce()
    expect(f.dialog.showOpenDialog).toBe(f.originalDialog)
    expect(f.handlers.get('db:close')).toBe(f.close)
  })

  it('records a rejected cleanup result without replacing the initial failure', async () => {
    const f = fixture('author-close')
    const original = new Error('private-initial')
    f.select.mockImplementation(async () => {
      await f.dialog.showOpenDialog()
      throw new Error('private-cleanup-rejection')
    })
    f.close.mockImplementation(async () => ({ success: true }))
    f.dependencies.wait.mockImplementation(async ms => { if (ms === 50) throw original })
    let caught
    try { await runInspectionLifecycleScenario('author-close', f.context, f.dependencies) } catch (error) { caught = error }
    expect(caught.cause).toBe(original)
    expect(caught.performanceBaseline.cleanupFailures).toBeGreaterThan(0)
    expect(JSON.stringify(caught.performanceBaseline)).not.toMatch(/private-initial|private-cleanup-rejection/)
    expect(f.dialog.showOpenDialog).toBe(f.originalDialog)
    expect(f.handlers.get('db:close')).toBe(f.close)
  })

  it('rejects a request observed after the measurement at the final cutoff', async () => {
    const f = fixture('author-close')
    const result = await runInspectionLifecycleScenario('author-close', f.context, f.dependencies)
    f.dependencies.networkCounts.mockResolvedValue({ model: 0, external: 1 })
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({ performanceBaseline: result })
    expect(result).toMatchObject({ failed: 1, success: false, failureStage: 'final_request_summary' })
  })
})
