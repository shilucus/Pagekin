import { afterEach, describe, expect, it, vi } from 'vitest'
import { countDraftUnits } from '../../../src/shared/draft-units.ts'
import { corpusSha256, performanceCorpus } from '../performance-scenarios.mjs'
import { PERFORMANCE_PARSE_SCENARIOS, runParseInspectionScenario, setupParseProject } from '../performance-parse-scenarios.mjs'
import { chooseProjectDirectoryGrant } from '../../project-directory-grant.mjs'
import { openFromLibrary } from '../pages/stage.mjs'

vi.mock('../../project-directory-grant.mjs', () => ({ chooseProjectDirectoryGrant: vi.fn() }))
vi.mock('../pages/stage.mjs', () => ({ openFromLibrary: vi.fn() }))

afterEach(() => { vi.restoreAllMocks(); delete globalThis.__parseChooser })

function fixture(purpose = 'author-manuscript') {
  const corpus = performanceCorpus(10), body = corpus.split('\n')[1]
  const chapterWords = countDraftUnits(body), totalBytes = Buffer.byteLength(body, 'utf8') * 10
  const inspection = { purpose, sourceCount: 1, chapterCount: 10, totalBytes, totalWords: chapterWords * 10,
    sourceDisplayNames: ['private-file'], inspectionId: 'private-inspection',
    preview: Array.from({ length: 8 }, (_, index) => ({ number: index + 1, wordCount: chapterWords,
      title: 'private-title', ...(purpose === 'reference' ? { targetStatus: 'new' } : {}) })),
    ...(purpose === 'reference' ? { previewRemaining: 2 } : {}) }
  const session = Object.freeze({ projectId: 'private-project', projectPath: '/private-project', leaseId: 'private-lease' })
  const dialog = { showOpenDialog: vi.fn() }
  const app = { evaluate: vi.fn(async (callback, argument) => callback({ dialog }, argument)) }
  const metrics = { main: { metrics: { metrics: { 'import.parse.ms': { count: 1 } } },
    cpu: { userUs: 0, systemUs: 0, windowMs: 600 }, memory: { rssStart: 100, rssEnd: 110, rssMax: 110, rssSamples: 3, rssIntervalMs: 250 },
    eventLoop: { count: 1 } }, renderer: { heartbeat: { count: 2 } },
  coverage: { main: 'observed_metrics', renderer: 'live_zero_events', cpu: 'observed' }, stopFailures: { main: 0, renderer: 0 } }
  let run
  const invoke = vi.fn(async (_page, channel, ...args) => {
    if (channel === 'dialog:select-novel-files') {
      const request = args[0]
      const selected = await dialog.showOpenDialog()
      expect(selected).toEqual({ canceled: false, filePaths: [expect.stringContaining('performance-parse-fiction.txt')] })
      if (purpose === 'author-manuscript') return { success: true, inspection }
      run = { id: request.runId, purpose, stage: 'prepared', status: 'ready', totalChapters: 10,
        manifestChapterCount: 10, manifestWordCount: inspection.totalWords, manifestContentSize: totalBytes,
        completedSources: 1, totalSources: 1 }
      return { success: true, preparation: { classification: 'new', run, inspection,
        newChapterNumbers: Array.from({ length: 10 }, (_, index) => index + 1),
        conflictChapterNumbers: [], duplicateChapterNumbers: [] } }
    }
    if (channel === 'db:import-run-get') return { ...run }
    throw new Error('UNEXPECTED_FIXTURE_CHANNEL')
  })
  const context = { app, page: {}, roots: { temp: '/fictional-temp' }, invoke }
  const dependencies = { setup: vi.fn(async () => session), runtime: vi.fn(async () => ({ node: 'v24.0.0' })),
    start: vi.fn(async () => {}), stop: vi.fn(async () => metrics), wait: vi.fn(async () => {}),
    write: vi.fn(), networkCounts: vi.fn(async () => ({ model: 0, external: 0 })),
    readRequests: vi.fn(async () => ({ coverage: 'guarded_fetch_attempts', byRoute: {
      '/v1/chat/completions': { count: 0 }, '/v1/embeddings': { count: 0 }, '/v1/messages': { count: 0 },
    } })) }
  return { context, dependencies, session, inspection, dialog, metrics, corpus }
}

describe('parse inspection scene orchestration', () => {
  it('registers six independent no-model scenes', () => {
    expect(Object.keys(PERFORMANCE_PARSE_SCENARIOS)).toEqual(['perf-parse-author-10', 'perf-parse-author-100',
      'perf-parse-author-1000', 'perf-parse-reference-10', 'perf-parse-reference-100', 'perf-parse-reference-1000'])
    for (const scene of Object.values(PERFORMANCE_PARSE_SCENARIOS)) {
      expect(scene).toMatchObject({ performance: true, model: false, shell: 'stage' })
      expect(typeof scene.run).toBe('function')
    }
  })

  it('creates and opens a fictional project, captures the real open receipt, and restores the handler', async () => {
    const original = vi.fn(async () => ({ success: true, project: { id: 'project', sessionLease: 'lease' } }))
    const handlers = new Map([['project:open', original]])
    const app = { evaluate: vi.fn(async callback => callback({ ipcMain: { _invokeHandlers: handlers } })) }
    const invoke = vi.fn(async () => ({ success: true }))
    vi.mocked(chooseProjectDirectoryGrant).mockResolvedValue({ grantId: 'fictional-grant' })
    vi.mocked(openFromLibrary).mockImplementation(async () => { await handlers.get('project:open')({}, '/fictional-project') })
    const context = { app, page: {}, roots: { projects: '/fictional-root' }, invoke, reload: vi.fn(async () => {}) }
    await expect(setupParseProject(context)).resolves.toEqual({ projectId: 'project', projectPath: '/fictional-project', leaseId: 'lease' })
    expect(handlers.get('project:open')).toBe(original)
    expect(invoke.mock.calls.map(call => call[1])).toEqual(['project:create'])
    expect(invoke.mock.calls[0][2]).toMatchObject({ parentGrantId: 'fictional-grant' })
    expect(globalThis.__parseOpenObserver).toBeUndefined()
    expect(globalThis.__parseOpenedSession).toBeUndefined()
  })

  it('restores the project open handler if opening fails', async () => {
    const original = vi.fn(), handlers = new Map([['project:open', original]])
    const app = { evaluate: vi.fn(async callback => callback({ ipcMain: { _invokeHandlers: handlers } })) }
    vi.mocked(chooseProjectDirectoryGrant).mockResolvedValue({ grantId: 'fictional-grant' })
    vi.mocked(openFromLibrary).mockRejectedValue(new Error('fictional-open-failure'))
    await expect(setupParseProject({ app, page: {}, roots: { projects: '/fictional-root' },
      invoke: vi.fn(async () => ({ success: true })), reload: vi.fn(async () => {}) })).rejects.toThrow('fictional-open-failure')
    expect(handlers.get('project:open')).toBe(original)
    expect(globalThis.__parseOpenObserver).toBeUndefined()
  })

  it.each(['author-manuscript', 'reference'])('uses the chooser and frozen session for %s without starting work', async purpose => {
    const f = fixture(purpose), original = f.dialog.showOpenDialog
    const result = await runParseInspectionScenario(purpose, 10, f.context, f.dependencies)
    expect(f.dialog.showOpenDialog).toBe(original)
    expect(f.dependencies.write).toHaveBeenCalledWith(expect.stringContaining('performance-parse-fiction.txt'), f.corpus)
    expect(result).toMatchObject({ attempted: 1, failed: 0, success: true, corpusSha256: corpusSha256(f.corpus),
      corpusBytes: Buffer.byteLength(f.corpus), inspection: { purpose, sourceCount: 1, chapterCount: 10,
        totalBytes: f.inspection.totalBytes, totalWords: f.inspection.totalWords } })
    expect(result.measurements.main.cpu).toEqual({ userUs: 0, systemUs: 0, windowMs: 600 })
    expect(f.context.invoke).toHaveBeenCalledWith(f.context.page, 'dialog:select-novel-files', {
      runId: expect.any(String), purpose, locale: 'zh-CN', expectedProjectPath: f.session.projectPath,
    }, f.session)
    expect(f.context.invoke.mock.calls.map(call => call[1])).toEqual(purpose === 'reference'
      ? ['dialog:select-novel-files', 'db:import-run-get'] : ['dialog:select-novel-files'])
    if (purpose === 'reference') expect(result.inspection).toMatchObject({ classification: 'new', stage: 'prepared',
      status: 'ready', completedSources: 1, totalSources: 1, newCount: 10, duplicateCount: 0, conflictCount: 0 })
    expect(JSON.stringify(result)).not.toMatch(/private-|\/private/)
    await f.context.finalizePerformanceEvidence()
    expect(result).toMatchObject({ requestsAfterMeasurement: 0, requestSummaryCutoff: 'before_quit' })
  })

  it('stops the probe and restores the chooser after an IPC failure without leaking its message', async () => {
    const f = fixture(), original = f.dialog.showOpenDialog
    f.context.invoke.mockRejectedValue(new Error('private-error'))
    let caught
    try { await runParseInspectionScenario('author-manuscript', 10, f.context, f.dependencies) } catch (error) { caught = error }
    expect(caught.performanceBaseline).toMatchObject({ failed: 1, success: false, failureStage: 'import' })
    expect(JSON.stringify(caught.performanceBaseline)).not.toContain('private-error')
    expect(f.dependencies.stop).toHaveBeenCalledOnce()
    expect(f.dialog.showOpenDialog).toBe(original)
  })

  it('restores the chooser when probe startup fails', async () => {
    const f = fixture(), original = f.dialog.showOpenDialog
    f.dependencies.start.mockRejectedValue(new Error('private-start'))
    await expect(runParseInspectionScenario('author-manuscript', 10, f.context, f.dependencies))
      .rejects.toMatchObject({ performanceBaseline: { failed: 1, failureStage: 'probe_start' } })
    expect(f.dialog.showOpenDialog).toBe(original)
    expect(f.dependencies.stop).not.toHaveBeenCalled()
    expect(f.context.invoke).not.toHaveBeenCalled()
  })

  it.each(['cpu', 'rss', 'rss-periodic', 'parse'])('rejects missing %s evidence without presenting it as zero', async missing => {
    const f = fixture()
    if (missing === 'cpu') f.metrics.coverage.cpu = 'unavailable'
    if (missing === 'rss') delete f.metrics.main.memory.rssEnd
    if (missing === 'rss-periodic') f.metrics.main.memory.rssSamples = 2
    if (missing === 'parse') delete f.metrics.main.metrics.metrics['import.parse.ms']
    await expect(runParseInspectionScenario('author-manuscript', 10, f.context, f.dependencies))
      .rejects.toMatchObject({ performanceBaseline: { failed: 1, cleanupFailures: 1 } })
  })

  it('rejects a changed durable reference snapshot', async () => {
    const f = fixture('reference'), invoke = f.context.invoke.getMockImplementation()
    f.context.invoke.mockImplementation(async (...args) => {
      const result = await invoke(...args)
      return args[1] === 'db:import-run-get' ? { ...result, totalChapters: 9 } : result
    })
    await expect(runParseInspectionScenario('reference', 10, f.context, f.dependencies))
      .rejects.toMatchObject({ performanceBaseline: { failed: 1, failureStage: 'verify' } })
  })

  it('records network evidence failure and refuses unexpected requests at the final cutoff', async () => {
    const f = fixture()
    const result = await runParseInspectionScenario('author-manuscript', 10, f.context, f.dependencies)
    f.dependencies.networkCounts.mockResolvedValue({ model: 1, external: 0 })
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({ performanceBaseline: result })
    expect(result).toMatchObject({ success: false, failed: 1, cleanupFailures: 1, failureStage: 'final_request_summary' })
  })
})
