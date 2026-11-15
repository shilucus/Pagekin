import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import * as stage from '../pages/stage.mjs'
import { assertProjectStoragePathSupported } from '../../../electron/services/project-storage-preflight.ts'
import { assertReferenceBackgroundCompletion, referenceBackgroundScenario, REFERENCE_BACKGROUND_SCENARIO,
  BACKGROUND_BOOK, BACKGROUND_EDIT, installReferenceBackgroundObserver,
  removeReferenceBackgroundObserver, openReferenceBackgroundBook } from '../reference-run-background-scenario.mjs'

// These synthetic observations test the scenario's refusal criteria, not Electron or background execution.
function completedFixture() {
  const reference = { projectId: 'fictional-A', runId: 'fictional-run', grantId: 'fictional-grant', revision: 1 }
  const execution = { owner: 'fictional-owner', epoch: 1 }
  const session = { projectId: reference.projectId, projectPath: '/fictional/A', leaseId: 'fictional-view-1' }
  const identity = () => ({ reference: { ...reference }, execution: { ...execution } })
  const stages = ['knowledge', 'global', 'style', 'blueprints', 'refresh']
  const beforeDrafts = [
    { id: 1, status: 'finalized', content_body: 'Fictional finalized chapter one.' },
    { id: 2, status: 'finalized', content_body: 'Fictional finalized chapter two.' },
    { id: 3, status: 'reviewed', content_body: 'Fictional reviewed draft.' },
    { id: 4, status: 'draft', content_body: 'Fictional draft.' },
  ]
  const beforeB = { core: [{ core_outline: BACKGROUND_EDIT }], blueprints: [], drafts: [], runs: [], grants: [], receipts: [], knowledge: [] }
  const prefix = [{ ...identity(), session: { ...session }, stage: 'knowledge', decision: 'settled' }]
  const baselineProgress = [
    { ...identity(), leaseId: session.leaseId, stage: 'knowledge', sequence: 1, kind: 'stage-started' },
    { ...identity(), leaseId: session.leaseId, stage: 'knowledge', sequence: 2, kind: 'stage-completed' },
    { ...identity(), leaseId: session.leaseId, stage: 'global', sequence: 3, kind: 'stage-started' },
  ]
  const modelDispatch = { attempt_id: 'fictional-model-attempt', run_id: 'fictional-generation-run',
    project_id: reference.projectId, epoch: session.leaseId, import_run_id: reference.runId,
    operation: 'import-global-facts', purpose: 'import-inference', status: 'dispatch-marked', finish_reason: null, failure_code: null }
  return structuredClone({
    observed: { calls: [{ ...identity(), session }], settled: true, success: true, cancellations: [],
      acks: stages.map((stage, index) => ({ ...identity(), session: { ...session,
        leaseId: index === 0 ? session.leaseId : 'fictional-view-2' }, stage, decision: 'settled' })) },
    beforeSwitch: { calls: [{ ...identity(), session }], settled: false, cancellations: [], acks: structuredClone(prefix),
      view: { activeProjectPath: session.projectPath, dbReady: true }, progress: baselineProgress },
    inB: { settled: false, acks: structuredClone(prefix), view: { activeProjectPath: '/fictional/B', dbReady: true },
      progress: [...baselineProgress, { ...identity(), leaseId: session.leaseId, stage: 'global', sequence: 4, kind: 'stage-completed' }] },
    progress: [...baselineProgress, ...stages.slice(1).map((stage, index) => ({ ...identity(),
      leaseId: session.leaseId, stage, sequence: index + 4, kind: 'stage-completed' }))],
    completed: { run: { id: reference.runId, purpose: 'reference', stage: 'completed', status: 'completed' },
      grants: [{ grant_id: reference.grantId, revision: reference.revision, state: 'completed' }],
      knowledge: 10, receipts: ['global', 'style', 'blueprints'].map(stage => ({ stage, state: 'committed' })),
      blueprints: Array.from({ length: 10 }, (_, index) => index + 1), drafts: beforeDrafts,
      modelDispatches: [{ ...modelDispatch, status: 'settled', finish_reason: 'stop' }],
      embeddingDispatches: [{ dispatch_id: 'fictional-dispatch', import_run_id: reference.runId,
        state: 'response_received', http_status: 200, settled_at: 2 }] },
    heldModelDispatches: [modelDispatch],
    beforeDrafts, beforeB, afterB: beforeB, returnLease: 'fictional-view-2',
  })
}

describe('reference whole-run A-B-A scenario contract', () => {
  it('checks B on the shelf then returns to the already open A without reopening its lease', async () => {
    const steps = []
    const root = path.resolve('fictional-background-root')
    const projects = path.join(root, 'projects')
    const page = { evaluate: vi.fn(async () => ({ grantId: 'fictional-directory-grant' })) }
    const context = { app: { evaluate: vi.fn(async () => {}) }, page, roots: { root, projects },
      invoke: vi.fn(async (_page, channel) => {
        expect(channel).toBe('project:create')
        steps.push('create-B')
        return { success: true, projectPath: path.join(projects, BACKGROUND_BOOK), projectId: 'fictional-B' }
      }) }
    const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation(value => value)
    const back = vi.spyOn(stage, 'backToLibrary').mockImplementation(async () => { steps.push('library') })
    const cover = vi.spyOn(stage, 'cover').mockImplementation((_page, name) => ({
      waitFor: async options => {
        expect(name).toBe(BACKGROUND_BOOK)
        expect(options).toEqual({ state: 'visible' })
        steps.push('B-visible')
      },
    }))
    const open = vi.spyOn(stage, 'openFromPalette').mockImplementation(async () => { steps.push('reopen-A') })
    const menu = vi.spyOn(stage, 'bookMenu').mockImplementation(async (received, name, item) => {
      expect(received).toBe(page)
      expect(name).toBe('灯塔')
      expect(item).toBe('回到作品')
      steps.push('return-to-current-A')
    })
    const spine = vi.spyOn(stage, 'spine').mockImplementation(received => ({ waitFor: async options => {
      expect(received).toBe(page)
      expect(options).toEqual({ state: 'visible' })
      steps.push('A-spine-visible')
    } }))
    try {
      await referenceBackgroundScenario({ seedStageSample: async received => {
        expect(received).toBe(context)
        context.samplePath = path.join(projects, '灯塔')
        steps.push('seed-A')
      } }).setup(context)
      expect(steps).toEqual(['create-B', 'seed-A', 'library', 'B-visible', 'return-to-current-A', 'A-spine-visible'])
      expect(context.invoke).toHaveBeenCalledTimes(1)
      expect(open).not.toHaveBeenCalled()
    } finally {
      realpath.mockRestore()
      back.mockRestore()
      cover.mockRestore()
      open.mockRestore()
      menu.mockRestore()
      spine.mockRestore()
    }
  })

  it.each([['灯塔', BACKGROUND_BOOK], [BACKGROUND_BOOK, '灯塔']])(
    'opens %s to %s only through the real library navigation before selecting a recent book', async (currentName, nextName) => {
      const steps = []
      const back = vi.spyOn(stage, 'backToLibrary').mockImplementation(async (page, name) => {
        expect(page).toEqual({ fictionalPage: true })
        steps.push(['library', name])
      })
      const cover = vi.spyOn(stage, 'cover').mockImplementation((_page, name) => ({
        waitFor: async options => {
          expect(options).toEqual({ state: 'visible' })
          steps.push(['visible', name])
        },
      }))
      const open = vi.spyOn(stage, 'openFromPalette').mockImplementation(async (_page, name) => {
        steps.push(['open', name])
      })
      try {
        await openReferenceBackgroundBook({ fictionalPage: true }, currentName, nextName)
        expect(steps).toEqual([['library', currentName], ['visible', nextName], ['open', nextName]])
      } finally {
        back.mockRestore()
        cover.mockRestore()
        open.mockRestore()
      }
    })

  it('uses the existing model-backed stage scenario shape without running its setup', () => {
    const scenario = referenceBackgroundScenario({})
    expect(REFERENCE_BACKGROUND_SCENARIO).toBe('f537-reference-background-10')
    expect(BACKGROUND_BOOK).not.toBe('灯塔')
    expect(scenario).toMatchObject({ model: true, shell: 'stage', setup: expect.any(Function), run: expect.any(Function) })
  })

  it('actively reopens the final RunSheet after receipt assertions before checking run completion and its toast', () => {
    const source = fs.readFileSync(new URL('../reference-run-background-scenario.mjs', import.meta.url), 'utf8')
    const completion = source.indexOf('assertReferenceBackgroundCompletion({ observed, progress, completed,')
    expect(completion).toBeGreaterThan(-1)
    const finalChecks = source.slice(completion, source.indexOf('result = { scenario:', completion))
    expect(finalChecks).toMatch(/await runSheet\.openFromPalette\(page\)\s+await runSheet\.waitUntilOpen\(page\)\s+await runSheet\.waitForRunDone\(page, 90_000\)/u)
  })

  it('fits the unchanged Windows storage gate under a 79-character isolated projects root', () => {
    const parent = 'C:\\' + 'f'.repeat(76)
    const root = path.win32.join(parent, BACKGROUND_BOOK)
    expect(root).toHaveLength(85)
    expect(() => assertProjectStoragePathSupported(root, { platform: 'win32' })).not.toThrow()
    expect(() => assertProjectStoragePathSupported(path.win32.join(parent, 'Reference background B'), { platform: 'win32' })).toThrow()
  })

  it('accepts the original A settled prefix and remaining new-lease ACKs after returning to A', () => {
    expect(() => assertReferenceBackgroundCompletion(completedFixture())).not.toThrow()
  })

  it('does not require a remote embedding dispatch when the actual held request is the global model', () => {
    const value = completedFixture()
    value.completed.embeddingDispatches = []
    expect(() => assertReferenceBackgroundCompletion(value)).not.toThrow()
  })

  it.each([
    ['reexecuted whole run', value => value.observed.calls.push(value.observed.calls[0]), 'must not execute the whole run again'],
    ['same view lease', value => { value.returnLease = value.observed.calls[0].session.leaseId }, 'new view lease'],
    ['whole run settled while viewing B', value => { value.inB.settled = true }, 'whole run must wait for the A projection view'],
    ['whole ACK while viewing B', value => { value.inB.acks.push(value.observed.acks[1]) }, 'B must not add or change whole projection ACKs'],
    ['missing baseline prefix', value => { value.beforeSwitch.acks = [] }, 'baseline completed stages must match its settled ACK prefix'],
    ['reordered baseline prefix', value => { value.beforeSwitch.acks[0].stage = 'global' }, 'baseline ACKs must be an ordered settled prefix'],
    ['tampered baseline prefix', value => { value.beforeSwitch.acks[0].execution.epoch++ }, 'original owner/epoch'],
    ['baseline prefix using the return lease', value => { value.beforeSwitch.acks[0].session.leaseId = value.returnLease }, 'baseline ACK must use the original A view lease'],
    ['baseline not in A', value => { value.beforeSwitch.view.activeProjectPath = '/fictional/B' }, 'baseline must capture the actual A view'],
    ['prefix changed after switching', value => { value.observed.acks[0].session.leaseId = value.returnLease }, 'settled ACK prefix must remain unchanged'],
    ['prefix changed while in B', value => { value.inB.acks[0].decision = 'projection-failed' }, 'B must not add or change whole projection ACKs'],
    ['old progress reused in B', value => { value.inB.progress = value.beforeSwitch.progress }, 'B must observe a newly completed stage after the baseline sequence'],
    ['unsettled invocation', value => { value.observed.settled = false }, 'must settle'],
    ['failed invocation', value => { value.observed.success = false }, 'must succeed'],
    ['view-switch cancellation', value => value.observed.cancellations.push({ channel: 'db:import-run-request-cancel' }), 'must not cancel'],
    ['missing ACK', value => value.observed.acks.pop(), 'all five real projection ACKs'],
    ['cancelled projection', value => { value.observed.acks[0].decision = 'cancelled' }, 'all five real projection ACKs'],
    ['foreign ACK grant', value => { value.observed.acks[1].reference.grantId = 'foreign-grant' }, 'original project/run/grant/revision'],
    ['foreign ACK epoch', value => { value.observed.acks[1].execution.epoch++ }, 'original owner/epoch'],
    ['ACK rebound to B', value => { value.observed.acks[1].session = { ...value.observed.acks[1].session, projectId: 'fictional-B' } }, 'ACK cannot be rebound to B'],
    ['ACK using B root', value => { value.observed.acks[1].session = { ...value.observed.acks[1].session, projectPath: '/fictional/B' } }, 'ACK cannot use the B root'],
    ['remaining ACK using the original execution lease', value => { value.observed.acks[1].session.leaseId = value.observed.calls[0].session.leaseId }, 'remaining ACK must use the actual returned A view lease'],
    ['no actual progress', value => { value.progress = [] }, 'actual renderer progress'],
    ['foreign progress project', value => { value.progress[0].reference.projectId = 'fictional-B' }, 'original project/run/grant/revision'],
    ['progress rebound to new view', value => { value.progress[0].leaseId = value.returnLease }, 'original execution lease'],
    ['uncommitted knowledge', value => { value.completed.knowledge = 9 }, 'all ten chapter knowledge receipts'],
    ['no held dispatch evidence', value => { value.heldModelDispatches = [] }, 'held HTTP must have the original A model dispatch'],
    ['already settled held dispatch', value => { value.heldModelDispatches[0].status = 'settled' }, 'held HTTP must have the original A model dispatch'],
    ['foreign held dispatch', value => { value.heldModelDispatches[0].project_id = 'fictional-B' }, 'held HTTP must have the original A model dispatch'],
    ['held dispatch using another lease', value => { value.heldModelDispatches[0].epoch = value.returnLease }, 'held HTTP must have the original A model dispatch'],
    ['held dispatch using another operation', value => { value.heldModelDispatches[0].operation = 'import-style' }, 'held HTTP must have the original A model dispatch'],
    ['held dispatch using another task purpose', value => { value.heldModelDispatches[0].purpose = 'import-global-facts' }, 'held HTTP must have the original A model dispatch'],
    ['missing original model settlement', value => { value.completed.modelDispatches = [] }, 'held model request requires its original successful durable settlement'],
    ['unresolved embedding dispatch', value => { value.completed.embeddingDispatches[0].state = 'transport_unknown' }, 'successful durable response settlement'],
    ['failed embedding response', value => { value.completed.embeddingDispatches[0].http_status = 500 }, 'successful durable response settlement'],
    ['missing global receipt', value => { value.completed.receipts = value.completed.receipts.filter(receipt => receipt.stage !== 'global') }, 'global needs a committed receipt'],
    ['prepared receipt', value => value.completed.receipts.push({ stage: 'global', state: 'prepared' }), 'no prepared receipt'],
    ['altered A draft', value => { value.completed.drafts = [...value.completed.drafts, { id: 5, status: 'draft' }] }, 'A existing drafts'],
    ['overwritten B facts', value => { value.afterB = { ...value.afterB, core: [{ core_outline: 'A reference overwrote B' }] } }, 'A must not change B'],
    ['B import pollution', value => { value.afterB = { ...value.afterB, runs: [{ id: 'foreign-A-run' }] } }, 'A must not change B'],
  ])('rejects %s rather than treating it as completion evidence', (_name, mutate, message) => {
    const value = completedFixture()
    mutate(value)
    expect(() => assertReferenceBackgroundCompletion(value)).toThrow(message)
  })
})

describe('reference scenario observation does not replace execution', () => {
  let fixture
  afterEach(async () => {
    if (fixture) await removeReferenceBackgroundObserver(fixture.app, fixture.page)
    fixture = undefined
    vi.unstubAllGlobals()
  })

  async function observedHandlers({ throwExecute = false, throwCancel = false, extraHandlers = [] } = {}) {
    let resolveExecution, listener, unsubscribed = 0
    const pending = new Promise(resolve => { resolveExecution = resolve })
    const channels = ['reference-run:v1:execute', 'reference-run:v1:projection-ack', 'project:open',
      'project-runtime:v1:open-view', 'project-runtime:v1:open-background-view',
      'reference-knowledge:v1:revoke', 'db:import-run-request-cancel']
    const originals = new Map(channels.map(channel => [channel, vi.fn(async () => {
      if (channel === 'reference-run:v1:execute') {
        if (throwExecute) throw new Error('FICTIONAL_EXECUTION_REJECTED')
        return pending
      }
      if (channel === 'db:import-run-request-cancel' && throwCancel) throw new Error('FICTIONAL_CANCEL_REJECTED')
      if (channel === 'reference-run:v1:projection-ack') return { version: 1 }
      return { success: true, project: { path: '/fictional/B', id: 'fictional-B', sessionLease: 'fictional-b-view' } }
    })]))
    for (const [channel, handler] of extraHandlers) originals.set(channel, handler)
    const handlers = new Map(originals)
    const app = { evaluate: async callback => callback({ ipcMain: { _invokeHandlers: handlers } }) }
    const page = { evaluate: async callback => callback() }
    vi.stubGlobal('window', { aiNovelAPI: { on: (channel, callback) => {
      expect(channel).toBe('reference-run:v1:progress')
      listener = callback
      return () => { unsubscribed++ }
    } } })
    fixture = { app, page, handlers, originals, release: resolveExecution,
      emit: event => listener(event), unsubscribed: () => unsubscribed }
    await installReferenceBackgroundObserver(app, page)
    return fixture
  }

  it('captures pending project DB and FS calls at view open without recording payloads or changing execution', async () => {
    let releaseFs, releaseDb
    const fsResult = { privateText: 'fictional-private-file-body' }, dbResult = [{ body: 'fictional-private-draft-body' }]
    const fsRead = vi.fn(() => new Promise(resolve => { releaseFs = resolve }))
    const dbRead = vi.fn(() => new Promise(resolve => { releaseDb = resolve }))
    const f = await observedHandlers({ extraHandlers: [['fs:read-json', fsRead], ['db:draft-list', dbRead]] })
    const event = { sender: { id: 31 } }, sessionA = completedFixture().observed.calls[0].session
    const sessionB = { projectId: 'fictional-B', projectPath: '/fictional/B', leaseId: 'fictional-b-lease' }
    const privateRequest = { path: 'private.json', body: 'fictional-private-request', token: 'fictional-secret-token' }
    const fsFlight = f.handlers.get('fs:read-json')(event, privateRequest, sessionB)
    const dbFlight = f.handlers.get('db:draft-list')(event, 7, '/fictional/A', sessionA)
    expect(fsRead).toHaveBeenCalledExactlyOnceWith(event, privateRequest, sessionB)
    expect(dbRead).toHaveBeenCalledExactlyOnceWith(event, 7, '/fictional/A', sessionA)
    const expected = [
      expect.objectContaining({ channel: 'fs:read-json', classification: 'fs-view-adapter', session: sessionB, senderId: 31 }),
      expect.objectContaining({ channel: 'db:draft-list', classification: 'db-view-adapter', session: sessionA, senderId: 31 }),
    ]
    expect(globalThis.__referenceBackground.state.pendingIpc).toEqual(expected)
    await f.handlers.get('project-runtime:v1:open-background-view')(event, { path: '/fictional/A' }, 'fictional-open', sessionB)
    const [attempt] = globalThis.__referenceBackground.state.viewAttempts
    expect(attempt).toMatchObject({ channel: 'project-runtime:v1:open-background-view', session: sessionB,
      pendingAtStart: expected, pendingAtEnd: expected, outcome: 'returned', success: true })
    releaseFs(fsResult)
    expect(await fsFlight).toBe(fsResult)
    expect(attempt.pendingAtStart).toHaveLength(2)
    releaseDb(dbResult)
    expect(await dbFlight).toBe(dbResult)
    expect(globalThis.__referenceBackground.state.pendingIpc).toEqual([])
    const trace = globalThis.__referenceBackground.state.ipcTrace
    expect(trace.map(item => [item.channel, item.phase])).toEqual([
      ['fs:read-json', 'start'], ['db:draft-list', 'start'], ['fs:read-json', 'end'], ['db:draft-list', 'end'],
    ])
    expect(trace[2]).toMatchObject({ id: trace[0].id, outcome: 'returned' })
    expect(trace[3]).toMatchObject({ id: trace[1].id, outcome: 'returned' })
    expect(JSON.stringify(globalThis.__referenceBackground.state)).not.toMatch(/fictional-private|fictional-secret/)
    await removeReferenceBackgroundObserver(f.app, f.page)
    expect(f.handlers.get('fs:read-json')).toBe(fsRead)
    expect(f.handlers.get('db:draft-list')).toBe(dbRead)
  })

  it.each(['db:recovery-candidate-list', 'db:revision-list', 'db:review-list', 'db:revision-get-pending',
    'db:review-get-full', 'db:revision-get-full', 'db:review-cycle-get'])(
    'classifies %s as a view read and preserves only the fixed view drain timeout code', async channel => {
    let releaseRead
    const result = [{ body: 'fictional-private-recovery-body' }]
    const read = vi.fn(() => new Promise(resolve => { releaseRead = resolve }))
    const failure = new Error('PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT')
    const open = vi.fn(async () => { throw failure })
    const f = await observedHandlers({ extraHandlers: [[channel, read],
      ['project-runtime:v1:open-background-view', open]] })
    const event = { sender: { id: 33 } }, session = completedFixture().observed.calls[0].session
    const flight = f.handlers.get(channel)(event, session)
    try {
      expect(globalThis.__referenceBackground.state.pendingIpc).toEqual([expect.objectContaining({
        channel, classification: 'db-view-adapter', session,
      })])
      await expect(f.handlers.get('project-runtime:v1:open-background-view')(event, {}, 'fictional-open', session)).rejects.toBe(failure)
      expect(globalThis.__referenceBackground.state.viewAttempts).toEqual([expect.objectContaining({
        outcome: 'threw', errorCode: 'PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT',
      })])
    } finally { releaseRead(result); await flight }
    expect(await flight).toBe(result)
    expect(read).toHaveBeenCalledExactlyOnceWith(event, session)
    expect(open).toHaveBeenCalledExactlyOnceWith(event, {}, 'fictional-open', session)
    expect(globalThis.__referenceBackground.state.pendingIpc).toEqual([])
    expect(JSON.stringify(globalThis.__referenceBackground.state)).not.toContain('fictional-private-recovery-body')
  })

  it('records finally cleanup and safe error codes while preserving original DB, recovery and view failures', async () => {
    const dbFailure = new Error('PROJECT_SESSION_STALE'), recoveryFailure = new Error('PROJECT_RUNTIME_BUSY')
    const viewFailure = new Error('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
    const dbRead = vi.fn(async () => { throw dbFailure })
    const recoveryRead = vi.fn(async () => { throw recoveryFailure })
    const viewOpen = vi.fn(async () => { throw viewFailure })
    const unrelated = vi.fn(async () => 'untouched')
    const f = await observedHandlers({ extraHandlers: [['db:review-list', dbRead],
      ['generation:list-recovery', recoveryRead], ['project-runtime:v1:open-background-view', viewOpen], ['unrelated:read', unrelated]] })
    const event = { sender: { id: 32 } }, session = completedFixture().observed.calls[0].session
    await expect(f.handlers.get('db:review-list')(event, session)).rejects.toBe(dbFailure)
    await expect(f.handlers.get('generation:list-recovery')(event, session)).rejects.toBe(recoveryFailure)
    await expect(f.handlers.get('project-runtime:v1:open-background-view')(event, {}, 'fictional-open', session)).rejects.toBe(viewFailure)
    expect(globalThis.__referenceBackground.state.pendingIpc).toEqual([])
    expect(globalThis.__referenceBackground.state.ipcTrace).toEqual([
      expect.objectContaining({ channel: 'db:review-list', phase: 'start', classification: 'db-view-adapter' }),
      expect.objectContaining({ channel: 'db:review-list', phase: 'end', outcome: 'threw', errorCode: 'PROJECT_SESSION_STALE' }),
      expect.objectContaining({ channel: 'generation:list-recovery', phase: 'start', classification: 'generation-recovery' }),
      expect.objectContaining({ channel: 'generation:list-recovery', phase: 'end', outcome: 'threw', errorCode: 'PROJECT_RUNTIME_BUSY' }),
    ])
    expect(globalThis.__referenceBackground.state.viewAttempts).toEqual([expect.objectContaining({
      pendingAtStart: [], pendingAtEnd: [], outcome: 'threw', errorCode: 'PROJECT_RUNTIME_VIEW_OPERATION_BUSY', session,
    })])
    expect(f.handlers.get('unrelated:read')).toBe(unrelated)
    expect(dbRead).toHaveBeenCalledTimes(1)
    expect(recoveryRead).toHaveBeenCalledTimes(1)
    expect(viewOpen).toHaveBeenCalledTimes(1)
  })

  it('omits malformed sessions and arbitrary error text while preserving a returned view refusal', async () => {
    const failure = new Error('FICTIONAL_PRIVATE_CREDENTIAL_TEXT')
    const refusal = { success: false, error: 'Error: PROJECT_RUNTIME_VIEW_OPERATION_BUSY', body: 'fictional-private-view-body' }
    const read = vi.fn(async () => { throw failure }), open = vi.fn(async () => refusal)
    const f = await observedHandlers({ extraHandlers: [['fs:read-file', read], ['project-runtime:v1:open-background-view', open]] })
    const malformed = { projectId: 'fictional-A', leaseId: 9, projectPath: '/fictional/A', token: 'fictional-private-token' }
    await expect(f.handlers.get('fs:read-file')({}, 'fictional-private-path', malformed)).rejects.toBe(failure)
    expect(await f.handlers.get('project-runtime:v1:open-background-view')({}, {}, 'fictional-open', malformed)).toBe(refusal)
    const state = globalThis.__referenceBackground.state
    expect(state.ipcTrace.every(item => item.session === null)).toBe(true)
    expect(state.ipcTrace.at(-1)).toMatchObject({ outcome: 'threw', errorCode: null })
    expect(state.viewAttempts).toEqual([expect.objectContaining({ session: null, success: false, outcome: 'returned',
      errorCode: 'PROJECT_RUNTIME_VIEW_OPERATION_BUSY', pendingAtStart: [], pendingAtEnd: [] })])
    expect(JSON.stringify(state)).not.toMatch(/PRIVATE_CREDENTIAL|fictional-private/)
  })

  it('passes the original sender, request and session through once, observes real settlement and restores handlers', async () => {
    const f = await observedHandlers()
    const { observed } = completedFixture(), issued = observed.calls[0]
    const event = { sender: { id: 'fictional-real-sender-object' } }
    const request = { reference: issued.reference, execution: issued.execution, modelId: 'fictional-model' }
    const execution = f.handlers.get('reference-run:v1:execute')(event, request, issued.session)
    expect(globalThis.__referenceBackground.state.settled).toBe(false)
    expect(f.originals.get('reference-run:v1:execute')).toHaveBeenCalledExactlyOnceWith(event, request, issued.session)
    const progress = { ...request, leaseId: issued.session.leaseId, sequence: 1, kind: 'stage-completed',
      token: 'fictional-sensitive-token-not-for-diagnostics', completion: { stage: 'knowledge', result: { fictional: true } } }
    f.emit(progress)
    expect(globalThis.__referenceBackgroundView.progress[0]).toMatchObject({ stage: 'knowledge', sequence: 1 })
    expect(JSON.stringify(globalThis.__referenceBackgroundView.progress)).not.toContain(progress.token)
    const ack = { ...request, stage: 'knowledge', decision: 'settled', token: progress.token }
    expect(await f.handlers.get('reference-run:v1:projection-ack')(event, ack, issued.session)).toEqual({ version: 1 })
    expect(f.originals.get('reference-run:v1:projection-ack')).toHaveBeenCalledExactlyOnceWith(event, ack, issued.session)
    f.release({ success: true, fictionalReceipt: 'original' })
    expect(await execution).toEqual({ success: true, fictionalReceipt: 'original' })
    expect(globalThis.__referenceBackground.state).toMatchObject({ settled: true, success: true })
    const replacement = () => { throw new Error('UNRELATED_HANDLER') }
    f.handlers.set('project:open', replacement)
    await removeReferenceBackgroundObserver(f.app, f.page)
    expect(f.handlers.get('project:open')).toBe(replacement)
    expect(f.handlers.get('reference-run:v1:execute')).toBe(f.originals.get('reference-run:v1:execute'))
    expect(f.unsubscribed()).toBe(1)
    expect(globalThis.__referenceBackground).toBeUndefined()
    expect(globalThis.__referenceBackgroundView).toBeUndefined()
  })

  it.each(['project:open', 'project-runtime:v1:open-view', 'project-runtime:v1:open-background-view'])(
    'observes the actual view result without changing the %s request', async channel => {
      const f = await observedHandlers()
      const event = { sender: { id: 'fictional-original-sender' } }
      const request = { path: '/fictional/B', grantId: 'fictional-original-grant' }
      const operationId = 'fictional-original-operation'
      const result = await f.handlers.get(channel)(event, request, operationId, null)
      expect(f.originals.get(channel)).toHaveBeenCalledExactlyOnceWith(event, request, operationId, null)
      expect(globalThis.__referenceBackground.state.views).toEqual([{ channel, success: true,
        projectPath: result.project.path, projectId: result.project.id, leaseId: result.project.sessionLease }])
      await removeReferenceBackgroundObserver(f.app, f.page)
      expect(f.handlers.get(channel)).toBe(f.originals.get(channel))
    })

  it('does not fabricate success when the actual wrapped execution rejects', async () => {
    const f = await observedHandlers({ throwExecute: true })
    const issued = completedFixture().observed.calls[0]
    await expect(f.handlers.get('reference-run:v1:execute')({}, issued, issued.session)).rejects.toThrow('FICTIONAL_EXECUTION_REJECTED')
    expect(globalThis.__referenceBackground.state).toMatchObject({ settled: true, success: false })
  })

  it('records a cancellation attempt even when the original handler rejects it', async () => {
    const f = await observedHandlers({ throwCancel: true })
    await expect(f.handlers.get('db:import-run-request-cancel')({}, 'fictional-run')).rejects.toThrow('FICTIONAL_CANCEL_REJECTED')
    expect(globalThis.__referenceBackground.state.cancellations).toEqual([{ channel: 'db:import-run-request-cancel' }])
  })
})
