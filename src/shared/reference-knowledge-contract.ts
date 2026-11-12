import type { ImportRunExecutionLease, ImportRunStartResult } from './import-run'
import { assertReferenceImportGrantId, assertReferenceImportGrantOperationId } from './reference-import-grant'

export const REFERENCE_KNOWLEDGE_CHANNELS = Object.freeze([
  'reference-knowledge:v1:prepare', 'reference-knowledge:v1:resume',
  'reference-knowledge:v1:import', 'reference-knowledge:v1:revoke',
  'reference-knowledge:v1:complete',
] as const)

/** Public evidence only; execution additionally requires a private main-process sender issuance. */
export interface ReferenceKnowledgeReference {
  projectId: string
  runId: string
  grantId: string
  revision: number
}

export interface PrepareReferenceKnowledgeRequest {
  operationId: string
  runId: string
  executionOwner: string
}

export interface ReferenceKnowledgeImportResult {
  success: boolean
  docId?: string
  chunkCount?: number
  idempotent?: boolean
  error?: string
  errorCode?: string
}

export interface ReferenceKnowledgeChannels {
  'reference-knowledge:v1:prepare': { args: [PrepareReferenceKnowledgeRequest]; return: {
    reference: ReferenceKnowledgeReference
    execution: ImportRunExecutionLease
  } }
  'reference-knowledge:v1:resume': { args: [ReferenceKnowledgeReference]; return: ImportRunStartResult }
  'reference-knowledge:v1:import': { args: [{
    reference: ReferenceKnowledgeReference
    chapterNumber: number
    execution: { owner: string; epoch: number }
  }]; return: ReferenceKnowledgeImportResult }
  'reference-knowledge:v1:revoke': { args: [ReferenceKnowledgeReference]; return: { state: 'revoked' | 'completed' } }
  'reference-knowledge:v1:complete': { args: [ReferenceKnowledgeReference]; return: { state: 'completed' } }
}

export type ReferenceKnowledgeChannel = keyof ReferenceKnowledgeChannels

export function isReferenceKnowledgeChannel(channel: string): channel is ReferenceKnowledgeChannel {
  return (REFERENCE_KNOWLEDGE_CHANNELS as readonly string[]).includes(channel)
}

export function referenceKnowledgeRequiresView(channel: ReferenceKnowledgeChannel): boolean {
  return channel !== 'reference-knowledge:v1:revoke'
}

function fail(): never { throw new Error('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID') }

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || keys.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !keys.includes(key))) fail()
}

function identifier(value: unknown): void {
  try { assertReferenceImportGrantId(value) } catch { fail() }
}

function operationId(value: unknown): void {
  try { assertReferenceImportGrantOperationId(value) } catch { fail() }
}

function positiveInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail()
}

function assertReference(value: unknown): asserts value is ReferenceKnowledgeReference {
  object(value, ['projectId', 'runId', 'grantId', 'revision'])
  identifier(value.projectId)
  identifier(value.runId)
  operationId(value.grantId)
  positiveInteger(value.revision)
}

export function assertReferenceKnowledgeRequest<C extends ReferenceKnowledgeChannel>(
  channel: C, value: unknown,
): asserts value is ReferenceKnowledgeChannels[C]['args'][0] {
  switch (channel) {
    case 'reference-knowledge:v1:prepare':
      object(value, ['operationId', 'runId', 'executionOwner'])
      operationId(value.operationId)
      identifier(value.runId)
      operationId(value.executionOwner)
      return
    case 'reference-knowledge:v1:resume':
    case 'reference-knowledge:v1:revoke':
    case 'reference-knowledge:v1:complete':
      assertReference(value)
      return
    case 'reference-knowledge:v1:import':
      object(value, ['reference', 'chapterNumber', 'execution'])
      assertReference(value.reference)
      positiveInteger(value.chapterNumber)
      object(value.execution, ['owner', 'epoch'])
      operationId(value.execution.owner)
      positiveInteger(value.execution.epoch)
      return
    default:
      throw new Error('KNOWLEDGE_BASE_REFERENCE_CHANNEL_NOT_ALLOWED')
  }
}
