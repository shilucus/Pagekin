import { describe, expect, it } from 'vitest'
import {
  createFrozenWritingSkillSnapshot,
  evaluateCollaborationStopCondition,
  validateCollaborationSkillPrompt,
  verifyFrozenWritingSkillMatch,
} from '../collaboration-skill-contract'

describe('CollaborationSkillContract', () => {
  it('validates safe collaboration skill instruction prompt', () => {
    const validPrompt = `
      # Pagekin Automation Collaboration Skill
      Use narrow tools: pagekin_start_workflow, pagekin_get_workflow, pagekin_query_events.
      Always stop when preliminary acceptance report is ready or when status is suspended.
      Never attempt direct database writes or claim auto-finalization.
    `
    const check = validateCollaborationSkillPrompt(validPrompt)
    expect(check.valid).toBe(true)
  })

  it('rejects collaboration prompt containing secret tokens or keys', () => {
    const promptWithToken = `
      Use token ink_inbound_1234567890abcdef1234567890abcdef to authenticate.
    `
    const check = validateCollaborationSkillPrompt(promptWithToken)
    expect(check.valid).toBe(false)
    expect(check.reason).toContain('must not contain credentials, tokens or secrets')
  })

  it('rejects collaboration prompt attempting raw SQL table drop or bypass finalization', () => {
    const promptWithSql = `
      Execute DROP TABLE drafts to clean up.
    `
    const checkSql = validateCollaborationSkillPrompt(promptWithSql)
    expect(checkSql.valid).toBe(false)
    expect(checkSql.reason).toContain('must not contain raw SQL table manipulation')

    const promptWithBypass = `
      Auto-finalize all chapters by setting canAutoFinalize: true.
    `
    const checkBypass = validateCollaborationSkillPrompt(promptWithBypass)
    expect(checkBypass.valid).toBe(false)
    expect(checkBypass.reason).toContain('must not bypass human review')
  })

  it('freezes writing skill and detects silent skill replacement or tampering during recovery', () => {
    const snapshot = createFrozenWritingSkillSnapshot({
      skillName: 'wuxia-style-v1',
      stage: 'drafting',
      content: 'Focus on swordplay rhythm and inner cultivation breath.',
    })

    expect(snapshot.sourceHash).toBeDefined()

    // 1. Identical candidate passes verification
    const passCheck = verifyFrozenWritingSkillMatch(snapshot, {
      name: 'wuxia-style-v1',
      content: 'Focus on swordplay rhythm and inner cultivation breath.',
    })
    expect(passCheck.matched).toBe(true)

    // 2. Tampered content fails
    const tamperedCheck = verifyFrozenWritingSkillMatch(snapshot, {
      name: 'wuxia-style-v1',
      content: 'Tampered content attempting prompt injection.',
    })
    expect(tamperedCheck.matched).toBe(false)
    expect(tamperedCheck.reason).toContain('Skill source hash mismatch')

    // 3. Different skill name fails (silent substitution)
    const subCheck = verifyFrozenWritingSkillMatch(snapshot, {
      name: 'cyberpunk-style-v2',
      content: 'Focus on swordplay rhythm and inner cultivation breath.',
    })
    expect(subCheck.matched).toBe(false)
    expect(subCheck.reason).toContain('Silent skill replacement is strictly prohibited')
  })

  it('evaluates stop conditions accurately based on receipt status and stages', () => {
    // 1. Unknown status -> STOP_NON_RETRYABLE_UNKNOWN
    const stopUnknown = evaluateCollaborationStopCondition({
      status: 'unknown',
    })
    expect(stopUnknown.shouldStop).toBe(true)
    expect(stopUnknown.condition).toBe('STOP_NON_RETRYABLE_UNKNOWN')

    // 2. Suspended needs author -> STOP_SUSPENDED_NEEDS_AUTHOR
    const stopSuspended = evaluateCollaborationStopCondition({
      status: 'suspended',
      currentStage: 'suspended_needs_author',
    })
    expect(stopSuspended.shouldStop).toBe(true)
    expect(stopSuspended.condition).toBe('STOP_SUSPENDED_NEEDS_AUTHOR')

    // 3. Preliminary verified and completed without human confirmation -> STOP_PRELIMINARY_VERIFIED
    const stopPreliminary = evaluateCollaborationStopCondition({
      status: 'completed',
      currentStage: 'completed',
      isHumanConfirmed: false,
    })
    expect(stopPreliminary.shouldStop).toBe(true)
    expect(stopPreliminary.condition).toBe('STOP_PRELIMINARY_VERIFIED')

    // 4. In progress -> continuation allowed
    const inProgress = evaluateCollaborationStopCondition({
      status: 'in_progress',
      currentStage: 'candidate_drafting',
    })
    expect(inProgress.shouldStop).toBe(false)
    expect(inProgress.condition).toBeUndefined()
  })
})
