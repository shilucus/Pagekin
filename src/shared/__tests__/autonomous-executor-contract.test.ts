import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type AutonomousBatchChainConfig,
  type AutonomousExecutionResult,
  type AutonomousStepReceipt,
  AutonomousExecutorError,
  checkPredecessorConflict,
  EXECUTOR_ERROR_CODES,
  MAX_BATCH_CHAPTER_LIMIT,
  validateAutonomousBatchConfig,
} from '../autonomous-executor-contract'

describe('autonomous-executor-contract', () => {
  const baseConfig: AutonomousBatchChainConfig = {
    batchId: 'batch-001',
    grantId: 'grant-001',
    projectId: 'proj-001',
    startChapter: 6,
    chapterCount: 5,
    predecessorChain: [
      {
        chapterNumber: 4,
        draftId: 104,
        version: 1,
        contentHash: 'hash-ch4-content',
        sourceFingerprint: 'fp-01',
        receiptId: 'rc-104',
      },
      {
        chapterNumber: 5,
        draftId: 105,
        version: 2,
        contentHash: 'hash-ch5-content',
        sourceFingerprint: 'fp-01',
        receiptId: 'rc-105',
      },
    ],
    allowAutoFinalize: false,
  }

  it('preserves the exact four-field execution result without inventing a current-step receipt', () => {
    expectTypeOf<AutonomousExecutionResult>().toEqualTypeOf<{
      batchId: string
      receipts: AutonomousStepReceipt[]
      stoppedDueToConflict: boolean
      completedChapters: number
    }>()
    expectTypeOf<keyof AutonomousExecutionResult>()
      .toEqualTypeOf<'batchId' | 'receipts' | 'stoppedDueToConflict' | 'completedChapters'>()
    expectTypeOf<AutonomousStepReceipt['isFinalized']>().toEqualTypeOf<false>()

    const result: AutonomousExecutionResult = {
      batchId: baseConfig.batchId,
      receipts: [],
      stoppedDueToConflict: false,
      completedChapters: 0,
    }
    expect(Object.keys(result).sort()).toEqual(['batchId', 'completedChapters', 'receipts', 'stoppedDueToConflict'])
    expect(result.receipts).toEqual([])
  })

  describe('validateAutonomousBatchConfig', () => {
    it('passes for a valid batch configuration within 10 chapters', () => {
      expect(() => validateAutonomousBatchConfig(baseConfig)).not.toThrow()
    })

    it.each(['startChapter', 'chapterCount'] as const)('rejects non-integer or nonfinite %s', field => {
      for (const value of [NaN, Infinity, -Infinity, 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => validateAutonomousBatchConfig({ ...baseConfig, [field]: value }))
          .toThrowError(AutonomousExecutorError)
      }
    })

    it('rejects a batch whose final chapter is outside the safe integer range', () => {
      expect(() => validateAutonomousBatchConfig({ ...baseConfig, startChapter: Number.MAX_SAFE_INTEGER,
        chapterCount: 2 })).toThrowError(AutonomousExecutorError)
      expect(() => validateAutonomousBatchConfig({ ...baseConfig, startChapter: Number.MAX_SAFE_INTEGER,
        chapterCount: 1 })).not.toThrow()
    })

    it('rejects batch exceeding the 10-chapter limit', () => {
      const overLimit = {
        ...baseConfig,
        chapterCount: MAX_BATCH_CHAPTER_LIMIT + 1, // 11
      }
      expect(() => validateAutonomousBatchConfig(overLimit)).toThrowError(AutonomousExecutorError)
      try {
        validateAutonomousBatchConfig(overLimit)
      } catch (err: unknown) {
        expect((err as AutonomousExecutorError).code).toBe(
          EXECUTOR_ERROR_CODES.BATCH_CHAPTER_LIMIT_EXCEEDED,
        )
      }
    })

    it('strictly forbids allowAutoFinalize bypass', () => {
      const autoFinalizeBypass = {
        ...baseConfig,
        allowAutoFinalize: true,
      }
      expect(() => validateAutonomousBatchConfig(autoFinalizeBypass)).toThrowError(
        AutonomousExecutorError,
      )
      try {
        validateAutonomousBatchConfig(autoFinalizeBypass)
      } catch (err: unknown) {
        expect((err as AutonomousExecutorError).code).toBe(
          EXECUTOR_ERROR_CODES.FORBIDDEN_AUTO_FINALIZE_BYPASS,
        )
      }
    })

    it('rejects non-monotonic or corrupted predecessor chains', () => {
      const nonMonotonic = {
        ...baseConfig,
        predecessorChain: [
          {
            chapterNumber: 5,
            draftId: 105,
            version: 1,
            contentHash: 'h5',
            sourceFingerprint: 'fp',
            receiptId: 'rc5',
          },
          {
            chapterNumber: 4, // inverted!
            draftId: 104,
            version: 1,
            contentHash: 'h4',
            sourceFingerprint: 'fp',
            receiptId: 'rc4',
          },
        ],
      }
      expect(() => validateAutonomousBatchConfig(nonMonotonic)).toThrowError(
        AutonomousExecutorError,
      )
    })
  })

  describe('checkPredecessorConflict', () => {
    const expected = {
      chapterNumber: 1,
      draftId: 101,
      version: 2,
      contentHash: 'hash-abc',
      sourceFingerprint: 'fp-1',
      receiptId: 'rc-1',
    }

    it('returns false when version and contentHash match exactly', () => {
      expect(checkPredecessorConflict(expected, { version: 2, contentHash: 'hash-abc' })).toBe(
        false,
      )
    })

    it('returns true when version has changed', () => {
      expect(checkPredecessorConflict(expected, { version: 3, contentHash: 'hash-abc' })).toBe(
        true,
      )
    })

    it('returns true when contentHash has changed', () => {
      expect(
        checkPredecessorConflict(expected, { version: 2, contentHash: 'hash-modified-content' }),
      ).toBe(true)
    })
  })
})
