import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import * as stage from './pages/stage.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

export const REFERENCE_BACKGROUND_SCENARIO = 'f537-reference-background-10'
export const BACKGROUND_BOOK = 'Ref B'
export const BACKGROUND_EDIT = 'B author buffer remains independent while A imports its reference.'
const STAGES = ['knowledge', 'global', 'style', 'blueprints', 'refresh']
const draftSnapshot = db => db.prepare(`SELECT d.*, c.body AS content_body FROM drafts_all d
  JOIN contents c ON c.id=d.content_id ORDER BY d.id`).all()

export async function openReferenceBackgroundBook(page, currentName, nextName) {
  // Cross-book palette entries exist in the library, not inside the current work.
  await stage.backToLibrary(page, currentName)
  await stage.cover(page, nextName).waitFor({ state: 'visible' })
  await stage.openFromPalette(page, nextName)
}

function within(parent, target) {
  assert.ok(path.isAbsolute(parent) && path.isAbsolute(target), 'fixture paths must be absolute')
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(target))
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'fixture path must stay inside the drive scratch directory')
}

export function referenceBookSnapshot(db) {
  return {
    core: db.prepare('SELECT * FROM project_core ORDER BY id').all(),
    blueprints: db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all(),
    drafts: draftSnapshot(db),
    runs: db.prepare('SELECT * FROM import_runs ORDER BY id').all(),
    grants: db.prepare('SELECT * FROM reference_import_grants ORDER BY grant_id').all(),
    receipts: db.prepare('SELECT * FROM import_run_receipts ORDER BY run_id,stage,batch_id').all(),
    knowledge: db.prepare('SELECT * FROM import_run_knowledge_receipts ORDER BY run_id,chapter_number').all(),
    embeddingDispatches: db.prepare('SELECT * FROM reference_embedding_dispatches ORDER BY dispatch_id').all(),
    embeddingBudgets: db.prepare('SELECT * FROM reference_embedding_budgets ORDER BY root_run_id').all(),
  }
}

export function referenceEmbeddingSnapshot(db, runId) {
  return db.prepare(`SELECT d.dispatch_id,d.import_run_id,d.state,d.http_status,d.settled_at
    FROM reference_embedding_dispatches d JOIN import_runs r ON r.id=d.import_run_id
    WHERE r.root_run_id=(SELECT root_run_id FROM import_runs WHERE id=?) ORDER BY d.dispatch_id`).all(runId)
}

export function referenceModelSnapshot(db, runId) {
  return db.prepare(`SELECT a.attempt_id,a.run_id,json_extract(r.binding_json,'$.projectId') AS project_id,
    json_extract(r.binding_json,'$.epoch') AS epoch,
    json_extract(r.binding_json,'$.sourceManifest.importSlot.runId') AS import_run_id,
    json_extract(r.binding_json,'$.sourceManifest.operation') AS operation,
    json_extract(a.usage_receipt_json,'$.purpose') AS purpose,
    json_extract(a.attempt_json,'$.status') AS status,
    json_extract(a.usage_receipt_json,'$.result.finishReason') AS finish_reason,
    json_extract(a.usage_receipt_json,'$.result.failureCode') AS failure_code
    FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id
    WHERE json_extract(r.binding_json,'$.sourceManifest.importSlot.runId')=? ORDER BY a.rowid`).all(runId)
}

export function referenceCompletionSnapshot(db, runId) {
  return {
    run: db.prepare('SELECT id,purpose,stage,status FROM import_runs WHERE id=?').get(runId),
    grants: db.prepare('SELECT grant_id,revision,state FROM reference_import_grants WHERE import_run_id=? ORDER BY grant_id').all(runId),
    knowledge: db.prepare("SELECT COUNT(*) FROM import_run_knowledge_receipts WHERE run_id=? AND state='committed'").pluck().get(runId),
    receipts: db.prepare('SELECT stage,batch_id,state FROM import_run_receipts WHERE run_id=? ORDER BY stage,batch_id').all(runId),
    blueprints: db.prepare('SELECT chapter_number FROM blueprints WHERE chapter_number BETWEEN 1 AND 10 ORDER BY chapter_number').pluck().all(),
    drafts: draftSnapshot(db),
    embeddingDispatches: referenceEmbeddingSnapshot(db, runId),
    modelDispatches: referenceModelSnapshot(db, runId),
  }
}

function assertIdentity(actual, issued) {
  assert.deepEqual(actual.reference, issued.reference, 'projection retained the original project/run/grant/revision')
  assert.deepEqual(actual.execution, issued.execution, 'projection retained the original owner/epoch')
}

function assertReferenceBackgroundBaseline(beforeSwitch, issued) {
  assert.deepEqual(beforeSwitch.calls, [issued], 'baseline must retain the single original invocation')
  assert.equal(beforeSwitch.settled, false, 'baseline whole run must remain in flight')
  assert.deepEqual(beforeSwitch.cancellations, [], 'baseline cannot cancel A')
  assert.deepEqual(beforeSwitch.view, { activeProjectPath: issued.session.projectPath, dbReady: true },
    'baseline must capture the actual A view')
  assert.ok(beforeSwitch.acks.length < STAGES.length, 'baseline must leave a remaining stage for return to A')
  const prefix = STAGES.slice(0, beforeSwitch.acks.length)
  assert.deepEqual(beforeSwitch.acks.map(({ stage, decision }) => ({ stage, decision })),
    prefix.map(stage => ({ stage, decision: 'settled' })), 'baseline ACKs must be an ordered settled prefix')
  for (const ack of beforeSwitch.acks) {
    assertIdentity(ack, issued)
    assert.deepEqual(ack.session, issued.session, 'baseline ACK must use the original A view lease')
  }
  for (const event of beforeSwitch.progress) {
    assertIdentity(event, issued)
    assert.equal(event.leaseId, issued.session.leaseId, 'execution events keep the original execution lease')
  }
  assert.deepEqual(beforeSwitch.progress.filter(event => event.kind === 'stage-completed').map(event => event.stage),
    prefix, 'baseline completed stages must match its settled ACK prefix')
  assert.equal(beforeSwitch.progress.at(-1)?.stage, STAGES[prefix.length], 'baseline must capture the current unfinished stage')
}

function assertHeldReferenceModel(heldModelDispatches, issued) {
  assert.ok(heldModelDispatches.length === 1 && heldModelDispatches.every(dispatch =>
    dispatch.project_id === issued.session.projectId && dispatch.epoch === issued.session.leaseId
    && dispatch.import_run_id === issued.reference.runId && dispatch.operation === 'import-global-facts'
    && dispatch.purpose === 'import-inference'
    && dispatch.status === 'dispatch-marked' && dispatch.finish_reason === null && dispatch.failure_code === null),
  'held HTTP must have the original A model dispatch without a response settlement')
}

function assertWaitingForReferenceView(inB, beforeSwitch) {
  assert.equal(inB.settled, false, 'whole run must wait for the A projection view')
  assert.deepEqual(inB.acks, beforeSwitch.acks, 'B must not add or change whole projection ACKs')
  assert.ok(inB.view.dbReady && inB.view.activeProjectPath
    && inB.view.activeProjectPath !== beforeSwitch.view.activeProjectPath, 'the detached observation must be in B')
}

export function assertReferenceBackgroundCompletion({ observed, progress, completed, beforeDrafts,
  beforeB, afterB, returnLease, heldModelDispatches, beforeSwitch, inB }) {
  assert.equal(observed.calls.length, 1, 'view reattachment must not execute the whole run again')
  const [issued] = observed.calls
  assert.ok(issued.reference.runId && issued.reference.grantId && issued.reference.revision > 0)
  assert.ok(issued.session.leaseId && returnLease && returnLease !== issued.session.leaseId, 'return to A must issue a new view lease')
  assertReferenceBackgroundBaseline(beforeSwitch, issued)
  assertWaitingForReferenceView(inB, beforeSwitch)
  assert.equal(observed.settled, true, 'the real whole-run invocation must settle')
  assert.equal(observed.success, true, 'the real whole-run invocation must succeed')
  assert.equal(observed.cancellations.length, 0, 'switching views must not cancel or revoke A')
  assert.deepEqual(observed.acks.map(({ stage, decision }) => ({ stage, decision })),
    STAGES.map(stage => ({ stage, decision: 'settled' })), 'all five real projection ACKs are required')
  assert.deepEqual(observed.acks.slice(0, beforeSwitch.acks.length), beforeSwitch.acks, 'settled ACK prefix must remain unchanged')
  for (const ack of observed.acks.slice(beforeSwitch.acks.length)) {
    assertIdentity(ack, issued)
    assert.equal(ack.session.projectId, issued.session.projectId, 'ACK cannot be rebound to B')
    assert.equal(ack.session.projectPath, issued.session.projectPath, 'ACK cannot use the B root')
    assert.equal(ack.session.leaseId, returnLease, 'remaining ACK must use the actual returned A view lease')
  }
  assert.ok(progress.length > 0, 'actual renderer progress events must be observed')
  for (const event of progress) {
    assertIdentity(event, issued)
    assert.equal(event.leaseId, issued.session.leaseId, 'execution events keep the original execution lease')
  }
  assert.deepEqual(progress.slice(0, beforeSwitch.progress.length), beforeSwitch.progress, 'the original progress prefix must remain unchanged')
  assert.ok(inB.progress.some(event => event.kind === 'stage-completed'
    && event.sequence > beforeSwitch.progress.at(-1).sequence), 'B must observe a newly completed stage after the baseline sequence')
  assert.deepEqual(progress.slice(0, inB.progress.length), inB.progress, 'B progress must retain the actual original execution events')
  assert.deepEqual(completed.run, { id: issued.reference.runId, purpose: 'reference', stage: 'completed', status: 'completed' })
  assert.deepEqual(completed.grants, [{ grant_id: issued.reference.grantId, revision: issued.reference.revision, state: 'completed' }])
  assert.equal(completed.knowledge, 10, 'all ten chapter knowledge receipts must commit')
  assertHeldReferenceModel(heldModelDispatches, issued)
  for (const held of heldModelDispatches) {
    assert.ok(completed.modelDispatches.some(dispatch => dispatch.attempt_id === held.attempt_id
      && dispatch.run_id === held.run_id && dispatch.project_id === held.project_id && dispatch.epoch === held.epoch
      && dispatch.import_run_id === held.import_run_id && dispatch.operation === held.operation && dispatch.purpose === held.purpose
      && dispatch.status === 'settled' && dispatch.finish_reason === 'stop' && dispatch.failure_code === null),
    'held model request requires its original successful durable settlement')
  }
  assert.ok(completed.embeddingDispatches.every(dispatch =>
    dispatch.state === 'response_received' && dispatch.http_status >= 200 && dispatch.http_status < 300
    && Number.isFinite(dispatch.settled_at)), 'original embedding requests require successful durable response settlement')
  for (const stage of ['global', 'style', 'blueprints']) {
    assert.ok(completed.receipts.some(receipt => receipt.stage === stage && receipt.state === 'committed'), `${stage} needs a committed receipt`)
  }
  assert.ok(completed.receipts.every(receipt => receipt.state === 'committed'), 'no prepared receipt may remain')
  assert.deepEqual(completed.blueprints, Array.from({ length: 10 }, (_, index) => index + 1))
  assert.equal(beforeDrafts.length, 4, 'the original reference fixture has four drafts/finalized records')
  assert.ok(beforeDrafts.some(draft => draft.status === 'finalized'))
  assert.ok(beforeDrafts.some(draft => draft.status !== 'finalized'))
  assert.deepEqual(completed.drafts, beforeDrafts, 'A existing drafts and finalized content must not change')
  assert.deepEqual(afterB, beforeB, 'A must not change B author facts, drafts, plans or import receipts')
}

async function until(read, accepted, message, timeout = 90_000) {
  for (const deadline = Date.now() + timeout; ; await new Promise(resolve => setTimeout(resolve, 100))) {
    const value = await read()
    if (accepted(value)) return value
    assert.ok(Date.now() < deadline, message)
  }
}

export async function installReferenceBackgroundObserver(app, page) {
  assert.ok(await app.evaluate(({ ipcMain }) => {
    if (globalThis.__referenceBackground) return false
    const handlers = ipcMain._invokeHandlers
    const channels = ['reference-run:v1:execute', 'reference-run:v1:projection-ack',
      'project:open', 'project-runtime:v1:open-view', 'project-runtime:v1:open-background-view',
      'reference-knowledge:v1:revoke', 'db:import-run-request-cancel']
    if (!channels.every(channel => handlers.has(channel))) return false
    const viewChannels = new Set(['project:open', 'project-runtime:v1:open-view', 'project-runtime:v1:open-background-view'])
    // This mirrors the DB adapter classification, not a measurement of acquired host claims.
    const viewDatabaseReads = new Set(['db:import-run-get', 'db:import-run-effect-receipt-get',
      'db:blueprint-get-all', 'db:blueprint-get', 'db:blueprint-character-sync-list-pending', 'db:blueprint-character-sync-get',
      'db:character-get-all', 'db:character-roster-read', 'db:draft-list', 'db:draft-list-all',
      'db:draft-get-meta', 'db:draft-get-full', 'db:draft-get-latest', 'db:draft-get-finalized', 'db:recovery-candidate-list',
      'db:revision-list', 'db:review-list', 'db:revision-get-pending',
      'db:review-get-full', 'db:revision-get-full', 'db:review-cycle-get'])
    const observedChannels = [...handlers.keys()].filter(channel => channel.startsWith('db:') || channel.startsWith('fs:')
      || channel === 'generation:list-recovery')
    const classification = channel => channel.startsWith('fs:') ? 'fs-view-adapter'
      : channel === 'generation:list-recovery' ? 'generation-recovery' : viewDatabaseReads.has(channel) ? 'db-view-adapter' : 'db-other'
    const safeErrors = new Set(['PROJECT_RUNTIME_VIEW_OPERATION_BUSY', 'PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT', 'PROJECT_RUNTIME_BUSY',
      'PROJECT_RUNTIME_VIEW_COMMIT_BUSY', 'PROJECT_RUNTIME_LEGACY_OPERATION_BUSY', 'PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE',
      'PROJECT_RUNTIME_COMPATIBILITY_OPEN_BUSY', 'PROJECT_RUNTIME_RESTORE_BUSY', 'PROJECT_RUNTIME_HOST_CLOSING',
      'PROJECT_RUNTIME_CLOSE_REQUESTED', 'PROJECT_RUNTIME_NOT_OPEN', 'PROJECT_RUNTIME_DATABASE_CHANGED',
      'PROJECT_SESSION_REQUIRED', 'PROJECT_SESSION_STALE', 'PROJECT_SESSION_ROOT_MISMATCH', 'PROJECT_SESSION_DATABASE_MISMATCH',
      'GENERATION_OWNER_BUSY', 'GENERATION_REQUEST_FAILED', 'GENERATION_PROJECT_SESSION_STALE'])
    const safeCode = value => {
      if (typeof value !== 'string') return null
      const code = value.startsWith('Error: ') ? value.slice(7) : value
      return safeErrors.has(code) ? code : null
    }
    const projectSession = candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && ['projectId', 'leaseId', 'projectPath'].every(key => typeof candidate[key] === 'string' && candidate[key])
      ? { projectId: candidate.projectId, leaseId: candidate.leaseId, projectPath: candidate.projectPath } : null
    const state = { calls: [], acks: [], views: [], cancellations: [], settled: false, success: false,
      ipcTrace: [], pendingIpc: [], viewAttempts: [] }
    let sequence = 0
    const pending = new Map()
    const snapshot = () => [...pending.values()].map(entry => ({ ...entry, session: entry.session ? { ...entry.session } : null }))
    const originals = new Map(), wrappers = new Map()
    for (const channel of new Set([...channels, ...observedChannels])) {
      const original = handlers.get(channel)
      const wrapped = async (event, ...args) => {
        const [request, ...rest] = args
        const session = projectSession(args.at(-1))
        const senderId = typeof event?.sender?.id === 'number' ? event.sender.id : null
        let trace, view, outcome = 'threw', errorCode = null
        if (observedChannels.includes(channel)) {
          trace = { id: ++sequence, channel, classification: classification(channel), session, senderId, startedAt: Date.now() }
          pending.set(trace.id, trace)
          state.pendingIpc = snapshot()
          state.ipcTrace.push({ ...trace, phase: 'start' })
        }
        if (viewChannels.has(channel)) {
          view = { id: ++sequence, channel, session, senderId, startedAt: Date.now(),
            pendingAtStart: snapshot(), outcome: 'pending' }
          state.viewAttempts.push(view)
        }
        try {
          if (channel === 'reference-run:v1:execute') {
            state.calls.push({ reference: { ...request.reference }, execution: { ...request.execution }, session: { ...rest[0] } })
          }
          if (channel === 'reference-knowledge:v1:revoke' || channel === 'db:import-run-request-cancel') {
            state.cancellations.push({ channel })
          }
          const result = await original(event, ...args)
          outcome = 'returned'
          errorCode = safeCode(result?.errorCode) ?? safeCode(result?.error)
          if (channel === 'reference-run:v1:execute') {
            state.success = result?.success === true
            state.errorCode = safeCode(result?.errorCode)
          }
          if (channel === 'reference-run:v1:projection-ack') state.acks.push({ stage: request.stage, decision: request.decision,
            reference: { ...request.reference }, execution: { ...request.execution }, session: { ...rest[0] } })
          else if (view) {
            view.success = result?.success === true
            state.views.push({ channel, projectPath: result?.project?.path, projectId: result?.project?.id,
              leaseId: result?.project?.sessionLease, success: result?.success })
          }
          return result
        } catch (error) {
          errorCode = safeCode(error?.message)
          throw error
        } finally {
          if (channel === 'reference-run:v1:execute') state.settled = true
          if (trace) {
            pending.delete(trace.id)
            state.pendingIpc = snapshot()
            state.ipcTrace.push({ ...trace, phase: 'end', outcome, errorCode, endedAt: Date.now() })
          }
          if (view) Object.assign(view, { outcome, errorCode, endedAt: Date.now(), pendingAtEnd: snapshot() })
        }
      }
      originals.set(channel, original); wrappers.set(channel, wrapped); handlers.set(channel, wrapped)
    }
    globalThis.__referenceBackground = { state, originals, wrappers }
    return true
  }), 'existing whole-run, view and cancellation handlers must be observable')
  await page.evaluate(() => {
    const state = { progress: [] }
    state.unsubscribe = window.aiNovelAPI.on('reference-run:v1:progress', event => {
      state.progress.push({ reference: { ...event.reference }, execution: { ...event.execution }, leaseId: event.leaseId,
        sequence: event.sequence, kind: event.kind, stage: event.stage ?? event.completion?.stage })
    })
    globalThis.__referenceBackgroundView = state
  })
}

export async function removeReferenceBackgroundObserver(app, page) {
  const failures = []
  try {
    await page.evaluate(() => {
      globalThis.__referenceBackgroundView?.unsubscribe()
      delete globalThis.__referenceBackgroundView
    })
  } catch (error) { failures.push(error) }
  try {
    await app.evaluate(({ ipcMain }) => {
      const fixture = globalThis.__referenceBackground
      if (!fixture) return
      for (const [channel, wrapped] of fixture.wrappers) {
        if (ipcMain._invokeHandlers.get(channel) === wrapped) ipcMain._invokeHandlers.set(channel, fixture.originals.get(channel))
      }
      delete globalThis.__referenceBackground
    })
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'REFERENCE_BACKGROUND_OBSERVER_CLEANUP_FAILED')
}

export function referenceBackgroundScenario({ seedStageSample, startImport, referenceNovel, readDb }) {
  return {
    model: true,
    shell: 'stage',
    setup: async context => {
      const { app, page, roots, invoke } = context
      within(roots.root, roots.projects)
      const created = await invoke(page, 'project:create', {
        parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
        name: BACKGROUND_BOOK, genre: '', targetAudience: '', writingLanguage: 'zh-CN',
      }, randomUUID(), null)
      assert.equal(created?.success, true, created?.error)
      within(roots.projects, created.projectPath)
      context.referenceBackgroundBook = created
      await seedStageSample(context)
      within(roots.projects, context.samplePath)
      await stage.backToLibrary(page, STAGE_SAMPLE.name)
      await stage.cover(page, BACKGROUND_BOOK).waitFor({ state: 'visible' })
      await stage.bookMenu(page, STAGE_SAMPLE.name, '回到作品')
      await stage.spine(page).waitFor({ state: 'visible' })
    },
    run: async context => {
      const { app, page, roots, fake, invoke } = context
      assert.ok(fake?.gate, 'only the isolated drive loopback fake provider is permitted')
      within(roots.root, roots.temp)
      within(roots.projects, context.samplePath)
      within(roots.projects, context.referenceBackgroundBook.projectPath)
      assert.notEqual(context.samplePath, context.referenceBackgroundBook.projectPath)
      const readB = read => readDb({ ...context, samplePath: context.referenceBackgroundBook.projectPath }, read)
      const beforeDrafts = readDb(context, draftSnapshot)
      const initialB = readB(referenceBookSnapshot)
      const mainState = () => app.evaluate(() => globalThis.__referenceBackground.state)
      const viewProgress = () => page.evaluate(() => globalThis.__referenceBackgroundView.progress)
      const currentView = () => invoke(page, 'project:get-runtime-context')
      let detached, result, failure, failed = false
      const requestsBefore = fake.requests.length
      fake.replyImport()
      try {
        await installReferenceBackgroundObserver(app, page)
        fake.gate.hold()
        await startImport(app, page, referenceNovel(roots, 10), 10)
        await until(() => fake.gate.waiting, waiting => waiting > 0, 'no real loopback request arrived at the held HTTP response')
        const held = await mainState()
        assert.equal(held.calls.length, 1, 'one author-entry whole run must be in flight')
        assert.equal(held.settled, false, 'HTTP response must be held before switching')
        const beforeSwitch = { ...held, view: await currentView(), progress: await viewProgress() }
        assertReferenceBackgroundBaseline(beforeSwitch, held.calls[0])
        const heldModelDispatches = readDb(context, db => referenceModelSnapshot(db, held.calls[0].reference.runId))
        assertHeldReferenceModel(heldModelDispatches, held.calls[0])
        const baselineSequence = beforeSwitch.progress.at(-1).sequence
        const heldHttpRequests = fake.gate.waiting
        await openReferenceBackgroundBook(page, STAGE_SAMPLE.name, BACKGROUND_BOOK)
        await stage.root(page).getByRole('button', { name: `《${BACKGROUND_BOOK}》作品菜单` }).waitFor({ state: 'visible' })
        assert.ok(fake.gate.waiting > 0, 'A request must remain in flight when B opens')
        assert.deepEqual(readB(referenceBookSnapshot), initialB, 'opening B must not project A data into its database')
        if (await runSheet.sheet(page).isVisible()) await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).click()
        await stage.stageButton(page, '设定').click()
        await stage.setupOutline(page).fill(BACKGROUND_EDIT)
        await stage.saveStatus(page).filter({ hasText: '未保存' }).waitFor({ state: 'visible' })
        await stage.setupFoot(page).getByRole('button', { name: /^保存/ }).click()
        await stage.saveStatus(page).filter({ hasText: /^已保存$/ }).waitFor({ state: 'visible' })
        assert.equal(await stage.setupOutline(page).inputValue(), BACKGROUND_EDIT)
        const beforeB = readB(referenceBookSnapshot)
        assert.equal(beforeB.core[0].core_outline, BACKGROUND_EDIT, 'B edit must reach its real project repository')
        const heldInB = { ...await mainState(), view: await currentView() }
        assertWaitingForReferenceView(heldInB, beforeSwitch)
        assert.deepEqual(readDb(context, db => referenceModelSnapshot(db, held.calls[0].reference.runId)), heldModelDispatches,
          'the original A model request must remain physically held while editing B')
        assert.equal(heldInB.cancellations.length, 0, 'opening and editing B cannot cancel A')
        await runSheet.openFromPalette(page)
        const background = runSheet.sheet(page).locator('.run-background-card').filter({ hasText: STAGE_SAMPLE.name })
        await background.waitFor({ state: 'visible' })
        assert.equal(await background.getAttribute('data-state'), 'running', 'RunSheet must attribute the active background task to A')
        await context.shoot('f537-reference-background-10-held-in-b')
        fake.gate.release()
        const progressInB = await until(viewProgress, events => events.some(event => event.kind === 'stage-completed'
          && event.sequence > baselineSequence),
          'A must emit a real completed stage after its HTTP response is released')
        const inB = { ...await mainState(), view: await currentView(), progress: progressInB }
        assertWaitingForReferenceView(inB, beforeSwitch)
        const committedInB = readDb(context, db => referenceCompletionSnapshot(db, held.calls[0].reference.runId))
        assert.equal(inB.cancellations.length, 0)
        assert.deepEqual(readB(referenceBookSnapshot), beforeB, 'A released response cannot overwrite saved B contents')
        assert.equal(await stage.setupOutline(page).inputValue(), BACKGROUND_EDIT, 'A progress cannot overwrite the B editor buffer')
        detached = { settled: inB.settled, success: inB.success, stageAcks: inB.acks.map(ack => ack.stage),
          baselineStageAcks: beforeSwitch.acks.map(ack => ack.stage), baselineSequence,
          completedStages: progressInB.filter(event => event.kind === 'stage-completed').map(event => event.stage),
          run: committedInB.run, knowledgeReceipts: committedInB.knowledge,
          disposition: 'stage-completed-without-whole-run-settlement' }
        await context.shoot('f537-reference-background-10-released-in-b')
        await openReferenceBackgroundBook(page, BACKGROUND_BOOK, STAGE_SAMPLE.name)
        await stage.root(page).getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).waitFor({ state: 'visible' })
        const observed = await until(mainState, state => state.settled, 'whole reference run did not settle after returning to A', 5 * 60_000)
        const returned = observed.views.filter(view => view.success && view.projectPath === context.samplePath).at(-1)
        const progress = await viewProgress()
        const completed = readDb(context, db => referenceCompletionSnapshot(db, observed.calls[0].reference.runId))
        assertReferenceBackgroundCompletion({ observed, progress, completed, beforeDrafts, beforeB,
          afterB: readB(referenceBookSnapshot), returnLease: returned?.leaseId, heldModelDispatches, beforeSwitch, inB })
        await runSheet.openFromPalette(page)
        await runSheet.waitUntilOpen(page)
        await runSheet.waitForRunDone(page, 90_000)
        result = { scenario: REFERENCE_BACKGROUND_SCENARIO, source: 'isolated-author-ui-real-main-reference-run',
          wholeCalls: observed.calls.length, stageAcks: observed.acks.map(ack => ack.stage), detached,
          viewLeaseRotated: true, unchangedDrafts: beforeDrafts.length, bAuthorEditSavedAndPreserved: true,
          knowledgeReceipts: completed.knowledge, committedReceipts: completed.receipts.length,
          heldHttpRequests, heldModelAttemptIds: heldModelDispatches.map(dispatch => dispatch.attempt_id),
          settledEmbeddingDispatches: completed.embeddingDispatches.length,
          fakeProviderRequests: fake.requests.length - requestsBefore }
      } catch (error) {
        failure = error
        failed = true
        try {
          context.diagnostics?.push(`reference-background-observation:${JSON.stringify({ detached,
            observed: await mainState(), progress: await viewProgress(), fakeProviderRequests: fake.requests.length - requestsBefore })}`)
        } catch {
          context.diagnostics?.push('reference-background-observation:unavailable')
        }
      } finally {
        fake.gate.release()
        try { await removeReferenceBackgroundObserver(app, page) } catch (cleanup) {
          failure = failed ? new AggregateError([failure, cleanup], 'REFERENCE_BACKGROUND_SCENARIO_AND_CLEANUP_FAILED') : cleanup
          failed = true
        }
      }
      if (failed) throw failure
      return result
    },
  }
}
