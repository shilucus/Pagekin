import type { GenerationTask } from '../services/generation/generation-harness'
import { CHAPTER_WORDS_TARGET_MAX, CHAPTER_WORDS_TARGET_MIN } from '../services/workflows/chapter-creation-parameters'
import { DRAFT_SHORT_OUTLINE_PURPOSE } from './draft-short-outline'
import { DRAFT_CONDENSE_PURPOSE, isDraftVisibleTextVersion, type DraftVisibleTextVersion } from './draft-visible-text'
import type { PhysicalAttempt } from './generation-contract'
import type { GenerationAuthorInput, GenerationDraftSaveState } from './generation-owner-contract'
import type { Locale } from '../i18n/types'
import type { ReviewRevisionCommitReceipt } from './review-revision-generation'
import { parseWorkflowDriverTask, type WorkflowDriverState } from './workflow-driver-contract'
import type { WritingLanguage } from './writing-language'

export const WORKFLOW_BATCH_TEMPLATE = 'prepared-batch-review-v2' as const
export const WORKFLOW_BATCH_CHANNELS = Object.freeze([
  'workflow-batch:v2:start', 'workflow-batch:v2:read-receipt', 'workflow-batch:v2:pause',
  'workflow-batch:v2:cancel', 'workflow-batch:v2:resume', 'workflow-batch:v2:reauthorize',
  'workflow-batch:v2:read-history',
] as const)
export type WorkflowBatchRole = 'draft' | 'review'
export type WorkflowBatchStepKind = 'outline' | 'draft' | 'continue' | 'condense' | 'compose'
  | 'draft_commit' | 'review' | 'review_rebuild' | 'review_commit'
export type WorkflowBatchReceiptKind = 'model' | 'composition' | 'draft_commit' | 'review_commit'
export type WorkflowBatchState = WorkflowDriverState
export interface WorkflowBatchIntent {
  mode: 'draft_review'
  range: { startChapter: number; endChapter: number }
  targetUnits: number
}
export interface WorkflowBatchRecipe {
  schemaVersion: 2
  writingLanguage: WritingLanguage
  uiLocale: Locale
  intent: WorkflowBatchIntent
  authorInputs: GenerationAuthorInput[]
}
export type WorkflowBatchStepInput =
  | { kind: 'model'; task: GenerationTask }
  | { kind: 'compose'; artifactIds: string[]; algorithm: DraftVisibleTextVersion; expectedTextHash: string }
  | { kind: 'draft-commit'; expectedCompositionHash: string }
  | { kind: 'review-commit'; artifact: { artifactId: string; revision: number; textHash: string } }
export interface WorkflowBatchReference { projectId: string; taskId: string; revision: number }
export interface StartWorkflowBatchRequest {
  operationKey: string
  modelId: string
  reviewModelId: string
  uiLocale: Locale
  intent: WorkflowBatchIntent
  authorInputs: GenerationAuthorInput[]
}
export interface WorkflowBatchReceipt {
  task: { taskId: string; projectId: string; template: typeof WORKFLOW_BATCH_TEMPLATE; batchRunId: string
    revision: number; state: WorkflowBatchState; blockedCode: string | null; createdAt: number; updatedAt: number }
  recipe: WorkflowBatchRecipe
  steps: { stepId: string; commandId: string; chapterNumber: number; role: WorkflowBatchRole
    kind: WorkflowBatchStepKind; slot: number; runId: string; inputHash: string
    effect: { receiptKind: WorkflowBatchReceiptKind; receiptAttemptId: string; contentHash: string } | null }[]
  attempts: { runId: string; attemptId: string; status: PhysicalAttempt['status']; artifactId: string | null }[]
  chapters: { chapterNumber: number; draftSave: GenerationDraftSaveState; review: ReviewRevisionCommitReceipt | null }[]
  historicalArtifacts?: { runId: string; attemptId: string; artifactId: string; revision: number; text: string; textHash: string }[]
  nonReplayable: true
}
export interface WorkflowBatchResult { reference: WorkflowBatchReference | null; receipt: WorkflowBatchReceipt }
export interface WorkflowBatchChannels {
  'workflow-batch:v2:start': { args: [StartWorkflowBatchRequest]; return: WorkflowBatchResult }
  'workflow-batch:v2:read-receipt': { args: [{ reference: WorkflowBatchReference }]; return: WorkflowBatchReceipt }
  'workflow-batch:v2:pause': { args: [{ reference: WorkflowBatchReference }]; return: WorkflowBatchResult }
  'workflow-batch:v2:cancel': { args: [{ reference: WorkflowBatchReference }]; return: WorkflowBatchResult }
  'workflow-batch:v2:resume': { args: [{ reference: WorkflowBatchReference }]; return: WorkflowBatchResult }
  'workflow-batch:v2:reauthorize': { args: [{ taskId: string }]; return: WorkflowBatchResult }
  'workflow-batch:v2:read-history': { args: [{ taskId: string }]; return: WorkflowBatchReceipt }
}
export type WorkflowBatchChannel = keyof WorkflowBatchChannels

function invalid(): never { throw new Error('WORKFLOW_BATCH_PAYLOAD_INVALID') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid()
  return row
}
function text(value: unknown, nonempty = true): string {
  if (typeof value !== 'string' || nonempty && !value.trim()) invalid()
  return value
}
function integer(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid()
  return Number(value)
}
function id(value: unknown): string {
  const result = text(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result)) invalid()
  return result
}
function hash(value: unknown): string {
  const result = text(value)
  if (!/^[a-f0-9]{64}$/u.test(result)) invalid()
  return result
}
function locale(value: unknown): Locale {
  if (value !== 'zh-CN' && value !== 'en-US') invalid()
  return value
}
function authorInputs(value: unknown): GenerationAuthorInput[] {
  if (!Array.isArray(value)) invalid()
  return value.map(item => { const row = object(item, ['id', 'text']); return { id: text(row.id), text: text(row.text, false) } })
}
export function parseWorkflowBatchIntent(value: unknown): WorkflowBatchIntent {
  const row = object(value, ['mode', 'range', 'targetUnits']), range = object(row.range, ['startChapter', 'endChapter'])
  const startChapter = integer(range.startChapter), endChapter = integer(range.endChapter), targetUnits = integer(row.targetUnits)
  if (row.mode !== 'draft_review' || endChapter < startChapter || endChapter - startChapter >= 10
    || targetUnits < CHAPTER_WORDS_TARGET_MIN || targetUnits > CHAPTER_WORDS_TARGET_MAX) invalid()
  return { mode: 'draft_review', range: { startChapter, endChapter }, targetUnits }
}
export function parseWorkflowBatchRecipe(value: unknown): WorkflowBatchRecipe {
  const row = object(value, ['schemaVersion', 'writingLanguage', 'uiLocale', 'intent', 'authorInputs'])
  if (row.schemaVersion !== 2) invalid()
  return { schemaVersion: 2, writingLanguage: locale(row.writingLanguage), uiLocale: locale(row.uiLocale),
    intent: parseWorkflowBatchIntent(row.intent), authorInputs: authorInputs(row.authorInputs) }
}

export function parseWorkflowBatchStepInput(value: unknown): WorkflowBatchStepInput {
  const kind = value && typeof value === 'object' ? (value as Record<string, unknown>).kind : undefined
  if (kind === 'model') {
    const row = object(value, ['kind', 'task'])
    return { kind, task: parseWorkflowDriverTask(row.task) }
  }
  if (kind === 'compose') {
    const row = object(value, ['kind', 'artifactIds', 'algorithm', 'expectedTextHash'])
    if (!Array.isArray(row.artifactIds) || !row.artifactIds.length || row.artifactIds.length > 9
      || !isDraftVisibleTextVersion(row.algorithm)) invalid()
    const artifactIds = row.artifactIds.map(item => text(item))
    if (new Set(artifactIds).size !== artifactIds.length) invalid()
    return { kind, artifactIds, algorithm: row.algorithm, expectedTextHash: hash(row.expectedTextHash) }
  }
  if (kind === 'draft-commit') {
    const row = object(value, ['kind', 'expectedCompositionHash'])
    return { kind, expectedCompositionHash: hash(row.expectedCompositionHash) }
  }
  const row = object(value, ['kind', 'artifact']), artifact = object(row.artifact, ['artifactId', 'revision', 'textHash'])
  if (row.kind !== 'review-commit') invalid()
  return { kind: 'review-commit', artifact: { artifactId: text(artifact.artifactId),
    revision: integer(artifact.revision), textHash: hash(artifact.textHash) } }
}

/** Branch slots mirror the existing algorithms; they do not authorize an effect or accept its output. */
export function assertWorkflowBatchSlot(role: WorkflowBatchRole, kind: WorkflowBatchStepKind, slot: number,
  input: WorkflowBatchStepInput): void {
  integer(slot, 0)
  const maxima: Record<WorkflowBatchStepKind, number> = { outline: 1, draft: 0, continue: 6, condense: 0,
    compose: 8, draft_commit: 0, review: 1, review_rebuild: 1, review_commit: 0 }
  if (!Object.hasOwn(maxima, kind) || slot > maxima[kind]
    || role !== (['review', 'review_rebuild', 'review_commit'].includes(kind) ? 'review' : 'draft')) invalid()
  if (kind === 'compose') { if (input.kind !== 'compose') invalid(); return }
  if (kind === 'draft_commit') { if (input.kind !== 'draft-commit') invalid(); return }
  if (kind === 'review_commit') { if (input.kind !== 'review-commit') invalid(); return }
  if (input.kind !== 'model') invalid()
  const purposes: Partial<Record<WorkflowBatchStepKind, readonly string[]>> = {
    outline: [DRAFT_SHORT_OUTLINE_PURPOSE], draft: ['chapter-draft'],
    continue: ['chapter-draft-continuation', 'chapter-draft-no-progress-recovery'], condense: [DRAFT_CONDENSE_PURPOSE],
    review: ['review-chapter'], review_rebuild: ['review-chapter-rebuild'],
  }
  if (!purposes[kind]?.includes(input.task.purpose)
    || input.task.output !== (role === 'review' ? 'structured-data' : 'visible-text')) invalid()
}

export function parseStartWorkflowBatchRequest(value: unknown): StartWorkflowBatchRequest {
  const row = object(value, ['operationKey', 'modelId', 'reviewModelId', 'uiLocale', 'intent', 'authorInputs'])
  const inputs = authorInputs(row.authorInputs)
  if (new Set(inputs.map(input => input.id)).size !== inputs.length
    || inputs.some(input => !['draft:author-config', 'draft:target-units'].includes(input.id))) invalid()
  return { operationKey: id(row.operationKey), modelId: text(row.modelId), reviewModelId: text(row.reviewModelId),
    uiLocale: locale(row.uiLocale), intent: parseWorkflowBatchIntent(row.intent), authorInputs: inputs }
}
export function isWorkflowBatchChannel(channel: string): channel is WorkflowBatchChannel {
  return (WORKFLOW_BATCH_CHANNELS as readonly string[]).includes(channel)
}
export function workflowBatchRequiresView(channel: WorkflowBatchChannel): boolean {
  return channel === 'workflow-batch:v2:start' || channel === 'workflow-batch:v2:reauthorize'
    || channel === 'workflow-batch:v2:read-history'
}
export function assertWorkflowBatchRequest<C extends WorkflowBatchChannel>(channel: C, value: unknown):
  asserts value is WorkflowBatchChannels[C]['args'][0] {
  if (!isWorkflowBatchChannel(channel)) throw new Error('WORKFLOW_BATCH_CHANNEL_NOT_ALLOWED')
  if (channel === 'workflow-batch:v2:start') { parseStartWorkflowBatchRequest(value); return }
  if (channel === 'workflow-batch:v2:reauthorize' || channel === 'workflow-batch:v2:read-history') {
    id(object(value, ['taskId']).taskId); return
  }
  const reference = object(object(value, ['reference']).reference, ['projectId', 'taskId', 'revision'])
  text(reference.projectId); id(reference.taskId); integer(reference.revision)
}
