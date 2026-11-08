import { describe, expect, it } from 'vitest'
import {
  assembleAdmissionReceipt,
  validateAdmissionForFinalization,
} from '../finalization-admission-contract'
import { createApprovalManifest } from '../approval-manifest-contract'

describe('finalization-admission-contract', () => {
  const baseManifest = createApprovalManifest({
    projectId: 'p-1',
    sessionLeaseId: 'l-1',
    scopeRange: { startChapter: 1, endChapter: 2 },
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
  })

  it('rejects when manifest is not frozen', () => {
    // Draft status
    const check = validateAdmissionForFinalization(baseManifest, 1, 'a'.repeat(64))
    expect(check.valid).toBe(false)
    expect(check.reason).toContain('清单状态非法 [draft]')
  })

  it('validates correctly when manifest is frozen and hash matches', () => {
    const frozenManifest = { ...baseManifest, status: 'frozen' as const }
    const check = validateAdmissionForFinalization(frozenManifest, 1, 'a'.repeat(64))
    expect(check.valid).toBe(true)
  })

  it('rejects when chapter is missing or content hash mismatches', () => {
    const frozenManifest = { ...baseManifest, status: 'frozen' as const }

    // Missing chapter
    const missingCh = validateAdmissionForFinalization(frozenManifest, 99, 'a'.repeat(64))
    expect(missingCh.valid).toBe(false)
    expect(missingCh.reason).toContain('未找到第 99 章')

    // Mismatched hash
    const mismatch = validateAdmissionForFinalization(frozenManifest, 1, 'c'.repeat(64))
    expect(mismatch.valid).toBe(false)
    expect(mismatch.reason).toContain('内容哈希不匹配')
  })

  it('assembles deterministic admission receipts with identical ids for same business inputs', () => {
    const params = {
      manifestId: 'amf-1',
      draftId: 'd-1',
      chapterNumber: 1,
      finalizationId: 'fin-1',
      contentHash: 'a'.repeat(64),
      committed: true,
      publicationStatus: 'projected' as const,
      transition: 'finalized' as const,
    }

    const r1 = assembleAdmissionReceipt(params)
    const r2 = assembleAdmissionReceipt(params)

    expect(r1.receiptId).toBe(r2.receiptId)
    expect(r1.receiptId.startsWith('far-')).toBe(true)
    expect(r1.chapterNumber).toBe(1)
    expect(r1.committed).toBe(true)
    expect(r1.publicationStatus).toBe('projected')
  })
})
