import { describe, expect, it } from 'vitest'
import {
  assembleStageExecutionReceipt,
  createScratchOrchestrationManifest,
  validateScratchCreationGrant,
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
