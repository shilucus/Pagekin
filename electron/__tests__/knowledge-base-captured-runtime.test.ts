import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import { getProjectDb } from '../database'
import { chunkText } from '../embedding'
import { captureReferenceImportResources, importReferenceText } from '../knowledge-base'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { projectRuntimeHost } from '../services/project-runtime'
import { withLegacyProjectOperation } from '../services/project-runtime-compatibility'
import * as store from '../vector-store'

const RUN_ID = 'fictional-captured-reference'
const OWNER = 'fictional-owner'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const model = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const embeddingModel = { ...model, baseUrl: 'https://embedding.example/v1', apiKey: 'fictional-key', modelName: 'embedding' }
let tempBase = ''
let parent = ''

function book(name: string, content: string) {
  const root = path.join(parent, name)
  fs.mkdirSync(root)
  openCanonicalProjectFixture(root)
  const runtime = projectRuntimeHost.getActiveView()!
  ImportRunRepository.prepare({
    runId: RUN_ID, purpose: 'reference', sourceFingerprint: hash(`source:${content}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'One', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }],
  })
  const execution = ImportRunRepository.startOrResume(RUN_ID, OWNER, Date.now(), 60_000).execution
  const authority = { owner: execution.owner, epoch: execution.epoch }
  const binding = ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, authority, 1)
  return { root, runtime, content, execution, authority, binding, resources: captureReferenceImportResources(runtime) }
}

type Book = ReturnType<typeof book>
let a: Book
let b: Book
let beforeB: string

function importBook(value: Book, options: {
  resources?: ReturnType<typeof captureReferenceImportResources>
  authority?: Book['authority']
  model?: typeof model
  projectPath?: string
} = {}) {
  return importReferenceText(value.content, 'Chapter 1.txt', value.binding.stableKey, 1, RUN_ID,
    options.authority ?? value.authority, options.projectPath ?? value.root, 'openai', options.model ?? model,
    options.resources ?? value.resources)
}

function documentId(value: Book): string { return hash(`reference-import:${value.binding.stableKey}`) }

function preparedState(value: Book) {
  return value.runtime.database.prepare('SELECT * FROM import_reference_documents ORDER BY document_id').all()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function holdEmbedding() {
  const started = deferred<void>()
  const response = deferred<Response>()
  const fetch = vi.fn(() => { started.resolve(); return response.promise })
  vi.stubGlobal('fetch', fetch)
  return {
    started: started.promise, fetch,
    finish: () => response.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })),
  }
}

async function expectBUnchanged() {
  expect(hash(b.runtime.database.serialize())).toBe(beforeB)
  await expect(store.listDocuments(b.root)).resolves.toEqual([])
  expect(getProjectDb()).toBe(b.runtime.database)
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
  if (!path.basename(absoluteRoot).startsWith('pk-kbc-')) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
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
      if (fs.lstatSync(target).isSymbolicLink() || normalized(realTarget) !== normalized(target)) throw new Error('FICTIONAL_CLEANUP_LINK')
      assertChild(realRoot, realTarget)
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return absoluteRoot
}

beforeEach(async () => {
  tempBase = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(tempBase, 'pk-kbc-'))
  a = book('a', 'A fictional reference courier waits beside the harbor.')
  b = book('b', 'B is a different fictional reference, never the target of A.')
  await store.listDocuments(b.root)
  beforeB = hash(b.runtime.database.serialize())
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    store.closeConnection(runtime.canonicalRoot)
    projectRuntimeHost.releaseIdle(runtime)
  }
  if (parent) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  parent = ''
})

describe('captured reference knowledge runtime', () => {
  it('imports and replays real SQLite/Lance A while same-authority B remains the active view', async () => {
    expect(a.authority).toEqual(b.authority)
    const imported = await importBook(a)
    expect(imported).toMatchObject({ success: true, idempotent: false, docId: documentId(a) })
    expect(preparedState(a)).toEqual([expect.objectContaining({ state: 'committed', content_hash: hash(a.content) })])
    ImportRunRepository.commitReferenceImportReceipt(RUN_ID, a.authority, 1, imported.docId!, a.runtime.database)
    await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: true, docId: imported.docId })
    ImportRunRepository.commitReferenceImportReceipt(RUN_ID, a.authority, 1, imported.docId!, a.runtime.database)
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(1)
    await expect(store.getDocumentIntegrity(a.root, imported.docId!)).resolves.toMatchObject({ complete: true, corpusKind: 'reference', chunkCount: 1 })
    await expectBUnchanged()
  })

  it('rejects a different root and a copied non-host runtime before effects', async () => {
    await expect(importBook(a, { projectPath: b.root })).resolves.toMatchObject({ success: false, error: 'PROJECT_CONTEXT_CHANGED' })
    await expect(importBook(a, { authority: { ...a.authority, owner: 'not-authorized' } }))
      .resolves.toMatchObject({ success: false, error: 'IMPORT_RUN_EXECUTION_STALE' })
    expect(() => captureReferenceImportResources({ ...a.runtime })).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(preparedState(a)).toEqual([])
    await expectBUnchanged()
  })

  it.each([
    ['cancelled', 'IMPORT_RUN_CANCELLED'],
    ['expired', 'IMPORT_RUN_EXECUTION_STALE'],
  ])('discards delayed embeddings after A becomes %s without borrowing B authority', async (state, error) => {
    const held = holdEmbedding()
    const pending = importBook(a, { model: embeddingModel })
    await held.started
    if (state === 'cancelled') ImportRunRepository.requestCancel(RUN_ID, a.execution, a.runtime)
    else {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(a.execution.expiresAt)
    }
    held.finish()
    await expect(pending).resolves.toMatchObject({ success: false, error })
    expect(held.fetch).toHaveBeenCalledTimes(1)
    expect(preparedState(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
    await expect(store.listDocuments(a.root)).resolves.toEqual([])
    await expectBUnchanged()
  })

  it('shares one pending native-runtime flight with a takeover authority', async () => {
    const held = holdEmbedding()
    const old = importBook(a, { model: embeddingModel })
    await held.started
    a.runtime.database.prepare('UPDATE import_runs SET lease_expires_at = 0 WHERE id = ?').run(RUN_ID)
    const takeover = ImportRunRepository.startOrResume(RUN_ID, 'fictional-takeover', Date.now(), 60_000, a.runtime).execution
    const authority = { owner: takeover.owner, epoch: takeover.epoch }
    const current = importBook(a, { model: embeddingModel, authority, resources: captureReferenceImportResources(a.runtime) })
    held.finish()
    await expect(Promise.all([old, current])).resolves.toEqual([
      expect.objectContaining({ success: true, docId: documentId(a) }),
      expect.objectContaining({ success: true, docId: documentId(a) }),
    ])
    expect(held.fetch).toHaveBeenCalledTimes(1)
    expect(await store.listDocuments(a.root)).toHaveLength(1)
    expect(preparedState(a)).toHaveLength(1)
    await expectBUnchanged()
  })

  it.each(['captured-to-legacy', 'legacy-to-captured'] as const)(
    'shares the already-written native flight during %s takeover', async direction => {
      store.closeConnection(b.root)
      projectRuntimeHost.releaseIdle(b.runtime)
      projectRuntimeHost.activateView(a.runtime)
      const actualAdd = store.addChunks
      const written = deferred<void>()
      const finishWrite = deferred<void>()
      const add = vi.spyOn(store, 'addChunks').mockImplementation(async (...args) => {
        const result = await actualAdd(...args)
        written.resolve()
        await finishWrite.promise
        return result
      })
      const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
      vi.stubGlobal('fetch', fetch)
      const captured = (authority: Book['authority']) => importBook(a, { model: embeddingModel, authority })
      const legacy = (authority: Book['authority']) => withLegacyProjectOperation('kb:import-reference-text', () => importReferenceText(
        a.content, 'Chapter 1.txt', a.binding.stableKey, 1, RUN_ID, authority, a.root, 'openai', embeddingModel,
      ))
      const old = direction === 'captured-to-legacy' ? captured(a.authority) : legacy(a.authority)
      let current: ReturnType<typeof importBook> | undefined
      try {
        await written.promise
        await expect(store.getDocumentIntegrity(a.root, documentId(a))).resolves.toMatchObject({ complete: true, corpusKind: 'reference' })
        expect(preparedState(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
        a.runtime.database.prepare('UPDATE import_runs SET lease_expires_at = 0 WHERE id = ?').run(RUN_ID)
        const execution = ImportRunRepository.startOrResume(RUN_ID, 'fictional-mixed-takeover', Date.now(), 60_000, a.runtime).execution
        const authority = { owner: execution.owner, epoch: execution.epoch }
        current = direction === 'captured-to-legacy' ? legacy(authority) : captured(authority)
        let currentSettled = false
        void current.then(() => { currentSettled = true }, () => {})
        await store.getDocumentIntegrity(a.root, documentId(a))
        expect(currentSettled).toBe(false)
        finishWrite.resolve()
        await expect(Promise.all([old, current])).resolves.toEqual([
          expect.objectContaining({ success: true, docId: documentId(a) }),
          expect.objectContaining({ success: true, docId: documentId(a) }),
        ])
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(add).toHaveBeenCalledTimes(1)
        await expect(store.getDocumentIntegrity(a.root, documentId(a))).resolves.toMatchObject({ complete: true, corpusKind: 'reference', chunkCount: 1 })
        expect(preparedState(a)).toEqual([expect.objectContaining({ state: 'committed' })])
        ImportRunRepository.commitReferenceImportReceipt(RUN_ID, authority, 1, documentId(a), a.runtime.database)
        ImportRunRepository.commitReferenceImportReceipt(RUN_ID, authority, 1, documentId(a), a.runtime.database)
        expect(a.runtime.database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(1)
      } finally {
        finishWrite.resolve()
        await Promise.allSettled(current ? [old, current] : [old])
      }
    },
  )

  it('does not reuse captured resources after a real native close and reopen', async () => {
    const old = a.runtime
    const oldResources = a.resources
    store.closeConnection(a.root)
    projectRuntimeHost.releaseIdle(old)
    openCanonicalProjectFixture(a.root)
    const reopened = projectRuntimeHost.getActiveView()!
    expect(reopened.databaseIdentity).not.toBe(old.databaseIdentity)
    expect(reopened.executionEpoch).not.toBe(old.executionEpoch)
    projectRuntimeHost.activateView(b.runtime)
    await expect(importBook(a, { resources: oldResources })).resolves.toMatchObject({ success: false, error: 'PROJECT_RUNTIME_HANDLE_INVALID' })
    a = { ...a, runtime: reopened, resources: captureReferenceImportResources(reopened) }
    await expect(importBook(a)).resolves.toMatchObject({ success: false, error: 'IMPORT_RUN_EXECUTION_STALE' })
    expect(preparedState(a)).toEqual([])
    const execution = ImportRunRepository.startOrResume(RUN_ID, OWNER, Date.now(), 60_000, reopened).execution
    expect(execution.epoch).toBeGreaterThan(a.authority.epoch)
    a = { ...a, execution, authority: { owner: execution.owner, epoch: execution.epoch } }
    await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: false })
    await expectBUnchanged()
  })

  it.each(['chunks', 'documents'] as const)('rebuilds a real partial %s document in captured A only', async missingSide => {
    const initial = await importBook(a)
    const connection = await store.getConnection(a.root)
    const table = await connection.openTable(missingSide)
    await table.delete(`\`${missingSide === 'chunks' ? 'docId' : 'id'}\` = '${initial.docId}'`)
    await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: false, docId: initial.docId })
    await expect(store.getDocumentIntegrity(a.root, initial.docId!)).resolves.toMatchObject({ complete: true, chunkCount: chunkText(a.content).length })
    await expectBUnchanged()
  })

  it('checks the captured migration root before preparing SQLite or writing Lance', async () => {
    const pendingMigration = path.join(a.runtime.projectStorageRoot, 'vectors.json.migration-journal.json')
    fs.writeFileSync(pendingMigration, '{}', { flag: 'wx' })
    await expect(importBook(a)).resolves.toMatchObject({ success: false, error: 'LEGACY_VECTOR_MIGRATION_BLOCKED' })
    expect(preparedState(a)).toEqual([])
    expect(fs.existsSync(path.join(a.runtime.projectStorageRoot, 'lancedb'))).toBe(false)
    await expectBUnchanged()
  })

  it('cleans a real late-cancelled write before releasing work for close', async () => {
    const actualAdd = store.addChunks
    const actualRemove = store.removeDocument
    const written = deferred<void>()
    const cleanupStarted = deferred<void>()
    const finishCleanup = deferred<void>()
    vi.spyOn(store, 'addChunks').mockImplementation(async (...args) => {
      const result = await actualAdd(...args)
      ImportRunRepository.requestCancel(RUN_ID, a.execution, a.runtime)
      written.resolve()
      return result
    })
    vi.spyOn(store, 'removeDocument').mockImplementation(async (...args) => {
      cleanupStarted.resolve()
      await finishCleanup.promise
      return actualRemove(...args)
    })
    const pending = importBook(a)
    await written.promise
    await cleanupStarted.promise
    let settled = false
    void pending.then(() => { settled = true })
    const unregister = projectRuntimeHost.onBeforeRelease(runtime => store.closeConnection(runtime.canonicalRoot))
    try {
      const closing = projectRuntimeHost.requestClose(a.runtime)
      let closed = false
      void closing.then(() => { closed = true }, () => {})
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(closed).toBe(false)
      expect(a.runtime.database.open).toBe(true)
      expect(() => captureReferenceImportResources(a.runtime)).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
      finishCleanup.resolve()
      await expect(pending).resolves.toMatchObject({ success: false, error: 'IMPORT_RUN_CANCELLED' })
      await closing
      expect(a.runtime.database.open).toBe(false)
      openCanonicalProjectFixture(a.root)
      a = { ...a, runtime: projectRuntimeHost.getActiveView()!, resources: captureReferenceImportResources(projectRuntimeHost.getActiveView()!) }
      projectRuntimeHost.activateView(b.runtime)
      await expect(store.listDocuments(a.root)).resolves.toEqual([])
      expect(preparedState(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
      await expectBUnchanged()
    } finally {
      finishCleanup.resolve()
      unregister()
    }
  })
})
