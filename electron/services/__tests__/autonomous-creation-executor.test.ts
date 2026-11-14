import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  type AutonomousBatchChainConfig,
  type AutonomousExecutionResult,
  type PredecessorCandidateRef,
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
    const drafts = new Map<number, PredecessorCandidateRef & { content: string }>()

    const storage: DraftStorageProvider = {
      contractVersion: 2,
      getDraft: vi.fn(async (ch: number) => {
        const item = drafts.get(ch)
        return item ? { ...item } : null
      }),
      compareAndSaveCandidate: vi.fn(async ({ chapterNumber: ch, content, expectedPredecessor }: Parameters<DraftStorageProvider['compareAndSaveCandidate']>[0]) => {
        const actual = drafts.get(ch - 1) ?? null
        if (expectedPredecessor && (!actual || Object.entries(expectedPredecessor).some(([key, value]) => actual[key as keyof PredecessorCandidateRef] !== value))) {
          return { status: 'predecessor_conflict' as const, actualPredecessor: actual }
        }
        const draftId = 1000 + ch
        const version = 1
        const contentHash = `hash_ch_${ch}_${content.length}`
        const candidate = { chapterNumber: ch, draftId, version, contentHash, sourceFingerprint: `saved-source-${ch}`, receiptId: `saved-receipt-${ch}` }
        drafts.set(ch, { ...candidate, content })
        return { status: 'saved' as const, candidate }
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

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
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

  it.each([
    { name: 'NaN start', startChapter: Number.NaN, chapterCount: 1 },
    { name: 'positive infinite start', startChapter: Number.POSITIVE_INFINITY, chapterCount: 1 },
    { name: 'negative infinite start', startChapter: Number.NEGATIVE_INFINITY, chapterCount: 1 },
    { name: 'fractional start', startChapter: 1.5, chapterCount: 1 },
    { name: 'unsafe start', startChapter: Number.MAX_SAFE_INTEGER + 1, chapterCount: 1 },
    { name: 'NaN count', startChapter: 1, chapterCount: Number.NaN },
    { name: 'positive infinite count', startChapter: 1, chapterCount: Number.POSITIVE_INFINITY },
    { name: 'negative infinite count', startChapter: 1, chapterCount: Number.NEGATIVE_INFINITY },
    { name: 'fractional count', startChapter: 1, chapterCount: 1.5 },
    { name: 'unsafe count', startChapter: 1, chapterCount: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'end chapter overflow', startChapter: Number.MAX_SAFE_INTEGER, chapterCount: 2 },
  ])('rejects $name before any storage or generation operation', async ({ startChapter, chapterCount }) => {
    const { storage, generator, drafts } = createMocks()
    const executor = new AutonomousCreationExecutor({ storage, generator })
    await expect(executor.executeBatchChain(batchConfig({ startChapter, chapterCount }))).rejects.toBeInstanceOf(AutonomousExecutorError)
    expect(storage.getDraft).not.toHaveBeenCalled()
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
    expect(generator.generateChapter).not.toHaveBeenCalled()
    expect(drafts.size).toBe(0)
  })

  it('AC-2: halts with predecessor_conflict_readonly when predecessor is modified by author', async () => {
    const { storage, generator, drafts } = createMocks()

    // Predecessor chapter 1 exists with version 1
    drafts.set(1, {
      chapterNumber: 1,
      draftId: 101,
      version: 2, // Author edited chapter 1, incrementing version to 2!
      contentHash: 'hash_modified_by_author',
      sourceFingerprint: 'fp-1',
      receiptId: 'rc-1',
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
    expect(result.receipts[0]!.error).toContain('Predecessor chapter 1')
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
    const originalSave = vi.mocked(storage.compareAndSaveCandidate).getMockImplementation()!
    const privateError = 'SYNTHETIC_PRIVATE_PROVIDER_DETAIL'
    vi.mocked(storage.getDraft).mockImplementation(async chapter => {
      if (phase === 'predecessor_read' && chapter === interruptedChapter - 1) throw new Error(privateError)
      return originalRead(chapter)
    })
    vi.mocked(generator.generateChapter).mockImplementation(async (chapter, hash) => {
      if (phase === 'generation' && chapter === interruptedChapter) throw new Error(privateError)
      return originalGenerate(chapter, hash)
    })
    vi.mocked(storage.compareAndSaveCandidate).mockImplementation(async request => {
      if (phase === 'candidate_save' && request.chapterNumber === interruptedChapter) throw new Error(privateError)
      return originalSave(request)
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
    expect(storage.compareAndSaveCandidate).toHaveBeenCalledTimes(prefix + (phase === 'candidate_save' ? 1 : 0))
    expect(drafts.has(interruptedChapter)).toBe(false)
  })

  it.each([0, 1])('does not invent a saved receipt after storage commits and throws with prefix %s', async prefix => {
    const { storage, generator, drafts } = createMocks()
    const originalSave = vi.mocked(storage.compareAndSaveCandidate).getMockImplementation()!
    const interruptedChapter = prefix + 1
    vi.mocked(storage.compareAndSaveCandidate).mockImplementation(async request => {
      const saved = await originalSave(request)
      if (request.chapterNumber === interruptedChapter) throw new Error('SYNTHETIC_PRIVATE_STORAGE_DETAIL')
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
    expect(storage.compareAndSaveCandidate).toHaveBeenCalledTimes(prefix + 1)
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
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
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
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
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
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
    expect(drafts.size).toBe(1)
  })

  it('retains the confirmed prefix but stops when the saved batch-internal predecessor disappears', async () => {
    const { storage, generator, drafts } = createMocks()
    const originalSave = vi.mocked(storage.compareAndSaveCandidate).getMockImplementation()!
    vi.mocked(storage.compareAndSaveCandidate).mockImplementation(async request => {
      const saved = await originalSave(request)
      drafts.delete(request.chapterNumber)
      return saved
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig())
    expect(result).toMatchObject({ completedChapters: 1, stoppedDueToConflict: true })
    expect(result.receipts).toHaveLength(2)
    expect(result.receipts[0]).toMatchObject({ chapterNumber: 1, draftId: 1001, status: 'candidate_draft_created' })
    expect(result.receipts[1]).toMatchObject({ chapterNumber: 2, draftId: 0, status: 'predecessor_conflict_readonly', sourcePredecessorHash: '' })
    expect(generator.generateChapter).toHaveBeenCalledTimes(1)
    expect(storage.compareAndSaveCandidate).toHaveBeenCalledTimes(1)
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
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
  })

  it('continues a declared cross-batch chain only after reading the matching predecessor', async () => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    drafts.set(1, { ...ref, content: 'Fictional predecessor prose' })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ startChapter: 2, chapterCount: 2, predecessorChain: [ref] }))
    expect(result).toMatchObject({ stoppedDueToConflict: false, completedChapters: 2 })
    expect(storage.getDraft).toHaveBeenNthCalledWith(1, 1)
    expect(storage.getDraft).toHaveBeenNthCalledWith(2, 1)
    expect(storage.getDraft).toHaveBeenNthCalledWith(3, 2)
    expect(storage.getDraft).toHaveBeenNthCalledWith(4, 2)
    expect(generator.generateChapter).toHaveBeenNthCalledWith(1, 2, ref.contentHash)
    expect(generator.generateChapter).toHaveBeenNthCalledWith(2, 3, drafts.get(2)!.contentHash)
    expect(result.receipts.map(receipt => receipt.draftId)).toEqual([1002, 1003])
    const requests = vi.mocked(storage.compareAndSaveCandidate).mock.calls.map(([request]) => request)
    expect(requests[0].expectedPredecessor).toEqual(ref)
    expect(requests[1].expectedPredecessor).toEqual(expect.objectContaining({ chapterNumber: 2, draftId: 1002,
      version: 1, contentHash: drafts.get(2)!.contentHash, sourceFingerprint: 'saved-source-2', receiptId: 'saved-receipt-2' }))
  })

  it.each(['draftId', 'sourceFingerprint', 'receiptId'] as const)('rejects a %s replacement even when predecessor version and text match', async field => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    const actual = { ...ref, content: 'Fictional unchanged prose', [field]: field === 'draftId' ? 5001 : 'replacement-identity' }
    drafts.set(1, actual as PredecessorCandidateRef & { content: string })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ startChapter: 2, predecessorChain: [ref] }))
    expect(result).toMatchObject({ stoppedDueToConflict: true, completedChapters: 0 })
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]).toMatchObject({ status: 'predecessor_conflict_readonly', draftId: 0, isFinalized: false })
    expect(generator.generateChapter).not.toHaveBeenCalled()
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
    expect(drafts.size).toBe(1)
  })

  it.each(['draftId', 'sourceFingerprint', 'receiptId', 'version', 'contentHash', 'missing'] as const)('stops after generation when its predecessor changes at %s', async field => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    drafts.set(1, { ...ref, content: 'Fictional predecessor' })
    const started = deferred<void>(), generated = deferred<Awaited<ReturnType<ChapterGenerator['generateChapter']>>>()
    vi.mocked(generator.generateChapter).mockImplementation(() => { started.resolve(); return generated.promise })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const pending = executor.executeBatchChain(batchConfig({ startChapter: 2, predecessorChain: [ref] }))
    await started.promise
    if (field === 'missing') drafts.delete(1)
    else Object.assign(drafts.get(1)!, { [field]: field === 'draftId' || field === 'version' ? 5001 : 'changed-after-generation' })
    generated.resolve({ content: 'Fictional successor', status: 'succeeded' })
    const result = await pending
    expect(result).toMatchObject({ stoppedDueToConflict: true, completedChapters: 0 })
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]).toMatchObject({ status: 'predecessor_conflict_readonly', chapterNumber: 2, draftId: 0 })
    expect(generator.generateChapter).toHaveBeenCalledTimes(1)
    expect(storage.getDraft).toHaveBeenCalledTimes(2)
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
    expect(drafts.has(2)).toBe(false)
  })

  it.each([0, 1])('passes the original frozen expectation to atomic CAS after %i confirmed candidates', async prefix => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    if (!prefix) drafts.set(1, { ...ref, content: 'Fictional predecessor' })
    const save = vi.mocked(storage.compareAndSaveCandidate).getMockImplementation()!
    let originalExpected: PredecessorCandidateRef | null = null
    vi.mocked(storage.compareAndSaveCandidate).mockImplementation(async request => {
      if (request.chapterNumber === 2) {
        originalExpected = { ...request.expectedPredecessor! }
        expect(Object.isFrozen(request.expectedPredecessor)).toBe(true)
        expect(Reflect.set(request.expectedPredecessor!, 'draftId', 9999)).toBe(false)
        drafts.get(1)!.draftId = 5001
      }
      return save(request)
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig(prefix ? {} : { startChapter: 2, predecessorChain: [ref] }))
    expect(originalExpected).toEqual(prefix ? expect.objectContaining({ draftId: 1001, receiptId: 'saved-receipt-1', sourceFingerprint: 'saved-source-1' }) : ref)
    expect(result).toMatchObject({ completedChapters: prefix, stoppedDueToConflict: true })
    expect(result.receipts).toHaveLength(prefix + 1)
    expect(result.receipts.at(-1)).toMatchObject({ chapterNumber: 2, status: 'predecessor_conflict_readonly', draftId: 0 })
    expect(result.receipts.filter(receipt => receipt.status === 'candidate_draft_created').map(receipt => receipt.draftId)).toEqual(prefix ? [1001] : [])
    expect(drafts.has(2)).toBe(false)
    expect(generator.generateChapter).toHaveBeenCalledTimes(prefix + 1)
    expect(storage.compareAndSaveCandidate).toHaveBeenCalledTimes(prefix + 1)
  })

  it('detaches the declared expectation and each read response from mutable caller-owned objects', async () => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1), original = { ...ref }, returned = { ...ref }
    const config = batchConfig({ startChapter: 2, chapterCount: 1, predecessorChain: [ref] })
    drafts.set(1, { ...ref, content: 'Fictional predecessor' })
    let reads = 0
    vi.mocked(storage.getDraft).mockImplementation(async () => ++reads === 1 ? returned : { ...drafts.get(1)! })
    vi.mocked(generator.generateChapter).mockImplementation(async () => {
      Object.assign(ref, { draftId: 9999, receiptId: 'caller-mutated', sourceFingerprint: 'caller-mutated' })
      Object.assign(returned, { draftId: 9998, receiptId: 'read-response-mutated', sourceFingerprint: 'read-response-mutated' })
      config.batchId = 'mutated-batch'
      config.startChapter = 99
      config.chapterCount = 10
      return { content: 'Fictional successor' }
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(config)
    expect(result).toMatchObject({ batchId: 'batch-interruption', completedChapters: 1, stoppedDueToConflict: false })
    const request = vi.mocked(storage.compareAndSaveCandidate).mock.calls[0][0]
    expect(request.expectedPredecessor).toEqual(original)
    expect(request.expectedPredecessor).not.toBe(ref)
    expect(request.expectedPredecessor).not.toBe(returned)
    expect(Object.isFrozen(request.expectedPredecessor)).toBe(true)
    expect(generator.generateChapter).toHaveBeenCalledExactlyOnceWith(2, original.contentHash)
  })

  it('does not silently rebase when the caller mutates both its declaration and actual storage during generation', async () => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    drafts.set(1, { ...ref, content: 'Fictional predecessor' })
    vi.mocked(generator.generateChapter).mockImplementation(async () => {
      ref.receiptId = 'reselected-candidate'
      drafts.get(1)!.receiptId = ref.receiptId
      return { content: 'Fictional successor' }
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ startChapter: 2, predecessorChain: [ref] }))
    expect(result).toMatchObject({ completedChapters: 0, stoppedDueToConflict: true })
    expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
  })

  it('uses the immutable full storage save response as the next batch-internal expectation', async () => {
    const { storage, generator } = createMocks()
    const save = vi.mocked(storage.compareAndSaveCandidate).getMockImplementation()!
    let firstResponse: PredecessorCandidateRef | undefined
    vi.mocked(storage.compareAndSaveCandidate).mockImplementation(async request => {
      const response = await save(request)
      if (request.chapterNumber === 1 && response.status === 'saved') firstResponse = response.candidate
      return response
    })
    vi.mocked(generator.generateChapter).mockImplementation(async chapterNumber => {
      if (chapterNumber === 2) Object.assign(firstResponse!, { draftId: 9999, receiptId: 'mutated-save-ack', sourceFingerprint: 'mutated-save-ack' })
      return { content: `Fictional chapter ${chapterNumber}` }
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ chapterCount: 2 }))
    expect(result).toMatchObject({ completedChapters: 2, stoppedDueToConflict: false })
    const expected = vi.mocked(storage.compareAndSaveCandidate).mock.calls[1][0].expectedPredecessor
    expect(expected).toMatchObject({ chapterNumber: 1, draftId: 1001, sourceFingerprint: 'saved-source-1', receiptId: 'saved-receipt-1' })
    expect(expected).not.toBe(firstResponse)
  })

  it('uses the actual saved batch predecessor rather than an extra declaration for an in-batch chapter', async () => {
    const { storage, generator, drafts } = createMocks()
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const result = await executor.executeBatchChain(batchConfig({ chapterCount: 2, predecessorChain: [predecessor(1)] }))
    expect(result).toMatchObject({ completedChapters: 2, stoppedDueToConflict: false })
    expect(vi.mocked(storage.compareAndSaveCandidate).mock.calls[1][0].expectedPredecessor).toEqual(
      expect.objectContaining({ chapterNumber: 1, draftId: 1001, contentHash: drafts.get(1)!.contentHash,
        sourceFingerprint: 'saved-source-1', receiptId: 'saved-receipt-1' }),
    )
    expect(generator.generateChapter).toHaveBeenNthCalledWith(2, 2, drafts.get(1)!.contentHash)
  })

  it.each(['chapterNumber', 'draftId', 'version', 'contentHash', 'sourceFingerprint', 'receiptId'] as const)('rejects an incomplete %s in the declared or read predecessor before generation', async field => {
    for (const source of ['declaration', 'storage'] as const) {
      const { storage, generator, drafts } = createMocks()
      const ref = predecessor(1), incomplete: Partial<PredecessorCandidateRef> = { ...ref }
      delete incomplete[field]
      drafts.set(1, { ...ref, content: 'Fictional predecessor' })
      if (source === 'storage') vi.mocked(storage.getDraft).mockResolvedValue(incomplete as PredecessorCandidateRef)
      const executor = new AutonomousCreationExecutor({ storage, generator })
      const config = batchConfig({ startChapter: 2, predecessorChain: [source === 'declaration' ? incomplete as PredecessorCandidateRef : ref] })
      if (source === 'declaration' && ['chapterNumber', 'draftId', 'contentHash', 'sourceFingerprint'].includes(field)) {
        await expect(executor.executeBatchChain(config)).rejects.toBeInstanceOf(AutonomousExecutorError)
      } else {
        const result = await executor.executeBatchChain(config)
        expect(result).toMatchObject({ completedChapters: 0, stoppedDueToConflict: true })
        expect(result.receipts).toHaveLength(1)
        expect(result.receipts[0]).toMatchObject({ draftId: 0, status: 'predecessor_conflict_readonly' })
      }
      expect(generator.generateChapter).not.toHaveBeenCalled()
      expect(storage.compareAndSaveCandidate).not.toHaveBeenCalled()
      expect(drafts.has(2)).toBe(false)
    }
  })

  it.each(['chapterNumber', 'draftId', 'version', 'contentHash', 'sourceFingerprint', 'receiptId'] as const)('does not invent success when the save response lacks %s after a possible commit', async field => {
    const { storage, generator, drafts } = createMocks()
    const save = vi.mocked(storage.compareAndSaveCandidate).getMockImplementation()!
    vi.mocked(storage.compareAndSaveCandidate).mockImplementation(async request => {
      const outcome = await save(request)
      if (outcome.status !== 'saved') return outcome
      const incomplete: Partial<PredecessorCandidateRef> = { ...outcome.candidate }
      delete incomplete[field]
      return { status: 'saved', candidate: incomplete as PredecessorCandidateRef }
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const error: unknown = await executor.executeBatchChain(batchConfig()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AutonomousExecutionInterruptedError)
    expect(error).toMatchObject({ phase: 'candidate_save', chapterNumber: 1,
      actualExecutionResult: { completedChapters: 0, receipts: [] } })
    expect(drafts.has(1)).toBe(true)
    expect(generator.generateChapter).toHaveBeenCalledTimes(1)
    expect(storage.compareAndSaveCandidate).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1])('preserves only the confirmed %i candidate prefix when the post-generation read throws', async prefix => {
    const { storage, generator, drafts } = createMocks()
    const ref = predecessor(1)
    if (!prefix) drafts.set(1, { ...ref, content: 'Fictional predecessor' })
    const read = vi.mocked(storage.getDraft).getMockImplementation()!
    let reads = 0
    vi.mocked(storage.getDraft).mockImplementation(async chapterNumber => {
      if (++reads === 2) throw new Error('PRIVATE_POST_GENERATION_READ_DETAIL')
      return read(chapterNumber)
    })
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const error: unknown = await executor.executeBatchChain(batchConfig(prefix ? {} : { startChapter: 2, predecessorChain: [ref] }))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AutonomousExecutionInterruptedError)
    expect(error).toMatchObject({ phase: 'predecessor_read', chapterNumber: 2,
      actualExecutionResult: { completedChapters: prefix, stoppedDueToConflict: false } })
    if (!(error instanceof AutonomousExecutionInterruptedError)) throw new Error('Expected a typed read interruption')
    expect(error.actualExecutionResult.receipts.map(receipt => receipt.draftId)).toEqual(prefix ? [1001] : [])
    expect(generator.generateChapter).toHaveBeenCalledTimes(prefix + 1)
    expect(storage.compareAndSaveCandidate).toHaveBeenCalledTimes(prefix)
    expect(drafts.has(2)).toBe(false)
    expect(JSON.stringify(error)).not.toContain('PRIVATE_POST_GENERATION_READ_DETAIL')
  })

  it('requires storage V2 and never falls back to an unconditional legacy save', () => {
    const { storage, generator } = createMocks()
    const legacySave = vi.fn()
    const legacy = { ...storage, contractVersion: 1, saveCandidateDraft: legacySave } as unknown as DraftStorageProvider
    expect(() => new AutonomousCreationExecutor({ storage: legacy, generator })).toThrow('AUTONOMOUS_STORAGE_CONTRACT_INVALID')
    expect(legacySave).not.toHaveBeenCalled()
    expect(generator.generateChapter).not.toHaveBeenCalled()
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
    expect(storage.compareAndSaveCandidate).toHaveBeenCalledTimes(prefix)
  })
})
