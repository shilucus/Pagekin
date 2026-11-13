import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import type { ReferenceImportGrantRef } from '../../src/shared/reference-import-grant'
import { normalizeEmbeddingOptions, type EmbeddingModel } from '../../src/shared/embedding-options'
import { getProjectDb } from '../database'
import { captureReferenceImportResources, importReferenceText } from '../knowledge-base'
import { chunkText } from '../embedding'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { ReferenceImportGrantRepository } from '../repositories/reference-import-grant-repository'
import { ReferenceEmbeddingBudgetRepository } from '../repositories/reference-embedding-budget-repository'
import { captureReferenceImportAdmission } from '../services/reference-import-admission'
import { readPortableRuntimeFreeze } from '../services/portable-runtime-freeze'
import { projectRuntimeHost } from '../services/project-runtime'
import { withLegacyProjectOperation } from '../services/project-runtime-compatibility'
import * as store from '../vector-store'

const RUN = 'fictional-grant-reference'
const BATCH_TEXT = `${'A'.repeat(100)}${'B'.repeat(100)}${'C'.repeat(100)}`
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const requestHash = hash('fictional-frozen-reference-request')
const ftsModel = { provider: 'openai', baseUrl: 'https://unused.example/v1', apiKey: '', modelName: 'fts-only' }
const embeddingModel = { ...ftsModel, baseUrl: 'https://embedding.example/v1', apiKey: 'fictional-key', modelName: 'embedding' }
let temporaryParent = ''
let parent = ''

function book(name: string, content = `Fictional ${name} courier waits beside a harbor.`, initialModel: EmbeddingModel | null = ftsModel) {
  const root = path.join(parent, name)
  fs.mkdirSync(root)
  openCanonicalProjectFixture(root)
  const runtime = projectRuntimeHost.getActiveView()!
  ImportRunRepository.prepare({ runId: RUN, purpose: 'reference', sourceFingerprint: hash(`source:${name}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'Chapter 1.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'One', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  const grants = new ReferenceImportGrantRepository(runtime.database, { projectId: runtime.projectId, context: runtime,
    assertCurrent: () => { projectRuntimeHost.assertOpen(runtime) },
    isFrozen: id => readPortableRuntimeFreeze(root).isFrozen('reference_import_grants', id) })
  const scope = ImportRunRepository.captureReferenceGrantScope(RUN, runtime)
  const budgets = new ReferenceEmbeddingBudgetRepository(runtime.database, {
    assertCurrent: () => { projectRuntimeHost.assertOpen(runtime) },
    isFrozen: id => readPortableRuntimeFreeze(root).isFrozen('reference_embedding_budgets', id),
  })
  if (initialModel) budgets.preflight(RUN)
  const { grant, execution, budget } = runtime.database.transaction(() => {
    const options = initialModel ? normalizeEmbeddingOptions(initialModel.embeddingOptions) : null
    const capability = options ? budgets.prepare({ runId: RUN, manifestFingerprint: scope.manifestFingerprint,
      plan: { chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap, batchSize: options.batchSize,
        requestLimit: Math.ceil(chunkText(content, options.chunkSize, options.chunkOverlap).length / options.batchSize) } }) : undefined
    const grant = grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), runId: RUN,
      manifestFingerprint: scope.manifestFingerprint, requestHash })
    const execution = ImportRunRepository.startOrResume(RUN, 'fictional-owner', Date.now(), 60_000, runtime).execution
    return { grant, execution, budget: capability ? { repository: budgets, capability } : undefined }
  }).immediate()
  const ref = { grantId: grant.grantId, revision: grant.revision, runId: RUN }
  const authority = { owner: execution.owner, epoch: execution.epoch }
  const binding = ImportRunRepository.resolveReferenceImportAuthority(RUN, authority, 1, undefined, runtime.database)
  return { root, runtime, content, grants, grant, ref, execution, authority, binding, budget,
    resources: captureReferenceImportResources(runtime), admission: captureReferenceImportAdmission(runtime, ref, requestHash, undefined, budget) }
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
  model?: EmbeddingModel
  protocol?: 'openai' | 'gemini'
} = {}) {
  return importReferenceText(value.content, 'Chapter 1.txt', value.binding.stableKey, 1, options.runId ?? RUN,
    options.authority ?? value.authority, value.root, options.protocol ?? 'openai', options.model ?? ftsModel,
    options.resources ?? value.resources, options.admission ?? value.admission)
}

function documentId(value: Book): string { return hash(`reference-import:${value.binding.stableKey}`) }
function documentRows(value: Book) { return value.runtime.database.prepare('SELECT * FROM import_reference_documents ORDER BY document_id').all() }
function knowledgeRows(value: Book) { return value.runtime.database.prepare('SELECT * FROM import_run_knowledge_receipts ORDER BY chapter_number').all() }
function dispatchRows(value: Book) { return value.runtime.database.prepare('SELECT * FROM reference_embedding_dispatches ORDER BY batch_ordinal').all() }

function batchModel(concurrencyLimit?: number): EmbeddingModel {
  return { ...embeddingModel, embeddingOptions: {
    chunkSize: 100, chunkOverlap: 0, batchSize: 1,
    ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
  } }
}

async function embeddingRows(value: Book) {
  const registry = await store.getEmbeddingSpaces(value.root)
  const active = registry.spaces.find(space => space.generation === registry.activeGeneration)
  if (!active) return []
  const table = await (await store.getConnection(value.root)).openTable(active.tableName)
  try {
    const rows = await table.query().filter(`\`docId\` = '${documentId(value)}'`)
      .select(['chunkIndex', 'text', 'vector']).toArray() as Array<{
        chunkIndex: number
        text: string
        vector: number[]
      }>
    return rows.sort((left, right) => left.chunkIndex - right.chunkIndex)
  } finally { table.close() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function embeddingResponse(vector = [0.1, 0.2, 0.3]) {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function invalidEmbeddingResponse() {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 'invalid', 0.3] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function batchOrdinal(text: string): number { return text.charCodeAt(0) - 'A'.charCodeAt(0) }
function batchVector(text: string): number[] { return [batchOrdinal(text) + 1, 0, 0] }

function holdEmbedding() {
  const started = deferred<void>(), finish = deferred<Response>()
  const fetch = vi.fn(() => { started.resolve(); return finish.promise })
  vi.stubGlobal('fetch', fetch)
  return { started: started.promise, finish: () => finish.resolve(embeddingResponse()),
    fail: () => finish.reject(new Error('FICTIONAL_TRANSPORT_REJECTED')), fetch }
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
  it('preserves a committed zero-overlap legacy chunk set when the corrected set conflicts', async () => {
    const first = 'A'.repeat(60), second = 'B'.repeat(60)
    const value = book('LegacyZeroOverlap', `${first}\n\n${second}`, null)
    projectRuntimeHost.activateView(b.runtime)
    const legacyChunks = [first, `${first}\n\n${second.slice(0, 38)}`, second.slice(38)]
    const correctedChunks = [first, second]
    const id = documentId(value)
    expect(store.hashCanonicalChunkSet(legacyChunks)).not.toBe(store.hashCanonicalChunkSet(correctedChunks))
    await expect(store.addChunks(value.root, id, 'Chapter 1.txt', legacyChunks, undefined, undefined,
      { corpusKind: 'reference', replacementMode: 'stable-id' })).resolves.toMatchObject({ success: true, chunkCount: 3 })
    value.admission.withTransaction(value.resources, RUN, () => {
      value.runtime.database.prepare(`INSERT INTO import_reference_documents
        (document_id, idempotency_key_hash, content_hash, chunk_set_hash, expected_chunk_count, corpus_kind, state)
        VALUES (?, ?, ?, ?, ?, 'reference', 'committed')`).run(id, hash(value.binding.stableKey), hash(value.content),
        store.hashCanonicalChunkSet(legacyChunks), legacyChunks.length)
      ImportRunRepository.commitReferenceImportReceipt(RUN, value.authority, 1, id, value.runtime.database)
    })
    const documents = documentRows(value), receipts = knowledgeRows(value), dispatches = dispatchRows(value)
    expect(value.runtime.database.prepare('SELECT COUNT(*) FROM reference_embedding_budgets').pluck().get()).toBe(0)
    const projection = await store.listDocuments(value.root)
    expect(projection).toHaveLength(1)
    const integrity = await store.getDocumentIntegrity(value.root, id)
    expect(integrity).toMatchObject({ complete: true, corpusKind: 'reference', chunkCount: 3,
      chunkSetHash: store.hashCanonicalChunkSet(legacyChunks) })
    expect(receipts).toEqual([expect.objectContaining({ run_id: RUN, chapter_number: 1, document_id: id,
      content_fingerprint: hash(value.content), state: 'committed' })])
    const connection = await store.getConnection(value.root)
    const table = await connection.openTable('chunks')
    const readChunks = async () => {
      const rows = await table.query().select(['chunkIndex', 'text']).toArray() as Array<{ chunkIndex: number; text: string }>
      return rows.sort((left, right) => left.chunkIndex - right.chunkIndex).map(row => ({ chunkIndex: row.chunkIndex, text: row.text }))
    }
    try {
      const chunks = await readChunks()
      expect(chunks).toEqual(legacyChunks.map((text, chunkIndex) => ({ chunkIndex, text })))
      const fts = await store.search(value.root, second.slice(0, 22))
      expect(fts.length).toBeGreaterThan(0)
      await expect(importBook(value, { model: batchModel(1) })).resolves.toMatchObject({
        success: false, error: 'KNOWLEDGE_BASE_REFERENCE_BUDGET_REQUIRED',
      })
      await expect(importReferenceText(value.content, 'Chapter 1.txt', value.binding.stableKey, 1, RUN,
        value.authority, value.root, 'openai', batchModel(1), value.resources)).resolves.toMatchObject({
        success: false, error: 'KNOWLEDGE_BASE_REFERENCE_RECEIPT_CONFLICT',
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(documentRows(value)).toEqual(documents)
      expect(knowledgeRows(value)).toEqual(receipts)
      expect(dispatchRows(value)).toEqual(dispatches)
      expect(await store.listDocuments(value.root)).toEqual(projection)
      expect(await readChunks()).toEqual(chunks)
      expect(await store.getDocumentIntegrity(value.root, id)).toEqual(integrity)
      expect(await store.search(value.root, second.slice(0, 22))).toEqual(fts)
      await expectBUnchanged()
    } finally { table.close() }
  })
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
    expect(dispatchRows(a)).toEqual([])
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
      expect(dispatchRows(a)).toEqual([expect.objectContaining({ state: 'dispatch_marked', http_status: null, settled_at: null })])
      a.grants.revoke(a.ref)
      held.finish()
      await expect(pending).resolves.toMatchObject({ success: false })
      expect(held.fetch).toHaveBeenCalledTimes(1)
      expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
      expect(knowledgeRows(a)).toEqual([])
      expect(dispatchRows(a)).toEqual([expect.objectContaining({ state: 'response_received', http_status: 200, settled_at: expect.any(Number) })])
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
    if (boundary === 'commit') {
      await expect(importBook(a)).resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_PREPARED_UNPROVEN' })
      expect(dispatchRows(a)).toEqual([])
      await expect(store.listDocuments(a.root)).resolves.toEqual([])
    } else await expect(importBook(a)).resolves.toMatchObject({ success: true, idempotent: boundary === 'replay' })
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
        admission: captureReferenceImportAdmission(a.runtime, a.ref, requestHash, undefined, a.budget) })
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
          { grantId: grant.grantId, revision: grant.revision, runId: RUN }, nextHash, undefined, a.budget) })
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
      if (nextKind === 'legacy') {
        await expect(current).resolves.toMatchObject({ success: true, idempotent: false, docId: documentId(a) })
        expect(add).toHaveBeenCalledTimes(2)
        expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'committed' })])
        await expect(store.getDocumentIntegrity(a.root, documentId(a))).resolves.toMatchObject({ complete: true, chunkCount: 1 })
      } else {
        await expect(current).resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_PREPARED_UNPROVEN' })
        expect(add).toHaveBeenCalledTimes(1)
        expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
        await expect(store.getDocumentIntegrity(a.root, documentId(a))).resolves.toBeNull()
        await expectBUnchanged()
      }
      expect(dispatchRows(a)).toEqual([])
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

  it.each(['openai', 'gemini'] as const)('records actual %s dispatch and validated response, then reconciles a complete document without another request', async protocol => {
    const fetchMock = vi.fn(async () => {
      expect(dispatchRows(a)).toEqual([expect.objectContaining({ import_run_id: RUN, document_id: documentId(a),
        batch_ordinal: 0, input_count: 1, state: 'dispatch_marked', http_status: null, settled_at: null })])
      const payload = protocol === 'openai' ? { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }
        : { embeddings: [{ values: [0.1, 0.2, 0.3] }] }
      return new Response(JSON.stringify(payload), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(importBook(a, { model: embeddingModel, protocol })).resolves.toMatchObject({ success: true, idempotent: false })
    const history = dispatchRows(a)
    expect(history).toEqual([expect.objectContaining({ dispatch_id: `reference-embedding:${documentId(a)}:0`,
      state: 'response_received', http_status: 201, marked_at: expect.any(Number), settled_at: expect.any(Number) })])
    await expect(importBook(a, { model: embeddingModel, protocol })).resolves.toMatchObject({ success: true, idempotent: true })
    expect(dispatchRows(a)).toEqual(history)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(store.getDocumentIntegrity(a.root, documentId(a))).resolves.toMatchObject({ complete: true,
      embeddingGenerations: expect.arrayContaining([expect.objectContaining({ complete: true, chunkCount: 1 })]) })
    await expectBUnchanged()
  })

  it('keeps the real multi-batch KB default serial and replays a fully embedded document without another request', async () => {
    const value = book('DefaultBatching', BATCH_TEXT, batchModel())
    projectRuntimeHost.activateView(b.runtime)
    let inFlight = 0, peakInFlight = 0
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const input = (JSON.parse(init?.body as string).input as string[])[0]
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      return Promise.resolve().then(() => embeddingResponse(batchVector(input))).finally(() => { inFlight-- })
    })
    vi.stubGlobal('fetch', fetchMock)
    const model = batchModel()

    const imported = await importBook(value, { model })
    expect(imported).toMatchObject({ success: true, idempotent: false, docId: documentId(value), chunkCount: 3 })
    expect(peakInFlight).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(dispatchRows(value)).toEqual([0, 1, 2].map(batch_ordinal => expect.objectContaining({
      batch_ordinal, input_count: 1, state: 'response_received', http_status: 200, settled_at: expect.any(Number),
    })))
    await expect(store.getDocumentIntegrity(value.root, documentId(value))).resolves.toMatchObject({
      complete: true, corpusKind: 'reference', chunkCount: 3,
      embeddingGenerations: [expect.objectContaining({ complete: true, chunkCount: 3 })],
    })
    expect((await embeddingRows(value)).map(row => ({ chunkIndex: row.chunkIndex, text: row.text, vector: Array.from(row.vector) })))
      .toEqual(['A', 'B', 'C'].map((letter, chunkIndex) => ({
        chunkIndex, text: letter.repeat(100), vector: [chunkIndex + 1, 0, 0],
      })))

    const history = dispatchRows(value)
    await expect(importBook(value, { model })).resolves.toMatchObject({ success: true, idempotent: true, docId: imported.docId })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(dispatchRows(value)).toEqual(history)
    await expectBUnchanged()
  })

  it('persists explicit-two out-of-order real KB batches in original vector order', async () => {
    const value = book('ExplicitTwoBatching', BATCH_TEXT, batchModel(2))
    projectRuntimeHost.activateView(b.runtime)
    const gates = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    const completed: number[] = []
    let inFlight = 0, peakInFlight = 0
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const input = (JSON.parse(init?.body as string).input as string[])[0]
      const ordinal = batchOrdinal(input)
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      return gates[ordinal].promise.then(response => {
        completed.push(ordinal)
        return response
      }).finally(() => { inFlight-- })
    })
    vi.stubGlobal('fetch', fetchMock)
    const pending = importBook(value, { model: batchModel(2) })
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      expect(peakInFlight).toBe(2)
      expect(dispatchRows(value)).toEqual([0, 1].map(batch_ordinal => expect.objectContaining({
        batch_ordinal, state: 'dispatch_marked', http_status: null, settled_at: null,
      })))

      gates[1].resolve(embeddingResponse(batchVector('B')))
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
      expect(dispatchRows(value)).toEqual([
        expect.objectContaining({ batch_ordinal: 0, state: 'dispatch_marked' }),
        expect.objectContaining({ batch_ordinal: 1, state: 'response_received', http_status: 200, settled_at: expect.any(Number) }),
        expect.objectContaining({ batch_ordinal: 2, state: 'dispatch_marked' }),
      ])
      gates[2].resolve(embeddingResponse(batchVector('C')))
      await vi.waitFor(() => expect(dispatchRows(value)[2]).toMatchObject({ state: 'response_received', http_status: 200 }))
      gates[0].resolve(embeddingResponse(batchVector('A')))

      await expect(pending).resolves.toMatchObject({ success: true, idempotent: false, chunkCount: 3 })
      expect(completed).toEqual([1, 2, 0])
      expect(peakInFlight).toBe(2)
      expect(dispatchRows(value)).toEqual([0, 1, 2].map(batch_ordinal => expect.objectContaining({
        batch_ordinal, input_count: 1, state: 'response_received', http_status: 200, settled_at: expect.any(Number),
      })))
      await expect(store.getDocumentIntegrity(value.root, documentId(value))).resolves.toMatchObject({
        complete: true, corpusKind: 'reference', chunkCount: 3,
        embeddingGenerations: [expect.objectContaining({ complete: true, chunkCount: 3 })],
      })
      expect((await embeddingRows(value)).map(row => ({ chunkIndex: row.chunkIndex, text: row.text, vector: Array.from(row.vector) })))
        .toEqual(['A', 'B', 'C'].map((letter, chunkIndex) => ({
          chunkIndex, text: letter.repeat(100), vector: [chunkIndex + 1, 0, 0],
        })))

      const history = dispatchRows(value)
      await expect(importBook(value, { model: batchModel(2) })).resolves.toMatchObject({ success: true, idempotent: true })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(dispatchRows(value)).toEqual(history)
      await expectBUnchanged()
    } finally {
      gates.forEach((gate, ordinal) => gate.resolve(embeddingResponse([ordinal + 1, 0, 0])))
      await Promise.allSettled([pending])
    }
  })

  it.each([
    ['http', 0], ['http', 1], ['invalid', 0], ['invalid', 1],
  ] as const)('matches serial outcome when ordinal zero is %s and ordinal %i returns first', async (ordinalZeroKind, firstCompletedOrdinal) => {
    const content = `${'A'.repeat(100)}${'B'.repeat(100)}`
    const serial = book(`Serial-${ordinalZeroKind}`, content, batchModel(1))
    const parallel = book(`Parallel-${ordinalZeroKind}`, content, batchModel(2))
    projectRuntimeHost.activateView(b.runtime)
    const kindAtOrdinal = [ordinalZeroKind, ordinalZeroKind === 'http' ? 'invalid' : 'http'] as const
    const responseFor = (kind: typeof kindAtOrdinal[number]) => kind === 'http'
      ? new Response('', { status: 503 })
      : invalidEmbeddingResponse()
    const requestOrdinal = (init?: RequestInit) => batchOrdinal((JSON.parse(init?.body as string).input as string[])[0])
    const serialFetch = vi.fn((_url: string, init?: RequestInit) => Promise.resolve(responseFor(kindAtOrdinal[requestOrdinal(init)])))
    const add = vi.spyOn(store, 'addChunks')
    vi.stubGlobal('fetch', serialFetch)
    const serialResult = await importBook(serial, { model: batchModel(1) })
    const serialDispatch = dispatchRows(serial)

    const gates = [deferred<Response>(), deferred<Response>()]
    const completionOrder: number[] = []
    const parallelFetch = vi.fn((_url: string, init?: RequestInit) => {
      const ordinal = requestOrdinal(init)
      return gates[ordinal].promise.then(response => {
        completionOrder.push(ordinal)
        return response
      })
    })
    vi.stubGlobal('fetch', parallelFetch)
    const pending = importBook(parallel, { model: batchModel(2) })
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(parallelFetch).toHaveBeenCalledTimes(2))
      gates[firstCompletedOrdinal].resolve(responseFor(kindAtOrdinal[firstCompletedOrdinal]))
      const firstCompletedKind = kindAtOrdinal[firstCompletedOrdinal]
      const firstCompletedState = firstCompletedKind === 'http' ? 'http_failed' : 'response_invalid'
      await vi.waitFor(() => expect(dispatchRows(parallel)[firstCompletedOrdinal]).toMatchObject({
        batch_ordinal: firstCompletedOrdinal, state: firstCompletedState, settled_at: expect.any(Number),
      }))
      let parallelSettled = false
      void pending.then(() => { parallelSettled = true }, () => { parallelSettled = true })
      await Promise.resolve()
      expect(parallelSettled).toBe(false)
      const secondCompletedOrdinal = 1 - firstCompletedOrdinal
      gates[secondCompletedOrdinal].resolve(responseFor(kindAtOrdinal[secondCompletedOrdinal]))
      const parallelResult = await pending
      expect(completionOrder).toEqual([firstCompletedOrdinal, secondCompletedOrdinal])

      const summarize = async (value: Book, result: Awaited<ReturnType<typeof importBook>>) => {
        const integrity = await store.getDocumentIntegrity(value.root, documentId(value))
        const documents = await store.listDocuments(value.root)
        return {
          success: result.success,
          error: result.error ?? null,
          documentState: (documentRows(value)[0] as { state?: string } | undefined)?.state ?? null,
          integrityComplete: integrity?.complete ?? false,
          chunkCount: integrity?.chunkCount ?? 0,
          embeddedChunks: integrity?.embeddingGenerations.reduce((total, generation) => total + generation.chunkCount, 0) ?? 0,
          visibleDocuments: documents.length,
        }
      }
      const serialOutcome = await summarize(serial, serialResult)
      const parallelOutcome = await summarize(parallel, parallelResult)
      expect(parallelOutcome).toEqual(serialOutcome)
      if (ordinalZeroKind === 'http') {
        expect(serialOutcome).toEqual({ success: true, error: null, documentState: 'committed',
          integrityComplete: true, chunkCount: 2, embeddedChunks: 0, visibleDocuments: 1 })
        expect(add).toHaveBeenCalledTimes(2)
      } else {
        expect(serialOutcome).toEqual({ success: false, error: 'EMBEDDING_RESPONSE_INVALID', documentState: 'prepared',
          integrityComplete: false, chunkCount: 0, embeddedChunks: 0, visibleDocuments: 0 })
        expect(add).not.toHaveBeenCalled()
      }
      expect(serialDispatch).toEqual([expect.objectContaining({
        batch_ordinal: 0, state: ordinalZeroKind === 'http' ? 'http_failed' : 'response_invalid', settled_at: expect.any(Number),
      })])
      const ordinalOneState = kindAtOrdinal[1] === 'http' ? 'http_failed' : 'response_invalid'
      expect(dispatchRows(parallel)).toEqual([
        expect.objectContaining({ batch_ordinal: 0, state: ordinalZeroKind === 'http' ? 'http_failed' : 'response_invalid', settled_at: expect.any(Number) }),
        expect.objectContaining({ batch_ordinal: 1, state: ordinalOneState, settled_at: expect.any(Number) }),
      ])
      expect(serialFetch).toHaveBeenCalledTimes(1)
      expect(parallelFetch).toHaveBeenCalledTimes(2)
      await expectBUnchanged()
    } finally {
      gates.forEach((gate, ordinal) => gate.resolve(responseFor(kindAtOrdinal[ordinal])))
      await Promise.allSettled([pending])
    }
  })

  it.each(['http_failed', 'transport_unknown'] as const)('retains %s while preserving same-invocation whole-document FTS fallback', async state => {
    const fetchMock = vi.fn(async () => {
      if (state === 'transport_unknown') throw new Error('FICTIONAL_TRANSPORT_REJECTED')
      return new Response('', { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(importBook(a, { model: embeddingModel })).resolves.toMatchObject({ success: true, idempotent: false })
    const history = dispatchRows(a)
    expect(history).toEqual([expect.objectContaining({ state, http_status: state === 'http_failed' ? 503 : null, settled_at: expect.any(Number) })])
    await expect(store.getDocumentIntegrity(a.root, documentId(a))).resolves.toMatchObject({ complete: true, embeddingGenerations: [] })
    await expect(importBook(a, { model: embeddingModel })).resolves.toMatchObject({ success: true, idempotent: true })
    expect(dispatchRows(a)).toEqual(history)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expectBUnchanged()
  })

  it.each(['response_received', 'http_failed', 'response_invalid', 'transport_unknown'] as const)('blocks incomplete %s history across the same grant, a new grant and legacy entry', async state => {
    const fetchMock = vi.fn(async () => {
      if (state === 'transport_unknown') throw new Error('FICTIONAL_TRANSPORT_REJECTED')
      if (state === 'http_failed') return new Response('', { status: 429 })
      return state === 'response_invalid' ? new Response('{}', { status: 200 }) : embeddingResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const add = vi.spyOn(store, 'addChunks').mockResolvedValue({ success: false, chunkCount: 0, error: 'FICTIONAL_PROJECTION_FAILED' })
    await expect(importBook(a, { model: embeddingModel })).resolves.toMatchObject({ success: false })
    expect(add).toHaveBeenCalledTimes(state === 'response_invalid' ? 0 : 1)
    add.mockRestore()
    const history = dispatchRows(a)
    expect(history).toEqual([expect.objectContaining({ state, settled_at: expect.any(Number) })])
    await expect(importBook(a, { model: embeddingModel })).resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED' })
    a.grants.revoke(a.ref)
    const grant = a.grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), runId: RUN,
      manifestFingerprint: a.grant.manifestFingerprint!, requestHash })
    const admission = captureReferenceImportAdmission(a.runtime, { grantId: grant.grantId, revision: grant.revision, runId: RUN }, requestHash, undefined, a.budget)
    await expect(importBook(a, { model: embeddingModel, admission })).resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED' })
    await expectBUnchanged()
    store.closeConnection(b.root)
    projectRuntimeHost.releaseIdle(b.runtime)
    projectRuntimeHost.activateView(a.runtime)
    await expect(withLegacyProjectOperation('kb:import-reference-text', () => importReferenceText(a.content, 'Chapter 1.txt',
      a.binding.stableKey, 1, RUN, a.authority, a.root, 'openai', embeddingModel)))
      .resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED' })
    expect(dispatchRows(a)).toEqual(history)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(store.listDocuments(a.root)).resolves.toEqual([])
    expect(documentRows(a)).toEqual([expect.objectContaining({ state: 'prepared' })])
  })

  it.each(['mark', 'settlement'] as const)('treats actual SQL %s failure as a hard barrier without FTS or a replacement request', async phase => {
    const fetchMock = vi.fn(async () => embeddingResponse())
    vi.stubGlobal('fetch', fetchMock)
    const add = vi.spyOn(store, 'addChunks')
    a.runtime.database.exec(`CREATE TEMP TRIGGER fictional_embedding_persistence BEFORE ${phase === 'mark' ? 'INSERT' : 'UPDATE'}
      ON reference_embedding_dispatches BEGIN SELECT RAISE(ABORT, 'FICTIONAL_LEDGER_WRITE_FAILED'); END;`)
    await expect(importBook(a, { model: embeddingModel })).resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED' })
    expect(fetchMock).toHaveBeenCalledTimes(phase === 'mark' ? 0 : 1)
    expect(add).not.toHaveBeenCalled()
    expect(dispatchRows(a)).toEqual(phase === 'mark' ? [] : [expect.objectContaining({ state: 'dispatch_marked', settled_at: null })])
    a.runtime.database.exec('DROP TRIGGER fictional_embedding_persistence')
    await expect(importBook(a, { model: embeddingModel })).resolves.toMatchObject({ success: false,
      error: phase === 'mark' ? 'REFERENCE_EMBEDDING_PREPARED_UNPROVEN' : 'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED' })
    expect(fetchMock).toHaveBeenCalledTimes(phase === 'mark' ? 0 : 1)
    expect(add).not.toHaveBeenCalled()
    await expectBUnchanged()
  })

  it('drains a sibling request before reporting a later settlement fence despite an earlier ordinary HTTP failure', async () => {
    const value = book('Batches', 'x'.repeat(150), batchModel(2))
    projectRuntimeHost.activateView(b.runtime)
    const model = { ...embeddingModel, embeddingOptions: { chunkSize: 100, chunkOverlap: 0, batchSize: 1, concurrencyLimit: 2 } }
    const first = deferred<Response>(), second = deferred<Response>(), both = deferred<void>()
    const fetchMock = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => { both.resolve(); return second.promise })
    vi.stubGlobal('fetch', fetchMock)
    value.runtime.database.exec(`CREATE TEMP TRIGGER fictional_second_settlement BEFORE UPDATE ON reference_embedding_dispatches
      WHEN NEW.batch_ordinal=1 BEGIN SELECT RAISE(ABORT, 'FICTIONAL_SECOND_LEDGER_WRITE_FAILED'); END;`)
    const add = vi.spyOn(store, 'addChunks'), pending = importBook(value, { model })
    try {
      await both.promise
      first.resolve(new Response('', { status: 503 }))
      await vi.waitFor(() => expect(dispatchRows(value)).toEqual([
        expect.objectContaining({ batch_ordinal: 0, state: 'http_failed' }), expect.objectContaining({ batch_ordinal: 1, state: 'dispatch_marked' }),
      ]))
      let finished = false
      void pending.then(() => { finished = true })
      await Promise.resolve()
      expect(finished).toBe(false)
      expect(() => projectRuntimeHost.acquireMaintenance(value.runtime, 'backup')).toThrow('PROJECT_RUNTIME_BUSY')
      second.resolve(embeddingResponse())
      await expect(pending).resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(add).not.toHaveBeenCalled()
      expect(dispatchRows(value)).toEqual([
        expect.objectContaining({ batch_ordinal: 0, state: 'http_failed', http_status: 503 }),
        expect.objectContaining({ batch_ordinal: 1, state: 'dispatch_marked', settled_at: null }),
      ])
      await expectBUnchanged()
    } finally { first.resolve(new Response('', { status: 503 })); second.resolve(embeddingResponse()); await pending }
  })

  it('stops a revoked three-batch import after two dispatches and drains its sibling before close', async () => {
    const value = book('RevokedThreeBatch', BATCH_TEXT, batchModel(2))
    projectRuntimeHost.activateView(b.runtime)
    const gates = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    let starts = 0, importSettled = false, closeSettled = false
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const input = (JSON.parse(init?.body as string).input as string[])[0]
      const ordinal = batchOrdinal(input)
      starts++
      return gates[ordinal].promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const add = vi.spyOn(store, 'addChunks')
    const pending = importBook(value, { model: batchModel(2) })
    void pending.then(() => { importSettled = true }, () => { importSettled = true })
    let sqlAtRelease: { documents: unknown[]; receipts: unknown[]; dispatches: unknown[] } | null = null
    const unregister = projectRuntimeHost.onBeforeRelease(runtime => {
      if (runtime !== value.runtime) return
      sqlAtRelease = { documents: documentRows(value), receipts: knowledgeRows(value), dispatches: dispatchRows(value) }
      store.closeConnection(runtime.canonicalRoot)
    })
    let closing: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      expect(starts).toBe(2)
      expect(dispatchRows(value)).toEqual([0, 1].map(batch_ordinal => expect.objectContaining({
        batch_ordinal, state: 'dispatch_marked', http_status: null, settled_at: null,
      })))
      expect(() => projectRuntimeHost.acquireMaintenance(value.runtime, 'backup')).toThrow('PROJECT_RUNTIME_BUSY')

      value.grants.revoke(value.ref)
      closing = projectRuntimeHost.requestClose(value.runtime)
      void closing.then(() => { closeSettled = true }, () => { closeSettled = true })
      await Promise.resolve()
      gates[0].resolve(embeddingResponse(batchVector('A')))
      await vi.waitFor(() => expect(dispatchRows(value)).toEqual([
        expect.objectContaining({ batch_ordinal: 0, state: 'response_received', http_status: 200, settled_at: expect.any(Number) }),
        expect.objectContaining({ batch_ordinal: 1, state: 'dispatch_marked', http_status: null, settled_at: null }),
      ]))
      expect(starts).toBe(2)
      expect(importSettled).toBe(false)
      expect(closeSettled).toBe(false)
      expect(value.runtime.database.open).toBe(true)
      expect(() => projectRuntimeHost.acquireMaintenance(value.runtime, 'backup')).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')

      gates[1].resolve(embeddingResponse(batchVector('B')))
      await expect(pending).resolves.toMatchObject({ success: false })
      expect(importSettled).toBe(true)
      await closing
      expect(closeSettled).toBe(true)
      expect(value.runtime.database.open).toBe(false)
      expect(sqlAtRelease).toEqual({
        documents: [expect.objectContaining({ state: 'prepared' })],
        receipts: [],
        dispatches: [0, 1].map(batch_ordinal => expect.objectContaining({
          batch_ordinal, state: 'response_received', http_status: 200, settled_at: expect.any(Number),
        })),
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(add).not.toHaveBeenCalled()
      openCanonicalProjectFixture(value.root)
      const reopened = projectRuntimeHost.getActiveView()!
      expect(reopened.databaseIdentity).not.toBe(value.runtime.databaseIdentity)
      await expect(store.listDocuments(value.root)).resolves.toEqual([])
      expect(await (await store.getConnection(value.root)).tableNames()).toEqual([])
      projectRuntimeHost.activateView(b.runtime)
      await expectBUnchanged()
    } finally {
      gates.forEach((gate, ordinal) => gate.resolve(embeddingResponse([ordinal + 1, 0, 0])))
      await Promise.allSettled([pending, ...(closing ? [closing] : [])])
      store.closeConnection(value.root)
      unregister()
    }
  })

  it.each(['response_received', 'transport_unknown'] as const)('settles the exact revoked %s request before close and preserves history on original-project reopen without resending', async state => {
    const held = holdEmbedding(), pending = importBook(a, { model: embeddingModel })
    const unregister = projectRuntimeHost.onBeforeRelease(runtime => store.closeConnection(runtime.canonicalRoot))
    let closing: Promise<void> | undefined
    try {
      await held.started
      a.grants.revoke(a.ref)
      closing = projectRuntimeHost.requestClose(a.runtime)
      let closed = false
      void closing.then(() => { closed = true }, () => {})
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(a.runtime.database.open).toBe(true)
      if (state === 'transport_unknown') held.fail()
      else held.finish()
      await expect(pending).resolves.toMatchObject({ success: false })
      await closing
      expect(a.runtime.database.open).toBe(false)
      await expectBUnchanged()
      store.closeConnection(b.root)
      projectRuntimeHost.releaseIdle(b.runtime)
      openCanonicalProjectFixture(a.root)
      const reopened = projectRuntimeHost.getActiveView()!
      expect(reopened.databaseIdentity).not.toBe(a.runtime.databaseIdentity)
      expect(reopened.database.prepare('SELECT state,http_status FROM reference_embedding_dispatches').all())
        .toEqual([{ state, http_status: state === 'response_received' ? 200 : null }])
      await expect(withLegacyProjectOperation('kb:import-reference-text', () => importReferenceText(a.content, 'Chapter 1.txt',
        a.binding.stableKey, 1, RUN, a.authority, a.root, 'openai', embeddingModel)))
        .resolves.toMatchObject({ success: false, error: 'IMPORT_RUN_EXECUTION_STALE' })
      const execution = ImportRunRepository.startOrResume(RUN, 'fictional-reopened-owner', Date.now(), 60_000, reopened).execution
      expect(execution.epoch).toBeGreaterThan(a.authority.epoch)
      await expect(withLegacyProjectOperation('kb:import-reference-text', () => importReferenceText(a.content, 'Chapter 1.txt',
        a.binding.stableKey, 1, RUN, { owner: execution.owner, epoch: execution.epoch }, a.root, 'openai', embeddingModel)))
        .resolves.toMatchObject({ success: false, error: 'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED' })
      expect(held.fetch).toHaveBeenCalledTimes(1)
      await expect(store.listDocuments(a.root)).resolves.toEqual([])
    } finally { held.finish(); await pending; if (closing) await closing; unregister() }
  })
})
