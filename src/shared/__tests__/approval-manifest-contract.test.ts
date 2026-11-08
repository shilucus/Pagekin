import { describe, expect, it } from 'vitest'
import {
  canUnfreezeManifest,
  computeBufferHash,
  createApprovalManifest,
  mergeEditorBufferSnapshot,
  validateApprovalManifest,
  type ApprovalManifest,
} from '../approval-manifest-contract'

describe('approval-manifest-contract', () => {
  const validParams = {
    projectId: 'p-1',
    sessionLeaseId: 'lease-100',
    scopeRange: { startChapter: 1, endChapter: 3 },
    items: [
      {
        draftId: 'd-1',
        chapterNumber: 1,
        version: 1,
        contentHash: 'a'.repeat(64),
        preliminaryReportId: 'par-1',
      },
      {
        draftId: 'd-2',
        chapterNumber: 2,
        version: 1,
        contentHash: 'b'.repeat(64),
        preliminaryReportId: 'par-2',
      },
    ],
    authorConfirmed: true,
  }

  it('computes buffer hash consistently', () => {
    const h1 = computeBufferHash('editor buffer text')
    const h2 = computeBufferHash('editor buffer text')
    expect(h1).toHaveLength(64)
    expect(h1).toBe(h2)
  })

  it('creates approval manifest with draft status', () => {
    const manifest = createApprovalManifest(validParams)
    expect(manifest.manifestId.startsWith('amf-')).toBe(true)
    expect(manifest.status).toBe('draft')
    expect(manifest.items).toHaveLength(2)
    expect(manifest.authorConfirmed).toBe(true)
  })

  it('validates client scope and author confirmation gate', () => {
    const manifest = createApprovalManifest(validParams)

    // Missing human_approval scope
    const noScope = validateApprovalManifest(manifest, 'read,write')
    expect(noScope.valid).toBe(false)
    expect(noScope.reason).toContain('缺少人审批准权限')

    // Valid with human_approval
    const valid = validateApprovalManifest(manifest, 'project:edit,human_approval')
    expect(valid.valid).toBe(true)

    // Author not confirmed
    const unconfirmedManifest: ApprovalManifest = { ...manifest, authorConfirmed: false }
    const unconfirmedCheck = validateApprovalManifest(unconfirmedManifest, 'human_approval')
    expect(unconfirmedCheck.valid).toBe(false)
    expect(unconfirmedCheck.reason).toContain('作者尚未确认')
  })

  it('validates scope range and report references', () => {
    // Out of scope chapter
    const outOfRange = createApprovalManifest({
      ...validParams,
      items: [
        {
          draftId: 'd-99',
          chapterNumber: 99,
          version: 1,
          contentHash: 'c'.repeat(64),
          preliminaryReportId: 'par-99',
        },
      ],
    })
    const rangeCheck = validateApprovalManifest(outOfRange, 'human_approval')
    expect(rangeCheck.valid).toBe(false)
    expect(rangeCheck.reason).toContain('清单条目越界')

    // Missing preliminary report
    const noReport = createApprovalManifest({
      ...validParams,
      items: [
        {
          draftId: 'd-1',
          chapterNumber: 1,
          version: 1,
          contentHash: 'd'.repeat(64),
          preliminaryReportId: '',
        },
      ],
    })
    const reportCheck = validateApprovalManifest(noReport, 'human_approval')
    expect(reportCheck.valid).toBe(false)
    expect(reportCheck.reason).toContain('缺少前置初验报告')
  })

  it('enforces unfreeze-wins vs commit-wins model', () => {
    const manifest = createApprovalManifest(validParams)

    // Can unfreeze when not committed
    manifest.status = 'frozen'
    expect(canUnfreezeManifest(manifest).allowed).toBe(true)

    // Commit wins: cannot unfreeze directly once committed
    manifest.status = 'committed'
    const committedCheck = canUnfreezeManifest(manifest)
    expect(committedCheck.allowed).toBe(false)
    expect(committedCheck.reason).toContain('提交先赢 (Commit wins)')
    expect(committedCheck.reason).toContain('ADR-0024')
  })

  it('merges frozen editor buffer snapshots safely', () => {
    const manifest = createApprovalManifest(validParams)
    const buffer = {
      chapterNumber: 1,
      bufferHash: computeBufferHash('dirty unsaved draft'),
      content: 'dirty unsaved draft',
      revision: 4,
      timestamp: Date.now(),
    }

    const updated = mergeEditorBufferSnapshot(manifest, buffer)
    expect(updated.frozenBuffers[1]).toEqual(buffer)
  })
})
