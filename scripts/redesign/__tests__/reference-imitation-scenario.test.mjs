import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { createReferenceImitationScenario } from '../reference-imitation-scenario.mjs'
import { FIXTURE_PROSE } from '../fake-model.mjs'

const STYLE = 'Fictional saved style: clipped sentences, restrained viewpoint.'
const SESSION = { projectId: 'fictional-project', projectPath: '/fictional/target', leaseId: 'fictional-lease-2' }
const HANDLE = { runId: 'fictional-write-run', projectId: SESSION.projectId, epoch: 'fictional-epoch' }
const CONTENT = FIXTURE_PROSE

function fixture({ invalidReceipt = false, onlyPreviousRunComplete = false, persistedBody = CONTENT } = {}) {
  const events = []
  const receipt = { success: true, id: 41, version: 2,
    contentHash: createHash('sha256').update(persistedBody, 'utf8').digest('hex'), content: persistedBody }
  const beforeDrafts = [{ id: 9, chapter_number: 3, version: 1, status: 'draft', content_body: 'Fictional earlier chapter three version.' },
    { id: 10, chapter_number: 4, version: 1, status: 'draft', content_body: 'Fictional chapter four.' }]
  const authoredDrafts = [...beforeDrafts, { id: 41, chapter_number: 3, version: 2, status: 'draft', content_body: persistedBody,
    content_hash: receipt.contentHash }]
  const state = { phase: 'before', openCount: 0, visibleChapter: 4 }
  const stateForPhase = () => state.phase === 'before'
    ? { drafts: beforeDrafts, writingStyle: '', styleReceipt: null, importRun: null }
    : state.phase === 'imported'
      ? { drafts: beforeDrafts, writingStyle: STYLE, styleReceipt: { state: 'committed', effect_receipt_json: JSON.stringify({ writingStyle: STYLE }) },
        importRun: { purpose: 'reference', status: 'completed', stage: 'completed' } }
      : { drafts: authoredDrafts, writingStyle: STYLE, styleReceipt: { state: 'committed', effect_receipt_json: JSON.stringify({ writingStyle: STYLE }) },
        importRun: { purpose: 'reference', status: 'completed', stage: 'completed' } }
  const ipcMain = { _invokeHandlers: new Map([
    ['project:open', vi.fn(async (_event, projectPath, operationId) => ({ success: true, project: {
      id: SESSION.projectId, path: projectPath, sessionLease: `fictional-lease-${++state.openCount + 1}` }, operationId }))],
    ['generation:commit-draft', vi.fn(async (_event, request) => ({ ...receipt, contentHash: invalidReceipt ? 'bad-hash' : receipt.contentHash,
      handle: request.handle, chapterNumber: request.chapterNumber, source: request.source }))],
  ]) }
  const console = { log: vi.fn() }
  const mainContext = createContext({ ipcMain, console })
  const app = { evaluate: async (callback, ...args) => {
    mainContext.__evaluateArgs = [{ ipcMain }, ...args]
    return runInContext(`(${callback.toString()})(...__evaluateArgs)`, mainContext)
  } }
  const consoleWaiters = new Set()
  const emitConsole = text => {
    const message = { text: () => text }
    for (const waiter of consoleWaiters) if (waiter.predicate(message)) {
      consoleWaiters.delete(waiter)
      waiter.resolve(message)
    }
  }
  const page = { fictionalPage: true, waitForEvent: vi.fn((event, { predicate }) => {
    if (event !== 'console') throw new Error('FICTIONAL_UNEXPECTED_PAGE_EVENT')
    const gate = deferred()
    consoleWaiters.add({ predicate, resolve: gate.resolve })
    return gate.promise
  }), waitForFunction: vi.fn(async (predicate, chapterNumber) => {
    const cards = [
      { title: '参考资料 · 导入', state: 'completed' },
      { title: '第 3 章 · 写稿', state: onlyPreviousRunComplete ? 'running' : 'completed' },
    ]
    const document = { querySelectorAll: () => cards.map(card => ({
      querySelector: selector => selector === '.run-card-title' ? { textContent: card.title } : null,
      getAttribute: name => name === 'data-state' ? card.state : null,
    })) }
    const completed = runInContext(`(${predicate.toString()})(${chapterNumber})`, createContext({ document }))
    if (!completed) throw new Error('FICTIONAL_TARGET_CHAPTER_RUN_NOT_COMPLETE')
    events.push(['wait-for-write-run-complete', chapterNumber])
  }) }
  const fake = { replyImport: vi.fn(), chats: [] }
  const invoke = vi.fn(async (_page, channel, ...args) => {
    events.push(['invoke', channel, ...args])
    if (ipcMain._invokeHandlers.has(channel)) return ipcMain._invokeHandlers.get(channel)({}, ...args)
    if (channel === 'generation:read-context') return { operation: 'chapter-draft', chapterNumber: 3,
      draftSave: { kind: 'current', receipt: { ...receipt, contentHash: invalidReceipt ? 'bad-hash' : receipt.contentHash } } }
    if (channel === 'db:draft-get-latest') return { id: 41, version: 2 }
    throw new Error(`Unexpected IPC ${channel}`)
  })
  const context = { app, page, fake, invoke, roots: { temp: 'C:/fictional/temp' }, samplePath: 'C:/fictional/target',
    shoot: vi.fn(), maxRealRequests: 0, diagnostics: [] }
  const readDb = (_context, read) => read({ prepare(sql) {
    const data = stateForPhase()
    if (sql.includes('drafts_all')) return { all: () => data.drafts }
    if (sql.includes('project_core')) return { get: () => ({ writing_style: data.writingStyle }) }
    if (sql.includes('import_run_receipts')) return { get: () => data.styleReceipt }
    if (sql.includes('import_runs')) return { get: () => data.importRun }
    throw new Error(`Unexpected SQL ${sql}`)
  } })
  const stage = {
    root: () => ({ getByRole: () => ({ getByRole: () => ({ click: async () => events.push(['import-menu']) }) }) }),
    backToLibrary: vi.fn(async () => { events.push(['close-project']); state.phase = 'reopened' }),
    openFromLibrary: vi.fn(async () => {
      events.push(['reopen-project'])
      await ipcMain._invokeHandlers.get('project:open')({}, SESSION.projectPath, 'fictional-open-operation')
      emitConsole(`[ProjectService] 项目数据加载完成: ${context.samplePath}`)
    }),
  }
  const prose = { filter: () => ({ first: () => ({ waitFor: async () => {} }) }),
    innerText: vi.fn(async () => {
      events.push(['read-visible-body', state.visibleChapter])
      return state.visibleChapter === 3 ? persistedBody : beforeDrafts[1].content_body
    }) }
  const title = { filter: () => ({ waitFor: vi.fn(async () => {}) }),
    innerText: vi.fn(async () => `第${state.visibleChapter}章`) }
  const chapterView = { prose: () => prose, title: () => title,
    open: vi.fn(async (_page, chapterNumber) => {
      state.visibleChapter = chapterNumber
      events.push(['open-visible-chapter', chapterNumber])
    }) }
  const blueprint = {
    open: vi.fn(async () => events.push(['open-blueprint'])),
    writeNext: vi.fn(async () => {
    events.push(['write-chapter', 3]); state.phase = 'written'
    fake.chats.push({ kind: 'prose', model: 'fixture', messages: [{ role: 'user', content: `writer prompt\n${STYLE}` }] })
    await ipcMain._invokeHandlers.get('generation:commit-draft')({}, {
      handle: HANDLE, chapterNumber: 3, source: 'write', expectedCompositionHash: receipt.contentHash,
    })
    }),
  }
  const runSheet = { waitUntilOpen: vi.fn(async () => {}), waitForRunDone: vi.fn(async () => {}) }
  const startImport = vi.fn(async () => { events.push(['import-reference-five-steps']); state.phase = 'imported' })
  const referenceNovel = vi.fn(() => 'C:/fictional/temp/reference.txt')
  const scenario = createReferenceImitationScenario({ readDb, startImport, referenceNovel, stageApi: stage,
    blueprintApi: blueprint, chapterApi: chapterView, runApi: runSheet,
    waitForProse: async () => {}, projectName: 'Fictional Target' })
  return { scenario, context, events, fake, invoke, stage, blueprint, page, runSheet, ipcMain, beforeDrafts, authoredDrafts,
    mainContext, console, emitConsole, chapterView, prose, title }
}

const OBSERVER = '__f537ReferenceImitation'
function diagnostics(f) {
  return JSON.parse(f.context.diagnostics.find(line => line.startsWith('reference-imitation-ipc:'))
    .slice('reference-imitation-ipc:'.length))
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
// Match drive.mjs's non-performance scenario report boundary without importing its executable entrypoint.
const driverMessageOf = error => error instanceof Error ? error.message : String(error)
function failObserverRestore(f, failure) {
  const handlers = f.ipcMain._invokeHandlers, original = handlers.get('project:open'), set = handlers.set.bind(handlers)
  handlers.set = (channel, value) => {
    if (channel === 'project:open' && value === original) throw failure
    return set(channel, value)
  }
}
function cleanupDiagnostics(f) {
  return f.context.diagnostics.filter(line => line.startsWith('reference-imitation-cleanup:'))
    .map(line => JSON.parse(line.slice('reference-imitation-cleanup:'.length)))
}

describe('reference imitation author-chain scenario', () => {
  it('runs import, consumes saved style in the actual prose request, commits a draft, and recovers it after reopen', async () => {
    const f = fixture()
    const result = await f.scenario.run(f.context)

    expect(f.fake.replyImport).toHaveBeenCalledOnce()
    expect(f.events).toEqual(expect.arrayContaining([['import-reference-five-steps'], ['open-blueprint'], ['write-chapter', 3],
      ['wait-for-write-run-complete', 3], ['close-project'], ['reopen-project']]))
    expect(f.runSheet.waitForRunDone).toHaveBeenCalledOnce()
    expect(f.page.waitForFunction).toHaveBeenCalledOnce()
    expect(f.stage.backToLibrary).toHaveBeenCalledWith(f.context.page, 'Fictional Target')
    expect(f.stage.openFromLibrary).toHaveBeenCalledWith(f.context.page, 'Fictional Target')
    expect(f.ipcMain._invokeHandlers.get('generation:commit-draft')).toHaveBeenCalledOnce()
    expect(f.ipcMain._invokeHandlers.get('project:open')).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ styleConsumed: true, importDraftsUnchanged: true, chapterNumber: 3,
      savedDraftId: 41, savedDraftVersion: 2, reopenedDraftId: 41, recoveredReceipt: true })
    expect(result.styleHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain(STYLE)
    expect(f.invoke).toHaveBeenCalledWith(f.context.page, 'generation:read-context', { handle: HANDLE }, SESSION)
    expect(f.invoke).toHaveBeenCalledWith(f.context.page, 'db:draft-get-latest', 3, SESSION.projectPath, SESSION)
  })

  it('opens the recovered new chapter three and measures its actual visible body instead of the old chapter four', async () => {
    const f = fixture()
    const result = await f.scenario.run(f.context)
    expect(f.chapterView.open).toHaveBeenCalledWith(f.page, 3)
    expect(f.title.innerText).toHaveBeenCalledOnce()
    expect(f.prose.innerText).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ visibleChapterNumber: 3,
      visibleBodyHash: createHash('sha256').update(FIXTURE_PROSE, 'utf8').digest('hex') })
    const recoveredAt = f.events.findIndex(event => event[0] === 'invoke' && event[1] === 'generation:read-context')
    const openedAt = f.events.findIndex(event => event[0] === 'open-visible-chapter' && event[1] === 3)
    const readAt = f.events.findIndex(event => event[0] === 'read-visible-body' && event[1] === 3)
    expect(openedAt).toBeGreaterThan(recoveredAt)
    expect(readAt).toBeGreaterThan(openedAt)
    expect(result.visibleBodyHash).toBe(result.savedContentHash)
  })

  it.each([['the saved style', STYLE], ['an unrelated reply', 'Fictional unrelated output, not the requested prose.']])(
    'rejects a saved body equal to %s even when its commit and recovery receipts match', async (_label, persistedBody) => {
      const f = fixture({ persistedBody })
      await expect(f.scenario.run(f.context)).rejects.toThrow(/REFERENCE_IMITATION_PROSE_OUTPUT_MISMATCH/)
    })

  it('waits for the reopened current project loaded signal before reading its recovery receipt', async () => {
    const f = fixture(), reopened = deferred()
    f.stage.openFromLibrary.mockImplementationOnce(async () => {
      await f.ipcMain._invokeHandlers.get('project:open')({}, SESSION.projectPath, 'fictional-open-operation')
      f.emitConsole(`[ProjectService] 项目数据加载完成: ${f.context.samplePath}-other`)
      f.emitConsole(`[OtherService] 项目数据加载完成: ${f.context.samplePath}`)
      reopened.resolve()
    })
    const running = f.scenario.run(f.context)
    await reopened.promise
    try {
      expect(f.page.waitForEvent).toHaveBeenCalledWith('console', { predicate: expect.any(Function), timeout: 30_000 })
      expect(f.invoke.mock.calls.some(([, channel]) => channel === 'generation:read-context')).toBe(false)
      f.emitConsole(`[ProjectService] 项目数据加载完成: ${f.context.samplePath}`)
      const result = await running
      expect(result.recoveredReceipt).toBe(true)
      expect(f.invoke.mock.calls.filter(([, channel]) => channel === 'generation:read-context')).toHaveLength(1)
    } finally {
      f.emitConsole(`[ProjectService] 项目数据加载完成: ${f.context.samplePath}`)
      await running
    }
  })

  it('handles the loaded waiter rejection when opening the project fails without reading recovery', async () => {
    const f = fixture(), loaded = deferred(), primary = new Error('FICTIONAL_OPEN_FAILED')
    const then = vi.spyOn(loaded.promise, 'then')
    f.page.waitForEvent.mockReturnValueOnce(loaded.promise)
    f.stage.openFromLibrary.mockRejectedValueOnce(primary)
    try {
      await expect(f.scenario.run(f.context)).rejects.toBe(primary)
      expect(f.page.waitForEvent).toHaveBeenCalledOnce()
      expect(then.mock.calls.some(([, onRejected]) => typeof onRejected === 'function')).toBe(true)
      expect(f.invoke.mock.calls.some(([, channel]) => channel === 'generation:read-context')).toBe(false)
    } finally {
      loaded.promise.catch(() => {})
      loaded.reject(new Error('FICTIONAL_PROJECT_LOADED_TIMEOUT'))
      await Promise.resolve()
    }
  })

  it('rejects a write receipt that does not match its persisted draft content hash', async () => {
    const f = fixture({ invalidReceipt: true })
    await expect(f.scenario.run(f.context)).rejects.toThrow(/DRAFT_RECEIPT/)
  })

  it('does not treat the previous import completion as completion of the chapter write', async () => {
    const f = fixture({ onlyPreviousRunComplete: true })
    await expect(f.scenario.run(f.context)).rejects.toThrow('FICTIONAL_TARGET_CHAPTER_RUN_NOT_COMPLETE')
    expect(f.stage.backToLibrary).not.toHaveBeenCalled()
  })

  it('restores the first handler if isolated main-process evaluation fails while replacing the second', async () => {
    const f = fixture()
    const handlers = f.ipcMain._invokeHandlers
    const originalOpen = handlers.get('project:open')
    const originalCommit = handlers.get('generation:commit-draft')
    const set = handlers.set.bind(handlers)
    handlers.set = (key, value) => {
      if (key === 'generation:commit-draft') throw new Error('FICTIONAL_HANDLER_INSTALL_FAILURE')
      return set(key, value)
    }

    await expect(f.scenario.run(f.context)).rejects.toThrow('FICTIONAL_HANDLER_INSTALL_FAILURE')
    expect(handlers.get('project:open')).toBe(originalOpen)
    expect(handlers.get('generation:commit-draft')).toBe(originalCommit)
    expect(f.mainContext[OBSERVER]).toBeUndefined()
    expect(f.mainContext[`${OBSERVER}Original`]).toBeUndefined()
  })

  it('captures safe pending FS evidence at recovery entry and failure without claiming an acquired view lock', async () => {
    const f = fixture(), gate = deferred(), handlers = f.ipcMain._invokeHandlers
    const failure = new Error('PROJECT_RUNTIME_BUSY')
    const list = vi.fn(() => gate.promise), recovery = vi.fn(async () => { throw failure })
    handlers.set('fs:list-dir', list)
    handlers.set('generation:read-context', recovery)
    const originals = new Map(handlers)
    let pendingCall
    f.blueprint.open.mockImplementationOnce(async () => {
      pendingCall = handlers.get('fs:list-dir')({ secret: 'event-secret' }, 'C:/private/path-secret', SESSION)
    })
    try {
      await expect(f.scenario.run(f.context)).rejects.toBe(failure)
      const observed = diagnostics(f)
      const fsStart = observed.trace.find(entry => entry.channel === 'fs:list-dir' && entry.phase === 'start')
      expect(fsStart).toMatchObject({ session: 'session-1', invocationId: expect.any(Number), startedAt: expect.any(Number) })
      expect(observed.pendingDoesNotProveClaim).toBe(true)
      for (const boundary of ['recovery-enter', 'recovery-failed', 'scenario-failed']) {
        expect(observed.snapshots.find(entry => entry.boundary === boundary)).toMatchObject({ pendingDoesNotProveClaim: true,
          pending: expect.arrayContaining([expect.objectContaining({ channel: 'fs:list-dir', invocationId: fsStart.invocationId,
            session: 'session-1', elapsedMs: expect.any(Number) })]) })
      }
      expect(observed.trace.find(entry => entry.channel === 'generation:read-context' && entry.phase === 'end'))
        .toMatchObject({ outcome: 'threw', errorCode: 'PROJECT_RUNTIME_BUSY', endedAt: expect.any(Number), elapsedMs: expect.any(Number) })
      expect(list).toHaveBeenCalledWith({ secret: 'event-secret' }, 'C:/private/path-secret', SESSION)
      const output = JSON.stringify([f.context.diagnostics, f.console.log.mock.calls])
      for (const privateValue of ['path-secret', 'event-secret', SESSION.projectId, SESSION.projectPath, SESSION.leaseId, CONTENT, STYLE])
        expect(output).not.toContain(privateValue)
      for (const [channel, original] of originals) expect(handlers.get(channel)).toBe(original)
      expect(f.mainContext[OBSERVER]).toBeUndefined()
      expect(f.mainContext[`${OBSERVER}Original`]).toBeUndefined()
    } finally {
      gate.resolve({ success: true })
      await pendingCall
    }
  })

  it('passes through allowlisted handlers and leaves other channels untouched, with only validated opaque sessions and codes', async () => {
    const f = fixture(), handlers = f.ipcMain._invokeHandlers
    const returned = { success: false, error: 'Error: PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT' }
    const unknown = new Error('raw-error-secret C:/private/error-secret')
    const read = vi.fn(async () => returned), find = vi.fn(async () => { throw unknown })
    const untouched = vi.fn()
    handlers.set('db:review-get-full', read)
    handlers.set('generation:find-blueprint-recovery', find)
    handlers.set('fs:unreviewed-secret', untouched)
    f.blueprint.open.mockImplementationOnce(async () => {
      expect(handlers.get('fs:unreviewed-secret')).toBe(untouched)
      expect(await handlers.get('db:review-get-full')({}, { secret: 'args-secret' }, SESSION)).toBe(returned)
      await expect(handlers.get('generation:find-blueprint-recovery')({}, { projectId: 'malformed-secret' })).rejects.toBe(unknown)
    })
    await f.scenario.run(f.context)
    const observed = diagnostics(f)
    expect(observed.trace.find(entry => entry.channel === 'db:review-get-full' && entry.phase === 'end'))
      .toMatchObject({ outcome: 'returned', errorCode: 'PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT', session: 'session-1' })
    expect(observed.trace.find(entry => entry.channel === 'generation:find-blueprint-recovery' && entry.phase === 'end'))
      .toMatchObject({ outcome: 'threw', errorCode: null, session: null })
    expect(observed.trace.every(entry => entry.channel !== 'fs:unreviewed-secret')).toBe(true)
    expect(JSON.stringify([f.context.diagnostics, f.console.log.mock.calls])).not.toMatch(/raw-error-secret|error-secret|args-secret|malformed-secret/)
    expect(handlers.get('db:review-get-full')).toBe(read)
    expect(handlers.get('generation:find-blueprint-recovery')).toBe(find)
  })

  it('bounds stored trace, pending snapshots and console output during repeated recovery reads', async () => {
    const f = fixture(), handlers = f.ipcMain._invokeHandlers
    handlers.set('generation:find-blueprint-recovery', vi.fn(async () => null))
    f.blueprint.open.mockImplementationOnce(async () => {
      for (let index = 0; index < 150; index++) await handlers.get('generation:find-blueprint-recovery')({}, SESSION)
    })
    await f.scenario.run(f.context)
    const observed = diagnostics(f)
    expect(observed.trace).toHaveLength(256)
    expect(observed.snapshots).toHaveLength(16)
    expect(observed.pending).toEqual([])
    expect(observed.droppedTrace).toBeGreaterThan(0)
    expect(observed.droppedSnapshots).toBeGreaterThan(0)
    expect(observed.droppedConsole).toBeGreaterThan(0)
    expect(f.console.log.mock.calls).toHaveLength(256)
  })

  it('rolls back every earlier diagnostic wrapper when a later allowlisted handler installation fails', async () => {
    const f = fixture(), handlers = f.ipcMain._invokeHandlers
    handlers.set('fs:list-dir', vi.fn())
    handlers.set('db:review-get-full', vi.fn())
    const originals = new Map(handlers), set = handlers.set.bind(handlers)
    handlers.set = (channel, value) => {
      if (channel === 'db:review-get-full' && value !== originals.get(channel)) throw new Error('FICTIONAL_DIAGNOSTIC_INSTALL_FAILURE')
      return set(channel, value)
    }
    await expect(f.scenario.run(f.context)).rejects.toThrow('FICTIONAL_DIAGNOSTIC_INSTALL_FAILURE')
    for (const [channel, original] of originals) expect(handlers.get(channel)).toBe(original)
    expect(f.mainContext[OBSERVER]).toBeUndefined()
    expect(f.mainContext[`${OBSERVER}Original`]).toBeUndefined()
  })

  it('preserves the install primary at the driver boundary and safely reports rollback failure without replacing another handler', async () => {
    const f = fixture(), handlers = f.ipcMain._invokeHandlers
    handlers.set('fs:list-dir', vi.fn())
    handlers.set('db:review-get-full', vi.fn())
    const originals = new Map(handlers), set = handlers.set.bind(handlers)
    const primary = new Error('PROJECT_RUNTIME_BUSY'), thirdParty = vi.fn()
    handlers.set = (channel, value) => {
      if (channel === 'db:review-get-full' && value !== originals.get(channel)) {
        set('fs:list-dir', thirdParty)
        throw primary
      }
      if (channel === 'project:open' && value === originals.get(channel))
        throw new Error('rollback-secret C:/private/rollback-path')
      return set(channel, value)
    }
    let failure
    try { await f.scenario.run(f.context) } catch (error) { failure = error }
    expect(failure).toBe(primary)
    expect(driverMessageOf(failure)).toBe('PROJECT_RUNTIME_BUSY')
    expect(f.console.log.mock.calls).toEqual([[
      'reference-imitation-ipc:{"type":"cleanup","phase":"install-rollback","errorCode":"REFERENCE_IMITATION_OBSERVER_INSTALL_ROLLBACK_FAILED"}',
    ]])
    expect(JSON.stringify([driverMessageOf(failure), f.context.diagnostics, f.console.log.mock.calls]))
      .not.toMatch(/rollback-secret|rollback-path/)
    expect(handlers.get('fs:list-dir')).toBe(thirdParty)
    expect(handlers.get('generation:commit-draft')).toBe(originals.get('generation:commit-draft'))
    expect(handlers.get('db:review-get-full')).toBe(originals.get('db:review-get-full'))
    expect(f.fake.replyImport).not.toHaveBeenCalled()
  })

  it.each(['PROJECT_RUNTIME_BUSY', 'PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT'])(
    'preserves %s at the driver message boundary when snapshot and restore both fail', async code => {
      const f = fixture(), handlers = f.ipcMain._invokeHandlers, primary = new Error(code)
      const originalCommit = handlers.get('generation:commit-draft')
      handlers.set('generation:read-context', vi.fn(async () => { throw primary }))
      failObserverRestore(f, new Error('restore-secret C:/private/restore-path'))
      const evaluate = f.context.app.evaluate
      f.context.app.evaluate = async (callback, ...args) => {
        if (args[0]?.observerKey === OBSERVER) throw new Error('snapshot-secret C:/private/snapshot-path')
        return evaluate(callback, ...args)
      }
      let failure
      try { await f.scenario.run(f.context) } catch (error) { failure = error }
      expect(failure).toBe(primary)
      expect(driverMessageOf(failure)).toBe(code)
      expect(cleanupDiagnostics(f)).toEqual([
        { phase: 'snapshot', errorCode: 'REFERENCE_IMITATION_OBSERVER_SNAPSHOT_FAILED' },
        { phase: 'restore', errorCode: 'REFERENCE_IMITATION_OBSERVER_RESTORE_FAILED' },
      ])
      expect(handlers.get('generation:commit-draft')).toBe(originalCommit)
      const output = JSON.stringify([driverMessageOf(failure), f.context.diagnostics, f.console.log.mock.calls])
      expect(output).not.toMatch(/restore-secret|restore-path|snapshot-secret|snapshot-path/)
    })

  it('keeps an unclassified primary object unchanged without adding its raw message to diagnostics', async () => {
    const f = fixture(), primary = new Error('primary-secret C:/private/primary-path')
    f.ipcMain._invokeHandlers.set('generation:read-context', vi.fn(async () => { throw primary }))
    failObserverRestore(f, new Error('restore-secret C:/private/restore-path'))
    let failure
    try { await f.scenario.run(f.context) } catch (error) { failure = error }
    expect(failure).toBe(primary)
    expect(driverMessageOf(failure)).toBe(primary.message)
    expect(cleanupDiagnostics(f)).toEqual([
      { phase: 'restore', errorCode: 'REFERENCE_IMITATION_OBSERVER_RESTORE_FAILED' },
    ])
    expect(diagnostics(f).snapshots.at(-1).boundary).toBe('scenario-failed')
    expect(JSON.stringify([f.context.diagnostics, f.console.log.mock.calls]))
      .not.toMatch(/primary-secret|primary-path|restore-secret|restore-path/)
  })

  it('still fails the driver report safely when cleanup fails after an otherwise successful scenario', async () => {
    const f = fixture()
    failObserverRestore(f, new Error('restore-secret C:/private/restore-path'))
    let failure
    try { await f.scenario.run(f.context) } catch (error) { failure = error }
    expect(driverMessageOf(failure)).toBe('REFERENCE_IMITATION_OBSERVER_CLEANUP_FAILED')
    expect(cleanupDiagnostics(f)).toEqual([
      { phase: 'restore', errorCode: 'REFERENCE_IMITATION_OBSERVER_RESTORE_FAILED' },
    ])
    expect(diagnostics(f).snapshots.at(-1).boundary).toBe('scenario-finally')
    expect(JSON.stringify([driverMessageOf(failure), f.context.diagnostics, f.console.log.mock.calls]))
      .not.toMatch(/restore-secret|restore-path/)
  })
})
