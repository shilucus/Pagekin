import { describe, expect, it, vi } from 'vitest'
import {
  FinalizationAdmissionExecutor,
  type FinalizationCommitHandler,
} from '../finalization-admission-executor'
import { ApprovalManifestCoordinator } from '../approval-manifest-coordinator'
import { computeBufferHash } from '../../../src/shared/approval-manifest-contract'

describe('FinalizationAdmissionExecutor', () => {
  const ch1Text = '第一章 正文'
  const ch2Text = '第二章 正文'
  const ch1Hash = computeBufferHash(ch1Text)
  const ch2Hash = computeBufferHash(ch2Text)

  const setupCoordinatorAndManifest = async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const { manifest } = coordinator.prepareApprovalManifest(
      {
        projectId: 'p-exec',
        sessionLeaseId: 'l-1',
        scopeRange: { startChapter: 1, endChapter: 2 },
        items: [
          {
            draftId: 'd-1',
            chapterNumber: 1,
            version: 1,
            contentHash: ch1Hash,
            preliminaryReportId: 'par-1',
          },
          {
            draftId: 'd-2',
            chapterNumber: 2,
            version: 1,
            contentHash: ch2Hash,
            preliminaryReportId: 'par-2',
          },
        ],
        authorConfirmed: true,
      },
      'human_approval',
    )

    // Handshake to frozen
    await coordinator.performEditorHandshakeAndFreeze(manifest!.manifestId, async () => ({
      connected: true,
      isDirty: false,
      revision: 1,
    }))

    return { coordinator, manifest: manifest! }
  }

  it('executes batch finalization in chapter order and generates independent receipts', async () => {
    const { coordinator, manifest } = await setupCoordinatorAndManifest()

    const commitChapter = vi.fn(async (params: { chapterNumber: number }) => {
      return {
        success: true,
        committed: true,
        finalizationId: `fin-${params.chapterNumber}`,
        publicationStatus: 'projected' as const,
      }
    })

    const handler: FinalizationCommitHandler = { commitChapter }
    const executor = new FinalizationAdmissionExecutor(coordinator, handler)

    const fetcher = async (ch: number) => {
      return {
        title: `第 ${ch} 章`,
        content: ch === 1 ? ch1Text : ch2Text,
        revision: 1,
      }
    }

    const progress = await executor.executeBatchFinalization(manifest.manifestId, fetcher)
    expect(progress.status).toBe('completed')
    expect(progress.completedCount).toBe(2)
    expect(progress.failedCount).toBe(0)
    expect(progress.receipts).toHaveLength(2)
    expect(progress.receipts[0].chapterNumber).toBe(1)
    expect(progress.receipts[1].chapterNumber).toBe(2)
    expect(commitChapter).toHaveBeenCalledTimes(2)

    // Manifest marked committed in coordinator
    expect(coordinator.getManifest(manifest.manifestId)?.status).toBe('committed')

    // Idempotency: re-running on committed manifest returns completed progress cleanly
    const reRun = await executor.executeBatchFinalization(manifest.manifestId, fetcher)
    expect(reRun.status).toBe('completed')
    expect(commitChapter).toHaveBeenCalledTimes(2) // No extra commits!
  })

  it('demonstrates non-fake-ACID: chapter 1 fact is preserved when chapter 2 fails', async () => {
    const { coordinator, manifest } = await setupCoordinatorAndManifest()

    const commitChapter = vi.fn(async (params: { chapterNumber: number }) => {
      if (params.chapterNumber === 1) {
        return {
          success: true,
          committed: true,
          finalizationId: 'fin-1',
          publicationStatus: 'projected' as const,
        }
      }
      return {
        success: false,
        committed: false,
        publicationStatus: 'failed' as const,
        error: 'Database disk full or constraint violation',
      }
    })

    const handler: FinalizationCommitHandler = { commitChapter }
    const executor = new FinalizationAdmissionExecutor(coordinator, handler)

    const fetcher = async (ch: number) => ({
      title: `第 ${ch} 章`,
      content: ch === 1 ? ch1Text : ch2Text,
      revision: 1,
    })

    const progress = await executor.executeBatchFinalization(manifest.manifestId, fetcher)
    expect(progress.status).toBe('partially_failed')
    expect(progress.completedCount).toBe(1)
    expect(progress.failedCount).toBe(1)
    // Chapter 1 receipt is intact and committed!
    expect(progress.receipts).toHaveLength(1)
    expect(progress.receipts[0].chapterNumber).toBe(1)
    expect(progress.receipts[0].committed).toBe(true)
    expect(progress.failureReason).toContain('第 2 章定稿事务失败')
  })

  it('prevents false completion when earlier chapters have pending projections', async () => {
    const { coordinator, manifest } = await setupCoordinatorAndManifest()

    // Ch 1 committed with pending projection, Ch 2 projected
    let ch1Calls = 0
    const commitChapter = vi.fn(async (params: { chapterNumber: number }) => {
      if (params.chapterNumber === 1) {
        ch1Calls += 1
        return {
          success: false,
          committed: true,
          finalizationId: 'fin-1',
          publicationStatus: 'pending' as const,
          error: 'Outbox disk latency',
        }
      }
      return {
        success: true,
        committed: true,
        finalizationId: 'fin-2',
        publicationStatus: 'projected' as const,
      }
    })

    const handler: FinalizationCommitHandler = { commitChapter }
    const executor = new FinalizationAdmissionExecutor(coordinator, handler)

    const fetcher = async (ch: number) => ({
      title: `第 ${ch} 章`,
      content: ch === 1 ? ch1Text : ch2Text,
      revision: 1,
    })

    // Step 1: Run Ch 1 -> fails projection -> status partially_failed
    const step1 = await executor.executeBatchFinalization(manifest.manifestId, fetcher)
    expect(step1.status).toBe('partially_failed')
    expect(step1.completedCount).toBe(1)
    expect(step1.receipts[0].publicationStatus).toBe('pending')

    // Step 2: Resume -> Ch 1 is skipped (already committed), Ch 2 commits and projects
    // BUT batch must NOT be marked completed because Ch 1 projection is still pending!
    const step2 = await executor.executeBatchFinalization(manifest.manifestId, fetcher)
    expect(step2.status).toBe('partially_failed')
    expect(step2.completedCount).toBe(2)
    expect(step2.failureReason).toContain('第 1 章实体投影处于 [pending] 状态')
    expect(coordinator.getManifest(manifest.manifestId)?.status).toBe('frozen') // Not marked committed!
    expect(ch1Calls).toBe(1) // No duplicate commit for Ch 1!

    // Step 3: Now retry projection for Ch 1
    const publisher = vi.fn(async () => true)
    const step3 = await executor.retryFailedProjections(manifest.manifestId, publisher)
    expect(step3.status).toBe('completed')
    expect(step3.failedCount).toBe(0)
    expect(step3.receipts[0].publicationStatus).toBe('projected')
    expect(coordinator.getManifest(manifest.manifestId)?.status).toBe('committed')
  })

  it('handles chapter fetcher exceptions safely without leaving dangling progress', async () => {
    const { coordinator, manifest } = await setupCoordinatorAndManifest()

    const commitChapter = vi.fn(async () => ({
      success: true,
      committed: true,
      finalizationId: 'fin-1',
      publicationStatus: 'projected' as const,
    }))

    const handler: FinalizationCommitHandler = { commitChapter }
    const executor = new FinalizationAdmissionExecutor(coordinator, handler)

    const crashingFetcher = async (ch: number) => {
      if (ch === 2) {
        throw new Error('Disk read timeout')
      }
      return {
        title: `第 ${ch} 章`,
        content: ch1Text,
        revision: 1,
      }
    }

    const progress = await executor.executeBatchFinalization(manifest.manifestId, crashingFetcher)
    expect(progress.status).toBe('partially_failed')
    expect(progress.completedCount).toBe(1)
    expect(progress.failedCount).toBe(1)
    expect(progress.failureReason).toContain('读取第 2 章草稿发生异常: Disk read timeout')
    expect(progress.receipts).toHaveLength(1)
    expect(progress.receipts[0].chapterNumber).toBe(1)
  })
})
