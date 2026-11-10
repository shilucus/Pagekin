import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeBufferHash } from '../../../src/shared/approval-manifest-contract'
import {
  ApprovalManifestCoordinator,
  type EditorRevisionProbeResult,
} from '../approval-manifest-coordinator'

describe('ApprovalManifestCoordinator', () => {
  afterEach(() => vi.restoreAllMocks())

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }

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

  function invalidate(coordinator: ApprovalManifestCoordinator, manifestId: string, action: 'unfreeze' | 'clear' | 'replace') {
    if (action === 'unfreeze') expect(coordinator.unfreezeManifest(manifestId).success).toBe(true)
    else if (action === 'clear') coordinator.clearProjectManifests(baseParams.projectId)
    else {
      const replacement = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
      expect(replacement.manifestId).toBe(manifestId)
    }
    return coordinator.getManifest(manifestId)
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
      dirtyContent: 'Fictional conflicting input',
      hasConcurrencyConflict: true,
      revision: 2,
    })
    const res2 = await coordinator.performEditorHandshakeAndFreeze(m2!.manifestId, conflictProbe)
    expect(res2.success).toBe(false)
    expect(res2.manifest.status).toBe('pending_author_action')
    expect(res2.error).toContain('并发新输入')
  })

  it.each(['disconnect', 'conflict'] as const)('preserves current dirty input before suspending approval for %s', async outcome => {
    const coordinator = new ApprovalManifestCoordinator()
    const manifest = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const content = 'Fictional current author input'
    const probe = vi.fn(async (): Promise<EditorRevisionProbeResult> => ({
      connected: outcome !== 'disconnect', isDirty: true, dirtyContent: content, revision: 9,
      hasConcurrencyConflict: outcome === 'conflict',
    }))

    const result = await coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, probe)

    expect(result.success).toBe(false)
    expect(result.manifest).toBe(manifest)
    expect(coordinator.getManifest(manifest.manifestId)).toBe(manifest)
    expect(manifest.status).toBe('pending_author_action')
    expect(result.error).toContain(outcome === 'disconnect' ? '已断开连接' : '并发新输入')
    expect(manifest.frozenBuffers[1]).toMatchObject({
      content, revision: 9, bufferHash: computeBufferHash(content), chapterNumber: 1,
    })
    expect(probe).toHaveBeenCalledExactlyOnceWith(1)
    expect(manifest.frozenBuffers[2]).toBeUndefined()
    expect(coordinator.markManifestCommitted(manifest.manifestId).success).toBe(false)
    expect(manifest.status).toBe('pending_author_action')
  })

  it('suspends approval when dirty editor content is unavailable', async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const manifest = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const probe = vi.fn(async (): Promise<EditorRevisionProbeResult> => ({
      connected: true, isDirty: true, revision: 9,
    }))

    const result = await coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, probe)

    expect(result).toMatchObject({ success: false, error: 'EDITOR_HANDSHAKE_BUFFER_UNAVAILABLE',
      manifest: { status: 'pending_author_action', pendingReason: 'EDITOR_HANDSHAKE_BUFFER_UNAVAILABLE' } })
    expect(result.manifest).toBe(manifest)
    expect(coordinator.getManifest(manifest.manifestId)).toBe(manifest)
    expect(manifest.frozenBuffers).toEqual({})
    expect(probe).toHaveBeenCalledExactlyOnceWith(1)
    expect(coordinator.markManifestCommitted(manifest.manifestId).success).toBe(false)
    expect(manifest.status).toBe('pending_author_action')
  })

  it('seals an explicitly empty dirty buffer and permits a valid freeze', async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const manifest = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const probe = vi.fn(async (chapter: number): Promise<EditorRevisionProbeResult> => chapter === 1
      ? { connected: true, isDirty: true, dirtyContent: '', revision: 10 }
      : { connected: true, isDirty: false, revision: 1 })

    const result = await coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, probe)

    expect(result.success).toBe(true)
    expect(result.manifest).toBe(manifest)
    expect(coordinator.getManifest(manifest.manifestId)).toBe(manifest)
    expect(manifest.status).toBe('frozen')
    expect(manifest.frozenBuffers[1]).toMatchObject({ chapterNumber: 1, content: '', revision: 10, bufferHash: computeBufferHash('') })
    expect(probe.mock.calls).toEqual([[1], [2]])
    expect(coordinator.markManifestCommitted(manifest.manifestId).success).toBe(true)
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

  it.each(
    (['unfreeze', 'clear', 'replace'] as const).flatMap(action =>
      (['clean', 'dirty', 'disconnect', 'conflict', 'throw'] as const).map(outcome => [action, outcome] as const)),
  )('keeps %s canonical state unchanged after a late %s probe', async (action, outcome) => {
    // Fixed synthetic time deliberately exercises the existing same-ID replacement behavior.
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const coordinator = new ApprovalManifestCoordinator()
    const manifest = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const late = deferred<EditorRevisionProbeResult>()
    const probe = vi.fn(() => late.promise)
    const pending = coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, probe)
    const canonical = invalidate(coordinator, manifest.manifestId, action)
    const originalSnapshot = structuredClone(manifest)
    const canonicalSnapshot = structuredClone(canonical)

    if (outcome === 'throw') late.reject(new Error('FICTIONAL_PRIVATE_PROBE_DETAIL'))
    else late.resolve({
      connected: outcome !== 'disconnect', isDirty: outcome !== 'clean',
      dirtyContent: outcome === 'clean' ? undefined : 'Fictional late author input', revision: 5,
      hasConcurrencyConflict: outcome === 'conflict',
    })
    const result = await pending

    expect(probe).toHaveBeenCalledExactlyOnceWith(1)
    expect(result).toMatchObject({ success: false, error: 'EDITOR_HANDSHAKE_INVALIDATED',
      manifest: { status: 'pending_author_action', pendingReason: 'EDITOR_HANDSHAKE_INVALIDATED' } })
    expect(coordinator.getManifest(manifest.manifestId)).toBe(canonical)
    expect(coordinator.getManifest(manifest.manifestId)).toEqual(canonicalSnapshot)
    expect(manifest).toEqual(originalSnapshot)
    expect(result.manifest).not.toBe(manifest)
    expect(result.manifest.items).not.toBe(manifest.items)
    expect(result.manifest.frozenBuffers).not.toBe(manifest.frozenBuffers)
    if (outcome !== 'clean' && outcome !== 'throw') {
      expect(result.manifest.frozenBuffers[1]).toMatchObject({ content: 'Fictional late author input', revision: 5 })
    } else expect(result.manifest.frozenBuffers).toEqual({})
    expect(JSON.stringify(result)).not.toContain('FICTIONAL_PRIVATE_PROBE_DETAIL')
  })

  it.each(['unfreeze', 'clear', 'replace'] as const)('retains first sealed input and detaches late second-chapter input after %s', async action => {
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const coordinator = new ApprovalManifestCoordinator()
    const manifest = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const secondEntered = deferred<void>(), second = deferred<EditorRevisionProbeResult>()
    const probe = vi.fn(async (chapter: number) => {
      if (chapter === 1) return { connected: true, isDirty: true, dirtyContent: 'Fictional first input', revision: 2 }
      secondEntered.resolve()
      return second.promise
    })
    const pending = coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, probe)
    await secondEntered.promise
    const canonical = invalidate(coordinator, manifest.manifestId, action)
    const originalSnapshot = structuredClone(manifest), canonicalSnapshot = structuredClone(canonical)
    second.resolve({ connected: true, isDirty: true, dirtyContent: 'Fictional second input', revision: 3 })
    const result = await pending

    expect(probe.mock.calls).toEqual([[1], [2]])
    expect(result.success).toBe(false)
    expect(result.error).toBe('EDITOR_HANDSHAKE_INVALIDATED')
    expect(manifest).toEqual(originalSnapshot)
    expect(manifest.frozenBuffers[1].content).toBe('Fictional first input')
    expect(manifest.frozenBuffers[2]).toBeUndefined()
    expect(coordinator.getManifest(manifest.manifestId)).toBe(canonical)
    expect(coordinator.getManifest(manifest.manifestId)).toEqual(canonicalSnapshot)
    expect(result.manifest.frozenBuffers[1]).toMatchObject({ content: 'Fictional first input', revision: 2 })
    expect(result.manifest.frozenBuffers[2]).toMatchObject({ content: 'Fictional second input', revision: 3 })
    expect(result.manifest.frozenBuffers[1]).not.toBe(manifest.frozenBuffers[1])
  })

  it('rejects concurrent duplicate handshakes without probing or interrupting the active handshake', async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const manifest = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const first = deferred<EditorRevisionProbeResult>()
    const probe = vi.fn((chapter: number) => chapter === 1 ? first.promise
      : Promise.resolve({ connected: true, isDirty: false, revision: 1 }))
    const duplicateProbe = vi.fn(async () => ({ connected: true, isDirty: false, revision: 1 }))
    const pending = coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, probe)
    const beforeDuplicate = structuredClone(manifest)
    const duplicate = await coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, duplicateProbe)
    expect(duplicate).toMatchObject({ success: false, error: 'EDITOR_HANDSHAKE_IN_PROGRESS' })
    expect(duplicateProbe).not.toHaveBeenCalled()
    expect(manifest).toEqual(beforeDuplicate)

    first.resolve({ connected: true, isDirty: true, dirtyContent: 'Fictional valid input', revision: 4 })
    const result = await pending
    expect(result.success).toBe(true)
    expect(result.manifest).toBe(coordinator.getManifest(manifest.manifestId))
    expect(result.manifest.status).toBe('frozen')
    expect(result.manifest.frozenBuffers[1]).toMatchObject({ content: 'Fictional valid input', revision: 4 })
    expect(probe.mock.calls).toEqual([[1], [2]])
  })

  it('does not let the old handshake release a replacement handshake token', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const coordinator = new ApprovalManifestCoordinator()
    const original = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const oldProbeResult = deferred<EditorRevisionProbeResult>(), newProbeResult = deferred<EditorRevisionProbeResult>()
    const oldProbe = vi.fn(() => oldProbeResult.promise)
    const oldPending = coordinator.performEditorHandshakeAndFreeze(original.manifestId, oldProbe)
    const replacement = invalidate(coordinator, original.manifestId, 'replace')!
    const newProbe = vi.fn((chapter: number) => chapter === 1 ? newProbeResult.promise
      : Promise.resolve({ connected: true, isDirty: false, revision: 1 }))
    const newPending = coordinator.performEditorHandshakeAndFreeze(replacement.manifestId, newProbe)
    const replacementSnapshot = structuredClone(replacement)

    oldProbeResult.resolve({ connected: true, isDirty: true, dirtyContent: 'Fictional old input', revision: 7 })
    const oldResult = await oldPending
    expect(oldResult.success).toBe(false)
    expect(oldResult.manifest.frozenBuffers[1].content).toBe('Fictional old input')
    expect(oldProbe).toHaveBeenCalledExactlyOnceWith(1)
    expect(replacement).toEqual(replacementSnapshot)
    const thirdProbe = vi.fn(async () => ({ connected: true, isDirty: false, revision: 1 }))
    expect(await coordinator.performEditorHandshakeAndFreeze(replacement.manifestId, thirdProbe))
      .toMatchObject({ success: false, error: 'EDITOR_HANDSHAKE_IN_PROGRESS' })
    expect(thirdProbe).not.toHaveBeenCalled()

    newProbeResult.resolve({ connected: true, isDirty: false, revision: 1 })
    const newResult = await newPending
    expect(newResult).toMatchObject({ success: true, manifest: { status: 'frozen', frozenBuffers: {} } })
    expect(newResult.manifest).toBe(replacement)
    expect(coordinator.getManifest(original.manifestId)).toBe(replacement)
    expect(newProbe.mock.calls).toEqual([[1], [2]])
  })

  it('turns a current probe exception into a fixed pending-author-action diagnostic', async () => {
    const coordinator = new ApprovalManifestCoordinator()
    const manifest = coordinator.prepareApprovalManifest(baseParams, 'human_approval').manifest!
    const probe = vi.fn(async () => { throw new Error('FICTIONAL_PRIVATE_PROBE_DETAIL') })
    const result = await coordinator.performEditorHandshakeAndFreeze(manifest.manifestId, probe)
    expect(result).toMatchObject({ success: false, error: 'EDITOR_HANDSHAKE_PROBE_FAILED',
      manifest: { status: 'pending_author_action', pendingReason: 'EDITOR_HANDSHAKE_PROBE_FAILED' } })
    expect(result.manifest).toBe(manifest)
    expect(coordinator.getManifest(manifest.manifestId)).toBe(manifest)
    expect(probe).toHaveBeenCalledExactlyOnceWith(1)
    expect(JSON.stringify(result)).not.toContain('FICTIONAL_PRIVATE_PROBE_DETAIL')
  })
})
