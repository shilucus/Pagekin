import type { GenerationTask } from '../services/generation/generation-harness'
import type { PhysicalAttempt } from './generation-contract'
import type { BeginGenerationRequest, GenerationDraftSaveState, PrepareDraftContextRequest, PreparedDraftContext,
  VisibleCompositionReceipt } from './generation-owner-contract'
import { DRAFT_SHORT_OUTLINE_PURPOSE } from './draft-short-outline'
import { isDraftVisibleTextVersion, type DraftVisibleTextVersion } from './draft-visible-text'
import type { WritingLanguage } from './writing-language'

export const WORKFLOW_DRIVER_TEMPLATE = 'prepared-first-chapter-v1' as const
export const WORKFLOW_DRIVER_CHANNELS = Object.freeze([
  'workflow-driver:v1:prepare-context', 'workflow-driver:v1:start',
  'workflow-driver:v1:read-receipt', 'workflow-driver:v1:pause',
  'workflow-driver:v1:cancel', 'workflow-driver:v1:resume',
  'workflow-driver:v1:reauthorize', 'workflow-driver:v1:read-history',
] as const)

export type WorkflowDriverState = 'ready' | 'paused' | 'blocked' | 'cancelled' | 'waiting_review'
export type WorkflowDriverStepKind = 'outline' | 'draft' | 'compose' | 'commit'
export type WorkflowDriverKind = WorkflowDriverStepKind
export type WorkflowDriverReceiptKind = 'model' | 'composition' | 'draft_commit'

/** Contains semantic author material, never a model lease or an execution capability. */
export interface WorkflowDriverRecipe {
  schemaVersion: 1
  writingLanguage: WritingLanguage
  outlineTask: GenerationTask
  baseDraftTask: GenerationTask
}

export type WorkflowDriverStepInput =
  | { kind: 'model'; task: GenerationTask }
  | { kind: 'compose'; artifactIds: string[]; algorithm: DraftVisibleTextVersion; expectedTextHash: string }
  | { kind: 'commit'; chapterNumber: number; expectedCompositionHash: string }

/** This reference identifies a private main issuance; possession alone grants nothing. */
export interface WorkflowDriverReference { projectId: string; taskId: string; revision: number }

export interface WorkflowDriverReceipt {
  task: {
    taskId: string; projectId: string; template: typeof WORKFLOW_DRIVER_TEMPLATE; runId: string
    revision: number; state: WorkflowDriverState; blockedCode: string | null; createdAt: number; updatedAt: number
  }
  steps: {
    stepId: string; commandId: string; ordinal: number; kind: WorkflowDriverStepKind; inputHash: string | null
    effect: { receiptKind: WorkflowDriverReceiptKind; receiptAttemptId: string; contentHash: string } | null
  }[]
  attempts: { attemptId: string; status: PhysicalAttempt['status']; artifactId: string | null }[]
  composition: VisibleCompositionReceipt | null
  draftSave: GenerationDraftSaveState
  /** Frozen copies retain allowed prose, not the excluded executable artifact identity. */
  historicalArtifacts?: { attemptId: string; artifactId: string; revision: number; text: string; textHash: string }[]
  draftSaveProof?: 'unavailable'
  nonReplayable: true
}

export interface WorkflowDriverResult { reference: WorkflowDriverReference | null; receipt: WorkflowDriverReceipt }
export interface StartWorkflowDriverRequest {
  operationKey: string
  selection: BeginGenerationRequest
  recipe: WorkflowDriverRecipe
}

export interface WorkflowDriverChannels {
  'workflow-driver:v1:prepare-context': { args: [{ request: PrepareDraftContextRequest }]; return: PreparedDraftContext }
  'workflow-driver:v1:start': { args: [StartWorkflowDriverRequest]; return: WorkflowDriverResult }
  'workflow-driver:v1:read-receipt': { args: [{ reference: WorkflowDriverReference }]; return: WorkflowDriverReceipt }
  'workflow-driver:v1:pause': { args: [{ reference: WorkflowDriverReference }]; return: WorkflowDriverResult }
  'workflow-driver:v1:cancel': { args: [{ reference: WorkflowDriverReference }]; return: WorkflowDriverResult }
  'workflow-driver:v1:resume': { args: [{ reference: WorkflowDriverReference }]; return: WorkflowDriverResult }
  'workflow-driver:v1:reauthorize': { args: [{ taskId: string }]; return: WorkflowDriverResult }
  'workflow-driver:v1:read-history': { args: [{ taskId: string }]; return: WorkflowDriverReceipt }
}
export type WorkflowDriverChannel = keyof WorkflowDriverChannels

function invalid(): never { throw new Error('WORKFLOW_DRIVER_PAYLOAD_INVALID') }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid()
  return row
}
function text(value: unknown, nonempty = false): string {
  if (typeof value !== 'string' || nonempty && !value.trim()) invalid()
  return value
}
function integer(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid()
  return Number(value)
}
function language(value: unknown): WritingLanguage {
  if (value !== 'zh-CN' && value !== 'en-US') invalid()
  return value
}
function id(value: unknown): string {
  const result = text(value, true)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result)) invalid()
  return result
}
function hash(value: unknown): string {
  const result = text(value)
  if (!/^[a-f0-9]{64}$/u.test(result)) invalid()
  return result
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) invalid()
  return value.map(item => text(item, true))
}
function positiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) invalid()
  return value.map(item => integer(item))
}
function authorInputs(value: unknown): void {
  if (!Array.isArray(value)) invalid()
  for (const item of value) {
    const row = object(item, ['id', 'text'])
    text(row.id, true); text(row.text)
  }
}

/** The same closed, canonical projection is used before persistence and during portable export. */
export function parseWorkflowDriverTask(value: unknown): GenerationTask {
  const row = object(value, ['purpose', 'output', 'messages'], ['budgetDemand', 'reasoningStage', 'promptBudget'])
  const purpose = text(row.purpose, true)
  if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(purpose) || !['visible-text', 'structured-data'].includes(String(row.output))
    || !Array.isArray(row.messages) || !row.messages.length) invalid()
  const messages = row.messages.map(item => {
    const message = object(item, ['role', 'content'])
    if (!['system', 'user', 'assistant'].includes(String(message.role))) invalid()
    return { role: message.role as 'system' | 'user' | 'assistant', content: text(message.content) }
  })
  const result: GenerationTask = { purpose, output: row.output as GenerationTask['output'], messages }
  if (row.budgetDemand !== undefined) {
    const raw = row.budgetDemand as Record<string, unknown>
    if (raw?.kind === 'draft-units') {
      const demand = object(raw, ['kind', 'writingLanguage', 'requestedUnits', 'segmentable'])
      if (typeof demand.segmentable !== 'boolean') invalid()
      result.budgetDemand = { kind: 'draft-units', writingLanguage: language(demand.writingLanguage),
        requestedUnits: integer(demand.requestedUnits), segmentable: demand.segmentable }
    } else {
      const demand = object(raw, ['kind', 'writingLanguage', 'requestedItems'])
      if (demand.kind !== 'structured-items') invalid()
      result.budgetDemand = { kind: 'structured-items', writingLanguage: language(demand.writingLanguage), requestedItems: integer(demand.requestedItems) }
    }
  }
  if (row.reasoningStage !== undefined) {
    if (!['drafting', 'planning', 'review', 'general'].includes(String(row.reasoningStage))) invalid()
    result.reasoningStage = row.reasoningStage as GenerationTask['reasoningStage']
  }
  if (row.promptBudget !== undefined) {
    const budget = object(row.promptBudget, ['limitUtf8Bytes', 'sections'])
    if (!Array.isArray(budget.sections)) invalid()
    result.promptBudget = { limitUtf8Bytes: integer(budget.limitUtf8Bytes), sections: budget.sections.map(item => {
      const section = object(item, ['sectionName', 'messageIndex', 'finalText'], ['limitUtf8Bytes', 'displayName'])
      const messageIndex = integer(section.messageIndex, 0), finalText = text(section.finalText)
      if (!messages[messageIndex]?.content.includes(finalText)) invalid()
      return { sectionName: text(section.sectionName, true), messageIndex, finalText,
        ...(section.limitUtf8Bytes === undefined ? {} : { limitUtf8Bytes: integer(section.limitUtf8Bytes) }),
        ...(section.displayName === undefined ? {} : { displayName: text(section.displayName) }) }
    }) }
  }
  return result
}

export function parseWorkflowDriverRecipe(value: unknown): WorkflowDriverRecipe {
  const row = object(value, ['schemaVersion', 'writingLanguage', 'outlineTask', 'baseDraftTask'])
  if (row.schemaVersion !== 1) invalid()
  const outlineTask = parseWorkflowDriverTask(row.outlineTask), baseDraftTask = parseWorkflowDriverTask(row.baseDraftTask)
  if (outlineTask.purpose !== DRAFT_SHORT_OUTLINE_PURPOSE || outlineTask.output !== 'visible-text'
    || baseDraftTask.purpose !== 'chapter-draft' || baseDraftTask.output !== 'visible-text') invalid()
  return { schemaVersion: 1, writingLanguage: language(row.writingLanguage), outlineTask, baseDraftTask }
}

export function parseWorkflowDriverStepInput(value: unknown): WorkflowDriverStepInput {
  if ((value as { kind?: unknown } | null)?.kind === 'model') {
    const row = object(value, ['kind', 'task'])
    return { kind: 'model', task: parseWorkflowDriverTask(row.task) }
  }
  if ((value as { kind?: unknown } | null)?.kind === 'compose') {
    const row = object(value, ['kind', 'artifactIds', 'algorithm', 'expectedTextHash'])
    const artifactIds = strings(row.artifactIds)
    if (!artifactIds.length || new Set(artifactIds).size !== artifactIds.length || !isDraftVisibleTextVersion(row.algorithm)) invalid()
    return { kind: 'compose', artifactIds, algorithm: row.algorithm, expectedTextHash: hash(row.expectedTextHash) }
  }
  const row = object(value, ['kind', 'chapterNumber', 'expectedCompositionHash'])
  if (row.kind !== 'commit') invalid()
  return { kind: 'commit', chapterNumber: integer(row.chapterNumber), expectedCompositionHash: hash(row.expectedCompositionHash) }
}

export function isWorkflowDriverChannel(channel: string): channel is WorkflowDriverChannel {
  return (WORKFLOW_DRIVER_CHANNELS as readonly string[]).includes(channel)
}
export function workflowDriverRequiresView(channel: WorkflowDriverChannel): boolean {
  return channel === 'workflow-driver:v1:prepare-context' || channel === 'workflow-driver:v1:start'
    || channel === 'workflow-driver:v1:reauthorize' || channel === 'workflow-driver:v1:read-history'
}

export function assertWorkflowDriverRequest<C extends WorkflowDriverChannel>(channel: C, value: unknown): asserts value is WorkflowDriverChannels[C]['args'][0] {
  if (channel === 'workflow-driver:v1:prepare-context') {
    const wrapper = object(value, ['request'])
    const request = object(wrapper.request, ['chapterNumber', 'modelId', 'promptKeys', 'skillStages', 'authorInputs', 'query', 'selectedDraftIds'])
    if (request.chapterNumber !== 1 || positiveIntegers(request.selectedDraftIds).length) invalid()
    text(request.modelId, true); strings(request.promptKeys); strings(request.skillStages); authorInputs(request.authorInputs); text(request.query)
    return
  }
  if (channel === 'workflow-driver:v1:start') {
    const request = object(value, ['operationKey', 'selection', 'recipe'])
    id(request.operationKey); parseWorkflowDriverRecipe(request.recipe)
    const selection = object(request.selection, ['operation', 'uiActionNonce', 'modelId', 'chapterNumber', 'selectedDraftIds',
      'selectedFinalizedDraftIds', 'promptKeys', 'skillStages', 'output', 'preparationId', 'materialDecision'],
    ['authorInputs', 'selectedBlueprintChapterNumbers'])
    if (selection.operation !== 'chapter-draft' || selection.chapterNumber !== 1 || selection.output !== 'visible-text'
      || positiveIntegers(selection.selectedDraftIds).length || positiveIntegers(selection.selectedFinalizedDraftIds).length) invalid()
    text(selection.uiActionNonce, true); text(selection.modelId, true); text(selection.preparationId, true)
    strings(selection.promptKeys); strings(selection.skillStages)
    if (selection.selectedBlueprintChapterNumbers !== undefined) positiveIntegers(selection.selectedBlueprintChapterNumbers)
    if (selection.authorInputs !== undefined) authorInputs(selection.authorInputs)
    return
  }
  if (channel === 'workflow-driver:v1:reauthorize' || channel === 'workflow-driver:v1:read-history') {
    const request = object(value, ['taskId'])
    id(request.taskId)
    return
  }
  if (!isWorkflowDriverChannel(channel)) throw new Error('WORKFLOW_DRIVER_CHANNEL_NOT_ALLOWED')
  const request = object(value, ['reference']), reference = object(request.reference, ['projectId', 'taskId', 'revision'])
  text(reference.projectId, true); id(reference.taskId); integer(reference.revision)
}
