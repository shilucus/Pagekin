import { randomUUID } from 'node:crypto'
import {
  type AutonomousBatchChainConfig,
  type AutonomousExecutionResult,
  type AutonomousStepReceipt,
  type PredecessorCandidateRef,
  validateAutonomousBatchConfig,
} from '../../src/shared/autonomous-executor-contract'

export interface DraftStorageProvider {
  getDraft(chapterNumber: number): Promise<{ version: number; contentHash: string } | null>
  saveCandidateDraft(chapterNumber: number, content: string): Promise<{ draftId: number; version: number; contentHash: string }>
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
    this.storage = options.storage
    this.generator = options.generator
  }

  /**
   * Executes a bounded autonomous batch creation chain up to 10 chapters.
   */
  async executeBatchChain(config: AutonomousBatchChainConfig): Promise<ExecutionResult> {
    // 1. Enforce strict batch configuration validation (<= 10 chapters, no auto_finalize bypass)
    validateAutonomousBatchConfig(config)

    const receipts: AutonomousStepReceipt[] = []
    let stoppedDueToConflict = false
    const result = (): ExecutionResult => ({
      batchId: config.batchId,
      receipts,
      stoppedDueToConflict,
      completedChapters: receipts.filter(r => r.status === 'candidate_draft_created').length,
    })

    // Map existing declared predecessor refs by chapter number
    const predecessorMap = new Map<number, PredecessorCandidateRef>()
    for (const ref of config.predecessorChain) {
      predecessorMap.set(ref.chapterNumber, ref)
    }

    let lastCandidateRef: { chapterNumber: number; version: number; contentHash: string } | null = null

    for (let i = 0; i < config.chapterCount; i++) {
      const currentChapter = config.startChapter + i
      const prevChapter = currentChapter - 1

      let predecessorHash = ''

      // 2. Predecessor CAS & Conflict check
      if (prevChapter >= 1) {
        const declaredRef = predecessorMap.get(prevChapter)
        const expectedRef = declaredRef ?? lastCandidateRef

        let actualStored: Awaited<ReturnType<DraftStorageProvider['getDraft']>> = null
        if (expectedRef) {
          try {
            actualStored = await this.storage.getDraft(prevChapter)
          } catch {
            throw new AutonomousExecutionInterruptedError('predecessor_read', currentChapter, result())
          }
        }
        if (!expectedRef || !actualStored
          || expectedRef.version !== actualStored.version || expectedRef.contentHash !== actualStored.contentHash) {
          stoppedDueToConflict = true
          receipts.push({
            stepId: `step_conflict_${randomUUID()}`,
            batchId: config.batchId,
            chapterNumber: currentChapter,
            draftId: 0,
            status: 'predecessor_conflict_readonly',
            isFinalized: false,
            sourcePredecessorHash: actualStored?.contentHash ?? '',
            error: !expectedRef
              ? `Predecessor chapter ${prevChapter} has no declared candidate reference. Halting batch to preserve integrity.`
              : !actualStored
                ? `Predecessor chapter ${prevChapter} is missing. Halting batch to preserve integrity.`
                : `Predecessor chapter ${prevChapter} was modified (version or content mismatch). Halting batch to preserve integrity.`,
            createdAt: Date.now(),
          })
          break
        }
        predecessorHash = actualStored.contentHash
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
          batchId: config.batchId,
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

      // 4. Save candidate draft (Strictly draft, never finalized!)
      let saved: Awaited<ReturnType<DraftStorageProvider['saveCandidateDraft']>>
      try {
        saved = await this.storage.saveCandidateDraft(currentChapter, genResult.content)
      } catch {
        // The storage may already have committed; only the earlier confirmed prefix is known.
        throw new AutonomousExecutionInterruptedError('candidate_save', currentChapter, result())
      }

      const receipt: AutonomousStepReceipt = {
        stepId: `step_${randomUUID()}`,
        batchId: config.batchId,
        chapterNumber: currentChapter,
        draftId: saved.draftId,
        status: 'candidate_draft_created',
        isFinalized: false, // Invariant: candidate draft is never finalized
        sourcePredecessorHash: predecessorHash,
        createdAt: Date.now(),
      }

      receipts.push(receipt)

      lastCandidateRef = {
        chapterNumber: currentChapter,
        version: saved.version,
        contentHash: saved.contentHash,
      }
    }

    return result()
  }
}
