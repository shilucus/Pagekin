import { describe, expect, it } from 'vitest'
import {
  AUTO_ERROR_CODES,
  assertAutomationGrantScope,
  AutomationDecisionError,
  type AutomationDecisionRequest,
  type AutomationTaskGrant,
  validateAutomationDecisionRequest,
} from '../automation-decision-contract'

describe('automation-decision-contract', () => {
  const baseGrant: AutomationTaskGrant = {
    grantId: 'grant-auto-001',
    projectId: 'project-novel-01',
    allowedChapterRange: [1, 10],
    allowedFields: ['outline', 'character', 'blueprint', 'chapter_draft'],
    allowedModels: ['gpt-4o', 'claude-3-5-sonnet'],
    allowedSkills: ['writing-dialogue-v1', 'pacing-check-v1'],
    maxRepairAttempts: 3,
    currentRepairAttempts: 0,
    sourceFingerprint: 'sha256-source-baseline-12345',
    revoked: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const baseRequest: AutomationDecisionRequest = {
    grantId: 'grant-auto-001',
    projectId: 'project-novel-01',
    chapterNumber: 2,
    targetField: 'chapter_draft',
    targetKind: 'draft_repair',
    modelId: 'gpt-4o',
    skillId: 'writing-dialogue-v1',
    sourceFingerprint: 'sha256-source-baseline-12345',
    payload: { prosePatch: 'fixed continuity error' },
    isHumanConfirmed: false,
  }

  describe('validateAutomationDecisionRequest', () => {
    it('passes for a valid request', () => {
      expect(() => validateAutomationDecisionRequest(baseRequest)).not.toThrow()
    })

    it('strictly forbids forging isHumanConfirmed = true', () => {
      const forged = { ...baseRequest, isHumanConfirmed: true }
      expect(() => validateAutomationDecisionRequest(forged)).toThrowError(AutomationDecisionError)
      try {
        validateAutomationDecisionRequest(forged)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(
          AUTO_ERROR_CODES.FORBIDDEN_MACHINE_CONFIRMED_FABRICATION,
        )
      }
    })

    it('strictly forbids high-risk actions (e.g. auto_finalize, delete, script installation)', () => {
      const finalizeReq = {
        ...baseRequest,
        payload: { auto_finalize: true },
      }
      expect(() => validateAutomationDecisionRequest(finalizeReq)).toThrowError(
        AutomationDecisionError,
      )
      try {
        validateAutomationDecisionRequest(finalizeReq)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(
          AUTO_ERROR_CODES.HIGH_RISK_ACTION_PROHIBITED,
        )
      }

      const deleteReq = {
        ...baseRequest,
        payload: { action: 'delete' },
      }
      expect(() => validateAutomationDecisionRequest(deleteReq)).toThrowError(
        AutomationDecisionError,
      )
    })

    it('rejects invalid fields or target kinds', () => {
      const invalidField = { ...baseRequest, targetField: 'dangerous_system_config' as any }
      expect(() => validateAutomationDecisionRequest(invalidField)).toThrowError(
        AutomationDecisionError,
      )
    })
  })

  describe('assertAutomationGrantScope', () => {
    it('allows requests strictly inside grant scope', () => {
      expect(() => assertAutomationGrantScope(baseGrant, baseRequest)).not.toThrow()
    })

    it('rejects chapters outside authorized range', () => {
      const outOfRange = { ...baseRequest, chapterNumber: 15 }
      expect(() => assertAutomationGrantScope(baseGrant, outOfRange)).toThrowError(
        AutomationDecisionError,
      )
      try {
        assertAutomationGrantScope(baseGrant, outOfRange)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(AUTO_ERROR_CODES.OUT_OF_SCOPE_CHAPTER)
      }
    })

    it('rejects unlisted models', () => {
      const badModel = { ...baseRequest, modelId: 'unauthorized-model-x' }
      expect(() => assertAutomationGrantScope(baseGrant, badModel)).toThrowError(
        AutomationDecisionError,
      )
      try {
        assertAutomationGrantScope(baseGrant, badModel)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(AUTO_ERROR_CODES.MODEL_NOT_PERMITTED)
      }
    })

    it('rejects unlisted skills', () => {
      const badSkill = { ...baseRequest, skillId: 'unauthorized-skill-malicious' }
      expect(() => assertAutomationGrantScope(baseGrant, badSkill)).toThrowError(
        AutomationDecisionError,
      )
      try {
        assertAutomationGrantScope(baseGrant, badSkill)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(AUTO_ERROR_CODES.SKILL_NOT_PERMITTED)
      }
    })

    it('rejects requests when source fingerprint has drifted/mismatched', () => {
      const drifted = {
        ...baseRequest,
        sourceFingerprint: 'sha256-drifted-modified-outline',
      }
      expect(() => assertAutomationGrantScope(baseGrant, drifted)).toThrowError(
        AutomationDecisionError,
      )
      try {
        assertAutomationGrantScope(baseGrant, drifted)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(
          AUTO_ERROR_CODES.SOURCE_FINGERPRINT_MISMATCH,
        )
      }
    })

    it('stops automatic repair when max repair attempts is reached or exceeded', () => {
      const exhaustedGrant: AutomationTaskGrant = {
        ...baseGrant,
        currentRepairAttempts: 3,
        maxRepairAttempts: 3,
      }
      expect(() => assertAutomationGrantScope(exhaustedGrant, baseRequest)).toThrowError(
        AutomationDecisionError,
      )
      try {
        assertAutomationGrantScope(exhaustedGrant, baseRequest)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(
          AUTO_ERROR_CODES.REPAIR_ATTEMPTS_EXCEEDED,
        )
      }
    })

    it('rejects requests when grant is revoked', () => {
      const revokedGrant: AutomationTaskGrant = {
        ...baseGrant,
        revoked: true,
      }
      expect(() => assertAutomationGrantScope(revokedGrant, baseRequest)).toThrowError(
        AutomationDecisionError,
      )
      try {
        assertAutomationGrantScope(revokedGrant, baseRequest)
      } catch (err: unknown) {
        expect((err as AutomationDecisionError).code).toBe(
          AUTO_ERROR_CODES.GRANT_REVOKED_OR_EXPIRED,
        )
      }
    })
  })
})
