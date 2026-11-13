import { assertReferenceImportGrantId } from '../../src/shared/reference-import-grant'
import { isContentHash } from '../../src/shared/source-ref'
import { EmbeddingDispatchBarrierError } from './reference-embedding-dispatch-contract'

export const REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION = 'reference-embedding-budget-v1' as const
/** New embedding policy uses the existing application's 3,600,000 / 32 millisecond unit. */
export const REFERENCE_EMBEDDING_BUDGET_MS_PER_REQUEST = 112_500
export const REFERENCE_EMBEDDING_BUDGET_FIELDS = [
  'root_run_id', 'manifest_fingerprint', 'policy_version', 'initial_chunk_size', 'initial_chunk_overlap',
  'initial_batch_size', 'request_limit', 'active_limit_ms', 'spent_requests', 'active_elapsed_ms',
  'active_since_ms', 'state',
] as const

export type ReferenceEmbeddingBudgetErrorCode = `KNOWLEDGE_BASE_REFERENCE_BUDGET_${
  'REQUIRED' | 'INVALID' | 'EXHAUSTED' | 'ACTIVE_TIME_EXHAUSTED' | 'RECOVERY_UNKNOWN'
  | 'HISTORY_UNBUDGETED' | 'PLAN_CONFLICT' | 'PERSISTENCE_FAILED' | 'HISTORY_FROZEN'}`

export interface ReferenceEmbeddingBudgetPlan {
  chunkSize: number
  chunkOverlap: number
  batchSize: number
  requestLimit: number
}
interface BudgetIdentity {
  root_run_id: string
  policy_version: typeof REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION
}
export interface ExecutableReferenceEmbeddingBudgetRecord extends BudgetIdentity {
  /** Null only in a frozen portable projection; never executable. */
  manifest_fingerprint: string | null
  initial_chunk_size: number
  initial_chunk_overlap: number
  initial_batch_size: number
  request_limit: number
  active_limit_ms: number
  spent_requests: number
  active_elapsed_ms: number
  active_since_ms: number | null
  state: 'ready' | 'recovery_unknown'
}
export interface LegacyReferenceEmbeddingBudgetRecord extends BudgetIdentity {
  manifest_fingerprint: null
  initial_chunk_size: null
  initial_chunk_overlap: null
  initial_batch_size: null
  request_limit: null
  active_limit_ms: null
  spent_requests: null
  active_elapsed_ms: null
  active_since_ms: null
  state: 'legacy_unbudgeted'
}
export type ReferenceEmbeddingBudgetRecord = ExecutableReferenceEmbeddingBudgetRecord | LegacyReferenceEmbeddingBudgetRecord

export function referenceEmbeddingBudgetFailure(code: ReferenceEmbeddingBudgetErrorCode): never {
  throw new EmbeddingDispatchBarrierError(code)
}
function invalid(): never { return referenceEmbeddingBudgetFailure('KNOWLEDGE_BASE_REFERENCE_BUDGET_INVALID') }
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function assertReferenceEmbeddingBudgetPlan(value: unknown): asserts value is ReferenceEmbeddingBudgetPlan {
  if (!record(value) || Object.keys(value).length !== 4
    || !['chunkSize', 'chunkOverlap', 'batchSize', 'requestLimit'].every(key => Object.hasOwn(value, key))
    || !integer(value.chunkSize, 100) || value.chunkSize > 4000
    || !integer(value.chunkOverlap) || value.chunkOverlap >= value.chunkSize
    || !integer(value.batchSize, 1) || value.batchSize > 50 || !integer(value.requestLimit, 1)
    || !Number.isSafeInteger(value.requestLimit * REFERENCE_EMBEDDING_BUDGET_MS_PER_REQUEST)) invalid()
}

/** Closed historical representation; readability is not an execution capability. */
export function assertReferenceEmbeddingBudgetRecord(value: unknown): asserts value is ReferenceEmbeddingBudgetRecord {
  if (!record(value) || Object.keys(value).length !== REFERENCE_EMBEDDING_BUDGET_FIELDS.length
    || Object.keys(value).some(key => !(REFERENCE_EMBEDDING_BUDGET_FIELDS as readonly string[]).includes(key))
    || value.policy_version !== REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION) invalid()
  try { assertReferenceImportGrantId(value.root_run_id) } catch { invalid() }
  if (value.state === 'legacy_unbudgeted') {
    if (REFERENCE_EMBEDDING_BUDGET_FIELDS.some(key => !['root_run_id', 'policy_version', 'state'].includes(key)
      && value[key] !== null)) invalid()
    return
  }
  if (value.state !== 'ready' && value.state !== 'recovery_unknown'
    || value.manifest_fingerprint !== null && (typeof value.manifest_fingerprint !== 'string'
      || !isContentHash(value.manifest_fingerprint))) invalid()
  assertReferenceEmbeddingBudgetPlan({ chunkSize: value.initial_chunk_size, chunkOverlap: value.initial_chunk_overlap,
    batchSize: value.initial_batch_size, requestLimit: value.request_limit })
  if (!integer(value.active_limit_ms, 1)
    || value.active_limit_ms !== (value.request_limit as number) * REFERENCE_EMBEDDING_BUDGET_MS_PER_REQUEST
    || !integer(value.spent_requests) || value.spent_requests > (value.request_limit as number)
    || !integer(value.active_elapsed_ms) || value.active_since_ms !== null && !integer(value.active_since_ms)) invalid()
}
