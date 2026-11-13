import type Database from 'better-sqlite3'
import type { ReferenceImportResources } from '../knowledge-base'
import { isContentHash } from '../../src/shared/source-ref'
import { assertReferenceImportGrantId } from '../../src/shared/reference-import-grant'
import { readReferenceEmbeddingDispatches, ReferenceEmbeddingDispatchRepository } from '../repositories/reference-embedding-dispatch-repository'
import { assertIssuedReferenceImportAdmission, type ReferenceImportAdmission } from './reference-import-admission'
import { EmbeddingDispatchBarrierError, type EmbeddingBatchObserver, type EmbeddingRequestOutcome,
  type ReferenceEmbeddingDispatchRecord } from './reference-embedding-dispatch-contract'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import { projectRuntimeHost } from './project-runtime'

export interface ReferenceEmbeddingDispatchFlight extends EmbeddingBatchObserver {
  /** Call only after every physical request and settlement has drained. */
  finish(): void
}

const flights = new WeakSet<object>()
const marks = new WeakSet<object>()
function invalid(): never { throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_INVALID') }
function persist<T>(operation: () => T): T {
  try { return operation() }
  catch (error) {
    if (error instanceof EmbeddingDispatchBarrierError) throw error
    throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
  }
}
function synchronous(operation: () => void): void {
  if (Object.prototype.toString.call(operation) === '[object AsyncFunction]') invalid()
  const result: unknown = operation()
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => {})
    invalid()
  }
}

export function assertNoReferenceEmbeddingDispatches(database: Database.Database, documentId: string): void {
  if (readReferenceEmbeddingDispatches(database, documentId).length) {
    throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED')
  }
}

/** An actual admitted INSERT, never a caller's assertion of freshness, creates this invocation's capability. */
export function prepareReferenceEmbeddingDocument(input: {
  resources: ReferenceImportResources
  admission: ReferenceImportAdmission
  runId: string
  document: { documentId: string; keyHash: string; contentHash: string; chunkSetHash: string; chunkCount: number }
  assertAuthority(): void
}): { conflict: boolean; existed: boolean; flight: ReferenceEmbeddingDispatchFlight | null } {
  assertIssuedReferenceImportAdmission(input.admission)
  try { assertReferenceImportGrantId(input.runId) } catch { invalid() }
  const { resources, admission, runId, assertAuthority } = input
  const budget = admission.budget
  if (!budget) throw new EmbeddingDispatchBarrierError('KNOWLEDGE_BASE_REFERENCE_BUDGET_REQUIRED')
  const document = Object.freeze({ ...input.document })
  if (![document.documentId, document.keyHash, document.contentHash, document.chunkSetHash].every(isContentHash)
    || !Number.isSafeInteger(document.chunkCount) || document.chunkCount < 1) invalid()
  const { database, canonicalRoot, databaseIdentity, executionEpoch } = resources
  // A returned capability must never outlive a caller's later outer-transaction rollback.
  if (database.inTransaction) invalid()
  const runtime = projectRuntimeHost.getByRoot(canonicalRoot)
  if (!runtime || runtime.database !== database || runtime.databaseIdentity !== databaseIdentity
    || runtime.executionEpoch !== executionEpoch) invalid()
  const assertNative = () => {
    synchronous(resources.assertResources)
    projectRuntimeHost.assertOpen(runtime)
    if (!database.open || resources.database !== database || resources.canonicalRoot !== canonicalRoot
      || resources.databaseIdentity !== databaseIdentity || resources.executionEpoch !== executionEpoch
      || runtime.database !== database || runtime.databaseIdentity !== databaseIdentity || runtime.executionEpoch !== executionEpoch
      || projectRuntimeHost.getByRoot(canonicalRoot) !== runtime) invalid()
  }
  const recorder = new ReferenceEmbeddingDispatchRepository(database, { assertCurrent: assertNative,
    isFrozen: id => readPortableRuntimeFreeze(canonicalRoot).isFrozen('reference_embedding_dispatches', id) })
  const readReceipts = () => persist(() => database.prepare(`SELECT document_id,idempotency_key_hash,content_hash,chunk_set_hash,
    expected_chunk_count,corpus_kind,state FROM import_reference_documents
    WHERE document_id=? OR idempotency_key_hash=?`).all(document.documentId, document.keyHash)) as Array<Record<string, unknown>>
  const matches = (receipt: Record<string, unknown>) => receipt.document_id === document.documentId
    && receipt.idempotency_key_hash === document.keyHash && receipt.content_hash === document.contentHash
    && receipt.chunk_set_hash === document.chunkSetHash && receipt.expected_chunk_count === document.chunkCount
    && receipt.corpus_kind === 'reference'
  let release = () => {}
  let issued: ReferenceEmbeddingDispatchFlight | null = null
  let budgetFlight: ReturnType<NonNullable<ReferenceImportAdmission['budget']>['openFlight']> | null = null
  try {
    return admission.withTransaction(resources, runId, () => {
      assertNative()
      synchronous(assertAuthority)
      const receipts = readReceipts()
      if (receipts.length) {
        const receipt = receipts[0]!
        const conflict = receipts.length !== 1 || !matches(receipt) || !['prepared', 'committed'].includes(String(receipt.state))
        return { conflict, existed: true, flight: null }
      }
      const inserted = persist(() => database.prepare(`INSERT INTO import_reference_documents
        (document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state)
        VALUES(?,?,?,?,?,'reference','prepared')`)
        .run(document.documentId, document.keyHash, document.contentHash, document.chunkSetHash, document.chunkCount))
      const fresh = readReceipts()
      if (inserted.changes !== 1 || fresh.length !== 1 || !matches(fresh[0]!) || fresh[0]!.state !== 'prepared') {
        throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
      }
      budget.assertEffect()
      budgetFlight = budget.openFlight()
      release = projectRuntimeHost.acquireWork(runtime)
      let nextBatch = 0
      let nextDispatch = 0
      let pending = 0
      const flight: ReferenceEmbeddingDispatchFlight = Object.freeze({
        forBatch(batchOrdinal: number, inputCount: number) {
          if (!flights.has(flight) || !Number.isSafeInteger(batchOrdinal) || batchOrdinal !== nextBatch
            || !Number.isSafeInteger(inputCount) || inputCount < 1) invalid()
          nextBatch += 1
          const token = Object.freeze({})
          let mark: ReferenceEmbeddingDispatchRecord | null = null
          let attempted = false
          return Object.freeze({
            beforeDispatch() {
              if (!flights.has(flight) || attempted || batchOrdinal !== nextDispatch) invalid()
              attempted = true
              mark = admission.withTransaction(resources, runId, () => {
                assertNative()
                synchronous(assertAuthority)
                const current = readReceipts()
                if (current.length !== 1 || !matches(current[0]!) || current[0]!.state !== 'prepared') invalid()
                return budget.beforeDispatch(budgetFlight!,
                  () => recorder.mark({ runId, documentId: document.documentId, batchOrdinal, inputCount }))
              })
              marks.add(token)
              pending += 1
              nextDispatch += 1
            },
            settled(outcome: EmbeddingRequestOutcome) {
              if (!flights.has(flight) || !marks.has(token) || !mark) invalid()
              marks.delete(token)
              try { persist(() => database.transaction(() => {
                assertNative()
                budget.settle(budgetFlight!, mark!, () => recorder.settle(mark!, outcome))
              }).immediate()) }
              finally { pending -= 1 }
            },
          })
        },
        finish() {
          if (!flights.has(flight) || pending !== 0) invalid()
          flights.delete(flight)
          try { budget.finish(budgetFlight!) }
          finally {
            release()
            release = () => {}
          }
        },
      })
      issued = flight
      flights.add(flight)
      return { conflict: false, existed: false, flight }
    })
  } catch (error) {
    if (issued) flights.delete(issued)
    if (budgetFlight) {
      try { budget.finish(budgetFlight) } catch { /* Preserve the issuance failure; no request escaped its rolled-back admission. */ }
    }
    release()
    throw error
  }
}
