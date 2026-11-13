import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { captureReferenceImportResources } from '../../knowledge-base'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { ReferenceImportGrantRepository } from '../../repositories/reference-import-grant-repository'
import { ReferenceEmbeddingBudgetRepository } from '../../repositories/reference-embedding-budget-repository'
import { readReferenceEmbeddingDispatches, ReferenceEmbeddingDispatchRepository } from '../../repositories/reference-embedding-dispatch-repository'
import { captureReferenceImportAdmission } from '../reference-import-admission'
import { assertNoReferenceEmbeddingDispatches, prepareReferenceEmbeddingDocument,
  type ReferenceEmbeddingDispatchFlight } from '../reference-embedding-dispatch'
import { assertEmbeddingRequestOutcome, assertReferenceEmbeddingDispatchRecord, EmbeddingDispatchBarrierError, REFERENCE_EMBEDDING_DISPATCH_FIELDS,
  type EmbeddingRequestOutcome } from '../reference-embedding-dispatch-contract'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { projectRuntimeHost } from '../project-runtime'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const runId = 'fictional-dispatch-run'
let temporaryParent = ''
let temporaryRoot = ''
const liveFlights = new Set<ReferenceEmbeddingDispatchFlight>()

function book(name: string) {
  const root = path.join(temporaryRoot, name)
  fs.mkdirSync(root)
  openCanonicalProjectFixture(root)
  const runtime = projectRuntimeHost.getActiveView()!
  const text = `Fictional ${name} reference chapter.`
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash(name), locale: 'en-US',
    sourceDisplay: [{ displayName: 'One.txt', mediaType: 'text/plain', size: Buffer.byteLength(text) }],
    chapters: [{ number: 1, title: 'One', content: text, contentSize: Buffer.byteLength(text), contentFingerprint: hash(text) }] })
  const grants = new ReferenceImportGrantRepository(runtime.database, { projectId: runtime.projectId, context: runtime,
    assertCurrent: () => { projectRuntimeHost.assertOpen(runtime) },
    isFrozen: id => readPortableRuntimeFreeze(root).isFrozen('reference_import_grants', id) })
  const scope = ImportRunRepository.captureReferenceGrantScope(runId, runtime)
  const requestHash = hash(`request:${name}`)
  const budgets = new ReferenceEmbeddingBudgetRepository(runtime.database, {
    assertCurrent: () => { projectRuntimeHost.assertOpen(runtime) },
    isFrozen: id => readPortableRuntimeFreeze(root).isFrozen('reference_embedding_budgets', id),
  })
  budgets.preflight(runId)
  const { grant, budget, execution } = runtime.database.transaction(() => {
    // This recorder fixture explicitly exercises two batches, not the production plan calculator.
    const budget = budgets.prepare({ runId, manifestFingerprint: scope.manifestFingerprint,
      plan: { chunkSize: 100, chunkOverlap: 0, batchSize: 1, requestLimit: 2 } })
    const grant = grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), runId,
      manifestFingerprint: scope.manifestFingerprint, requestHash })
    const execution = ImportRunRepository.startOrResume(runId, `owner:${name}`, Date.now(), 60_000, runtime).execution
    return { grant, budget, execution }
  }).immediate()
  const ref = { grantId: grant.grantId, runId, revision: grant.revision }
  const authority = { owner: execution.owner, epoch: execution.epoch }
  const binding = ImportRunRepository.resolveReferenceImportAuthority(runId, authority, 1, undefined, runtime.database)
  const resources = captureReferenceImportResources(runtime)
  const admission = captureReferenceImportAdmission(runtime, ref, requestHash, undefined, { repository: budgets, capability: budget })
  const assertAuthority = () => {
    ImportRunRepository.resolveReferenceImportAuthority(runId, authority, 1, undefined, runtime.database)
  }
  const document = { documentId: hash(`reference-import:${binding.stableKey}`), keyHash: hash(binding.stableKey),
    contentHash: hash(text), chunkSetHash: hash(`chunks:${name}`), chunkCount: 2 }
  return { root, runtime, resources, admission, document, grants, ref, execution, assertAuthority }
}

type Book = ReturnType<typeof book>
let a: Book

function prepare(value = a, document = value.document) {
  const result = prepareReferenceEmbeddingDocument({ resources: value.resources, admission: value.admission,
    runId, document, assertAuthority: value.assertAuthority })
  if (result.flight) liveFlights.add(result.flight)
  return result
}

function finish(flight: ReferenceEmbeddingDispatchFlight) {
  flight.finish()
  liveFlights.delete(flight)
}

function rows(value = a) { return readReferenceEmbeddingDispatches(value.runtime.database, value.document.documentId) }

function safeCleanupRoot(): string {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const root = path.resolve(temporaryRoot), parent = path.resolve(temporaryParent)
  const isChild = (base: string, target: string) => {
    const relative = path.relative(base, target)
    return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
  }
  if (!isChild(parent, root) || normalize(path.dirname(root)) !== normalize(parent)
    || !path.basename(root).startsWith('pk-embedding-recorder-')) throw new Error('FICTIONAL_RECORDER_CLEANUP_OUTSIDE_ROOT')
  for (const directory of [parent, root]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(fs.realpathSync.native(directory)) !== normalize(directory)) {
      throw new Error('FICTIONAL_RECORDER_CLEANUP_LINK')
    }
  }
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name), stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() || !isChild(root, fs.realpathSync.native(target))
        || normalize(fs.realpathSync.native(target)) !== normalize(target)) throw new Error('FICTIONAL_RECORDER_CLEANUP_LINK')
      if (stat.isDirectory()) pending.push(target)
    }
  }
  return root
}

beforeEach(() => {
  temporaryParent = fs.realpathSync.native(os.tmpdir())
  temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'pk-embedding-recorder-'))
  a = book('A')
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const flight of liveFlights) finish(flight)
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) projectRuntimeHost.releaseIdle(runtime)
  if (temporaryRoot) fs.rmSync(safeCleanupRoot(), { recursive: true, force: true })
  temporaryRoot = ''
})

describe('native reference embedding dispatch recorder', () => {
  it('issues a flight only for the actual admitted prepared INSERT while B is current', () => {
    const b = book('B'), before = b.runtime.database.serialize()
    const prepared = prepare()
    expect(prepared).toMatchObject({ conflict: false, existed: false })
    expect(prepared.flight).not.toBeNull()
    expect(a.runtime.database.prepare('SELECT state FROM import_reference_documents').pluck().get()).toBe('prepared')
    expect(rows()).toEqual([])
    expect(prepare()).toEqual({ conflict: false, existed: true, flight: null })
    expect(b.runtime.database.serialize()).toEqual(before)
    finish(prepared.flight!)
    expect(() => prepared.flight!.forBatch(0, 1)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
  })

  it.each(['contentHash', 'chunkSetHash', 'chunkCount', 'keyHash'] as const)('rejects an existing %s binding conflict without a flight', field => {
    const prepared = prepare()
    finish(prepared.flight!)
    const document = { ...a.document, [field]: field === 'chunkCount' ? 3 : hash(`different:${field}`) }
    expect(prepare(a, document)).toEqual({ conflict: true, existed: true, flight: null })
    expect(rows()).toEqual([])
  })

  it('rejects forged admission and outer-transaction capability escape without inserting', () => {
    const input = { resources: a.resources, admission: { ...a.admission }, runId,
      document: a.document, assertAuthority: a.assertAuthority }
    expect(() => prepareReferenceEmbeddingDocument(input)).toThrow('REFERENCE_IMPORT_ADMISSION_INVALID')
    expect(() => a.runtime.database.transaction(() => prepare())()).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
  })

  it('rejects an issued admission without a budget before document insertion', () => {
    const admission = captureReferenceImportAdmission(a.runtime, a.ref, hash('request:A'))
    expect(() => prepareReferenceEmbeddingDocument({ resources: a.resources, admission, runId,
      document: a.document, assertAuthority: a.assertAuthority })).toThrow('KNOWLEDGE_BASE_REFERENCE_BUDGET_REQUIRED')
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
    expect(rows()).toEqual([])
  })

  it('rejects cross-wired captured resources before any receipt or dispatch write', () => {
    const b = book('B')
    expect(() => prepareReferenceEmbeddingDocument({ resources: b.resources, admission: a.admission,
      runId, document: a.document, assertAuthority: a.assertAuthority })).toThrow('REFERENCE_IMPORT_ADMISSION_RESOURCES_CHANGED')
    for (const value of [a, b]) {
      expect(value.runtime.database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
      expect(rows(value)).toEqual([])
    }
  })

  it('rejects inherited outcome kinds and invalid run IDs as typed closed-contract barriers', () => {
    const inherited = Object.assign(Object.create({ kind: 'response_received' }), { httpStatus: 200, extra: 'not-own-kind' })
    expect(() => assertEmbeddingRequestOutcome(inherited)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    const hiddenReceived = Object.defineProperty({ httpStatus: 200, extra: 'not-enumerable-kind' }, 'kind', { value: 'response_received' })
    const hiddenUnknown = Object.defineProperty({ extra: 'not-enumerable-kind' }, 'kind', { value: 'transport_unknown' })
    expect(() => assertEmbeddingRequestOutcome(hiddenReceived)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    expect(() => assertEmbeddingRequestOutcome(hiddenUnknown)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    const badRecord = { dispatch_id: `reference-embedding:${a.document.documentId}:0`, import_run_id: '',
      document_id: a.document.documentId, batch_ordinal: 0, input_count: 1,
      state: 'dispatch_marked', http_status: null, marked_at: 0, settled_at: null }
    expect(() => assertReferenceEmbeddingDispatchRecord(badRecord)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    expect(() => prepareReferenceEmbeddingDocument({ resources: a.resources, admission: a.admission, runId: '',
      document: a.document, assertAuthority: a.assertAuthority })).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    expect(rows()).toEqual([])
  })

  it('rolls back a prepared INSERT and grants when a SQL hook revokes its admission', () => {
    a.runtime.database.exec(`CREATE TRIGGER revoke_prepared AFTER INSERT ON import_reference_documents BEGIN
      UPDATE reference_import_grants SET state='revoked',revision=revision+1,revoked_at=100 WHERE state='active'; END;`)
    expect(() => prepare()).toThrow('REFERENCE_IMPORT_GRANT_REVISION_CONFLICT')
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
    expect(a.grants.get(a.ref.grantId)).toMatchObject({ revision: 1, state: 'active' })
    expect(rows()).toEqual([])
    a.runtime.database.exec('DROP TRIGGER revoke_prepared')
    const prepared = prepare()
    finish(prepared.flight!)
  })

  it('cannot issue freshness when a SQL hook ignores the actual INSERT', () => {
    a.runtime.database.exec(`CREATE TRIGGER ignore_prepared BEFORE INSERT ON import_reference_documents BEGIN
      SELECT RAISE(IGNORE); END;`)
    expect(() => prepare()).toThrow('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM import_reference_documents').pluck().get()).toBe(0)
    expect(rows()).toEqual([])
    a.runtime.database.exec('DROP TRIGGER ignore_prepared')
  })

  it.each([
    { kind: 'response_received', httpStatus: 200 }, { kind: 'http_failed', httpStatus: 429 },
    { kind: 'response_invalid', httpStatus: 204 }, { kind: 'transport_unknown' },
  ] satisfies EmbeddingRequestOutcome[])('settles exactly its own nine-field mark once as $kind', outcome => {
    const flight = prepare().flight!, batch = flight.forBatch(0, 2)
    expect(() => batch.settled(outcome)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    batch.beforeDispatch()
    expect(Object.keys(rows()[0]!).sort()).toEqual([...REFERENCE_EMBEDDING_DISPATCH_FIELDS].sort())
    expect(rows()).toEqual([expect.objectContaining({ import_run_id: runId, document_id: a.document.documentId,
      batch_ordinal: 0, input_count: 2, state: 'dispatch_marked', http_status: null, settled_at: null })])
    expect(() => batch.beforeDispatch()).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    expect(() => flight.finish()).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    batch.settled(outcome)
    const settled = rows()
    expect(settled[0]).toMatchObject({ state: outcome.kind, http_status: 'httpStatus' in outcome ? outcome.httpStatus : null,
      settled_at: expect.any(Number) })
    expect(() => batch.settled({ kind: 'transport_unknown' })).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    expect(rows()).toEqual(settled)
    finish(flight)
  })

  it('allows ordered batches in one fresh flight and denies invalid ordinals and counts', () => {
    const flight = prepare().flight!
    for (const [ordinal, count] of [[-1, 1], [1, 1], [0, 0], [0.5, 1], [0, 1.5]]) {
      expect(() => flight.forBatch(ordinal!, count!)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    }
    const first = flight.forBatch(0, 1), second = flight.forBatch(1, 1)
    expect(() => second.beforeDispatch()).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    first.beforeDispatch()
    second.beforeDispatch()
    second.settled({ kind: 'http_failed', httpStatus: 503 })
    first.settled({ kind: 'response_received', httpStatus: 200 })
    expect(rows().map(row => row.batch_ordinal)).toEqual([0, 1])
    finish(flight)
  })

  it('rechecks source execution before mark and can truthfully settle after grant revocation', () => {
    const flight = prepare().flight!, first = flight.forBatch(0, 1), second = flight.forBatch(1, 1)
    first.beforeDispatch()
    a.grants.revoke(a.ref)
    expect(() => second.beforeDispatch()).toThrow('REFERENCE_IMPORT_GRANT_REVISION_CONFLICT')
    first.settled({ kind: 'transport_unknown' })
    expect(rows()).toEqual([expect.objectContaining({ state: 'transport_unknown' })])
    finish(flight)
  })

  it('does not mark after the original source execution is cancelled', () => {
    const flight = prepare().flight!, batch = flight.forBatch(0, 1)
    ImportRunRepository.cancelAtBoundary(runId, a.execution, a.runtime)
    expect(() => batch.beforeDispatch()).toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(rows()).toEqual([])
    finish(flight)
  })

  it('rolls back a mark when the admission post-check sees a SQL-hook revoke', () => {
    const flight = prepare().flight!, batch = flight.forBatch(0, 1)
    a.runtime.database.exec(`CREATE TRIGGER revoke_mark AFTER INSERT ON reference_embedding_dispatches BEGIN
      UPDATE reference_import_grants SET state='revoked',revision=revision+1,revoked_at=100 WHERE state='active'; END;`)
    expect(() => batch.beforeDispatch()).toThrow('REFERENCE_IMPORT_GRANT_REVISION_CONFLICT')
    expect(rows()).toEqual([])
    expect(a.grants.get(a.ref.grantId)).toMatchObject({ revision: 1, state: 'active' })
    expect(() => batch.settled({ kind: 'transport_unknown' })).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    a.runtime.database.exec('DROP TRIGGER revoke_mark')
    finish(flight)
  })

  it('keeps a failed settlement marked, returns only a hard safe error and cannot retry its token', () => {
    const flight = prepare().flight!, batch = flight.forBatch(0, 1)
    batch.beforeDispatch()
    a.runtime.database.exec(`CREATE TRIGGER fail_settlement BEFORE UPDATE ON reference_embedding_dispatches BEGIN
      SELECT RAISE(ABORT,'fictional-private-db-detail'); END;`)
    try { batch.settled({ kind: 'response_received', httpStatus: 200 }); expect.fail('expected a hard settlement barrier') }
    catch (error) {
      expect(error).toBeInstanceOf(EmbeddingDispatchBarrierError)
      expect(String(error)).toBe('EmbeddingDispatchBarrierError: REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
      expect(error).not.toHaveProperty('cause')
    }
    expect(rows()[0]!.state).toBe('dispatch_marked')
    a.runtime.database.exec('DROP TRIGGER fail_settlement')
    expect(() => batch.settled({ kind: 'transport_unknown' })).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    finish(flight)
    expect(() => assertNoReferenceEmbeddingDispatches(a.runtime.database, a.document.documentId))
      .toThrow('REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED')
  })

  it('blocks native maintenance until settlement drain, then retains document history across real reopen', () => {
    const flight = prepare().flight!, batch = flight.forBatch(0, 1)
    batch.beforeDispatch()
    expect(() => projectRuntimeHost.releaseIdle(a.runtime)).toThrow('PROJECT_RUNTIME_BUSY')
    batch.settled({ kind: 'transport_unknown' })
    finish(flight)
    const oldIdentity = a.runtime.databaseIdentity
    projectRuntimeHost.releaseIdle(a.runtime)
    openCanonicalProjectFixture(a.root)
    const reopened = projectRuntimeHost.getActiveView()!
    expect(reopened.databaseIdentity).not.toBe(oldIdentity)
    expect(() => assertNoReferenceEmbeddingDispatches(reopened.database, a.document.documentId))
      .toThrow('REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED')
    expect(readReferenceEmbeddingDispatches(reopened.database, a.document.documentId)[0]!.state).toBe('transport_unknown')
    expect(() => batch.beforeDispatch()).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
  })

  it('low-level writer requires native transaction, exact original mark and nonfrozen history', () => {
    const flight = prepare().flight!
    finish(flight)
    let frozen = false
    const repository = new ReferenceEmbeddingDispatchRepository(a.runtime.database, {
      assertCurrent: a.resources.assertResources, isFrozen: () => frozen, now: () => 100 })
    const input = { runId, documentId: a.document.documentId, batchOrdinal: 0, inputCount: 2 }
    expect(() => repository.mark(input)).toThrow('REFERENCE_EMBEDDING_DISPATCH_INVALID')
    const mark = a.runtime.database.transaction(() => repository.mark(input))()
    expect(() => a.runtime.database.transaction(() => repository.mark(input))())
      .toThrow('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
    expect(() => a.runtime.database.transaction(() => repository.settle({ ...mark, input_count: 1 }, { kind: 'transport_unknown' }))())
      .toThrow('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
    frozen = true
    expect(() => a.runtime.database.transaction(() => repository.settle(mark, { kind: 'transport_unknown' }))())
      .toThrow('REFERENCE_EMBEDDING_DISPATCH_FROZEN')
    frozen = false
    a.runtime.database.transaction(() => repository.settle(mark, { kind: 'response_invalid', httpStatus: 200 }))()
    expect(() => a.runtime.database.transaction(() => repository.settle(mark, { kind: 'transport_unknown' }))())
      .toThrow('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
    const otherRunId = 'fictional-other-dispatch-run'
    a.runtime.database.prepare(`INSERT INTO import_runs
      (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count)
      VALUES(?,'reference',?,'','','','en-US',1,1)`).run(otherRunId, otherRunId)
    a.runtime.database.transaction(() => repository.mark({ ...input, runId: otherRunId, batchOrdinal: 1 }))()
    expect(rows().map(row => row.import_run_id)).toEqual([runId, otherRunId])
    expect(() => assertNoReferenceEmbeddingDispatches(a.runtime.database, a.document.documentId))
      .toThrow('REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED')
  })
})
