import type { ImportRunSnapshot, ImportRunStartResult } from './import-run'
import type { ReferenceGlobalResult } from './reference-global-contract'
import type { ReferenceStyleResult } from './reference-style-contract'
import type { ReferenceBlueprintResult } from './reference-blueprint-contract'
import { assertReferenceRefreshRequest } from './reference-refresh-contract'
import type { ReferenceRefreshRequest, ReferenceRefreshSuccess } from './reference-refresh-contract'
import { assertReferenceImportGrantOperationId } from './reference-import-grant'

export const REFERENCE_RUN_STAGES = ['knowledge', 'global', 'style', 'blueprints', 'refresh'] as const
export type ReferenceRunStage = typeof REFERENCE_RUN_STAGES[number]
export const REFERENCE_RUN_CHANNELS = ['reference-run:v1:execute', 'reference-run:v1:projection-ack'] as const

export interface ReferenceRunRequest extends ReferenceRefreshRequest {
  /** Freeze the existing author-selected planning route; null may recover an existing root, never a guessed default. */
  modelId: string | null
}
export type ReferenceRunCompletion =
  | { stage: 'knowledge'; result: ImportRunStartResult }
  | { stage: 'global'; result: ReferenceGlobalResult }
  | { stage: 'style'; result: ReferenceStyleResult }
  | { stage: 'blueprints'; result: ReferenceBlueprintResult }
  | { stage: 'refresh'; result: ReferenceRefreshSuccess }
export interface ReferenceRunProjectionAck extends ReferenceRefreshRequest {
  stage: ReferenceRunStage
  token: string
  decision: 'settled' | 'cancelled' | 'projection-failed'
}
export interface ReferenceRunProjectionAckResult { version: 1 }
export type ReferenceRunResponse = ({ success: true } & ReferenceRefreshSuccess)
  | { success: false; error: string; errorCode: string; completionFailureCode?: string; postCommitSyncBatchId?: string }
export type ReferenceRunProgress = ReferenceRefreshRequest & { leaseId: string; sequence: number } & (
  | { kind: 'stage-started'; stage: ReferenceRunStage; run: ImportRunSnapshot }
  | { kind: 'stage-skipped'; stage: ReferenceRunStage; run: ImportRunSnapshot; token: string }
  | { kind: 'stage-completed'; token: string; completion: ReferenceRunCompletion }
)
export interface ReferenceRunChannels {
  'reference-run:v1:execute': { args: [ReferenceRunRequest]; return: ReferenceRunResponse }
  'reference-run:v1:projection-ack': { args: [ReferenceRunProjectionAck]; return: ReferenceRunProjectionAckResult }
}
export interface ReferenceRunEvents { 'reference-run:v1:progress': ReferenceRunProgress }

function fail(): never { throw new Error('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID') }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || fields.some(field => !Object.hasOwn(value, field))
    || Object.keys(value).some(field => !fields.includes(field))) fail()
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
}
function identity(value: Record<string, unknown>): void {
  assertReferenceRefreshRequest('reference-knowledge:v1:refresh', { reference: value.reference, execution: value.execution })
}
function operation(value: unknown): void { try { assertReferenceImportGrantOperationId(value) } catch { fail() } }
function stage(value: unknown): value is ReferenceRunStage {
  return typeof value === 'string' && (REFERENCE_RUN_STAGES as readonly string[]).includes(value)
}

export function isReferenceRunChannel(channel: string): channel is keyof ReferenceRunChannels {
  return (REFERENCE_RUN_CHANNELS as readonly string[]).includes(channel)
}
export function assertReferenceRunRequest<C extends keyof ReferenceRunChannels>(channel: C, value: unknown):
  asserts value is ReferenceRunChannels[C]['args'][0] {
  if (channel === 'reference-run:v1:execute') {
    closed(value, ['reference', 'execution', 'modelId']); identity(value)
    if (value.modelId !== null && !id(value.modelId)) fail()
    return
  }
  if (channel === 'reference-run:v1:projection-ack') {
    closed(value, ['reference', 'execution', 'stage', 'token', 'decision']); identity(value)
    operation(value.token)
    if (!stage(value.stage) || !['settled', 'cancelled', 'projection-failed'].includes(value.decision as string)) fail()
    return
  }
  fail()
}

/** Validate the projection envelope; the existing stage adapters still validate their canonical result/receipt. */
export function isReferenceRunProgress(value: unknown): value is ReferenceRunProgress {
  try {
    if (!record(value)) return false
    const base = ['reference', 'execution', 'leaseId', 'sequence', 'kind']
    if (value.kind === 'stage-started') {
      closed(value, [...base, 'stage', 'run'])
      if (!stage(value.stage)) return false
    } else if (value.kind === 'stage-skipped') {
      closed(value, [...base, 'stage', 'run', 'token']); operation(value.token)
      if (!stage(value.stage)) return false
    } else if (value.kind === 'stage-completed') {
      closed(value, [...base, 'token', 'completion']); operation(value.token)
      closed(value.completion, ['stage', 'result'])
      if (!stage(value.completion.stage) || !record(value.completion.result)) return false
    } else return false
    identity(value)
    if (!id(value.leaseId) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) return false
    const run = value.kind === 'stage-completed'
      ? (value.completion as Record<string, Record<string, unknown>>).result.run : value.run
    return record(run) && record(value.reference) && run.id === value.reference.runId && run.purpose === 'reference'
      && id(run.rootRunId) && [...REFERENCE_RUN_STAGES, 'completed'].includes(run.stage as ReferenceRunStage)
      && ['running', 'completed', 'cancelled', 'failed'].includes(run.status as string)
  } catch { return false }
}
