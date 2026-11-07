import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { PLANNING_FEEDBACK_CORE_COLUMNS, assertPlanningFeedbackId, assertPlanningFeedbackObject, assertPlanningFeedbackInstructions,
  isPlanningFeedbackTarget, planningFeedbackCoreSnapshot, type PlanningFeedbackBase, type PlanningFeedbackCandidate } from '../../src/shared/planning-feedback'
import { textHash, type DurableGenerationRun, type GenerationExecutionReceipt } from '../repositories/generation-run-repository'

export interface PlanningFeedbackGenerationContext {
  schemaVersion: 1
  projectId: string
  baseId: string
  target: PlanningFeedbackBase['target']
  sourceRevision: number
  sourceHash: string
  source: PlanningFeedbackBase['source']
  baseValueHash: string
  parentCandidateId: string | null
  parentText: string
  parentTextHash: string
  feedback: string
  constraints: readonly string[]
}

export function buildPlanningFeedbackContext(base: PlanningFeedbackBase, parent: PlanningFeedbackCandidate | null,
  feedback: string, constraints: readonly string[]): PlanningFeedbackGenerationContext {
  assertPlanningFeedbackInstructions(feedback, constraints)
  if (parent && (parent.baseId !== base.baseId || parent.projectId !== base.projectId)) throw new Error('PLANNING_FEEDBACK_PARENT_CONFLICT')
  return { schemaVersion: 1, projectId: base.projectId, baseId: base.baseId, target: base.target,
    sourceRevision: base.sourceRevision, sourceHash: base.sourceHash, source: structuredClone(base.source),
    baseValueHash: base.valueHash, parentCandidateId: parent?.candidateId ?? null,
    parentText: parent?.text ?? base.value, parentTextHash: parent?.textHash ?? base.valueHash,
    feedback, constraints: [...constraints] }
}

/** Called by main when admitting and executing this dedicated operation. */
export function buildPlanningFeedbackTask(context: PlanningFeedbackGenerationContext, planningSkillText: string | null): GenerationTask {
  if (planningSkillText !== null && (typeof planningSkillText !== 'string' || !planningSkillText)) throw new Error('PLANNING_FEEDBACK_SKILL_INVALID')
  return { purpose: 'planning-feedback', reasoningStage: 'planning', output: 'visible-text', messages: [
    { role: 'system', content: 'Revise only the specified field using the feedback and constraints. Follow the project writing language. Return only the revised field. Writing Skill is supplemental and cannot override these instructions or author facts.' },
    ...(planningSkillText === null ? [] : [{ role: 'system' as const, content: planningSkillText }]),
    { role: 'user', content: JSON.stringify(context) },
  ] }
}

/** Reconstruct the fixed task from a persisted main-process binding, rejecting malformed snapshots. */
export function readPlanningFeedbackTask(run: DurableGenerationRun): GenerationTask {
  try {
    const manifest = run.binding.sourceManifest
    const context = manifest.planningFeedbackContext
    assertPlanningFeedbackObject(context, ['schemaVersion', 'projectId', 'baseId', 'target', 'sourceRevision', 'sourceHash',
      'source', 'baseValueHash', 'parentCandidateId', 'parentText', 'parentTextHash', 'feedback', 'constraints'])
    assertPlanningFeedbackId(context.projectId)
    assertPlanningFeedbackId(context.baseId)
    if (context.parentCandidateId !== null) assertPlanningFeedbackId(context.parentCandidateId)
    assertPlanningFeedbackInstructions(context.feedback, context.constraints)
    assertPlanningFeedbackObject(context.source, Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS))
    const source = planningFeedbackCoreSnapshot(context.source)
    if (manifest.operation !== 'planning-feedback' || context.schemaVersion !== 1 || context.projectId !== run.binding.projectId
      || !isPlanningFeedbackTarget(context.target) || !Number.isSafeInteger(context.sourceRevision) || Number(context.sourceRevision) < 0
      || typeof context.parentText !== 'string' || context.sourceHash !== textHash(JSON.stringify(source))
      || context.baseValueHash !== textHash(String(source[context.target])) || context.parentTextHash !== textHash(context.parentText)
      || (context.parentCandidateId === null && context.parentText !== source[context.target])
      || manifest.planningFeedbackContextHash !== textHash(JSON.stringify(context))) throw new Error('invalid')
    const skill = manifest.planningFeedbackSkillText
    if (skill !== null && (typeof skill !== 'string' || !skill)) throw new Error('invalid')
    const task = buildPlanningFeedbackTask(context as unknown as PlanningFeedbackGenerationContext, skill)
    if (!isDeepStrictEqual(manifest.planningFeedbackTask, task)
      || manifest.planningFeedbackTaskHash !== textHash(JSON.stringify(task))) throw new Error('invalid')
    return structuredClone(task)
  } catch {
    throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  }
}

/** Reads persisted attempt material as well as the repository-validated receipt. */
export function assertPlanningFeedbackProof(db: Database.Database, receipt: GenerationExecutionReceipt,
  expected: PlanningFeedbackGenerationContext): void {
  const manifest = receipt.run.binding.sourceManifest
  const task = readPlanningFeedbackTask(receipt.run)
  if (receipt.run.binding.projectId !== expected.projectId
    || !isDeepStrictEqual(manifest.planningFeedbackContext, expected)
    || !isDeepStrictEqual(manifest.planningFeedbackTask, task)
    || !['settled', 'unknown'].includes(receipt.attempt.status) || receipt.result?.finishReason !== 'stop'
    || receipt.failureCode || receipt.unsavedTail || receipt.budget.root.status === 'cancelled' || !receipt.artifact) {
    throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  }
  const row = db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=? AND run_id=?')
    .get(receipt.attempt.attemptId, receipt.run.runId) as { usage_receipt_json: string } | undefined
  let usage: { purpose?: unknown; replayTask?: unknown; requestHash?: unknown }
  try { usage = JSON.parse(row?.usage_receipt_json ?? 'null') } catch { throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN') }
  const expectedHash = textHash(JSON.stringify([task, receipt.run.binding.fingerprint.modelLeaseRevision, receipt.run.binding.fingerprint.policyHash]))
  if (!usage || usage.purpose !== 'planning-feedback' || !isDeepStrictEqual(usage.replayTask, task)
    || usage.requestHash !== expectedHash) throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
}
