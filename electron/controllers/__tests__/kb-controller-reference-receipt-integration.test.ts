import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportRunExecutionAuthority, ImportRunPrepareRequest } from '../../../src/shared/import-run'
import type { ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { ReferenceKnowledgeReference } from '../../../src/shared/reference-knowledge-contract'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
type ReferenceImportResult = { success: boolean; docId?: string; error?: string }
type ReferenceImportArgs = [
  content: string, fileName: string, stableKey: string, chapterNumber: number,
  runId: string, authority: ImportRunExecutionAuthority, projectPath: string,
  protocol: string, model: unknown, resources?: unknown, admission?: unknown,
]
type ReferenceKnowledgeModule = {
  captureReferenceImportResources: (runtime: unknown) => unknown
  importReferenceText: (...args: ReferenceImportArgs) => Promise<ReferenceImportResult>
}

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  run: vi.fn<(operation: (kb: ReferenceKnowledgeModule) => unknown) => Promise<unknown>>(),
  load: vi.fn<() => Promise<ReferenceKnowledgeModule>>(),
  importReferenceText: vi.fn<(...args: ReferenceImportArgs) => Promise<ReferenceImportResult>>(),
  unexpectedDialog: vi.fn(() => { throw new Error('Unexpected dialog in reference receipt fixture') }),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US', isPackaged: false },
  dialog: { showOpenDialog: mocks.unexpectedDialog },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))

vi.mock('../../utils/config-utils', () => ({
  readJsonFile: (_file: string, fallback: unknown) => fallback,
  GLOBAL_CONFIG_PATH: 'fictional-global.json',
  DEFAULT_GLOBAL_CONFIG: { defaultModelId: null, defaultEmbeddingModelId: null },
  MODELS_CONFIG_PATH: 'fictional-models.json',
}))

vi.mock('../../utils/remembered-dialog', () => ({
  showOpenDialogInLastDirectory: mocks.unexpectedDialog,
}))

vi.mock('../../i18n', () => ({
  mainText: (_locale: string, _zh: string, en: string) => en,
  getMainLocale: () => 'en-US',
}))

vi.mock('../../services/knowledge-base-loader', () => ({
  knowledgeBaseLoader: { run: mocks.run, load: mocks.load },
}))

import { createProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { registerKBController } from '../kb-controller'
import { registerReferenceKnowledgeController } from '../reference-knowledge-controller'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const RUN_ID = 'reference-receipt-run'
const CONTENT = 'A fictional courier waits at the harbor with a sealed letter.'
const CONTENT_HASH = digest(CONTENT)
const secret = Buffer.alloc(32, 44)
const request: ImportRunPrepareRequest = {
  runId: RUN_ID, purpose: 'reference', sourceFingerprint: digest('fictional-source'), locale: 'en-US',
  sourceDisplay: [{ displayName: 'fictional-reference.txt', mediaType: 'text/plain', size: CONTENT.length }],
  chapters: [{ number: 1, title: 'One', content: CONTENT, contentSize: CONTENT.length, contentFingerprint: CONTENT_HASH }],
}

let parent = ''
let tempBase = ''
let root = ''
let database: NonNullable<ReturnType<typeof getProjectDb>>
let session: ProjectSessionContext
const sender = Object.assign(new EventEmitter(), { id: 55, isDestroyed: () => false })
type PreparedReference = { reference: ReferenceKnowledgeReference; execution: ImportRunExecutionAuthority }

// Only the KB document effect is stubbed; the registered handler and receipt transaction stay real.
function writeCommittedDocument(content: string, stableKey: string): ReferenceImportResult {
  const docId = digest(`reference-import:${stableKey}`)
  database.prepare(`
    INSERT INTO import_reference_documents (
      document_id, idempotency_key_hash, content_hash, chunk_set_hash,
      expected_chunk_count, corpus_kind, state
    ) VALUES (?, ?, ?, ?, 1, 'reference', 'committed')
    ON CONFLICT(document_id) DO NOTHING
  `).run(docId, digest(stableKey), digest(content), digest('fictional-chunks:1'))
  return { success: true, docId }
}

function invokeLegacyReference(authority: ImportRunExecutionAuthority, context: ProjectSessionContext = session): Promise<unknown> {
  const handler = mocks.handlers.get('kb:import-reference-text')
  if (!handler) throw new Error('Reference import handler was not registered')
  return handler({ sender: { id: 55 } }, 1, RUN_ID, authority, context)
}

async function prepareManagedReference(): Promise<PreparedReference> {
  const handler = mocks.handlers.get('reference-knowledge:v1:prepare')
  if (!handler) throw new Error('Managed reference prepare handler was not registered')
  return await handler({ sender }, { operationId: randomUUID(), runId: RUN_ID,
    executionOwner: randomUUID() }, session) as PreparedReference
}

function invokeManagedReference(prepared: PreparedReference, context: ProjectSessionContext = session): Promise<unknown> {
  const handler = mocks.handlers.get('reference-knowledge:v1:import')
  if (!handler) throw new Error('Managed reference import handler was not registered')
  return handler({ sender }, { reference: prepared.reference, chapterNumber: 1,
    execution: { owner: prepared.execution.owner, epoch: prepared.execution.epoch } }, context)
}

function startLegacyRun(): ImportRunExecutionAuthority {
  const started = ImportRunRepository.startOrResume(RUN_ID, `fictional-renderer-${randomUUID()}`, Date.now(), 60_000)
  return { owner: started.execution.owner, epoch: started.execution.epoch }
}

function expectNoReceipt(): void {
  expect(database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(0)
}

function otherProject() {
  const project = projectAccess.createProject(parent, 'B')
  createProjectDatabase(project.rootPath, secret)
  return project
}

function verifiedCleanupRoot(): string {
  const assertChild = (base: string, child: string) => {
    const relative = path.relative(base, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
    }
  }
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const absoluteRoot = path.resolve(parent)
  assertChild(tempBase, absoluteRoot)
  if (!path.basename(absoluteRoot).startsWith('pk-kb-')) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  for (let directory = absoluteRoot; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error('FICTIONAL_CLEANUP_LINK')
    }
    if (normalized(directory) === normalized(tempBase)) break
  }
  const realRoot = fs.realpathSync.native(absoluteRoot)
  assertChild(fs.realpathSync.native(tempBase), realRoot)
  const pending = [absoluteRoot]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const realTarget = fs.realpathSync.native(target)
      if (fs.lstatSync(target).isSymbolicLink() || normalized(realTarget) !== normalized(target)) {
        throw new Error('FICTIONAL_CLEANUP_LINK')
      }
      assertChild(realRoot, realTarget)
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return absoluteRoot
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.run.mockReset()
  mocks.load.mockReset()
  mocks.importReferenceText.mockReset()
  mocks.unexpectedDialog.mockClear()
  // Keep the fictional native-storage fixture below the production Windows path limit.
  tempBase = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(tempBase, 'pk-kb-'))
  const project = projectAccess.createProject(parent, 'A')
  const lease = projectAccess.beginSession(project)
  root = lease.rootPath
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
  openCanonicalProjectFixture(root, secret)
  database = getProjectDb()!
  ImportRunRepository.prepare(request)
  mocks.importReferenceText.mockImplementation(async (content, _fileName, stableKey) => writeCommittedDocument(content, stableKey))
  mocks.run.mockImplementation(async operation => operation({
    captureReferenceImportResources: () => undefined,
    importReferenceText: (...args) => mocks.importReferenceText(...args),
  }))
  mocks.load.mockImplementation(async () => {
    const knowledgeBase = await import('../../knowledge-base')
    return {
      ...knowledgeBase,
      captureReferenceImportResources: (runtime: unknown) => knowledgeBase.captureReferenceImportResources(
        runtime as Parameters<typeof knowledgeBase.captureReferenceImportResources>[0],
      ),
      importReferenceText: (...args: ReferenceImportArgs) => mocks.importReferenceText(...args),
    }
  })
  registerKBController()
  registerReferenceKnowledgeController()
})

afterEach(() => {
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) projectRuntimeHost.releaseIdle(runtime)
  projectAccess.invalidateCurrentSession()
  if (parent) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  parent = ''
})

describe('registered reference-import handler with real SQLite receipts and runtime guards', () => {
  it('commits the managed document receipt and replays it without duplicating either row', async () => {
    const prepared = await prepareManagedReference()
    const binding = ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, prepared.execution, 1)
    const docId = digest(`reference-import:${binding.stableKey}`)

    await expect(invokeManagedReference(prepared)).resolves.toMatchObject({ success: true, docId })
    await expect(invokeManagedReference(prepared)).resolves.toMatchObject({ success: true, docId })

    expect(mocks.importReferenceText).toHaveBeenCalledTimes(2)
    expect(mocks.importReferenceText).toHaveBeenCalledWith(
      CONTENT, expect.any(String), binding.stableKey, 1, RUN_ID, prepared.execution, root, 'openai',
      { provider: '', baseUrl: '', apiKey: '',
        embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50, concurrencyLimit: 1 } },
      expect.any(Object), expect.any(Object),
    )
    expect(database.prepare('SELECT COUNT(*) FROM reference_embedding_budgets').pluck().get()).toBe(1)
    expect(database.prepare('SELECT COUNT(*) FROM reference_import_grants').pluck().get()).toBe(1)
    expect(database.prepare(`
      SELECT run_id, chapter_number, purpose, content_fingerprint, document_id, state
      FROM import_run_knowledge_receipts
    `).all()).toEqual([{
      run_id: RUN_ID, chapter_number: 1, purpose: 'reference', content_fingerprint: CONTENT_HASH,
      document_id: docId, state: 'committed',
    }])
    expect(database.prepare(`
      SELECT document_id, idempotency_key_hash, content_hash, chunk_set_hash, expected_chunk_count, corpus_kind, state
      FROM import_reference_documents
    `).all()).toEqual([{
      document_id: docId, idempotency_key_hash: digest(binding.stableKey), content_hash: CONTENT_HASH,
      chunk_set_hash: digest('fictional-chunks:1'), expected_chunk_count: 1, corpus_kind: 'reference', state: 'committed',
    }])
    expect(mocks.unexpectedDialog).not.toHaveBeenCalled()
  })

  it('rejects a different valid SHA256 document id even when the bound document is committed', async () => {
    const prepared = await prepareManagedReference()
    const wrongId = digest('different-fictional-document')
    mocks.importReferenceText.mockImplementationOnce(async (content, _fileName, stableKey) => {
      const committed = writeCommittedDocument(content, stableKey)
      expect(committed.docId).not.toBe(wrongId)
      return { success: true, docId: wrongId }
    })

    await expect(invokeManagedReference(prepared)).resolves.toMatchObject({
      success: false, errorCode: 'IMPORT_RUN_REFERENCE_DOCUMENT_INCOMPLETE',
    })
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(1)
  })

  it('does not create a receipt for a failed knowledge import', async () => {
    const prepared = await prepareManagedReference()
    mocks.importReferenceText.mockResolvedValueOnce({ success: false, error: 'Fictional knowledge import failed.' })
    await expect(invokeManagedReference(prepared)).resolves.toMatchObject({
      success: false, errorCode: 'KNOWLEDGE_BASE_REFERENCE_OPERATION_FAILED',
    })
    expect(mocks.importReferenceText).toHaveBeenCalledOnce()
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('does not create a receipt when the loader is unavailable', async () => {
    mocks.load.mockRejectedValueOnce(new Error('KNOWLEDGE_BASE_NATIVE_UNAVAILABLE'))
    await expect(prepareManagedReference()).rejects.toThrow(
      'The knowledge base is unavailable because its Windows native component could not be loaded. Reinstall or download the complete release package.',
    )
    expect(mocks.load).toHaveBeenCalledOnce()
    expect(mocks.importReferenceText).not.toHaveBeenCalled()
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM reference_embedding_budgets').pluck().get()).toBe(0)
    expect(database.prepare('SELECT COUNT(*) FROM reference_import_grants').pluck().get()).toBe(0)
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('preserves a thrown KB import failure without creating a receipt', async () => {
    const prepared = await prepareManagedReference()
    mocks.importReferenceText.mockRejectedValueOnce(new Error('EMBEDDING_FICTIONAL_FAILURE'))
    await expect(invokeManagedReference(prepared)).resolves.toMatchObject({
      success: false, errorCode: 'EMBEDDING_FICTIONAL_FAILURE',
    })
    expect(mocks.importReferenceText).toHaveBeenCalledOnce()
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('holds the managed interlock while KB import awaits and commits only to A after release', async () => {
    const other = otherProject()
    const prepared = await prepareManagedReference()
    let resume!: () => void
    const resumed = new Promise<void>(resolve => { resume = resolve })
    mocks.importReferenceText.mockImplementationOnce(async (content, _fileName, stableKey) => {
      await resumed
      return writeCommittedDocument(content, stableKey)
    })
    const pending = invokeManagedReference(prepared)
    try {
      await vi.waitFor(() => expect(mocks.importReferenceText).toHaveBeenCalledOnce())
      expect(() => projectRuntimeHost.prepareOpen(other)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
      expect(projectRuntimeHost.getActiveView()?.database).toBe(database)
      expectNoReceipt()
    } finally {
      resume()
      await pending
    }
    await expect(pending).resolves.toMatchObject({ success: true })
    expect(database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(1)
    const runtimeB = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(other))
    expect(runtimeB.database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(0)
    expect(runtimeB.database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('refuses a retained two-runtime legacy call before loading KB and leaves both native databases unchanged', async () => {
    const authority = startLegacyRun()
    const runtimeA = projectRuntimeHost.getActiveView()!
    const runtimeB = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(otherProject()))
    const lease = projectAccess.beginViewSession(runtimeA)
    const context = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
    const beforeA = digest(runtimeA.database.serialize())
    const beforeB = digest(runtimeB.database.serialize())

    await expect(invokeLegacyReference(authority, context)).rejects.toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.importReferenceText).not.toHaveBeenCalled()
    expect(digest(runtimeA.database.serialize())).toBe(beforeA)
    expect(digest(runtimeB.database.serialize())).toBe(beforeB)
    expect(projectRuntimeHost.getActiveView()).toBe(runtimeA)
  })

  it.each(['started', 'managed-budget'] as const)('rejects legacy import after %s without loading KB or writing a receipt', async state => {
    const execution = state === 'started' ? startLegacyRun() : (await prepareManagedReference()).execution
    mocks.run.mockClear()
    mocks.load.mockClear()
    mocks.importReferenceText.mockClear()
    const before = database.serialize()

    await expect(invokeLegacyReference(execution)).resolves.toMatchObject({
      success: false, errorCode: 'IMPORT_RUN_REFERENCE_UNBOUND',
    })
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.importReferenceText).not.toHaveBeenCalled()
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
    expect(database.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
    expect(database.serialize()).toEqual(before)
    expect(database.prepare('SELECT COUNT(*) FROM reference_embedding_budgets').pluck().get()).toBe(state === 'started' ? 0 : 1)
    expect(database.prepare('SELECT COUNT(*) FROM reference_import_grants').pluck().get()).toBe(state === 'started' ? 0 : 1)
  })
})
