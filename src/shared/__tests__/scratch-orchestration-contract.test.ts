import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AutonomousExecutionResult } from '../autonomous-executor-contract'
import {
  assembleStageExecutionReceipt,
  createScratchOrchestrationManifest,
  validateScratchCreationGrant,
  type CandidateDraftingBarrierReason,
  type ScratchOrchestrationManifest,
  type ScratchCreationTaskGrant,
} from '../scratch-orchestration-contract'

describe('scratch-orchestration-contract', () => {
  const validGrant: ScratchCreationTaskGrant = {
    grantId: 'grant-001',
    projectId: 'proj-scratch',
    authorTaskPrompt: '从零创作一部东方玄幻修真小说，主角李玄机入宗门。',
    targetChapterCount: 3,
    maxRepairAttempts: 3,
    allowedStages: [
      'foundation_setup',
      'outline_generation',
      'character_roster',
      'blueprint_planning',
      'candidate_drafting',
      'preliminary_acceptance',
    ],
    timestamp: Date.now(),
  }

  it('validates task grant and enforces 1-10 chapter bounds', () => {
    // Clean grant
    expect(validateScratchCreationGrant(validGrant).valid).toBe(true)

    // Over chapter limit (> 10)
    const overLimit = { ...validGrant, targetChapterCount: 15 }
    const overCheck = validateScratchCreationGrant(overLimit)
    expect(overCheck.valid).toBe(false)
    expect(overCheck.reason).toContain('超出限制，单次从零编排上限为 1-10 章')

    // Zero or negative chapters
    const zeroChapter = { ...validGrant, targetChapterCount: 0 }
    expect(validateScratchCreationGrant(zeroChapter).valid).toBe(false)

    // Empty prompt
    const emptyPrompt = { ...validGrant, authorTaskPrompt: '   ' }
    expect(validateScratchCreationGrant(emptyPrompt).valid).toBe(false)

    // Invalid max repair attempts
    const invalidRepair = { ...validGrant, maxRepairAttempts: 10 }
    expect(validateScratchCreationGrant(invalidRepair).valid).toBe(false)
  })

  it('initializes orchestration manifest with human review and finalization boundaries', () => {
    const manifest = createScratchOrchestrationManifest(validGrant)

    expect(manifest.orchestrationId.startsWith('som-')).toBe(true)
    expect(manifest.currentStage).toBe('foundation_setup')
    expect(manifest.isHumanConfirmed).toBe(false)
    expect(manifest.canAutoFinalize).toBe(false)
    expect(manifest.status).toBe('in_progress')
    expect(manifest.repairAttempts).toBe(0)
    expect(manifest.draftingExecutionResults).toEqual([])
    expect(manifest).not.toHaveProperty('candidateDraftingBarrier')
    expect(manifest.stageReceipts).toEqual([])
    expect(manifest.candidateChapterIds).toEqual([])
    expect(manifest.preliminaryReportIds).toEqual([])
  })

  it('keeps the drafting barrier closed and optional without widening execution results or author approval', () => {
    expectTypeOf<CandidateDraftingBarrierReason>()
      .toEqualTypeOf<'unknown' | 'predecessor_conflict' | 'partial' | 'interrupted' | 'unproven'>()
    expectTypeOf<ScratchOrchestrationManifest['candidateDraftingBarrier']>()
      .toEqualTypeOf<CandidateDraftingBarrierReason | undefined>()
    expectTypeOf<ScratchOrchestrationManifest['draftingExecutionResults']>()
      .toEqualTypeOf<AutonomousExecutionResult[]>()
    expectTypeOf<ScratchOrchestrationManifest['isHumanConfirmed']>().toEqualTypeOf<false>()
    expectTypeOf<ScratchOrchestrationManifest['canAutoFinalize']>().toEqualTypeOf<false>()
  })

  it('isolates actual drafting histories between manifests without synthesizing candidate IDs or stage receipts', () => {
    const first = createScratchOrchestrationManifest(validGrant)
    const second = createScratchOrchestrationManifest({ ...validGrant, grantId: 'grant-002', projectId: 'proj-other' })
    const emptyAttempt: AutonomousExecutionResult = {
      batchId: 'batch-empty', receipts: [], stoppedDueToConflict: false, completedChapters: 0,
    }
    const savedAttempt: AutonomousExecutionResult = {
      batchId: 'batch-saved',
      receipts: [{ stepId: 'step-saved', batchId: 'batch-saved', chapterNumber: 1, draftId: 701,
        status: 'candidate_draft_created', isFinalized: false, sourcePredecessorHash: '', createdAt: 1 }],
      stoppedDueToConflict: false,
      completedChapters: 1,
    }

    expect(first.draftingExecutionResults).not.toBe(second.draftingExecutionResults)
    first.draftingExecutionResults.push(emptyAttempt, savedAttempt)
    first.candidateDraftingBarrier = 'partial'
    expect(first.draftingExecutionResults).toEqual([emptyAttempt, savedAttempt])
    expect(first.draftingExecutionResults[0]!.receipts).toEqual([])
    expect(first.draftingExecutionResults[1]!.receipts.map(receipt => receipt.draftId)).toEqual([701])
    expect(first.candidateChapterIds).toEqual([])
    expect(first.stageReceipts).toEqual([])
    expect(first.preliminaryReportIds).toEqual([])
    expect(second.draftingExecutionResults).toEqual([])
    expect(second).not.toHaveProperty('candidateDraftingBarrier')
    expect(second.candidateChapterIds).toEqual([])
    expect(second.stageReceipts).toEqual([])

    const stageReceipt = assembleStageExecutionReceipt({ orchestrationId: first.orchestrationId,
      stage: 'candidate_drafting', success: false, entityCount: 1 })
    first.stageReceipts.push(stageReceipt)
    expect(first.stageReceipts).toEqual([stageReceipt])
    expect(first.draftingExecutionResults).toEqual([emptyAttempt, savedAttempt])
    expect(second.stageReceipts).toEqual([])
  })

  it('assembles stage execution receipts with deterministic stage tracking', () => {
    const receipt = assembleStageExecutionReceipt({
      orchestrationId: 'som-test',
      stage: 'character_roster',
      success: true,
      entityCount: 4,
    })

    expect(receipt.receiptId.startsWith('ser-')).toBe(true)
    expect(receipt.stage).toBe('character_roster')
    expect(receipt.success).toBe(true)
    expect(receipt.entityCount).toBe(4)
  })
})
