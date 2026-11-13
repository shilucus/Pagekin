import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { PromptBudgetReport } from '../services/generation/generation-harness'
import type { ImportInferenceTopicKey } from './import-inference-materials'
import type { ImportRunEffectReceipt, ImportRunExecutionAuthority, ImportRunExecutionLease, ImportRunSnapshot } from './import-run'
import type { LLMFinishReason } from './ipc-channels'

export const REFERENCE_GLOBAL_CHANNELS = ['import-generation:v1:global', 'import-generation:v1:global-ack'] as const

export interface ReferenceGlobalRequest {
  runId: string
  execution: ImportRunExecutionAuthority
  modelId: string | null
}
export interface ReferenceGlobalAckRequest {
  runId: string
  execution: ImportRunExecutionAuthority
  token: string
  decision: 'accept' | 'cancelled' | 'projection-failed'
}
export interface ReferenceGlobalAckResult { version: 1 }
export type ReferenceGlobalLog =
  | { key: 'retrieving' | 'calling-ai' | 'syntax-repair' | 'parsing' }
  | { key: 'retrieved'; topic: ImportInferenceTopicKey; count: number }
  | { key: 'retrieval-fallback'; topic: ImportInferenceTopicKey }
  | { key: 'endpoint-recovery' | 'saved-proposals' | 'saved-roster'; count: number }
  | { key: 'skill'; name: string }
  | { key: 'discard-failed'; code: string }
  | { key: 'dropped-relationships'; relationships: { source: string; target: string; relation: string }[] }
export interface ReferenceGlobalIdentity {
  projectId: string
  leaseId: string
  runId: string
  execution: ImportRunExecutionAuthority
}
export type ReferenceGlobalProgress = ReferenceGlobalIdentity & { sequence: number } & (
  | { kind: 'opened'; token: string; handle: MainGenerationRunHandle; modelId: string }
  | { kind: 'log'; value: ReferenceGlobalLog }
  | { kind: 'progress'; progress: 5 | 10 | 20 | 25 | 70 | 90 | 100 }
  | { kind: 'prompt-budget'; report: PromptBudgetReport }
  | { kind: 'candidate'; content: string }
  | { kind: 'committed' }
)
export interface ReferenceGlobalResult {
  version: 1
  run: ImportRunSnapshot
  execution: ImportRunExecutionLease | null
  receipt: ImportRunEffectReceipt
  handle: MainGenerationRunHandle | null
  modelId: string | null
  replayed: boolean
}
export type ReferenceGlobalCompletionFailureCode = Exclude<LLMFinishReason, 'stop'>
export type ReferenceGlobalResponse = ({ success: true } & ReferenceGlobalResult)
  | { success: false; errorCode: string; error: string; completionFailureCode?: ReferenceGlobalCompletionFailureCode }
export interface ReferenceGlobalChannels {
  'import-generation:v1:global': { args: [ReferenceGlobalRequest]; return: ReferenceGlobalResponse }
  'import-generation:v1:global-ack': { args: [ReferenceGlobalAckRequest]; return: ReferenceGlobalAckResult }
}
export interface ReferenceGlobalEvents {
  'import-generation:v1:global-progress': ReferenceGlobalProgress
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
  && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const topic = (value: unknown): value is ImportInferenceTopicKey => ['worldview', 'protagonist', 'conflict', 'style'].includes(value as string)
export function isReferenceGlobalCompletionFailureCode(value: unknown): value is ReferenceGlobalCompletionFailureCode {
  return typeof value === 'string' && ['length', 'content_filter', 'cancelled', 'error', 'unknown'].includes(value)
}
function execution(value: unknown): value is ImportRunExecutionAuthority {
  return keys(value, ['owner', 'epoch']) && id(value.owner) && Number.isSafeInteger(value.epoch) && (value.epoch as number) > 0
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
export function assertReferenceGlobalRequest(value: unknown): asserts value is ReferenceGlobalRequest {
  if (!keys(value, ['runId', 'execution', 'modelId']) || !id(value.runId) || !execution(value.execution)
    || value.modelId !== null && !id(value.modelId)) throw new Error('GENERATION_IMPORT_TASK_INVALID')
}
export function assertReferenceGlobalAckRequest(value: unknown): asserts value is ReferenceGlobalAckRequest {
  if (!keys(value, ['runId', 'execution', 'token', 'decision']) || !id(value.runId) || !execution(value.execution)
    || !id(value.token) || !['accept', 'cancelled', 'projection-failed'].includes(value.decision as string)) {
    throw new Error('GENERATION_IMPORT_TASK_INVALID')
  }
}
function log(value: unknown): value is ReferenceGlobalLog {
  if (!record(value)) return false
  if (['retrieving', 'calling-ai', 'syntax-repair', 'parsing'].includes(value.key as string)) return keys(value, ['key'])
  if (value.key === 'retrieved') return keys(value, ['key', 'topic', 'count']) && topic(value.topic) && nonnegative(value.count) && value.count <= 5
  if (value.key === 'retrieval-fallback') return keys(value, ['key', 'topic']) && topic(value.topic)
  if (['endpoint-recovery', 'saved-proposals', 'saved-roster'].includes(value.key as string)) {
    return keys(value, ['key', 'count']) && nonnegative(value.count) && value.count <= 8 && (value.key !== 'endpoint-recovery' || value.count > 0)
  }
  if (value.key === 'skill') return keys(value, ['key', 'name']) && typeof value.name === 'string' && value.name.trim().length > 0
  if (value.key === 'discard-failed') return keys(value, ['key', 'code']) && typeof value.code === 'string' && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(value.code)
  return value.key === 'dropped-relationships' && keys(value, ['key', 'relationships']) && Array.isArray(value.relationships)
    && value.relationships.length > 0 && value.relationships.every(item => keys(item, ['source', 'target', 'relation'])
      && [item.source, item.target, item.relation].every(field => typeof field === 'string' && field.trim().length > 0))
}
export function isReferenceGlobalProgress(value: unknown): value is ReferenceGlobalProgress {
  if (!record(value) || !id(value.projectId) || !id(value.leaseId) || !id(value.runId) || !execution(value.execution)
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return false
  const base = ['projectId', 'leaseId', 'runId', 'execution', 'sequence', 'kind']
  if (value.kind === 'progress') return keys(value, [...base, 'progress']) && [5, 10, 20, 25, 70, 90, 100].includes(value.progress as number)
  if (value.kind === 'log') return keys(value, [...base, 'value']) && log(value.value)
  if (value.kind === 'prompt-budget') return keys(value, [...base, 'report']) && promptBudget(value.report)
  if (value.kind === 'candidate') return keys(value, [...base, 'content']) && typeof value.content === 'string'
  if (value.kind === 'committed') return keys(value, base)
  return value.kind === 'opened' && keys(value, [...base, 'token', 'handle', 'modelId']) && id(value.token) && id(value.modelId)
    && keys(value.handle, ['projectId', 'epoch', 'rootActionId', 'runId']) && Object.values(value.handle).every(id)
    && value.handle.projectId === value.projectId && value.handle.epoch === value.leaseId
}
