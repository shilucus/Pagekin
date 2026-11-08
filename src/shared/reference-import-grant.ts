import { isContentHash } from './source-ref'

export const REFERENCE_IMPORT_GRANT_ACTION = 'reference-import-v1' as const
export type ReferenceImportGrantState = 'active' | 'completed' | 'revoked'

export interface ReferenceImportGrantRef {
  grantId: string
  revision: number
  runId: string
}

/** Readable history is not an execution capability, including rows with retained hashes. */
export interface ReferenceImportGrant extends ReferenceImportGrantRef {
  operationKey: string
  projectId: string
  action: typeof REFERENCE_IMPORT_GRANT_ACTION
  manifestFingerprint: string | null
  requestHash: string | null
  state: ReferenceImportGrantState
  decisionSource: 'author-action'
  createdAt: number
  completedAt: number | null
  revokedAt: number | null
}

export interface IssueReferenceImportGrant {
  grantId: string
  operationKey: string
  runId: string
  manifestFingerprint: string
  requestHash: string
  createdAt?: number
}

const identifier = /^[\p{L}\p{N}._:@+-]{1,512}$/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function referenceImportGrantFail(code: string): never { throw new Error(`REFERENCE_IMPORT_GRANT_${code}`) }

export function assertReferenceImportGrantId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) referenceImportGrantFail('ID_INVALID')
}

export function assertReferenceImportGrantOperationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) referenceImportGrantFail('ID_INVALID')
}

export function referenceImportGrantInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) referenceImportGrantFail('INVALID')
  return Number(value)
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) referenceImportGrantFail('PAYLOAD_INVALID')
}

export function assertReferenceImportGrantRef(value: unknown): asserts value is ReferenceImportGrantRef {
  object(value, ['grantId', 'revision', 'runId'])
  assertReferenceImportGrantOperationId(value.grantId)
  assertReferenceImportGrantId(value.runId)
  referenceImportGrantInteger(value.revision, 1)
}

export function assertIssueReferenceImportGrant(value: unknown): asserts value is IssueReferenceImportGrant {
  object(value, ['grantId', 'operationKey', 'runId', 'manifestFingerprint', 'requestHash'], ['createdAt'])
  assertReferenceImportGrantOperationId(value.grantId)
  assertReferenceImportGrantOperationId(value.operationKey)
  assertReferenceImportGrantId(value.runId)
  if (typeof value.manifestFingerprint !== 'string' || !isContentHash(value.manifestFingerprint)
    || typeof value.requestHash !== 'string' || !isContentHash(value.requestHash)) referenceImportGrantFail('HASH_INVALID')
  if (Object.hasOwn(value, 'createdAt')) referenceImportGrantInteger(value.createdAt)
}
