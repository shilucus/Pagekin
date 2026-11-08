import { describe, expect, it } from 'vitest'
import {
  ApprovalManifestCoordinator,
  type EditorRevisionProbeResult,
} from '../approval-manifest-coordinator'

describe('ApprovalManifestCoordinator', () => {
  const baseParams = {
    projectId: 'p-cord',
    sessionLeaseId: 'lease-101',
    scopeRange: { startChapter: 1, endChapter: 2 },
    items: [
      {
        draftId: 'd-1',
        chapterNumber: 1,
        version: 1,
        contentHash: '1'.repeat(64),
        preliminaryReportId: 'par-1',
      },
      {
        draftId: 'd-2',
        chapterNumber: 2,
        version: 1,
        contentHash: '2'.repeat(64),
        preliminaryReportId: 'par-2',
      },
    ],
    authorConfirmed: true,
  }

  it('prepares manifest and intercepts unauthorized clients', () => {
    const coordinator = new ApprovalManifestCoordinator()

    // 1. Missing scope
    const noScope = coordinator.prepareApprovalManifest(baseParams, 'task_run')
    expect(noScope.success).toBe(false)
    expect(noScope.error).toContain('缺少人审批准权限')

    // 2. Authorized
    const auth = coordinator.prepareApprovalManifest(baseParams, 'human_approval')
    expect(auth.success).toBe(true)
    expect(auth.manifest).toBeDefined()
  })

  it('performs clean editor handshake and freezes cleanly', async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const { manifest } = coordinator.prepareApprovalManifest(baseParams, 'human_approval')

    const probe = async (): Promise<EditorRevisionProbeResult> => ({
      connected: true,
      isDirty: false,
      revision: 1,
    })

    const result = await coordinator.performEditorHandshakeAndFreeze(manifest!.manifestId, probe)
    expect(result.success).toBe(true)
    expect(result.manifest.status).toBe('frozen')
    expect(Object.keys(result.manifest.frozenBuffers)).toHaveLength(0)
  })

  it('safely freezes dirty buffer snapshots during handshake without losing edits', async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const { manifest } = coordinator.prepareApprovalManifest(baseParams, 'human_approval')

    const probe = async (ch: number): Promise<EditorRevisionProbeResult> => {
      if (ch === 1) {
        return {
          connected: true,
          isDirty: true,
          dirtyContent: '第一章最新未保存段落',
          revision: 5,
        }
      }
      return { connected: true, isDirty: false, revision: 1 }
    }

    const result = await coordinator.performEditorHandshakeAndFreeze(manifest!.manifestId, probe)
    expect(result.success).toBe(true)
    expect(result.manifest.status).toBe('frozen')
    expect(result.manifest.frozenBuffers[1]).toBeDefined()
    expect(result.manifest.frozenBuffers[1].content).toBe('第一章最新未保存段落')
    expect(result.manifest.frozenBuffers[1].revision).toBe(5)
  })

  it('suspends to pending_author_action on editor disconnection or input conflict', async () => {
    const coordinator = new ApprovalManifestCoordinator()

    // 1. Disconnection
    const { manifest: m1 } = coordinator.prepareApprovalManifest(baseParams, 'human_approval')
    const disconnectedProbe = async (): Promise<EditorRevisionProbeResult> => ({
      connected: false,
      isDirty: false,
      revision: 1,
    })
    const res1 = await coordinator.performEditorHandshakeAndFreeze(m1!.manifestId, disconnectedProbe)
    expect(res1.success).toBe(false)
    expect(res1.manifest.status).toBe('pending_author_action')
    expect(res1.error).toContain('已断开连接')

    // 2. Concurrency conflict (author typing during handshake)
    const { manifest: m2 } = coordinator.prepareApprovalManifest(baseParams, 'human_approval')
    const conflictProbe = async (): Promise<EditorRevisionProbeResult> => ({
      connected: true,
      isDirty: true,
      hasConcurrencyConflict: true,
      revision: 2,
    })
    const res2 = await coordinator.performEditorHandshakeAndFreeze(m2!.manifestId, conflictProbe)
    expect(res2.success).toBe(false)
    expect(res2.manifest.status).toBe('pending_author_action')
    expect(res2.error).toContain('并发新输入')
  })

  it('demonstrates unfreeze-wins vs commit-wins concurrency resolution', async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const { manifest } = coordinator.prepareApprovalManifest(baseParams, 'human_approval')

    await coordinator.performEditorHandshakeAndFreeze(manifest!.manifestId, async () => ({
      connected: true,
      isDirty: false,
      revision: 1,
    }))
    expect(coordinator.getManifest(manifest!.manifestId)?.status).toBe('frozen')

    // Scenario A: Unfreeze wins before commit
    const unfreezeResult = coordinator.unfreezeManifest(manifest!.manifestId)
    expect(unfreezeResult.success).toBe(true)
    expect(coordinator.getManifest(manifest!.manifestId)?.status).toBe('unfrozen')

    // Scenario B: Commit wins
    const { manifest: m2 } = coordinator.prepareApprovalManifest(baseParams, 'human_approval')
    await coordinator.performEditorHandshakeAndFreeze(m2!.manifestId, async () => ({
      connected: true,
      isDirty: false,
      revision: 1,
    }))

    const commitResult = coordinator.markManifestCommitted(m2!.manifestId)
    expect(commitResult.success).toBe(true)
    expect(coordinator.getManifest(m2!.manifestId)?.status).toBe('committed')

    // Subsequent unfreeze attempt is rejected due to Commit Wins
    const lateUnfreeze = coordinator.unfreezeManifest(m2!.manifestId)
    expect(lateUnfreeze.success).toBe(false)
    expect(lateUnfreeze.error).toContain('提交先赢 (Commit wins)')
    expect(lateUnfreeze.error).toContain('ADR-0024')
  })
})
