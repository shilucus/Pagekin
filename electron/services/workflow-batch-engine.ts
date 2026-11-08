import type Database from 'better-sqlite3'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { ReviewGenerationCommitRequest } from '../../src/shared/review-revision-generation'
import { draftShortOutlineBlock } from '../../src/shared/draft-short-outline'
import { DRAFT_VISIBLE_TEXT_VERSION, composeDraftVisibleContinuation, sanitizeDraftText } from '../../src/shared/draft-visible-text'
import { buildDraftCondensePrompt, buildDraftContinuationPrompt } from '../../src/shared/draft-generation-prompts'
import { acceptsCondensedDraft, hasSubstantialPreviousChapterReuse, isLowProgressDraftContinuation,
  shouldAutoContinueDraft, shouldCondenseDraft } from '../../src/shared/draft-generation-policy'
import { countDraftUnits, draftTargetUnitRange } from '../../src/shared/draft-units'
import { parseReviewGenerationResult } from '../../src/shared/review-generation-report'
import type { WorkflowBatchStepKind, WorkflowBatchStepInput } from '../../src/shared/workflow-batch-contract'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import type { WorkflowBatchRef, WorkflowBatchRepository, WorkflowBatchStep } from '../repositories/workflow-batch-repository'
import { applyWorkflowBatchWritingSkill, type prepareWorkflowBatchMaterials } from './workflow-batch-materials'
import type { createMainGenerationOwner } from './main-generation-owner'

type Owner = Pick<ReturnType<typeof createMainGenerationOwner>, 'executeWorkflowDriver' | 'retryWorkflowBatchShortOutline'
  | 'whenPhysicalIdle' | 'read' | 'composeVisible' | 'commitDraft' | 'commitReview' | 'assertSourcesCurrent'>
type Materials = Awaited<ReturnType<typeof prepareWorkflowBatchMaterials>>
export interface WorkflowBatchEngineOptions {
  database: Database.Database
  repository: WorkflowBatchRepository
  runs: GenerationRunRepository
  owner: Owner
  ref: WorkflowBatchRef
  assertActive(): void
  withKnowledge<T>(handle: MainGenerationRunHandle, operation: () => T | Promise<T>): Promise<T>
  openDraft(chapterNumber: number): Promise<{ handle: MainGenerationRunHandle; materials: Materials }>
  openReview(chapterNumber: number): Promise<{ handle: MainGenerationRunHandle; contextId: string;
    task: GenerationTask; rebuildTask: GenerationTask;
    replacementTask(kind: 'review' | 'review_rebuild', partial: string): GenerationTask }>
}

/** Each selected branch is durable before its model request or domain effect. */
export async function runWorkflowBatch(options: WorkflowBatchEngineOptions): Promise<void> {
  const { database, repository, runs, owner, ref } = options
  const active = () => database.transaction(() => { options.assertActive(); repository.assertActive(ref) }).immediate()
  const task = repository.get(ref.taskId)
  if (!task) throw new Error('WORKFLOW_BATCH_TASK_MISSING')
  const hasEffect = (chapter: number, kind: WorkflowBatchStepKind) => {
    const step = repository.readSteps(ref.taskId).find(item => item.chapterNumber === chapter && item.kind === kind)
    return !!step && !!repository.acknowledgeFromReceipt(ref, step.stepId)
  }
  const bind = (handle: MainGenerationRunHandle, chapterNumber: number, role: 'draft' | 'review',
    kind: WorkflowBatchStepKind, slot: number, input: WorkflowBatchStepInput) =>
    repository.bindStep(ref, { runId: handle.runId, chapterNumber, role, kind, slot, input })
  const model = async (handle: MainGenerationRunHandle, step: WorkflowBatchStep) => {
    if (step.input.kind !== 'model' || !step.invocationNonce) throw new Error('WORKFLOW_BATCH_STEP_INVALID')
    let effect = repository.acknowledgeFromReceipt(ref, step.stepId)
    if (!effect) {
      const run = runs.get(handle.runId)
      const hash = textHash(JSON.stringify([step.input.task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
      if (runs.findInvocation(handle.runId, step.invocationNonce, hash)) throw new Error('WORKFLOW_BATCH_ATTEMPT_UNRESOLVED')
      active()
      const promise = step.kind === 'outline' && step.slot === 1
        ? owner.retryWorkflowBatchShortOutline({ handle, failedAttemptId: step.invocationNonce!.slice('draft-short-outline-retry:'.length) })
        : owner.executeWorkflowDriver({ handle, invocationNonce: step.invocationNonce!, task: step.input.kind === 'model' ? step.input.task : neverTask() })
      try { await promise } finally { await owner.whenPhysicalIdle() }
      if (owner.read(handle).unsavedTails?.length) throw new Error('WORKFLOW_BATCH_TAIL_UNSAVED')
      active()
      effect = repository.acknowledgeFromReceipt(ref, step.stepId)
      if (!effect) throw new Error('WORKFLOW_BATCH_RECEIPT_MISSING')
    }
    return runs.receipt(effect.receiptAttemptId)
  }
  const compose = async (handle: MainGenerationRunHandle, chapter: number, slot: number, ids: string[], text: string) => {
    const input = { kind: 'compose' as const, artifactIds: ids, algorithm: DRAFT_VISIBLE_TEXT_VERSION, expectedTextHash: textHash(text) }
    const step = bind(handle, chapter, 'draft', 'compose', slot, input)
    await options.withKnowledge(handle, () => {
      active()
      repository.withEffectCommit(ref, step.stepId, () => { options.assertActive(); owner.assertSourcesCurrent(handle)
        owner.composeVisible(handle, ids, input.expectedTextHash, input.algorithm) })
    })
  }
  const { startChapter, endChapter } = task.recipe.intent.range
  for (let chapter = startChapter; chapter <= endChapter; chapter++) {
    active()
    if (hasEffect(chapter, 'draft_commit')) continue
    const { handle, materials } = await options.openDraft(chapter)
    const first = bind(handle, chapter, 'draft', 'outline', 0, { kind: 'model', task: materials.outlineTask })
    let outline = await model(handle, first)
    if (outline.result?.finishReason !== 'stop' || outline.failureCode || !outline.artifact?.text.trim()) {
      const retry = bind(handle, chapter, 'draft', 'outline', 1, { kind: 'model', task: materials.outlineTask })
      outline = await model(handle, retry)
    }
    if (outline.result?.finishReason !== 'stop' || outline.failureCode || !outline.artifact?.text.trim()) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
    const outlineBlock = draftShortOutlineBlock(materials.writingLanguage, outline.artifact.text)
    const promptMaterial = { ...materials.promptMaterial,
      reconciliation: [materials.promptMaterial.reconciliation, outlineBlock].filter(Boolean).join('\n\n') }
    const initialTask = { ...materials.baseDraftTask, messages: materials.baseDraftTask.messages.map(message => message.role === 'user'
      ? { ...message, content: `${message.content}\n\n${outlineBlock}` } : { ...message }) }
    const firstDraft = await model(handle, bind(handle, chapter, 'draft', 'draft', 0, { kind: 'model', task: initialTask }))
    const initialFinish = firstDraft.result?.finishReason
    if (firstDraft.failureCode || !firstDraft.artifact || initialFinish !== 'stop' && initialFinish !== 'length') throw new Error('WORKFLOW_BATCH_DRAFT_INCOMPLETE')
    let text = sanitizeDraftText(firstDraft.artifact.text, DRAFT_VISIBLE_TEXT_VERSION)
    let ids = [firstDraft.artifact.artifactId]
    await compose(handle, chapter, 0, ids, text)
    const modelReceipt = runs.get(handle.runId).binding.sourceManifest.modelReceipt as { capabilityEvidence?: { reasoning?: boolean } }
    if (modelReceipt.capabilityEvidence?.reasoning && initialFinish === 'length' && countDraftUnits(text) < 100)
      throw new Error('WORKFLOW_BATCH_REASONING_OUTPUT_INCOMPLETE')
    let finish: 'stop' | 'length' = initialFinish, recoveryPending = false, recoveryUsed = false, rounds = 0
    while (shouldAutoContinueDraft(text, materials.targetUnits, rounds, finish)) {
      const { prompt, allowance } = buildDraftContinuationPrompt({ ...promptMaterial, writingLanguage: materials.writingLanguage,
        targetChars: materials.targetUnits, compositionVersion: DRAFT_VISIBLE_TEXT_VERSION, draft: text, recoveryPending })
      const continuation = applyWorkflowBatchWritingSkill({ purpose: recoveryPending ? 'chapter-draft-no-progress-recovery' : 'chapter-draft-continuation',
        reasoningStage: 'drafting', output: 'visible-text', budgetDemand: { kind: 'draft-units', writingLanguage: materials.writingLanguage,
          requestedUnits: Math.max(1, allowance), segmentable: false }, messages: [{ role: 'system', content: materials.systemPrompt }, { role: 'user', content: prompt }] }, materials.writingLanguage, materials.writingSkill)
      const result = await model(handle, bind(handle, chapter, 'draft', 'continue', rounds, { kind: 'model', task: continuation }))
      const nextFinish = result.result?.finishReason
      if (result.failureCode || !result.artifact || nextFinish !== 'stop' && nextFinish !== 'length') throw new Error('WORKFLOW_BATCH_DRAFT_INCOMPLETE')
      finish = nextFinish
      const next = composeDraftVisibleContinuation(text, sanitizeDraftText(result.artifact.text, DRAFT_VISIBLE_TEXT_VERSION), DRAFT_VISIBLE_TEXT_VERSION)
      const delta = countDraftUnits(next) - countDraftUnits(text)
      rounds++
      if (isLowProgressDraftContinuation(finish, delta)) {
        if (recoveryUsed) throw new Error('WORKFLOW_BATCH_NO_PROGRESS')
        recoveryUsed = true; recoveryPending = true
        continue
      }
      ids = [...ids, result.artifact.artifactId]; text = next; recoveryPending = false
      await compose(handle, chapter, rounds, ids, text)
      if (delta < 300) break
    }
    if (finish !== 'stop' && !(finish === 'length' && countDraftUnits(text) > draftTargetUnitRange(materials.targetUnits).maximum)) throw new Error('WORKFLOW_BATCH_DRAFT_INCOMPLETE')
    if (shouldCondenseDraft(countDraftUnits(text), materials.targetUnits, false)) {
      const { prompt } = buildDraftCondensePrompt({ ...promptMaterial, writingLanguage: materials.writingLanguage,
        targetChars: materials.targetUnits, candidate: { text } })
      const condense = applyWorkflowBatchWritingSkill({ purpose: 'chapter-draft-condense', reasoningStage: 'drafting', output: 'visible-text',
        budgetDemand: { kind: 'draft-units', writingLanguage: materials.writingLanguage, requestedUnits: materials.targetUnits, segmentable: false },
        messages: [{ role: 'system', content: materials.systemPrompt }, { role: 'user', content: prompt }] }, materials.writingLanguage, materials.writingSkill)
      const result = await model(handle, bind(handle, chapter, 'draft', 'condense', 0, { kind: 'model', task: condense }))
      if (result.failureCode) {
        if (finish !== 'stop' || !['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'GENERATION_CONTEXT_LENGTH_EXCEEDED'].includes(result.failureCode))
          throw new Error('WORKFLOW_BATCH_DRAFT_INCOMPLETE')
      } else if (!result.result) throw new Error('WORKFLOW_BATCH_DRAFT_INCOMPLETE')
      const compressed = sanitizeDraftText(result.artifact?.text ?? '', DRAFT_VISIBLE_TEXT_VERSION)
      if (!result.failureCode && result.artifact && result.result?.finishReason === 'stop' && acceptsCondensedDraft('stop', countDraftUnits(compressed), materials.targetUnits)) {
        text = compressed; ids = [...ids, result.artifact.artifactId]
        await compose(handle, chapter, 8, ids, text)
      } else if (finish !== 'stop') throw new Error('WORKFLOW_BATCH_DRAFT_INCOMPLETE')
    }
    if (countDraftUnits(text) < draftTargetUnitRange(materials.targetUnits).minimum
      || hasSubstantialPreviousChapterReuse(materials.previousEnding, text, materials.writingLanguage)) throw new Error('WORKFLOW_BATCH_DRAFT_INVALID')
    const commit = bind(handle, chapter, 'draft', 'draft_commit', 0, { kind: 'draft-commit', expectedCompositionHash: textHash(text) })
    await options.withKnowledge(handle, () => { active(); repository.withEffectCommit(ref, commit.stepId, () => {
      options.assertActive(); owner.assertSourcesCurrent(handle)
      owner.commitDraft({ handle, chapterNumber: chapter, source: 'write', batchId: ref.batchRunId, expectedCompositionHash: textHash(text) })
    }) })
  }
  for (let chapter = startChapter; chapter <= endChapter; chapter++) {
    active()
    if (hasEffect(chapter, 'review_commit')) continue
    const prepared = await options.openReview(chapter), { handle } = prepared
    let artifact: ReviewGenerationCommitRequest['artifact'] | undefined
    for (const kind of ['review', 'review_rebuild'] as const) {
      let complete = false
      let partial = ''
      for (let slot = 0; slot < 2; slot++) {
        const result = await model(handle, bind(handle, chapter, 'review', kind, slot,
          { kind: 'model', task: slot === 1 ? prepared.replacementTask(kind, partial)
            : kind === 'review' ? prepared.task : prepared.rebuildTask }))
        if (result.failureCode || !result.result) throw new Error('WORKFLOW_BATCH_REVIEW_INCOMPLETE')
        if (result.result.finishReason === 'length') { partial = result.artifact?.text ?? ''; continue }
        if (result.result.finishReason !== 'stop' || !result.artifact) throw new Error('WORKFLOW_BATCH_REVIEW_INCOMPLETE')
        complete = true
        try { parseReviewGenerationResult(result.artifact.text); artifact = { artifactId: result.artifact.artifactId,
          revision: result.artifact.revision, textHash: result.artifact.textHash } } catch { /* The original workflow permits one full rebuild. */ }
        break
      }
      if (!complete) throw new Error('WORKFLOW_BATCH_REVIEW_INCOMPLETE')
      if (artifact) break
    }
    if (!artifact) throw new Error('WORKFLOW_BATCH_REVIEW_INVALID')
    const commit = bind(handle, chapter, 'review', 'review_commit', 0, { kind: 'review-commit', artifact })
    await options.withKnowledge(handle, () => { active(); repository.withEffectCommit(ref, commit.stepId, () => {
      options.assertActive(); owner.assertSourcesCurrent(handle)
      owner.commitReview({ contextId: prepared.contextId, handle, artifact: artifact! })
    }) })
  }
}

function neverTask(): never { throw new Error('WORKFLOW_BATCH_STEP_INVALID') }
