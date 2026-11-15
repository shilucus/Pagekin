import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { ReferenceKnowledgeReference } from '../../../src/shared/reference-knowledge-contract'

type Sender = EventEmitter & { id: number; isDestroyed: () => boolean }
type Handler = (event: { sender: Sender }, ...args: unknown[]) => Promise<unknown>
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(), selected: 'fictional-a',
  profiles: [
    { id: 'fictional-a', provider: 'openai', protocol: 'openai', baseUrl: 'https://a.invalid/v1', apiKey: 'fictional-key-a', modelName: 'model-a', embeddingOptions: { chunkSize: 1000, chunkOverlap: 0, batchSize: 1 } },
    { id: 'fictional-b', provider: 'openai', protocol: 'openai', baseUrl: 'https://b.invalid/v1', apiKey: 'fictional-key-b', modelName: 'model-b', embeddingOptions: { chunkSize: 100, chunkOverlap: 0, batchSize: 1 } },
  ],
  afterImport: null as null | (() => Promise<void>),
}))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', isPackaged: false }, dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => mock.handlers.set(channel, handler) } }))
vi.mock('../../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'fictional-global.json', MODELS_CONFIG_PATH: 'fictional-models.json',
  DEFAULT_GLOBAL_CONFIG: { defaultModelId: null, defaultEmbeddingModelId: null },
  readJsonFile: (file: string) => file === 'fictional-global.json' ? { defaultEmbeddingModelId: mock.selected } : structuredClone(mock.profiles) }))
vi.mock('../../utils/remembered-dialog', () => ({ showOpenDialogInLastDirectory: vi.fn() }))
vi.mock('../../i18n', () => ({ mainText: (_locale: string, _zh: string, en: string) => en, getMainLocale: () => 'en-US' }))
vi.mock('../../services/knowledge-base-loader', () => {
  const load = async () => {
    const kb = await import('../../knowledge-base')
    return { ...kb, importReferenceText: async (...args: Parameters<typeof kb.importReferenceText>) => {
      const result = await kb.importReferenceText(...args)
      await mock.afterImport?.()
      return result
    } }
  }
  return { knowledgeBaseLoader: { load, run: async (operation: (kb: Awaited<ReturnType<typeof load>>) => unknown) => operation(await load()) } }
})
import { createProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { chunkText } from '../../embedding'
import { ReferenceImportGrantRepository } from '../../repositories/reference-import-grant-repository'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { getProjectDatabasePath } from '../../services/project-data-locator'
import { ReferenceKnowledgeAuthority } from '../../services/reference-knowledge-authority'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'
import { translate } from '../../../src/i18n/core'
import * as vectorStore from '../../vector-store'
import { registerKBController } from '../kb-controller'
import { registerDatabaseController } from '../db-controller'
import { registerReferenceKnowledgeController } from '../reference-knowledge-controller'
// @ts-expect-error Existing JavaScript cleanup helper has no declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'

const RUN = 'fictional-reference-knowledge'
const CONTENT = 'A fictional courier waits at a harbor with a sealed letter. '.repeat(4)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sender = (): Sender => Object.assign(new EventEmitter(), { id: 51, isDestroyed: () => false })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
function response() { return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }) }
const BATCH_CHUNKS = ['A alpha', 'B bravo', 'C charlie'].map(text => text.padEnd(100, 'x'))
const BATCH_CONTENT = BATCH_CHUNKS.join('\n\n')
function batchResponse(ordinal: number) {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [ordinal + 1, 0, 0] }] }), { status: 200 })
}
function batchOrdinal(init: RequestInit): number {
  const input = (JSON.parse(String(init.body)) as { input: string[] }).input[0]!
  return input.charCodeAt(0) - 'A'.charCodeAt(0)
}
function prepareBatchRun() {
  const runId = `fictional-batch-${randomUUID()}`
  const prepared = ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash(runId), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: Buffer.byteLength(BATCH_CONTENT) }],
    chapters: [{ number: 1, title: 'One', content: BATCH_CONTENT, contentSize: Buffer.byteLength(BATCH_CONTENT), contentFingerprint: hash(BATCH_CONTENT) }] })
  expect(prepared.classification).toBe('new')
  expect(prepared.newChapterNumbers).toHaveLength(1)
  return { runId, chapterNumber: prepared.newChapterNumbers[0]! }
}
function dispatchRows() {
  return db.prepare('SELECT batch_ordinal, input_count, state, http_status, settled_at FROM reference_embedding_dispatches ORDER BY batch_ordinal').all()
}
async function waitForBatchStarts(fetchMock: { mock: { calls: unknown[] } }, pending: Promise<unknown>, expected: number) {
  let early: string | undefined
  void pending.then(result => {
    const value = result as { success?: boolean; errorCode?: string }
    early = value.errorCode ?? (value.success ? 'EARLY_SUCCESS' : 'EARLY_FAILURE_WITHOUT_CODE')
  }, () => { early = 'EARLY_REJECTION' })
  await vi.waitFor(() => {
    expect(early, 'import settled before expected physical requests').toBeUndefined()
    expect(fetchMock.mock.calls).toHaveLength(expected)
  })
}
async function storedBatchVectors() {
  const registry = await vectorStore.getEmbeddingSpaces(root)
  const active = registry.spaces.find(space => space.generation === registry.activeGeneration)
  if (!active) return []
  const table = await (await vectorStore.getConnection(root)).openTable(active.tableName)
  try {
    const rows = await table.query().select(['chunkIndex', 'text', 'vector']).toArray() as Array<{ chunkIndex: number; text: string; vector: number[] }>
    return rows.sort((a, b) => a.chunkIndex - b.chunkIndex).map(row => ({ ...row, vector: Array.from(row.vector) }))
  } finally { table.close() }
}
async function canonicalBatchRows() {
  const connection = await vectorStore.getConnection(root)
  if (!(await connection.tableNames()).includes('chunks')) return []
  const table = await connection.openTable('chunks')
  try {
    const rows = await table.query().select(['chunkIndex', 'text']).toArray() as Array<{ chunkIndex: number; text: string }>
    return rows.sort((a, b) => a.chunkIndex - b.chunkIndex).map(row => ({ chunkIndex: row.chunkIndex, text: row.text }))
  } finally { table.close() }
}
let tempBase = '', parent = '', root = ''
let session: ProjectSessionContext
let subject: Sender
let db: NonNullable<ReturnType<typeof getProjectDb>>

function verifiedCleanupRoot(): string {
  const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const target = path.resolve(parent)
  if (normal(path.dirname(target)) !== normal(tempBase) || !path.basename(target).startsWith('pk-ref-owner-')) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  for (const directory of [tempBase, target]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normal(fs.realpathSync.native(directory)) !== normal(directory)) throw new Error('FICTIONAL_CLEANUP_LINK')
  }
  const pending = [target]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      const relative = path.relative(target, fs.realpathSync.native(child))
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || fs.lstatSync(child).isSymbolicLink() || normal(fs.realpathSync.native(child)) !== normal(child)) throw new Error('FICTIONAL_CLEANUP_LINK')
      if (entry.isDirectory()) pending.push(child)
    }
  }
  return target
}
function invoke(channel: string, payload: unknown, who = subject, withView = true): Promise<unknown> {
  const handler = mock.handlers.get(channel)
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler({ sender: who }, payload, ...(withView ? [session] : []))
}
type Prepared = { reference: ReferenceKnowledgeReference; execution: { owner: string; epoch: number } }
async function prepare(operationId = randomUUID(), executionOwner = randomUUID(), runId = RUN): Promise<Prepared> {
  return await invoke('reference-knowledge:v1:prepare', { operationId, runId, executionOwner }) as Prepared
}
function importChapter(value: Prepared, who = subject, chapterNumber = 1): Promise<unknown> {
  return invoke('reference-knowledge:v1:import', { reference: value.reference, chapterNumber,
    execution: { owner: value.execution.owner, epoch: value.execution.epoch } }, who)
}
async function denied(operation: Promise<unknown>): Promise<void> {
  let result: unknown
  try { result = await operation } catch (error) { expect(error).toBeInstanceOf(Error); return }
  expect(result).toMatchObject({ success: false })
}
function count(table: string): number { return Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()) }
function removeUnstartedDefaultReferenceRun(): void {
  expect(db.prepare('SELECT status,stage,execution_epoch FROM import_runs WHERE id=?').get(RUN))
    .toEqual({ status: 'ready', stage: 'knowledge', execution_epoch: 0 })
  const chapters = db.prepare(`SELECT source_id,source_chapter_number FROM import_run_chapters WHERE run_id=?`).all(RUN) as Array<{
    source_id: string; source_chapter_number: number
  }>
  expect(chapters).toHaveLength(1)
  const chapter = chapters[0]!
  const mappings = db.prepare(`SELECT purpose,source_id,source_chapter_number,chapter_number
    FROM import_source_chapter_map WHERE purpose='reference' AND source_id=? AND source_chapter_number=?`)
    .all(chapter.source_id, chapter.source_chapter_number)
  expect(mappings).toEqual([{ purpose: 'reference', source_id: chapter.source_id,
    source_chapter_number: chapter.source_chapter_number, chapter_number: 1 }])
  expect(db.prepare(`SELECT 1 FROM import_run_chapters WHERE run_id<>? AND source_id=? AND source_chapter_number=? LIMIT 1`)
    .get(RUN, chapter.source_id, chapter.source_chapter_number)).toBeUndefined()
  expect(db.prepare('SELECT 1 FROM import_runs WHERE base_run_id=? LIMIT 1').get(RUN)).toBeUndefined()
  for (const [table, key] of [
    ['reference_import_grants', 'import_run_id'],
    ['reference_embedding_dispatches', 'import_run_id'],
    ['import_run_knowledge_receipts', 'run_id'],
    ['reference_embedding_budgets', 'root_run_id'],
  ] as const) {
    expect(db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=? LIMIT 1`).get(RUN)).toBeUndefined()
  }
  expect(db.prepare('DELETE FROM import_runs WHERE id=?').run(RUN).changes).toBe(1)
  expect(db.prepare(`DELETE FROM import_source_chapter_map
    WHERE purpose=? AND source_id=? AND source_chapter_number=? AND chapter_number=?`)
    .run('reference', chapter.source_id, chapter.source_chapter_number,
      (mappings[0] as { chapter_number: number }).chapter_number).changes).toBe(1)
}

let referenceRetirementGuard: (runtime: ProjectRuntime) => boolean
let referenceRetirementGuardInstalled = false

beforeEach(() => {
  mock.handlers.clear(); mock.selected = 'fictional-a'; mock.afterImport = null
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('FICTIONAL_NETWORK_FORBIDDEN') }))
  tempBase = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(tempBase, 'pk-ref-owner-'))
  const project = projectAccess.createProject(parent, 'A')
  createProjectDatabase(project.rootPath, Buffer.alloc(32, 44))
  const lease = projectAccess.beginSession(project)
  root = lease.rootPath
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
  openCanonicalProjectFixture(root, Buffer.alloc(32, 44))
  db = getProjectDb()!
  ImportRunRepository.prepare({ runId: RUN, purpose: 'reference', sourceFingerprint: hash('fictional-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: Buffer.byteLength(CONTENT) }],
    chapters: [{ number: 1, title: 'One', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) }] })
  subject = sender()
  const register = referenceRetirementGuardInstalled ? null : vi.spyOn(projectRuntimeHost, 'registerRetirementGuard')
  registerReferenceKnowledgeController(); registerKBController(); registerDatabaseController()
  if (register) { referenceRetirementGuard = register.mock.calls[0]![0]; referenceRetirementGuardInstalled = true; register.mockRestore() }
})
afterEach(() => {
  mock.afterImport = null; vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (root) vectorStore.closeConnection(root)
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    vectorStore.closeConnection(runtime.canonicalRoot)
    projectRuntimeHost.releaseIdle(runtime)
  }
  projectAccess.invalidateCurrentSession()
  if (parent) removeTemporaryTree(verifiedCleanupRoot(), tempBase)
  parent = ''; root = ''
})

describe('registered reference knowledge controller with real native storage', () => {
  it('preserves an unstarted issuance and durable unknown during pure retirement checks', async () => {
    const runtime = projectRuntimeHost.getActiveView()!
    const first = await prepare()
    const grants = db.prepare('SELECT * FROM reference_import_grants').all()
    expect(referenceRetirementGuard(runtime)).toBe(false)
    expect(db.prepare('SELECT * FROM reference_import_grants').all()).toEqual(grants)
    await invoke('reference-knowledge:v1:revoke', first.reference, subject, false)
    expect(referenceRetirementGuard(runtime)).toBe(true)
    db.prepare("UPDATE reference_embedding_budgets SET state='recovery_unknown'").run()
    const budget = db.prepare('SELECT * FROM reference_embedding_budgets').all()
    expect(referenceRetirementGuard(runtime)).toBe(false)
    expect(db.prepare('SELECT * FROM reference_embedding_budgets').all()).toEqual(budget)
  })
  it('retains a legacy unknown reference effect without changing the ledger', () => {
    const runtime = projectRuntimeHost.getActiveView()!
    const namespace = db.prepare('SELECT effect_namespace FROM import_runs WHERE id=?').pluck().get(RUN) as string
    db.prepare(`INSERT INTO import_effect_ledger(run_id,stage,batch_id,effect_namespace,effect_key,state,evidence_kind,diagnostic_code)
      VALUES(?,'global','__legacy_fictional',?,'fictional-legacy-global-unknown','unknown','terminal','FICTIONAL_UNKNOWN')`)
      .run(RUN, namespace)
    const before = db.prepare('SELECT total_changes()').pluck().get()
    expect(referenceRetirementGuard(runtime)).toBe(false)
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
    expect(db.prepare("SELECT state FROM import_effect_ledger WHERE run_id=? AND stage='global'").pluck().get(RUN)).toBe('unknown')
  })
  it.each(['missing-binding', 'different-completed-snapshot', 'same-body-unfinished-cross-root'] as const)(
    'rejects a corrupted full manifest before budget or grant creation (%s)', async corruption => {
      const logicalChapter = ImportRunRepository.listChapterBatch(RUN, { afterChapterNumber: 0, limit: 10 })[0]!

      if (corruption === 'missing-binding') {
        expect(db.prepare('DELETE FROM reference_import_manifest_chapters WHERE import_run_id=? AND chapter_number=?')
          .run(RUN, logicalChapter.number).changes).toBe(1)
      } else {
        const snapshotRunId = `fictional-manifest-snapshot-${randomUUID()}`
        const content = corruption === 'different-completed-snapshot'
          ? 'A different fictional manifest body.' : logicalChapter.content
        const snapshot = ImportRunRepository.prepare({ runId: snapshotRunId, purpose: 'reference',
          sourceFingerprint: hash(snapshotRunId), locale: 'en-US',
          sourceDisplay: [{ displayName: 'snapshot.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
          chapters: [{ number: 1, title: logicalChapter.title, content, contentSize: Buffer.byteLength(content),
            contentFingerprint: hash(content) }] })
        expect(snapshot.classification).toBe('new')
        const physicalChapter = ImportRunRepository.listChapterBatch(snapshotRunId, { afterChapterNumber: 0, limit: 10 })[0]!
        if (corruption === 'different-completed-snapshot') {
          db.prepare(`UPDATE import_runs SET stage='completed',status='completed',resumable=0,completed_at=datetime('now') WHERE id=?`)
            .run(snapshotRunId)
        }
        expect(db.prepare(`UPDATE reference_import_manifest_chapters
          SET snapshot_run_id=?,snapshot_chapter_number=? WHERE import_run_id=? AND chapter_number=?`)
          .run(snapshotRunId, physicalChapter.number, RUN, logicalChapter.number).changes).toBe(1)
      }

      const before = db.prepare('SELECT status,stage,execution_epoch FROM import_runs WHERE id=?').get(RUN)
      await expect(prepare()).rejects.toThrow('IMPORT_RUN_SNAPSHOT_CORRUPT')
      expect(fetch).not.toHaveBeenCalled()
      expect(count('reference_embedding_budgets')).toBe(0)
      expect(count('reference_import_grants')).toBe(0)
      expect(count('reference_embedding_dispatches')).toBe(0)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(db.prepare('SELECT status,stage,execution_epoch FROM import_runs WHERE id=?').get(RUN)).toEqual(before)
      expect(before).toEqual({ status: 'ready', stage: 'knowledge', execution_epoch: 0 })
    })

  it('binds a full incremental manifest when baseline-shaped sources reuse local chapter number one', async () => {
    removeUnstartedDefaultReferenceRun()
    const sourceA = randomUUID(), sourceB = randomUUID(), sourceC = randomUUID()
    const firstIdA = `fictional-completed-a-${randomUUID()}`
    const firstIdB = `fictional-completed-b-${randomUUID()}`
    const firstA = ImportRunRepository.prepare({ runId: firstIdA, purpose: 'reference',
      sourceFingerprint: hash('fictional-completed-source-a'), sourceIds: [sourceA], locale: 'en-US',
      sourceDisplay: [{ displayName: 'a.txt', mediaType: 'text/plain', size: Buffer.byteLength(CONTENT) }],
      chapters: [{ number: 1, title: 'One', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) }] })
    expect(firstA.classification).toBe('new')
    db.prepare(`UPDATE import_runs SET stage='completed',status='completed',resumable=0,completed_at=datetime('now') WHERE id=?`)
      .run(firstIdA)
    const firstB = ImportRunRepository.prepare({ runId: firstIdB, purpose: 'reference',
      sourceFingerprint: hash('fictional-completed-source-b'), sourceIds: [sourceB], locale: 'en-US',
      sourceDisplay: [{ displayName: 'b.txt', mediaType: 'text/plain', size: Buffer.byteLength('Other chapter.') }],
      chapters: [{ number: 1, title: 'Other', content: 'Other chapter.', contentSize: Buffer.byteLength('Other chapter.'), contentFingerprint: hash('Other chapter.') }] })
    expect(firstB.classification).toBe('new')
    db.prepare('DELETE FROM reference_import_manifest_chapters WHERE import_run_id=? AND chapter_number=2').run(firstIdB)
    db.prepare('UPDATE import_run_chapters SET chapter_number=1 WHERE run_id=? AND chapter_number=2').run(firstIdB)
    db.prepare(`UPDATE import_runs SET stage='completed',status='completed',resumable=0,completed_at=datetime('now') WHERE id=?`)
      .run(firstIdB)

    const runId = `fictional-incremental-${randomUUID()}`
    const incremental = ImportRunRepository.prepare({ runId, purpose: 'reference',
      sourceFingerprint: hash('fictional-incremental-source'), sourceIds: [sourceA, sourceB, sourceC], locale: 'en-US',
      sourceDisplay: [
        { displayName: 'a.txt', mediaType: 'text/plain', size: Buffer.byteLength(CONTENT) },
        { displayName: 'b.txt', mediaType: 'text/plain', size: Buffer.byteLength('Other chapter.') },
        { displayName: 'c.txt', mediaType: 'text/plain', size: Buffer.byteLength('New chapter.') },
      ],
      chapters: [
        { number: 1, sourceIndex: 0, title: 'One', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) },
        { number: 1, sourceIndex: 1, title: 'Other', content: 'Other chapter.', contentSize: Buffer.byteLength('Other chapter.'), contentFingerprint: hash('Other chapter.') },
        { number: 1, sourceIndex: 2, title: 'New', content: 'New chapter.', contentSize: Buffer.byteLength('New chapter.'), contentFingerprint: hash('New chapter.') },
      ] })
    expect(incremental.classification).toBe('new')
    expect(incremental.run).toMatchObject({ totalChapters: 1, manifestChapterCount: 3 })
    expect(db.prepare(`SELECT chapter_number,snapshot_run_id,snapshot_chapter_number,source_id,source_chapter_number
      FROM reference_import_manifest_chapters WHERE import_run_id=? ORDER BY chapter_number`).all(runId))
      .toEqual([
        { chapter_number: 1, snapshot_run_id: firstIdA, snapshot_chapter_number: 1, source_id: sourceA, source_chapter_number: 1 },
        { chapter_number: 2, snapshot_run_id: firstIdB, snapshot_chapter_number: 1, source_id: sourceB, source_chapter_number: 1 },
        { chapter_number: 3, snapshot_run_id: runId, snapshot_chapter_number: 3, source_id: sourceC, source_chapter_number: 1 },
      ])
    const runtime = projectRuntimeHost.getActiveView()!
    const context = { database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId }
    const streamed: Array<{ number: number; title: string; content: string }> = []
    const validatedManifest = ImportRunRepository.streamValidatedReferenceManifest(
      runId, context, chapter => streamed.push(chapter),
    )
    expect(validatedManifest).toMatchObject({ chapterCount: 3 })
    expect(streamed.map(({ number, title, content }) => ({ number, title, content }))).toEqual([
      { number: 1, title: 'One', content: CONTENT },
      { number: 2, title: 'Other', content: 'Other chapter.' },
      { number: 3, title: 'New', content: 'New chapter.' },
    ])

    const issuance = await prepare(randomUUID(), randomUUID(), runId)
    const initialBudget = db.prepare('SELECT * FROM reference_embedding_budgets').get()
    expect(initialBudget).toMatchObject({ root_run_id: runId, manifest_fingerprint: validatedManifest.manifestFingerprint,
      request_limit: 3, spent_requests: 0 })
    await expect(invoke('reference-knowledge:v1:revoke', issuance.reference, subject, false))
      .resolves.toMatchObject({ state: 'revoked' })

    db.prepare("UPDATE import_runs SET status='failed',resumable=1 WHERE id=?").run(runId)
    const restarted = ImportRunRepository.restart(runId, `fictional-incremental-restart-${randomUUID()}`)
    expect(ImportRunRepository.streamValidatedReferenceManifest(restarted.id, context)).toMatchObject({
      rootRunId: runId, manifestFingerprint: validatedManifest.manifestFingerprint, chapterCount: 3,
    })
    expect(db.prepare(`SELECT chapter_number,snapshot_run_id,snapshot_chapter_number,source_id,source_chapter_number
      FROM reference_import_manifest_chapters WHERE import_run_id=? ORDER BY chapter_number`).all(restarted.id))
      .toEqual(db.prepare(`SELECT chapter_number,snapshot_run_id,snapshot_chapter_number,source_id,source_chapter_number
        FROM reference_import_manifest_chapters WHERE import_run_id=? ORDER BY chapter_number`).all(runId))
    const resumed = await prepare(randomUUID(), randomUUID(), restarted.id)
    expect(resumed.reference.runId).toBe(restarted.id)
    expect(db.prepare('SELECT * FROM reference_embedding_budgets').get()).toEqual(initialBudget)
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    for (const chapterNumber of [1, 2]) {
      await expect(importChapter(resumed, subject, chapterNumber)).resolves.toMatchObject({
        success: false, errorCode: 'IMPORT_RUN_REFERENCE_UNBOUND',
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(count('import_reference_documents')).toBe(0)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(count('reference_embedding_dispatches')).toBe(0)
      expect(db.prepare('SELECT spent_requests,active_since_ms FROM reference_embedding_budgets').get())
        .toEqual({ spent_requests: 0, active_since_ms: null })
    }
    await expect(importChapter(resumed, subject, 3)).resolves.toMatchObject({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT run_id,chapter_number,state FROM import_run_knowledge_receipts').all())
      .toEqual([{ run_id: restarted.id, chapter_number: 3, state: 'committed' }])
    expect(db.prepare('SELECT import_run_id,state FROM reference_embedding_dispatches').all())
      .toEqual([{ import_run_id: restarted.id, state: 'response_received' }])
    expect(db.prepare('SELECT state FROM import_reference_documents').all()).toEqual([{ state: 'committed' }])
    expect(db.prepare('SELECT request_limit,spent_requests FROM reference_embedding_budgets').get())
      .toEqual({ request_limit: 3, spent_requests: 1 })
  })
  it('binds worker-finalized duplicate snapshots from baseline-shaped local chapter numbering', async () => {
    removeUnstartedDefaultReferenceRun()
    const legacyFingerprint = hash('fictional-legacy-source')
    const legacyRunId = `fictional-legacy-${randomUUID()}`
    const legacy = ImportRunRepository.prepare({ runId: legacyRunId, purpose: 'reference',
      sourceFingerprint: legacyFingerprint, locale: 'en-US',
      sourceDisplay: [{ displayName: 'legacy.txt', mediaType: 'text/plain', size: Buffer.byteLength(CONTENT) }],
      chapters: [{ number: 7, title: 'Legacy one', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) }] })
    expect(legacy.classification).toBe('new')
    db.prepare(`UPDATE import_runs SET stage='completed',status='completed',resumable=0,completed_at=datetime('now') WHERE id=?`)
      .run(legacyRunId)

    const sourceA = randomUUID(), sourceB = randomUUID(), sourceC = randomUUID(), runId = randomUUID()
    const secondLegacyRunId = `fictional-legacy-second-${randomUUID()}`
    ImportRunRepository.prepare({ runId: secondLegacyRunId, purpose: 'reference',
      sourceFingerprint: hash('fictional-legacy-second-source'), sourceIds: [sourceB], locale: 'en-US',
      sourceDisplay: [{ displayName: 'second-legacy.txt', mediaType: 'text/plain', size: Buffer.byteLength('Other chapter.') }],
      chapters: [{ number: 1, title: 'Legacy two', content: 'Other chapter.', contentSize: Buffer.byteLength('Other chapter.'), contentFingerprint: hash('Other chapter.') }] })
    db.prepare('DELETE FROM reference_import_manifest_chapters WHERE import_run_id=? AND chapter_number=2').run(secondLegacyRunId)
    db.prepare('UPDATE import_run_chapters SET chapter_number=1 WHERE run_id=? AND chapter_number=2').run(secondLegacyRunId)
    db.prepare(`UPDATE import_runs SET stage='completed',status='completed',resumable=0,completed_at=datetime('now') WHERE id=?`)
      .run(secondLegacyRunId)

    const worker = ImportRunRepository.beginParsing({ runId, purpose: 'reference',
      sourceFingerprint: hash('fictional-worker-source'), sourceIds: [sourceA, sourceB, sourceC],
      sourceFingerprints: [hash('fictional-worker-a'), hash('fictional-worker-b'), hash('fictional-worker-c')],
      legacySourceFingerprints: [legacyFingerprint, '', ''], locale: 'en-US',
      sourceDisplay: [
        { displayName: 'legacy.txt', mediaType: 'text/plain', size: Buffer.byteLength(CONTENT) },
        { displayName: 'second-legacy.txt', mediaType: 'text/plain', size: Buffer.byteLength('Other chapter.') },
        { displayName: 'new.txt', mediaType: 'text/plain', size: Buffer.byteLength('New chapter.') },
      ] })
    expect(worker.stage).toBe('parsing')
    ImportRunRepository.commitParsedSource(runId, sourceA, [
      { number: 1, sourceChapterNumber: 7, title: 'Legacy one', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) },
    ])
    ImportRunRepository.commitParsedSource(runId, sourceB, [
      { number: 1, title: 'Legacy two', content: 'Other chapter.', contentSize: Buffer.byteLength('Other chapter.'), contentFingerprint: hash('Other chapter.') },
    ])
    ImportRunRepository.commitParsedSource(runId, sourceC, [
      { number: 1, title: 'New', content: 'New chapter.', contentSize: Buffer.byteLength('New chapter.'), contentFingerprint: hash('New chapter.') },
    ])
    const finalized = ImportRunRepository.finalizeParsing(runId)
    expect(finalized.classification).toBe('new')
    expect(finalized.run).toMatchObject({ totalChapters: 1, manifestChapterCount: 3 })
    expect(db.prepare(`SELECT chapter_number,snapshot_run_id,snapshot_chapter_number,source_id,source_chapter_number
      FROM reference_import_manifest_chapters WHERE import_run_id=? ORDER BY chapter_number`).all(runId))
      .toEqual([
        { chapter_number: 1, snapshot_run_id: legacyRunId, snapshot_chapter_number: 1, source_id: sourceA, source_chapter_number: 7 },
        { chapter_number: 2, snapshot_run_id: secondLegacyRunId, snapshot_chapter_number: 1, source_id: sourceB, source_chapter_number: 1 },
        { chapter_number: 3, snapshot_run_id: runId, snapshot_chapter_number: 3, source_id: sourceC, source_chapter_number: 1 },
      ])
    expect(db.prepare('SELECT source_id FROM import_run_chapters WHERE run_id=?').get(legacyRunId))
      .toEqual({ source_id: sourceA })
    const runtime = projectRuntimeHost.getActiveView()!
    const context = { database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId }
    expect(ImportRunRepository.streamValidatedReferenceManifest(legacyRunId, context)).toMatchObject({ chapterCount: 1 })
    const streamed: Array<{ number: number; title: string; content: string }> = []
    const validatedManifest = ImportRunRepository.streamValidatedReferenceManifest(
      runId, context, chapter => streamed.push(chapter),
    )
    expect(validatedManifest).toMatchObject({ chapterCount: 3 })
    expect(streamed.map(({ number, title, content }) => ({ number, title, content }))).toEqual([
      { number: 1, title: 'Legacy one', content: CONTENT },
      { number: 2, title: 'Legacy two', content: 'Other chapter.' },
      { number: 3, title: 'New', content: 'New chapter.' },
    ])
    const issuance = await prepare(randomUUID(), randomUUID(), runId)
    const initialBudget = db.prepare('SELECT * FROM reference_embedding_budgets').get()
    expect(initialBudget).toMatchObject({ root_run_id: runId, manifest_fingerprint: validatedManifest.manifestFingerprint,
      request_limit: 3, spent_requests: 0 })
    await expect(invoke('reference-knowledge:v1:revoke', issuance.reference, subject, false))
      .resolves.toMatchObject({ state: 'revoked' })
    db.prepare("UPDATE import_runs SET status='failed',resumable=1 WHERE id=?").run(runId)
    const restarted = ImportRunRepository.restart(runId, `fictional-worker-restart-${randomUUID()}`)
    expect(ImportRunRepository.streamValidatedReferenceManifest(restarted.id, context)).toMatchObject({
      rootRunId: runId, manifestFingerprint: validatedManifest.manifestFingerprint, chapterCount: 3,
    })
    const resumed = await prepare(randomUUID(), randomUUID(), restarted.id)
    expect(resumed.reference.runId).toBe(restarted.id)
    expect(db.prepare('SELECT * FROM reference_embedding_budgets').get()).toEqual(initialBudget)
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    for (const chapterNumber of [1, 2]) {
      await expect(importChapter(resumed, subject, chapterNumber)).resolves.toMatchObject({
        success: false, errorCode: 'IMPORT_RUN_REFERENCE_UNBOUND',
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(count('import_reference_documents')).toBe(0)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(count('reference_embedding_dispatches')).toBe(0)
      expect(db.prepare('SELECT spent_requests,active_since_ms FROM reference_embedding_budgets').get())
        .toEqual({ spent_requests: 0, active_since_ms: null })
    }
    await expect(importChapter(resumed, subject, 3)).resolves.toMatchObject({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT run_id,chapter_number,state FROM import_run_knowledge_receipts').all())
      .toEqual([{ run_id: restarted.id, chapter_number: 3, state: 'committed' }])
    expect(db.prepare('SELECT import_run_id,state FROM reference_embedding_dispatches').all())
      .toEqual([{ import_run_id: restarted.id, state: 'response_received' }])
    expect(db.prepare('SELECT state FROM import_reference_documents').all()).toEqual([{ state: 'committed' }])
    expect(db.prepare('SELECT request_limit,spent_requests FROM reference_embedding_budgets').get())
      .toEqual({ request_limit: 3, spent_requests: 1 })
  })
  it('freezes the selected model and replays a successful receipt without a second fetch', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    const operation = randomUUID(), owner = randomUUID()
    const first = await prepare(operation, owner)
    expect(first.reference).toMatchObject({ projectId: session.projectId, runId: RUN, revision: 1 })
    expect(first.execution).toMatchObject({ owner })
    expect(await prepare(operation, owner)).toEqual(first)
    expect(count('reference_import_grants')).toBe(1)
    mock.selected = 'fictional-b'
    await expect(importChapter(first)).resolves.toMatchObject({ success: true })
    await expect(importChapter(first)).resolves.toMatchObject({ success: true, idempotent: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('a.invalid')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'model-a' })
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fictional-key-a')
    expect(count('import_reference_documents')).toBe(1)
    expect(count('import_run_knowledge_receipts')).toBe(1)
    expect(db.prepare('SELECT initial_chunk_size, initial_chunk_overlap, initial_batch_size, request_limit, spent_requests, active_elapsed_ms, active_since_ms FROM reference_embedding_budgets').get())
      .toMatchObject({ initial_chunk_size: 1000, initial_chunk_overlap: 0, initial_batch_size: 1,
        request_limit: Math.ceil(chunkText(CONTENT, 1000, 0).length / 1), spent_requests: 1, active_since_ms: null })
  })
  it('keeps the root budget when a restart explicitly selects different embedding options', async () => {
    const profile = mock.profiles[0]!, saved = profile.embeddingOptions
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    try {
      Object.defineProperty(profile, 'embeddingOptions', { value: { chunkSize: 1000, chunkOverlap: 0, batchSize: 50 }, writable: true, configurable: true })
      const first = await prepare()
      const initial = db.prepare('SELECT * FROM reference_embedding_budgets').get()
      expect(initial).toMatchObject({ initial_chunk_size: 1000, initial_batch_size: 50, request_limit: 1, spent_requests: 0 })
      await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
      const descendant = ImportRunRepository.restart(RUN, `fictional-restart-${randomUUID()}`).id
      mock.selected = 'fictional-b'
      const resumed = await prepare(randomUUID(), randomUUID(), descendant)
      expect(resumed.reference.runId).toBe(descendant)
      expect(db.prepare('SELECT * FROM reference_embedding_budgets').get()).toEqual(initial)
      const result = await importChapter(resumed) as { success: boolean; errorCode: string }
      expect(result).toMatchObject({ success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_BUDGET_EXHAUSTED' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(db.prepare('SELECT spent_requests, active_since_ms FROM reference_embedding_budgets').get())
        .toEqual({ spent_requests: 1, active_since_ms: null })
      expect(count('import_run_knowledge_receipts')).toBe(0)
    } finally { profile.embeddingOptions = saved }
  })
  it('enforces the active-time cap before the KB document effect', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const gate = deferred<Response>()
    const fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const first = await prepare()
    const activeLimit = (db.prepare('SELECT active_limit_ms FROM reference_embedding_budgets').get() as { active_limit_ms: number }).active_limit_ms
    const pending = importChapter(first)
    void pending.catch(() => {})
    try {
      await waitForBatchStarts(fetchMock, pending, 1)
      now += activeLimit
      gate.resolve(response())
      await expect(pending).resolves.toMatchObject({
        success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_BUDGET_ACTIVE_TIME_EXHAUSTED',
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(db.prepare("SELECT state FROM import_reference_documents WHERE corpus_kind='reference'").all())
        .toEqual([{ state: 'prepared' }])
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(dispatchRows()).toEqual([expect.objectContaining({ state: 'response_received', settled_at: expect.any(Number) })])
      expect(db.prepare('SELECT spent_requests,active_elapsed_ms,active_since_ms,state FROM reference_embedding_budgets').get())
        .toEqual({ spent_requests: 1, active_elapsed_ms: activeLimit, active_since_ms: null, state: 'ready' })
      expect(await vectorStore.listDocuments(root)).toEqual([])
    } finally {
      gate.resolve(response())
      await Promise.allSettled([pending])
    }
  })
  it('keeps the KB commit but refuses the final run receipt after another same-root flight exhausts active time', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const gates = [deferred<Response>(), deferred<Response>()]
    let fetchIndex = 0
    const fetchMock = vi.fn(() => gates[fetchIndex++]!.promise)
    vi.stubGlobal('fetch', fetchMock)
    const sourceFingerprint = hash('fictional-two-chapter-source')
    const runId = `fictional-two-chapter-${randomUUID()}`
    const secondContent = 'A second fictional chapter for the reference import.'
    ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint, locale: 'en-US',
      sourceDisplay: [{ displayName: 'two.txt', mediaType: 'text/plain',
        size: Buffer.byteLength(CONTENT) + Buffer.byteLength(secondContent) }],
      chapters: [
        { number: 1, title: 'One', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) },
        { number: 2, title: 'Two', content: secondContent, contentSize: Buffer.byteLength(secondContent), contentFingerprint: hash(secondContent) },
      ] })
    let afterImportCalls = 0
    const atReceiptBoundary = deferred<void>(), releaseReceipt = deferred<void>()
    mock.afterImport = async () => {
      afterImportCalls += 1
      if (afterImportCalls === 1) {
        atReceiptBoundary.resolve()
        await releaseReceipt.promise
      }
    }
    let firstImport: Promise<unknown> | undefined
    let secondImport: Promise<unknown> | undefined
    try {
      const chapters = ImportRunRepository.listChapterBatch(runId, { afterChapterNumber: 0, limit: 10 })
      expect(chapters).toHaveLength(2)
      const first = await prepare(randomUUID(), randomUUID(), runId)
      const activeLimit = (db.prepare('SELECT active_limit_ms FROM reference_embedding_budgets').get() as { active_limit_ms: number }).active_limit_ms
      firstImport = importChapter(first, subject, chapters[0]!.number)
      secondImport = importChapter(first, subject, chapters[1]!.number)
      void firstImport.catch(() => {})
      void secondImport.catch(() => {})
      await waitForBatchStarts(fetchMock, firstImport, 2)
      gates[0]!.resolve(response())
      await atReceiptBoundary.promise
      expect(db.prepare("SELECT state FROM import_reference_documents WHERE state='committed'").all()).toHaveLength(1)
      expect(db.prepare('SELECT active_since_ms,active_elapsed_ms FROM reference_embedding_budgets').get())
        .toMatchObject({ active_since_ms: now, active_elapsed_ms: 0 })
      now += activeLimit
      releaseReceipt.resolve()
      await expect(firstImport).resolves.toMatchObject({
        success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_BUDGET_ACTIVE_TIME_EXHAUSTED',
      })
      expect(db.prepare("SELECT state FROM import_reference_documents WHERE state='committed'").all()).toHaveLength(1)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      gates[1]!.resolve(response())
      await expect(secondImport).resolves.toMatchObject({
        success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_BUDGET_ACTIVE_TIME_EXHAUSTED',
      })
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(db.prepare("SELECT COUNT(*) AS count FROM reference_embedding_dispatches WHERE state='dispatch_marked'").get())
        .toEqual({ count: 0 })
      expect(db.prepare('SELECT spent_requests,active_elapsed_ms,active_since_ms,state FROM reference_embedding_budgets').get())
        .toEqual({ spent_requests: 2, active_elapsed_ms: activeLimit, active_since_ms: null, state: 'ready' })
      expect(db.prepare("SELECT state FROM import_reference_documents WHERE state='committed'").all()).toHaveLength(1)
    } finally {
      releaseReceipt.resolve()
      gates.forEach(gate => gate.resolve(response()))
      const pending = [firstImport, secondImport].filter((value): value is Promise<unknown> => value !== undefined)
      await Promise.allSettled(pending)
      mock.afterImport = null
    }
  })
  it('requires the same actual WebContents object even when numeric ids match', async () => {
    const first = await prepare(), impostor = sender()
    await denied(importChapter(first, impostor))
    await denied(invoke('reference-knowledge:v1:revoke', first.reference, impostor, false))
    expect(count('import_run_knowledge_receipts')).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('early revoke prevents automatic resume and both legacy execution entrances', async () => {
    const first = await prepare()
    await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
    await denied(invoke('reference-knowledge:v1:resume', first.reference))
    const oldStart = mock.handlers.get('db:import-run-start-resume')!
    await denied(oldStart({ sender: subject }, RUN, first.execution.owner, root, session))
    const oldImport = mock.handlers.get('kb:import-reference-text')!
    await denied(oldImport({ sender: subject }, 1, RUN, first.execution, session))
    expect(count('reference_import_grants')).toBe(1)
    expect(count('import_run_knowledge_receipts')).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not allocate a first budget after the legacy start-resume path has already executed the root', async () => {
    const oldStart = mock.handlers.get('db:import-run-start-resume')!
    await oldStart({ sender: subject }, RUN, randomUUID(), root, session)
    await denied(prepare(randomUUID(), randomUUID(), RUN))
    expect(count('reference_embedding_budgets')).toBe(0)
    expect(count('reference_import_grants')).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('detaches sender destruction listeners after repeated revokes and project close', async () => {
    const runtime = projectRuntimeHost.getActiveView()!
    const unrelated = () => {}
    subject.on('destroyed', unrelated)
    const baseline = subject.listenerCount('destroyed')
    const during: number[] = []
    const afterReplay: number[] = []
    const afterRevoke: number[] = []
    try {
      for (let i = 0; i < 3; i++) {
        const operation = randomUUID(), owner = randomUUID()
        const issuance = await prepare(operation, owner)
        during.push(subject.listenerCount('destroyed'))
        expect(await prepare(operation, owner)).toEqual(issuance)
        afterReplay.push(subject.listenerCount('destroyed'))
        await expect(invoke('reference-knowledge:v1:revoke', issuance.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
        afterRevoke.push(subject.listenerCount('destroyed'))
      }
      await prepare()
      const beforeClose = subject.listenerCount('destroyed')
      await projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
      const afterClose = subject.listenerCount('destroyed')
      expect({ during, afterReplay, afterRevoke, beforeClose, afterClose }).toEqual({
        during: [baseline + 1, baseline + 1, baseline + 1],
        afterReplay: [baseline + 1, baseline + 1, baseline + 1],
        afterRevoke: [baseline, baseline, baseline],
        beforeClose: baseline + 1,
        afterClose: baseline,
      })
      expect(subject.listeners('destroyed')).toContain(unrelated)
      expect(runtime.database.open).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      subject.off('destroyed', unrelated)
    }
  })
  it.each([false, true])('later-stage revoke preserves the execution lease only after resume: %s', async resumed => {
    // Issue the managed root budget first, then simulate its durable later-stage state.
    const first = await prepare()
    db.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(RUN)
    if (resumed) await invoke('reference-knowledge:v1:resume', first.reference)
    await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
    const row = db.prepare('SELECT status, stage, cancel_requested, execution_owner, execution_epoch, lease_expires_at FROM import_runs WHERE id=?')
      .get(RUN) as { status: string; stage: string; cancel_requested: number; execution_owner: string; execution_epoch: number; lease_expires_at: number }
    expect(row).toMatchObject({ stage: 'global', cancel_requested: 1 })
    if (resumed) {
      expect(row).toMatchObject({ status: 'running', execution_owner: first.execution.owner, execution_epoch: first.execution.epoch })
      expect(row.lease_expires_at).toBeGreaterThan(0)
    } else {
      expect(row).toMatchObject({ status: 'cancelled', execution_owner: '', execution_epoch: first.execution.epoch + 1, lease_expires_at: 0 })
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })
  it('freezes absent embedding options and sends default-normalized content despite later configuration changes', async () => {
    const profile = mock.profiles[0]!
    const saved = profile.embeddingOptions
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    try {
      Object.defineProperty(profile, 'embeddingOptions', { value: undefined, writable: true, configurable: true })
      const first = await prepare()
      profile.embeddingOptions = { chunkSize: 100, chunkOverlap: 0, batchSize: 1 }
      await expect(importChapter(first)).resolves.toMatchObject({ success: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(String(url)).toContain('a.invalid')
      expect(JSON.parse(String(init.body))).toEqual({ model: 'model-a', input: [CONTENT.trim()] })
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fictional-key-a')
      expect(count('import_run_knowledge_receipts')).toBe(1)
    } finally { profile.embeddingOptions = saved }
  })
  it.each([1, 2] as const)('freezes concurrency %i across profile changes and persists ordered batches', async concurrency => {
    const profile = mock.profiles[0]!, saved = profile.embeddingOptions
    const gates = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    const completed: number[] = []
    let inFlight = 0, peak = 0
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((_url, init) => {
      const ordinal = batchOrdinal(init)
      inFlight++; peak = Math.max(peak, inFlight)
      return gates[ordinal]!.promise.then(result => { completed.push(ordinal); return result }).finally(() => { inFlight-- })
    })
    vi.stubGlobal('fetch', fetchMock)
    let pending: Promise<unknown> | undefined
    try {
      Object.defineProperty(profile, 'embeddingOptions', { value: { chunkSize: 100, chunkOverlap: 0, batchSize: 1,
        ...(concurrency === 2 ? { concurrencyLimit: 2 } : {}) }, writable: true, configurable: true })
      const batch = prepareBatchRun(), first = await prepare(randomUUID(), randomUUID(), batch.runId)
      Object.defineProperty(profile, 'embeddingOptions', { value: { chunkSize: 1000, chunkOverlap: 0, batchSize: 1,
        concurrencyLimit: concurrency === 1 ? 2 : 1 }, writable: true, configurable: true })
      pending = importChapter(first, subject, batch.chapterNumber)
      void pending.catch(() => {})
      await waitForBatchStarts(fetchMock, pending, concurrency)
      await Promise.resolve()
      expect(fetchMock).toHaveBeenCalledTimes(concurrency)
      expect(dispatchRows()).toEqual(Array.from({ length: concurrency }, (_, batch_ordinal) => expect.objectContaining({
        batch_ordinal, input_count: 1, state: 'dispatch_marked', settled_at: null,
      })))
      if (concurrency === 1) {
        for (let ordinal = 0; ordinal < 3; ordinal++) {
          await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(ordinal + 1))
          gates[ordinal]!.resolve(batchResponse(ordinal))
        }
      } else {
        gates[1]!.resolve(batchResponse(1))
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
        gates[2]!.resolve(batchResponse(2))
        await vi.waitFor(() => expect(dispatchRows()[2]).toMatchObject({ state: 'response_received' }))
        gates[0]!.resolve(batchResponse(0))
      }
      const result = await pending as { success: boolean; chunkCount: number; docId: string }
      expect(result).toMatchObject({ success: true, chunkCount: 3, docId: expect.any(String) })
      expect(completed).toEqual(concurrency === 1 ? [0, 1, 2] : [1, 2, 0])
      expect(peak).toBe(concurrency)
      expect(fetchMock.mock.calls.map(([url, init]) => ({ url, model: (JSON.parse(String(init.body)) as { model: string }).model })))
        .toEqual([0, 1, 2].map(() => ({ url: 'https://a.invalid/v1/embeddings', model: 'model-a' })))
      expect(dispatchRows()).toEqual([0, 1, 2].map(batch_ordinal => expect.objectContaining({
        batch_ordinal, input_count: 1, state: 'response_received', http_status: 200, settled_at: expect.any(Number),
      })))
      expect(await storedBatchVectors()).toEqual(BATCH_CHUNKS.map((text, chunkIndex) => ({
        chunkIndex, text, vector: [chunkIndex + 1, 0, 0],
      })))
      const canonical = await canonicalBatchRows()
      expect(canonical).toEqual(BATCH_CHUNKS.map((text, chunkIndex) => ({ chunkIndex, text })))
      for (const [index, query] of ['alpha', 'bravo', 'charlie'].entries()) {
        expect(await vectorStore.search(root, query)).toMatchObject([{ text: BATCH_CHUNKS[index] }])
      }
      const documentId = db.prepare('SELECT document_id FROM import_reference_documents').pluck().get() as string
      expect(documentId).toBe(result.docId)
      expect(db.prepare('SELECT run_id, chapter_number, document_id, content_fingerprint, state FROM import_run_knowledge_receipts').all())
        .toEqual([{ run_id: batch.runId, chapter_number: batch.chapterNumber, document_id: result.docId, content_fingerprint: hash(BATCH_CONTENT), state: 'committed' }])
      const integrity = await vectorStore.getDocumentIntegrity(root, documentId)
      expect(integrity).toMatchObject({ complete: true, chunkCount: 3,
        embeddingGenerations: [expect.objectContaining({ complete: true, chunkCount: 3 })] })
      const history = dispatchRows()
      const receipts = db.prepare('SELECT * FROM import_run_knowledge_receipts').all()
      await expect(importChapter(first, subject, batch.chapterNumber)).resolves.toMatchObject({ success: true, idempotent: true })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(dispatchRows()).toEqual(history)
      expect(await canonicalBatchRows()).toEqual(canonical)
      expect(await vectorStore.getDocumentIntegrity(root, documentId)).toEqual(integrity)
      expect(db.prepare('SELECT * FROM import_run_knowledge_receipts').all()).toEqual(receipts)
      expect(count('import_run_knowledge_receipts')).toBe(1)
      expect(count('import_reference_documents')).toBe(1)
    } finally {
      gates.forEach((gate, ordinal) => gate.resolve(batchResponse(ordinal)))
      if (pending) await Promise.allSettled([pending])
      profile.embeddingOptions = saved
    }
  })
  it.each([['http', 0], ['http', 1], ['invalid', 0], ['invalid', 1]] as const)(
    'uses ordinal zero %s outcome even when ordinal %i completes first', async (zeroKind, firstCompleted) => {
      const profile = mock.profiles[0]!, saved = profile.embeddingOptions
      const gates = [deferred<Response>(), deferred<Response>()]
      const kindAt = (ordinal: number) => ordinal === 0 ? zeroKind : zeroKind === 'http' ? 'invalid' : 'http'
      const resultFor = (ordinal: number) => kindAt(ordinal) === 'http' ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 'invalid', 0.3] }] }), { status: 200 })
      const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((_url, init) => gates[batchOrdinal(init)]!.promise)
      vi.stubGlobal('fetch', fetchMock)
      let pending: Promise<unknown> | undefined
      try {
        Object.defineProperty(profile, 'embeddingOptions', { value: { chunkSize: 100, chunkOverlap: 0, batchSize: 1, concurrencyLimit: 2 }, writable: true, configurable: true })
        const batch = prepareBatchRun(), first = await prepare(randomUUID(), randomUUID(), batch.runId)
        pending = importChapter(first, subject, batch.chapterNumber)
        void pending.catch(() => {})
        await waitForBatchStarts(fetchMock, pending, 2)
        gates[firstCompleted]!.resolve(resultFor(firstCompleted))
        await vi.waitFor(() => expect(dispatchRows()[firstCompleted]).toMatchObject({
          state: kindAt(firstCompleted) === 'http' ? 'http_failed' : 'response_invalid', settled_at: expect.any(Number),
        }))
        let settled = false
        void pending.then(() => { settled = true }, () => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        gates[1 - firstCompleted]!.resolve(resultFor(1 - firstCompleted))
        if (zeroKind === 'http') {
          const result = await pending as { success: boolean; chunkCount: number; docId: string }
          expect(result).toMatchObject({ success: true, chunkCount: 3, docId: expect.any(String) })
          expect(db.prepare('SELECT run_id, chapter_number, document_id, content_fingerprint, state FROM import_run_knowledge_receipts').all())
            .toEqual([{ run_id: batch.runId, chapter_number: batch.chapterNumber, document_id: result.docId, content_fingerprint: hash(BATCH_CONTENT), state: 'committed' }])
          expect(db.prepare('SELECT document_id FROM import_reference_documents').pluck().get()).toBe(result.docId)
          expect(await vectorStore.getStats(root)).toMatchObject({ totalChunks: 3, hasVectors: false })
          expect(count('import_run_knowledge_receipts')).toBe(1)
          expect(await canonicalBatchRows()).toEqual(BATCH_CHUNKS.map((text, chunkIndex) => ({ chunkIndex, text })))
          expect(await storedBatchVectors()).toEqual([])
          for (const [index, query] of ['alpha', 'bravo', 'charlie'].entries()) {
            expect(await vectorStore.search(root, query)).toMatchObject([{ text: BATCH_CHUNKS[index] }])
          }
        } else {
          await expect(pending).resolves.toMatchObject({ success: false, errorCode: 'EMBEDDING_RESPONSE_INVALID' })
          expect(await vectorStore.listDocuments(root)).toEqual([])
          expect(count('import_run_knowledge_receipts')).toBe(0)
          expect(await canonicalBatchRows()).toEqual([])
        }
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(dispatchRows()).toEqual([0, 1].map(batch_ordinal => expect.objectContaining({
          batch_ordinal, state: kindAt(batch_ordinal) === 'http' ? 'http_failed' : 'response_invalid', settled_at: expect.any(Number),
        })))
      } finally {
        gates.forEach((gate, ordinal) => gate.resolve(resultFor(ordinal)))
        if (pending) await Promise.allSettled([pending])
        profile.embeddingOptions = saved
      }
    },
  )
  it('revokes two physical batches and drains both without dispatching a third', async () => {
    const profile = mock.profiles[0]!, saved = profile.embeddingOptions
    const runtime = projectRuntimeHost.getActiveView()!
    const gates = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((_url, init) => gates[batchOrdinal(init)]!.promise)
    vi.stubGlobal('fetch', fetchMock)
    let pending: Promise<unknown> | undefined
    let closing: Promise<void> | undefined
    let atClose: { dispatches: unknown[]; receipts: number } | undefined
    const failures: unknown[] = []
    const removeBeforeRelease = projectRuntimeHost.onBeforeRelease(released => {
      if (released !== runtime) return
      atClose = { dispatches: dispatchRows(), receipts: count('import_run_knowledge_receipts') }
      vectorStore.closeConnection(root)
    })
    try {
      Object.defineProperty(profile, 'embeddingOptions', { value: { chunkSize: 100, chunkOverlap: 0, batchSize: 1, concurrencyLimit: 2 }, writable: true, configurable: true })
      const batch = prepareBatchRun(), first = await prepare(randomUUID(), randomUUID(), batch.runId)
      pending = importChapter(first, subject, batch.chapterNumber)
      void pending.catch(() => {})
      await waitForBatchStarts(fetchMock, pending, 2)
      await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
      closing = projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
      let closeSettled = false
      void closing.then(() => { closeSettled = true }, () => { closeSettled = true })
      gates[1]!.resolve(batchResponse(1))
      await vi.waitFor(() => expect(dispatchRows()[1]).toMatchObject({ state: 'response_received', settled_at: expect.any(Number) }))
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(closeSettled).toBe(false)
      expect(runtime.database.open).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(await vectorStore.listDocuments(root)).toEqual([])
      gates[0]!.resolve(batchResponse(0))
      await denied(pending)
      await closing
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(atClose?.dispatches).toEqual([0, 1].map(batch_ordinal => expect.objectContaining({
        batch_ordinal, state: 'response_received', settled_at: expect.any(Number),
      })))
      expect(atClose?.receipts).toBe(0)
      expect(runtime.database.open).toBe(false)
      openCanonicalProjectFixture(root, Buffer.alloc(32, 44))
      const reopened = projectRuntimeHost.getActiveView()!
      expect(reopened.database).not.toBe(runtime.database)
      expect(reopened.databaseIdentity).not.toBe(runtime.databaseIdentity)
      const lease = projectAccess.beginViewSession(reopened)
      session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
      db = reopened.database
      expect(dispatchRows()).toEqual(atClose?.dispatches)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(db.prepare("SELECT COUNT(*) FROM import_reference_documents WHERE state='committed'").pluck().get()).toBe(0)
      expect(await vectorStore.listDocuments(root)).toEqual([])
      expect(await canonicalBatchRows()).toEqual([])
      expect(await storedBatchVectors()).toEqual([])
      expect(await vectorStore.search(root, 'alpha')).toEqual([])
    } catch (error) {
      failures.push(error)
    } finally {
      gates.forEach((gate, ordinal) => gate.resolve(batchResponse(ordinal)))
      if (pending) await Promise.allSettled([pending])
      if (closing) {
        try { await closing } catch (error) { failures.push(error) }
      }
      removeBeforeRelease()
      profile.embeddingOptions = saved
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'FIXTURE_ASSERTION_AND_CLEANUP_FAILED')
  })
  it('cannot reconstruct an issuance from its public reference or operation after native reopen', async () => {
    const operation = randomUUID(), owner = randomUUID()
    const first = await prepare(operation, owner)
    const runtime = projectRuntimeHost.getActiveView()!
    vectorStore.closeConnection(runtime.canonicalRoot)
    await projectRuntimeHost.requestClose(runtime)
    openCanonicalProjectFixture(root, Buffer.alloc(32, 44))
    const reopened = projectRuntimeHost.getActiveView()!
    const lease = projectAccess.beginViewSession(reopened)
    session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
    db = reopened.database
    registerReferenceKnowledgeController()
    await denied(invoke('reference-knowledge:v1:resume', first.reference))
    await denied(importChapter(first))
    await denied(prepare(operation, owner))
    expect(count('reference_import_grants')).toBe(1)
    expect(count('import_run_knowledge_receipts')).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('durably refuses an open budget interval after a native reopen without replaying its request', async () => {
    const gate = deferred<Response>()
    const fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const issuance = await prepare()
    const runtime = projectRuntimeHost.getActiveView()!
    const databasePath = getProjectDatabasePath(root)
    const pending = importChapter(issuance)
    void pending.catch(() => {})
    try {
      await waitForBatchStarts(fetchMock, pending, 1)
      const crashSnapshot = Buffer.from(runtime.database.serialize())
      const atSnapshot = db.prepare('SELECT spent_requests,active_elapsed_ms,active_since_ms,state FROM reference_embedding_budgets').get() as {
        spent_requests: number; active_elapsed_ms: number; active_since_ms: number | null; state: string
      }
      expect(atSnapshot).toMatchObject({ spent_requests: 1, active_elapsed_ms: 0, state: 'ready' })
      expect(atSnapshot.active_since_ms).not.toBeNull()

      gate.resolve(response())
      await expect(pending).resolves.toMatchObject({ success: true })
      vectorStore.closeConnection(runtime.canonicalRoot)
      await projectRuntimeHost.requestClose(runtime)
      fs.writeFileSync(databasePath, crashSnapshot)

      openCanonicalProjectFixture(root, Buffer.alloc(32, 44))
      const reopened = projectRuntimeHost.getActiveView()!
      expect(reopened.database).not.toBe(runtime.database)
      const lease = projectAccess.beginViewSession(reopened)
      session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
      db = reopened.database
      registerReferenceKnowledgeController()
      await expect(prepare()).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_BUDGET_RECOVERY_UNKNOWN')
      expect(db.prepare('SELECT spent_requests,active_elapsed_ms,active_since_ms,state FROM reference_embedding_budgets').get())
        .toMatchObject({ spent_requests: 1, active_elapsed_ms: 0, active_since_ms: atSnapshot.active_since_ms, state: 'recovery_unknown' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(dispatchRows()).toEqual([expect.objectContaining({ state: 'dispatch_marked', settled_at: null })])
      // Isolate the dispatch SQL branch in this disposable fixture; this is not recovery.
      db.prepare("UPDATE reference_embedding_budgets SET state='ready',active_since_ms=NULL").run()
      try {
        expect(db.prepare('SELECT state,active_since_ms FROM reference_embedding_budgets').get())
          .toEqual({ state: 'ready', active_since_ms: null })
        const canRetire = vi.spyOn(ReferenceKnowledgeAuthority.prototype, 'canRetire')
        const beforeGuard = db.prepare('SELECT total_changes()').pluck().get()
        expect(referenceRetirementGuard(reopened)).toBe(false)
        expect(canRetire).toHaveReturnedWith(true)
        expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(beforeGuard)
        canRetire.mockRestore()
      } finally {
        db.prepare("UPDATE reference_embedding_budgets SET state='recovery_unknown',active_since_ms=?").run(atSnapshot.active_since_ms)
      }
      expect(count('import_run_knowledge_receipts')).toBe(0)
    } finally {
      gate.resolve(response())
      await Promise.allSettled([pending])
    }
  })
  it('preserves closed-interval budget consumption across a fresh grant and native reopen', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response()))
    vi.stubGlobal('fetch', fetchMock)
    const first = await prepare()
    await expect(importChapter(first)).resolves.toMatchObject({ success: true })
    await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false))
      .resolves.toMatchObject({ state: 'revoked' })
    const restarted = ImportRunRepository.restart(RUN, `fictional-closed-restart-${randomUUID()}`)
    await prepare(randomUUID(), randomUUID(), restarted.id)
    const beforeClose = db.prepare('SELECT spent_requests,active_elapsed_ms,active_since_ms,state FROM reference_embedding_budgets').get()
    expect(beforeClose).toMatchObject({ spent_requests: 1, active_since_ms: null, state: 'ready' })

    const runtime = projectRuntimeHost.getActiveView()!
    vectorStore.closeConnection(runtime.canonicalRoot)
    await projectRuntimeHost.requestClose(runtime)
    openCanonicalProjectFixture(root, Buffer.alloc(32, 44))
    const reopened = projectRuntimeHost.getActiveView()!
    const lease = projectAccess.beginViewSession(reopened)
    session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
    db = reopened.database
    registerReferenceKnowledgeController()
    await prepare(randomUUID(), randomUUID(), restarted.id)
    expect(db.prepare('SELECT spent_requests,active_elapsed_ms,active_since_ms,state FROM reference_embedding_budgets').get())
      .toEqual(beforeClose)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([['zh-CN', 'response_received'], ['en-US', 'response_received'],
    ['zh-CN', 'transport_unknown'], ['en-US', 'transport_unknown']] as const)(
    'localizes %s after a new grant cannot resend an incomplete %s document', async (locale, state) => {
    db.prepare('UPDATE import_runs SET locale=? WHERE id=?').run(locale, RUN)
    const started = deferred<void>(), finish = deferred<Response>()
    const fetchMock = vi.fn(() => { started.resolve(); return finish.promise })
    vi.stubGlobal('fetch', fetchMock)
    const first = await prepare(), importing = importChapter(first)
    void importing.catch(() => {})
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await started.promise
      await invoke('reference-knowledge:v1:revoke', first.reference, subject, false)
      if (state === 'transport_unknown') finish.reject(new Error('FICTIONAL_TRANSPORT_FAILURE'))
      else finish.resolve(response())
      await denied(importing)
      expect(dispatchRows()).toEqual([expect.objectContaining({
        batch_ordinal: 0, state, http_status: state === 'transport_unknown' ? null : 200, settled_at: expect.any(Number),
      })])
      if (state === 'transport_unknown') {
        expect(db.prepare('SELECT state,active_since_ms FROM reference_embedding_budgets').get())
          .toEqual({ state: 'ready', active_since_ms: null })
        const canRetire = vi.spyOn(ReferenceKnowledgeAuthority.prototype, 'canRetire')
        const beforeGuard = db.prepare('SELECT total_changes()').pluck().get()
        expect(referenceRetirementGuard(projectRuntimeHost.getActiveView()!)).toBe(false)
        expect(canRetire).toHaveReturnedWith(true)
        expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(beforeGuard)
        canRetire.mockRestore()
      }
      const next = await prepare()
      expect(next.reference.grantId).not.toBe(first.reference.grantId)
      expect(count('reference_import_grants')).toBe(2)
      const code = 'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED'
      await expect(importChapter(next)).resolves.toMatchObject({
        success: false, errorCode: code, error: translate(locale, 'error.importRunCheckFailed', { code }),
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(count('reference_embedding_dispatches')).toBe(1)
      expect(await vectorStore.listDocuments(root)).toEqual([])
      expect(await canonicalBatchRows()).toEqual([])
    } finally { finish.resolve(response()); await importing.catch(() => {}) }
  })
  it.each(['zh-CN', 'en-US'] as const)('localizes %s when the real grant writer revokes an issued capability', async locale => {
    const runId = `fictional-revoked-${locale}`
    ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash(`fictional-${locale}`), locale,
      sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: Buffer.byteLength(CONTENT) }],
      chapters: [{ number: 1, title: 'One', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) }] })
    const first = await prepare(randomUUID(), randomUUID(), runId)
    const runtime = projectRuntimeHost.getActiveView()!
    const context = { database: db, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId }
    const grants = new ReferenceImportGrantRepository(db, {
      projectId: runtime.projectId, context,
      assertCurrent: () => projectRuntimeHost.assertOpen(runtime),
      isFrozen: grantId => readPortableRuntimeFreeze(runtime.canonicalRoot).isFrozen('reference_import_grants', grantId),
    })
    const { grantId, revision } = first.reference
    expect(grants.revoke({ grantId, revision, runId }).state).toBe('revoked')
    const code = 'REFERENCE_IMPORT_GRANT_REVISION_CONFLICT'
    await expect(importChapter(first)).resolves.toMatchObject({
      success: false, errorCode: code, error: translate(locale, 'error.importRunCheckFailed', { code }),
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(count('import_reference_documents')).toBe(0)
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })
  it.each(['zh-CN', 'en-US'] as const)('localizes %s when the persisted admission binding does not match', async locale => {
    const runId = `fictional-binding-${locale}`
    ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash(`fictional-binding-${locale}`), locale,
      sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: Buffer.byteLength(CONTENT) }],
      chapters: [{ number: 1, title: 'One', content: CONTENT, contentSize: Buffer.byteLength(CONTENT), contentFingerprint: hash(CONTENT) }] })
    const first = await prepare(randomUUID(), randomUUID(), runId)
    const originalHash = db.prepare('SELECT request_hash FROM reference_import_grants WHERE grant_id=?').pluck().get(first.reference.grantId)
    const mismatchedHash = hash('fictional-corrupt-binding')
    expect(originalHash).not.toBe(mismatchedHash)
    expect(db.prepare('UPDATE reference_import_grants SET request_hash=? WHERE grant_id=?').run(mismatchedHash, first.reference.grantId).changes).toBe(1)
    const code = 'REFERENCE_IMPORT_ADMISSION_REQUEST_MISMATCH'
    await expect(importChapter(first)).resolves.toMatchObject({
      success: false, errorCode: code, error: translate(locale, 'error.importRunCheckFailed', { code }),
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(count('import_reference_documents')).toBe(0)
    expect(count('import_run_knowledge_receipts')).toBe(0)
  })
  it('revokes during a fetch, drains it and forbids late receipt or automatic resume', async () => {
    const started = deferred<void>(), finish = deferred<Response>()
    const fetchMock = vi.fn(() => { started.resolve(); return finish.promise })
    vi.stubGlobal('fetch', fetchMock)
    const baseline = subject.listenerCount('destroyed')
    const first = await prepare(), importing = importChapter(first)
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await started.promise
      await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
      expect(subject.listenerCount('destroyed')).toBe(baseline + 1)
      await denied(invoke('reference-knowledge:v1:resume', first.reference))
      finish.resolve(response()); await denied(importing)
      expect(subject.listenerCount('destroyed')).toBe(baseline)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(db.prepare('SELECT state FROM reference_embedding_dispatches').pluck().all()).toEqual(['response_received'])
    } finally { finish.resolve(response()); await importing.catch(() => {}) }
  })
  it('retains a committed document but forbids the separate receipt after revoke', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const finish = deferred<void>()
    let reached = false
    mock.afterImport = async () => { reached = true; await finish.promise }
    const first = await prepare(), importing = importChapter(first)
    try {
      await vi.waitFor(() => expect(reached).toBe(true))
      expect(db.prepare('SELECT state FROM import_reference_documents').pluck().all()).toEqual(['committed'])
      await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false)).resolves.toMatchObject({ state: 'revoked' })
      finish.resolve(); await denied(importing)
      expect(count('import_reference_documents')).toBe(1)
      expect(count('import_run_knowledge_receipts')).toBe(0)
    } finally { finish.resolve(); await importing.catch(() => {}) }
  })
  it('holds native runtime close until the admitted physical fetch drains', async () => {
    const started = deferred<void>(), finish = deferred<Response>()
    const fetchMock = vi.fn(() => { started.resolve(); return finish.promise })
    vi.stubGlobal('fetch', fetchMock)
    const runtime = projectRuntimeHost.getActiveView()!
    const first = await prepare(), importing = importChapter(first)
    let closing: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await started.promise
      let closed = false
      closing = projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
      void closing.then(() => { closed = true }, () => {})
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(runtime.database.open).toBe(true)
      finish.resolve(response())
      await denied(importing)
      await closing
      expect(runtime.database.open).toBe(false)
    } finally { finish.resolve(response()); await importing.catch(() => {}); await closing?.catch(() => {}) }
  })
  it('fences a held fetch when close cannot persist grant revocation, then retries cleanup', async () => {
    const started = deferred<void>(), finish = deferred<Response>()
    const fetchMock = vi.fn(() => { started.resolve(); return finish.promise })
    vi.stubGlobal('fetch', fetchMock)
    const runtime = projectRuntimeHost.getActiveView()!
    const baseline = subject.listenerCount('destroyed')
    const first = await prepare(), importing = importChapter(first)
    void importing.catch(() => {})
    const failures: unknown[] = []
    let removeBeforeRelease: (() => void) | undefined
    let persistedState: unknown
    let observerError: unknown
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await started.promise
      db.exec("CREATE TEMP TRIGGER fixture_block_grant_revoke BEFORE UPDATE OF state ON reference_import_grants WHEN NEW.state='revoked' BEGIN SELECT RAISE(FAIL, 'fixture-private-grant-error'); END")
      await expect(projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_CLOSE_CLEANUP_FAILED')
      expect(subject.listenerCount('destroyed')).toBe(baseline + 1)
      expect(db.prepare('SELECT state FROM reference_import_grants').pluck().get()).toBe('active')
      expect(runtime.database.open).toBe(true)
      finish.resolve(response())
      await expect(importing).resolves.toMatchObject({ success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED' })
      expect(subject.listenerCount('destroyed')).toBe(baseline + 1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(count('reference_embedding_dispatches')).toBe(1)
      expect(count('import_run_knowledge_receipts')).toBe(0)
      expect(db.prepare("SELECT COUNT(*) FROM import_reference_documents WHERE state='committed'").pluck().get()).toBe(0)
      expect(await vectorStore.listDocuments(root)).toEqual([])
      await expect(projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_CLOSE_CLEANUP_FAILED')
      expect(runtime.database.open).toBe(true)
      expect(db.prepare('SELECT state FROM reference_import_grants').pluck().get()).toBe('active')
      db.exec('DROP TRIGGER fixture_block_grant_revoke')
      removeBeforeRelease = projectRuntimeHost.onBeforeRelease(released => {
        if (released !== runtime) return
        try { persistedState = db.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(first.reference.grantId) }
        catch (error) { observerError = error }
      })
      await projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
      expect(subject.listenerCount('destroyed')).toBe(baseline)
      expect(observerError).toBeUndefined()
      expect(persistedState).toBe('revoked')
      expect(runtime.database.open).toBe(false)
    } catch (error) {
      failures.push(error)
    } finally {
      try { removeBeforeRelease?.() } catch (cleanup) { failures.push(cleanup) }
      try {
        finish.resolve(response())
        await importing.catch(() => {})
        if (runtime.database.open) {
          db.exec('DROP TRIGGER IF EXISTS fixture_block_grant_revoke')
          await projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
        }
      } catch (cleanup) {
        failures.push(cleanup)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'FIXTURE_ASSERTION_AND_CLEANUP_FAILED')
  })
  it.each(['IMPORT_RUN_EXECUTION_STALE', 'EMBEDDING_RESPONSE_INVALID'] as const)('retains sanitized %s and cleanup errors without leaking cleanup detail', async primaryCode => {
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const finish = deferred<void>()
    let reached = false
    mock.afterImport = async () => { reached = true; await finish.promise; throw new Error(primaryCode) }
    const original = ReferenceKnowledgeAuthority.prototype.importChapter
    let captured: unknown
    vi.spyOn(ReferenceKnowledgeAuthority.prototype, 'importChapter').mockImplementation(async function (this: ReferenceKnowledgeAuthority, ...args) {
      try { return await original.apply(this, args) } catch (error) { captured = error; throw error }
    })
    const runtime = projectRuntimeHost.getActiveView()!
    const first = await prepare(), importing = importChapter(first)
    void importing.catch(() => {})
    const failures: unknown[] = []
    try {
      await vi.waitFor(() => expect(reached).toBe(true))
      db.exec("CREATE TEMP TRIGGER fixture_block_cancel BEFORE UPDATE OF cancel_requested ON import_runs WHEN NEW.cancel_requested=1 BEGIN SELECT RAISE(FAIL, 'fixture-private-cancel-error'); END")
      await expect(invoke('reference-knowledge:v1:revoke', first.reference, subject, false)).rejects.toThrow()
      finish.resolve()
      const result = await importing
      expect(result).toMatchObject({ success: false, errorCode: primaryCode })
      if (primaryCode === 'EMBEDDING_RESPONSE_INVALID') {
        expect(result).toMatchObject({ error: expect.stringContaining('retrieval model returned an unusable result') })
      }
      if (!(captured instanceof AggregateError)) throw new Error('EXPECTED_SAFE_AGGREGATE_ERROR')
      expect(captured.message).toBe(primaryCode)
      expect(captured.errors).toHaveLength(2)
      expect(captured.errors.map(error => error instanceof Error ? error.message : '')).toEqual([
        primaryCode, 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED',
      ])
      expect(JSON.stringify(result)).not.toContain('fixture-private-cancel-error')
      expect(captured.errors.map(error => String(error)).join(' ')).not.toContain('fixture-private-cancel-error')
      expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).not.toThrow()
      await expect(projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_CLOSE_CLEANUP_FAILED')
      db.exec('DROP TRIGGER fixture_block_cancel')
      await projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
    } catch (error) {
      failures.push(error)
    } finally {
      try {
        finish.resolve()
        await importing.catch(() => {})
        if (runtime.database.open) {
          db.exec('DROP TRIGGER IF EXISTS fixture_block_cancel')
          await projectRuntimeHost.requestClose(runtime, { timeoutMs: 5000 })
        }
      } catch (cleanup) {
        failures.push(cleanup)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'FIXTURE_ASSERTION_AND_CLEANUP_FAILED')
  })
})
