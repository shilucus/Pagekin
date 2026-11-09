import { describe, expect, it, vi } from 'vitest'
import {
  createStreamSnapshotGuard,
  computeSnapshotTextHash,
  type StreamSnapshotEvent,
} from '../stream-snapshot-guard'
import type { MainGenerationSnapshot } from '../../../src/services/generation/generation-runtime'
import type { GenerationExecutionReceipt } from '../../repositories/generation-run-repository'

describe('Stream Snapshot Deduplication and Publish Guard (PERF-003)', () => {
  const mockReceipt = (attemptId: string, revision: number, text: string, status: 'running' | 'completed' | 'failed' | 'cancelled' = 'running'): GenerationExecutionReceipt => {
    return {
      attempt: {
        attemptId,
        runId: 'run-1',
        rootActionId: 'root-1',
        attemptNumber: 1,
        purpose: 'prose',
        phase: 'creation',
        status: 'settled',
        createdAt: 1000,
      },
      run: {
        runId: 'run-1',
        rootActionId: 'root-1',
        binding: {
          projectId: 'proj-1',
          epoch: 'epoch-1',
          authorRoot: 'C:/novel',
          fingerprint: {
            modelLeaseRevision: '1'.repeat(64),
            policyHash: '2'.repeat(64),
            createdAt: 1000,
          },
          sourceManifest: {
            schemaVersion: 1,
            operation: 'chapter-draft',
            chapterNumber: 1,
            authorEvidenceFingerprint: '3'.repeat(64),
            modelReceipt: {
              modelId: 'gpt-4o',
              modelRevision: '4'.repeat(64),
              issuedAt: 1000,
            },
          },
        },
      },
      artifact: {
        artifactId: `art-${attemptId}`,
        attemptId,
        revision,
        text,
        textHash: computeSnapshotTextHash(text),
        epoch: 'epoch-1',
        fingerprint: {
          modelLeaseRevision: '1'.repeat(64),
          policyHash: '2'.repeat(64),
          createdAt: 1000,
        },
        createdAt: 1000,
      },
      budget: {
        root: { status: 'active', rootActionId: 'root-1' },
        attempt: { status: 'active', attemptId },
      },
      result: status === 'running' ? null : { finishReason: 'stop', usage: null },
    } as unknown as GenerationExecutionReceipt
  }

  const mockSnapshotOf = (receipt: GenerationExecutionReceipt): MainGenerationSnapshot | null => {
    if (!receipt.artifact) return null
    return {
      projectId: receipt.run.binding.projectId,
      epoch: receipt.run.binding.epoch,
      rootActionId: receipt.run.rootActionId,
      runId: receipt.run.runId,
      artifactId: receipt.artifact.artifactId,
      attemptId: receipt.attempt.attemptId,
      revision: receipt.artifact.revision,
      durableRevision: receipt.artifact.revision,
      text: receipt.artifact.text,
      textHash: receipt.artifact.textHash,
      status: receipt.result ? 'completed' : 'running',
    }
  }

  it('suppresses duplicate receipt reads and full text publishing across high frequency token deltas', () => {
    const published: MainGenerationSnapshot[] = []
    let currentReceipt = mockReceipt('att-1', 1, '第一章 剑气。')
    const readReceipt = vi.fn(() => currentReceipt)
    const onPublish = vi.fn((snapshot: MainGenerationSnapshot) => {
      published.push(snapshot)
    })
    const recordReceipt = vi.fn()
    const recordPublish = vi.fn()

    const guard = createStreamSnapshotGuard({
      onPublish,
      readReceipt,
      snapshotOf: mockSnapshotOf,
      recordReceiptCall: recordReceipt,
      recordPublish,
    })

    // 1. First durable snapshot reaches disk (revision = 1)
    const event1: StreamSnapshotEvent = {
      attemptId: 'att-1',
      visibleText: '第一章 剑气。',
      durableText: '第一章 剑气。',
      durableRevision: 1,
      storageFailed: false,
    }
    const res1 = guard.handleStreamEvent(event1)
    expect(res1).not.toBeNull()
    expect(res1?.durableRevision).toBe(1)
    expect(onPublish).toHaveBeenCalledTimes(1)
    expect(readReceipt).toHaveBeenCalledTimes(1)
    expect(recordReceipt).toHaveBeenCalledTimes(1)
    expect(recordPublish).toHaveBeenCalledTimes(1)

    // 2. High-frequency streaming: 50 token deltas arrive, but durableRevision remains 1
    for (let i = 0; i < 50; i++) {
      const deltaEvent: StreamSnapshotEvent = {
        attemptId: 'att-1',
        visibleText: `第一章 剑气。${'风'.repeat(i + 1)}`,
        durableText: '第一章 剑气。', // durable snapshot not flushed yet
        durableRevision: 1,
        storageFailed: false,
      }
      const res = guard.handleStreamEvent(deltaEvent)
      expect(res).toBeNull() // Suppressed!
    }

    // Still exactly 1 read and 1 publish
    expect(readReceipt).toHaveBeenCalledTimes(1)
    expect(onPublish).toHaveBeenCalledTimes(1)
    const stats = guard.getStats('att-1')
    expect(stats?.suppressedCount).toBe(50)
    expect(stats?.publishedCount).toBe(1)
    expect(stats?.receiptReadCount).toBe(1)

    // 3. Next periodic flush occurs: durableRevision increments to 2
    currentReceipt = mockReceipt('att-1', 2, '第一章 剑气。风云激荡！')
    const flushEvent: StreamSnapshotEvent = {
      attemptId: 'att-1',
      visibleText: '第一章 剑气。风云激荡！',
      durableText: '第一章 剑气。风云激荡！',
      durableRevision: 2,
      storageFailed: false,
    }
    const res2 = guard.handleStreamEvent(flushEvent)
    expect(res2).not.toBeNull()
    expect(res2?.durableRevision).toBe(2)
    expect(res2?.text).toBe('第一章 剑气。风云激荡！')
    expect(readReceipt).toHaveBeenCalledTimes(2)
    expect(onPublish).toHaveBeenCalledTimes(2)
  })

  it('coalesces stream diagnostics during suppressed deltas and delivers them with next snapshot', () => {
    const published: MainGenerationSnapshot[] = []
    let currentReceipt = mockReceipt('att-2', 1, '开头')
    const readReceipt = vi.fn(() => currentReceipt)
    const onPublish = vi.fn((snapshot: MainGenerationSnapshot) => {
      published.push(snapshot)
    })

    const guard = createStreamSnapshotGuard({
      onPublish,
      readReceipt,
      snapshotOf: mockSnapshotOf,
    })

    // Initial snapshot
    guard.handleStreamEvent({
      attemptId: 'att-2',
      visibleText: '开头',
      durableText: '开头',
      durableRevision: 1,
      storageFailed: false,
      diagnostics: { elapsedMs: 120, firstResponseMs: 120 },
    })
    expect(published[0].diagnostics).toMatchObject({ elapsedMs: 120, firstResponseMs: 120 })

    // Delta 1 arrives with updated network diagnostics
    guard.handleStreamEvent({
      attemptId: 'att-2',
      visibleText: '开头增量1',
      durableText: '开头',
      durableRevision: 1,
      storageFailed: false,
      diagnostics: { elapsedMs: 250 },
    })

    // Delta 2 arrives with further diagnostics
    guard.handleStreamEvent({
      attemptId: 'att-2',
      visibleText: '开头增量2',
      durableText: '开头',
      durableRevision: 1,
      storageFailed: false,
      diagnostics: { elapsedMs: 380 },
    })

    // Both were suppressed
    expect(published.length).toBe(1)

    // Flush revision 2 arrives without explicit diagnostics in event
    currentReceipt = mockReceipt('att-2', 2, '开头落盘')
    guard.handleStreamEvent({
      attemptId: 'att-2',
      visibleText: '开头落盘',
      durableText: '开头落盘',
      durableRevision: 2,
      storageFailed: false,
    })

    expect(published.length).toBe(2)
    // The coalesced diagnostics (elapsedMs: 380, firstResponseMs: 120) are delivered!
    expect(published[1].diagnostics).toMatchObject({ elapsedMs: 380, firstResponseMs: 120 })
  })

  it('ensures terminal completion snapshot is merged with coalesced diagnostics', () => {
    const published: MainGenerationSnapshot[] = []
    const currentReceipt = mockReceipt('att-3', 1, '终章。', 'completed')
    const onPublish = vi.fn((snapshot: MainGenerationSnapshot) => {
      published.push(snapshot)
    })

    const guard = createStreamSnapshotGuard({
      onPublish,
      readReceipt: () => currentReceipt,
      snapshotOf: mockSnapshotOf,
    })

    // Initial snapshot at revision 1
    guard.handleStreamEvent({
      attemptId: 'att-3',
      visibleText: '终章。',
      durableText: '终章。',
      durableRevision: 1,
      storageFailed: false,
      diagnostics: { elapsedMs: 100 },
    })

    // Delta with diagnostics (suppressed)
    guard.handleStreamEvent({
      attemptId: 'att-3',
      visibleText: '终章。',
      durableText: '终章。',
      durableRevision: 1,
      storageFailed: false,
      diagnostics: { elapsedMs: 500, endReason: 'completed' },
    })

    // Settle terminal receipt: must merge coalesced diagnostics
    const rawSnapshot = mockSnapshotOf(currentReceipt)!
    const terminal = guard.mergeTerminalDiagnostics(rawSnapshot)
    expect(terminal).not.toBeNull()
    expect(terminal.status).toBe('completed')
    expect(terminal.diagnostics).toMatchObject({ elapsedMs: 500, endReason: 'completed' })
  })

  it('drops out-of-order revision regression safely', () => {
    const published: MainGenerationSnapshot[] = []
    const guard = createStreamSnapshotGuard({
      onPublish: snapshot => published.push(snapshot),
      readReceipt: () => mockReceipt('att-4', 5, '内容'),
      snapshotOf: mockSnapshotOf,
    })

    guard.handleStreamEvent({
      attemptId: 'att-4',
      visibleText: '内容',
      durableText: '内容',
      durableRevision: 5,
      storageFailed: false,
    })
    expect(published.length).toBe(1)

    // Regressive revision event arriving out of order is dropped safely
    const res = guard.handleStreamEvent({
      attemptId: 'att-4',
      visibleText: '旧内容',
      durableText: '旧内容',
      durableRevision: 3,
      storageFailed: false,
    })
    expect(res).toBeNull()
    expect(published.length).toBe(1)
  })

  it('intercepts divergent text on identical durable revision as anomaly', () => {
    const published: MainGenerationSnapshot[] = []
    const guard = createStreamSnapshotGuard({
      onPublish: snapshot => published.push(snapshot),
      readReceipt: () => mockReceipt('att-divergent', 1, '权威正文内容'),
      snapshotOf: mockSnapshotOf,
    })

    // 1. Initial publication of revision 1
    guard.handleStreamEvent({
      attemptId: 'att-divergent',
      visibleText: '权威正文内容',
      durableText: '权威正文内容',
      durableRevision: 1,
      storageFailed: false,
    })
    expect(published.length).toBe(1)

    // 2. Normal duplicate delta (same durableText) -> increments suppressedCount
    guard.handleStreamEvent({
      attemptId: 'att-divergent',
      visibleText: '权威正文内容+追加',
      durableText: '权威正文内容',
      durableRevision: 1,
      storageFailed: false,
    })
    expect(guard.getStats('att-divergent')?.suppressedCount).toBe(1)
    expect(guard.getStats('att-divergent')?.divergentCount).toBe(0)

    // 3. Abnormal divergent text with identical durableRevision -> intercepted by defense!
    const divergentRes = guard.handleStreamEvent({
      attemptId: 'att-divergent',
      visibleText: '篡改正文',
      durableText: '篡改的正文内容（不同于权威内容）',
      durableRevision: 1,
      storageFailed: false,
    })
    expect(divergentRes).toBeNull()
    expect(published.length).toBe(1) // Not published
    expect(guard.getStats('att-divergent')?.suppressedCount).toBe(1) // Not counted as normal suppression
    expect(guard.getStats('att-divergent')?.divergentCount).toBe(1) // Correctly identified as divergence
  })

  it('strictly rejects non-advancing database read (snapshot.durableRevision <= lastPublishedRevision)', () => {
    const published: MainGenerationSnapshot[] = []
    // Database returns snapshot still at revision 1 even though event claimed revision 2
    const stagnantReceipt = mockReceipt('att-stagnant', 1, '停滞内容')
    const guard = createStreamSnapshotGuard({
      onPublish: snapshot => published.push(snapshot),
      readReceipt: () => stagnantReceipt,
      snapshotOf: mockSnapshotOf,
    })

    // First publish at revision 1
    guard.handleStreamEvent({
      attemptId: 'att-stagnant',
      visibleText: '停滞内容',
      durableText: '停滞内容',
      durableRevision: 1,
      storageFailed: false,
    })
    expect(published.length).toBe(1)

    // Event claims revision 2, but DB read still returns revision 1
    const res = guard.handleStreamEvent({
      attemptId: 'att-stagnant',
      visibleText: '新内容',
      durableText: '新内容',
      durableRevision: 2,
      storageFailed: false,
    })
    expect(res).toBeNull()
    expect(published.length).toBe(1) // Secondary duplicate was blocked by strict <=
  })

  it('marks storage failure without publishing invalid speculative snapshot', () => {
    const onPublish = vi.fn()
    const guard = createStreamSnapshotGuard({
      onPublish,
      readReceipt: () => mockReceipt('att-6', 1, '文本'),
      snapshotOf: mockSnapshotOf,
    })

    const res = guard.handleStreamEvent({
      attemptId: 'att-6',
      visibleText: '未落盘文本',
      durableText: '',
      durableRevision: 0,
      storageFailed: true,
    })

    expect(res).toBeNull()
    expect(onPublish).not.toHaveBeenCalled()
    expect(guard.getStats('att-6')?.storageFailed).toBe(true)
  })

  it('preserves the stored hash when the durable text does not match it', () => {
    const receipt = mockReceipt('att-hash', 1, 'stored text')
    receipt.artifact!.textHash = computeSnapshotTextHash('different text')
    const onPublish = vi.fn()
    const guard = createStreamSnapshotGuard({ onPublish, readReceipt: () => receipt, snapshotOf: mockSnapshotOf })

    const result = guard.handleStreamEvent({
      attemptId: 'att-hash', visibleText: 'stored text', durableText: 'stored text', durableRevision: 1, storageFailed: false,
    })

    expect(result?.textHash).toBe(receipt.artifact!.textHash)
    expect(result?.textHash).not.toBe(computeSnapshotTextHash('stored text'))
    expect(onPublish).toHaveBeenCalledWith(result)
  })
})
