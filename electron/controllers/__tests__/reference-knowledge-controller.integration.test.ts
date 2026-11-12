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
import { ReferenceImportGrantRepository } from '../../repositories/reference-import-grant-repository'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
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
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function response() { return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }) }
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
function importChapter(value: Prepared, who = subject): Promise<unknown> {
  return invoke('reference-knowledge:v1:import', { reference: value.reference, chapterNumber: 1,
    execution: { owner: value.execution.owner, epoch: value.execution.epoch } }, who)
}
async function denied(operation: Promise<unknown>): Promise<void> {
  let result: unknown
  try { result = await operation } catch (error) { expect(error).toBeInstanceOf(Error); return }
  expect(result).toMatchObject({ success: false })
}
function count(table: string): number { return Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()) }

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
  registerReferenceKnowledgeController(); registerKBController(); registerDatabaseController()
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
    // Seed a later-stage resumable run; this test exercises issuance ownership, not stage progression.
    db.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(RUN)
    const first = await prepare()
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
  it.each(['zh-CN', 'en-US'] as const)('localizes %s after a new grant cannot resend an incomplete document', async locale => {
    db.prepare('UPDATE import_runs SET locale=? WHERE id=?').run(locale, RUN)
    const started = deferred<void>(), finish = deferred<Response>()
    const fetchMock = vi.fn(() => { started.resolve(); return finish.promise })
    vi.stubGlobal('fetch', fetchMock)
    const first = await prepare(), importing = importChapter(first)
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await started.promise
      await invoke('reference-knowledge:v1:revoke', first.reference, subject, false)
      finish.resolve(response()); await denied(importing)
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
