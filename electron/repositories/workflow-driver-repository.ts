import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { parseWorkflowDriverRecipe, parseWorkflowDriverStepInput,
  type WorkflowDriverRecipe, type WorkflowDriverState, type WorkflowDriverStepInput,
  type WorkflowDriverStepKind } from '../../src/shared/workflow-driver-contract'
import { DRAFT_SHORT_OUTLINE_PURPOSE, draftShortOutlineBlock } from '../../src/shared/draft-short-outline'
import { isContentHash } from '../../src/shared/source-ref'
import { GenerationRunRepository, textHash } from './generation-run-repository'

type Row = Record<string, unknown>
export type WorkflowDriverTable = 'workflow_tasks' | 'workflow_steps' | 'workflow_effects'
export type WorkflowDriverReceiptKind = 'model' | 'composition' | 'draft_commit'
const kinds = ['outline', 'draft', 'compose', 'commit'] as const
const idPattern = /^[\p{L}\p{N}._:@+-]{1,512}$/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const codePattern = /^[A-Z][A-Z0-9_]{0,127}$/u
function fail(code: string): never { throw new Error(`WORKFLOW_DRIVER_${code}`) }
function id(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) fail('ID_INVALID')
  return value
}
function operationKey(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) fail('OPERATION_KEY_INVALID')
  return value
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail('INVALID')
  return Number(value)
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !isContentHash(value)) fail('HASH_INVALID')
  return value
}
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INTEGRITY_FAILED')
  return value as Row
}
function parsed(value: unknown): Row {
  if (typeof value !== 'string') fail('INTEGRITY_FAILED')
  try { return record(JSON.parse(value)) } catch { fail('INTEGRITY_FAILED') }
}
function closed(value: unknown, required: string[], optional: string[] = []): void {
  const row = record(value)
  if (!required.every(key => Object.hasOwn(row, key))
    || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) fail('INVALID')
}

export interface WorkflowDriverTaskRef { taskId: string; revision: number; runId: string }
export type WorkflowDriverRef = WorkflowDriverTaskRef
export interface WorkflowDriverTask extends WorkflowDriverTaskRef {
  projectId: string
  operationKey: string
  requestHash: string | null
  template: 'prepared-first-chapter-v1'
  state: WorkflowDriverState
  blockedCode: string | null
  recipe: WorkflowDriverRecipe
  recipeHash: string
  createdAt: number
  updatedAt: number
}
export interface WorkflowDriverStep {
  stepId: string
  taskId: string
  ordinal: number
  kind: WorkflowDriverStepKind
  commandId: string
  invocationNonce: string | null
  input: WorkflowDriverStepInput | null
  inputHash: string | null
}
export interface WorkflowDriverEffect {
  stepId: string
  receiptKind: WorkflowDriverReceiptKind
  receiptAttemptId: string
  contentHash: string
  acknowledgedAt: number
}
export interface IssueWorkflowDriverTask {
  taskId: string
  operationKey: string
  requestHash: string
  runId: string
  recipe: WorkflowDriverRecipe
  createdAt?: number
}
export interface WorkflowDriverRepositoryOptions {
  projectId: string
  /** Captured runtime/native resources only; process-local execution grants live in the service. */
  assertCurrent(): void
  isFrozen(table: WorkflowDriverTable, recordId: string): boolean
  now?(): number
}

/** Stores control/history and references to original receipts, never a second effect result. */
export class WorkflowDriverRepository {
  private readonly runs: GenerationRunRepository
  constructor(private readonly db: Database.Database, private readonly options: WorkflowDriverRepositoryOptions) {
    id(options.projectId)
    this.runs = new GenerationRunRepository(() => db, options.now)
  }
  private current(): void {
    if (!this.db.open) fail('DATABASE_NOT_READY')
    const result: unknown = this.options.assertCurrent()
    if (result !== undefined) fail('ASYNC_GUARD_INVALID')
  }
  private transaction<T>(callback: () => T): T {
    this.current()
    return this.db.transaction(() => { this.current(); return callback() }).immediate()
  }
  private now(task?: WorkflowDriverTask): number {
    return Math.max(task?.updatedAt ?? 0, integer((this.options.now ?? Date.now)()))
  }
  private mutable(task: WorkflowDriverTask, step?: WorkflowDriverStep): void {
    if (this.options.isFrozen('workflow_tasks', task.taskId)
      || step && (this.options.isFrozen('workflow_steps', step.stepId) || this.options.isFrozen('workflow_effects', step.stepId))) fail('HISTORY_FROZEN')
    if (task.projectId !== this.options.projectId) fail('PROJECT_MISMATCH')
    if (task.requestHash === null) fail('HISTORY_FROZEN')
  }
  private task(row: Row): WorkflowDriverTask {
    if (row.template !== 'prepared-first-chapter-v1' || !['ready', 'paused', 'blocked', 'cancelled', 'waiting_review'].includes(String(row.state))
      || (row.state === 'blocked' ? typeof row.blocked_code !== 'string' || !codePattern.test(row.blocked_code) : row.blocked_code !== null)) fail('INTEGRITY_FAILED')
    const recipe = parseWorkflowDriverRecipe(parsed(row.recipe_json)), recipeHash = hash(row.recipe_hash)
    if (JSON.stringify(recipe) !== row.recipe_json || textHash(JSON.stringify(recipe)) !== recipeHash) fail('INTEGRITY_FAILED')
    const task: WorkflowDriverTask = { taskId: id(row.task_id), projectId: id(row.project_id), operationKey: id(row.operation_key),
      requestHash: row.request_hash === null ? null : hash(row.request_hash), template: row.template, runId: id(row.run_id),
      revision: integer(row.revision, 1), state: row.state as WorkflowDriverState, blockedCode: row.blocked_code as string | null,
      recipe, recipeHash, createdAt: integer(row.created_at), updatedAt: integer(row.updated_at) }
    if (task.updatedAt < task.createdAt) fail('INTEGRITY_FAILED')
    if (task.projectId !== this.options.projectId && !this.options.isFrozen('workflow_tasks', task.taskId)) fail('PROJECT_MISMATCH')
    return task
  }
  get(taskId: string): WorkflowDriverTask | null {
    this.current()
    const row = this.db.prepare('SELECT * FROM workflow_tasks WHERE task_id=?').get(id(taskId)) as Row | undefined
    return row ? this.task(row) : null
  }
  getByOperation(key: string): WorkflowDriverTask | null {
    this.current()
    const row = this.db.prepare('SELECT * FROM workflow_tasks WHERE operation_key=?').get(id(key)) as Row | undefined
    return row ? this.task(row) : null
  }
  private requireTask(taskId: string): WorkflowDriverTask {
    const task = this.get(taskId)
    if (!task) fail('MISSING')
    return task
  }
  private step(row: Row): WorkflowDriverStep {
    const ordinal = integer(row.ordinal)
    if (kinds[ordinal] !== row.kind || (row.input_json === null) !== (row.input_hash === null)
      || ordinal > 1 && row.invocation_nonce !== null) fail('INTEGRITY_FAILED')
    const input = row.input_json === null ? null : parseWorkflowDriverStepInput(parsed(row.input_json))
    const inputHash = row.input_hash === null ? null : hash(row.input_hash)
    if (input && (input.kind !== (ordinal < 2 ? 'model' : ordinal === 2 ? 'compose' : 'commit')
      || JSON.stringify(input) !== row.input_json || textHash(JSON.stringify(input)) !== inputHash)) fail('INTEGRITY_FAILED')
    return { stepId: id(row.step_id), taskId: id(row.task_id), ordinal, kind: row.kind as WorkflowDriverStepKind,
      commandId: id(row.command_id), invocationNonce: row.invocation_nonce === null ? null : id(row.invocation_nonce), input, inputHash }
  }
  readSteps(taskId: string): WorkflowDriverStep[] {
    this.requireTask(taskId)
    const steps = (this.db.prepare('SELECT * FROM workflow_steps WHERE task_id=? ORDER BY ordinal').all(taskId) as Row[]).map(row => this.step(row))
    if (steps.length !== 4 || steps.some((step, index) => step.ordinal !== index)) fail('INTEGRITY_FAILED')
    return steps
  }
  private effect(row: Row): WorkflowDriverEffect {
    if (!['model', 'composition', 'draft_commit'].includes(String(row.receipt_kind))) fail('INTEGRITY_FAILED')
    return { stepId: id(row.step_id), receiptKind: row.receipt_kind as WorkflowDriverReceiptKind,
      receiptAttemptId: id(row.receipt_attempt_id), contentHash: hash(row.content_hash), acknowledgedAt: integer(row.acknowledged_at) }
  }
  readEffects(taskId: string): WorkflowDriverEffect[] {
    this.requireTask(taskId)
    return (this.db.prepare(`SELECT e.* FROM workflow_effects e JOIN workflow_steps s ON s.step_id=e.step_id
      WHERE s.task_id=? ORDER BY s.ordinal`).all(taskId) as Row[]).map(row => this.effect(row))
  }
  private reference(ref: WorkflowDriverTaskRef): WorkflowDriverTask {
    closed(ref, ['taskId', 'revision', 'runId'])
    integer(ref.revision, 1)
    const task = this.requireTask(id(ref.taskId))
    this.mutable(task)
    if (task.runId !== id(ref.runId)) fail('RUN_MISMATCH')
    if (task.revision !== ref.revision) fail('REVISION_CONFLICT')
    return task
  }
  private run(task: Pick<WorkflowDriverTask, 'projectId' | 'runId' | 'recipe'>): void {
    const run = this.runs.get(task.runId), manifest = run.binding.sourceManifest
    const root = this.runs.budget(run.rootActionId).root
    const decision = record(manifest.materialDecision)
    const outlineUsers = task.recipe.outlineTask.messages.filter(message => message.role === 'user')
    const draftUsers = task.recipe.baseDraftTask.messages.filter(message => message.role === 'user')
    if (manifest.freezeWritingLanguage !== true || manifest.writingLanguage !== task.recipe.writingLanguage
      || [task.recipe.outlineTask, task.recipe.baseDraftTask].some(input => input.budgetDemand
        && input.budgetDemand.writingLanguage !== task.recipe.writingLanguage)) fail('LANGUAGE_MISMATCH')
    const core = this.db.prepare("SELECT writing_language FROM project_core WHERE id='main'").get() as Row | undefined
    if (!core || (core.writing_language === 'en-US' ? 'en-US' : 'zh-CN') !== manifest.writingLanguage) fail('SOURCE_LANGUAGE_CHANGED')
    if (run.binding.projectId !== task.projectId || root.projectId !== task.projectId
      || root.operation !== 'chapter-draft' || manifest.operation !== 'chapter-draft' || manifest.chapterNumber !== 1
      || manifest.outputContract !== 'visible-text' || manifest.batchId !== undefined || manifest.importSlot !== undefined
      || decision.version !== 1 || decision.verdict !== 'admitted' || outlineUsers.length !== 1 || draftUsers.length !== 1
      || decision.shortOutlinePromptHash !== textHash(outlineUsers[0]!.content)
      || decision.promptHash !== textHash(draftUsers[0]!.content)
      || task.recipe.outlineTask.purpose !== DRAFT_SHORT_OUTLINE_PURPOSE || task.recipe.baseDraftTask.purpose !== 'chapter-draft') fail('RUN_MISMATCH')
  }
  issue(request: IssueWorkflowDriverTask): WorkflowDriverTask {
    closed(request, ['taskId', 'operationKey', 'requestHash', 'runId', 'recipe'], ['createdAt'])
    operationKey(request.taskId)
    operationKey(request.operationKey)
    hash(request.requestHash)
    id(request.runId)
    const recipe = parseWorkflowDriverRecipe(request.recipe), recipeJson = JSON.stringify(recipe)
    return this.transaction(() => {
      const prior = this.getByOperation(request.operationKey)
      if (prior) {
        this.mutable(prior)
        if (prior.requestHash !== request.requestHash || prior.runId !== request.runId || JSON.stringify(prior.recipe) !== recipeJson) fail('IDEMPOTENCY_CONFLICT')
        this.run(prior)
        return prior
      }
      if (this.get(request.taskId) || this.db.prepare('SELECT 1 FROM workflow_tasks WHERE run_id=?').get(request.runId)) fail('IDEMPOTENCY_CONFLICT')
      if (this.options.isFrozen('workflow_tasks', request.taskId)) fail('HISTORY_FROZEN')
      this.run({ projectId: this.options.projectId, runId: request.runId, recipe })
      if (this.db.prepare('SELECT 1 FROM generation_attempts WHERE run_id=?').get(request.runId)) fail('RUN_ALREADY_STARTED')
      const now = integer(request.createdAt ?? this.now())
      this.db.prepare(`INSERT INTO workflow_tasks
        (task_id,project_id,operation_key,request_hash,template,run_id,revision,state,blocked_code,recipe_json,recipe_hash,created_at,updated_at)
        VALUES(?,?,?,?,'prepared-first-chapter-v1',?,1,'ready',NULL,?,?,?,?)`)
        .run(request.taskId, this.options.projectId, request.operationKey, request.requestHash, request.runId, recipeJson, textHash(recipeJson), now, now)
      const insert = this.db.prepare(`INSERT INTO workflow_steps
        (step_id,task_id,ordinal,kind,command_id,invocation_nonce,input_json,input_hash) VALUES(?,?,?,?,?,?,NULL,NULL)`)
      for (const [ordinal, kind] of kinds.entries()) insert.run(randomUUID(), request.taskId, ordinal, kind, randomUUID(), ordinal < 2 ? randomUUID() : null)
      return this.requireTask(request.taskId)
    })
  }
  assertActive(ref: WorkflowDriverTaskRef): WorkflowDriverTask {
    this.current()
    if (!this.db.inTransaction) fail('TRANSACTION_REQUIRED')
    const task = this.reference(ref)
    if (task.state !== 'ready') fail('INACTIVE')
    this.run(task)
    const steps = this.readSteps(task.taskId)
    for (const step of steps) this.mutable(task, step)
    if (steps.some(step => step.ordinal < 2 && step.invocationNonce === null)) fail('HISTORY_FROZEN')
    return task
  }
  private requireStep(task: WorkflowDriverTask, stepId: string): WorkflowDriverStep {
    const step = this.readSteps(task.taskId).find(item => item.stepId === id(stepId))
    if (!step) fail('STEP_MISMATCH')
    this.mutable(task, step)
    return step
  }
  private preceding(task: WorkflowDriverTask, step: WorkflowDriverStep): void {
    const effects = this.readEffects(task.taskId)
    const steps = this.readSteps(task.taskId)
    if (steps.slice(0, step.ordinal).some(item => !effects.some(effect => effect.stepId === item.stepId))) fail('STEP_ORDER')
  }
  private expectedInput(task: WorkflowDriverTask, step: WorkflowDriverStep, input: WorkflowDriverStepInput): void {
    if (step.kind === 'outline') {
      if (input.kind !== 'model' || !isDeepStrictEqual(input.task, task.recipe.outlineTask)) fail('INPUT_MISMATCH')
    } else if (step.kind === 'draft') {
      const outline = this.readSteps(task.taskId)[0]!, effect = this.readEffects(task.taskId).find(item => item.stepId === outline.stepId)
      if (!effect) fail('STEP_ORDER')
      const artifact = this.runs.receipt(effect.receiptAttemptId).artifact
      if (!artifact) fail('RECEIPT_INVALID')
      const base = task.recipe.baseDraftTask, expected = { ...base, messages: base.messages.map(message => message.role === 'user'
        ? { ...message, content: `${message.content}\n\n${draftShortOutlineBlock(task.recipe.writingLanguage, artifact.text)}` } : { ...message }) }
      if (input.kind !== 'model' || !isDeepStrictEqual(input.task, expected)) fail('INPUT_MISMATCH')
    } else if (step.kind === 'compose') {
      const draft = this.readSteps(task.taskId)[1]!, effect = this.readEffects(task.taskId).find(item => item.stepId === draft.stepId)
      const artifact = effect ? this.runs.receipt(effect.receiptAttemptId).artifact : null
      if (input.kind !== 'compose' || !artifact || input.artifactIds.length !== 1 || input.artifactIds[0] !== artifact.artifactId) fail('INPUT_MISMATCH')
    } else {
      const composition = this.runs.readVisibleComposition(task.runId)
      if (input.kind !== 'commit' || input.chapterNumber !== 1 || !composition || input.expectedCompositionHash !== composition.textHash) fail('INPUT_MISMATCH')
    }
  }
  bindInput(ref: WorkflowDriverTaskRef, stepId: string, value: WorkflowDriverStepInput): WorkflowDriverStep {
    const input = parseWorkflowDriverStepInput(value), json = JSON.stringify(input)
    return this.transaction(() => {
      const task = this.assertActive(ref), step = this.requireStep(task, stepId)
      this.preceding(task, step)
      if (step.input !== null) {
        if (JSON.stringify(step.input) !== json) fail('INPUT_CONFLICT')
        return step
      }
      if (step.ordinal < 2 && step.invocationNonce === null) fail('HISTORY_FROZEN')
      this.expectedInput(task, step, input)
      this.db.prepare('UPDATE workflow_steps SET input_json=?,input_hash=? WHERE step_id=? AND input_json IS NULL').run(json, textHash(json), step.stepId)
      return this.requireStep(task, stepId)
    })
  }
  private state(ref: WorkflowDriverTaskRef, state: WorkflowDriverState, blockedCode: string | null): WorkflowDriverTask {
    return this.transaction(() => {
      const task = this.requireTask(ref.taskId)
      closed(ref, ['taskId', 'revision', 'runId'])
      integer(ref.revision, 1)
      this.mutable(task)
      if (task.runId !== id(ref.runId)) fail('RUN_MISMATCH')
      if (task.state === state && task.blockedCode === blockedCode && (task.revision === ref.revision || task.revision === ref.revision + 1)) return task
      if (task.revision !== ref.revision) fail('REVISION_CONFLICT')
      if (task.state === 'waiting_review' || task.state === 'cancelled') return task
      if (state === 'ready') this.run(task)
      this.db.prepare('UPDATE workflow_tasks SET state=?,blocked_code=?,revision=revision+1,updated_at=? WHERE task_id=? AND revision=?')
        .run(state, blockedCode, this.now(task), task.taskId, task.revision)
      return this.requireTask(task.taskId)
    })
  }
  pause(ref: WorkflowDriverTaskRef): WorkflowDriverTask { return this.state(ref, 'paused', null) }
  cancel(ref: WorkflowDriverTaskRef): WorkflowDriverTask { return this.state(ref, 'cancelled', null) }
  resume(ref: WorkflowDriverTaskRef): WorkflowDriverTask { return this.state(ref, 'ready', null) }
  block(ref: WorkflowDriverTaskRef, code: string): WorkflowDriverTask {
    if (!codePattern.test(code)) fail('BLOCK_CODE_INVALID')
    return this.state(ref, 'blocked', code)
  }
  private receipt(task: WorkflowDriverTask, step: WorkflowDriverStep): Omit<WorkflowDriverEffect, 'acknowledgedAt'> | null {
    if (!step.input) fail('INPUT_REQUIRED')
    const input = step.input
    this.expectedInput(task, step, input)
    if (input.kind === 'model') {
      if (step.invocationNonce === null) fail('HISTORY_FROZEN')
      const run = this.runs.get(task.runId), requestHash = textHash(JSON.stringify([input.task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
      const receipt = this.runs.findInvocation(task.runId, step.invocationNonce, requestHash)
      if (!receipt) return null
      const row = this.db.prepare(`SELECT t.usage_receipt_json,a.status FROM generation_attempts t
        LEFT JOIN generation_artifacts a ON a.attempt_id=t.attempt_id WHERE t.attempt_id=?`).get(receipt.attempt.attemptId) as Row
      const usage = parsed(row.usage_receipt_json)
      if (usage.purpose !== input.task.purpose || !isDeepStrictEqual(usage.replayTask, input.task)) fail('RECEIPT_INVALID')
      if (!['settled', 'unknown'].includes(receipt.attempt.status) || receipt.result?.finishReason !== 'stop' || receipt.failureCode
        || row.status === 'discarded' || !receipt.artifact?.text.trim()
        || this.db.prepare('SELECT 1 FROM generation_recovery_tails WHERE attempt_id=?').get(receipt.attempt.attemptId)) fail('RECEIPT_NOT_COMMITTED')
      return { stepId: step.stepId, receiptKind: 'model', receiptAttemptId: receipt.attempt.attemptId, contentHash: receipt.artifact.textHash }
    }
    const composition = this.runs.readVisibleComposition(task.runId)
    if (!composition) return null
    if (input.kind === 'compose' && (!isDeepStrictEqual(composition.artifactIds, input.artifactIds)
      || composition.algorithm !== input.algorithm || composition.textHash !== input.expectedTextHash)) fail('RECEIPT_INVALID')
    const lastArtifact = composition.artifactIds.at(-1)
    const row = this.db.prepare(`SELECT a.attempt_id,t.usage_receipt_json FROM generation_artifacts a
      JOIN generation_attempts t ON t.attempt_id=a.attempt_id WHERE a.artifact_id=? AND a.run_id=? AND t.run_id=?`)
      .get(lastArtifact, task.runId, task.runId) as Row | undefined
    if (!row) fail('RECEIPT_INVALID')
    if (input.kind === 'compose') return { stepId: step.stepId, receiptKind: 'composition', receiptAttemptId: id(row.attempt_id), contentHash: composition.textHash }
    const usage = parsed(row.usage_receipt_json), commit = usage.draftCommit
    if (commit === undefined) return null
    const saved = record(commit), handle = record(saved.handle), run = this.runs.get(task.runId), identity = record(usage.artifactIdentity)
    if (saved.success !== true || saved.chapterNumber !== input.chapterNumber || input.chapterNumber !== 1
      || saved.contentHash !== input.expectedCompositionHash || saved.contentHash !== composition.textHash
      || saved.content !== composition.text || textHash(String(saved.content)) !== saved.contentHash
      || !isDeepStrictEqual(handle, { projectId: task.projectId, epoch: identity.epoch, runId: task.runId, rootActionId: run.rootActionId })
      || saved.batchId !== undefined || !Number.isSafeInteger(saved.id) || Number(saved.id) < 1
      || !Number.isSafeInteger(saved.version) || Number(saved.version) < 1) fail('RECEIPT_INVALID')
    return { stepId: step.stepId, receiptKind: 'draft_commit', receiptAttemptId: id(row.attempt_id), contentHash: hash(saved.contentHash) }
  }
  private acknowledgeDraftState(task: WorkflowDriverTask, found: Omit<WorkflowDriverEffect, 'acknowledgedAt'>): void {
    if (found.receiptKind !== 'draft_commit' || task.state === 'cancelled') return
    const usage = parsed(this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(found.receiptAttemptId))
    const saved = record(usage.draftCommit)
    const draft = this.db.prepare(`SELECT d.chapter_number,d.version,c.body FROM drafts d
      JOIN contents c ON c.id=d.content_id WHERE d.id=?`).get(saved.id) as Row | undefined
    // A known historical COMMIT is not proof that the author's current draft is still the same.
    if (!draft || draft.chapter_number !== saved.chapterNumber || draft.version !== saved.version || draft.body !== saved.content) {
      if (task.state !== 'blocked' || task.blockedCode !== 'SOURCE_DRAFT_CHANGED') {
        this.db.prepare("UPDATE workflow_tasks SET state='blocked',blocked_code='SOURCE_DRAFT_CHANGED',revision=revision+1,updated_at=? WHERE task_id=?")
          .run(this.now(task), task.taskId)
      }
    } else if (task.state !== 'waiting_review' && !(task.state === 'blocked' && task.blockedCode === 'SOURCE_DRAFT_CHANGED')) {
      this.db.prepare("UPDATE workflow_tasks SET state='waiting_review',blocked_code=NULL,updated_at=? WHERE task_id=?").run(this.now(task), task.taskId)
    }
  }
  private acknowledge(task: WorkflowDriverTask, step: WorkflowDriverStep): WorkflowDriverEffect | null {
    this.preceding(task, step)
    const found = this.receipt(task, step)
    const prior = this.readEffects(task.taskId).find(effect => effect.stepId === step.stepId)
    if (!found) {
      if (prior) fail('RECEIPT_INVALID')
      return null
    }
    if (prior) {
      const { acknowledgedAt: _time, ...reference } = prior
      void _time
      if (!isDeepStrictEqual(reference, found)) fail('RECEIPT_CONFLICT')
      this.acknowledgeDraftState(task, found)
      return prior
    }
    const now = this.now(task)
    this.db.prepare(`INSERT INTO workflow_effects(step_id,receipt_kind,receipt_attempt_id,content_hash,acknowledged_at)
      VALUES(?,?,?,?,?)`).run(found.stepId, found.receiptKind, found.receiptAttemptId, found.contentHash, now)
    this.acknowledgeDraftState(task, found)
    return { ...found, acknowledgedAt: now }
  }
  acknowledgeFromReceipt(ref: WorkflowDriverTaskRef, stepId: string): WorkflowDriverEffect | null {
    return this.transaction(() => {
      const task = this.reference(ref), step = this.requireStep(task, stepId)
      return this.acknowledge(task, step)
    })
  }
  withEffectCommit(ref: WorkflowDriverTaskRef, stepId: string, callback: () => unknown): WorkflowDriverEffect {
    return this.transaction(() => {
      const task = this.reference(ref), step = this.requireStep(task, stepId)
      if (step.kind === 'outline' || step.kind === 'draft') fail('MODEL_CALLBACK_INVALID')
      const existing = this.acknowledge(task, step)
      if (existing) return existing
      this.assertActive(ref)
      if (Object.prototype.toString.call(callback) === '[object AsyncFunction]') fail('ASYNC_CALLBACK_INVALID')
      const result = callback()
      if (result && typeof (result as { then?: unknown }).then === 'function') fail('ASYNC_CALLBACK_INVALID')
      this.assertActive(ref)
      const receipt = this.acknowledge(task, step)
      if (!receipt) fail('RECEIPT_NOT_COMMITTED')
      return receipt
    })
  }
}
