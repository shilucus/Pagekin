import { createHash } from 'node:crypto'

export type AcceptanceDimension = 'execution' | 'scope' | 'quality'
export type AcceptanceEvaluationStatus = 'pass' | 'needs_review' | 'rejected'
export type EvidenceStatus = 'verified' | 'unverified' | 'unavailable'

export interface ExecutionAcceptanceReport {
  status: 'success' | 'failed' | 'error'
  receiptId?: string
  requestId?: string
  projectionStatus?: 'projected' | 'pending' | 'failed'
  errors: string[]
  evidenceStatus: EvidenceStatus
}

export interface ScopeAcceptanceReport {
  status: 'within_scope' | 'out_of_scope'
  targetRange?: {
    startChapter?: number
    endChapter?: number
    allowedFields?: string[]
  }
  modifiedEntities: Array<{
    id: string
    type: string
    inScope: boolean
  }>
  unauthorizedModifications: string[]
  evidenceStatus: EvidenceStatus
}

export interface QualityAcceptanceReport {
  status: 'passed' | 'warning' | 'failed'
  wordCountCheck?: {
    current: number
    min?: number
    max?: number
    passed: boolean
  }
  goalReviews?: Array<{
    goalId: string
    description: string
    status: 'met' | 'unmet' | 'unknown'
  }>
  consistencyFindings?: Array<{
    category: string
    description: string
    severity: 'low' | 'medium' | 'high'
  }>
  unverifiedItems: string[]
  evidenceStatus: EvidenceStatus
}

export interface PreliminaryAcceptanceReport {
  reportId: string
  projectId: string
  targetType: 'chapter' | 'outline' | 'blueprint' | 'characters'
  targetId: string
  targetVersion: number
  contentHash: string
  planHash?: string
  sourceOrigin: 'generation' | 'revision' | 'manual' | 'import'
  timestamp: number
  execution: ExecutionAcceptanceReport
  scope: ScopeAcceptanceReport
  quality: QualityAcceptanceReport
  overallStatus: AcceptanceEvaluationStatus
  summary: string
  isHumanConfirmed: false
  canAutoFinalize: false
}

export interface EvaluateAcceptanceInput {
  projectId: string
  targetType: 'chapter' | 'outline' | 'blueprint' | 'characters'
  targetId: string
  targetVersion: number
  content: string
  planHash?: string
  sourceOrigin: 'generation' | 'revision' | 'manual' | 'import'
  executionInput?: {
    receiptId?: string
    requestId?: string
    projectionStatus?: 'projected' | 'pending' | 'failed'
    errors?: string[]
    evidenceAvailable?: boolean
  }
  scopeInput?: {
    targetRange?: {
      startChapter?: number
      endChapter?: number
      allowedFields?: string[]
    }
    modifiedEntities?: Array<{ id: string; type: string; field?: string }>
    evidenceAvailable?: boolean
  }
  qualityInput?: {
    wordCountMin?: number
    wordCountMax?: number
    goalReviews?: Array<{ goalId: string; description: string; status: 'met' | 'unmet' | 'unknown' }>
    consistencyFindings?: Array<{ category: string; description: string; severity: 'low' | 'medium' | 'high' }>
    unverifiedItems?: string[]
    evidenceAvailable?: boolean
  }
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

export function evaluatePreliminaryAcceptance(input: EvaluateAcceptanceInput): PreliminaryAcceptanceReport {
  const contentHash = computeContentHash(input.content)
  const reportId = `par-${createHash('sha256').update(`${input.projectId}:${input.targetId}:${input.targetVersion}:${contentHash}:${Date.now()}`).digest('hex').slice(0, 16)}`

  // 1. Evaluate Execution
  const execErrors = input.executionInput?.errors ? [...input.executionInput.errors] : []
  let execStatus: ExecutionAcceptanceReport['status'] = 'success'
  let execEvidenceStatus: EvidenceStatus = 'verified'

  // 严格缺证据检查：若 executionInput 未提供或明确不可用，判定为 unavailable，绝不默认 verified / success
  if (!input.executionInput || input.executionInput.evidenceAvailable !== true) {
    execEvidenceStatus = 'unavailable'
    execErrors.push('缺少执行证据 (Execution evidence missing or unavailable)')
    execStatus = 'error'
  } else {
    if (input.sourceOrigin === 'generation' && !input.executionInput.receiptId) {
      execErrors.push('生成来源缺少收据 (Generation receipt missing)')
      execStatus = 'failed'
    }
    if (input.executionInput.projectionStatus === 'pending') {
      execErrors.push('投影尚未完成 (Outbox projection pending)')
      execStatus = 'failed'
    } else if (input.executionInput.projectionStatus === 'failed') {
      execErrors.push('实体正文投影失败 (Outbox projection failed)')
      execStatus = 'failed'
    }
    if (execErrors.length > 0) {
      execStatus = 'failed'
    }
  }

  const execution: ExecutionAcceptanceReport = {
    status: execStatus,
    receiptId: input.executionInput?.receiptId,
    requestId: input.executionInput?.requestId,
    projectionStatus: input.executionInput?.projectionStatus ?? (execEvidenceStatus === 'verified' ? 'projected' : 'pending'),
    errors: execErrors,
    evidenceStatus: execEvidenceStatus,
  }

  // 2. Evaluate Scope
  let scopeStatus: ScopeAcceptanceReport['status'] = 'within_scope'
  let scopeEvidenceStatus: EvidenceStatus = 'verified'
  const unauthorizedModifications: string[] = []
  const modifiedEntities: ScopeAcceptanceReport['modifiedEntities'] = []

  // 严格缺证据检查：若 scopeInput 未提供或明确不可用，判定为 unavailable，绝不默认 within_scope
  if (!input.scopeInput || input.scopeInput.evidenceAvailable !== true) {
    scopeEvidenceStatus = 'unavailable'
    unauthorizedModifications.push('缺少范围证据 (Scope evidence missing or unavailable)')
    scopeStatus = 'out_of_scope'
  } else if (input.scopeInput.modifiedEntities) {
    const range = input.scopeInput.targetRange
    const allowedFields = range?.allowedFields ? new Set(range.allowedFields) : undefined

    for (const ent of input.scopeInput.modifiedEntities) {
      let inScope = true
      if (ent.type === 'chapter' && range?.startChapter !== undefined && range?.endChapter !== undefined) {
        const digits = ent.id.replace(/\D/g, '')
        if (digits) {
          const chNum = parseInt(digits, 10)
          if (!Number.isNaN(chNum) && (chNum < range.startChapter || chNum > range.endChapter)) {
            inScope = false
          }
        } else {
          // 非数字章节实体，检查是否明确在 allowedFields 中，否则视为越界
          if (allowedFields && !allowedFields.has(ent.id)) {
            inScope = false
          }
        }
      }

      if (ent.field && allowedFields && !allowedFields.has(ent.field)) {
        inScope = false
        unauthorizedModifications.push(`越界字段修改: 实体 ${ent.id} 的字段 [${ent.field}] 不在允许列表`)
      }

      modifiedEntities.push({
        id: ent.id,
        type: ent.type,
        inScope,
      })
      if (!inScope && !unauthorizedModifications.some(m => m.includes(ent.id))) {
        unauthorizedModifications.push(`越界修改实体: ${ent.type}:${ent.id} 超出声明范围`)
      }
    }
    if (unauthorizedModifications.length > 0) {
      scopeStatus = 'out_of_scope'
    }
  }

  const scope: ScopeAcceptanceReport = {
    status: scopeStatus,
    targetRange: input.scopeInput?.targetRange,
    modifiedEntities,
    unauthorizedModifications,
    evidenceStatus: scopeEvidenceStatus,
  }

  // 3. Evaluate Quality
  let qualityStatus: QualityAcceptanceReport['status'] = 'passed'
  let qualityEvidenceStatus: EvidenceStatus = 'verified'
  const unverifiedItems = input.qualityInput?.unverifiedItems ? [...input.qualityInput.unverifiedItems] : []

  // 严格缺证据检查：若 qualityInput 未提供或明确不可用，判定为 unavailable，绝不默认 passed
  if (!input.qualityInput || input.qualityInput.evidenceAvailable !== true) {
    qualityEvidenceStatus = 'unavailable'
    unverifiedItems.push('缺少质量证据 (Quality evidence missing or unavailable)')
    qualityStatus = 'failed'
  } else {
    // Word count check
    const wordCount = Array.from(input.content.trim()).length
    let wordCountPassed = true
    if (input.qualityInput.wordCountMin !== undefined && wordCount < input.qualityInput.wordCountMin) {
      wordCountPassed = false
      unverifiedItems.push(`正文字数不足: 当前 ${wordCount} 字，最小要求 ${input.qualityInput.wordCountMin} 字`)
    }
    if (input.qualityInput.wordCountMax !== undefined && wordCount > input.qualityInput.wordCountMax) {
      wordCountPassed = false
      unverifiedItems.push(`正文字数超限: 当前 ${wordCount} 字，最大上限 ${input.qualityInput.wordCountMax} 字`)
    }

    // Goal reviews check
    if (input.qualityInput.goalReviews) {
      for (const gr of input.qualityInput.goalReviews) {
        if (gr.status === 'unmet') {
          unverifiedItems.push(`未达成章节目标: [${gr.goalId}] ${gr.description}`)
        } else if (gr.status === 'unknown') {
          unverifiedItems.push(`待核实章节目标: [${gr.goalId}] ${gr.description}`)
        }
      }
    }

    // Consistency findings check: 包括 high 与 medium
    let hasHighSeverityFinding = false
    if (input.qualityInput.consistencyFindings) {
      for (const cf of input.qualityInput.consistencyFindings) {
        if (cf.severity === 'high') {
          hasHighSeverityFinding = true
          unverifiedItems.push(`严重一致性冲突: [${cf.category}] ${cf.description}`)
        } else if (cf.severity === 'medium') {
          unverifiedItems.push(`中度一致性冲突: [${cf.category}] ${cf.description}`)
        }
      }
    }

    if (!wordCountPassed || hasHighSeverityFinding) {
      qualityStatus = 'failed'
    } else if (unverifiedItems.length > 0) {
      qualityStatus = 'warning'
    }
  }

  const wordCount = Array.from(input.content.trim()).length
  const quality: QualityAcceptanceReport = {
    status: qualityStatus,
    wordCountCheck: input.qualityInput?.wordCountMin !== undefined || input.qualityInput?.wordCountMax !== undefined
      ? {
          current: wordCount,
          min: input.qualityInput?.wordCountMin,
          max: input.qualityInput?.wordCountMax,
          passed: qualityStatus !== 'failed' && (input.qualityInput?.wordCountMin === undefined || wordCount >= input.qualityInput.wordCountMin) && (input.qualityInput?.wordCountMax === undefined || wordCount <= input.qualityInput.wordCountMax),
        }
      : undefined,
    goalReviews: input.qualityInput?.goalReviews,
    consistencyFindings: input.qualityInput?.consistencyFindings,
    unverifiedItems,
    evidenceStatus: qualityEvidenceStatus,
  }

  // 4. Overall Status Determination
  let overallStatus: AcceptanceEvaluationStatus = 'pass'
  let summary = '初验全部通过，产物已满足人审准入基线'

  if (
    execution.status !== 'success'
    || scope.status === 'out_of_scope'
    || quality.status === 'failed'
    || execution.evidenceStatus === 'unavailable'
    || scope.evidenceStatus === 'unavailable'
    || quality.evidenceStatus === 'unavailable'
  ) {
    overallStatus = 'rejected'
    summary = `初验未通过: ${[
      execution.status !== 'success' || execution.evidenceStatus !== 'verified' ? '执行异常或缺证据' : '',
      scope.status === 'out_of_scope' || scope.evidenceStatus !== 'verified' ? '存在越界或缺范围证据' : '',
      quality.status === 'failed' || quality.evidenceStatus !== 'verified' ? '质量未达标或缺质量证据' : '',
    ].filter(Boolean).join('、')}`
  } else if (
    quality.status === 'warning'
    || unverifiedItems.length > 0
    || execution.evidenceStatus !== 'verified'
    || scope.evidenceStatus !== 'verified'
    || quality.evidenceStatus !== 'verified'
  ) {
    overallStatus = 'needs_review'
    summary = `初验包含待核实项 (${unverifiedItems.length} 项)，需作者特别审查`
  }

  return {
    reportId,
    projectId: input.projectId,
    targetType: input.targetType,
    targetId: input.targetId,
    targetVersion: input.targetVersion,
    contentHash,
    planHash: input.planHash,
    sourceOrigin: input.sourceOrigin,
    timestamp: Date.now(),
    execution,
    scope,
    quality,
    overallStatus,
    summary,
    isHumanConfirmed: false,
    canAutoFinalize: false,
  }
}

export function isAcceptanceReportStale(
  report: PreliminaryAcceptanceReport,
  currentContentHash: string,
  currentVersion: number,
): boolean {
  return report.contentHash !== currentContentHash || report.targetVersion !== currentVersion
}

export function validateReportForHumanReviewAdmission(
  report: PreliminaryAcceptanceReport,
  expectedContentHash: string,
  expectedVersion: number,
): { valid: boolean; reason?: string } {
  if (isAcceptanceReportStale(report, expectedContentHash, expectedVersion)) {
    return {
      valid: false,
      reason: `初验报告已过期 (Stale report): 期望版本 v${expectedVersion} (hash ${expectedContentHash.slice(0, 8)})，报告版本 v${report.targetVersion} (hash ${report.contentHash.slice(0, 8)})`,
    }
  }

  if (report.overallStatus === 'rejected') {
    return {
      valid: false,
      reason: `初验被硬性拒绝 (Rejected): ${report.summary}`,
    }
  }

  return { valid: true }
}
