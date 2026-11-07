import type Database from 'better-sqlite3'
import { PlanningFeedbackRepository } from '../repositories/planning-feedback-repository'
import type { GenerationExecutionReceipt } from '../repositories/generation-run-repository'
import { assertPlanningFeedbackId, assertPlanningFeedbackObject, assertPlanningFeedbackInstructions, type PlanningFeedbackCaptureTarget, type StagePlanningFeedbackCandidate, type AdoptPlanningFeedbackCandidate,
  type RelineagePlanningFeedbackCandidate, type PlanningFeedbackTable } from '../../src/shared/planning-feedback'
import { readPortableRuntimeFreeze, type PortableRuntimeFreezeTable } from './portable-runtime-freeze'
import { assertPlanningFeedbackProof, buildPlanningFeedbackContext, type PlanningFeedbackGenerationContext } from './planning-feedback-generation'

export interface PlanningFeedbackGenerationInput {
  baseId: string
  parentCandidateId?: string | null
  feedback: string
  constraints: readonly string[]
}

export interface PlanningFeedbackContextAuthority {
  projectId: string
  assertCurrent(): void
  isFrozen(table: PlanningFeedbackTable, id: string): boolean
}

/** Read only: reconstruct the existing lineage, never create or rebase it. */
export function capturePlanningFeedbackContext(database: Database.Database, input: PlanningFeedbackGenerationInput,
  authority: PlanningFeedbackContextAuthority): PlanningFeedbackGenerationContext {
  assertPlanningFeedbackObject(input, ['baseId', 'feedback', 'constraints'], ['parentCandidateId'])
  assertPlanningFeedbackId(input.baseId)
  if (input.parentCandidateId != null) assertPlanningFeedbackId(input.parentCandidateId)
  assertPlanningFeedbackInstructions(input.feedback, input.constraints)
  const repo = new PlanningFeedbackRepository(database, { ...authority, assertGenerationCurrent: () => {
    throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  } })
  const base = repo.assertBaseCurrent(input.baseId)
  const parent = input.parentCandidateId == null ? null : repo.getCandidate(input.parentCandidateId)
  if (parent && repo.candidateState(parent.candidateId) !== 'ready') throw new Error('PLANNING_FEEDBACK_PARENT_CONFLICT')
  const context = buildPlanningFeedbackContext(base, parent, input.feedback, input.constraints)
  authority.assertCurrent()
  return context
}

export interface PlanningFeedbackServiceOptions {
  database: Database.Database
  projectId: string
  projectPath: string
  /** Main validates the captured session, canonical root and exact database handle. */
  assertCurrent(): void
  /** Main rebuilds current sources, model and Skill and rejects stale bindings. */
  assertGenerationBindingCurrent(receipt: GenerationExecutionReceipt): void
}

/** Main-process service only; no renderer or generic model admission is exposed. */
export class PlanningFeedbackService {
  constructor(private readonly options: PlanningFeedbackServiceOptions) {}

  private repository(assertGenerationCurrent: (receipt: GenerationExecutionReceipt, base: import('../../src/shared/planning-feedback').PlanningFeedbackBase,
    parent: import('../../src/shared/planning-feedback').PlanningFeedbackCandidate | null) => void = () => {
      throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    }): PlanningFeedbackRepository {
    return new PlanningFeedbackRepository(this.options.database, {
      projectId: this.options.projectId,
      assertCurrent: this.options.assertCurrent,
      isFrozen: (table, id) => readPortableRuntimeFreeze(this.options.projectPath).isFrozen(table as PortableRuntimeFreezeTable, id),
      assertGenerationCurrent,
    })
  }

  captureBase(target: PlanningFeedbackCaptureTarget) { return this.repository().captureBase(target) }

  prepare(input: PlanningFeedbackGenerationInput) {
    const context = capturePlanningFeedbackContext(this.options.database, input, { projectId: this.options.projectId,
      assertCurrent: this.options.assertCurrent,
      isFrozen: (table, id) => readPortableRuntimeFreeze(this.options.projectPath).isFrozen(table, id) })
    return { context }
  }

  stage(request: StagePlanningFeedbackCandidate) {
    const feedback = request.feedback, constraints = [...request.constraints]
    const repo = this.repository((receipt, base, parent) => {
      const context = buildPlanningFeedbackContext(base, parent, feedback, constraints)
      assertPlanningFeedbackProof(this.options.database, receipt, context)
      const result: unknown = this.options.assertGenerationBindingCurrent(receipt)
      if (result !== undefined) throw new Error('PLANNING_FEEDBACK_ASYNC_PROOF_INVALID')
    })
    return repo.stageCandidate({ ...request, feedback, constraints })
  }

  relineage(request: RelineagePlanningFeedbackCandidate) { return this.repository().relineageCandidate(request) }
  adopt(request: AdoptPlanningFeedbackCandidate) { return this.repository().adopt(request) }
  getCandidate(candidateId: string) { return this.repository().getCandidate(candidateId) }
  candidateState(candidateId: string) { return this.repository().candidateState(candidateId) }
  listCandidates(baseId: string) { return this.repository().listCandidates(baseId) }
  listAdoptions(baseId: string) { return this.repository().listAdoptions(baseId) }
}
