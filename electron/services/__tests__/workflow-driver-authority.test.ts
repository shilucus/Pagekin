import { beforeEach, describe, expect, it, vi } from 'vitest'
import { textHash } from '../../repositories/generation-run-repository'
import { DRAFT_VISIBLE_TEXT_VERSION, sanitizeDraftText } from '../../../src/shared/draft-visible-text'
import type { ProjectRuntime } from '../project-runtime'
import type { WorkflowDriverReceipt } from '../../../src/shared/workflow-driver-contract'
import type { WorkflowDriverEffect, WorkflowDriverStep } from '../../repositories/workflow-driver-repository'

const fixture = vi.hoisted(() => ({ task: {} as WorkflowDriverReceipt['task'],
  steps: [] as Omit<WorkflowDriverStep, 'invocationNonce'>[],
  effects: [] as Omit<WorkflowDriverEffect, 'acknowledgedAt'>[],
  rows: [] as { attempt_id: string; root_action_id: string; attempt_json: string;
    artifact_id: string; artifact_run_id: string; revision: number; artifact_json: string }[] }))
vi.mock('../portable-runtime-freeze', () => ({ readPortableRuntimeFreeze: () => ({ isFrozen: () => true }) }))
vi.mock('../../repositories/workflow-driver-repository', () => ({ WorkflowDriverRepository: class {
  get() { return fixture.task }
  readSteps() { return fixture.steps }
  readEffects() { return fixture.effects }
} }))
import { readWorkflowDriverReceipt } from '../workflow-driver-authority'

describe('workflow driver frozen history projection', () => {
  const artifactText = 'A retained historical draft.'
  const runtime = { projectId: 'copy', canonicalRoot: 'unused', database: {
    prepare: () => ({ all: () => fixture.rows }),
  } } as unknown as ProjectRuntime
  beforeEach(() => {
    fixture.task = { taskId: 'task', projectId: 'origin', runId: 'run', revision: 1,
      template: 'prepared-first-chapter-v1', state: 'paused', blockedCode: null, createdAt: 1, updatedAt: 1 }
    fixture.steps = (['outline', 'draft', 'compose', 'commit'] as const).map((kind, ordinal) => ({
      taskId: 'task', stepId: kind, commandId: `command-${kind}`, ordinal, kind, input: null, inputHash: null,
    }))
    fixture.effects = []
    fixture.rows = [{ attempt_id: 'attempt', root_action_id: 'root',
      attempt_json: JSON.stringify({ attemptId: 'attempt', rootActionId: 'root', status: 'unknown' }),
      artifact_id: 'artifact', artifact_run_id: 'run', revision: 1,
      artifact_json: JSON.stringify({ artifactId: 'artifact', attemptId: 'attempt', rootActionId: 'root', revision: 1,
        text: artifactText, textHash: textHash(artifactText) }) }]
  })
  it('returns partial text as historical material without a composition or save claim', () => {
    const receipt = readWorkflowDriverReceipt(runtime, 'task', () => {})
    expect(receipt.historicalArtifacts).toEqual([{ attemptId: 'attempt', artifactId: 'artifact', revision: 1,
      text: artifactText, textHash: textHash(artifactText) }])
    expect(receipt.composition).toBeNull()
    expect(receipt.draftSave).toEqual({ kind: 'absent' })
    expect(receipt.nonReplayable).toBe(true)
  })
  it('reconstructs only a hash-matched composition and marks its save proof unavailable', () => {
    const hash = textHash(sanitizeDraftText(artifactText, DRAFT_VISIBLE_TEXT_VERSION))
    fixture.steps[2].input = { kind: 'compose', artifactIds: ['artifact'], algorithm: DRAFT_VISIBLE_TEXT_VERSION, expectedTextHash: hash }
    fixture.steps[3].input = { kind: 'commit', chapterNumber: 1, expectedCompositionHash: hash }
    fixture.effects = [
      { stepId: 'draft', receiptKind: 'model', receiptAttemptId: 'attempt', contentHash: textHash(artifactText) },
      { stepId: 'compose', receiptKind: 'composition', receiptAttemptId: 'attempt', contentHash: hash },
      { stepId: 'commit', receiptKind: 'draft_commit', receiptAttemptId: 'attempt', contentHash: hash },
    ]
    const receipt = readWorkflowDriverReceipt(runtime, 'task', () => {})
    expect(receipt.composition?.textHash).toBe(hash)
    expect(receipt.draftSave).toEqual({ kind: 'changed' })
    expect(receipt.draftSaveProof).toBe('unavailable')
    fixture.effects[1].contentHash = textHash('different')
    expect(() => readWorkflowDriverReceipt(runtime, 'task', () => {})).toThrow('WORKFLOW_DRIVER_HISTORY_INVALID')
  })
})
