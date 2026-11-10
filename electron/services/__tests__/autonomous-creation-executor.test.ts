import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  type AutonomousBatchChainConfig,
  type AutonomousExecutionResult,
  AutonomousExecutorError,
  EXECUTOR_ERROR_CODES,
  MAX_BATCH_CHAPTER_LIMIT,
} from '../../../src/shared/autonomous-executor-contract'
import {
  AutonomousCreationExecutor,
  AutonomousExecutionInterruptedError,
  type ChapterGenerator,
  type DraftStorageProvider,
  type ExecutionResult,
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

  function batchConfig(overrides: Partial<AutonomousBatchChainConfig> = {}): AutonomousBatchChainConfig {
    return { batchId: 'batch-interruption', grantId: 'grant-01', projectId: 'proj-01', startChapter: 1,
      chapterCount: 3, predecessorChain: [], allowAutoFinalize: false, ...overrides }
  }

  function predecessor(chapterNumber: number) {
    return { chapterNumber, draftId: 1000 + chapterNumber, version: 1, contentHash: `declared-hash-${chapterNumber}`,
      sourceFingerprint: 'fictional-source', receiptId: `receipt-${chapterNumber}` }
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

  it('keeps the service ExecutionResult export identical to the shared four-field contract', () => {
    expectTypeOf<ExecutionResult>().toEqualTypeOf<AutonomousExecutionResult>()
    expectTypeOf<keyof ExecutionResult>().toEqualTypeOf<'batchId' | 'receipts' | 'stoppedDueToConflict' | 'completedChapters'>()
  })

  it.each([
    { phase: 'predecessor_read', prefix: 0 }, { phase: 'predecessor_read', prefix: 1 },
    { phase: 'generation', prefix: 0 }, { phase: 'generation', prefix: 1 },
    { phase: 'candidate_save', prefix: 0 }, { phase: 'candidate_save', prefix: 1 },
  ] as const)('preserves only the confirmed $prefix chapter prefix when $phase throws', async ({ phase, prefix }) => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    const firstRead = phase === 'predecessor_read' && prefix === 0
    if (firstRead) drafts.set(1, { ...ref, content: 'Fictional predecessor prose' })
    const config = batchConfig(firstRead ? { startChapter: 2, predecessorChain: [ref] } : {})
    const interruptedChapter = config.startChapter + prefix
    const originalRead = vi.mocked(storage.getDraft).getMockImplementation()!
    const originalGenerate = vi.mocked(generator.generateChapter).getMockImplementation()!
    const originalSave = vi.mocked(storage.saveCandidateDraft).getMockImplementation()!
    const privateError = 'SYNTHETIC_PRIVATE_PROVIDER_DETAIL'
    vi.mocked(storage.getDraft).mockImplementation(async chapter => {
      if (phase === 'predecessor_read' && chapter === interruptedChapter - 1) throw new Error(privateError)
      return originalRead(chapter)
    })
    vi.mocked(generator.generateChapter).mockImplementation(async (chapter, hash) => {
      if (phase === 'generation' && chapter === interruptedChapter) throw new Error(privateError)
      return originalGenerate(chapter, hash)
    })
    vi.mocked(storage.saveCandidateDraft).mockImplementation(async (chapter, content) => {
      if (phase === 'candidate_save' && chapter === interruptedChapter) throw new Error(privateError)
      return originalSave(chapter, content)
    })

    const executor = new AutonomousCreationExecutor({ storage, generator })
    const error: unknown = await executor.executeBatchChain(config).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AutonomousExecutionInterruptedError)
    if (!(error instanceof AutonomousExecutionInterruptedError)) throw new Error('Expected a typed execution interruption')
    expect(error).toMatchObject({ code: 'AUTONOMOUS_EXECUTION_INTERRUPTED', message: 'AUTONOMOUS_EXECUTION_INTERRUPTED',
      phase, chapterNumber: interruptedChapter, actualExecutionResult: { batchId: config.batchId,
        stoppedDueToConflict: false, completedChapters: prefix } })
    expect(error.actualExecutionResult.receipts).toHaveLength(prefix)
    expect(error.actualExecutionResult.receipts.map(receipt => ({ chapterNumber: receipt.chapterNumber, draftId: receipt.draftId,
      status: receipt.status, isFinalized: receipt.isFinalized }))).toEqual(prefix === 0 ? []
      : [{ chapterNumber: 1, draftId: 1001, status: 'candidate_draft_created', isFinalized: false }])
    expect(error.actualExecutionResult.receipts.some(receipt => receipt.chapterNumber === interruptedChapter)).toBe(false)
    expect(JSON.stringify(error)).not.toContain(privateError)
    expect(error.stack).not.toContain(privateError)
    expect(generator.generateChapter).toHaveBeenCalledTimes(prefix + (phase === 'predecessor_read' ? 0 : 1))
    expect(storage.saveCandidateDraft).toHaveBeenCalledTimes(prefix + (phase === 'candidate_save' ? 1 : 0))
    expect(drafts.has(interruptedChapter)).toBe(false)
  })

  it.each([0, 1])('does not invent a saved receipt after storage commits and throws with prefix %s', async prefix => {
    const { storage, generator, drafts } = createMocks()
    const originalSave = vi.mocked(storage.saveCandidateDraft).getMockImplementation()!
    const interruptedChapter = prefix + 1
    vi.mocked(storage.saveCandidateDraft).mockImplementation(async (chapter, content) => {
      const saved = await originalSave(chapter, content)
      if (chapter === interruptedChapter) throw new Error('SYNTHETIC_PRIVATE_STORAGE_DETAIL')
      return saved
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const error: unknown = await executor.executeBatchChain(batchConfig()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AutonomousExecutionInterruptedError)
    if (!(error instanceof AutonomousExecutionInterruptedError)) throw new Error('Expected a typed save interruption')
    expect(error.phase).toBe('candidate_save')
    expect(error.chapterNumber).toBe(interruptedChapter)
    expect(drafts.get(interruptedChapter)).toMatchObject({ draftId: 1000 + interruptedChapter })
    expect(drafts.size).toBe(prefix + 1)
    expect(error.actualExecutionResult.completedChapters).toBe(prefix)
    expect(error.actualExecutionResult.receipts).toHaveLength(prefix)
    expect(error.actualExecutionResult.receipts.map(receipt => receipt.draftId)).toEqual(prefix ? [1001] : [])
    expect(generator.generateChapter).toHaveBeenCalledTimes(prefix + 1)
    expect(storage.saveCandidateDraft).toHaveBeenCalledTimes(prefix + 1)
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC_PRIVATE_STORAGE_DETAIL')
  })

  it('detaches the interrupted result and its receipt objects from the supplied observed result', async () => {
    const { storage, generator } = createMocks()
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ chapterCount: 1 }))
    const snapshot = structuredClone(result)
    const error = new AutonomousExecutionInterruptedError('generation', 2, result)
    expect(error.actualExecutionResult).not.toBe(result)
    expect(error.actualExecutionResult.receipts).not.toBe(result.receipts)
    expect(error.actualExecutionResult.receipts[0]).not.toBe(result.receipts[0])
    result.receipts[0]!.draftId = 9999
    result.receipts.length = 0
    result.completedChapters = 0
    result.stoppedDueToConflict = true
    expect(error.actualExecutionResult).toEqual(snapshot)
  })

  it('keeps batch validation failures ordinary and does not call execution boundaries', async () => {
    const { storage, generator } = createMocks()
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const error: unknown = await executor.executeBatchChain(batchConfig({ chapterCount: 11 })).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AutonomousExecutorError)
    expect(error).not.toBeInstanceOf(AutonomousExecutionInterruptedError)
    expect(error).toMatchObject({ code: EXECUTOR_ERROR_CODES.BATCH_CHAPTER_LIMIT_EXCEEDED })
    expect(storage.getDraft).not.toHaveBeenCalled()
    expect(generator.generateChapter).not.toHaveBeenCalled()
    expect(storage.saveCandidateDraft).not.toHaveBeenCalled()
  })

  it('halts before generation when a declared predecessor row is absent without claiming its hash was read', async () => {
    const { storage, generator } = createMocks()
    const ref = predecessor(1)
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ startChapter: 2, predecessorChain: [ref] }))
    expect(result).toMatchObject({ completedChapters: 0, stoppedDueToConflict: true })
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]).toMatchObject({ chapterNumber: 2, draftId: 0, status: 'predecessor_conflict_readonly',
      sourcePredecessorHash: '', isFinalized: false })
    expect(result.receipts[0]!.sourcePredecessorHash).not.toBe(ref.contentHash)
    expect(storage.getDraft).toHaveBeenCalledExactlyOnceWith(1)
    expect(generator.generateChapter).not.toHaveBeenCalled()
    expect(storage.saveCandidateDraft).not.toHaveBeenCalled()
  })

  it.each(['empty-chain', 'older-ref-only'] as const)('halts a cross-batch %s without a direct predecessor reference', async kind => {
    const { storage, generator, drafts } = createMocks()
    drafts.set(2, { ...predecessor(2), content: 'Existing but undeclared predecessor prose' })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ startChapter: 3,
      predecessorChain: kind === 'older-ref-only' ? [predecessor(1)] : [] }))
    expect(result).toMatchObject({ completedChapters: 0, stoppedDueToConflict: true })
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]).toMatchObject({ chapterNumber: 3, draftId: 0, status: 'predecessor_conflict_readonly',
      sourcePredecessorHash: '', isFinalized: false })
    expect(storage.getDraft).not.toHaveBeenCalled()
    expect(generator.generateChapter).not.toHaveBeenCalled()
    expect(storage.saveCandidateDraft).not.toHaveBeenCalled()
    expect(drafts.size).toBe(1)
  })

  it('retains the confirmed prefix but stops when the saved batch-internal predecessor disappears', async () => {
    const { storage, generator, drafts } = createMocks()
    const originalSave = vi.mocked(storage.saveCandidateDraft).getMockImplementation()!
    vi.mocked(storage.saveCandidateDraft).mockImplementation(async (chapter, content) => {
      const saved = await originalSave(chapter, content)
      drafts.delete(chapter)
      return saved
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig())
    expect(result).toMatchObject({ completedChapters: 1, stoppedDueToConflict: true })
    expect(result.receipts).toHaveLength(2)
    expect(result.receipts[0]).toMatchObject({ chapterNumber: 1, draftId: 1001, status: 'candidate_draft_created' })
    expect(result.receipts[1]).toMatchObject({ chapterNumber: 2, draftId: 0, status: 'predecessor_conflict_readonly', sourcePredecessorHash: '' })
    expect(generator.generateChapter).toHaveBeenCalledTimes(1)
    expect(storage.saveCandidateDraft).toHaveBeenCalledTimes(1)
    expect(storage.getDraft).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each(['version-only', 'hash-only'] as const)('keeps the predecessor readonly barrier for a %s change', async kind => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    const actual = { ...ref, content: 'Existing fictional predecessor prose',
      version: kind === 'version-only' ? 2 : ref.version,
      contentHash: kind === 'hash-only' ? 'changed-actual-hash' : ref.contentHash }
    drafts.set(1, actual)
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ startChapter: 2, predecessorChain: [ref] }))
    expect(result).toMatchObject({ stoppedDueToConflict: true, completedChapters: 0 })
    expect(result.receipts[0]).toMatchObject({ status: 'predecessor_conflict_readonly', sourcePredecessorHash: actual.contentHash })
    expect(generator.generateChapter).not.toHaveBeenCalled()
    expect(storage.saveCandidateDraft).not.toHaveBeenCalled()
  })

  it('continues a declared cross-batch chain only after reading the matching predecessor', async () => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    drafts.set(1, { ...ref, content: 'Fictional predecessor prose' })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ startChapter: 2, chapterCount: 2, predecessorChain: [ref] }))
    expect(result).toMatchObject({ stoppedDueToConflict: false, completedChapters: 2 })
    expect(storage.getDraft).toHaveBeenNthCalledWith(1, 1)
    expect(storage.getDraft).toHaveBeenNthCalledWith(2, 2)
    expect(generator.generateChapter).toHaveBeenNthCalledWith(1, 2, ref.contentHash)
    expect(generator.generateChapter).toHaveBeenNthCalledWith(2, 3, drafts.get(2)!.contentHash)
    expect(result.receipts.map(receipt => receipt.draftId)).toEqual([1002, 1003])
  })

  it.each([
    { status: 'failed', prefix: 0 }, { status: 'failed', prefix: 1 },
    { status: 'unknown', prefix: 0 }, { status: 'unknown', prefix: 1 },
  ] as const)('preserves explicit $status behavior after $prefix confirmed candidates without retry', async ({ status, prefix }) => {
    const { storage, generator } = createMocks()
    const originalGenerate = vi.mocked(generator.generateChapter).getMockImplementation()!
    vi.mocked(generator.generateChapter).mockImplementation(async (chapter, hash) => chapter === prefix + 1
      ? { content: '', status } : originalGenerate(chapter, hash))
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig())
    expect(result.completedChapters).toBe(prefix)
    expect(result.stoppedDueToConflict).toBe(false)
    expect(result.receipts).toHaveLength(prefix + 1)
    expect(result.receipts.at(-1)).toMatchObject({ chapterNumber: prefix + 1, draftId: 0, status, isFinalized: false })
    expect(result.receipts.filter(receipt => receipt.status === 'candidate_draft_created').map(receipt => receipt.draftId))
      .toEqual(prefix ? [1001] : [])
    expect(generator.generateChapter).toHaveBeenCalledTimes(prefix + 1)
    expect(storage.saveCandidateDraft).toHaveBeenCalledTimes(prefix)
  })
})
