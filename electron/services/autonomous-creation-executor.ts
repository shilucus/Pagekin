import { randomUUID } from 'node:crypto'
import {
  type AutonomousBatchChainConfig,
  type AutonomousExecutionResult,
  type AutonomousStepReceipt,
  type PredecessorCandidateRef,
  validateAutonomousBatchConfig,
} from '../../src/shared/autonomous-executor-contract'

export interface DraftStorageProvider {
  readonly contractVersion: 2
  getDraft(chapterNumber: number): Promise<PredecessorCandidateRef | null>
  /** Compare the complete predecessor and save in one atomic boundary; conflict guarantees zero writes. */
  compareAndSaveCandidate(request: {
    chapterNumber: number
    content: string
    expectedPredecessor: Readonly<PredecessorCandidateRef> | null
  }): Promise<
    | { status: 'saved'; candidate: PredecessorCandidateRef }
    | { status: 'predecessor_conflict'; actualPredecessor: PredecessorCandidateRef | null }
  >
}

function snapshotCandidateRef(value: unknown, chapterNumber: number): Readonly<PredecessorCandidateRef> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ref = value as Partial<PredecessorCandidateRef>
  if (ref.chapterNumber !== chapterNumber || !Number.isSafeInteger(chapterNumber) || chapterNumber < 1
    || !Number.isSafeInteger(ref.draftId) || ref.draftId! < 1
    || !Number.isSafeInteger(ref.version) || ref.version! < 1
    || ![ref.contentHash, ref.sourceFingerprint, ref.receiptId].every(item => typeof item === 'string' && item.trim())) return null
  return Object.freeze({ chapterNumber, draftId: ref.draftId!, version: ref.version!, contentHash: ref.contentHash!,
    sourceFingerprint: ref.sourceFingerprint!, receiptId: ref.receiptId! })
}

function sameCandidateRef(expected: Readonly<PredecessorCandidateRef>, actual: Readonly<PredecessorCandidateRef> | null): boolean {
  return actual !== null && expected.chapterNumber === actual.chapterNumber && expected.draftId === actual.draftId
    && expected.version === actual.version && expected.contentHash === actual.contentHash
    && expected.sourceFingerprint === actual.sourceFingerprint && expected.receiptId === actual.receiptId
}

export interface ChapterGenerator {
  generateChapter(chapterNumber: number, predecessorContentHash?: string): Promise<{ content: string; status?: 'succeeded' | 'failed' | 'unknown' }>
}

export type ExecutionResult = AutonomousExecutionResult
export type AutonomousExecutionPhase = 'predecessor_read' | 'generation' | 'candidate_save'

export class AutonomousExecutionInterruptedError extends Error {
  public readonly code = 'AUTONOMOUS_EXECUTION_INTERRUPTED' as const
  public readonly actualExecutionResult: ExecutionResult

  constructor(
    public readonly phase: AutonomousExecutionPhase,
    public readonly chapterNumber: number,
    result: ExecutionResult,
  ) {
    super('AUTONOMOUS_EXECUTION_INTERRUPTED')
    this.name = 'AutonomousExecutionInterruptedError'
    this.actualExecutionResult = { ...result, receipts: result.receipts.map(receipt => ({ ...receipt })) }
  }
}

export class AutonomousCreationExecutor {
  private readonly storage: DraftStorageProvider
  private readonly generator: ChapterGenerator

  constructor(options: { storage: DraftStorageProvider; generator: ChapterGenerator }) {
    if (options.storage.contractVersion !== 2) throw new Error('AUTONOMOUS_STORAGE_CONTRACT_INVALID')
    this.storage = options.storage
    this.generator = options.generator
  }

  /**
   * Executes a bounded autonomous batch creation chain up to 10 chapters.
   */
  async executeBatchChain(config: AutonomousBatchChainConfig): Promise<ExecutionResult> {
    // 1. Enforce strict batch configuration validation (<= 10 chapters, no auto_finalize bypass)
    validateAutonomousBatchConfig(config)
    const { batchId, startChapter, chapterCount } = config

    const receipts: AutonomousStepReceipt[] = []
    let stoppedDueToConflict = false
    const result = (): ExecutionResult => ({
      batchId,
      receipts,
      stoppedDueToConflict,
      completedChapters: receipts.filter(r => r.status === 'candidate_draft_created').length,
    })

    // Map existing declared predecessor refs by chapter number
    const predecessorMap = new Map<number, Readonly<PredecessorCandidateRef> | null>()
    for (const ref of config.predecessorChain) {
      predecessorMap.set(ref.chapterNumber, snapshotCandidateRef(ref, ref.chapterNumber))
    }

    let lastCandidateRef: Readonly<PredecessorCandidateRef> | null = null
    const conflict = (chapterNumber: number, actual: Readonly<PredecessorCandidateRef> | null) => {
      stoppedDueToConflict = true
      receipts.push({ stepId: `step_conflict_${randomUUID()}`, batchId, chapterNumber, draftId: 0,
        status: 'predecessor_conflict_readonly', isFinalized: false, sourcePredecessorHash: actual?.contentHash ?? '',
        error: `Predecessor chapter ${chapterNumber - 1} is missing, incomplete or changed. Halting batch to preserve integrity.`,
        createdAt: Date.now() })
    }

    for (let i = 0; i < chapterCount; i++) {
      const currentChapter = startChapter + i
      const prevChapter = currentChapter - 1

      let predecessorHash = ''
      const expectedRef = i > 0 ? lastCandidateRef : predecessorMap.get(prevChapter) ?? null

      // 2. Predecessor CAS & Conflict check
      if (prevChapter >= 1) {
        let actualStored: Readonly<PredecessorCandidateRef> | null = null
        if (expectedRef) {
          try {
            actualStored = snapshotCandidateRef(await this.storage.getDraft(prevChapter), prevChapter)
          } catch {
            throw new AutonomousExecutionInterruptedError('predecessor_read', currentChapter, result())
          }
        }
        if (!expectedRef || !sameCandidateRef(expectedRef, actualStored)) {
          conflict(currentChapter, actualStored)
          break
        }
        predecessorHash = expectedRef.contentHash
      }

      // 3. Generate candidate chapter
      let genResult: Awaited<ReturnType<ChapterGenerator['generateChapter']>>
      try {
        genResult = await this.generator.generateChapter(currentChapter, predecessorHash)
      } catch {
        throw new AutonomousExecutionInterruptedError('generation', currentChapter, result())
      }

      if (genResult.status === 'failed' || genResult.status === 'unknown') {
        receipts.push({
          stepId: `step_${randomUUID()}`,
          batchId,
          chapterNumber: currentChapter,
          draftId: 0,
          status: genResult.status,
          isFinalized: false,
          sourcePredecessorHash: predecessorHash,
          error: `Generation ended in ${genResult.status} terminal status`,
          createdAt: Date.now(),
        })
        break
      }

      const generatedContent = genResult.content
      if (expectedRef) {
        let actualStored: Readonly<PredecessorCandidateRef> | null
        try {
          actualStored = snapshotCandidateRef(await this.storage.getDraft(prevChapter), prevChapter)
        } catch {
          throw new AutonomousExecutionInterruptedError('predecessor_read', currentChapter, result())
        }
        if (!sameCandidateRef(expectedRef, actualStored)) {
          conflict(currentChapter, actualStored)
          break
        }
      }

      // 4. Save candidate draft (Strictly draft, never finalized!)
      let saved: Readonly<PredecessorCandidateRef>
      try {
        const outcome = await this.storage.compareAndSaveCandidate({ chapterNumber: currentChapter,
          content: generatedContent, expectedPredecessor: expectedRef })
        if (outcome?.status === 'predecessor_conflict') {
          conflict(currentChapter, snapshotCandidateRef(outcome.actualPredecessor, prevChapter))
          break
        }
        const candidate = outcome?.status === 'saved' ? snapshotCandidateRef(outcome.candidate, currentChapter) : null
        if (!candidate) throw new Error('AUTONOMOUS_CANDIDATE_SAVE_UNPROVEN')
        saved = candidate
      } catch {
        // The storage may already have committed; only the earlier confirmed prefix is known.
        throw new AutonomousExecutionInterruptedError('candidate_save', currentChapter, result())
      }

      const receipt: AutonomousStepReceipt = {
        stepId: `step_${randomUUID()}`,
        batchId,
        chapterNumber: currentChapter,
        draftId: saved.draftId,
        status: 'candidate_draft_created',
        isFinalized: false, // Invariant: candidate draft is never finalized
        sourcePredecessorHash: predecessorHash,
        createdAt: Date.now(),
      }

      receipts.push(receipt)

      lastCandidateRef = saved
    }

    return result()
  }
}
