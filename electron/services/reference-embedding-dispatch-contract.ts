import { assertReferenceImportGrantId } from '../../src/shared/reference-import-grant'
import { isContentHash } from '../../src/shared/source-ref'
import type { ImportQueryErrorCode } from './import-query-contract'
import type { ReferenceEmbeddingBudgetErrorCode } from './reference-embedding-budget-contract'

export type EmbeddingRequestOutcome =
  | { kind: 'response_received'; httpStatus: number }
  | { kind: 'http_failed'; httpStatus: number }
  | { kind: 'response_invalid'; httpStatus: number }
  | { kind: 'transport_unknown' }

export interface EmbeddingRequestLifecycle {
  beforeDispatch(): void
  settled(outcome: EmbeddingRequestOutcome): void
}

export interface EmbeddingBatchObserver {
  forBatch(batchOrdinal: number, inputCount: number): EmbeddingRequestLifecycle
}

export type EmbeddingDispatchBarrierCode =
  | 'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED'
  | 'REFERENCE_EMBEDDING_PREPARED_UNPROVEN'
  | 'REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED'
  | 'REFERENCE_EMBEDDING_DISPATCH_INVALID'
  | 'REFERENCE_EMBEDDING_DISPATCH_FROZEN'
  | ReferenceEmbeddingBudgetErrorCode
  | ImportQueryErrorCode

/** This hard boundary must not become ordinary network-error FTS fallback. */
export class EmbeddingDispatchBarrierError extends Error {
  constructor(readonly code: EmbeddingDispatchBarrierCode) {
    super(code)
    this.name = 'EmbeddingDispatchBarrierError'
  }
}

function invalid(): never { throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_INVALID') }
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function referenceEmbeddingDispatchId(documentId: string, batchOrdinal: number): string {
  if (!isContentHash(documentId) || !integer(batchOrdinal)) invalid()
  return `reference-embedding:${documentId}:${batchOrdinal}`
}

export function assertEmbeddingRequestOutcome(value: unknown): asserts value is EmbeddingRequestOutcome {
  if (!record(value) || !Object.prototype.hasOwnProperty.call(value, 'kind')) invalid()
  const keys = Object.keys(value)
  if (value.kind === 'transport_unknown') {
    if (keys.length !== 1 || keys[0] !== 'kind') invalid()
    return
  }
  if (!['response_received', 'http_failed', 'response_invalid'].includes(value.kind as string)
    || keys.length !== 2 || !keys.includes('kind') || !keys.includes('httpStatus') || !integer(value.httpStatus, 100)
    || value.httpStatus > 599) invalid()
  const successful = value.httpStatus >= 200 && value.httpStatus <= 299
  if (successful === (value.kind === 'http_failed')) invalid()
}

export interface ReferenceEmbeddingDispatchRecord {
  dispatch_id: string
  import_run_id: string
  document_id: string
  batch_ordinal: number
  input_count: number
  state: 'dispatch_marked' | EmbeddingRequestOutcome['kind']
  http_status: number | null
  /** Actual local wall-clock milliseconds; clock adjustment is not a new ordering authority. */
  marked_at: number
  settled_at: number | null
}

export const REFERENCE_EMBEDDING_DISPATCH_FIELDS = [
  'dispatch_id', 'import_run_id', 'document_id', 'batch_ordinal', 'input_count',
  'state', 'http_status', 'marked_at', 'settled_at',
] as const

export function assertReferenceEmbeddingDispatchRecord(value: unknown): asserts value is ReferenceEmbeddingDispatchRecord {
  if (!record(value) || Object.keys(value).length !== REFERENCE_EMBEDDING_DISPATCH_FIELDS.length
    || Object.keys(value).some(key => !(REFERENCE_EMBEDDING_DISPATCH_FIELDS as readonly string[]).includes(key))) invalid()
  try { assertReferenceImportGrantId(value.import_run_id) } catch { invalid() }
  if (typeof value.document_id !== 'string' || !integer(value.batch_ordinal)
    || value.dispatch_id !== referenceEmbeddingDispatchId(value.document_id, value.batch_ordinal)
    || !integer(value.input_count, 1) || !integer(value.marked_at)) invalid()
  if (value.state === 'dispatch_marked') {
    if (value.http_status !== null || value.settled_at !== null) invalid()
  } else {
    if (!integer(value.settled_at)) invalid()
    assertEmbeddingRequestOutcome(value.state === 'transport_unknown'
      ? { kind: value.state }
      : { kind: value.state, httpStatus: value.http_status })
    if (value.state === 'transport_unknown' && value.http_status !== null) invalid()
  }
}
