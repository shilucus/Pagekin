export const AUTOMATION_ALLOWED_FIELDS = [
  'character',
  'outline',
  'blueprint',
  'chapter_draft',
] as const

export type AutomationAllowedField = (typeof AUTOMATION_ALLOWED_FIELDS)[number]

export const AUTOMATION_DECISION_KINDS = [
  'planning_revision',
  'outline_revision',
  'character_proposal',
  'draft_repair',
] as const

export type AutomationDecisionKind = (typeof AUTOMATION_DECISION_KINDS)[number]

export const AUTO_ERROR_CODES = {
  GRANT_REVOKED_OR_EXPIRED: 'GRANT_REVOKED_OR_EXPIRED',
  OUT_OF_SCOPE_CHAPTER: 'OUT_OF_SCOPE_CHAPTER',
  FIELD_NOT_PERMITTED: 'FIELD_NOT_PERMITTED',
  MODEL_NOT_PERMITTED: 'MODEL_NOT_PERMITTED',
  SKILL_NOT_PERMITTED: 'SKILL_NOT_PERMITTED',
  REPAIR_ATTEMPTS_EXCEEDED: 'REPAIR_ATTEMPTS_EXCEEDED',
  SOURCE_FINGERPRINT_MISMATCH: 'SOURCE_FINGERPRINT_MISMATCH',
  FORBIDDEN_MACHINE_CONFIRMED_FABRICATION: 'FORBIDDEN_MACHINE_CONFIRMED_FABRICATION',
  HIGH_RISK_ACTION_PROHIBITED: 'HIGH_RISK_ACTION_PROHIBITED',
} as const

export type AutoErrorCode = (typeof AUTO_ERROR_CODES)[keyof typeof AUTO_ERROR_CODES]

export class AutomationDecisionError extends Error {
  public readonly code: AutoErrorCode
  public readonly status: number

  constructor(code: AutoErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'AutomationDecisionError'
    this.code = code
    this.status = status
  }
}

export interface AutomationTaskGrant {
  grantId: string
  projectId: string
  allowedChapterRange: [number, number]
  allowedFields: AutomationAllowedField[]
  allowedModels: string[]
  allowedSkills: string[]
  maxRepairAttempts: number
  currentRepairAttempts: number
  sourceFingerprint: string
  revoked: boolean
  createdAt: number
  updatedAt: number
}

export interface AutomationDecisionRequest {
  grantId: string
  projectId: string
  chapterNumber?: number
  targetField: AutomationAllowedField
  targetKind: AutomationDecisionKind
  modelId: string
  skillId?: string
  sourceFingerprint: string
  payload: Record<string, unknown>
  isHumanConfirmed?: boolean
}

export interface AutomationDecisionReceipt {
  decisionId: string
  grantId: string
  projectId: string
  source: 'machine_automated'
  targetKind: AutomationDecisionKind
  isHumanConfirmed: false
  repairAttemptIndex: number
  status: 'applied' | 'pending_decision' | 'rejected'
  reason?: string
  createdAt: number
}

/**
 * Validates the structural integrity and security of an incoming automation decision request.
 */
export function validateAutomationDecisionRequest(
  request: unknown,
): asserts request is AutomationDecisionRequest {
  if (!request || typeof request !== 'object') {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.FIELD_NOT_PERMITTED,
      'Automation decision request must be a valid object',
      400,
    )
  }

  const req = request as Partial<AutomationDecisionRequest>

  if (!req.grantId || typeof req.grantId !== 'string') {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.GRANT_REVOKED_OR_EXPIRED,
      'Missing or invalid grantId',
      400,
    )
  }

  if (!req.projectId || typeof req.projectId !== 'string') {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.FIELD_NOT_PERMITTED,
      'Missing or invalid projectId',
      400,
    )
  }

  if (
    !req.targetField ||
    !AUTOMATION_ALLOWED_FIELDS.includes(req.targetField as AutomationAllowedField)
  ) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.FIELD_NOT_PERMITTED,
      `Target field '${req.targetField}' is not permitted for automation`,
      400,
    )
  }

  if (
    !req.targetKind ||
    !AUTOMATION_DECISION_KINDS.includes(req.targetKind as AutomationDecisionKind)
  ) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.FIELD_NOT_PERMITTED,
      `Target kind '${req.targetKind}' is not recognized`,
      400,
    )
  }

  if (!req.modelId || typeof req.modelId !== 'string') {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.MODEL_NOT_PERMITTED,
      'Missing or invalid modelId',
      400,
    )
  }

  if (!req.sourceFingerprint || typeof req.sourceFingerprint !== 'string') {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.SOURCE_FINGERPRINT_MISMATCH,
      'Missing or invalid sourceFingerprint',
      400,
    )
  }

  // Core Integrity Rule: Machine automation CANNOT claim to be human-confirmed!
  if (req.isHumanConfirmed === true) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.FORBIDDEN_MACHINE_CONFIRMED_FABRICATION,
      'Machine automation decisions are strictly prohibited from forging human confirmation (isHumanConfirmed must not be true)',
      403,
    )
  }

  // Prohibit high-risk actions
  if (
    req.payload &&
    (req.payload.auto_finalize === true ||
      req.payload.action === 'finalize' ||
      req.payload.action === 'delete' ||
      req.payload.action === 'install_script' ||
      req.payload.action === 'modify_credentials')
  ) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.HIGH_RISK_ACTION_PROHIBITED,
      'High-risk actions (finalizing, deletion, installing scripts, modifying credentials) are strictly prohibited in automation decisions',
      403,
    )
  }
}

/**
 * Checks whether an automation decision request falls within the authorized scope of the task grant.
 */
export function assertAutomationGrantScope(
  grant: AutomationTaskGrant,
  req: AutomationDecisionRequest,
): void {
  if (grant.revoked) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.GRANT_REVOKED_OR_EXPIRED,
      `Automation grant '${grant.grantId}' has been revoked`,
      403,
    )
  }

  if (grant.projectId !== req.projectId) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.GRANT_REVOKED_OR_EXPIRED,
      `Grant projectId '${grant.projectId}' does not match request projectId '${req.projectId}'`,
      403,
    )
  }

  // 1. Chapter range check
  if (req.chapterNumber !== undefined) {
    const [min, max] = grant.allowedChapterRange
    if (req.chapterNumber < min || req.chapterNumber > max) {
      throw new AutomationDecisionError(
        AUTO_ERROR_CODES.OUT_OF_SCOPE_CHAPTER,
        `Chapter ${req.chapterNumber} is outside authorized range [${min}, ${max}]`,
        403,
      )
    }
  }

  // 2. Field check
  if (!grant.allowedFields.includes(req.targetField)) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.FIELD_NOT_PERMITTED,
      `Field '${req.targetField}' is not permitted by grant (allowed: ${grant.allowedFields.join(', ')})`,
      403,
    )
  }

  // 3. Model check
  if (!grant.allowedModels.includes(req.modelId)) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.MODEL_NOT_PERMITTED,
      `Model '${req.modelId}' is not authorized by grant (allowed: ${grant.allowedModels.join(', ')})`,
      403,
    )
  }

  // 4. Skill check (if specified)
  if (req.skillId && !grant.allowedSkills.includes(req.skillId)) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.SKILL_NOT_PERMITTED,
      `Skill '${req.skillId}' is not authorized by grant (allowed: ${grant.allowedSkills.join(', ')})`,
      403,
    )
  }

  // 5. Source Fingerprint check (prevents executing against stale/drifted facts)
  if (grant.sourceFingerprint !== req.sourceFingerprint) {
    throw new AutomationDecisionError(
      AUTO_ERROR_CODES.SOURCE_FINGERPRINT_MISMATCH,
      `Source fingerprint '${req.sourceFingerprint}' does not match grant baseline '${grant.sourceFingerprint}'`,
      409,
    )
  }

  // 6. Max Repair Attempts limit check
  if (req.targetKind === 'draft_repair') {
    if (grant.currentRepairAttempts >= grant.maxRepairAttempts) {
      throw new AutomationDecisionError(
        AUTO_ERROR_CODES.REPAIR_ATTEMPTS_EXCEEDED,
        `Repair attempts (${grant.currentRepairAttempts}) reached or exceeded maximum limit (${grant.maxRepairAttempts})`,
        429,
      )
    }
  }
}
