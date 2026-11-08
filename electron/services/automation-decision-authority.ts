import { randomUUID } from 'node:crypto'
import {
  type AutomationDecisionReceipt,
  type AutomationDecisionRequest,
  type AutomationTaskGrant,
  AUTO_ERROR_CODES,
  assertAutomationGrantScope,
  AutomationDecisionError,
  validateAutomationDecisionRequest,
} from '../../src/shared/automation-decision-contract'

export interface CreateAutomationGrantOptions {
  projectId: string
  allowedChapterRange: [number, number]
  allowedFields: AutomationTaskGrant['allowedFields']
  allowedModels: string[]
  allowedSkills: string[]
  maxRepairAttempts?: number
  sourceFingerprint: string
}

export class AutomationDecisionAuthority {
  private readonly grants = new Map<string, AutomationTaskGrant>()
  private readonly decisions = new Map<string, AutomationDecisionReceipt>()

  /**
   * Author creates an explicit bounded automation task grant.
   */
  createGrant(options: CreateAutomationGrantOptions): AutomationTaskGrant {
    const grantId = `grant_auto_${randomUUID().replace(/-/g, '')}`
    const now = Date.now()

    const grant: AutomationTaskGrant = {
      grantId,
      projectId: options.projectId,
      allowedChapterRange: [...options.allowedChapterRange],
      allowedFields: [...options.allowedFields],
      allowedModels: [...options.allowedModels],
      allowedSkills: [...options.allowedSkills],
      maxRepairAttempts: options.maxRepairAttempts ?? 3,
      currentRepairAttempts: 0,
      sourceFingerprint: options.sourceFingerprint,
      revoked: false,
      createdAt: now,
      updatedAt: now,
    }

    this.grants.set(grantId, grant)
    return grant
  }

  /**
   * Revokes an automation task grant.
   */
  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId)
    if (!grant) {
      return false
    }
    grant.revoked = true
    grant.updatedAt = Date.now()
    return true
  }

  getGrant(grantId: string): AutomationTaskGrant | null {
    return this.grants.get(grantId) ?? null
  }

  /**
   * Evaluates an incoming machine decision against the grant scope and anti-fabrication rules.
   */
  async recordDecision(
    request: AutomationDecisionRequest,
  ): Promise<AutomationDecisionReceipt> {
    // 1. Structural & anti-fabrication validation
    validateAutomationDecisionRequest(request)

    // 2. Fetch active grant
    const grant = this.grants.get(request.grantId)
    if (!grant) {
      throw new AutomationDecisionError(
        AUTO_ERROR_CODES.GRANT_REVOKED_OR_EXPIRED,
        `Grant '${request.grantId}' does not exist or has expired`,
        404,
      )
    }

    // 3. Grant scope & boundary assertion
    assertAutomationGrantScope(grant, request)

    // 4. Increment repair attempt if applicable
    let attemptIndex = 0
    if (request.targetKind === 'draft_repair') {
      grant.currentRepairAttempts += 1
      attemptIndex = grant.currentRepairAttempts
      grant.updatedAt = Date.now()
    }

    // 5. Issue immutable decision receipt with fixed machine provenance
    const decisionId = `dec_${randomUUID()}`
    const receipt: AutomationDecisionReceipt = {
      decisionId,
      grantId: grant.grantId,
      projectId: grant.projectId,
      source: 'machine_automated',
      targetKind: request.targetKind,
      isHumanConfirmed: false,
      repairAttemptIndex: attemptIndex,
      status: 'applied',
      createdAt: Date.now(),
    }

    this.decisions.set(decisionId, receipt)
    return receipt
  }

  /**
   * Retrieves all decision receipts for a given grant.
   */
  getDecisionsForGrant(grantId: string): AutomationDecisionReceipt[] {
    return Array.from(this.decisions.values()).filter(d => d.grantId === grantId)
  }
}
