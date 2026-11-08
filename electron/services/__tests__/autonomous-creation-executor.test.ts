import { describe, expect, it, vi } from 'vitest'
import {
  type AutonomousBatchChainConfig,
  EXECUTOR_ERROR_CODES,
  MAX_BATCH_CHAPTER_LIMIT,
} from '../../../src/shared/autonomous-executor-contract'
import {
  AutonomousCreationExecutor,
  type ChapterGenerator,
  type DraftStorageProvider,
} from '../autonomous-creation-executor'

describe('autonomous-creation-executor', () => {
  function createMocks() {
    const drafts = new Map<number, { draftId: number; version: number; contentHash: string; content: string }>()

    const storage: DraftStorageProvider = {
      getDraft: vi.fn(async (ch: number) => {
        const item = drafts.get(ch)
        return item ? { version: item.version, contentHash: item.contentHash } : null
      }),
      saveCandidateDraft: vi.fn(async (ch: number, content: string) => {
        const draftId = 1000 + ch
        const version = 1
        const contentHash = `hash_ch_${ch}_${content.length}`
        drafts.set(ch, { draftId, version, contentHash, content })
        return { draftId, version, contentHash }
      }),
    }

    const generator: ChapterGenerator = {
      generateChapter: vi.fn(async (ch: number) => {
        return { content: `Draft prose for chapter ${ch}`, status: 'succeeded' as const }
      }),
    }

    return { storage, generator, drafts }
  }

  it('AC-1: executes a 3-chapter chained batch without bypassing finalization', async () => {
    const { storage, generator } = createMocks()
    const executor = new AutonomousCreationExecutor({ storage, generator })

    const config: AutonomousBatchChainConfig = {
      batchId: 'batch-test-01',
      grantId: 'grant-01',
      projectId: 'proj-01',
      startChapter: 1,
      chapterCount: 3,
      predecessorChain: [],
      allowAutoFinalize: false,
    }

    const result = await executor.executeBatchChain(config)

    expect(result.completedChapters).toBe(3)
    expect(result.stoppedDueToConflict).toBe(false)
    expect(result.receipts).toHaveLength(3)

    // Verify all generated chapters are strictly candidate drafts, NEVER finalized!
    for (const receipt of result.receipts) {
      expect(receipt.status).toBe('candidate_draft_created')
      expect(receipt.isFinalized).toBe(false)
    }
  })

  it('AC-1: strictly enforces 10-chapter boundary and forbids allowAutoFinalize bypass', async () => {
    const { storage, generator } = createMocks()
    const executor = new AutonomousCreationExecutor({ storage, generator })

    // 11 chapters -> over limit
    const overLimitConfig: AutonomousBatchChainConfig = {
      batchId: 'batch-over-limit',
      grantId: 'grant-01',
      projectId: 'proj-01',
      startChapter: 1,
      chapterCount: MAX_BATCH_CHAPTER_LIMIT + 1,
      predecessorChain: [],
      allowAutoFinalize: false,
    }

    await expect(executor.executeBatchChain(overLimitConfig)).rejects.toMatchObject({
      code: EXECUTOR_ERROR_CODES.BATCH_CHAPTER_LIMIT_EXCEEDED,
    })

    // allowAutoFinalize: true -> forbidden bypass
    const bypassConfig: AutonomousBatchChainConfig = {
      batchId: 'batch-bypass',
      grantId: 'grant-01',
      projectId: 'proj-01',
      startChapter: 1,
      chapterCount: 2,
      predecessorChain: [],
      allowAutoFinalize: true,
    }

    await expect(executor.executeBatchChain(bypassConfig)).rejects.toMatchObject({
      code: EXECUTOR_ERROR_CODES.FORBIDDEN_AUTO_FINALIZE_BYPASS,
    })
  })

  it('AC-2: halts with predecessor_conflict_readonly when predecessor is modified by author', async () => {
    const { storage, generator, drafts } = createMocks()

    // Predecessor chapter 1 exists with version 1
    drafts.set(1, {
      draftId: 101,
      version: 2, // Author edited chapter 1, incrementing version to 2!
      contentHash: 'hash_modified_by_author',
      content: 'Author modified prose',
    })

    const executor = new AutonomousCreationExecutor({ storage, generator })

    // Batch expects predecessor chapter 1 with version 1 and old hash
    const config: AutonomousBatchChainConfig = {
      batchId: 'batch-conflict-test',
      grantId: 'grant-01',
      projectId: 'proj-01',
      startChapter: 2,
      chapterCount: 3,
      predecessorChain: [
        {
          chapterNumber: 1,
          draftId: 101,
          version: 1, // Stale expectation!
          contentHash: 'hash_old_stale_content',
          sourceFingerprint: 'fp-1',
          receiptId: 'rc-1',
        },
      ],
      allowAutoFinalize: false,
    }

    const result = await executor.executeBatchChain(config)

    expect(result.stoppedDueToConflict).toBe(true)
    expect(result.completedChapters).toBe(0)
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]!.status).toBe('predecessor_conflict_readonly')
    expect(result.receipts[0]!.isFinalized).toBe(false)
    expect(result.receipts[0]!.error).toContain('Predecessor chapter 1 was modified')
  })

  it('AC-3: records real receipts on failure and does not perform silent mutation', async () => {
    const { storage } = createMocks()
    const generator: ChapterGenerator = {
      generateChapter: vi.fn().mockResolvedValueOnce({
        content: '',
        status: 'failed',
      }),
    }

    const executor = new AutonomousCreationExecutor({ storage, generator })

    const config: AutonomousBatchChainConfig = {
      batchId: 'batch-fail-test',
      grantId: 'grant-01',
      projectId: 'proj-01',
      startChapter: 1,
      chapterCount: 3,
      predecessorChain: [],
      allowAutoFinalize: false,
    }

    const result = await executor.executeBatchChain(config)

    expect(result.completedChapters).toBe(0)
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]!.status).toBe('failed')
    expect(result.receipts[0]!.isFinalized).toBe(false)
  })
})
