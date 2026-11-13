import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { PromptBudgetReport } from '../services/generation/generation-harness'
import { parseImportRunChapterBatchCheckpointId } from './import-run'
import type { ImportRunEffectReceipt, ImportRunExecutionAuthority, ImportRunExecutionLease, ImportRunSnapshot } from './import-run'

export const REFERENCE_BLUEPRINT_CHANNELS = ['import-generation:v1:blueprints', 'import-generation:v1:blueprints-ack'] as const

export interface ReferenceBlueprintRequest {
  runId: string
  execution: ImportRunExecutionAuthority
  modelId: string | null
}
export interface ReferenceBlueprintAckRequest {
  runId: string
  execution: ImportRunExecutionAuthority
  batchId: string
  token: string
  decision: 'accept' | 'cancelled' | 'projection-failed'
}
export interface ReferenceBlueprintAckResult { version: 1 }
export type ReferenceBlueprintLog =
  | { key: 'begin'; count: number; estimatedCalls: number }
  | { key: 'inferring'; startChapter: number; endChapter: number }
  | { key: 'complete'; count: number }
  | { key: 'stop-reason' | 'discard-failed'; code: string }
export interface ReferenceBlueprintIdentity {
  projectId: string
  leaseId: string
  runId: string
  execution: ImportRunExecutionAuthority
}
export type ReferenceBlueprintProgress = ReferenceBlueprintIdentity & { sequence: number } & (
  | { kind: 'opened'; batchId: string; token: string; handle: MainGenerationRunHandle; modelId: string }
  | { kind: 'log'; value: ReferenceBlueprintLog }
  | { kind: 'progress'; progress: number }
  | { kind: 'prompt-budget'; report: PromptBudgetReport }
  | { kind: 'range-committed' | 'range-synced'; batchId: string }
)
export interface ReferenceBlueprintResult {
  version: 1
  run: ImportRunSnapshot
  execution: ImportRunExecutionLease | null
  receipt: ImportRunEffectReceipt
  handle: MainGenerationRunHandle | null
  modelId: string | null
  replayed: boolean
}
export type ReferenceBlueprintResponse = ({ success: true } & ReferenceBlueprintResult)
  | { success: false; errorCode: string; error: string; postCommitSyncBatchId?: string }
export interface ReferenceBlueprintChannels {
  'import-generation:v1:blueprints': { args: [ReferenceBlueprintRequest]; return: ReferenceBlueprintResponse }
  'import-generation:v1:blueprints-ack': { args: [ReferenceBlueprintAckRequest]; return: ReferenceBlueprintAckResult }
}
export interface ReferenceBlueprintEvents {
  'import-generation:v1:blueprints-progress': ReferenceBlueprintProgress
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
  && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
export function isReferenceBlueprintBatchId(value: unknown): value is string {
  return id(value) && parseImportRunChapterBatchCheckpointId(value) !== null
}
function execution(value: unknown): value is ImportRunExecutionAuthority {
  return keys(value, ['owner', 'epoch']) && id(value.owner) && positive(value.epoch)
}
function promptBudget(value: unknown): value is PromptBudgetReport {
  if (!record(value)) return false
  const optional = ['contextWindowTokens', 'estimatedInputTokens'].filter(key => Object.hasOwn(value, key))
  return keys(value, ['totalUtf8Bytes', 'limitUtf8Bytes', 'reservedOutputTokens', 'sections', 'modelId', 'errorCode', ...optional])
    && nonnegative(value.totalUtf8Bytes) && nonnegative(value.limitUtf8Bytes) && nonnegative(value.reservedOutputTokens)
    && (value.contextWindowTokens === undefined || value.contextWindowTokens === null || nonnegative(value.contextWindowTokens))
    && (value.estimatedInputTokens === undefined || nonnegative(value.estimatedInputTokens))
    && id(value.modelId) && ['OK', 'PROMPT_BUDGET_EXHAUSTED'].includes(value.errorCode as string)
    && Array.isArray(value.sections) && value.sections.every(section => keys(section,
      ['sectionName', 'utf8Bytes', ...(record(section) && Object.hasOwn(section, 'displayName') ? ['displayName'] : [])])
      && id(section.sectionName) && nonnegative(section.utf8Bytes) && (section.displayName === undefined || typeof section.displayName === 'string'))
}
export function assertReferenceBlueprintRequest(value: unknown): asserts value is ReferenceBlueprintRequest {
  if (!keys(value, ['runId', 'execution', 'modelId']) || !id(value.runId) || !execution(value.execution)
    || value.modelId !== null && !id(value.modelId)) throw new Error('GENERATION_IMPORT_TASK_INVALID')
}
export function assertReferenceBlueprintAckRequest(value: unknown): asserts value is ReferenceBlueprintAckRequest {
  if (!keys(value, ['runId', 'execution', 'batchId', 'token', 'decision']) || !id(value.runId) || !execution(value.execution)
    || !isReferenceBlueprintBatchId(value.batchId) || !id(value.token)
    || !['accept', 'cancelled', 'projection-failed'].includes(value.decision as string)) throw new Error('GENERATION_IMPORT_TASK_INVALID')
}
function log(value: unknown): value is ReferenceBlueprintLog {
  if (!record(value)) return false
  if (value.key === 'begin') return keys(value, ['key', 'count', 'estimatedCalls']) && positive(value.count)
    && value.count <= 5 && value.estimatedCalls === Math.ceil(value.count / 5)
  if (value.key === 'inferring') return keys(value, ['key', 'startChapter', 'endChapter'])
    && positive(value.startChapter) && positive(value.endChapter) && value.endChapter >= value.startChapter
    && value.endChapter - value.startChapter < 5
  if (value.key === 'complete') return keys(value, ['key', 'count']) && positive(value.count) && value.count <= 5
  return ['stop-reason', 'discard-failed'].includes(value.key as string) && keys(value, ['key', 'code'])
    && typeof value.code === 'string' && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(value.code)
}
export function isReferenceBlueprintProgress(value: unknown): value is ReferenceBlueprintProgress {
  if (!record(value) || !id(value.projectId) || !id(value.leaseId) || !id(value.runId) || !execution(value.execution)
    || !positive(value.sequence)) return false
  const base = ['projectId', 'leaseId', 'runId', 'execution', 'sequence', 'kind']
  if (value.kind === 'progress') return keys(value, [...base, 'progress']) && nonnegative(value.progress) && value.progress <= 100
  if (value.kind === 'log') return keys(value, [...base, 'value']) && log(value.value)
  if (value.kind === 'prompt-budget') return keys(value, [...base, 'report']) && promptBudget(value.report)
  if (value.kind === 'range-committed' || value.kind === 'range-synced') return keys(value, [...base, 'batchId']) && isReferenceBlueprintBatchId(value.batchId)
  return value.kind === 'opened' && keys(value, [...base, 'batchId', 'token', 'handle', 'modelId'])
    && isReferenceBlueprintBatchId(value.batchId) && id(value.token) && id(value.modelId)
    && keys(value.handle, ['projectId', 'epoch', 'rootActionId', 'runId']) && Object.values(value.handle).every(id)
    && value.handle.projectId === value.projectId && value.handle.epoch === value.leaseId
}
