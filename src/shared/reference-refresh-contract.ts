import type { ImportRunExecutionAuthority, ImportRunSnapshot } from './import-run'
import type { ReferenceKnowledgeReference } from './reference-knowledge-contract'
import { assertReferenceImportGrantId, assertReferenceImportGrantOperationId } from './reference-import-grant'

export const REFERENCE_REFRESH_CHANNELS = [
  'reference-knowledge:v1:refresh', 'reference-knowledge:v1:refresh-ack',
] as const

export interface ReferenceRefreshRequest {
  reference: ReferenceKnowledgeReference
  execution: ImportRunExecutionAuthority
}
export interface ReferenceRefreshAckRequest extends ReferenceRefreshRequest {
  token: string
  decision: 'completed' | 'failed' | 'cancelled'
}
export interface ReferenceRefreshAckResult { version: 1 }
export interface ReferenceRefreshSuccess {
  version: 1
  run: ImportRunSnapshot
  execution: null
  replayed: boolean
}
export type ReferenceRefreshResult = ({ success: true } & ReferenceRefreshSuccess)
  | { success: false; error: string; errorCode: string }
export type ReferenceRefreshProgress = ReferenceRefreshRequest & {
  leaseId: string
  sequence: number
} & ({ kind: 'refresh'; token: string } | { kind: 'progress'; progress: 100 })
export interface ReferenceRefreshEvents {
  'reference-knowledge:v1:refresh-progress': ReferenceRefreshProgress
}
export interface ReferenceRefreshChannels {
  'reference-knowledge:v1:refresh': { args: [ReferenceRefreshRequest]; return: ReferenceRefreshResult }
  'reference-knowledge:v1:refresh-ack': { args: [ReferenceRefreshAckRequest]; return: ReferenceRefreshAckResult }
}

function fail(): never { throw new Error('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID') }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) fail()
}
function id(value: unknown): void { try { assertReferenceImportGrantId(value) } catch { fail() } }
function operation(value: unknown): void { try { assertReferenceImportGrantOperationId(value) } catch { fail() } }
function positive(value: unknown): void { if (!Number.isSafeInteger(value) || Number(value) < 1) fail() }
function identity(value: Record<string, unknown>): void {
  object(value.reference, ['projectId', 'runId', 'grantId', 'revision'])
  id(value.reference.projectId); id(value.reference.runId); operation(value.reference.grantId); positive(value.reference.revision)
  object(value.execution, ['owner', 'epoch'])
  operation(value.execution.owner); positive(value.execution.epoch)
}

export function assertReferenceRefreshRequest<C extends keyof ReferenceRefreshChannels>(
  channel: C, value: unknown,
): asserts value is ReferenceRefreshChannels[C]['args'][0] {
  if (channel === 'reference-knowledge:v1:refresh') {
    object(value, ['reference', 'execution'])
    identity(value)
    return
  }
  if (channel === 'reference-knowledge:v1:refresh-ack') {
    object(value, ['reference', 'execution', 'token', 'decision'])
    identity(value); operation(value.token)
    if (value.decision !== 'completed' && value.decision !== 'failed' && value.decision !== 'cancelled') fail()
    return
  }
  fail()
}

/** Projection readiness is never evidence of a domain commit or author approval. */
export function isReferenceRefreshProgress(value: unknown): value is ReferenceRefreshProgress {
  try {
    if (!value || typeof value !== 'object' || !('kind' in value)) return false
    const fields = value as Record<string, unknown>
    if (fields.kind === 'refresh') {
      object(fields, ['reference', 'execution', 'leaseId', 'sequence', 'kind', 'token'])
      operation(fields.token)
    } else if (fields.kind === 'progress') {
      object(fields, ['reference', 'execution', 'leaseId', 'sequence', 'kind', 'progress'])
      if (fields.progress !== 100) return false
    } else return false
    identity(fields); id(fields.leaseId); positive(fields.sequence)
    return true
  } catch { return false }
}
