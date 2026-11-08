import { createHash } from 'node:crypto'

export type CollaborationStopCondition =
  | 'STOP_SUSPENDED_NEEDS_AUTHOR'
  | 'STOP_PRELIMINARY_VERIFIED'
  | 'STOP_NON_RETRYABLE_UNKNOWN'
  | 'STOP_UNAUTHORIZED_SCOPE'

export interface CollaborationSkillDefinition {
  name: string
  description: string
  version: string
  permittedTools: readonly string[]
  stopConditions: readonly CollaborationStopCondition[]
  instructionPrompt: string
}

export interface FrozenWritingSkillSnapshot {
  skillName: string
  stage: string
  sourceHash: string
  content: string
  frozenAt: number
}

const FORBIDDEN_SECRET_PATTERNS = [
  /ink_inbound_[a-f0-9]{32}/i,
  /sk-[a-zA-Z0-9]{20,}/i,
  /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
  /password\s*[:=]\s*['"][^'"]+['"]/i,
]

const FORBIDDEN_DIRECT_SQL = /\b(DROP|TRUNCATE|ALTER)\s+TABLE\b/i
const FORBIDDEN_AUTO_FINALIZE = /\b(canAutoFinalize|autoFinalize)\s*[:=]\s*true\b/i

export function validateCollaborationSkillPrompt(promptText: string): { valid: boolean; reason?: string } {
  if (!promptText || !promptText.trim()) {
    return { valid: false, reason: 'Collaboration skill prompt cannot be empty' }
  }

  // Security check: Must NOT hold secrets
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    if (pattern.test(promptText)) {
      return { valid: false, reason: 'Collaboration skill prompt must not contain credentials, tokens or secrets' }
    }
  }

  // Security check: Must NOT attempt direct database destructive operations
  if (FORBIDDEN_DIRECT_SQL.test(promptText)) {
    return { valid: false, reason: 'Collaboration skill prompt must not contain raw SQL table manipulation statements' }
  }

  // Security check: Must NOT claim auto-finalization authority without human approval
  if (FORBIDDEN_AUTO_FINALIZE.test(promptText)) {
    return { valid: false, reason: 'Collaboration skill prompt must not bypass human review or set autoFinalize=true' }
  }

  return { valid: true }
}

export function createFrozenWritingSkillSnapshot(params: {
  skillName: string
  stage: string
  content: string
}): FrozenWritingSkillSnapshot {
  const sourceHash = createHash('sha256')
    .update(`${params.skillName}:${params.stage}:${params.content}`)
    .digest('hex')

  return {
    skillName: params.skillName,
    stage: params.stage,
    sourceHash,
    content: params.content,
    frozenAt: Date.now(),
  }
}

export function verifyFrozenWritingSkillMatch(
  snapshot: FrozenWritingSkillSnapshot,
  candidate: { name: string; content: string },
): { matched: boolean; reason?: string } {
  if (snapshot.skillName !== candidate.name) {
    return {
      matched: false,
      reason: `Skill name mismatch: expected '${snapshot.skillName}', got '${candidate.name}'. Silent skill replacement is strictly prohibited.`,
    }
  }

  const currentHash = createHash('sha256')
    .update(`${candidate.name}:${snapshot.stage}:${candidate.content}`)
    .digest('hex')

  if (currentHash !== snapshot.sourceHash) {
    return {
      matched: false,
      reason: `Skill source hash mismatch for '${candidate.name}': snapshot was '${snapshot.sourceHash}', but candidate is '${currentHash}'. Modifying skill content during execution is prohibited.`,
    }
  }

  return { matched: true }
}

export function evaluateCollaborationStopCondition(statusData: {
  status: string
  currentStage?: string
  isHumanConfirmed?: boolean
  canAutoFinalize?: boolean
  error?: { code?: string; message?: string }
}): { shouldStop: boolean; condition?: CollaborationStopCondition; message: string } {
  // Condition 1: Unknown non-retryable terminal status
  if (statusData.status === 'unknown') {
    return {
      shouldStop: true,
      condition: 'STOP_NON_RETRYABLE_UNKNOWN',
      message: 'Workflow reached unknown status: automatic retry is strictly prohibited, stopping execution immediately.',
    }
  }

  // Condition 2: Suspended needs author decision (repair attempts exceeded or missing required facts)
  if (statusData.currentStage === 'suspended_needs_author' || statusData.status === 'suspended') {
    return {
      shouldStop: true,
      condition: 'STOP_SUSPENDED_NEEDS_AUTHOR',
      message: 'Workflow is suspended pending author decision: stop conditions triggered, awaiting human intervention.',
    }
  }

  // Condition 3: Candidate drafts created and preliminary acceptance report issued
  if (
    statusData.currentStage === 'completed' ||
    statusData.status === 'completed' ||
    statusData.currentStage === 'preliminary_acceptance'
  ) {
    // If completed from scratch or preliminary verified, agent MUST stop before finalization
    if (!statusData.isHumanConfirmed) {
      return {
        shouldStop: true,
        condition: 'STOP_PRELIMINARY_VERIFIED',
        message: 'Preliminary acceptance report issued: candidate drafts created, stopping before finalization. Author review required.',
      }
    }
  }

  // Condition 4: Unauthorized scope or self-approval attempt
  if (statusData.error?.code === 'INSUFFICIENT_SCOPE' || statusData.error?.code === 'HUMAN_REVIEW_SCOPE_REQUIRED') {
    return {
      shouldStop: true,
      condition: 'STOP_UNAUTHORIZED_SCOPE',
      message: 'Unauthorized operation or anti-self-approval gate triggered: stopping execution immediately.',
    }
  }

  return {
    shouldStop: false,
    message: 'Workflow in progress: continuation allowed.',
  }
}
