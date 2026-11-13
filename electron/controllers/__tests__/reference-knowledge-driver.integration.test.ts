import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../../src/shared/ipc-channels'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
import { isReferenceKnowledgeProgress, type ReferenceKnowledgeProgress, type ReferenceKnowledgeReference } from '../../../src/shared/reference-knowledge-contract'

type Sender = EventEmitter & { id: number; isDestroyed: () => boolean; destroy: () => void; send: (channel: string, payload: unknown) => void }
type Handler = (event: { sender: Sender }, ...args: unknown[]) => Promise<unknown>
const mock = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', isPackaged: false }, dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => mock.handlers.set(channel, handler) } }))
vi.mock('../../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'fictional-global.json', MODELS_CONFIG_PATH: 'fictional-models.json',
  DEFAULT_GLOBAL_CONFIG: { defaultModelId: null, defaultEmbeddingModelId: null },
  readJsonFile: (file: string) => file === 'fictional-global.json' ? { defaultEmbeddingModelId: 'fictional' } : [{
    id: 'fictional', provider: 'openai', protocol: 'openai', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-key',
    modelName: 'fictional-model', embeddingOptions: { chunkSize: 1000, chunkOverlap: 0, batchSize: 1 },
  }] }))
vi.mock('../../utils/remembered-dialog', () => ({ showOpenDialogInLastDirectory: vi.fn() }))
vi.mock('../../i18n', () => ({ mainText: (_locale: string, _zh: string, en: string) => en, getMainLocale: () => 'en-US' }))
import { createProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { FinalizedDraftImportRepository } from '../../repositories/finalized-draft-import-repository'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { getNewProjectDatabasePath, getProjectDatabasePath } from '../../services/project-data-locator'
import * as vectorStore from '../../vector-store'
import { registerKBController } from '../kb-controller'
import { registerDatabaseController } from '../db-controller'
import { registerReferenceKnowledgeController } from '../reference-knowledge-controller'
import { explainImportRunFailure } from '../import-run-failure'
// @ts-expect-error Existing JavaScript cleanup helper has no declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'

const RUN = 'fictional-driver-run'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const response = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
type Prepared = { reference: ReferenceKnowledgeReference; execution: { owner: string; epoch: number; expiresAt: number } }
let tempBase = '', parent = '', root = ''
let session: ProjectSessionContext
let subject: Sender
let db: NonNullable<ReturnType<typeof getProjectDb>>
let events: ReferenceKnowledgeProgress[]
let eventEvidence: unknown[]

function verifiedCleanupRoot(): string {
  const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const target = path.resolve(parent)
  if (normal(path.dirname(target)) !== normal(tempBase) || !path.basename(target).startsWith('pk-ref-driver-')) throw new Error('FIXTURE_CLEANUP_OUTSIDE_BASE')
  const pending = [target]
  for (const directory of [tempBase, target]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normal(fs.realpathSync.native(directory)) !== normal(directory)) throw new Error('FIXTURE_CLEANUP_LINK')
  }
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      const relative = path.relative(target, fs.realpathSync.native(child))
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || fs.lstatSync(child).isSymbolicLink() || normal(fs.realpathSync.native(child)) !== normal(child)) throw new Error('FIXTURE_CLEANUP_LINK')
      if (entry.isDirectory()) pending.push(child)
    }
  }
  return target
}
function sender(): Sender {
  let destroyed = false
  const emitter = new EventEmitter()
  return Object.assign(emitter, { id: 51, isDestroyed: () => destroyed, destroy: () => {
    destroyed = true
    emitter.emit('destroyed')
  }, send: (channel: string, payload: unknown) => {
    if (channel !== 'reference-knowledge:v1:progress' || !isReferenceKnowledgeProgress(payload)) {
      eventEvidence.push({ invalid: true }); return
    }
    if (payload.kind === 'chapter') {
      eventEvidence.push(db.prepare('SELECT state FROM import_run_knowledge_receipts WHERE run_id=? AND chapter_number=?')
        .pluck().get(RUN, payload.chapterNumber))
    } else eventEvidence.push(ImportRunRepository.get(RUN)?.completedBatches.knowledge?.length ?? 0)
    events.push(payload)
  } })
}
function invoke(channel: string, payload: unknown, who = subject, withView = true): Promise<unknown> {
  const handler = mock.handlers.get(channel)
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler({ sender: who }, payload, ...(withView ? [session] : []))
}
function execute(value: Prepared, who = subject): Promise<unknown> {
  return invoke('reference-knowledge:v1:execute', { reference: value.reference,
    execution: { owner: value.execution.owner, epoch: value.execution.epoch } }, who)
}
async function prepare(runId = RUN): Promise<Prepared> {
  return await invoke('reference-knowledge:v1:prepare', { operationId: randomUUID(), runId, executionOwner: randomUUID() }) as Prepared
}
function createRun(chapterCount: number, runId = RUN, purpose: 'reference' | 'author-manuscript' = 'reference') {
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const content = `Fictional chapter ${index + 1}: a courier crosses a quiet harbor.`
    return { number: index + 1, title: `Chapter ${index + 1}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }
  })
  const preview = purpose === 'author-manuscript' ? FinalizedDraftImportRepository.preview(chapters.map(chapter => ({
    chapterNumber: chapter.number, title: chapter.title, content: chapter.content, wordCount: countDraftUnits(chapter.content),
  }))) : undefined
  return ImportRunRepository.prepare({ runId, purpose, sourceFingerprint: hash(runId), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: chapters.reduce((sum, c) => sum + c.contentSize, 0) }], chapters,
    ...(preview ? { authorityFingerprint: preview.authorityFingerprint, expectedManifestFingerprint: preview.manifestFingerprint } : {}) })
}
function count(table: string): number { return Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()) }
async function vectors(): Promise<unknown[]> {
  const registry = await vectorStore.getEmbeddingSpaces(root)
  const active = registry.spaces.find(space => space.generation === registry.activeGeneration)
  if (!active) return []
  const table = await (await vectorStore.getConnection(root)).openTable(active.tableName)
  try { return await table.query().select(['vector']).toArray() } finally { table.close() }
}

beforeEach(() => {
  mock.handlers.clear(); events = []; eventEvidence = []
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('FICTIONAL_NETWORK_FORBIDDEN') }))
  tempBase = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(tempBase, 'pk-ref-driver-'))
  const project = projectAccess.createProject(parent, 'A')
  createProjectDatabase(project.rootPath, Buffer.alloc(32, 44))
  const lease = projectAccess.beginSession(project)
  root = lease.rootPath
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
  openCanonicalProjectFixture(root, Buffer.alloc(32, 44))
  db = getProjectDb()!
  subject = sender()
  registerReferenceKnowledgeController(); registerKBController(); registerDatabaseController()
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (root) vectorStore.closeConnection(root)
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    vectorStore.closeConnection(runtime.canonicalRoot)
    projectRuntimeHost.releaseIdle(runtime)
  }
  projectAccess.invalidateCurrentSession()
  if (parent) removeTemporaryTree(verifiedCleanupRoot(), tempBase)
  parent = ''; root = ''
})

describe('registered foreground reference knowledge driver with native storage', () => {
  it('imports across pages and checkpoints before projecting progress, then replays the global acknowledgement', async () => {
    createRun(101)
    const fetchMock = vi.fn(async () => response()); vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare()
    const result = await execute(issued)
    expect(result).toMatchObject({ success: true, run: { id: RUN, stage: 'global' }, execution: { owner: issued.execution.owner, epoch: issued.execution.epoch } })
    expect(count('import_run_knowledge_receipts')).toBe(101)
    expect(count('import_reference_documents')).toBe(101)
    expect(fetchMock).toHaveBeenCalledTimes(101)
    expect((await vectors()).length).toBeGreaterThan(0)
    const chapters = events.filter(event => event.kind === 'chapter')
    expect(chapters.map(event => event.kind === 'chapter' && event.chapterNumber)).toEqual(Array.from({ length: 101 }, (_, i) => i + 1))
    expect(chapters.every(event => event.kind === 'chapter' && !event.idempotent)).toBe(true)
    expect(events.every(event => JSON.stringify(event.reference) === JSON.stringify(issued.reference)
      && event.execution.owner === issued.execution.owner && event.execution.epoch === issued.execution.epoch)).toBe(true)
    expect(events.filter(event => event.kind === 'batch')).toHaveLength(11)
    expect(eventEvidence.filter(value => value === 'committed')).toHaveLength(101)
    expect(eventEvidence.filter(value => typeof value === 'number')).toEqual(Array.from({ length: 11 }, (_, i) => i + 1))
    expect(eventEvidence).toHaveLength(events.length)
    expect(ImportRunRepository.get(RUN)?.completedBatches.knowledge).toHaveLength(11)
    const before = events.length
    await expect(execute(issued)).resolves.toMatchObject({ success: true, run: { stage: 'global' } })
    expect(fetchMock).toHaveBeenCalledTimes(101)
    expect(events).toHaveLength(before)
  }, 120000)

  it('joins duplicate live execution and fences competing renderer writers', async () => {
    createRun(2)
    const gate = deferred<Response>()
    const fetchMock = vi.fn().mockImplementationOnce(() => gate.promise).mockImplementation(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare(), first = execute(issued)
    void first.catch(() => {})
    let second: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      second = execute(issued)
      void second.catch(() => {})
      await expect(prepare()).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
      const blocked = [
        ['db:import-run-renew-execution', RUN, issued.execution, root],
        ['db:import-run-cancel-at-boundary', RUN, issued.execution, root],
        ['db:import-run-complete-batch', RUN, 'knowledge', '1-1-12345678', issued.execution, root],
        ['db:import-run-advance-stage', RUN, 'knowledge', 'global', issued.execution, root],
        ['db:import-run-fail', RUN, 'knowledge', 'fictional', issued.execution, root],
      ] as const
      for (const [channel, ...args] of blocked) {
        const handler = mock.handlers.get(channel)!
        await expect(handler({ sender: subject }, ...args, session)).resolves.toMatchObject({
          success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE',
        })
      }
      await expect(invoke('reference-knowledge:v1:import', { reference: issued.reference, chapterNumber: 1,
        execution: { owner: issued.execution.owner, epoch: issued.execution.epoch } })).resolves.toMatchObject({ success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      gate.resolve(response())
      await expect(first).resolves.toMatchObject({ success: true, run: { stage: 'global' } })
      await expect(second).resolves.toMatchObject({ success: true, run: { stage: 'global' } })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(count('import_run_knowledge_receipts')).toBe(2)
    } finally { gate.resolve(response()); await Promise.allSettled([first, ...(second ? [second] : [])]) }
  })

  it.each(['revoke', 'destroy', 'close'] as const)('drains physical work without a late receipt on %s', async action => {
    createRun(2)
    const gate = deferred<Response>(), fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare(), runtime = projectRuntimeHost.getActiveView()!, pending = execute(issued)
    void pending.catch(() => {})
    let closing: Promise<void> | undefined
    let atRelease: unknown
    let releaseObservationError: unknown
    const observe = () => ({
      run: db.prepare('SELECT status,stage,execution_owner,execution_epoch,lease_expires_at,last_error FROM import_runs WHERE id=?').get(RUN),
      receipts: count('import_run_knowledge_receipts'),
      dispatches: db.prepare('SELECT dispatch_id,import_run_id FROM reference_embedding_dispatches').all(),
      budget: db.prepare('SELECT root_run_id,request_limit,spent_requests FROM reference_embedding_budgets WHERE root_run_id=?').get(RUN),
    })
    const removeRelease = projectRuntimeHost.onBeforeRelease(released => {
      if (released === runtime) {
        try { atRelease = observe() } catch (error) { releaseObservationError = error }
      }
    })
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const before = observe()
      expect(before.run).toMatchObject({ status: 'running', stage: 'knowledge', execution_owner: issued.execution.owner,
        execution_epoch: issued.execution.epoch, last_error: '' })
      expect(before.dispatches).toHaveLength(1)
      expect(before.budget).toEqual({ root_run_id: RUN, request_limit: 2, spent_requests: 1 })
      if (action === 'revoke') await expect(invoke('reference-knowledge:v1:revoke', issued.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
      if (action === 'destroy') { subject.destroy(); expect(subject.isDestroyed()).toBe(true) }
      if (action === 'close') {
        closing = projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
        let done = false; void closing.then(() => { done = true }, () => { done = true })
        await Promise.resolve(); expect(done).toBe(false); expect(runtime.database.open).toBe(true)
      }
      gate.resolve(response())
      await expect(pending).resolves.toMatchObject({ success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED' })
      if (closing) await closing
      expect(releaseObservationError).toBeUndefined()
      expect(closing ? atRelease : observe()).toEqual({
        run: { status: 'cancelled', stage: 'knowledge', execution_owner: '', execution_epoch: issued.execution.epoch + 1,
          lease_expires_at: 0, last_error: '' },
        receipts: 0, dispatches: before.dispatches, budget: before.budget,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(events.filter(event => event.kind === 'chapter')).toHaveLength(0)
    } finally { gate.resolve(response()); await Promise.allSettled([pending, ...(closing ? [closing] : [])]); removeRelease() }
  })

  it('refuses a recovered open dispatch rather than sending it again', async () => {
    createRun(1)
    const gate = deferred<Response>(), fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare(), runtime = projectRuntimeHost.getActiveView()!, pending = execute(issued)
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const snapshot = Buffer.from(runtime.database.serialize())
      const databasePath = getProjectDatabasePath(root)
      gate.resolve(response()); await pending
      vectorStore.closeConnection(root); await projectRuntimeHost.requestClose(runtime)
      fs.writeFileSync(databasePath, snapshot)
      openCanonicalProjectFixture(root, Buffer.alloc(32, 44))
      const reopened = projectRuntimeHost.getActiveView()!, lease = projectAccess.beginViewSession(reopened)
      session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }; db = reopened.database
      registerReferenceKnowledgeController()
      await expect(prepare()).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_BUDGET_RECOVERY_UNKNOWN')
      expect(db.prepare('SELECT state FROM reference_embedding_budgets').pluck().get()).toBe('recovery_unknown')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(count('import_run_knowledge_receipts')).toBe(0)
    } finally { gate.resolve(response()); await Promise.allSettled([pending]) }
  })

  it('reconciles an existing checkpoint and a separate committed chapter receipt', async () => {
    createRun(12)
    const fetchMock = vi.fn(async () => response()); vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare()
    const chapterRows = ImportRunRepository.listChapterBatch(RUN, { afterChapterNumber: 0, limit: 100 })
    for (const chapter of chapterRows.slice(0, 11)) {
      await expect(invoke('reference-knowledge:v1:import', { reference: issued.reference, chapterNumber: chapter.number,
        execution: { owner: issued.execution.owner, epoch: issued.execution.epoch } })).resolves.toMatchObject({ success: true })
    }
    const checkpoint = createImportRunChapterBatchCheckpointId(chapterRows.slice(0, 10))
    ImportRunRepository.completeBatch(RUN, 'knowledge', checkpoint, issued.execution)
    expect(count('import_run_knowledge_receipts')).toBe(11)
    await expect(execute(issued)).resolves.toMatchObject({ success: true, run: { stage: 'global' } })
    expect(fetchMock).toHaveBeenCalledTimes(12)
    expect(count('import_run_knowledge_receipts')).toBe(12)
    expect(events.filter(event => event.kind === 'chapter')).toEqual([
      expect.objectContaining({ chapterNumber: chapterRows[10]!.number, idempotent: true }),
      expect.objectContaining({ chapterNumber: chapterRows[11]!.number, idempotent: false }),
    ])
    expect(events.filter(event => event.kind === 'batch')).toHaveLength(2)
    expect(ImportRunRepository.get(RUN)?.completedBatches.knowledge).toHaveLength(2)
  }, 20_000)

  it('preserves the existing localized migration barrier from the real KB importer', async () => {
    createRun(1)
    const issued = await prepare()
    const storageRoot = projectRuntimeHost.getActiveView()!.projectStorageRoot
    fs.writeFileSync(path.join(storageRoot, 'vectors.json'), '{broken fictional json', { flag: 'wx' })
    const result = await execute(issued)
    const expected = 'Legacy knowledge-base data must be repaired before continuing. Fix vectors.json in the project, then try again.'
    expect(result).toEqual({ success: false, errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED', error: expected })
    expect(db.prepare('SELECT last_error FROM import_runs WHERE id=?').pluck().get(RUN)).toBe(expected)
    expect(count('import_run_knowledge_receipts')).toBe(0)
    expect(ImportRunRepository.get(RUN)?.completedBatches.knowledge ?? []).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('respects sparse historical chapter numbers and separate contiguous checkpoints', async () => {
    const sourceId = `legacy:${hash(RUN)}`
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO import_source_chapter_map
        (purpose,source_id,source_chapter_number,chapter_number) VALUES ('reference',?,?,?)`)
      for (const [sourceChapter, logicalChapter] of [[1, 1], [2, 2], [3, 4]]) insert.run(sourceId, sourceChapter, logicalChapter)
    })()
    expect(createRun(3).classification).toBe('new')
    expect(ImportRunRepository.listChapterBatch(RUN, { afterChapterNumber: 0, limit: 10 }).map(chapter => chapter.number)).toEqual([1, 2, 4])
    const fetchMock = vi.fn(async () => response()); vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare()
    await expect(execute(issued)).resolves.toMatchObject({ success: true, run: { stage: 'global' } })
    expect(events.filter(event => event.kind === 'chapter').map(event => event.kind === 'chapter' && event.chapterNumber)).toEqual([1, 2, 4])
    expect(ImportRunRepository.get(RUN)?.completedBatches.knowledge).toEqual([
      expect.stringMatching(/^1-2-/u), expect.stringMatching(/^4-4-/u),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(count('import_run_knowledge_receipts')).toBe(3)
  })

  it('rejects an unrelated sender and mismatched execution without physical effects', async () => {
    createRun(1)
    const issued = await prepare()
    await expect(execute(issued, sender())).resolves.toMatchObject({ success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED' })
    await expect(execute({ ...issued, execution: { ...issued.execution, owner: randomUUID() } })).resolves.toMatchObject({
      success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH',
    })
    await expect(execute({ ...issued, execution: { ...issued.execution, epoch: issued.execution.epoch + 1 } })).resolves.toMatchObject({
      success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(count('reference_embedding_dispatches')).toBe(0)
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })

  it('does not mutate a superseding execution epoch', async () => {
    createRun(1)
    const issued = await prepare()
    db.prepare('UPDATE import_runs SET execution_epoch=execution_epoch+1 WHERE id=?').run(RUN)
    const before = db.prepare('SELECT status,stage,execution_owner,execution_epoch,last_error FROM import_runs WHERE id=?').get(RUN)
    await expect(execute(issued)).resolves.toMatchObject({ success: false })
    expect(db.prepare('SELECT status,stage,execution_owner,execution_epoch,last_error FROM import_runs WHERE id=?').get(RUN)).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })

  it('drains an in-flight request after losing its lease without changing the successor', async () => {
    createRun(2)
    const gate = deferred<Response>(), fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare(), pending = execute(issued)
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const dispatch = db.prepare('SELECT dispatch_id,import_run_id,state FROM reference_embedding_dispatches').get() as {
        dispatch_id: string; import_run_id: string; state: string
      }
      expect(dispatch).toMatchObject({ import_run_id: RUN, state: 'dispatch_marked' })
      const budget = db.prepare('SELECT root_run_id,request_limit,spent_requests FROM reference_embedding_budgets WHERE root_run_id=?').get(RUN)
      expect(budget).toEqual({ root_run_id: RUN, request_limit: 2, spent_requests: 1 })
      const successorOwner = randomUUID(), successorEpoch = issued.execution.epoch + 1
      const successorExpiry = Date.now() + 300_000
      expect(db.prepare(`UPDATE import_runs SET execution_owner=?, execution_epoch=?, lease_expires_at=?
        WHERE id=? AND execution_owner=? AND execution_epoch=?`)
        .run(successorOwner, successorEpoch, successorExpiry, RUN, issued.execution.owner, issued.execution.epoch).changes).toBe(1)
      const successor = db.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN)
      expect(successor).toMatchObject({ status: 'running', stage: 'knowledge', execution_owner: successorOwner,
        execution_epoch: successorEpoch, lease_expires_at: successorExpiry })
      const checkpoints = db.prepare('SELECT * FROM import_effect_ledger WHERE run_id=? ORDER BY rowid').all(RUN)
      expect(checkpoints).toEqual([])
      expect(count('import_run_knowledge_receipts')).toBe(0)
      gate.resolve(response())
      await expect(pending).resolves.toMatchObject({ success: false, errorCode: 'IMPORT_RUN_EXECUTION_STALE' })
      expect(db.prepare('SELECT dispatch_id,import_run_id FROM reference_embedding_dispatches').all())
        .toEqual([{ dispatch_id: dispatch.dispatch_id, import_run_id: RUN }])
      expect(db.prepare('SELECT root_run_id,request_limit,spent_requests FROM reference_embedding_budgets WHERE root_run_id=?').get(RUN)).toEqual(budget)
      expect(db.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN)).toEqual(successor)
      expect(db.prepare('SELECT * FROM import_effect_ledger WHERE run_id=? ORDER BY rowid').all(RUN)).toEqual(checkpoints)
      expect(db.prepare("SELECT COUNT(*) FROM import_reference_documents WHERE state='committed'").pluck().get()).toBe(0)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(events.filter(event => event.kind === 'chapter')).toHaveLength(0)
    } finally { gate.resolve(response()); await Promise.allSettled([pending]) }
  })

  it('rejects an author manuscript at the real preparation boundary', async () => {
    expect(createRun(1, RUN, 'author-manuscript').run).toMatchObject({ purpose: 'author-manuscript', stage: 'author-commit' })
    await expect(prepare()).rejects.toThrow(explainImportRunFailure('IMPORT_RUN_REFERENCE_UNBOUND', 'en-US')!.error)
    expect(fetch).not.toHaveBeenCalled()
    expect(count('reference_import_grants')).toBe(0)
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })

  it('rejects a missing source binding before admitting the driver', async () => {
    createRun(1)
    expect(db.prepare('DELETE FROM reference_import_manifest_chapters WHERE import_run_id=?').run(RUN).changes).toBe(1)
    await expect(prepare()).rejects.toThrow('IMPORT_RUN_SNAPSHOT_CORRUPT')
    expect(fetch).not.toHaveBeenCalled()
    expect(count('reference_embedding_budgets')).toBe(0)
    expect(count('reference_import_grants')).toBe(0)
  })

  it('refuses a source snapshot changed after issuance without sending an embedding', async () => {
    createRun(1)
    const issued = await prepare()
    db.prepare("UPDATE import_run_chapters SET content_snapshot=content_snapshot || 'tampered' WHERE run_id=?").run(RUN)
    await expect(execute(issued)).resolves.toMatchObject({ success: false, errorCode: 'IMPORT_RUN_SNAPSHOT_CORRUPT' })
    expect(fetch).not.toHaveBeenCalled()
    expect(count('reference_embedding_dispatches')).toBe(0)
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })

  it('does not dispatch when the root active-time budget is exhausted', async () => {
    createRun(1)
    const issued = await prepare()
    db.prepare('UPDATE reference_embedding_budgets SET active_elapsed_ms=active_limit_ms WHERE root_run_id=?').run(RUN)
    await expect(execute(issued)).resolves.toMatchObject({ success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_BUDGET_ACTIVE_TIME_EXHAUSTED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(count('reference_embedding_dispatches')).toBe(0)
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })

  it('accepts requestCancel during a live physical request and stops at the boundary', async () => {
    createRun(2)
    const gate = deferred<Response>(), fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare(), pending = execute(issued)
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const handler = mock.handlers.get('db:import-run-request-cancel')!
      await expect(handler({ sender: subject }, RUN, issued.execution, root, session)).resolves.toMatchObject({ success: true })
      gate.resolve(response())
      await expect(pending).resolves.toMatchObject({ success: false })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(ImportRunRepository.get(RUN)).toMatchObject({ stage: 'knowledge', status: 'cancelled' })
    } finally { gate.resolve(response()); await Promise.allSettled([pending]) }
  })

  it('rejects opening another real project throughout the foreground operation', async () => {
    createRun(1)
    const other = projectAccess.createProject(parent, 'B')
    const otherDatabasePath = getNewProjectDatabasePath(other.rootPath)
    createProjectDatabase(other.rootPath, Buffer.alloc(32, 45))
    const gate = deferred<Response>(), fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const issued = await prepare(), pending = execute(issued)
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const executeHandler = mock.handlers.get('reference-knowledge:v1:execute')!
      const foreignSession = { projectId: other.projectId, leaseId: randomUUID(), projectPath: other.rootPath }
      await expect(executeHandler({ sender: subject }, { reference: issued.reference,
        execution: { owner: issued.execution.owner, epoch: issued.execution.epoch } }, foreignSession))
        .resolves.toMatchObject({ success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(() => projectRuntimeHost.prepareOpen(other)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
      expect(projectRuntimeHost.getOpenRuntimes()).toHaveLength(1)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      gate.resolve(response())
      await expect(pending).resolves.toMatchObject({ success: true, run: { stage: 'global' } })
      expect(count('import_run_knowledge_receipts')).toBe(1)
      const otherDb = new Database(otherDatabasePath, { readonly: true, fileMustExist: true })
      try {
        expect(otherDb.prepare('SELECT COUNT(*) FROM import_runs').pluck().get()).toBe(0)
        expect(otherDb.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(0)
      } finally { otherDb.close() }
    } finally { gate.resolve(response()); await Promise.allSettled([pending]) }
  })
})
