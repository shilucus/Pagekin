import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import { draftShortOutlineBlock } from '../../src/shared/draft-short-outline'
import { DRAFT_VISIBLE_TEXT_VERSION, sanitizeDraftText } from '../../src/shared/draft-visible-text'
import type { WorkflowDriverStepInput } from '../../src/shared/workflow-driver-contract'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import type { WorkflowDriverRepository, WorkflowDriverTaskRef } from '../repositories/workflow-driver-repository'
import type { createMainGenerationOwner } from './main-generation-owner'

type Owner = Pick<ReturnType<typeof createMainGenerationOwner>, 'executeWorkflowDriver' | 'composeVisible'
  | 'commitDraft' | 'read' | 'assertSourcesCurrent'>

export interface WorkflowDriverEngineOptions {
  database: Database.Database
  repository: WorkflowDriverRepository
  runs: GenerationRunRepository
  owner: Owner
  handle: MainGenerationRunHandle
  ref: WorkflowDriverTaskRef
  assertActive(): void
  withKnowledge<T>(handle: MainGenerationRunHandle, operation: () => T | Promise<T>): Promise<T>
}

/** The persisted step input and original generation receipt are the only replay evidence. */
export async function runWorkflowDriver(options: WorkflowDriverEngineOptions): Promise<void> {
  const { database, repository, runs, owner, handle, ref } = options
  const current = () => database.transaction(() => { options.assertActive(); repository.assertActive(ref) }).immediate()
  for (const step of repository.readSteps(ref.taskId)) {
    current()
    if (step.input && repository.acknowledgeFromReceipt(ref, step.stepId)) continue
    const task = repository.get(ref.taskId)
    if (!task) throw new Error('WORKFLOW_DRIVER_TASK_MISSING')
    let input: WorkflowDriverStepInput
    if (step.kind === 'outline') input = { kind: 'model', task: task.recipe.outlineTask }
    else if (step.kind === 'draft') {
      const outline = repository.readSteps(ref.taskId)[0]!
      const effect = repository.readEffects(ref.taskId).find(item => item.stepId === outline.stepId)
      const artifact = effect ? runs.receipt(effect.receiptAttemptId).artifact : null
      if (!artifact) throw new Error('WORKFLOW_DRIVER_OUTLINE_MISSING')
      const base = task.recipe.baseDraftTask
      input = { kind: 'model', task: { ...base, messages: base.messages.map(message => message.role === 'user'
        ? { ...message, content: `${message.content}\n\n${draftShortOutlineBlock(task.recipe.writingLanguage, artifact.text)}` } : { ...message }) } }
    } else if (step.kind === 'compose') {
      const draft = repository.readSteps(ref.taskId)[1]!
      const effect = repository.readEffects(ref.taskId).find(item => item.stepId === draft.stepId)
      const artifact = effect ? runs.receipt(effect.receiptAttemptId).artifact : null
      if (!artifact) throw new Error('WORKFLOW_DRIVER_DRAFT_MISSING')
      input = { kind: 'compose', artifactIds: [artifact.artifactId], algorithm: DRAFT_VISIBLE_TEXT_VERSION,
        expectedTextHash: textHash(sanitizeDraftText(artifact.text, DRAFT_VISIBLE_TEXT_VERSION)) }
    } else {
      const composition = runs.readVisibleComposition(ref.runId)
      if (!composition) throw new Error('WORKFLOW_DRIVER_COMPOSITION_MISSING')
      input = { kind: 'commit', chapterNumber: 1, expectedCompositionHash: composition.textHash }
    }
    const bound = repository.bindInput(ref, step.stepId, input)
    if (!isDeepStrictEqual(bound.input, input)) throw new Error('WORKFLOW_DRIVER_INPUT_CONFLICT')
    if (input.kind === 'model') {
      if (!bound.invocationNonce) throw new Error('WORKFLOW_DRIVER_NONCE_MISSING')
      const run = runs.get(ref.runId)
      const requestHash = textHash(JSON.stringify([input.task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
      const prior = runs.findInvocation(ref.runId, bound.invocationNonce, requestHash)
      if (prior) throw new Error('WORKFLOW_DRIVER_ATTEMPT_UNRESOLVED')
      current()
      await owner.executeWorkflowDriver({ handle, invocationNonce: bound.invocationNonce!, task: input.task })
      if (owner.read(handle).unsavedTails?.length) throw new Error('WORKFLOW_DRIVER_TAIL_UNSAVED')
      current()
      if (!repository.acknowledgeFromReceipt(ref, step.stepId)) throw new Error('WORKFLOW_DRIVER_RECEIPT_MISSING')
      continue
    }
    await options.withKnowledge(handle, () => {
      current()
      repository.withEffectCommit(ref, step.stepId, () => {
        options.assertActive()
        owner.assertSourcesCurrent(handle)
        if (input.kind === 'compose') owner.composeVisible(handle, input.artifactIds, input.expectedTextHash, input.algorithm)
        else owner.commitDraft({ handle, chapterNumber: input.chapterNumber, expectedCompositionHash: input.expectedCompositionHash, source: 'write' })
      })
    })
  }
}
