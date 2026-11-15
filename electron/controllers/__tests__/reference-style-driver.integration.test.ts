import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import { createImportRunChapterBatchCheckpointId, type ImportRunExecutionAuthority, type ImportRunExecutionLease } from '../../../src/shared/import-run'
import { isReferenceStyleProgress, type ReferenceStyleProgress, type ReferenceStyleResponse } from '../../../src/shared/reference-style-contract'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => ({ modelId: 'fictional-embedding', protocol: 'openai',
  model: { provider: 'openai', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', modelName: 'fictional-embedding' } }) }))
import { assertImportGenerationSourcesCurrent, registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { closeProjectDatabase, createProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { MainGenerationScheduler } from '../../services/generation-scheduler'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'

const model: ModelProfile = { id: 'fictional-model', name: 'Fictional', provider: 'openai', protocol: 'openai',
  modelName: 'fictional-model', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', temperature: 0.7,
  maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048,
    reasoning: false, structuredOutput: true, usage: true } }
const otherModel: ModelProfile = { ...model, id: 'fictional-other', modelName: 'fictional-other' }
const loadModel = (id: string) => id === model.id ? model : id === otherModel.id ? otherModel : null
const scheduler = new MainGenerationScheduler({ global: 2, provider: 2, credential: 2, model: 2, project: 1,
  maxQueued: 16, maxQuarantined: 2, interactiveBurst: 1 }, 60)
let runId = 'fictional-reference-style'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

class Sender extends EventEmitter {
  readonly id = 71
  destroyed = false
  events: ReferenceStyleProgress[] = []
  isDestroyed() { return this.destroyed }
  send(channel: string, payload: unknown) {
    if (channel === 'import-generation:v1:style-progress') {
      if (!isReferenceStyleProgress(payload)) throw new Error('INVALID_STYLE_PROGRESS')
      this.events.push(payload)
    }
  }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
let sender: Sender, root: string, session: ProjectSessionContext, execution: ImportRunExecutionAuthority
let executionLease: ImportRunExecutionLease
let releaseFetch: (() => void) | undefined
let pending: Promise<unknown> | undefined

beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel }),
    loadModel, applyProxyConfig: () => {}, scheduler })
  registerDatabaseController()
})
beforeEach(() => {
  runId = 'fictional-reference-style'; sender = new Sender(); pending = undefined; releaseFetch = undefined
  const base = path.resolve('.runtime/rs65')
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, 'Fictional reference')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.prepare("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','Fictional reference',100)").run()
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: projectAccess.beginSession(project).leaseId }
  const chapters = Array.from({ length: 7 }, (_, index) => {
    const number = index + 1, content = `sample-${number}-` + String(number).repeat(2100) + `-end-${number}`
    return { number, title: `Fictional ${number}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }
  })
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash('fictional-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: 1 }], chapters })
  executionLease = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
  execution = { owner: executionLease.owner, epoch: executionLease.epoch }
  getProjectDb()!.prepare("UPDATE import_runs SET stage='style' WHERE id=?").run(runId)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK') }))
})

function removeFixture() {
  const base = path.resolve('.runtime/rs65'), target = path.resolve(root), relative = path.relative(base, target)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || normalize(fs.realpathSync.native(base)) !== normalize(base)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
  const directories = [target], files: string[] = []
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!, stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(fs.realpathSync.native(directory)) !== normalize(directory)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
    for (const entry of fs.readdirSync(directory)) {
      const child = path.join(directory, entry), childRelative = path.relative(target, child), childStat = fs.lstatSync(child)
      if (!childRelative || path.isAbsolute(childRelative) || childRelative === '..' || childRelative.startsWith(`..${path.sep}`)
        || childStat.isSymbolicLink() || normalize(fs.realpathSync.native(child)) !== normalize(child)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
      if (childStat.isDirectory()) directories.push(child)
      else if (childStat.isFile()) files.push(child)
      else throw new Error('FIXTURE_CLEANUP_UNSAFE')
    }
  }
  for (const file of files) fs.unlinkSync(file)
  for (const directory of directories.reverse()) fs.rmdirSync(directory)
}
afterEach(async () => {
  sender.destroy(); releaseFetch?.()
  if (pending) await pending.catch(() => undefined)
  const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId
    && normalize(item.canonicalRoot) === normalize(session.projectPath))
  if (runtime) await projectRuntimeHost.requestClose(runtime)
  const currentPath = getCurrentProjectPath()
  if (currentPath && normalize(currentPath) === normalize(session.projectPath)) closeProjectDatabase()
  const currentSession = projectAccess.captureCurrentSession()
  if (currentSession?.projectId === session.projectId && currentSession.leaseId === session.leaseId) projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  removeFixture()
})
function invoke<T>(channel: string, payload: unknown, context = session, eventSender = sender): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender: eventSender }, payload, { ...context }) as Promise<T>
}
function dbCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender }, ...args, session.projectPath, { ...session }) as Promise<T>
}
function seedFinalized(number: number, content: string) {
  const db = getProjectDb()!, id = number + 100
  db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(id, content)
  db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id) VALUES(?,?,1,'finalized',?)").run(id, number, id)
  db.prepare(`INSERT INTO finalization_outbox_all(finalization_id,draft_id,chapter_number,content_hash,content_revision,content_snapshot,target_file_name)
    VALUES(?,?,?,?,1,?,?)`).run(`final-${number}`, id, number, hash(content), content, `chapter-${number}.txt`)
}
function fallbackSamples() {
  const db = getProjectDb()!
  ImportRunRepository.requestCancel(runId, executionLease)
  ImportRunRepository.cancelAtBoundary(runId, executionLease)
  runId = 'fictional-reference-fallback'
  const content = ' \n '
  const chapters = Array.from({ length: 7 }, (_, index) => ({ number: index + 1, title: `Fictional ${index + 1}`,
    content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }))
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash('fictional-fallback-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional-fallback.txt', mediaType: 'text/plain', size: 1 }], chapters })
  executionLease = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
  execution = { owner: executionLease.owner, epoch: executionLease.epoch }
  db.prepare("UPDATE import_runs SET stage='style' WHERE id=?").run(runId)
  seedFinalized(5, 'outside-five-chapter-window')
  seedFinalized(6, 'final-six')
  seedFinalized(8, '')
  seedFinalized(10, `final-ten-${'x'.repeat(2100)}-too-late`)
}
function start(modelId: string | null = model.id) {
  const flight = invoke<ReferenceStyleResponse>('import-generation:v1:style', { runId, execution, modelId })
  pending = flight
  void flight.catch(() => undefined)
  return flight
}
async function event<K extends 'opened' | 'commit-ready'>(kind: K) {
  const waiting = vi.waitFor(() => expect(sender.events.some(item => item.kind === kind)).toBe(true), { timeout: 10_000 })
    .then(() => sender.events.find(item => item.kind === kind)! as Extract<ReferenceStyleProgress, { kind: K }>)
  if (!pending) throw new Error('STYLE_FLIGHT_MISSING')
  const finished = pending.then(result => {
    const code = result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string'
      && /^[A-Z][A-Z0-9_]{0,99}$/.test(result.errorCode) ? result.errorCode : 'UNEXPECTED_FINISH'
    throw new Error(`STYLE_BEFORE_${kind.toUpperCase()}:${code}`)
  }, () => { throw new Error(`STYLE_BEFORE_${kind.toUpperCase()}:IPC_REJECTED`) })
  return Promise.race([waiting, finished])
}
function networkFailure() {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('fictional connection reset'), { code: 'ECONNRESET' }) })
}
function ack(item: Extract<ReferenceStyleProgress, { kind: 'opened' | 'commit-ready' }>, decision: 'accept' | 'draft-changed' = 'accept', eventSender = sender) {
  return invoke<{ version: 1; savedWritingStyle: string | null }>('import-generation:v1:style-ack',
    { runId, execution, token: item.token, phase: item.kind === 'opened' ? 'opened' : 'commit', decision }, session, eventSender)
}
function response(text = 'Fictional style: concise dialogue.') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function committedGlobal() {
    const db = getProjectDb()!
    db.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(runId)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const globalSlot = { runId, stage: 'global', batchId: 'done' }
    const begun = await invoke<{ handle: MainGenerationRunHandle }>('generation:begin', {
      operation: 'import-global-facts', uiActionNonce: 'fictional-global', modelId: model.id,
      promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'],
      selectedDraftIds: [], selectedFinalizedDraftIds: [], output: 'structured-data', importSlot: globalSlot, importExecution: execution,
    })
    await invoke('import-generation:v1:query-materials', { handle: begun.handle, execution })
    expect(fetch).toHaveBeenCalledTimes(4)
    fetch.mockImplementation(async () => response('{"fictional":true}'))
    const generated = await invoke<{ outcome: { status: string } }>('import-generation:execute', {
      handle: begun.handle, execution, ordinal: 0,
      task: { purpose: 'import-global-facts', output: 'structured-data', messages: [{ role: 'user', content: 'Summarize the fictional reference.' }] },
    })
    expect(generated.outcome.status).toBe('completed')
    const effect = { ...globalSlot, effectKey: 'global-facts', kind: 'project-global-facts', payload: {
      operationId: `novel-import-global-${runId}`, expectedRosterRevision: 0, generationRunHandle: begun.handle,
      core: { genre: 'fiction', subGenre: 'adventure', targetAudience: 'general', totalChapters: 7, wordsPerChapter: 900,
        plotStructure: 'three_act', narrativePov: 'third_limited', goldenFinger: 'A fictional gift', globalGuidance: 'Follow the letter',
        premise: 'A letter', coreOutline: 'Find its sender', worldSetting: 'A harbor', protagonistProfile: 'A courier',
        worldbuilding: 'The harbor', synopsis: 'A letter' },
      characterEntries: [{ name: 'Courier', role: 'protagonist', gender: 'unknown', age: '18', appearance: 'plain',
        personality: 'careful', background: 'harbor resident', abilities: 'observation', motivation: 'find sender', relationships: [], arc: 'growth', notes: '' }],
    } }
    expect(await dbCall('db:import-run-effect-receipt-prepare', effect, executionLease)).toMatchObject({ success: true, receipt: { state: 'prepared' } })
    expect(await dbCall('db:import-run-effect-receipt-commit', runId, 'global', 'done', executionLease)).toMatchObject({ success: true, result: { receipt: { state: 'committed' } } })
    expect(await dbCall('db:import-run-advance-stage', runId, 'global', 'style', executionLease)).toMatchObject({ success: true })
    return { db, fetch, begun }
}

describe('registered foreground reference style', () => {
  it('renews the same real execution lease while opened and commit-ready handshakes wait', async () => {
    const { db, fetch } = await committedGlobal()
    fetch.mockImplementation(async () => response())
    const beforeStyleRequests = fetch.mock.calls.length
    const originalRenew = ImportRunRepository.renewExecution
    const renewals: ImportRunExecutionLease[] = []
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution').mockImplementation((id, lease, now, _leaseMs, context) => {
      const actual = originalRenew.call(ImportRunRepository, id, lease, now, 200, context)
      renewals.push(actual)
      return actual
    })
    const flight = start(), opened = await event('opened')
    expect(renewals.length).toBeGreaterThan(0)
    const firstExpiry = renewals[0]!.expiresAt
    await vi.waitFor(() => {
      expect(Date.now()).toBeGreaterThan(firstExpiry)
      expect(renewals.length).toBeGreaterThanOrEqual(3)
    }, { timeout: 4_000, interval: 20 })
    const openedRow = db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id=?').get(runId)
    expect(openedRow).toMatchObject({ execution_owner: execution.owner, execution_epoch: execution.epoch })
    expect((openedRow as { lease_expires_at: number }).lease_expires_at).toBeGreaterThan(Date.now())
    expect(fetch).toHaveBeenCalledTimes(beforeStyleRequests)
    expect(renewals.every(lease => lease.owner === execution.owner && lease.epoch === execution.epoch)).toBe(true)

    await ack(opened)
    const ready = await event('commit-ready'), renewalsAtReady = renewals.length
    expect(fetch).toHaveBeenCalledTimes(beforeStyleRequests + 1)
    await vi.waitFor(() => expect(renewals.length).toBeGreaterThanOrEqual(renewalsAtReady + 2), { timeout: 4_000, interval: 20 })
    const commitRow = db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id=?').get(runId)
    expect(commitRow).toMatchObject({ execution_owner: execution.owner, execution_epoch: execution.epoch })
    expect((commitRow as { lease_expires_at: number }).lease_expires_at).toBeGreaterThan(Date.now())
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(beforeStyleRequests + 1)
    await ack(ready)
    expect(await flight).toMatchObject({ success: true, savedWritingStyle: ready.writingStyle })
    expect(renew).toHaveBeenCalled()
  }, 60_000)

  it('cannot fail or cancel the successor after a real expired-lease takeover while opened waits', async () => {
    const { db, fetch } = await committedGlobal()
    fetch.mockImplementation(async () => response())
    const requestsBefore = fetch.mock.calls.length
    const flight = start(), opened = await event('opened')
    expect(opened.execution).toEqual(execution)
    expect(fetch).toHaveBeenCalledTimes(requestsBefore)

    // Inject only expiry; the real repository creates the successor authority and epoch.
    db.prepare('UPDATE import_runs SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, runId)
    const successor = ImportRunRepository.startOrResume(runId, 'fictional-successor', Date.now(), 60_000).execution
    expect(successor.owner).not.toBe(execution.owner)
    expect(successor.epoch).toBeGreaterThan(execution.epoch)
    const successorRow = db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at,status,stage,cancel_requested,last_error FROM import_runs WHERE id=?').get(runId)
    expect(successorRow).toMatchObject({ execution_owner: successor.owner, execution_epoch: successor.epoch,
      lease_expires_at: successor.expiresAt, status: 'running', stage: 'style', cancel_requested: 0 })
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_EXECUTION_STALE' })
    expect(db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at,status,stage,cancel_requested,last_error FROM import_runs WHERE id=?').get(runId)).toEqual(successorRow)
    expect(fetch).toHaveBeenCalledTimes(requestsBefore)
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 60_000)

  it('inherits the committed global root, model and budget even when style requests another model', async () => {
    const { db, fetch, begun } = await committedGlobal()
    const rootPolicy = db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(begun.handle.rootActionId)
    expect(rootPolicy).toBeTypeOf('string')
    fetch.mockImplementation(async () => response())
    const flight = start(otherModel.id), opened = await event('opened')
    expect(opened.handle.rootActionId).toBe(begun.handle.rootActionId)
    expect(opened.modelId).toBe(model.id)
    await ack(opened)
    const ready = await event('commit-ready'); await ack(ready)
    expect(await flight).toMatchObject({ success: true, modelId: model.id, run: { stage: 'blueprints' } })
    expect(db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(begun.handle.rootActionId)).toBe(rootPolicy)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(db.prepare('SELECT count(*) FROM generation_attempts WHERE root_action_id=?').pluck().get(begun.handle.rootActionId)).toBe(2)
    expect(db.prepare(`SELECT count(*) FROM import_query_topics t JOIN import_query_plans p ON p.import_root_run_id=t.import_root_run_id
      WHERE p.root_action_id=? AND t.physical_closed_at_ms IS NOT NULL`).pluck().get(begun.handle.rootActionId)).toBe(4)
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(JSON.stringify(fetch.mock.calls[5])).toContain(model.modelName)
    expect(JSON.stringify(fetch.mock.calls[5])).not.toContain(otherModel.modelName)
  }, 60_000)

  it('replays a committed style read-only after real import completion clears execution authority', async () => {
    const { db, fetch } = await committedGlobal()
    fetch.mockImplementation(async () => response())
    const flight = start(), opened = await event('opened')
    await ack(opened)
    const ready = await event('commit-ready'); await ack(ready)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'blueprints' } })

    // Synthetic blueprint effects exercise the existing receipt/checkpoint contract only;
    // they are not evidence that blueprint generation or literary quality was validated.
    const chapters = ImportRunRepository.listChapterBatch(runId, { afterChapterNumber: 0, limit: 100 })
    expect(chapters).toHaveLength(7)
    for (let offset = 0; offset < chapters.length; offset += 5) {
      const batch = chapters.slice(offset, offset + 5), startChapter = batch[0]!.number, endChapter = batch.at(-1)!.number
      const batchId = createImportRunChapterBatchCheckpointId(batch)
      const effect = { runId, stage: 'blueprints' as const, batchId, effectKey: `blueprints:${batchId}`,
        kind: 'chapter-blueprint-range' as const, payload: { mode: 'replace-range',
          operationId: `import-blueprints-${runId}-${startChapter}-${endChapter}`, startChapter, endChapter,
          blueprints: batch.map(chapter => ({ chapterNumber: chapter.number, title: `Fictional ${chapter.number}`, role: 'setup',
            purpose: `Advance ${chapter.number}`, keyEvents: `Event ${chapter.number}`, characters: [], suspenseHook: `Hook ${chapter.number}`,
            userGuidance: '', notes: '', notesUpdatedAt: '' })) } }
      expect(ImportRunRepository.prepareEffectReceipt(effect, executionLease)).toMatchObject({ state: 'prepared' })
      expect(ImportRunRepository.commitEffectReceipt(runId, 'blueprints', batchId, executionLease).receipt).toMatchObject({ state: 'committed' })
    }
    expect(ImportRunRepository.advanceStage(runId, 'blueprints', 'refresh', executionLease)).toMatchObject({ stage: 'refresh' })
    ImportRunRepository.completeBatch(runId, 'refresh', 'done', executionLease)
    expect(ImportRunRepository.complete(runId, executionLease)).toMatchObject({ stage: 'completed', status: 'completed' })
    const currentStyle = 'Fictional author style changed after completion.'
    expect(currentStyle).not.toBe(ready.writingStyle)
    expect(await dbCall('db:project-core-update', { writingStyle: currentStyle })).toMatchObject({ success: true })
    expect(db.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe(currentStyle)
    const runBefore = db.prepare('SELECT * FROM import_runs WHERE id=?').get(runId)
    expect(runBefore).toMatchObject({ execution_owner: '', lease_expires_at: 0, status: 'completed', stage: 'completed' })
    const rootsBefore = db.prepare('SELECT * FROM generation_roots ORDER BY rowid').all()
    const runsBefore = db.prepare('SELECT * FROM generation_runs ORDER BY rowid').all()
    const attemptsBefore = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const receiptsBefore = db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()
    const ledgerBefore = db.prepare('SELECT * FROM import_effect_ledger ORDER BY rowid').all()
    const fetchCount = fetch.mock.calls.length
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution')
    const replay = await invoke<ReferenceStyleResponse>('import-generation:v1:style', { runId, execution, modelId: model.id })
    expect(replay).toMatchObject({ success: true, replayed: true, execution: null, savedWritingStyle: ready.writingStyle,
      handle: opened.handle, run: { stage: 'completed', status: 'completed' } })
    expect(renew).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM import_runs WHERE id=?').get(runId)).toEqual(runBefore)
    expect(db.prepare('SELECT * FROM generation_roots ORDER BY rowid').all()).toEqual(rootsBefore)
    expect(db.prepare('SELECT * FROM generation_runs ORDER BY rowid').all()).toEqual(runsBefore)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attemptsBefore)
    expect(db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()).toEqual(receiptsBefore)
    expect(db.prepare('SELECT * FROM import_effect_ledger ORDER BY rowid').all()).toEqual(ledgerBefore)
    expect(db.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe(currentStyle)
    expect(fetch).toHaveBeenCalledTimes(fetchCount)
  }, 60_000)

  it('advances a committed style after an interrupted stage transition without repeating its effect', async () => {
    const { db, fetch } = await committedGlobal()
    fetch.mockImplementation(async () => response())
    const advance = vi.spyOn(ImportRunRepository, 'advanceStage').mockImplementationOnce(() => {
      throw new Error('FICTIONAL_ADVANCE_FAILURE')
    })
    const flight = start(), opened = await event('opened')
    await ack(opened)
    const ready = await event('commit-ready')
    expect(await ack(ready)).toEqual({ version: 1, savedWritingStyle: ready.writingStyle })
    expect(await flight).toMatchObject({ success: false })
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance.mock.calls[0]).toEqual(expect.arrayContaining([runId, 'style', 'blueprints']))
    advance.mockRestore()

    expect(ImportRunRepository.get(runId)).toMatchObject({ status: 'running', stage: 'style' })
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toMatchObject({ state: 'committed' })
    expect(db.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe(ready.writingStyle)
    const roots = db.prepare('SELECT * FROM generation_roots ORDER BY rowid').all()
    const attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const receipts = db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()
    const effects = db.prepare('SELECT * FROM import_effect_ledger ORDER BY rowid').all()
    const requests = fetch.mock.calls.length
    expect(requests).toBe(6)

    const replay = await start()
    expect(replay).toMatchObject({ success: true, replayed: true, handle: opened.handle,
      savedWritingStyle: ready.writingStyle, run: { status: 'running', stage: 'blueprints' } })
    expect(db.prepare('SELECT * FROM generation_roots ORDER BY rowid').all()).toEqual(roots)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()).toEqual(receipts)
    expect(db.prepare('SELECT * FROM import_effect_ledger ORDER BY rowid').all()).toEqual(effects)
    expect(db.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe(ready.writingStyle)
    expect(fetch).toHaveBeenCalledTimes(requests)
  }, 60_000)

  it.each(['physical', 'elapsed'] as const)('does not replace an exhausted original %s budget with a fresh root', async kind => {
    const { db, fetch, begun } = await committedGlobal()
    const repository = new GenerationRunRepository(() => db)
    const rootId = begun.handle.rootActionId
    const policy = db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(rootId) as string
    if (kind === 'physical') {
      // Synthetic terminal attempts consume only the existing ledger, not provider requests.
      let index = 0
      let budget = repository.budget(rootId)
      while (budget.attempts.length + (budget.auxiliaryRequestCount ?? 0) < budget.policy.maxPhysicalRequests) {
        const receipt = repository.reserve(begun.handle.runId, `fictional-exhaustion-${index}`, hash(`fictional-exhaustion-${index}`), 1, 1)
        repository.markDispatched(receipt.attempt.attemptId)
        repository.settle(receipt.attempt.attemptId, null, 'stop')
        index++
        budget = repository.budget(rootId)
      }
    } else {
      db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?')
        .run(repository.budget(rootId).policy.maxActiveElapsedMs, rootId)
    }
    const attempts = db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()
    const requests = fetch.mock.calls.length
    let settled = false
    const flight = start(otherModel.id).finally(() => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const opened = sender.events.find(item => item.kind === 'opened')
    if (opened?.kind === 'opened') {
      await ack(opened)
      await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'commit-ready')).toBe(true), { timeout: 10_000 })
      const ready = sender.events.find(item => item.kind === 'commit-ready')
      if (ready?.kind === 'commit-ready') await ack(ready, 'draft-changed').catch(() => undefined)
    }
    expect(await flight).toMatchObject({ success: false, errorCode: 'ROOT_BUDGET_EXHAUSTED' })
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(rootId)).toBe(policy)
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(attempts)
    expect(fetch).toHaveBeenCalledTimes(requests)
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 60_000)

  it('waits for readiness, samples first three and last two, commits once, and replays the durable value', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response()); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    expect(opened).toMatchObject({ projectId: session.projectId, leaseId: session.leaseId, runId, execution, modelId: model.id })
    expect(fetch).not.toHaveBeenCalled()
    expect(await ack(opened)).toEqual({ version: 1, savedWritingStyle: null })
    const ready = await event('commit-ready')
    expect(ready.handle).toEqual(opened.handle)
    expect(ready.writingStyle).toBe('Fictional style: concise dialogue.')
    const firstAck = ack(ready), duplicateAck = ack(ready)
    expect(await firstAck).toEqual({ version: 1, savedWritingStyle: ready.writingStyle })
    expect(await duplicateAck).toEqual({ version: 1, savedWritingStyle: ready.writingStyle })
    expect(getProjectDb()!.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe(ready.writingStyle)
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toMatchObject({ state: 'committed' })
    const result = await flight
    expect(result).toMatchObject({ success: true, version: 1, savedWritingStyle: ready.writingStyle, modelId: model.id, replayed: false, run: { stage: 'blueprints' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    const request = JSON.stringify(fetch.mock.calls[0])
    for (const n of [1, 2, 3, 6, 7]) { expect(request).toContain(`sample-${n}-`); expect(request).not.toContain(`-end-${n}`) }
    for (const n of [4, 5]) expect(request).not.toContain(`sample-${n}-`)
    const db = getProjectDb()!
    expect(db.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe(ready.writingStyle)
    expect(db.prepare('SELECT count(*) FROM generation_attempts WHERE run_id=? AND root_action_id=? AND invocation_nonce=?').pluck().get(opened.handle.runId, opened.handle.rootActionId, 'import:0')).toBe(1)
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toMatchObject({ state: 'committed' })
    expect(db.prepare("SELECT state FROM import_effect_ledger WHERE run_id=? AND stage='style' AND batch_id='done'").pluck().get(runId)).toBe('complete')
    const sequence = sender.events.map(item => item.sequence)
    expect(sequence.every((value, index) => index === 0 || value > sequence[index - 1]!)).toBe(true)
    const replay = await invoke<ReferenceStyleResponse>('import-generation:v1:style', { runId, execution, modelId: model.id })
    expect(replay).toMatchObject({ success: true, savedWritingStyle: ready.writingStyle, replayed: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('rejects closed-contract, stale-session and unknown token inputs without dispatch', async () => {
    const fetch = vi.mocked(globalThis.fetch)
    await expect(invoke('import-generation:v1:style', { runId, execution, modelId: model.id, task: {} })).rejects.toThrow()
    await expect(invoke('import-generation:v1:style', { runId, execution, modelId: model.id }, { ...session, leaseId: 'fictional-stale' })).rejects.toThrow()
    const stale = await invoke<ReferenceStyleResponse>('import-generation:v1:style', { runId, execution: { ...execution, epoch: execution.epoch + 1 }, modelId: model.id })
    expect(stale).toMatchObject({ success: false })
    await expect(invoke('import-generation:v1:style-ack', { runId, execution, token: 'unknown', phase: 'opened', decision: 'accept' })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
  }, 30_000)

  it('rejects another sender and does not prepare an effect after draft-changed', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    const foreign = new Sender(); Object.defineProperty(foreign, 'id', { value: 72 })
    await expect(ack(opened, 'accept', foreign)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await ack(opened)
    const ready = await event('commit-ready')
    await ack(ready, 'draft-changed').catch(() => undefined)
    expect(await flight).toMatchObject({ success: false })
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
    expect(getProjectDb()!.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe('')
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('recovers a prepared effect from its original completed generation without dispatching again', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    await ack(opened)
    const ready = await event('commit-ready')
    // Crash-point injection: seed the prepared receipt after completion and before the driver's commit ACK.
    // This bypasses the controller flight fence but retains the production generation-source guard.
    ImportRunRepository.prepareEffectReceipt({ runId, stage: 'style', batchId: 'done', effectKey: 'writing-style',
      kind: 'project-writing-style', payload: { writingStyle: ready.writingStyle, generationRunHandle: ready.handle } },
    executionLease, Date.now(), assertImportGenerationSourcesCurrent)
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toMatchObject({ state: 'prepared' })
    sender.destroy()
    expect(await flight).toMatchObject({ success: false })
    sender = new Sender()
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    const recovered = await start()
    expect(recovered).toMatchObject({ success: true, savedWritingStyle: ready.writingStyle, run: { stage: 'blueprints' } })
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toMatchObject({ state: 'committed' })
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 30_000)

  it.each(['same connection', 'fresh native reopen'] as const)('reuses the original unknown receipt without resending under a new execution owner and epoch after %s', async recovery => {
    const fetch = vi.fn(async () => { throw networkFailure() }); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    await ack(opened)
    expect(await flight).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    let db = getProjectDb()!
    const attempts = db.prepare('SELECT attempt_id,run_id,root_action_id,invocation_nonce,attempt_json,usage_receipt_json FROM generation_attempts').all() as Array<{
      attempt_id: string; run_id: string; root_action_id: string; invocation_nonce: string; attempt_json: string; usage_receipt_json: string
    }>
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ run_id: opened.handle.runId, root_action_id: opened.handle.rootActionId, invocation_nonce: 'import:0' })
    expect(JSON.parse(attempts[0]!.attempt_json)).toMatchObject({ status: 'unknown' })
    expect(JSON.parse(attempts[0]!.usage_receipt_json)).toMatchObject({ result: { usage: null, finishReason: null, failureCode: 'NETWORK_ERROR' } })
    const stored = JSON.parse(attempts[0]!.usage_receipt_json) as { replayTask: unknown; requestHash: string }
    const binding = JSON.parse(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(opened.handle.runId) as string) as {
      fingerprint: { modelLeaseRevision: string; policyHash: string }
    }
    expect(stored.replayTask).toMatchObject({ purpose: 'analyze-writing-style', output: 'visible-text' })
    expect(stored.requestHash).toBe(hash(JSON.stringify([stored.replayTask, binding.fingerprint.modelLeaseRevision, binding.fingerprint.policyHash])))
    const task = { purpose: 'analyze-writing-style', output: 'visible-text', messages: [{ role: 'user', content: 'not the frozen request' }] }
    const repository = new GenerationRunRepository(() => db)
    const initialBudget = repository.budget(opened.handle.rootActionId)
    const initialRemaining = Math.max(0, initialBudget.policy.maxActiveElapsedMs - initialBudget.activeElapsedMs)
    const originalBefore = Date.now()
    const original = await invoke<MainGenerationExecuteReceipt>(
      'import-generation:execute', { handle: opened.handle, execution, ordinal: 0, task })
    const originalAfter = Date.now()
    expect(original.run.handle).toEqual(opened.handle)
    expect(original.outcome).toMatchObject({ status: 'incomplete', receipt: { failureCode: 'NETWORK_ERROR' } })
    const previousExecution = execution
    if (recovery === 'fresh native reopen') {
      const previousRuntime = projectRuntimeHost.getActiveView()!, previousDatabase = db, previousSession = session
      const identity = db.prepare('SELECT id,root_run_id,effect_namespace,manifest_fingerprint FROM import_runs WHERE id=?').get(runId)
      await projectRuntimeHost.requestClose(previousRuntime)
      expect(previousDatabase.open).toBe(false)
      sender.destroy()
      initProjectDatabase(session.projectPath)
      db = getProjectDb()!
      const runtime = projectRuntimeHost.getActiveView()!, lease = projectAccess.beginViewSession(runtime)
      session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
      sender = new Sender()
      expect(runtime).not.toBe(previousRuntime)
      expect(runtime.databaseIdentity).not.toBe(previousRuntime.databaseIdentity)
      expect(runtime.executionEpoch).not.toBe(previousRuntime.executionEpoch)
      expect(session.leaseId).not.toBe(previousSession.leaseId)
      expect(db).not.toBe(previousDatabase)
      expect(db.prepare('SELECT id,root_run_id,effect_namespace,manifest_fingerprint FROM import_runs WHERE id=?').get(runId)).toEqual(identity)
    }
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery-owner', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    expect(execution.owner).not.toBe(previousExecution.owner)
    expect(execution.epoch).toBeGreaterThan(previousExecution.epoch)
    sender.events = []
    let settled = false
    const retry = start().finally(() => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const reopened = sender.events.find(item => item.kind === 'opened')
    let replayHandle = opened.handle
    if (reopened?.kind === 'opened') {
      expect(reopened.handle).toEqual({ ...opened.handle, epoch: recovery === 'fresh native reopen'
        ? session.leaseId : opened.handle.epoch })
      replayHandle = reopened.handle
      await ack(reopened)
    }
    expect(await retry).toMatchObject({ success: false })
    if (recovery === 'fresh native reopen') {
      expect(replayHandle.epoch).not.toBe(opened.handle.epoch)
      await expect(invoke('import-generation:execute', { handle: opened.handle, execution, ordinal: 0, task }))
        .rejects.toThrow('GENERATION_RUN_IDENTITY_MISMATCH')
    }
    const recoveredBudget = new GenerationRunRepository(() => db).budget(opened.handle.rootActionId)
    const recoveredRemaining = Math.max(0, recoveredBudget.policy.maxActiveElapsedMs - recoveredBudget.activeElapsedMs)
    expect(recoveredRemaining).toBeLessThanOrEqual(initialRemaining)
    const recoveredBefore = Date.now()
    const recovered = await invoke<MainGenerationExecuteReceipt>('import-generation:execute', { handle: replayHandle, execution, ordinal: 0, task })
    const recoveredAfter = Date.now()
    expect(recovered.run.handle).toEqual(replayHandle)
    const { deadlineAt: originalDeadline, ...originalBudget } = original.outcome.receipt.budget
    const { deadlineAt: recoveredDeadline, ...recoveredBudgetReceipt } = recovered.outcome.receipt.budget
    expect(originalDeadline).toBeGreaterThanOrEqual(originalBefore + initialRemaining)
    expect(originalDeadline).toBeLessThanOrEqual(originalAfter + initialRemaining)
    expect(recoveredDeadline).toBeGreaterThanOrEqual(recoveredBefore + recoveredRemaining)
    expect(recoveredDeadline).toBeLessThanOrEqual(recoveredAfter + recoveredRemaining)
    expect(recoveredBudgetReceipt).toEqual(originalBudget)
    expect({ ...recovered.outcome, receipt: { ...recovered.outcome.receipt, budget: recoveredBudgetReceipt } })
      .toEqual({ ...original.outcome, receipt: { ...original.outcome.receipt, budget: originalBudget } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT run_id,root_action_id FROM generation_runs').all()).toEqual([{ run_id: opened.handle.runId, root_action_id: opened.handle.rootActionId }])
    expect(db.prepare('SELECT attempt_id,run_id,root_action_id,invocation_nonce,attempt_json,usage_receipt_json FROM generation_attempts').all()).toEqual(attempts)
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 30_000)

  it('uses actual finalized outbox snapshots within max through max-minus-four', async () => {
    fallbackSamples()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response()); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    const binding = getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(opened.handle.runId) as string
    expect(binding).toContain(hash('final-six'))
    expect(binding).toContain(hash(`final-ten-${'x'.repeat(2100)}-too-late`))
    await ack(opened)
    const ready = await event('commit-ready'); await ack(ready)
    expect(await flight).toMatchObject({ success: true, savedWritingStyle: ready.writingStyle })
    const request = JSON.stringify(fetch.mock.calls[0])
    expect(request).toContain('final-six')
    expect(request).toContain('final-ten-')
    expect(request).not.toContain('outside-five-chapter-window')
    expect(request).not.toContain('-too-late')
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('fences a changed finalized outbox after capture before physical dispatch', async () => {
    fallbackSamples()
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    const altered = 'changed fictional finalized source'
    getProjectDb()!.prepare('UPDATE finalization_outbox_all SET content_snapshot=?,content_hash=? WHERE draft_id=?').run(altered, hash(altered), 106)
    await ack(opened)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_FINALIZED_SOURCE_NOT_CURRENT' })
    expect(getProjectDb()!.prepare('SELECT status,stage,execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id=?').get(runId))
      .toMatchObject({ status: 'failed', stage: 'style', execution_owner: '', execution_epoch: execution.epoch + 1, lease_expires_at: 0 })
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 30_000)

  it('fences legacy DB and generation writers while allowing request-cancel', async () => {
    const flight = start(), opened = await event('opened')
    expect(await dbCall('db:import-run-advance-stage', runId, 'style', 'blueprints', execution)).toMatchObject({ success: false })
    await expect(invoke('import-generation:execute', { handle: opened.handle, execution, ordinal: 0,
      task: { purpose: 'analyze-writing-style', output: 'visible-text', messages: [{ role: 'user', content: 'forged' }] } })).rejects.toThrow()
    expect(await dbCall('db:import-run-request-cancel', runId, execution)).toMatchObject({ success: true })
    await ack(opened)
    expect(await flight).toMatchObject({ success: false })
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 30_000)

  it('keeps a cancelled physical request occupied until the ignored abort drains', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn(async () => { entered(); await gate; return response() }); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    await ack(opened); await started
    try {
      expect(await dbCall('db:import-run-request-cancel', runId, executionLease)).toMatchObject({ success: true })
      await vi.waitFor(() => expect(getProjectDb()!.prepare('SELECT cancel_requested FROM import_runs WHERE id=?').pluck().get(runId)).toBe(1))
      expect(scheduler.getStats().occupied).toBe(1)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { releaseFetch!() }
    expect(await flight).toMatchObject({ success: false })
    await vi.waitFor(() => expect(scheduler.getStats().occupied).toBe(0), { timeout: 10_000 })
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 30_000)

  it('retains a durable provider failure when sender stop races the resolved incomplete operation', async () => {
    const fetch = vi.fn(async () => { throw networkFailure() }); vi.stubGlobal('fetch', fetch)
    const settle = GenerationRunRepository.prototype.settle
    const observed = vi.spyOn(GenerationRunRepository.prototype, 'settle').mockImplementation(function (this: GenerationRunRepository, ...args) {
      const receipt = settle.apply(this, args)
      if (receipt.attempt.status === 'unknown') {
        expect(receipt.failureCode).toBe('NETWORK_ERROR')
        sender.destroy()
      }
      return receipt
    })
    const flight = start(), opened = await event('opened')
    await ack(opened)
    expect(await flight).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    expect(observed).toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 30_000)

  it('reports only safe codes when provider failure is followed by terminal bookkeeping failure', async () => {
    const fetch = vi.fn(async () => { throw networkFailure() }); vi.stubGlobal('fetch', fetch)
    vi.spyOn(ImportRunRepository, 'fail').mockImplementation(() => { throw new Error('fictional-sensitive-diagnostic') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const flight = start(), opened = await event('opened')
    await ack(opened)
    const result = await flight
    expect(result).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    expect(log).toHaveBeenCalledWith('[generation] reference style terminal bookkeeping failed', expect.objectContaining({
      errorCode: 'NETWORK_ERROR', secondaryErrorCodes: ['GENERATION_REQUEST_FAILED'],
    }))
    expect(JSON.stringify(result)).not.toContain('fictional-sensitive-diagnostic')
    expect(JSON.stringify(log.mock.calls)).not.toContain('fictional-sensitive-diagnostic')
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('keeps a real storage failure instead of reporting a later sender stop', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    await ack(opened)
    const ready = await event('commit-ready')
    getProjectDb()!.exec("CREATE TRIGGER fictional_style_failure BEFORE UPDATE OF writing_style ON project_core BEGIN SELECT RAISE(FAIL,'fictional storage failure'); END")
    await expect(ack(ready)).rejects.toThrow()
    sender.destroy()
    const result = await flight
    expect(result).toMatchObject({ success: false })
    if (result.success) throw new Error('EXPECTED_STORAGE_FAILURE')
    expect(result.errorCode).not.toBe('GENERATION_ACTION_CANCELLED')
    expect(getProjectDb()!.prepare('SELECT writing_style FROM project_core WHERE id=?').pluck().get('main')).toBe('')
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')?.state).not.toBe('committed')
  }, 30_000)

  it('keeps project close pending until the physical provider has drained', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn(async () => { entered(); await gate; return response() }); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    await ack(opened); await started
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)!
    expect(runtime).toBeDefined()
    let closed = false
    const closing = projectRuntimeHost.requestClose(runtime).then(() => { closed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(closed).toBe(false)
      expect(scheduler.getStats().occupied).toBe(1)
    } finally {
      releaseFetch!()
      await Promise.allSettled([flight, closing])
    }
    expect(closed).toBe(true)
    expect(scheduler.getStats().occupied).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('holds the physical operation until an ignored-abort provider drains after sender destruction', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn(async () => { entered(); await gate; return response() }); vi.stubGlobal('fetch', fetch)
    const flight = start(), opened = await event('opened')
    await ack(opened); await started
    sender.destroy()
    expect(scheduler.getStats().occupied).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    releaseFetch!()
    expect(await flight).toMatchObject({ success: false })
    await vi.waitFor(() => expect(scheduler.getStats().occupied).toBe(0), { timeout: 10_000 })
    expect(ImportRunRepository.getEffectReceipt(runId, 'style', 'done')).toBeNull()
  }, 30_000)
})
