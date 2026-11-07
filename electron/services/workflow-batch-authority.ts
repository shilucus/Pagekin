import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import type { GenerationDraftSaveState, PrepareDraftContextRequest } from '../../src/shared/generation-owner-contract'
import type { DraftStatus } from '../../src/shared/draft-status'
import { buildStructuredReplacementPrompt } from '../../src/shared/structured-replacement-prompt'
import { injectWritingSkillPrompt } from '../../src/shared/writing-skill-task'
import { assertWorkflowBatchRequest, parseStartWorkflowBatchRequest, type StartWorkflowBatchRequest,
  type WorkflowBatchReceipt, type WorkflowBatchReference, type WorkflowBatchResult } from '../../src/shared/workflow-batch-contract'
import { assertOrdinaryHistoryFreezeCoverage, parseOrdinarySemanticHistory, readOrdinaryReviewHistoryReport,
  readVerifiedOrdinaryHistory } from '../migrations/ordinary-review-history'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import { WorkflowBatchRepository, type WorkflowBatchRef, type WorkflowBatchTask } from '../repositories/workflow-batch-repository'
import { generationModelReceiptHash, type SafeGenerationModelReceipt } from './generation-source-binding'
import { GenerationDraftEffects } from './generation-draft-effects'
import type { createMainGenerationOwner, MainGenerationOwnerDependencies } from './main-generation-owner'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import type { ProjectRuntime } from './project-runtime'
import { ReviewRevisionGeneration } from './review-revision-generation'
import { captureReviewRevisionContext, reviewRevisionRequest } from './review-revision-context'
import { runWorkflowBatch } from './workflow-batch-engine'
import { prepareWorkflowBatchMaterials, readWorkflowBatchChapter, readWorkflowReviewAssets } from './workflow-batch-materials'
import { prepareWorkflowReviewMaterials } from './workflow-review-materials'

export interface WorkflowBatchSubject {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
}
type Owner = Pick<ReturnType<typeof createMainGenerationOwner>, 'draftPreparationBinding' | 'prepareDraftContext'
  | 'beginWorkflowBatchRoot' | 'beginWorkflowBatchRun' | 'rollbackWorkflowDriverPreparation'
  | 'executeWorkflowDriver' | 'retryWorkflowBatchShortOutline' | 'recoverWorkflowDriverRun'
  | 'assertWorkflowDriverRecoverySources' | 'pauseWorkflowDriver' | 'prepareReviewRevision' | 'bindMaterialDecision'
  | 'read' | 'composeVisible' | 'commitDraft' | 'commitReview' | 'assertSourcesCurrent' | 'resume'
  | 'hasPhysicalInFlight' | 'whenPhysicalIdle' | 'assertRetirable' | 'retireIdle' | 'requestProjectClose' | 'suspendForProjectClose'>
export interface WorkflowBatchAuthorityOptions {
  runtime: ProjectRuntime
  globalDataRoot: string
  assertAdmission(): void
  assertCapturedResources(): void
  acquireWork(): () => void
  readSafeModelReceipt(modelId: string): SafeGenerationModelReceipt
  captureKnowledge(query: string, chapterNumber: number): Promise<GenerationKnowledgeSnapshot>
  withKnowledge<T>(handle: MainGenerationRunHandle, operation: () => T | Promise<T>): Promise<T>
  withPreparedKnowledge<T>(preparationId: string, chapterNumber: number, operation: () => T | Promise<T>): Promise<T>
  createOwner(hooks: { assertNoRuntimeClaims(): void; workflowDriver: NonNullable<MainGenerationOwnerDependencies['workflowDriver']> }): Owner
}
interface Issuance { subject: WorkflowBatchSubject; task: WorkflowBatchTask; claim: boolean }
const refOf = (task: WorkflowBatchTask): WorkflowBatchRef => ({ taskId: task.taskId, revision: task.revision, batchRunId: task.batchRunId })
const publicRef = (task: WorkflowBatchTask): WorkflowBatchReference => ({ projectId: task.projectId, taskId: task.taskId, revision: task.revision })
function fail(code: string): never { throw new Error(`WORKFLOW_BATCH_${code}`) }

/** History reads neither construct an owner nor mint execution authority. */
export function readWorkflowBatchReceipt(runtime: ProjectRuntime, taskId: string, assertCapturedResources: () => void): WorkflowBatchReceipt {
  assertCapturedResources()
  const freeze = readPortableRuntimeFreeze(runtime.canonicalRoot)
  assertOrdinaryHistoryFreezeCoverage(runtime.database, freeze)
  const history = readVerifiedOrdinaryHistory(runtime.database)
  const repository = new WorkflowBatchRepository(runtime.database, { projectId: runtime.projectId,
    assertCurrent: assertCapturedResources, isFrozen: (table, id) => freeze.isFrozen(table, id) })
  const task = repository.get(taskId)
  if (!task) fail('TASK_MISSING')
  const steps = repository.readSteps(taskId), effects = repository.readEffects(taskId)
  const runIds = [...new Set([task.batchRunId, ...steps.map(step => step.runId)])]
  const historical = history.taskIds.includes(taskId)
  if (freeze.isFrozen('workflow_batch_tasks', taskId) !== historical) fail('HISTORY_INVALID')
  const runs = new GenerationRunRepository(() => runtime.database, Date.now, (table, id) => freeze.isFrozen(table, id))
  const attempts: WorkflowBatchReceipt['attempts'] = []
  const historicalArtifacts: NonNullable<WorkflowBatchReceipt['historicalArtifacts']> = []
  for (const runId of runIds) {
    if (!historical) {
      // A run view includes its whole root budget; only the receipt's actual run owns this attempt.
      attempts.push(...runs.readRunView(runId).attempts.filter(({ receipt }) => receipt.run.runId === runId)
        .map(({ receipt }) => ({ runId: receipt.run.runId, attemptId: receipt.attempt.attemptId,
          status: receipt.attempt.status, artifactId: receipt.artifact?.artifactId ?? null })))
      continue
    }
    // The leaf has already proved the closed graph and actual freeze coverage. Do not hydrate excluded bindings.
    const rows = runtime.database.prepare(`SELECT t.attempt_id,t.attempt_json,a.artifact_id,a.artifact_json,a.revision
      FROM generation_attempts t LEFT JOIN generation_artifacts a ON a.attempt_id=t.attempt_id
      WHERE t.run_id=? ORDER BY t.rowid`).all(runId) as {
      attempt_id: string; attempt_json: string; artifact_id: string | null; artifact_json: string | null; revision: number | null
    }[]
    for (const row of rows) {
      const attempt = JSON.parse(row.attempt_json) as { status: WorkflowBatchReceipt['attempts'][number]['status'] }
      attempts.push({ runId, attemptId: row.attempt_id, status: attempt.status, artifactId: row.artifact_id })
      if (row.artifact_json !== null) {
        const artifact = JSON.parse(row.artifact_json) as { text: string; textHash: string }
        historicalArtifacts.push({ runId, attemptId: row.attempt_id, artifactId: row.artifact_id!, revision: row.revision!,
          text: artifact.text, textHash: artifact.textHash })
      }
    }
  }
  const draftEffects = historical ? null : new GenerationDraftEffects(runtime.database, runs)
  const reviews = historical ? null : new ReviewRevisionGeneration(runtime.database, runs,
    { projectId: runtime.projectId, epoch: runtime.executionEpoch }, assertCapturedResources)
  const chapters: WorkflowBatchReceipt['chapters'] = []
  for (let chapterNumber = task.recipe.intent.range.startChapter; chapterNumber <= task.recipe.intent.range.endChapter; chapterNumber++) {
    const draft = steps.find(step => step.chapterNumber === chapterNumber && step.role === 'draft')
    const review = steps.find(step => step.chapterNumber === chapterNumber && step.kind === 'review_commit')
    let draftSave: GenerationDraftSaveState = draft ? draftEffects?.readRecovery(draft.runId) ?? { kind: 'absent' } : { kind: 'absent' }
    let savedReview: WorkflowBatchReceipt['chapters'][number]['review'] = null
    if (historical) {
      const draftStep = steps.find(step => step.chapterNumber === chapterNumber && step.kind === 'draft_commit')
      const effect = draftStep && effects.find(item => item.stepId === draftStep.stepId)
      if (effect?.semanticHistory) {
        const proof = parseOrdinarySemanticHistory(effect.semanticHistory)
        if (proof.kind !== 'draft-commit-history') fail('HISTORY_INVALID')
        const row = runtime.database.prepare('SELECT d.chapter_number,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
          .get(proof.draft.id) as { chapter_number: number; version: number; status: string; body: string } | undefined
        draftSave = row && row.chapter_number === chapterNumber && row.version === proof.draft.version
          && row.status !== 'deleted' && textHash(row.body) === proof.draft.contentHash
          ? { kind: 'current', receipt: { success: true, id: proof.draft.id, version: proof.draft.version,
            content: row.body, contentHash: proof.draft.contentHash } } : { kind: 'changed' }
      }
      const reviewEffect = review && effects.find(item => item.stepId === review.stepId)
      if (reviewEffect?.semanticHistory) {
        const proof = parseOrdinarySemanticHistory(reviewEffect.semanticHistory)
        if (proof.kind !== 'ordinary-review-history') fail('HISTORY_INVALID')
        const saved = readOrdinaryReviewHistoryReport(runtime.database, proof.cycleId, history)
        savedReview = { success: true, kind: 'review', id: proof.reviewId, index: proof.reviewIndex,
          content: saved.report, contentHash: textHash(saved.report), source: { ...proof.source, status: proof.source.status as DraftStatus } }
      }
    } else if (review) savedReview = reviews!.readCommittedReview(review.runId)?.receipt ?? null
    chapters.push({ chapterNumber, draftSave, review: savedReview })
  }
  assertCapturedResources()
  return { task: { taskId: task.taskId, projectId: task.projectId, template: task.template, batchRunId: task.batchRunId,
    revision: task.revision, state: task.state, blockedCode: task.blockedCode, createdAt: task.createdAt, updatedAt: task.updatedAt },
  recipe: task.recipe, steps: steps.map(step => ({ stepId: step.stepId, commandId: step.commandId,
    chapterNumber: step.chapterNumber, role: step.role, kind: step.kind, slot: step.slot, runId: step.runId, inputHash: step.inputHash,
    effect: (() => {
      const effect = effects.find(value => value.stepId === step.stepId)
      return effect ? { receiptKind: effect.receiptKind, receiptAttemptId: effect.receiptAttemptId, contentHash: effect.contentHash } : null
    })() })), attempts, chapters,
  ...(historical ? { historicalArtifacts } : {}), nonReplayable: true }
}

export class WorkflowBatchAuthority {
  readonly runtime: ProjectRuntime
  private readonly repository: WorkflowBatchRepository
  private readonly runs: GenerationRunRepository
  private readonly owner: Owner
  private readonly issuances = new Map<string, Issuance>()
  private readonly subjects = new WeakSet<WorkflowBatchSubject>()
  private readonly running = new Map<string, Promise<void>>()
  private pendingAdmission = false
  private closing = false
  private retired = false

  constructor(private readonly options: WorkflowBatchAuthorityOptions) {
    this.runtime = options.runtime
    const freeze = readPortableRuntimeFreeze(this.runtime.canonicalRoot)
    assertOrdinaryHistoryFreezeCoverage(this.runtime.database, freeze)
    this.repository = new WorkflowBatchRepository(this.runtime.database, { projectId: this.runtime.projectId,
      assertCurrent: options.assertCapturedResources, isFrozen: (table, id) => freeze.isFrozen(table, id) })
    this.runs = new GenerationRunRepository(() => this.runtime.database, Date.now, (table, id) => freeze.isFrozen(table, id))
    this.owner = options.createOwner({ assertNoRuntimeClaims: () => {
      if (this.hasIssuance()) fail('OWNER_BUSY')
    }, workflowDriver: {
      assertActive: runId => { this.active(runId) },
      assertDispatchAdmission: (runId, nonce, input) => {
        const item = this.active(runId)
        const step = this.repository.readSteps(item.task.taskId).find(value => value.runId === runId && value.invocationNonce === nonce)
        if (!step || step.input.kind !== 'model' || !isDeepStrictEqual(step.input.task, input)) fail('DISPATCH_MISMATCH')
        this.repository.assertDispatch(refOf(item.task), step.stepId, nonce, input)
      },
    } })
  }

  private available(): void {
    if (this.closing || this.retired) fail('OWNER_CLOSING')
    this.options.assertAdmission(); this.options.assertCapturedResources()
  }
  private handle(runId: string): MainGenerationRunHandle {
    const run = this.runs.get(runId)
    return { projectId: run.binding.projectId, epoch: run.binding.epoch, rootActionId: run.rootActionId, runId }
  }
  private active(runId: string): Issuance {
    this.available()
    const item = [...this.issuances.values()].find(value => value.task.batchRunId === runId
      || this.repository.readSteps(value.task.taskId).some(step => step.runId === runId))
    if (!item || !item.claim || item.subject.isDestroyed()) fail('CAPABILITY_REQUIRED')
    const check = () => this.repository.assertActive(refOf(item.task))
    if (this.runtime.database.inTransaction) check()
    else this.runtime.database.transaction(check).immediate()
    return item
  }
  private owned(subject: WorkflowBatchSubject, reference: WorkflowBatchReference, checkRevision = true): Issuance {
    this.options.assertCapturedResources()
    const item = this.issuances.get(reference.taskId)
    if (!item || item.subject !== subject || subject.isDestroyed() || reference.projectId !== this.runtime.projectId) fail('CAPABILITY_REQUIRED')
    const current = this.repository.get(item.task.taskId)
    if (!current) fail('TASK_MISSING')
    item.task = current
    if (checkRevision && reference.revision !== current.revision) fail('REVISION_CONFLICT')
    return item
  }
  private receipt(taskId: string): WorkflowBatchReceipt {
    return readWorkflowBatchReceipt(this.runtime, taskId, this.options.assertCapturedResources)
  }
  private result(item: Issuance): WorkflowBatchResult {
    item.task = this.repository.get(item.task.taskId) ?? item.task
    return { reference: publicRef(item.task), receipt: this.receipt(item.task.taskId) }
  }
  private observe(subject: WorkflowBatchSubject): void {
    if (this.subjects.has(subject)) return
    this.subjects.add(subject)
    subject.once('destroyed', () => {
      for (const item of this.issuances.values()) if (item.subject === subject && item.claim) {
        try { this.stop(item, false) } catch { console.error('[workflow-batch] sender cleanup failed') }
      }
    })
  }
  private taskHandles(task: WorkflowBatchTask): MainGenerationRunHandle[] {
    return [...new Set([task.batchRunId, ...this.repository.readSteps(task.taskId).map(step => step.runId)])].map(id => this.handle(id))
  }
  private stop(item: Issuance, cancel: boolean): void {
    const failures: unknown[] = []
    try {
      item.task = this.repository.get(item.task.taskId) ?? item.task
      item.task = cancel ? this.repository.cancel(refOf(item.task)) : this.repository.pause(refOf(item.task))
    } catch (error) { failures.push(error) }
    item.claim = false
    try { this.pauseRuns(item.task, cancel) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'WORKFLOW_BATCH_STOP_FAILED')
  }
  private pauseRuns(task: WorkflowBatchTask, cancel = false): void {
    const failures: unknown[] = []
    const roots = new Set<string>()
    for (const handle of this.taskHandles(task)) if (!roots.has(handle.rootActionId)) {
      roots.add(handle.rootActionId)
      try { this.owner.pauseWorkflowDriver(handle, cancel) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'WORKFLOW_BATCH_STOP_FAILED')
  }
  private chapter(chapterNumber: number, targetUnits: number) {
    return readWorkflowBatchChapter({ database: this.runtime.database, projectId: this.runtime.projectId,
      epoch: this.runtime.executionEpoch, chapterNumber, targetUnits, assertResources: this.options.assertCapturedResources })
  }
  private assertEmpty(chapterNumber: number): void {
    if (this.runtime.database.prepare('SELECT 1 FROM drafts WHERE chapter_number=? LIMIT 1').get(chapterNumber)) fail('TARGET_NOT_EMPTY')
  }
  private firstPredecessor(chapterNumber: number): number[] {
    if (chapterNumber === 1) return []
    const row = this.runtime.database.prepare(`SELECT d.id,c.body,o.finalization_id,o.content_hash,o.content_snapshot
      FROM drafts d JOIN contents c ON c.id=d.content_id LEFT JOIN finalization_outbox o ON o.draft_id=d.id
      WHERE d.chapter_number=? AND d.status='finalized' ORDER BY d.version DESC,d.id DESC LIMIT 1`).get(chapterNumber - 1) as {
        id: number; body: string; finalization_id: string | null; content_hash: string | null; content_snapshot: string | null
      } | undefined
    if (!row?.finalization_id || row.content_hash !== textHash(row.body) || row.content_snapshot !== row.body
      || !new GenerationDraftEffects(this.runtime.database, this.runs).finalizationSettled(row.finalization_id)) fail('PREDECESSOR_NOT_SETTLED')
    return [row.id]
  }
  private assertRootSources(item: Issuance): void {
    this.owner.assertWorkflowDriverRecoverySources(this.handle(item.task.batchRunId))
  }
  private draftModel(task: WorkflowBatchTask): string {
    const model = this.runs.get(task.batchRunId).binding.sourceManifest.modelReceipt as SafeGenerationModelReceipt
    if (!model || generationModelReceiptHash(this.options.readSafeModelReceipt(model.modelId))
      !== this.runs.get(task.batchRunId).binding.fingerprint.modelLeaseRevision) fail('MODEL_CHANGED')
    return model.modelId
  }
  private reviewModel(task: WorkflowBatchTask): string {
    if (!task.reviewModelId || !task.reviewModelHash
      || generationModelReceiptHash(this.options.readSafeModelReceipt(task.reviewModelId)) !== task.reviewModelHash) fail('REVIEW_MODEL_CHANGED')
    return task.reviewModelId
  }
  private async openDraft(item: Issuance, chapterNumber: number) {
    this.active(item.task.batchRunId); this.assertRootSources(item)
    const task = item.task, chapter = this.chapter(chapterNumber, task.recipe.intent.targetUnits)
    if (!isDeepStrictEqual(chapter.authorInputs.filter(input => input.id !== 'draft:chapter-info'), task.recipe.authorInputs)) fail('AUTHOR_INPUT_CHANGED')
    const existing = this.repository.readSteps(task.taskId).find(step => step.chapterNumber === chapterNumber && step.role === 'draft')
    const effects = new GenerationDraftEffects(this.runtime.database, this.runs)
    const batch = effects.readBatch(task.batchRunId, this.runtime.projectId)
    const predecessor = chapterNumber === task.recipe.intent.range.startChapter ? undefined
      : batch.completedChapters.find(value => value.chapterNumber === chapterNumber - 1)
    if (chapterNumber > task.recipe.intent.range.startChapter && !predecessor) fail('PREDECESSOR_MISSING')
    const request: PrepareDraftContextRequest = { chapterNumber, modelId: this.draftModel(task),
      promptKeys: [chapterNumber === 1 ? 'first_chapter_draft' : 'next_chapter_draft'], skillStages: ['drafting'],
      authorInputs: chapter.authorInputs, query: chapter.query, selectedDraftIds: predecessor ? [predecessor.draftId] : [], batchId: task.batchRunId }
    if (existing) {
      const handle = this.handle(existing.runId), binding = this.runs.get(existing.runId).binding
      const snapshot = binding.sourceManifest.knowledgeSnapshot as GenerationKnowledgeSnapshot
      const materials = await this.options.withKnowledge(handle, () => prepareWorkflowBatchMaterials({
        database: this.runtime.database, projectId: this.runtime.projectId, epoch: this.runtime.executionEpoch,
        chapterNumber, targetUnits: task.recipe.intent.targetUnits, projectStorageRoot: this.runtime.projectStorageRoot,
        globalDataRoot: this.options.globalDataRoot, knowledgeSnapshot: snapshot, predecessor,
        assertResources: this.options.assertCapturedResources, assertSourcesCurrent: () => this.owner.assertSourcesCurrent(handle) }))
      this.active(handle.runId)
      return { handle, materials }
    }
    this.assertEmpty(chapterNumber)
    const selectedFinalizedDraftIds = predecessor ? [] : this.firstPredecessor(chapterNumber)
    const baseline = this.owner.draftPreparationBinding(request)
    const snapshot = await this.options.captureKnowledge(chapter.query, chapterNumber)
    this.active(task.batchRunId); this.assertRootSources(item)
    const prepared = this.owner.prepareDraftContext(request, snapshot, baseline)
    const frozenBinding = this.owner.draftPreparationBinding(request, snapshot)
    return this.options.withPreparedKnowledge(prepared.preparationId, chapterNumber, async () => {
      const assertSourcesCurrent = () => {
        this.active(task.batchRunId); this.assertRootSources(item)
        if (!isDeepStrictEqual(frozenBinding, this.owner.draftPreparationBinding(request, snapshot))) fail('SOURCE_CHANGED')
      }
      const materials = await prepareWorkflowBatchMaterials({ database: this.runtime.database, projectId: this.runtime.projectId,
        epoch: this.runtime.executionEpoch, chapterNumber, targetUnits: task.recipe.intent.targetUnits,
        projectStorageRoot: this.runtime.projectStorageRoot, globalDataRoot: this.options.globalDataRoot,
        knowledgeSnapshot: snapshot, predecessor, assertResources: this.options.assertCapturedResources, assertSourcesCurrent })
      assertSourcesCurrent(); this.assertEmpty(chapterNumber)
      let handle: MainGenerationRunHandle | undefined
      try {
        this.runtime.database.transaction(() => {
          this.active(task.batchRunId); this.assertEmpty(chapterNumber)
          const view = this.owner.beginWorkflowBatchRun({ operation: 'chapter-draft', modelId: request.modelId,
            uiActionNonce: `workflow-batch:${task.taskId}:draft:${chapterNumber}`, chapterNumber,
            selectedDraftIds: request.selectedDraftIds, selectedFinalizedDraftIds,
            selectedBlueprintChapterNumbers: Array.from({ length: 6 }, (_, index) => chapterNumber + index),
            promptKeys: request.promptKeys, skillStages: request.skillStages, authorInputs: materials.authorInputs,
            output: 'visible-text', batchId: task.batchRunId, parentRootActionId: this.handle(task.batchRunId).rootActionId,
            preparationId: prepared.preparationId, materialDecision: materials.materialDecision })
          handle = view.handle
          this.repository.bindStep(refOf(task), { chapterNumber, role: 'draft', kind: 'outline', slot: 0,
            runId: handle.runId, input: { kind: 'model', task: materials.outlineTask } })
        }).immediate()
      } catch (error) {
        if (handle) this.owner.rollbackWorkflowDriverPreparation(handle)
        throw error
      }
      if (!handle) fail('RUN_MISSING')
      return { handle, materials }
    })
  }

  private async openReview(item: Issuance, chapterNumber: number) {
    this.active(item.task.batchRunId); this.assertRootSources(item)
    const task = item.task, modelId = this.reviewModel(task)
    const steps = this.repository.readSteps(task.taskId)
    const draftStep = steps.find(step => step.chapterNumber === chapterNumber && step.kind === 'draft_commit')
    if (!draftStep) fail('DRAFT_RECEIPT_MISSING')
    const saved = new GenerationDraftEffects(this.runtime.database, this.runs).readRecovery(draftStep.runId)
    if (saved.kind !== 'current') fail('SOURCE_DRAFT_CHANGED')
    const row = this.runtime.database.prepare('SELECT status FROM drafts WHERE id=?').get(saved.receipt.id) as { status: DraftStatus } | undefined
    if (!row || row.status !== 'draft') fail('SOURCE_DRAFT_CHANGED')
    const existing = steps.find(step => step.chapterNumber === chapterNumber && step.role === 'review')
    const prepared = this.owner.prepareReviewRevision({ operation: 'review-chapter', draftId: saved.receipt.id,
      expectedDraft: { chapterNumber, version: saved.receipt.version, status: row.status, contentHash: saved.receipt.contentHash },
      authorInputs: [], uiLocale: task.recipe.uiLocale })
    const context = prepared.context
    if (existing && !isDeepStrictEqual(context, this.runs.get(existing.runId).binding.sourceManifest.reviewRevisionContext)) fail('SOURCE_CHANGED')
    const assertSourcesCurrent = () => {
      this.active(task.batchRunId); this.assertRootSources(item); this.reviewModel(task)
      if (!isDeepStrictEqual(context, captureReviewRevisionContext(this.runtime.database, reviewRevisionRequest(context), this.runtime.projectId))) fail('SOURCE_CHANGED')
      if (existing) this.owner.assertSourcesCurrent(this.handle(existing.runId))
    }
    const assets = readWorkflowReviewAssets({ projectStorageRoot: this.runtime.projectStorageRoot,
      globalDataRoot: this.options.globalDataRoot, writingLanguage: task.recipe.writingLanguage,
      assertResources: this.options.assertCapturedResources, assertSourcesCurrent })
    const materials = await prepareWorkflowReviewMaterials({ context,
      current: { projectId: this.runtime.projectId, epoch: this.runtime.executionEpoch }, template: assets.template, skill: assets.skill ?? undefined })
    assets.assertUnchanged()
    let handle: MainGenerationRunHandle | undefined = existing ? this.handle(existing.runId) : undefined
    if (!handle) {
      try {
        this.runtime.database.transaction(() => {
          assets.assertUnchanged()
          const view = this.owner.beginWorkflowBatchRun({ operation: 'review-chapter', modelId,
            uiActionNonce: `workflow-batch:${task.taskId}:review:${chapterNumber}`, chapterNumber,
            selectedDraftIds: [context.source.id], selectedFinalizedDraftIds: [], promptKeys: ['consistency_check'],
            skillStages: ['review'], output: 'structured-data', reviewRevisionContextId: prepared.contextId,
            authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] })
          handle = view.handle
          if (this.runs.get(handle.runId).binding.fingerprint.modelLeaseRevision !== task.reviewModelHash) fail('REVIEW_MODEL_CHANGED')
          this.owner.bindMaterialDecision(handle, materials.materialDecision)
          this.repository.bindStep(refOf(task), { chapterNumber, role: 'review', kind: 'review', slot: 0,
            runId: handle.runId, input: { kind: 'model', task: materials.task } })
        }).immediate()
      } catch (error) {
        if (handle) this.owner.rollbackWorkflowDriverPreparation(handle)
        throw error
      }
    } else this.owner.bindMaterialDecision(handle, materials.materialDecision)
    if (!handle) fail('RUN_MISSING')
    this.active(handle.runId)
    return { handle, contextId: prepared.contextId, task: materials.task, rebuildTask: materials.rebuildTask,
      replacementTask: (kind: 'review' | 'review_rebuild', partial: string): GenerationTask => {
        const prompt = kind === 'review' ? materials.prompt : materials.rebuildPrompt
        return injectWritingSkillPrompt({ purpose: kind === 'review' ? 'review-chapter' : 'review-chapter-rebuild',
          reasoningStage: 'review', output: 'structured-data', messages: [{ role: 'system', content: materials.systemPrompt },
            { role: 'user', content: buildStructuredReplacementPrompt(prompt, partial, task.recipe.writingLanguage) }] },
        task.recipe.writingLanguage, assets.skill).task
      } }
  }

  private launch(item: Issuance): void {
    if (this.running.has(item.task.taskId)) fail('TASK_BUSY')
    const release = this.options.acquireWork(), ref = refOf(item.task)
    const work = runWorkflowBatch({ database: this.runtime.database, repository: this.repository, runs: this.runs,
      owner: this.owner, ref, assertActive: () => { this.active(item.task.batchRunId) }, withKnowledge: this.options.withKnowledge,
      openDraft: chapter => this.openDraft(item, chapter), openReview: chapter => this.openReview(item, chapter) })
      .catch(error => {
        const current = this.repository.get(ref.taskId)
        if (current && item.claim && current.revision === ref.revision && current.state === 'ready') {
          const raw = error instanceof Error ? error.message : ''
          item.task = this.repository.block(ref, /^[A-Z][A-Z0-9_]{0,127}$/u.test(raw) ? raw : 'WORKFLOW_BATCH_FAILED')
          item.claim = false
          this.pauseRuns(item.task)
        }
      }).catch(() => { console.error('[workflow-batch] failed to persist task state') })
      .finally(async () => {
        try {
          await this.owner.whenPhysicalIdle()
          this.running.delete(ref.taskId)
          const current = this.repository.get(ref.taskId)
          if (current) item.task = current
          item.claim = false
        } finally { release() }
      }).catch(() => { console.error('[workflow-batch] failed to finish task cleanup') })
    this.running.set(ref.taskId, work)
  }
  hasIssuance(taskId?: string, subject?: WorkflowBatchSubject): boolean {
    if (taskId === undefined) return this.pendingAdmission || this.running.size > 0 || [...this.issuances.values()].some(item => item.claim)
    const item = this.issuances.get(taskId)
    return Boolean(item && (!subject || item.subject === subject))
  }
  async start(subject: WorkflowBatchSubject, input: StartWorkflowBatchRequest, assertFreshView: () => void): Promise<WorkflowBatchResult> {
    assertWorkflowBatchRequest('workflow-batch:v2:start', input)
    const request = parseStartWorkflowBatchRequest(input)
    assertFreshView(); this.available()
    if (subject.isDestroyed()) fail('OWNER_CLOSING')
    const requestHash = textHash(JSON.stringify(request))
    const prior = this.repository.getByOperation(request.operationKey)
    if (prior) {
      if (prior.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
      const issued = this.issuances.get(prior.taskId)
      return { reference: issued?.subject === subject ? publicRef(this.repository.get(prior.taskId)!) : null, receipt: this.receipt(prior.taskId) }
    }
    if (this.hasIssuance() || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
    this.pendingAdmission = true
    try {
      const { startChapter, endChapter } = request.intent.range
      const chapter = this.chapter(startChapter, request.intent.targetUnits)
      for (let number = startChapter; number <= endChapter; number++) { this.chapter(number, request.intent.targetUnits); this.assertEmpty(number) }
      this.firstPredecessor(startChapter)
      const authorInputs = chapter.authorInputs.filter(value => value.id !== 'draft:chapter-info')
      if (request.authorInputs.some(value => !isDeepStrictEqual(value, authorInputs.find(actual => actual.id === value.id)))) fail('AUTHOR_INPUT_INVALID')
      const recipe = { schemaVersion: 2 as const, writingLanguage: chapter.core.writingLanguage, uiLocale: request.uiLocale,
        intent: request.intent, authorInputs }
      const modelHash = generationModelReceiptHash(this.options.readSafeModelReceipt(request.modelId))
      const reviewModelHash = generationModelReceiptHash(this.options.readSafeModelReceipt(request.reviewModelId))
      const taskId = randomUUID()
      let handle: MainGenerationRunHandle | undefined
      let task: WorkflowBatchTask
      try {
        task = this.runtime.database.transaction(() => {
          assertFreshView(); this.available()
          if (subject.isDestroyed()) fail('OWNER_CLOSING')
          for (let number = startChapter; number <= endChapter; number++) this.assertEmpty(number)
          const view = this.owner.beginWorkflowBatchRoot({ ...request.intent, uiActionNonce: `workflow-batch:${taskId}`,
            modelId: request.modelId, authorInputs, promptKeys: ['first_chapter_draft', 'next_chapter_draft', 'consistency_check'],
            skillStages: ['drafting', 'review'] })
          handle = view.handle
          if (this.runs.get(handle.runId).binding.fingerprint.modelLeaseRevision !== modelHash) fail('MODEL_CHANGED')
          return this.repository.issue({ taskId, operationKey: request.operationKey, requestHash, batchRunId: handle.runId,
            recipe, reviewModelId: request.reviewModelId, reviewModelHash })
        }).immediate()
      } catch (error) {
        if (handle) this.owner.rollbackWorkflowDriverPreparation(handle)
        throw error
      }
      const item: Issuance = { subject, task, claim: true }
      this.issuances.set(task.taskId, item); this.observe(subject)
      try { this.launch(item) } catch (error) {
        try { this.stop(item, false) } catch (cleanup) { throw new AggregateError([error, cleanup], 'WORKFLOW_BATCH_START_CLEANUP_FAILED') }
        throw error
      }
      return this.result(item)
    } finally { this.pendingAdmission = false }
  }
  readReceipt(subject: WorkflowBatchSubject, reference: WorkflowBatchReference): WorkflowBatchReceipt {
    this.owned(subject, reference, false)
    return this.receipt(reference.taskId)
  }
  pause(subject: WorkflowBatchSubject, reference: WorkflowBatchReference): WorkflowBatchResult {
    const item = this.owned(subject, reference)
    if (this.retired || this.closing) fail('OWNER_CLOSING')
    if (item.task.state === 'ready') this.stop(item, false)
    return this.result(item)
  }
  cancel(subject: WorkflowBatchSubject, reference: WorkflowBatchReference): WorkflowBatchResult {
    const item = this.owned(subject, reference)
    if ((this.retired || this.closing) && !['cancelled', 'waiting_review'].includes(item.task.state)) fail('OWNER_CLOSING')
    if (!['cancelled', 'waiting_review'].includes(item.task.state)) this.stop(item, true)
    return this.result(item)
  }

  private reconcile(task: WorkflowBatchTask): WorkflowBatchTask {
    for (const step of this.repository.readSteps(task.taskId)) {
      this.repository.acknowledgeFromReceipt(refOf(task), step.stepId)
      const latest = this.repository.get(task.taskId)
      if (!latest) fail('TASK_MISSING')
      if (latest.revision !== task.revision || latest.state === 'waiting_review') return latest
      task = latest
    }
    return task
  }
  private unfinishedHandles(task: WorkflowBatchTask): MainGenerationRunHandle[] {
    const steps = this.repository.readSteps(task.taskId), effects = this.repository.readEffects(task.taskId)
    const saved = (chapter: number, kind: 'draft_commit' | 'review_commit') => steps.some(step => step.chapterNumber === chapter
      && step.kind === kind && effects.some(effect => effect.stepId === step.stepId))
    const pending = steps.filter(step => !saved(step.chapterNumber, step.role === 'draft' ? 'draft_commit' : 'review_commit'))
    const representatives = new Map<string, MainGenerationRunHandle>()
    for (const step of pending) {
      const handle = this.handle(step.runId)
      representatives.set(handle.rootActionId, handle)
    }
    const range = task.recipe.intent.range
    if (Array.from({ length: range.endChapter - range.startChapter + 1 }, (_, index) => range.startChapter + index)
      .some(chapter => !saved(chapter, 'draft_commit'))) {
      const root = this.handle(task.batchRunId)
      if (!representatives.has(root.rootActionId)) representatives.set(root.rootActionId, root)
    }
    return [...representatives.values()]
  }
  private async assertRecoverySources(task: WorkflowBatchTask, assertView: () => void): Promise<void> {
    const handles = [this.handle(task.batchRunId), ...this.unfinishedHandles(task)]
    for (const handle of new Map(handles.map(value => [value.runId, value])).values()) {
      await this.options.withKnowledge(handle, () => {
        assertView(); this.available()
        this.owner.assertWorkflowDriverRecoverySources(handle)
      })
    }
    this.draftModel(task); this.reviewModel(task)
  }
  async resume(subject: WorkflowBatchSubject, reference: WorkflowBatchReference): Promise<WorkflowBatchResult> {
    const item = this.owned(subject, reference)
    this.available()
    if (['ready', 'cancelled', 'waiting_review'].includes(item.task.state)) return this.result(item)
    if (this.hasIssuance() || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
    this.pendingAdmission = true
    try {
      item.task = this.reconcile(item.task)
      if (item.task.state === 'waiting_review') return this.result(item)
      const expected = item.task.revision
      await this.assertRecoverySources(item.task, () => { if (subject.isDestroyed()) fail('CAPABILITY_REQUIRED') })
      this.available()
      if (subject.isDestroyed() || this.repository.get(item.task.taskId)?.revision !== expected) fail('REVISION_CONFLICT')
      item.task = this.repository.resume(refOf(item.task)); item.claim = true
      try {
        for (const handle of this.unfinishedHandles(item.task)) {
          await this.options.withKnowledge(handle, () => this.owner.resume(handle))
          this.active(handle.runId)
        }
        this.launch(item)
      } catch (error) {
        try { this.stop(item, false) } catch (cleanup) { throw new AggregateError([error, cleanup], 'WORKFLOW_BATCH_RESUME_CLEANUP_FAILED') }
        throw error
      }
      return this.result(item)
    } finally { this.pendingAdmission = false }
  }
  async reauthorize(subject: WorkflowBatchSubject, taskId: string, assertFreshView: () => void): Promise<WorkflowBatchResult> {
    assertFreshView(); this.available()
    if (subject.isDestroyed()) fail('OWNER_CLOSING')
    if (this.hasIssuance() || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
    let task = this.repository.get(taskId)
    if (!task) fail('TASK_MISSING')
    const freeze = readPortableRuntimeFreeze(this.runtime.canonicalRoot)
    assertOrdinaryHistoryFreezeCoverage(this.runtime.database, freeze)
    if (freeze.isFrozen('workflow_batch_tasks', taskId) || ['cancelled', 'waiting_review'].includes(task.state)) {
      return { reference: null, receipt: this.receipt(taskId) }
    }
    this.pendingAdmission = true
    try {
      task = this.reconcile(task)
      if (task.state === 'waiting_review') return { reference: null, receipt: this.receipt(taskId) }
      await this.assertRecoverySources(task, assertFreshView)
      assertFreshView(); this.available()
      if (subject.isDestroyed()) fail('OWNER_CLOSING')
      const latest = this.repository.get(taskId)
      if (!latest || latest.revision !== task.revision || latest.state !== task.state) fail('REVISION_CONFLICT')
      // A root's physical attempts are recovered once, never dispatched or inferred from a history row.
      const roots = new Map<string, MainGenerationRunHandle>()
      for (const handle of this.taskHandles(task)) if (!roots.has(handle.rootActionId)) roots.set(handle.rootActionId, handle)
      for (const handle of roots.values()) {
        if (handle.epoch !== this.runtime.executionEpoch) this.owner.recoverWorkflowDriverRun(handle.runId)
        else if (this.runs.budget(handle.rootActionId).root.status === 'active') this.owner.pauseWorkflowDriver(handle)
      }
      if (task.state === 'ready') task = this.repository.pause(refOf(task))
      const item: Issuance = { subject, task, claim: false }
      this.issuances.set(taskId, item); this.observe(subject)
      return this.result(item)
    } finally { this.pendingAdmission = false }
  }
  assertRetirable(): void { this.owner.assertRetirable() }
  retireIdle(): void { this.owner.retireIdle(); this.retired = true }
  requestProjectClose(): void {
    this.closing = true
    const failures: unknown[] = []
    for (const item of this.issuances.values()) if (item.claim) try { this.stop(item, false) } catch (error) { failures.push(error) }
    try { this.owner.requestProjectClose() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'WORKFLOW_BATCH_CLOSE_FAILED')
  }
  hasPhysicalInFlight(): boolean { return this.owner.hasPhysicalInFlight() || this.running.size > 0 || this.pendingAdmission }
  suspendForProjectClose(): void { this.owner.suspendForProjectClose() }
}
