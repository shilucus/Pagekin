import { randomUUID } from 'node:crypto'
import {
  type AutonomousBatchChainConfig,
  type AutonomousStepReceipt,
  checkPredecessorConflict,
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

export interface ExecutionResult {
  batchId: string
  receipts: AutonomousStepReceipt[]
  stoppedDueToConflict: boolean
  completedChapters: number
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

        if (expectedRef) {
          const actualStored = await this.storage.getDraft(prevChapter)
          if (actualStored) {
            const hasConflict = checkPredecessorConflict(
              {
                chapterNumber: prevChapter,
                draftId: 0,
                version: expectedRef.version,
                contentHash: expectedRef.contentHash,
                sourceFingerprint: '',
                receiptId: '',
              },
              actualStored,
            )

            if (hasConflict) {
              // Predecessor conflict detected -> enter readonly block, refuse further writes
              stoppedDueToConflict = true
              receipts.push({
                stepId: `step_conflict_${randomUUID()}`,
                batchId: config.batchId,
                chapterNumber: currentChapter,
                draftId: 0,
                status: 'predecessor_conflict_readonly',
                isFinalized: false,
                sourcePredecessorHash: actualStored.contentHash,
                error: `Predecessor chapter ${prevChapter} was modified (version or content mismatch). Halting batch to preserve integrity.`,
                createdAt: Date.now(),
              })
              break
            }
          }
          predecessorHash = expectedRef.contentHash
        }
      }

      // 3. Generate candidate chapter
      const genResult = await this.generator.generateChapter(currentChapter, predecessorHash)

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
      const saved = await this.storage.saveCandidateDraft(currentChapter, genResult.content)

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

    return {
      batchId: config.batchId,
      receipts,
      stoppedDueToConflict,
      completedChapters: receipts.filter(r => r.status === 'candidate_draft_created').length,
    }
  }
}
