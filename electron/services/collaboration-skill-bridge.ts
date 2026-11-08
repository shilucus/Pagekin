import {
  type CollaborationSkillDefinition,
  type CollaborationStopCondition,
  createFrozenWritingSkillSnapshot,
  evaluateCollaborationStopCondition,
  type FrozenWritingSkillSnapshot,
  validateCollaborationSkillPrompt,
  verifyFrozenWritingSkillMatch,
} from '../../src/shared/collaboration-skill-contract'
import { INBOUND_MCP_TOOL_NAMES } from '../../src/shared/inbound-mcp-contract'

export class CollaborationSkillBridge {
  private readonly frozenWritingSkills = new Map<string, FrozenWritingSkillSnapshot>()

  /**
   * Generates the standard Pagekin Automation Collaboration Skill definition.
   */
  public getCollaborationSkill(): CollaborationSkillDefinition {
    const instructionPrompt = `# Pagekin Automation Collaboration Skill

You are an automated assistant collaborating with Pagekin, a local-first desktop novel writing engine.
You interact strictly via the narrow domain API / CLI / MCP tools.

## Permitted Inbound Tools
${INBOUND_MCP_TOOL_NAMES.map(t => `- ${t}`).join('\n')}

## Non-Bypassable Rules and Stop Conditions
1. **Never attempt direct database writes**: All mutations must go through domain tasks.
2. **Never hold or leak secrets**: API tokens and project credentials stay isolated.
3. **Acknowledge Stop Conditions immediately**:
   - When a preliminary acceptance report is ready (preliminary_acceptance / completed), STOP immediately. Do NOT claim finalization; author human confirmation is required.
   - When a task enters 'suspended_needs_author' or repair attempts reach limit, STOP and notify author. Never invent confirmation.
   - When status is 'unknown', STOP immediately. Unknown terminal status is non-retryable.
   - When encountering unauthorized scope or self-approval error, STOP immediately.
`

    const check = validateCollaborationSkillPrompt(instructionPrompt)
    if (!check.valid) {
      throw new Error(`协作 Skill 提示词安全校验失败: ${check.reason}`) // i18n-exempt: 内部断言错误
    }

    return {
      name: 'pagekin-automation-collaboration-skill',
      description: 'Drives external agents to safely consume Pagekin API/CLI/MCP creation tasks and stop conditions.',
      version: '1.0.0',
      permittedTools: INBOUND_MCP_TOOL_NAMES,
      stopConditions: [
        'STOP_SUSPENDED_NEEDS_AUTHOR',
        'STOP_PRELIMINARY_VERIFIED',
        'STOP_NON_RETRYABLE_UNKNOWN',
        'STOP_UNAUTHORIZED_SCOPE',
      ],
      instructionPrompt,
    }
  }

  /**
   * Registers a stage writing skill snapshot upon first run, or strictly verifies against
   * the frozen snapshot upon recovery to prevent silent skill replacement.
   */
  public registerOrVerifyWritingSkill(params: {
    projectId: string
    stage: string
    skill: { name: string; content: string }
  }): { success: boolean; snapshot: FrozenWritingSkillSnapshot; error?: string } {
    const key = `${params.projectId}:${params.stage}`
    const existing = this.frozenWritingSkills.get(key)

    if (!existing) {
      const snapshot = createFrozenWritingSkillSnapshot({
        skillName: params.skill.name,
        stage: params.stage,
        content: params.skill.content,
      })
      this.frozenWritingSkills.set(key, snapshot)
      return { success: true, snapshot }
    }

    const verification = verifyFrozenWritingSkillMatch(existing, params.skill)
    if (!verification.matched) {
      return {
        success: false,
        snapshot: existing,
        error: verification.reason ?? 'Stage writing skill mismatch during recovery',
      }
    }

    return { success: true, snapshot: existing }
  }

  public getFrozenWritingSkill(projectId: string, stage: string): FrozenWritingSkillSnapshot | undefined {
    return this.frozenWritingSkills.get(`${projectId}:${stage}`)
  }

  public clearProjectWritingSkills(projectId: string): void {
    for (const [key] of Array.from(this.frozenWritingSkills.entries())) {
      if (key.startsWith(`${projectId}:`)) {
        this.frozenWritingSkills.delete(key)
      }
    }
  }

  /**
   * Simulates agent decision making on top of receipt data (AC-3).
   * Verifies that agent stops under explicit stop conditions rather than relying solely on static rules.
   */
  public simulateAgentDecision(receipt: {
    status: string
    currentStage?: string
    isHumanConfirmed?: boolean
    canAutoFinalize?: boolean
    error?: { code?: string; message?: string }
  }): { action: 'continue' | 'stop'; stopCondition?: CollaborationStopCondition; reason: string } {
    const evaluation = evaluateCollaborationStopCondition(receipt)
    if (evaluation.shouldStop) {
      return {
        action: 'stop',
        stopCondition: evaluation.condition,
        reason: evaluation.message,
      }
    }

    return {
      action: 'continue',
      reason: evaluation.message,
    }
  }
}
