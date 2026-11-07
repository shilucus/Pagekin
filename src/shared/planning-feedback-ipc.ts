import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunSummary, MainGenerationRunView } from '../services/generation/generation-runtime'
import {
  assertPlanningFeedbackAdoption, assertPlanningFeedbackId, assertPlanningFeedbackInstructions, assertPlanningFeedbackObject,
  isPlanningFeedbackCoreTarget, type AdoptPlanningFeedbackCandidate, type PlanningFeedbackAdoption,
  type PlanningFeedbackBase, type PlanningFeedbackCandidate, type PlanningFeedbackCoreTarget,
  type RelineagePlanningFeedbackCandidate, type StagePlanningFeedbackCandidate,
} from './planning-feedback'

/** Wire version is part of each channel name; persisted candidate/task versions are independent. */
export const PLANNING_FEEDBACK_IPC_VERSION = 1 as const
export type PlanningFeedbackFieldBase = Extract<PlanningFeedbackBase, { schemaVersion: 1 }>
export type PlanningFeedbackBaseSummary = Pick<PlanningFeedbackFieldBase,
  'baseId' | 'projectId' | 'target' | 'createdAt' | 'closedAt' | 'closedByAdoptionId'>
export type PlanningFeedbackCandidateState = 'ready' | 'conflict' | 'frozen' | 'adopted'
export interface BeginPlanningFeedbackRequest {
  input: { baseId: string; parentCandidateId?: string | null; feedback: string; constraints: readonly string[] }
  modelId: string
  uiActionNonce: string
}
export interface PlanningFeedbackHistory {
  base: PlanningFeedbackFieldBase
  candidates: { candidate: PlanningFeedbackCandidate; state: PlanningFeedbackCandidateState }[]
  adoptions: PlanningFeedbackAdoption[]
}
export interface PlanningFeedbackRunRecovery {
  view: MainGenerationRunView
  modelId: string
  input: BeginPlanningFeedbackRequest['input']
  sourceStatus: 'current' | 'conflict'
}

/** Desktop project-session channels, not an automation or human-approval capability. */
export interface PlanningFeedbackChannels {
  'planning-feedback:v1:capture': { args: [{ target: PlanningFeedbackCoreTarget }]; return: PlanningFeedbackFieldBase }
  'planning-feedback:v1:list-bases': { args: [{ target: PlanningFeedbackCoreTarget }]; return: PlanningFeedbackBaseSummary[] }
  'planning-feedback:v1:read-history': { args: [{ baseId: string }]; return: PlanningFeedbackHistory }
  'planning-feedback:v1:begin': { args: [BeginPlanningFeedbackRequest]; return: MainGenerationRunView }
  'planning-feedback:v1:execute': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationExecuteReceipt }
  'planning-feedback:v1:read-run': { args: [{ handle: MainGenerationRunHandle }]; return: PlanningFeedbackRunRecovery }
  'planning-feedback:v1:list-runs': { args: [{ baseId: string }]; return: MainGenerationRunSummary[] }
  'planning-feedback:v1:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
  'planning-feedback:v1:stage': { args: [StagePlanningFeedbackCandidate]; return: PlanningFeedbackCandidate }
  'planning-feedback:v1:relineage': { args: [RelineagePlanningFeedbackCandidate]; return: PlanningFeedbackCandidate }
  'planning-feedback:v1:adopt': { args: [Omit<AdoptPlanningFeedbackCandidate, 'adoptedRange'>]; return: PlanningFeedbackAdoption }
}

export type PlanningFeedbackChannel = keyof PlanningFeedbackChannels
type Request<C extends PlanningFeedbackChannel> = PlanningFeedbackChannels[C]['args'][0]

function assertHandle(value: unknown): void {
  assertPlanningFeedbackObject(value, ['projectId', 'epoch', 'rootActionId', 'runId'])
  for (const key of ['projectId', 'epoch', 'rootActionId', 'runId']) assertPlanningFeedbackId(value[key])
}

/** Validate the wire boundary even when a caller bypasses the typed preload/client. */
export function assertPlanningFeedbackRequest<C extends PlanningFeedbackChannel>(channel: C, value: unknown): asserts value is Request<C> {
  switch (channel) {
    case 'planning-feedback:v1:capture':
    case 'planning-feedback:v1:list-bases':
      assertPlanningFeedbackObject(value, ['target'])
      if (!isPlanningFeedbackCoreTarget(value.target)) throw new Error('PLANNING_FEEDBACK_TARGET_INVALID')
      return
    case 'planning-feedback:v1:read-history':
    case 'planning-feedback:v1:list-runs':
      assertPlanningFeedbackObject(value, ['baseId'])
      assertPlanningFeedbackId(value.baseId)
      return
    case 'planning-feedback:v1:begin':
      assertPlanningFeedbackObject(value, ['input', 'modelId', 'uiActionNonce'])
      assertPlanningFeedbackObject(value.input, ['baseId', 'feedback', 'constraints'], ['parentCandidateId'])
      assertPlanningFeedbackId(value.input.baseId)
      if (value.input.parentCandidateId != null) assertPlanningFeedbackId(value.input.parentCandidateId)
      assertPlanningFeedbackInstructions(value.input.feedback, value.input.constraints)
      if (typeof value.modelId !== 'string' || !value.modelId.trim()
        || typeof value.uiActionNonce !== 'string' || !value.uiActionNonce.trim() || value.uiActionNonce.length > 256) {
        throw new Error('PLANNING_FEEDBACK_PAYLOAD_INVALID')
      }
      return
    case 'planning-feedback:v1:execute':
    case 'planning-feedback:v1:read-run':
    case 'planning-feedback:v1:cancel':
      assertPlanningFeedbackObject(value, ['handle'])
      assertHandle(value.handle)
      return
    case 'planning-feedback:v1:stage':
      assertPlanningFeedbackObject(value, ['baseId', 'feedback', 'constraints', 'runId', 'attemptId', 'artifactId'], ['parentCandidateId'])
      for (const key of ['baseId', 'runId', 'attemptId', 'artifactId']) assertPlanningFeedbackId(value[key])
      if (value.parentCandidateId != null) assertPlanningFeedbackId(value.parentCandidateId)
      assertPlanningFeedbackInstructions(value.feedback, value.constraints)
      return
    case 'planning-feedback:v1:relineage':
      assertPlanningFeedbackObject(value, ['baseId', 'sourceCandidateId', 'feedback', 'constraints'])
      assertPlanningFeedbackId(value.baseId)
      assertPlanningFeedbackId(value.sourceCandidateId)
      assertPlanningFeedbackInstructions(value.feedback, value.constraints)
      return
    case 'planning-feedback:v1:adopt':
      assertPlanningFeedbackObject(value, ['candidateId', 'idempotencyKey', 'decision', 'text'])
      assertPlanningFeedbackAdoption(value)
      return
    default:
      throw new Error('PLANNING_FEEDBACK_PAYLOAD_INVALID')
  }
}
