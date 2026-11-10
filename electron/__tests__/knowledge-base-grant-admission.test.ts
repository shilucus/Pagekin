import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import type { ReferenceImportGrantRef } from '../../src/shared/reference-import-grant'
import { getProjectDb } from '../database'
import { captureReferenceImportResources, importReferenceText } from '../knowledge-base'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { ReferenceImportGrantRepository } from '../repositories/reference-import-grant-repository'
import { captureReferenceImportAdmission } from '../services/reference-import-admission'
import { readPortableRuntimeFreeze } from '../services/portable-runtime-freeze'
import { projectRuntimeHost } from '../services/project-runtime'
import { withLegacyProjectOperation } from '../services/project-runtime-compatibility'
import * as store from '../vector-store'

const RUN = 'fictional-grant-reference'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const requestHash = hash('fictional-frozen-reference-request')
const ftsModel = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const embeddingModel = { ...ftsModel, baseUrl: 'https://embedding.example/v1', apiKey: 'fictional-key', modelName: 'embedding' }
let temporaryParent = ''
let parent = ''

function book(name: string) {
  const root = path.join(parent, name)
  fs.mkdirSync(root)
  openCanonicalProjectFixture(root)
  const runtime = projectRuntimeHost.getActiveView()!
  const content = `Fictional ${name} courier waits beside a harbor.`
  ImportRunRepository.prepare({ runId: RUN, purpose: 'reference', sourceFingerprint: hash(`source:${name}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'One', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  const grants = new ReferenceImportGrantRepository(runtime.database, { projectId: runtime.projectId, context: runtime,
    assertCurrent: () => { projectRuntimeHost.assertOpen(runtime) },
    isFrozen: id => readPortableRuntimeFreeze(root).isFrozen('reference_import_grants', id) })
  const scope = ImportRunRepository.captureReferenceGrantScope(RUN, runtime)
  const grant = grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), runId: RUN,
    manifestFingerprint: scope.manifestFingerprint, requestHash })
  const ref = { grantId: grant.grantId, revision: grant.revision, runId: RUN }
  const execution = ImportRunRepository.startOrResume(RUN, 'fictional-owner', Date.now(), 60_000, runtime).execution
  const authority = { owner: execution.owner, epoch: execution.epoch }
  const binding = ImportRunRepository.resolveReferenceImportAuthority(RUN, authority, 1, undefined, runtime.database)
  return { root, runtime, content, grants, grant, ref, execution, authority, binding,
    resources: captureReferenceImportResources(runtime), admission: captureReferenceImportAdmission(runtime, ref, requestHash) }
}

type Book = ReturnType<typeof book>
type Admission = ReturnType<typeof captureReferenceImportAdmission>
let a: Book
let b: Book
let beforeB: string

function importBook(value: Book, options: {
  admission?: Admission
  resources?: Book['resources']
  authority?: Book['authority']
  runId?: string
  model?: typeof ftsModel
} = {}) {
  return importReferenceText(value.content, 'Chapter 1.txt', value.binding.stableKey, 1, options.runId ?? RUN,
    options.authority ?? value.authority, value.root, 'openai', options.model ?? ftsModel,
    options.resources ?? value.resources, options.admission ?? value.admission)
}

function documentId(value: Book): string { return hash(`reference-import:${value.binding.stableKey}`) }
function documentRows(value: Book) { return value.runtime.database.prepare('SELECT * FROM import_reference_documents ORDER BY document_id').all() }
function knowledgeRows(value: Book) { return value.runtime.database.prepare('SELECT * FROM import_run_knowledge_receipts ORDER BY chapter_number').all() }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function embeddingResponse() {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function holdEmbedding() {
  const started = deferred<void>(), finish = deferred<Response>()
  const fetch = vi.fn(() => { started.resolve(); return finish.promise })
  vi.stubGlobal('fetch', fetch)
  return { started: started.promise, finish: () => finish.resolve(embeddingResponse()), fetch }
}

async function expectBUnchanged() {
  expect(hash(b.runtime.database.serialize())).toBe(beforeB)
  await expect(store.listDocuments(b.root)).resolves.toEqual([])
  expect(getProjectDb()).toBe(b.runtime.database)
}

function verifiedCleanupRoot(): string {
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const assertChild = (base: string, child: string) => {
    const relative = path.relative(base, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('FICTIONAL_GRANT_KB_CLEANUP_OUTSIDE_BASE')
  }
  const root = path.resolve(parent)
  assertChild(temporaryParent, root)
  if (normalized(path.dirname(root)) !== normalized(temporaryParent) || !path.basename(root).startsWith('pk-kb-grant-')) throw new Error('FICTIONAL_GRANT_KB_CLEANUP_OUTSIDE_BASE')
  for (const directory of [temporaryParent, root]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) throw new Error('FICTIONAL_GRANT_KB_CLEANUP_LINK')
  }
  const realRoot = fs.realpathSync.native(root)
  assertChild(fs.realpathSync.native(temporaryParent), realRoot)
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name), stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() || normalized(fs.realpathSync.native(target)) !== normalized(target)) throw new Error('FICTIONAL_GRANT_KB_CLEANUP_LINK')
      assertChild(realRoot, fs.realpathSync.native(target))
      if (stat.isDirectory()) pending.push(target)
    }
  }
  return root
}

beforeEach(async () => {
  temporaryParent = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(temporaryParent, 'pk-kb-grant-'))
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('FICTIONAL_GRANT_KB_NETWORK_FORBIDDEN') }))
  a = book('A')
  b = book('B')
  await store.listDocuments(b.root)
  beforeB = hash(b.runtime.database.serialize())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    store.closeConnection(runtime.canonicalRoot)
    projectRuntimeHost.releaseIdle(runtime)
  }
  if (parent) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  parent = ''
})

describe('actual reference knowledge grant admission', () => {
  it('imports real FTS/Lance A with B active and replays the same document only under its active grant', async () => {
    const imported = await importBook(a)
    expect(imported).toMatchObject({ success: true, idempotent: false, docId: documentId(a), chunkCount: 1 })
    expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'committed', content_hash: hash(a.content) })])
    a.admission.withTransaction(a.resources, RUN, () => ImportRunRepository.commitReferenceImportReceipt(RUN, a.authority, 1, imported.docId!, a.runtime.database))
    await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: true, docId: imported.docId })
    a.admission.withTransaction(a.resources, RUN, () => ImportRunRepository.commitReferenceImportReceipt(RUN, a.authority, 1, imported.docId!, a.runtime.database))
    expect(knowledgeRows(a)).toEqual([expect.objectContaining({ document_id: imported.docId, state: 'committed' })])
    await expect(store.getDocumentIntegrity(a.root, imported.docId!)).resolves.toMatchObject({ complete: true, corpusKind: 'reference', chunkCount: 1 })
    expect(fetch).not.toHaveBeenCalled()
    const documents = documentRows(a), receipts = knowledgeRows(a)
    a.grants.revoke(a.ref)
    await expect(importBook(a)).resolves.toMatchObject({ success: false })
    expect(() => a.admission.withTransaction(a.resources, RUN, () => ImportRunRepository.commitReferenceImportReceipt(RUN, a.authority, 1, imported.docId!, a.runtime.database)))
      .toThrow('REFERENCE_IMPORT_GRANT_REVISION_CONFLICT')
    expect(documentRows(a)).toEqual(documents)
    expect(knowledgeRows(a)).toEqual(receipts)
    await expectBUnchanged()
  })

  it.each(['revoked', 'revision', 'hash', 'run', 'resources'] as const)('denies %s admission before any KB effect', async mismatch => {
    const beforeA = hash(a.runtime.database.serialize())
    if (mismatch === 'revoked') {
      a.grants.revoke(a.ref)
      expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash)).toThrow('REFERENCE_IMPORT_GRANT_REVISION_CONFLICT')
      await expect(importBook(a)).resolves.toMatchObject({ success: false })
    } else if (mismatch === 'revision') {
      expect(() => captureReferenceImportAdmission(a.runtime, { ...a.ref, revision: a.ref.revision + 1 }, requestHash)).toThrow()
    } else if (mismatch === 'hash') {
      expect(() => captureReferenceImportAdmission(a.runtime, a.ref, hash('different-fictional-request'))).toThrow()
    } else if (mismatch === 'run') {
      await expect(importBook(a, { runId: 'different-fictional-run' })).resolves.toMatchObject({ success: false })
    } else {
      await expect(importBook(b, { admission: a.admission })).resolves.toMatchObject({ success: false })
    }
    if (mismatch !== 'revoked') expect(hash(a.runtime.database.serialize())).toBe(beforeA)
    expect(documentRows(a)).toEqual([])
    expect(knowledgeRows(a)).toEqual([])
    expect(fs.existsSync(path.join(a.runtime.projectStorageRoot, 'lancedb'))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    await expectBUnchanged()
  })

  it('rejects a copied non-host runtime rather than reconstructing admission from its fields', () => {
    expect(() => captureReferenceImportAdmission({ ...a.runtime }, a.ref, requestHash)).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(documentRows(a)).toEqual([])
    expect(knowledgeRows(a)).toEqual([])
  })

  it('discards a held embedding when its actual grant is revoked without borrowing active B authority', async () => {
    const held = holdEmbedding(), pending = importBook(a, { model: embeddingModel })
    try {
      await held.started
      a.grants.revoke(a.ref)
      held.finish()
      await expect(pending).resolves.toMatchObject({ success: false })
      expect(held.fetch).toHaveBeenCalledTimes(1)
      expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
      expect(knowledgeRows(a)).toEqual([])
      await expect(store.listDocuments(a.root)).resolves.toEqual([])
      await expectBUnchanged()
    } finally { held.finish(); await pending }
  })

  it.each(['initial-integrity', 'vector-write', 'committed-integrity'] as const)('refuses final success after revoke during %s and cleans any admitted vector write', async boundary => {
    if (boundary === 'vector-write') {
      const actual = store.addChunks
      vi.spyOn(store, 'addChunks').mockImplementation(async (...args) => {
        const result = await actual(...args)
        a.grants.revoke(a.ref)
        return result
      })
    } else {
      const actual = store.getDocumentIntegrity
      let reads = 0
      vi.spyOn(store, 'getDocumentIntegrity').mockImplementation(async (...args) => {
        const result = await actual(...args)
        reads += 1
        if (reads === (boundary === 'initial-integrity' ? 1 : 2)) a.grants.revoke(a.ref)
        return result
      })
    }
    await expect(importBook(a)).resolves.toMatchObject({ success: false })
    expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
    expect(knowledgeRows(a)).toEqual([])
    await expect(store.listDocuments(a.root)).resolves.toEqual([])
    await expectBUnchanged()
  })

  it('checks the real grant and every prepare/commit/replay SQL write synchronously inside native transactions', async () => {
    const db = a.runtime.database, trace: string[] = []
    const actual = ReferenceImportGrantRepository.prototype.assertActive
    vi.spyOn(ReferenceImportGrantRepository.prototype, 'assertActive').mockImplementation(function (this: ReferenceImportGrantRepository, ref: ReferenceImportGrantRef) {
      const result = actual.call(this, ref)
      if (ref.grantId === a.ref.grantId) {
        expect(db.inTransaction).toBe(true)
        trace.push('grant')
      }
      return result
    })
    db.function('fictional_require_grant_transaction', (state: string) => {
      if (!db.inTransaction || trace.at(-1) !== 'grant') throw new Error('FICTIONAL_GRANT_KB_TRANSACTION_MISSING')
      trace.push(`write:${state}`)
      return 1
    })
    db.exec(`CREATE TEMP TRIGGER fictional_grant_insert BEFORE INSERT ON import_reference_documents
      BEGIN SELECT fictional_require_grant_transaction(NEW.state); END;
      CREATE TEMP TRIGGER fictional_grant_update BEFORE UPDATE ON import_reference_documents
      BEGIN SELECT fictional_require_grant_transaction(NEW.state); END;`)
    await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: false })
    await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: true })
    expect(trace.filter(value => value === 'write:prepared').length).toBeGreaterThanOrEqual(1)
    expect(trace.filter(value => value === 'write:committed')).toHaveLength(2)
    await expectBUnchanged()
  })

  it.each(['preparation', 'commit', 'replay'] as const)('rolls back a SQL-trigger revocation and its %s write in the same guarded transaction', async boundary => {
    if (boundary === 'replay') await expect(importBook(a)).resolves.toMatchObject({ success: true })
    const before = documentRows(a)
    const mutation = boundary === 'preparation' ? 'INSERT' : 'UPDATE'
    a.runtime.database.exec(`CREATE TEMP TRIGGER fictional_revoke_reference BEFORE ${mutation} ON import_reference_documents
      ${boundary === 'preparation' ? '' : "WHEN NEW.state='committed'"} BEGIN
        UPDATE reference_import_grants SET state='revoked',revision=revision+1,revoked_at=1 WHERE grant_id='${a.ref.grantId}'; END;`)
    await expect(importBook(a)).resolves.toMatchObject({ success: false, error: 'REFERENCE_IMPORT_GRANT_REVISION_CONFLICT' })
    expect(a.grants.get(a.ref.grantId)).toMatchObject({ state: 'active', revision: a.ref.revision, revokedAt: null })
    if (boundary === 'commit') {
      expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
      await expect(store.listDocuments(a.root)).resolves.toEqual([])
    } else expect(documentRows(a)).toEqual(before)
    expect(knowledgeRows(a)).toEqual([])
    a.runtime.database.exec('DROP TRIGGER fictional_revoke_reference')
    await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: boundary === 'replay' })
    await expectBUnchanged()
  })

  it('shares one physical request for the same grant binding and preserves same-binding execution takeover', async () => {
    const held = holdEmbedding(), old = importBook(a, { model: embeddingModel })
    let current: ReturnType<typeof importBook> | undefined
    try {
      await held.started
      a.runtime.database.prepare('UPDATE import_runs SET lease_expires_at=0 WHERE id=?').run(RUN)
      const execution = ImportRunRepository.startOrResume(RUN, 'fictional-takeover', Date.now(), 60_000, a.runtime).execution
      current = importBook(a, { model: embeddingModel, authority: { owner: execution.owner, epoch: execution.epoch },
        admission: captureReferenceImportAdmission(a.runtime, a.ref, requestHash) })
      held.finish()
      await expect(Promise.all([old, current])).resolves.toEqual([
        expect.objectContaining({ success: true, docId: documentId(a) }), expect.objectContaining({ success: true, docId: documentId(a) }),
      ])
      expect(held.fetch).toHaveBeenCalledTimes(1)
      expect(documentRows(a)).toHaveLength(1)
      await expectBUnchanged()
    } finally { held.finish(); await Promise.allSettled(current ? [old, current] : [old]) }
  })

  it.each(['new-grant-same-request', 'new-grant-new-request', 'legacy'] as const)('queues %s behind a revoked physical flight instead of rescuing or overlapping it', async nextKind => {
    if (nextKind === 'legacy') {
      store.closeConnection(b.root)
      projectRuntimeHost.releaseIdle(b.runtime)
      projectRuntimeHost.activateView(a.runtime)
    }
    const actual = store.addChunks, actualRemove = store.removeDocument
    const written = deferred<void>(), finishWrite = deferred<void>(), cleanupStarted = deferred<void>(), finishCleanup = deferred<void>()
    let writes = 0
    const add = vi.spyOn(store, 'addChunks').mockImplementation(async (...args) => {
      const result = await actual(...args)
      writes += 1
      if (writes === 1) { written.resolve(); await finishWrite.promise }
      return result
    })
    vi.spyOn(store, 'removeDocument').mockImplementation(async (...args) => {
      cleanupStarted.resolve()
      await finishCleanup.promise
      return actualRemove(...args)
    })
    const old = importBook(a)
    let current: ReturnType<typeof importBook> | undefined
    try {
      await written.promise
      a.grants.revoke(a.ref)
      if (nextKind === 'legacy') {
        current = withLegacyProjectOperation('kb:import-reference-text', () => importReferenceText(a.content, 'Chapter 1.txt',
          a.binding.stableKey, 1, RUN, a.authority, a.root, 'openai', ftsModel))
      } else {
        const nextHash = nextKind === 'new-grant-same-request' ? requestHash : hash('next-fictional-request')
        const grant = a.grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), runId: RUN,
          manifestFingerprint: a.grant.manifestFingerprint!, requestHash: nextHash })
        current = importBook(a, { admission: captureReferenceImportAdmission(a.runtime,
          { grantId: grant.grantId, revision: grant.revision, runId: RUN }, nextHash) })
      }
      let currentSettled = false
      void current.then(() => { currentSettled = true }, () => { currentSettled = true })
      await store.getDocumentIntegrity(a.root, documentId(a))
      expect(currentSettled).toBe(false)
      expect(add).toHaveBeenCalledTimes(1)
      finishWrite.resolve()
      await cleanupStarted.promise
      expect(currentSettled).toBe(false)
      expect(add).toHaveBeenCalledTimes(1)
      finishCleanup.resolve()
      await expect(old).resolves.toMatchObject({ success: false })
      await expect(current).resolves.toMatchObject({ success: true, idempotent: false, docId: documentId(a) })
      expect(add).toHaveBeenCalledTimes(2)
      expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'committed' })])
      await expect(store.getDocumentIntegrity(a.root, documentId(a))).resolves.toMatchObject({ complete: true, chunkCount: 1 })
      if (nextKind !== 'legacy') await expectBUnchanged()
    } finally { finishWrite.resolve(); finishCleanup.resolve(); await Promise.allSettled(current ? [old, current] : [old]) }
  })

  it('keeps physical cleanup held for close and excludes maintenance until the revoked native work settles', async () => {
    const actualAdd = store.addChunks, actualRemove = store.removeDocument
    const cleanupStarted = deferred<void>(), finishCleanup = deferred<void>()
    vi.spyOn(store, 'addChunks').mockImplementation(async (...args) => {
      const result = await actualAdd(...args)
      a.grants.revoke(a.ref)
      return result
    })
    vi.spyOn(store, 'removeDocument').mockImplementation(async (...args) => {
      cleanupStarted.resolve()
      await finishCleanup.promise
      return actualRemove(...args)
    })
    const pending = importBook(a)
    const unregister = projectRuntimeHost.onBeforeRelease(runtime => store.closeConnection(runtime.canonicalRoot))
    let closing: Promise<void> | undefined
    try {
      await cleanupStarted.promise
      expect(() => projectRuntimeHost.acquireMaintenance(a.runtime, 'backup')).toThrow('PROJECT_RUNTIME_BUSY')
      let settled = false, closed = false
      void pending.then(() => { settled = true })
      closing = projectRuntimeHost.requestClose(a.runtime)
      void closing.then(() => { closed = true }, () => {})
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(closed).toBe(false)
      expect(a.runtime.database.open).toBe(true)
      finishCleanup.resolve()
      await expect(pending).resolves.toMatchObject({ success: false })
      await closing
      expect(a.runtime.database.open).toBe(false)
      openCanonicalProjectFixture(a.root)
      const reopened = projectRuntimeHost.getActiveView()!
      expect(reopened.databaseIdentity).not.toBe(a.runtime.databaseIdentity)
      projectRuntimeHost.activateView(b.runtime)
      await expect(store.listDocuments(a.root)).resolves.toEqual([])
      expect(reopened.database.prepare('SELECT state FROM import_reference_documents').all()).toEqual([{ state: 'prepared' }])
      await expectBUnchanged()
    } finally { finishCleanup.resolve(); await pending; if (closing) await closing; unregister() }
  })
})
