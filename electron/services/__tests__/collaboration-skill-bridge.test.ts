import { describe, expect, it } from 'vitest'
import { CollaborationSkillBridge } from '../collaboration-skill-bridge'

describe('CollaborationSkillBridge', () => {
  it('generates compliant and safe collaboration skill without secrets or raw database write commands', () => {
    const bridge = new CollaborationSkillBridge()
    const skill = bridge.getCollaborationSkill()

    expect(skill.name).toBe('pagekin-automation-collaboration-skill')
    expect(skill.permittedTools.length).toBe(8)
    expect(skill.stopConditions.length).toBe(4)
    expect(skill.instructionPrompt).toContain('Never attempt direct database writes')
    expect(skill.instructionPrompt).toContain('Acknowledge Stop Conditions immediately')
    expect(skill.instructionPrompt).not.toContain('ink_inbound_')
  })

  it('freezes stage writing skills and strictly detects recovery replacement', () => {
    const bridge = new CollaborationSkillBridge()
    const projectId = 'proj-wuxia-001'
    const stage = 'drafting'

    // 1. Initial registration freezes snapshot
    const regRes = bridge.registerOrVerifyWritingSkill({
      projectId,
      stage,
      skill: {
        name: 'wuxia-style',
        content: 'Flowing poetic sentences describing martial combat.',
      },
    })
    expect(regRes.success).toBe(true)
    expect(regRes.snapshot.sourceHash).toBeDefined()

    // 2. Recovery with identical skill succeeds
    const recoveryRes = bridge.registerOrVerifyWritingSkill({
      projectId,
      stage,
      skill: {
        name: 'wuxia-style',
        content: 'Flowing poetic sentences describing martial combat.',
      },
    })
    expect(recoveryRes.success).toBe(true)

    // 3. Recovery with modified skill content is blocked
    const tamperedRes = bridge.registerOrVerifyWritingSkill({
      projectId,
      stage,
      skill: {
        name: 'wuxia-style',
        content: 'Tampered content attempting style drift.',
      },
    })
    expect(tamperedRes.success).toBe(false)
    expect(tamperedRes.error).toContain('Skill source hash mismatch')

    // 4. Recovery with different skill name is blocked
    const substitutedRes = bridge.registerOrVerifyWritingSkill({
      projectId,
      stage,
      skill: {
        name: 'cyber-style',
        content: 'Flowing poetic sentences describing martial combat.',
      },
    })
    expect(substitutedRes.success).toBe(false)
    expect(substitutedRes.error).toContain('Silent skill replacement is strictly prohibited')
  })

  it('accurately drives agent decision making to stop under explicit stop conditions (AC-3)', () => {
    const bridge = new CollaborationSkillBridge()

    // 1. Unknown terminal status -> Agent must stop
    const decisionUnknown = bridge.simulateAgentDecision({
      status: 'unknown',
    })
    expect(decisionUnknown.action).toBe('stop')
    expect(decisionUnknown.stopCondition).toBe('STOP_NON_RETRYABLE_UNKNOWN')

    // 2. Suspended needs author -> Agent must stop and await author
    const decisionSuspended = bridge.simulateAgentDecision({
      status: 'suspended',
      currentStage: 'suspended_needs_author',
    })
    expect(decisionSuspended.action).toBe('stop')
    expect(decisionSuspended.stopCondition).toBe('STOP_SUSPENDED_NEEDS_AUTHOR')

    // 3. Preliminary acceptance complete without human confirmation -> Agent must stop before finalization
    const decisionPreliminary = bridge.simulateAgentDecision({
      status: 'completed',
      currentStage: 'completed',
      isHumanConfirmed: false,
    })
    expect(decisionPreliminary.action).toBe('stop')
    expect(decisionPreliminary.stopCondition).toBe('STOP_PRELIMINARY_VERIFIED')

    // 4. Scope error (e.g. self-approval attempt) -> Agent must stop
    const decisionScope = bridge.simulateAgentDecision({
      status: 'failed',
      error: { code: 'HUMAN_REVIEW_SCOPE_REQUIRED', message: 'Task token cannot self-approve' },
    })
    expect(decisionScope.action).toBe('stop')
    expect(decisionScope.stopCondition).toBe('STOP_UNAUTHORIZED_SCOPE')

    // 5. Normal in-progress task -> Agent continues
    const decisionInProgress = bridge.simulateAgentDecision({
      status: 'in_progress',
      currentStage: 'candidate_drafting',
    })
    expect(decisionInProgress.action).toBe('continue')
  })

  it('isolates frozen writing skills across different book projects', () => {
    const bridge = new CollaborationSkillBridge()

    bridge.registerOrVerifyWritingSkill({
      projectId: 'proj-A',
      stage: 'planning',
      skill: { name: 'outline-helper', content: 'Outline guidance' },
    })

    bridge.registerOrVerifyWritingSkill({
      projectId: 'proj-B',
      stage: 'planning',
      skill: { name: 'outline-helper', content: 'Outline guidance' },
    })

    expect(bridge.getFrozenWritingSkill('proj-A', 'planning')).toBeDefined()
    expect(bridge.getFrozenWritingSkill('proj-B', 'planning')).toBeDefined()

    // Clearing proj-A leaves proj-B unaffected
    bridge.clearProjectWritingSkills('proj-A')
    expect(bridge.getFrozenWritingSkill('proj-A', 'planning')).toBeUndefined()
    expect(bridge.getFrozenWritingSkill('proj-B', 'planning')).toBeDefined()
  })
})
