import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { PromptBudgetReport } from '../services/generation/generation-harness'
import type { ImportRunExecutionAuthority, ImportRunExecutionLease, ImportRunSnapshot } from './import-run'

export const REFERENCE_STYLE_CHANNELS = ['import-generation:v1:style', 'import-generation:v1:style-ack'] as const

export interface ReferenceStyleRequest {
  runId: string
  execution: ImportRunExecutionAuthority
  modelId: string | null
}
export interface ReferenceStyleIdentity {
  projectId: string
  leaseId: string
  runId: string
  execution: ImportRunExecutionAuthority
}
export interface ReferenceStyleAckRequest {
  runId: string
  execution: ImportRunExecutionAuthority
  token: string
  phase: 'opened' | 'commit'
  decision: 'accept' | 'draft-changed' | 'cancelled' | 'projection-failed'
}
export interface ReferenceStyleAckResult {
  version: 1
  savedWritingStyle: string | null
}
export type ReferenceStyleLog = 'imported-samples' | 'sampling-finalized' | 'no-finalized'
  | 'sampled-finalized' | 'read-finalized-failed' | 'empty-samples' | 'calling-ai' | 'empty-result' | 'saved'
export type ReferenceStyleProgress = ReferenceStyleIdentity & { sequence: number } & (
  | { kind: 'opened'; token: string; handle: MainGenerationRunHandle; modelId: string }
  | { kind: 'commit-ready'; token: string; handle: MainGenerationRunHandle; writingStyle: string }
  | { kind: 'log'; log: 'imported-samples' | 'sampled-finalized'; count: number }
  | { kind: 'log'; log: Exclude<ReferenceStyleLog, 'imported-samples' | 'sampled-finalized'> }
  | { kind: 'progress'; progress: 10 | 90 | 100 }
  | { kind: 'prompt-budget'; report: PromptBudgetReport }
)
export interface ReferenceStyleResult {
  version: 1
  run: ImportRunSnapshot
  execution: ImportRunExecutionLease | null
  savedWritingStyle: string
  handle: MainGenerationRunHandle | null
  modelId: string | null
  replayed: boolean
}
export type ReferenceStyleResponse = ({ success: true } & ReferenceStyleResult)
  | { success: false; errorCode: string; error: string }
export interface ReferenceStyleChannels {
  'import-generation:v1:style': { args: [ReferenceStyleRequest]; return: ReferenceStyleResponse }
  'import-generation:v1:style-ack': { args: [ReferenceStyleAckRequest]; return: ReferenceStyleAckResult }
}
export interface ReferenceStyleEvents {
  'import-generation:v1:style-progress': ReferenceStyleProgress
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
  && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
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
function execution(value: unknown): value is ImportRunExecutionAuthority {
  return keys(value, ['owner', 'epoch']) && id(value.owner) && Number.isSafeInteger(value.epoch) && (value.epoch as number) > 0
}
export function assertReferenceStyleRequest(value: unknown): asserts value is ReferenceStyleRequest {
  if (!keys(value, ['runId', 'execution', 'modelId']) || !id(value.runId) || !execution(value.execution)
    || value.modelId !== null && !id(value.modelId)) throw new Error('GENERATION_IMPORT_TASK_INVALID')
}
export function assertReferenceStyleAckRequest(value: unknown): asserts value is ReferenceStyleAckRequest {
  if (!keys(value, ['runId', 'execution', 'token', 'phase', 'decision']) || !id(value.runId)
    || !execution(value.execution) || !id(value.token) || !['opened', 'commit'].includes(value.phase as string)
    || !['accept', 'draft-changed', 'cancelled', 'projection-failed'].includes(value.decision as string)) {
    throw new Error('GENERATION_IMPORT_TASK_INVALID')
  }
}
export function isReferenceStyleProgress(value: unknown): value is ReferenceStyleProgress {
  if (!record(value) || !id(value.projectId) || !id(value.leaseId) || !id(value.runId) || !execution(value.execution)
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return false
  const base = ['projectId', 'leaseId', 'runId', 'execution', 'sequence', 'kind']
  if (value.kind === 'progress') return keys(value, [...base, 'progress']) && [10, 90, 100].includes(value.progress as number)
  if (value.kind === 'log') {
    if (value.log === 'imported-samples' || value.log === 'sampled-finalized') return keys(value, [...base, 'log', 'count'])
      && nonnegative(value.count) && value.count <= 5
    return keys(value, [...base, 'log'])
      && ['sampling-finalized', 'no-finalized', 'read-finalized-failed', 'empty-samples', 'calling-ai', 'empty-result', 'saved'].includes(value.log as string)
  }
  if (value.kind === 'prompt-budget') return keys(value, [...base, 'report']) && promptBudget(value.report)
  if (value.kind !== 'opened' && value.kind !== 'commit-ready') return false
  if (!keys(value, [...base, 'token', 'handle', value.kind === 'opened' ? 'modelId' : 'writingStyle']) || !id(value.token)
    || !keys(value.handle, ['projectId', 'epoch', 'rootActionId', 'runId']) || !Object.values(value.handle).every(id)
    || value.handle.projectId !== value.projectId || value.handle.epoch !== value.leaseId) return false
  return value.kind === 'opened' ? id(value.modelId) : typeof value.writingStyle === 'string' && !!value.writingStyle.trim()
}
