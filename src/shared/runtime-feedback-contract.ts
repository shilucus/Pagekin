import type { PlanningFeedbackCandidate, PlanningFeedbackCoreTarget } from './planning-feedback'
import { assertPlanningFeedbackId, assertPlanningFeedbackInstructions, assertPlanningFeedbackObject } from './planning-feedback'
import type { BeginPlanningFeedbackRequest } from './planning-feedback-ipc'
import type { PhysicalAttempt } from './generation-contract'

export const RUNTIME_FEEDBACK_CHANNELS = Object.freeze([
  'runtime-feedback:v1:prepare', 'runtime-feedback:v1:execute', 'runtime-feedback:v1:revoke',
  'runtime-feedback:v1:revoke-many',
  'runtime-feedback:v1:read-receipt', 'runtime-feedback:v1:read-history',
] as const)

/** Bounds one untrusted IPC request; completeness covers only the submitted references. */
export const MAX_RUNTIME_FEEDBACK_REVOCATIONS = 128

export interface RuntimeFeedbackReference {
  projectId: string
  grantId: string
  revision: number
}

export interface PrepareRuntimeFeedbackRequest {
  operationId: string
  input: BeginPlanningFeedbackRequest['input']
  modelId: string
}

/** This receipt is evidence, never a bearer execution capability. */
export interface RuntimeFeedbackReceipt {
  grant: {
    grantId: string
    projectId: string
    revision: number
    target: PlanningFeedbackCoreTarget
    baseId: string
    parentCandidateId: string | null
    runId: string
    state: 'active' | 'completed' | 'revoked'
    candidateId: string | null
  }
  attempts: { attemptId: string; status: PhysicalAttempt['status']; artifactId: string | null }[]
  candidate: PlanningFeedbackCandidate | null
  nonReplayable: true
}

export interface RuntimeFeedbackRevocationReceipt {
  completeForRequestedScope: boolean
  projects: {
    projectId: string
    completeForRequestedScope: boolean
    grants: {
      grantId: string
      requestedRevision: number
      fenced: boolean
      receipt: RuntimeFeedbackReceipt | null
      errorCode: string | null
    }[]
  }[]
}

export interface RuntimeFeedbackChannels {
  'runtime-feedback:v1:prepare': { args: [PrepareRuntimeFeedbackRequest]; return: {
    reference: RuntimeFeedbackReference | null; receipt: RuntimeFeedbackReceipt
  } }
  'runtime-feedback:v1:execute': { args: [RuntimeFeedbackReference]; return: RuntimeFeedbackReceipt }
  'runtime-feedback:v1:revoke': { args: [RuntimeFeedbackReference]; return: RuntimeFeedbackReceipt }
  'runtime-feedback:v1:revoke-many': { args: [{ references: RuntimeFeedbackReference[] }]; return: RuntimeFeedbackRevocationReceipt }
  'runtime-feedback:v1:read-receipt': { args: [Pick<RuntimeFeedbackReference, 'projectId' | 'grantId'>]; return: RuntimeFeedbackReceipt }
  'runtime-feedback:v1:read-history': { args: [{ grantId: string }]; return: RuntimeFeedbackReceipt }
}

export type RuntimeFeedbackChannel = keyof RuntimeFeedbackChannels

export function isRuntimeFeedbackChannel(channel: string): channel is RuntimeFeedbackChannel {
  return (RUNTIME_FEEDBACK_CHANNELS as readonly string[]).includes(channel)
}

function assertOperationId(value: unknown): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('RUNTIME_FEEDBACK_ID_INVALID')
  }
}

export function assertRuntimeFeedbackRequest<C extends RuntimeFeedbackChannel>(channel: C, value: unknown): asserts value is RuntimeFeedbackChannels[C]['args'][0] {
  switch (channel) {
    case 'runtime-feedback:v1:prepare':
      assertPlanningFeedbackObject(value, ['operationId', 'input', 'modelId'])
      assertOperationId(value.operationId)
      assertPlanningFeedbackObject(value.input, ['baseId', 'feedback', 'constraints'], ['parentCandidateId'])
      assertPlanningFeedbackId(value.input.baseId)
      if (value.input.parentCandidateId != null) assertPlanningFeedbackId(value.input.parentCandidateId)
      assertPlanningFeedbackInstructions(value.input.feedback, value.input.constraints)
      if (typeof value.modelId !== 'string' || !value.modelId.trim()) throw new Error('RUNTIME_FEEDBACK_PAYLOAD_INVALID')
      return
    case 'runtime-feedback:v1:execute':
    case 'runtime-feedback:v1:revoke':
      assertPlanningFeedbackObject(value, ['projectId', 'grantId', 'revision'])
      assertPlanningFeedbackId(value.projectId)
      assertOperationId(value.grantId)
      if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error('RUNTIME_FEEDBACK_REVISION_INVALID')
      return
    case 'runtime-feedback:v1:revoke-many': {
      assertPlanningFeedbackObject(value, ['references'])
      if (!Array.isArray(value.references) || value.references.length < 1 || value.references.length > MAX_RUNTIME_FEEDBACK_REVOCATIONS) {
        throw new Error('RUNTIME_FEEDBACK_PAYLOAD_INVALID')
      }
      const seen = new Set<string>()
      for (const reference of value.references) {
        assertRuntimeFeedbackRequest('runtime-feedback:v1:revoke', reference)
        const key = JSON.stringify([reference.projectId, reference.grantId])
        if (seen.has(key)) throw new Error('RUNTIME_FEEDBACK_PAYLOAD_INVALID')
        seen.add(key)
      }
      return
    }
    case 'runtime-feedback:v1:read-receipt':
      assertPlanningFeedbackObject(value, ['projectId', 'grantId'])
      assertPlanningFeedbackId(value.projectId)
      assertOperationId(value.grantId)
      return
    case 'runtime-feedback:v1:read-history':
      assertPlanningFeedbackObject(value, ['grantId'])
      assertOperationId(value.grantId)
      return
    default:
      throw new Error('RUNTIME_FEEDBACK_CHANNEL_NOT_ALLOWED')
  }
}
