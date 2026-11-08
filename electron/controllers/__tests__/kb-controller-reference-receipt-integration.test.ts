import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportRunExecutionAuthority, ImportRunPrepareRequest } from '../../../src/shared/import-run'
import type { ProjectSessionContext } from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
type ReferenceImportResult = { success: boolean; docId?: string; error?: string }
type ReferenceImportArgs = [
  content: string, fileName: string, stableKey: string, chapterNumber: number,
  runId: string, authority: ImportRunExecutionAuthority, projectPath: string,
  protocol: string, model: unknown,
]
type ReferenceKnowledgeModule = {
  importReferenceText: (...args: ReferenceImportArgs) => Promise<ReferenceImportResult>
}

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  run: vi.fn<(operation: (kb: ReferenceKnowledgeModule) => unknown) => Promise<unknown>>(),
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
  knowledgeBaseLoader: { run: mocks.run },
}))

import { createProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { registerKBController } from '../kb-controller'

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
let authority: ImportRunExecutionAuthority

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

function invokeReference(context: ProjectSessionContext = session): Promise<unknown> {
  const handler = mocks.handlers.get('kb:import-reference-text')
  if (!handler) throw new Error('Reference import handler was not registered')
  return handler({ sender: { id: 55 } }, 1, RUN_ID, authority, context)
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
  const started = ImportRunRepository.startOrResume(RUN_ID, 'fictional-renderer', Date.now(), 60_000)
  authority = { owner: started.execution.owner, epoch: started.execution.epoch }
  mocks.importReferenceText.mockImplementation(async (content, _fileName, stableKey) => writeCommittedDocument(content, stableKey))
  mocks.run.mockImplementation(async operation => operation({ importReferenceText: mocks.importReferenceText }))
  registerKBController()
})

afterEach(() => {
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) projectRuntimeHost.releaseIdle(runtime)
  projectAccess.invalidateCurrentSession()
  if (parent) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  parent = ''
})

describe('registered reference-import handler with real SQLite receipts and runtime guards', () => {
  it('commits the real document receipt and replays it without duplicating either row', async () => {
    const binding = ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, authority, 1)
    const docId = digest(`reference-import:${binding.stableKey}`)

    await expect(invokeReference()).resolves.toEqual({ success: true, docId })
    await expect(invokeReference()).resolves.toEqual({ success: true, docId })

    expect(mocks.importReferenceText).toHaveBeenCalledTimes(2)
    expect(mocks.importReferenceText).toHaveBeenCalledWith(
      CONTENT, expect.any(String), binding.stableKey, 1, RUN_ID, authority, root, 'openai',
      { provider: '', baseUrl: '', apiKey: '' },
    )
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
    const wrongId = digest('different-fictional-document')
    mocks.importReferenceText.mockImplementationOnce(async (content, _fileName, stableKey) => {
      const committed = writeCommittedDocument(content, stableKey)
      expect(committed.docId).not.toBe(wrongId)
      return { success: true, docId: wrongId }
    })

    await expect(invokeReference()).resolves.toMatchObject({
      success: false, errorCode: 'IMPORT_RUN_REFERENCE_DOCUMENT_INCOMPLETE',
    })
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(1)
  })

  it('does not create a receipt for a failed knowledge import', async () => {
    mocks.importReferenceText.mockResolvedValueOnce({ success: false, error: 'Fictional knowledge import failed.' })
    await expect(invokeReference()).resolves.toEqual({ success: false, error: 'Fictional knowledge import failed.' })
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('does not create a receipt when the loader is unavailable', async () => {
    mocks.run.mockResolvedValueOnce({ success: false, errorCode: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' })
    await expect(invokeReference()).resolves.toEqual({ success: false, errorCode: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' })
    expect(mocks.importReferenceText).not.toHaveBeenCalled()
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('preserves a thrown loader failure without creating a receipt', async () => {
    mocks.run.mockRejectedValueOnce(new Error('Fictional loader failed.'))
    await expect(invokeReference()).rejects.toThrow('Fictional loader failed.')
    expect(mocks.importReferenceText).not.toHaveBeenCalled()
    expectNoReceipt()
    expect(database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('holds the actual legacy interlock while the loader awaits and commits only to A after release', async () => {
    const other = otherProject()
    let resume!: () => void
    const resumed = new Promise<void>(resolve => { resume = resolve })
    mocks.importReferenceText.mockImplementationOnce(async (content, _fileName, stableKey) => {
      await resumed
      return writeCommittedDocument(content, stableKey)
    })
    const pending = invokeReference()
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

  it('refuses a retained two-runtime call before loading KB and leaves both native databases unchanged', async () => {
    const runtimeA = projectRuntimeHost.getActiveView()!
    const runtimeB = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(otherProject()))
    const lease = projectAccess.beginViewSession(runtimeA)
    const context = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
    const beforeA = digest(runtimeA.database.serialize())
    const beforeB = digest(runtimeB.database.serialize())

    await expect(invokeReference(context)).rejects.toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.importReferenceText).not.toHaveBeenCalled()
    expect(digest(runtimeA.database.serialize())).toBe(beforeA)
    expect(digest(runtimeB.database.serialize())).toBe(beforeB)
    expect(projectRuntimeHost.getActiveView()).toBe(runtimeA)
  })
})
