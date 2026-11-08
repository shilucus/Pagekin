import { describe, expect, it } from 'vitest'
import {
  AUTO_ERROR_CODES,
  type AutomationDecisionRequest,
} from '../../../src/shared/automation-decision-contract'
import { AutomationDecisionAuthority } from '../automation-decision-authority'

describe('automation-decision-authority', () => {
  it('creates and tracks bounded automation grants', () => {
    const authority = new AutomationDecisionAuthority()
    const grant = authority.createGrant({
      projectId: 'proj-novel-1',
      allowedChapterRange: [1, 5],
      allowedFields: ['chapter_draft', 'outline'],
      allowedModels: ['gpt-4o'],
      allowedSkills: ['dialogue-repair'],
      maxRepairAttempts: 2,
      sourceFingerprint: 'hash-baseline-1',
    })

    expect(grant.grantId).toBeDefined()
    expect(grant.maxRepairAttempts).toBe(2)
    expect(grant.currentRepairAttempts).toBe(0)
    expect(grant.revoked).toBe(false)
  })

  it('records valid machine decisions and increments repair attempts', async () => {
    const authority = new AutomationDecisionAuthority()
    const grant = authority.createGrant({
      projectId: 'proj-novel-1',
      allowedChapterRange: [1, 5],
      allowedFields: ['chapter_draft'],
      allowedModels: ['gpt-4o'],
      allowedSkills: [],
      maxRepairAttempts: 2,
      sourceFingerprint: 'hash-baseline-1',
    })

    const request: AutomationDecisionRequest = {
      grantId: grant.grantId,
      projectId: 'proj-novel-1',
      chapterNumber: 3,
      targetField: 'chapter_draft',
      targetKind: 'draft_repair',
      modelId: 'gpt-4o',
      sourceFingerprint: 'hash-baseline-1',
      payload: { patch: 'fixed typo' },
      isHumanConfirmed: false,
    }

    // Attempt 1
    const receipt1 = await authority.recordDecision(request)
    expect(receipt1.status).toBe('applied')
    expect(receipt1.repairAttemptIndex).toBe(1)
    expect(receipt1.isHumanConfirmed).toBe(false)
    expect(receipt1.source).toBe('machine_automated')

    // Attempt 2
    const receipt2 = await authority.recordDecision(request)
    expect(receipt2.repairAttemptIndex).toBe(2)

    // Attempt 3 -> exceeds maxRepairAttempts (2)
    await expect(authority.recordDecision(request)).rejects.toMatchObject({
      code: AUTO_ERROR_CODES.REPAIR_ATTEMPTS_EXCEEDED,
    })
  })

  it('strictly rejects forged human confirmation', async () => {
    const authority = new AutomationDecisionAuthority()
    const grant = authority.createGrant({
      projectId: 'proj-novel-1',
      allowedChapterRange: [1, 5],
      allowedFields: ['chapter_draft'],
      allowedModels: ['gpt-4o'],
      allowedSkills: [],
      sourceFingerprint: 'hash-baseline-1',
    })

    const forgedRequest: AutomationDecisionRequest = {
      grantId: grant.grantId,
      projectId: 'proj-novel-1',
      chapterNumber: 1,
      targetField: 'chapter_draft',
      targetKind: 'draft_repair',
      modelId: 'gpt-4o',
      sourceFingerprint: 'hash-baseline-1',
      payload: {},
      isHumanConfirmed: true, // Forbidden forgery!
    }

    await expect(authority.recordDecision(forgedRequest)).rejects.toMatchObject({
      code: AUTO_ERROR_CODES.FORBIDDEN_MACHINE_CONFIRMED_FABRICATION,
    })
  })

  it('rejects high-risk finalize and deletion operations in automation decisions', async () => {
    const authority = new AutomationDecisionAuthority()
    const grant = authority.createGrant({
      projectId: 'proj-novel-1',
      allowedChapterRange: [1, 5],
      allowedFields: ['chapter_draft'],
      allowedModels: ['gpt-4o'],
      allowedSkills: [],
      sourceFingerprint: 'hash-baseline-1',
    })

    const autoFinalizeReq: AutomationDecisionRequest = {
      grantId: grant.grantId,
      projectId: 'proj-novel-1',
      chapterNumber: 1,
      targetField: 'chapter_draft',
      targetKind: 'draft_repair',
      modelId: 'gpt-4o',
      sourceFingerprint: 'hash-baseline-1',
      payload: { auto_finalize: true },
    }

    await expect(authority.recordDecision(autoFinalizeReq)).rejects.toMatchObject({
      code: AUTO_ERROR_CODES.HIGH_RISK_ACTION_PROHIBITED,
    })
  })

  it('stops processing when grant is revoked', async () => {
    const authority = new AutomationDecisionAuthority()
    const grant = authority.createGrant({
      projectId: 'proj-novel-1',
      allowedChapterRange: [1, 5],
      allowedFields: ['chapter_draft'],
      allowedModels: ['gpt-4o'],
      allowedSkills: [],
      sourceFingerprint: 'hash-baseline-1',
    })

    authority.revokeGrant(grant.grantId)

    const request: AutomationDecisionRequest = {
      grantId: grant.grantId,
      projectId: 'proj-novel-1',
      chapterNumber: 2,
      targetField: 'chapter_draft',
      targetKind: 'draft_repair',
      modelId: 'gpt-4o',
      sourceFingerprint: 'hash-baseline-1',
      payload: {},
    }

    await expect(authority.recordDecision(request)).rejects.toMatchObject({
      code: AUTO_ERROR_CODES.GRANT_REVOKED_OR_EXPIRED,
    })
  })
})
