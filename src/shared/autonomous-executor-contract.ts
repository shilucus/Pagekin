export const MAX_BATCH_CHAPTER_LIMIT = 10

export const EXECUTOR_ERROR_CODES = {
  BATCH_CHAPTER_LIMIT_EXCEEDED: 'BATCH_CHAPTER_LIMIT_EXCEEDED',
  FORBIDDEN_AUTO_FINALIZE_BYPASS: 'FORBIDDEN_AUTO_FINALIZE_BYPASS',
  PREDECESSOR_CONFLICT_READONLY: 'PREDECESSOR_CONFLICT_READONLY',
  SILENT_MUTATION_PROHIBITED: 'SILENT_MUTATION_PROHIBITED',
  INVALID_PREDECESSOR_CHAIN: 'INVALID_PREDECESSOR_CHAIN',
} as const

export type ExecutorErrorCode = (typeof EXECUTOR_ERROR_CODES)[keyof typeof EXECUTOR_ERROR_CODES]

export class AutonomousExecutorError extends Error {
  public readonly code: ExecutorErrorCode
  public readonly status: number

  constructor(code: ExecutorErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'AutonomousExecutorError'
    this.code = code
    this.status = status
  }
}

export interface PredecessorCandidateRef {
  chapterNumber: number
  draftId: number
  version: number
  contentHash: string
  sourceFingerprint: string
  receiptId: string
}

export interface AutonomousBatchChainConfig {
  batchId: string
  grantId: string
  projectId: string
  startChapter: number
  chapterCount: number
  predecessorChain: PredecessorCandidateRef[]
  allowAutoFinalize?: boolean
}

export interface AutonomousStepReceipt {
  stepId: string
  batchId: string
  chapterNumber: number
  draftId: number
  status:
    | 'candidate_draft_created'
    | 'repair_converged'
    | 'predecessor_conflict_readonly'
    | 'failed'
    | 'unknown'
  isFinalized: false
  sourcePredecessorHash: string
  error?: string
  createdAt: number
}

export interface AutonomousExecutionResult {
  batchId: string
  receipts: AutonomousStepReceipt[]
  stoppedDueToConflict: boolean
  completedChapters: number
}

/**
 * Validates the batch configuration ensuring chapter limit (<= 10), chain integrity,
 * and forbidding auto_finalize bypass.
 */
export function validateAutonomousBatchConfig(
  config: unknown,
): asserts config is AutonomousBatchChainConfig {
  if (!config || typeof config !== 'object') {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'Batch configuration must be an object',
      400,
    )
  }

  const cfg = config as Partial<AutonomousBatchChainConfig>

  if (!cfg.batchId || typeof cfg.batchId !== 'string') {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'Missing or invalid batchId',
      400,
    )
  }

  if (!cfg.grantId || typeof cfg.grantId !== 'string') {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'Missing or invalid grantId',
      400,
    )
  }

  if (!cfg.projectId || typeof cfg.projectId !== 'string') {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'Missing or invalid projectId',
      400,
    )
  }

  if (typeof cfg.startChapter !== 'number' || !Number.isSafeInteger(cfg.startChapter) || cfg.startChapter < 1) {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'Invalid startChapter (must be a safe integer >= 1)',
      400,
    )
  }

  if (typeof cfg.chapterCount !== 'number' || !Number.isSafeInteger(cfg.chapterCount) || cfg.chapterCount < 1) {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'Invalid chapterCount (must be a safe integer >= 1)',
      400,
    )
  }

  // Enforce the 10-chapter maximum batch boundary
  if (cfg.chapterCount > MAX_BATCH_CHAPTER_LIMIT) {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.BATCH_CHAPTER_LIMIT_EXCEEDED,
      `Chapter count ${cfg.chapterCount} exceeds hard batch boundary limit of ${MAX_BATCH_CHAPTER_LIMIT} chapters`,
      400,
    )
  }

  if (!Number.isSafeInteger(cfg.startChapter + (cfg.chapterCount - 1))) {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'Final chapter exceeds the safe integer range',
      400,
    )
  }

  // Forbid auto_finalize bypass: candidate drafts must NOT be automatically promoted to finalized!
  if (cfg.allowAutoFinalize === true) {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.FORBIDDEN_AUTO_FINALIZE_BYPASS,
      'Automated batch creation is strictly prohibited from bypassing human finalization (allowAutoFinalize must be false)',
      403,
    )
  }

  // Check predecessor chain ordering
  if (!Array.isArray(cfg.predecessorChain)) {
    throw new AutonomousExecutorError(
      EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
      'predecessorChain must be an array',
      400,
    )
  }

  let prevChapter = 0
  for (const ref of cfg.predecessorChain) {
    if (!ref.chapterNumber || ref.chapterNumber <= prevChapter) {
      throw new AutonomousExecutorError(
        EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
        `Predecessor chain chapters must be strictly monotonically increasing (got ${ref.chapterNumber} after ${prevChapter})`,
        400,
      )
    }
    if (!ref.contentHash || !ref.sourceFingerprint || !ref.draftId) {
      throw new AutonomousExecutorError(
        EXECUTOR_ERROR_CODES.INVALID_PREDECESSOR_CHAIN,
        `Predecessor ref for chapter ${ref.chapterNumber} is missing required hash or draftId`,
        400,
      )
    }
    prevChapter = ref.chapterNumber
  }
}

/**
 * Compares an expected predecessor candidate reference with actual current draft facts.
 * Returns true if conflict is detected (version mismatch or content hash mismatch).
 */
export function checkPredecessorConflict(
  expected: PredecessorCandidateRef,
  actual: { version: number; contentHash: string },
): boolean {
  return expected.version !== actual.version || expected.contentHash !== actual.contentHash
}
