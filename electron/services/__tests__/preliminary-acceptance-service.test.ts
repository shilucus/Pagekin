import { describe, expect, it } from 'vitest'
import { PreliminaryAcceptanceService } from '../preliminary-acceptance-service'
import { computeContentHash } from '../../../src/shared/preliminary-acceptance-contract'

describe('PreliminaryAcceptanceService', () => {
  it('records, queries, and validates human review admission eligibility', () => {
    const service = new PreliminaryAcceptanceService()
    const content = '第二章 天剑出鞘。剑气纵横三万里，一剑光寒十九洲。'
    const contentHash = computeContentHash(content)

    const query = {
      projectId: 'proj-test',
      targetType: 'chapter' as const,
      targetId: 'ch-2',
    }

    // 1. Before evaluation: no report found
    const preCheck = service.verifyAdmissionEligibility(query, contentHash, 1)
    expect(preCheck.eligible).toBe(false)
    expect(preCheck.reason).toContain('未找到初验报告')

    // 2. Record clean evaluation
    const report = service.evaluateAndRecord({
      projectId: 'proj-test',
      targetType: 'chapter',
      targetId: 'ch-2',
      targetVersion: 1,
      content,
      sourceOrigin: 'generation',
      executionInput: { receiptId: 'rcpt-test', evidenceAvailable: true },
      scopeInput: {
        targetRange: { startChapter: 1, endChapter: 5 },
        modifiedEntities: [{ id: 'ch-2', type: 'chapter' }],
        evidenceAvailable: true,
      },
      qualityInput: {
        wordCountMin: 10,
        evidenceAvailable: true,
      },
    })

    expect(report.overallStatus).toBe('pass')
    expect(service.getLatestReport(query)).toEqual(report)

    // 3. Admission eligibility check passes
    const validCheck = service.verifyAdmissionEligibility(query, contentHash, 1)
    expect(validCheck.eligible).toBe(true)
    expect(validCheck.report).toEqual(report)

    // 4. Stale check when content or version modified
    const modifiedHash = computeContentHash('第二章 天剑出鞘（作者手工修订）。')
    const staleCheck = service.verifyAdmissionEligibility(query, modifiedHash, 2)
    expect(staleCheck.eligible).toBe(false)
    expect(staleCheck.reason).toContain('初验报告已过期')

    // 5. Hard rejected check
    service.evaluateAndRecord({
      projectId: 'proj-test',
      targetType: 'chapter',
      targetId: 'ch-2',
      targetVersion: 2,
      content: '太短',
      sourceOrigin: 'generation',
      executionInput: { evidenceAvailable: true },
      scopeInput: { evidenceAvailable: true },
      qualityInput: {
        wordCountMin: 100, // will fail
        evidenceAvailable: true,
      },
    })
    const rejectedCheck = service.verifyAdmissionEligibility(query, computeContentHash('太短'), 2)
    expect(rejectedCheck.eligible).toBe(false)
    expect(rejectedCheck.reason).toContain('初验被硬性拒绝')

    // 6. Clear project reports
    service.clearProjectReports('proj-test')
    expect(service.getLatestReport(query)).toBeUndefined()
  })
})
