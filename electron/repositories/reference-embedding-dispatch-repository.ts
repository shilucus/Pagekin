import type Database from 'better-sqlite3'
import { isContentHash } from '../../src/shared/source-ref'
import { assertEmbeddingRequestOutcome, assertReferenceEmbeddingDispatchRecord, EmbeddingDispatchBarrierError,
  referenceEmbeddingDispatchId, type EmbeddingRequestOutcome,
  type ReferenceEmbeddingDispatchRecord } from '../services/reference-embedding-dispatch-contract'

function invalid(): never { throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_INVALID') }
function persistence(): never { throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED') }

/** Read-only document scope deliberately spans every run and grant. */
export function readReferenceEmbeddingDispatches(database: Database.Database, documentId: string): ReferenceEmbeddingDispatchRecord[] {
  if (!isContentHash(documentId)) invalid()
  try {
    return (database.prepare('SELECT * FROM reference_embedding_dispatches WHERE document_id=? ORDER BY batch_ordinal')
      .all(documentId) as unknown[]).map(value => {
      assertReferenceEmbeddingDispatchRecord(value)
      return Object.freeze({ ...value })
    })
  } catch (error) {
    if (error instanceof EmbeddingDispatchBarrierError) throw error
    return persistence()
  }
}

/** Low-level synchronous writer. Only the main factory issues physical-flight/mark capabilities. */
export class ReferenceEmbeddingDispatchRepository {
  constructor(private readonly database: Database.Database, private readonly options: {
    assertCurrent(): void
    isFrozen(dispatchId: string): boolean
    now?(): number
  }) {}

  private current(dispatchId: string): void {
    if (!this.database.open || !this.database.inTransaction) invalid()
    if (Object.prototype.toString.call(this.options.assertCurrent) === '[object AsyncFunction]') invalid()
    const current: unknown = this.options.assertCurrent()
    if (current !== undefined) {
      if (current instanceof Promise) void current.catch(() => {})
      invalid()
    }
    const frozen: unknown = this.options.isFrozen(dispatchId)
    if (typeof frozen !== 'boolean') invalid()
    if (frozen) throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_FROZEN')
  }

  private exact(record: ReferenceEmbeddingDispatchRecord): void {
    const stored = this.database.prepare('SELECT * FROM reference_embedding_dispatches WHERE dispatch_id=?').get(record.dispatch_id)
    assertReferenceEmbeddingDispatchRecord(stored)
    if (Object.entries(record).some(([key, value]) => stored[key as keyof ReferenceEmbeddingDispatchRecord] !== value)) persistence()
  }

  mark(input: { runId: string; documentId: string; batchOrdinal: number; inputCount: number }): ReferenceEmbeddingDispatchRecord {
    const record: ReferenceEmbeddingDispatchRecord = { dispatch_id: referenceEmbeddingDispatchId(input.documentId, input.batchOrdinal),
      import_run_id: input.runId, document_id: input.documentId, batch_ordinal: input.batchOrdinal, input_count: input.inputCount,
      state: 'dispatch_marked', http_status: null, marked_at: (this.options.now ?? Date.now)(), settled_at: null }
    assertReferenceEmbeddingDispatchRecord(record)
    this.current(record.dispatch_id)
    try {
      const result = this.database.prepare(`INSERT INTO reference_embedding_dispatches
        (dispatch_id,import_run_id,document_id,batch_ordinal,input_count,state,http_status,marked_at,settled_at)
        VALUES(?,?,?,?,?,'dispatch_marked',NULL,?,NULL)`)
        .run(record.dispatch_id, record.import_run_id, record.document_id, record.batch_ordinal, record.input_count, record.marked_at)
      if (result.changes !== 1) persistence()
      this.exact(record)
      this.current(record.dispatch_id)
      return Object.freeze(record)
    } catch (error) {
      if (error instanceof EmbeddingDispatchBarrierError) throw error
      return persistence()
    }
  }

  settle(mark: ReferenceEmbeddingDispatchRecord, outcome: EmbeddingRequestOutcome): void {
    assertReferenceEmbeddingDispatchRecord(mark)
    assertEmbeddingRequestOutcome(outcome)
    if (mark.state !== 'dispatch_marked') invalid()
    const settled: ReferenceEmbeddingDispatchRecord = { ...mark, state: outcome.kind,
      http_status: outcome.kind === 'transport_unknown' ? null : outcome.httpStatus,
      settled_at: (this.options.now ?? Date.now)() }
    assertReferenceEmbeddingDispatchRecord(settled)
    this.current(mark.dispatch_id)
    try {
      const result = this.database.prepare(`UPDATE reference_embedding_dispatches SET state=?,http_status=?,settled_at=?
        WHERE dispatch_id=? AND import_run_id=? AND document_id=? AND batch_ordinal=? AND input_count=?
          AND state='dispatch_marked' AND http_status IS NULL AND marked_at=? AND settled_at IS NULL`)
        .run(settled.state, settled.http_status, settled.settled_at, mark.dispatch_id, mark.import_run_id,
          mark.document_id, mark.batch_ordinal, mark.input_count, mark.marked_at)
      if (result.changes !== 1) persistence()
      this.exact(settled)
      this.current(mark.dispatch_id)
    } catch (error) {
      if (error instanceof EmbeddingDispatchBarrierError) throw error
      persistence()
    }
  }
}
