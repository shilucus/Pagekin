import { describe, expect, it } from 'vitest'
import {
  computeContentHash,
  evaluatePreliminaryAcceptance,
  isAcceptanceReportStale,
  validateReportForHumanReviewAdmission,
  type EvaluateAcceptanceInput,
} from '../preliminary-acceptance-contract'

describe('preliminary-acceptance-contract', () => {
  const baseInput: EvaluateAcceptanceInput = {
    projectId: 'proj-1',
    targetType: 'chapter',
    targetId: 'ch-1',
    targetVersion: 1,
    content: '第一章 晨曦破晓。林云走出客栈，迎着微风看向远方。',
    planHash: 'plan-hash-abc',
    sourceOrigin: 'generation',
    executionInput: {
      receiptId: 'rcpt-1',
      requestId: 'req-1',
      projectionStatus: 'projected',
      errors: [],
      evidenceAvailable: true,
    },
    scopeInput: {
      targetRange: { startChapter: 1, endChapter: 3 },
      modifiedEntities: [{ id: 'ch-1', type: 'chapter' }],
      evidenceAvailable: true,
    },
    qualityInput: {
      wordCountMin: 10,
      wordCountMax: 5000,
      goalReviews: [{ goalId: 'g1', description: '林云出场', status: 'met' }],
      consistencyFindings: [],
      unverifiedItems: [],
      evidenceAvailable: true,
    },
  }

  it('computes deterministic sha256 hash', () => {
    const text = 'Hello Pagekin'
    const h1 = computeContentHash(text)
    const h2 = computeContentHash(text)
    expect(h1).toHaveLength(64)
    expect(h1).toBe(h2)
    expect(computeContentHash('Other text')).not.toBe(h1)
  })

  it('evaluates clean input to pass and enforces human/finalize boundaries', () => {
    const report = evaluatePreliminaryAcceptance(baseInput)

    expect(report.overallStatus).toBe('pass')
    expect(report.execution.status).toBe('success')
    expect(report.scope.status).toBe('within_scope')
    expect(report.quality.status).toBe('passed')
    expect(report.isHumanConfirmed).toBe(false)
    expect(report.canAutoFinalize).toBe(false)
    expect(report.contentHash).toBe(computeContentHash(baseInput.content))
    expect(report.targetVersion).toBe(1)
  })

  it('rejects on missing inputs without defaulting to pass (strict anti-silent pass)', () => {
    // Completely omitting execution, scope, and quality inputs
    const bareReport = evaluatePreliminaryAcceptance({
      projectId: 'proj-1',
      targetType: 'chapter',
      targetId: 'ch-1',
      targetVersion: 1,
      content: '测试内容',
      sourceOrigin: 'generation',
    })

    expect(bareReport.overallStatus).toBe('rejected')
    expect(bareReport.execution.evidenceStatus).toBe('unavailable')
    expect(bareReport.scope.evidenceStatus).toBe('unavailable')
    expect(bareReport.quality.evidenceStatus).toBe('unavailable')
    expect(bareReport.execution.errors).toContain('缺少执行证据 (Execution evidence missing or unavailable)')
    expect(bareReport.scope.unauthorizedModifications).toContain('缺少范围证据 (Scope evidence missing or unavailable)')
    expect(bareReport.quality.unverifiedItems).toContain('缺少质量证据 (Quality evidence missing or unavailable)')
  })

  it('rejects on execution errors and marks failure', () => {
    const report = evaluatePreliminaryAcceptance({
      ...baseInput,
      executionInput: {
        receiptId: 'rcpt-fail',
        projectionStatus: 'failed',
        errors: ['Outbox write failed'],
        evidenceAvailable: true,
      },
    })

    expect(report.overallStatus).toBe('rejected')
    expect(report.execution.status).toBe('failed')
    expect(report.execution.errors).toContain('Outbox write failed')
  })

  it('fails execution when projectionStatus is pending or receiptId missing for generation', () => {
    const pendingReport = evaluatePreliminaryAcceptance({
      ...baseInput,
      executionInput: {
        receiptId: 'rcpt-1',
        projectionStatus: 'pending',
        evidenceAvailable: true,
      },
    })
    expect(pendingReport.execution.status).toBe('failed')
    expect(pendingReport.execution.errors).toContain('投影尚未完成 (Outbox projection pending)')

    const noReceiptReport = evaluatePreliminaryAcceptance({
      ...baseInput,
      executionInput: {
        projectionStatus: 'projected',
        evidenceAvailable: true,
      },
    })
    expect(noReceiptReport.execution.status).toBe('failed')
    expect(noReceiptReport.execution.errors).toContain('生成来源缺少收据 (Generation receipt missing)')
  })

  it('rejects on out of scope chapter modification or unauthorized field', () => {
    const report = evaluatePreliminaryAcceptance({
      ...baseInput,
      scopeInput: {
        targetRange: { startChapter: 1, endChapter: 3, allowedFields: ['title', 'content'] },
        modifiedEntities: [
          { id: 'ch-1', type: 'chapter' },
          { id: 'ch-5', type: 'chapter' }, // out of scope
          { id: 'ch-1', type: 'chapter', field: 'secret_admin_role' }, // unauthorized field
        ],
        evidenceAvailable: true,
      },
    })

    expect(report.overallStatus).toBe('rejected')
    expect(report.scope.status).toBe('out_of_scope')
    expect(report.scope.unauthorizedModifications.some(m => m.includes('ch-5'))).toBe(true)
    expect(report.scope.unauthorizedModifications.some(m => m.includes('secret_admin_role'))).toBe(true)
  })

  it('marks evidenceStatus unavailable when evidence is missing and does not default pass', () => {
    const report = evaluatePreliminaryAcceptance({
      ...baseInput,
      executionInput: {
        evidenceAvailable: false,
      },
      qualityInput: {
        evidenceAvailable: false,
      },
    })

    expect(report.overallStatus).toBe('rejected')
    expect(report.execution.evidenceStatus).toBe('unavailable')
    expect(report.quality.evidenceStatus).toBe('unavailable')
    expect(report.execution.errors.length).toBeGreaterThan(0)
  })

  it('flags needs_review when quality has unmet goals or medium severity consistency conflicts', () => {
    const report = evaluatePreliminaryAcceptance({
      ...baseInput,
      qualityInput: {
        wordCountMin: 10,
        goalReviews: [
          { goalId: 'g1', description: '目标A', status: 'met' },
          { goalId: 'g2', description: '目标B', status: 'unmet' },
        ],
        consistencyFindings: [{ category: '角色', description: '佩剑颜色轻度差异', severity: 'medium' }],
        evidenceAvailable: true,
      },
    })

    expect(report.overallStatus).toBe('needs_review')
    expect(report.quality.status).toBe('warning')
    expect(report.quality.unverifiedItems).toContain('未达成章节目标: [g2] 目标B')
    expect(report.quality.unverifiedItems).toContain('中度一致性冲突: [角色] 佩剑颜色轻度差异')
  })

  it('rejects when word count fails or high severity finding exists', () => {
    const report = evaluatePreliminaryAcceptance({
      ...baseInput,
      qualityInput: {
        wordCountMin: 5000, // content only ~25 chars
        evidenceAvailable: true,
      },
    })

    expect(report.overallStatus).toBe('rejected')
    expect(report.quality.status).toBe('failed')
  })

  it('detects stale report when content or version changes', () => {
    const report = evaluatePreliminaryAcceptance(baseInput)
    const currentHash = computeContentHash(baseInput.content)

    expect(isAcceptanceReportStale(report, currentHash, 1)).toBe(false)
    expect(isAcceptanceReportStale(report, currentHash, 2)).toBe(true)
    expect(isAcceptanceReportStale(report, 'changed-hash-12345', 1)).toBe(true)
  })

  it('validates report for human review admission correctly', () => {
    const report = evaluatePreliminaryAcceptance(baseInput)
    const currentHash = computeContentHash(baseInput.content)

    const validResult = validateReportForHumanReviewAdmission(report, currentHash, 1)
    expect(validResult.valid).toBe(true)

    // Stale check
    const staleResult = validateReportForHumanReviewAdmission(report, 'new-content-hash', 1)
    expect(staleResult.valid).toBe(false)
    expect(staleResult.reason).toContain('初验报告已过期')

    // Rejected check
    const rejectedReport = evaluatePreliminaryAcceptance({
      ...baseInput,
      executionInput: { errors: ['Network crash'], evidenceAvailable: true },
    })
    const rejectedResult = validateReportForHumanReviewAdmission(
      rejectedReport,
      computeContentHash(baseInput.content),
      1,
    )
    expect(rejectedResult.valid).toBe(false)
    expect(rejectedResult.reason).toContain('初验被硬性拒绝')
  })
})
