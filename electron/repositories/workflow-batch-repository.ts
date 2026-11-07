import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { assertWorkflowBatchSlot, parseWorkflowBatchRecipe, parseWorkflowBatchStepInput, WORKFLOW_BATCH_TEMPLATE,
  type WorkflowBatchRecipe, type WorkflowBatchStepInput, type WorkflowBatchStepKind,
  type WorkflowBatchRole, type WorkflowBatchReceiptKind, type WorkflowBatchState } from '../../src/shared/workflow-batch-contract'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { stripDraftShortOutlineBlock } from '../../src/shared/draft-short-outline'
import { composeDraftVisibleContinuation, sanitizeDraftText } from '../../src/shared/draft-visible-text'
import { countDraftUnits } from '../../src/shared/draft-units'
import { isLowProgressDraftContinuation, shouldAutoContinueDraft, shouldCondenseDraft } from '../../src/shared/draft-generation-policy'
import { readWorkflowBatchEffectProof } from '../migrations/m13-workflow-batch'
import { parseOrdinarySemanticHistory, ordinarySemanticHistoryHash } from '../migrations/ordinary-review-history'
import { ReviewRevisionGeneration } from '../services/review-revision-generation'
import { GenerationRunRepository, textHash } from './generation-run-repository'

type Row = Record<string, unknown>
export type WorkflowBatchTable = 'workflow_batch_tasks' | 'workflow_batch_steps' | 'workflow_batch_effects'
export interface WorkflowBatchRef { taskId: string; revision: number; batchRunId: string }
export type WorkflowBatchTaskRef = WorkflowBatchRef
export interface WorkflowBatchTask extends WorkflowBatchRef {
  projectId: string; operationKey: string; requestHash: string | null; template: typeof WORKFLOW_BATCH_TEMPLATE
  state: WorkflowBatchState; blockedCode: string | null; recipe: WorkflowBatchRecipe; recipeHash: string
  reviewModelId: string | null; reviewModelHash: string | null; createdAt: number; updatedAt: number
}
export interface WorkflowBatchStep {
  stepId: string; taskId: string; chapterNumber: number; role: WorkflowBatchRole; kind: WorkflowBatchStepKind
  slot: number; commandId: string; runId: string; invocationNonce: string | null; input: WorkflowBatchStepInput; inputHash: string
}
export interface WorkflowBatchEffect {
  stepId: string; receiptKind: WorkflowBatchReceiptKind; receiptAttemptId: string; contentHash: string; acknowledgedAt: number
  semanticHistory: Row | null; semanticHistoryHash: string | null
}
export interface IssueWorkflowBatchTask {
  taskId: string; operationKey: string; requestHash: string; batchRunId: string; recipe: WorkflowBatchRecipe
  reviewModelId: string; reviewModelHash: string; createdAt?: number
}
export interface BindWorkflowBatchStep {
  chapterNumber: number; role: WorkflowBatchRole; kind: WorkflowBatchStepKind; slot: number; runId: string; input: WorkflowBatchStepInput
}
export interface WorkflowBatchRepositoryOptions {
  projectId: string
  assertCurrent(): void
  isFrozen(table: WorkflowBatchTable, recordId: string): boolean
  now?(): number
}
function fail(code: string): never { throw new Error(`WORKFLOW_BATCH_${code}`) }
function id(v: unknown): string { if (typeof v !== 'string' || !/^[\p{L}\p{N}._:@+-]{1,512}$/u.test(v)) fail('ID_INVALID'); return v }
function uuid(v: unknown): string { const value = id(v); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) fail('ID_INVALID'); return value }
function hash(v: unknown): string { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/u.test(v)) fail('HASH_INVALID'); return v }
function integer(v: unknown, min = 0): number { if (!Number.isSafeInteger(v) || Number(v) < min) fail('INVALID'); return Number(v) }
function object(v: unknown): Row { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('INTEGRITY_FAILED'); return v as Row }
function json(v: unknown): Row { if (typeof v !== 'string') fail('INTEGRITY_FAILED'); return object(JSON.parse(v)) }
function closed(v: unknown, required: string[], optional: string[] = []): void {
  const row = object(v)
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) fail('INVALID')
}
const receiptKind = (kind: WorkflowBatchStepKind): WorkflowBatchReceiptKind => kind === 'compose' ? 'composition'
  : kind === 'draft_commit' || kind === 'review_commit' ? kind : 'model'

/** Control history points to existing native effects. Rows and command IDs never grant execution. */
export class WorkflowBatchRepository {
  private readonly runs: GenerationRunRepository
  constructor(private readonly db: Database.Database, private readonly options: WorkflowBatchRepositoryOptions) {
    id(options.projectId)
    this.runs = new GenerationRunRepository(() => db, options.now)
  }
  private current(): void {
    if (!this.db.open) fail('DATABASE_NOT_READY')
    if ((this.options.assertCurrent() as unknown) !== undefined) fail('ASYNC_GUARD_INVALID')
  }
  private transaction<T>(callback: () => T): T { this.current(); return this.db.transaction(() => { this.current(); return callback() }).immediate() }
  private now(task?: WorkflowBatchTask): number { return Math.max(task?.updatedAt ?? 0, integer((this.options.now ?? Date.now)())) }
  private mutable(task: WorkflowBatchTask, step?: WorkflowBatchStep): void {
    if (this.options.isFrozen('workflow_batch_tasks', task.taskId) || task.requestHash === null || task.reviewModelId === null || task.reviewModelHash === null
      || step && (this.options.isFrozen('workflow_batch_steps', step.stepId) || this.options.isFrozen('workflow_batch_effects', step.stepId)
        || step.input.kind === 'model' && step.invocationNonce === null)) fail('HISTORY_FROZEN')
    if (task.projectId !== this.options.projectId) fail('PROJECT_MISMATCH')
  }
  private task(row: Row): WorkflowBatchTask {
    const recipe = parseWorkflowBatchRecipe(JSON.parse(String(row.recipe_json)))
    if (row.template !== WORKFLOW_BATCH_TEMPLATE || !['ready', 'paused', 'blocked', 'cancelled', 'waiting_review'].includes(String(row.state))
      || JSON.stringify(recipe) !== row.recipe_json || textHash(String(row.recipe_json)) !== row.recipe_hash
      || (row.state === 'blocked' ? typeof row.blocked_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(row.blocked_code) : row.blocked_code !== null)
      || (row.review_model_id === null) !== (row.review_model_hash === null)) fail('INTEGRITY_FAILED')
    const value: WorkflowBatchTask = { taskId: id(row.task_id), projectId: id(row.project_id), operationKey: id(row.operation_key),
      requestHash: row.request_hash === null ? null : hash(row.request_hash), template: WORKFLOW_BATCH_TEMPLATE, batchRunId: id(row.batch_run_id),
      revision: integer(row.revision, 1), state: row.state as WorkflowBatchState, blockedCode: row.blocked_code as string | null,
      recipe, recipeHash: hash(row.recipe_hash), reviewModelId: row.review_model_id === null ? null : id(row.review_model_id),
      reviewModelHash: row.review_model_hash === null ? null : hash(row.review_model_hash), createdAt: integer(row.created_at), updatedAt: integer(row.updated_at) }
    if (value.updatedAt < value.createdAt || value.projectId !== this.options.projectId && !this.options.isFrozen('workflow_batch_tasks', value.taskId)) fail('PROJECT_MISMATCH')
    return value
  }
  get(taskId: string): WorkflowBatchTask | null {
    this.current()
    const row = this.db.prepare('SELECT * FROM workflow_batch_tasks WHERE task_id=?').get(id(taskId)) as Row | undefined
    return row ? this.task(row) : null
  }
  getByOperation(key: string): WorkflowBatchTask | null {
    this.current()
    const row = this.db.prepare('SELECT * FROM workflow_batch_tasks WHERE operation_key=?').get(id(key)) as Row | undefined
    return row ? this.task(row) : null
  }
  private required(taskId: string): WorkflowBatchTask { const value = this.get(taskId); if (!value) fail('MISSING'); return value }
  private step(row: Row): WorkflowBatchStep {
    const input = parseWorkflowBatchStepInput(JSON.parse(String(row.input_json)))
    assertWorkflowBatchSlot(row.role as WorkflowBatchRole, row.kind as WorkflowBatchStepKind, integer(row.slot), input)
    if (JSON.stringify(input) !== row.input_json || textHash(String(row.input_json)) !== row.input_hash
      || input.kind !== 'model' && row.invocation_nonce !== null) fail('INTEGRITY_FAILED')
    return { stepId: id(row.step_id), taskId: id(row.task_id), chapterNumber: integer(row.chapter_number, 1), role: row.role as WorkflowBatchRole,
      kind: row.kind as WorkflowBatchStepKind, slot: integer(row.slot), commandId: id(row.command_id), runId: id(row.run_id),
      invocationNonce: row.invocation_nonce === null ? null : id(row.invocation_nonce), input, inputHash: hash(row.input_hash) }
  }
  readSteps(taskId: string): WorkflowBatchStep[] {
    this.required(taskId)
    return (this.db.prepare('SELECT * FROM workflow_batch_steps WHERE task_id=? ORDER BY chapter_number,role,kind,slot').all(taskId) as Row[]).map(row => this.step(row))
  }
  readEffects(taskId: string): WorkflowBatchEffect[] {
    this.required(taskId)
    return (this.db.prepare(`SELECT e.* FROM workflow_batch_effects e JOIN workflow_batch_steps s ON s.step_id=e.step_id WHERE s.task_id=? ORDER BY s.chapter_number,s.role,s.kind,s.slot`).all(taskId) as Row[]).map(row => {
      if (!['model', 'composition', 'draft_commit', 'review_commit'].includes(String(row.receipt_kind))
        || (row.semantic_history_json === null) !== (row.semantic_history_hash === null)) fail('INTEGRITY_FAILED')
      const history = row.semantic_history_json === null ? null : parseOrdinarySemanticHistory(JSON.parse(String(row.semantic_history_json)))
      if (history && ordinarySemanticHistoryHash(history) !== row.semantic_history_hash) fail('INTEGRITY_FAILED')
      return { stepId: id(row.step_id), receiptKind: row.receipt_kind as WorkflowBatchReceiptKind, receiptAttemptId: id(row.receipt_attempt_id),
        contentHash: hash(row.content_hash), acknowledgedAt: integer(row.acknowledged_at), semanticHistory: history === null ? null : object(history),
        semanticHistoryHash: row.semantic_history_hash === null ? null : hash(row.semantic_history_hash) }
    })
  }
  private reference(ref: WorkflowBatchRef): WorkflowBatchTask {
    closed(ref, ['taskId', 'revision', 'batchRunId'])
    const task = this.required(id(ref.taskId)); this.mutable(task)
    if (task.batchRunId !== id(ref.batchRunId)) fail('RUN_MISMATCH')
    if (task.revision !== integer(ref.revision, 1)) fail('REVISION_CONFLICT')
    return task
  }
  private root(task: Pick<WorkflowBatchTask, 'projectId' | 'batchRunId' | 'recipe'>, live = true): void {
    const run = this.runs.get(task.batchRunId), manifest = run.binding.sourceManifest, budget = this.runs.budget(run.rootActionId)
    if (run.binding.projectId !== task.projectId || budget.root.projectId !== task.projectId || budget.root.operation !== 'batch-chapters'
      || manifest.operation !== 'batch-chapters' || !isDeepStrictEqual(manifest.batchIntent, task.recipe.intent)
      || !isDeepStrictEqual(manifest.authorInputs ?? [], task.recipe.authorInputs)) fail('RUN_MISMATCH')
    if (manifest.freezeWritingLanguage !== true || manifest.writingLanguage !== task.recipe.writingLanguage) fail('LANGUAGE_MISMATCH')
    if (live) {
      const language = this.db.prepare("SELECT writing_language FROM project_core WHERE id='main'").pluck().get()
      if (language !== manifest.writingLanguage) fail('SOURCE_LANGUAGE_CHANGED')
    }
  }
  issue(request: IssueWorkflowBatchTask): WorkflowBatchTask {
    closed(request, ['taskId', 'operationKey', 'requestHash', 'batchRunId', 'recipe', 'reviewModelId', 'reviewModelHash'], ['createdAt'])
    uuid(request.taskId); uuid(request.operationKey); hash(request.requestHash); hash(request.reviewModelHash); id(request.reviewModelId)
    const recipe = parseWorkflowBatchRecipe(request.recipe), encoded = JSON.stringify(recipe)
    return this.transaction(() => {
      const previous = this.getByOperation(request.operationKey)
      if (previous) {
        this.mutable(previous)
        if (previous.requestHash !== request.requestHash || previous.batchRunId !== request.batchRunId || previous.reviewModelId !== request.reviewModelId
          || previous.reviewModelHash !== request.reviewModelHash || JSON.stringify(previous.recipe) !== encoded) fail('IDEMPOTENCY_CONFLICT')
        this.root(previous); return previous
      }
      if (this.get(request.taskId) || this.db.prepare('SELECT 1 FROM workflow_batch_tasks WHERE batch_run_id=?').get(request.batchRunId)
        || this.options.isFrozen('workflow_batch_tasks', request.taskId)) fail('IDEMPOTENCY_CONFLICT')
      this.root({ projectId: this.options.projectId, batchRunId: request.batchRunId, recipe })
      const root = this.runs.get(request.batchRunId)
      if (this.runs.budget(root.rootActionId).attempts.length) fail('RUN_ALREADY_STARTED')
      const now = integer(request.createdAt ?? this.now())
      this.db.prepare(`INSERT INTO workflow_batch_tasks VALUES(?,?,?,?,'prepared-batch-review-v2',?,1,'ready',NULL,?,?,?,?,?,?)`)
        .run(request.taskId, this.options.projectId, request.operationKey, request.requestHash, request.batchRunId, encoded, textHash(encoded), request.reviewModelId, request.reviewModelHash, now, now)
      return this.required(request.taskId)
    })
  }
  assertActive(ref: WorkflowBatchRef): WorkflowBatchTask {
    this.current(); if (!this.db.inTransaction) fail('TRANSACTION_REQUIRED')
    const task = this.reference(ref)
    if (task.state !== 'ready') fail('INACTIVE')
    this.root(task)
    for (const step of this.readSteps(task.taskId)) this.mutable(task, step)
    return task
  }
  private draftCommit(task: WorkflowBatchTask, chapter: number) {
    const step = this.readSteps(task.taskId).find(v => v.chapterNumber === chapter && v.kind === 'draft_commit')
    if (!step) return null
    const proof = readWorkflowBatchEffectProof(this.db, task.taskId, step.stepId)
    if (!proof) return null
    const usage = json(this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(proof.receiptAttemptId))
    return { step, proof, saved: object(usage.draftCommit) }
  }
  private currentDraft(task: WorkflowBatchTask, chapter: number): boolean {
    const found = this.draftCommit(task, chapter)
    if (!found) return false
    const row = this.db.prepare('SELECT d.chapter_number,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(found.saved.id) as Row | undefined
    const latest = this.db.prepare('SELECT id FROM drafts WHERE chapter_number=? ORDER BY version DESC,id DESC LIMIT 1').pluck().get(chapter)
    return !!row && latest === found.saved.id && row.status !== 'superseded' && row.chapter_number === chapter
      && row.version === found.saved.version && row.body === found.saved.content
  }
  private role(task: WorkflowBatchTask, request: BindWorkflowBatchStep): void {
    const range = task.recipe.intent.range
    if (request.chapterNumber < range.startChapter || request.chapterNumber > range.endChapter) fail('CHAPTER_MISMATCH')
    const run = this.runs.get(request.runId), root = this.runs.get(task.batchRunId), manifest = run.binding.sourceManifest
    if (run.binding.projectId !== task.projectId || manifest.chapterNumber !== request.chapterNumber
      || manifest.operation !== (request.role === 'draft' ? 'chapter-draft' : 'review-chapter')) fail('RUN_MISMATCH')
    if (request.role === 'draft') {
      if (run.rootActionId !== root.rootActionId || manifest.batchId !== task.batchRunId) fail('RUN_MISMATCH')
      for (let chapter = range.startChapter; chapter < request.chapterNumber; chapter++) if (!this.currentDraft(task, chapter)) fail('STEP_ORDER')
    } else {
      if (run.rootActionId === root.rootActionId || manifest.batchId !== undefined) fail('RUN_MISMATCH')
      if (this.db.prepare(`SELECT 1 FROM workflow_batch_steps s JOIN generation_runs r ON r.run_id=s.run_id
        WHERE s.role='review' AND r.root_action_id=? AND (s.task_id<>? OR s.chapter_number<>?) LIMIT 1`)
        .get(run.rootActionId, task.taskId, request.chapterNumber)) fail('RUN_MISMATCH')
      for (let chapter = range.startChapter; chapter <= range.endChapter; chapter++) if (!this.currentDraft(task, chapter)) fail('STEP_ORDER')
      for (let chapter = range.startChapter; chapter < request.chapterNumber; chapter++) {
        if (!this.readSteps(task.taskId).some(v => v.chapterNumber === chapter && v.kind === 'review_commit'
          && readWorkflowBatchEffectProof(this.db, task.taskId, v.stepId))) fail('STEP_ORDER')
      }
      const context = object(manifest.reviewRevisionContext), source = object(context.source), draft = this.draftCommit(task, request.chapterNumber)!
      const model = object(manifest.modelReceipt)
      if (context.operation !== 'review-chapter' || context.recheck !== undefined || context.confirmation !== undefined
        || context.writingLanguage !== task.recipe.writingLanguage || context.uiLocale !== task.recipe.uiLocale
        || source.id !== draft.saved.id || source.version !== draft.saved.version || source.content !== draft.saved.content
        || model.modelId !== task.reviewModelId || run.binding.fingerprint.modelLeaseRevision !== task.reviewModelHash) fail('REVIEW_SOURCE_MISMATCH')
    }
    const steps = this.readSteps(task.taskId)
    if (steps.some(v => v.chapterNumber === request.chapterNumber && v.role === request.role && v.runId !== request.runId)
      || this.db.prepare('SELECT 1 FROM workflow_batch_steps WHERE run_id=? AND (task_id<>? OR chapter_number<>? OR role<>?) LIMIT 1')
        .get(request.runId, task.taskId, request.chapterNumber, request.role)) fail('RUN_MISMATCH')
  }
  private observed(task: WorkflowBatchTask, step: WorkflowBatchStep) {
    const proof = readWorkflowBatchEffectProof(this.db, task.taskId, step.stepId)
    if (!proof) fail('STEP_ORDER')
    return this.runs.receipt(proof.receiptAttemptId)
  }
  private order(task: WorkflowBatchTask, request: BindWorkflowBatchStep, excludeStepId?: string): void {
    const steps = this.readSteps(task.taskId).filter(v => v.runId === request.runId && v.stepId !== excludeStepId), input = request.input
    const find = (kind: WorkflowBatchStepKind, slot = 0) => steps.find(v => v.kind === kind && v.slot === slot)
    if (input.kind === 'model') {
      for (const other of steps.filter(v => v.input.kind === 'model')) if (!readWorkflowBatchEffectProof(this.db, task.taskId, other.stepId)) fail('STEP_UNRESOLVED')
      if (request.kind === 'outline' && request.slot === 1) {
        const first = find('outline'); if (!first || !isDeepStrictEqual(first.input, input)) fail('STEP_ORDER')
        const prior = this.observed(task, first)
        if (this.runs.attemptCount(request.runId) !== 1 || prior.attempt.status !== 'settled'
          || prior.failureCode || prior.unsavedTail || !prior.artifact
          || !(prior.result?.finishReason === 'length' || prior.result?.finishReason === 'stop' && !prior.artifact.text.trim())) fail('OUTLINE_RETRY_INVALID')
      } else if (request.kind === 'draft') {
        const outlines = steps.filter(v => v.kind === 'outline').sort((a, b) => b.slot - a.slot), latest = outlines[0]
        if (!latest) fail('STEP_ORDER')
        const prior = this.observed(task, latest), user = input.task.messages.filter(v => v.role === 'user')
        const decision = object(this.runs.get(request.runId).binding.sourceManifest.materialDecision)
        if (prior.result?.finishReason !== 'stop' || prior.failureCode || !prior.artifact?.text.trim() || user.length !== 1
          || textHash(stripDraftShortOutlineBlock(user[0].content, prior.artifact.text) ?? '') !== decision.promptHash) fail('INPUT_MISMATCH')
      } else if (request.kind === 'continue' || request.kind === 'condense') {
        const composition = this.runs.readVisibleComposition(request.runId)
        if (!composition || !find('draft')) fail('STEP_ORDER')
        const target = task.recipe.intent.targetUnits
        if (request.kind === 'condense') { if (!shouldCondenseDraft(countDraftUnits(composition.text), target, false)) fail('STEP_ORDER') }
        else {
          const previous = request.slot === 0 ? find('draft') : find('continue', request.slot - 1)
          if (!previous || steps.filter(v => v.kind === 'continue').length !== request.slot) fail('STEP_ORDER')
          const prior = this.observed(task, previous)
          if (!shouldAutoContinueDraft(composition.text, target, request.slot, prior.result?.finishReason as 'stop' | 'length')) fail('STEP_ORDER')
          const recovery = input.task.purpose === 'chapter-draft-no-progress-recovery'
          const included = prior.artifact && composition.artifactIds.includes(prior.artifact.artifactId)
          if (request.slot > 0 && included && prior.result?.finishReason === 'stop') {
            let prefix = ''
            for (const artifactId of composition.artifactIds.slice(0, -1)) {
              const attemptId = this.db.prepare('SELECT attempt_id FROM generation_artifacts WHERE artifact_id=? AND run_id=?').pluck().get(artifactId, request.runId) as string
              const text = this.runs.receipt(attemptId).artifact!.text
              prefix = prefix ? composeDraftVisibleContinuation(prefix, text, composition.algorithm as never) : sanitizeDraftText(text, composition.algorithm as never)
            }
            // The old loop ACKs a stop result, then exits on a net increase below 300 draft units.
            if (countDraftUnits(composition.text) - countDraftUnits(prefix) < 300) fail('STEP_ORDER')
          }
          if (request.slot > 0 && !included) {
            if (!prior.artifact || prior.result?.finishReason !== 'length' || !isLowProgressDraftContinuation('length',
              countDraftUnits(composeDraftVisibleContinuation(composition.text, prior.artifact.text, composition.algorithm as never)) - countDraftUnits(composition.text)) || !recovery) fail('STEP_ORDER')
          } else if (recovery) fail('STEP_ORDER')
          if (recovery && steps.some(v => v.input.kind === 'model' && v.input.task.purpose === 'chapter-draft-no-progress-recovery')) fail('RECOVERY_LIMIT')
        }
      } else if (request.kind === 'review' && request.slot === 1 || request.kind === 'review_rebuild') {
        const previous = request.slot === 1 ? find(request.kind, 0) : find('review', 1) ?? find('review')
        if (!previous) fail('STEP_ORDER')
        const prior = this.observed(task, previous)
        if (request.slot === 1 && prior.result?.finishReason !== 'length') fail('STEP_ORDER')
      }
      if (request.kind === 'outline') {
        const users = input.task.messages.filter(v => v.role === 'user'), decision = object(this.runs.get(request.runId).binding.sourceManifest.materialDecision)
        if (users.length !== 1 || textHash(users[0].content) !== decision.shortOutlinePromptHash) fail('INPUT_MISMATCH')
      }
      if (input.task.budgetDemand && input.task.budgetDemand.writingLanguage !== task.recipe.writingLanguage) fail('LANGUAGE_MISMATCH')
    } else if (input.kind === 'compose') {
      const model = request.slot === 0 ? find('draft') : request.slot === 8 ? find('condense') : find('continue', request.slot - 1)
      if (!model) fail('STEP_ORDER')
      const prior = this.observed(task, model), current = this.runs.readVisibleComposition(request.runId)
      if (!prior.artifact || input.artifactIds.at(-1) !== prior.artifact.artifactId
        || current && !isDeepStrictEqual(current.artifactIds, input.artifactIds)
          && !isDeepStrictEqual([...current.artifactIds, prior.artifact.artifactId], input.artifactIds)) fail('INPUT_MISMATCH')
    } else if (input.kind === 'draft-commit') {
      const current = this.runs.readVisibleComposition(request.runId)
      if (!current || current.textHash !== input.expectedCompositionHash) fail('INPUT_MISMATCH')
    } else {
      const model = steps.find(v => v.input.kind === 'model' && this.observed(task, v).artifact?.artifactId === input.artifact.artifactId)
      if (!model) fail('INPUT_MISMATCH')
    }
  }
  bindStep(ref: WorkflowBatchRef, request: BindWorkflowBatchStep): WorkflowBatchStep {
    closed(request, ['chapterNumber', 'role', 'kind', 'slot', 'runId', 'input'])
    const input = parseWorkflowBatchStepInput(request.input), encoded = JSON.stringify(input)
    assertWorkflowBatchSlot(request.role, request.kind, integer(request.slot), input)
    const first = !this.readSteps(ref.taskId).some(v => v.chapterNumber === request.chapterNumber && v.role === request.role)
    if (first && !this.db.inTransaction) fail('TRANSACTION_REQUIRED')
    return this.transaction(() => {
      const task = this.assertActive(ref), normalized = { ...request, input }
      const previous = this.readSteps(task.taskId).find(v => v.chapterNumber === request.chapterNumber && v.kind === request.kind && v.slot === request.slot)
      if (previous) {
        this.mutable(task, previous)
        if (previous.runId !== request.runId || previous.role !== request.role || JSON.stringify(previous.input) !== encoded) fail('INPUT_CONFLICT')
        return previous
      }
      this.role(task, normalized)
      if (first && (request.kind !== (request.role === 'draft' ? 'outline' : 'review') || request.slot !== 0 || this.runs.attemptCount(request.runId))) fail('RUN_ALREADY_STARTED')
      this.order(task, normalized)
      const stepId = randomUUID(), commandId = randomUUID()
      let nonce: string | null = input.kind === 'model' ? randomUUID() : null
      if (request.kind === 'outline' && request.slot === 1) {
        const prior = this.readSteps(task.taskId).find(v => v.runId === request.runId && v.kind === 'outline' && v.slot === 0)!
        nonce = `draft-short-outline-retry:${this.observed(task, prior).attempt.attemptId}`
      }
      this.db.prepare('INSERT INTO workflow_batch_steps VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(stepId, task.taskId, integer(request.chapterNumber, 1), request.role, request.kind, request.slot, commandId, id(request.runId), nonce, encoded, textHash(encoded))
      return this.readSteps(task.taskId).find(v => v.stepId === stepId)!
    })
  }
  assertDispatch(ref: WorkflowBatchRef, stepId: string, nonce: string, taskInput: GenerationTask): void {
    const task = this.assertActive(ref), step = this.readSteps(task.taskId).find(v => v.stepId === id(stepId))
    if (!step || step.input.kind !== 'model' || step.invocationNonce !== nonce || !isDeepStrictEqual(step.input.task, taskInput)) fail('INPUT_MISMATCH')
    this.mutable(task, step); this.role(task, step); this.order(task, step, step.stepId)
    if (step.kind === 'outline' && step.slot === 1) {
      const first = this.readSteps(task.taskId).find(value => value.runId === step.runId && value.kind === 'outline' && value.slot === 0)
      if (!first || nonce !== `draft-short-outline-retry:${this.observed(task, first).attempt.attemptId}`) fail('OUTLINE_RETRY_INVALID')
    }
    if (this.db.prepare('SELECT 1 FROM generation_attempts WHERE run_id=? AND invocation_nonce=?').get(step.runId, nonce)) fail('INVOCATION_ALREADY_RESERVED')
  }
  private requireStep(task: WorkflowBatchTask, stepId: string): WorkflowBatchStep {
    const step = this.readSteps(task.taskId).find(v => v.stepId === id(stepId)); if (!step) fail('STEP_MISMATCH'); this.mutable(task, step); return step
  }
  private acknowledge(task: WorkflowBatchTask, step: WorkflowBatchStep): WorkflowBatchEffect | null {
    const found = readWorkflowBatchEffectProof(this.db, task.taskId, step.stepId), prior = this.readEffects(task.taskId).find(v => v.stepId === step.stepId)
    if (!found) { if (prior) fail('RECEIPT_INVALID'); return null }
    if (found.receiptKind !== receiptKind(step.kind)) fail('RECEIPT_INVALID')
    if (found.receiptKind === 'review_commit') {
      const run = this.runs.get(step.runId)
      const strict = new ReviewRevisionGeneration(this.db, this.runs, { projectId: task.projectId, epoch: run.binding.epoch }, () => this.current()).readCommittedReview(step.runId)
      if (!strict || strict.attemptId !== found.receiptAttemptId || strict.receipt.contentHash !== found.contentHash) fail('RECEIPT_INVALID')
    }
    if (prior && (prior.receiptKind !== found.receiptKind || prior.receiptAttemptId !== found.receiptAttemptId || prior.contentHash !== found.contentHash
      || prior.semanticHistory !== null || prior.semanticHistoryHash !== null)) fail('RECEIPT_CONFLICT')
    const effect = prior ?? { ...found, stepId: step.stepId, acknowledgedAt: this.now(task), semanticHistory: null, semanticHistoryHash: null }
    if (!prior) this.db.prepare('INSERT INTO workflow_batch_effects VALUES(?,?,?,?,?,NULL,NULL)')
      .run(step.stepId, found.receiptKind, found.receiptAttemptId, found.contentHash, effect.acknowledgedAt)
    if (found.receiptKind === 'draft_commit' || found.receiptKind === 'review_commit') this.converge(task)
    return effect
  }
  private converge(task: WorkflowBatchTask): void {
    if (task.state === 'cancelled') return
    const range = task.recipe.intent.range
    for (let chapter = range.startChapter; chapter <= range.endChapter; chapter++) {
      if (this.draftCommit(task, chapter) && !this.currentDraft(task, chapter)) {
        if (task.blockedCode !== 'SOURCE_DRAFT_CHANGED') this.db.prepare("UPDATE workflow_batch_tasks SET state='blocked',blocked_code='SOURCE_DRAFT_CHANGED',revision=revision+1,updated_at=? WHERE task_id=?")
          .run(this.now(task), task.taskId)
        return
      }
    }
    if (task.blockedCode === 'SOURCE_DRAFT_CHANGED') return
    const steps = this.readSteps(task.taskId), effects = this.readEffects(task.taskId)
    if (Array.from({ length: range.endChapter - range.startChapter + 1 }, (_, index) => range.startChapter + index)
      .every(chapter => steps.some(v => v.chapterNumber === chapter && v.kind === 'review_commit' && effects.some(e => e.stepId === v.stepId)))) {
      this.db.prepare("UPDATE workflow_batch_tasks SET state='waiting_review',blocked_code=NULL,updated_at=? WHERE task_id=?").run(this.now(task), task.taskId)
    }
  }
  acknowledgeFromReceipt(ref: WorkflowBatchRef, stepId: string): WorkflowBatchEffect | null {
    return this.transaction(() => { const task = this.reference(ref); return this.acknowledge(task, this.requireStep(task, stepId)) })
  }
  withEffectCommit(ref: WorkflowBatchRef, stepId: string, callback: () => unknown): WorkflowBatchEffect {
    return this.transaction(() => {
      const task = this.reference(ref), step = this.requireStep(task, stepId)
      if (step.input.kind === 'model') fail('MODEL_CALLBACK_INVALID')
      const previous = this.acknowledge(task, step); if (previous) return previous
      this.assertActive(ref); this.role(task, step); this.order(task, step)
      if (Object.prototype.toString.call(callback) === '[object AsyncFunction]') fail('ASYNC_CALLBACK_INVALID')
      const result = callback()
      if (result && typeof (result as { then?: unknown }).then === 'function') fail('ASYNC_CALLBACK_INVALID')
      this.assertActive(ref)
      const effect = this.acknowledge(task, step); if (!effect) fail('RECEIPT_NOT_COMMITTED'); return effect
    })
  }
  private state(ref: WorkflowBatchRef, next: WorkflowBatchState, blockedCode: string | null): WorkflowBatchTask {
    return this.transaction(() => {
      closed(ref, ['taskId', 'revision', 'batchRunId'])
      const task = this.required(id(ref.taskId)); this.mutable(task)
      if (task.batchRunId !== id(ref.batchRunId)) fail('RUN_MISMATCH')
      if (task.state === next && task.blockedCode === blockedCode && [ref.revision, ref.revision + 1].includes(task.revision)) return task
      if (task.revision !== integer(ref.revision, 1)) fail('REVISION_CONFLICT')
      if (task.state === 'cancelled' || task.state === 'waiting_review') return task
      if (next === 'ready') {
        this.root(task)
        const range = task.recipe.intent.range
        for (let chapter = range.startChapter; chapter <= range.endChapter; chapter++) {
          if (this.draftCommit(task, chapter) && !this.currentDraft(task, chapter)) fail('SOURCE_DRAFT_CHANGED')
        }
      }
      this.db.prepare('UPDATE workflow_batch_tasks SET state=?,blocked_code=?,revision=revision+1,updated_at=? WHERE task_id=?')
        .run(next, blockedCode, this.now(task), task.taskId)
      return this.required(task.taskId)
    })
  }
  pause(ref: WorkflowBatchRef): WorkflowBatchTask { return this.state(ref, 'paused', null) }
  cancel(ref: WorkflowBatchRef): WorkflowBatchTask { return this.state(ref, 'cancelled', null) }
  resume(ref: WorkflowBatchRef): WorkflowBatchTask { return this.state(ref, 'ready', null) }
  block(ref: WorkflowBatchRef, code: string): WorkflowBatchTask {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) fail('BLOCK_CODE_INVALID')
    return this.state(ref, 'blocked', code)
  }
}
