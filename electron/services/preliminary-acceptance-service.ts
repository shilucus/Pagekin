import {
  evaluatePreliminaryAcceptance,
  isAcceptanceReportStale,
  validateReportForHumanReviewAdmission,
  type EvaluateAcceptanceInput,
  type PreliminaryAcceptanceReport,
} from '../../src/shared/preliminary-acceptance-contract'

export interface PreliminaryAcceptanceQuery {
  projectId: string
  targetType: 'chapter' | 'outline' | 'blueprint' | 'characters'
  targetId: string
}

export class PreliminaryAcceptanceService {
  private readonly reports = new Map<string, PreliminaryAcceptanceReport>()

  private makeKey(projectId: string, targetType: string, targetId: string): string {
    return `${projectId}:${targetType}:${targetId}`
  }

  /**
   * 评估并记录自动化初验报告
   */
  public evaluateAndRecord(input: EvaluateAcceptanceInput): PreliminaryAcceptanceReport {
    const report = evaluatePreliminaryAcceptance(input)
    const key = this.makeKey(input.projectId, input.targetType, input.targetId)
    this.reports.set(key, report)
    return report
  }

  /**
   * 获取目标产物的最新初验报告
   */
  public getLatestReport(query: PreliminaryAcceptanceQuery): PreliminaryAcceptanceReport | undefined {
    return this.reports.get(this.makeKey(query.projectId, query.targetType, query.targetId))
  }

  /**
   * 检验目标产物是否具备人审准入资格
   */
  public verifyAdmissionEligibility(
    query: PreliminaryAcceptanceQuery,
    currentContentHash: string,
    currentVersion: number,
  ): { eligible: boolean; report?: PreliminaryAcceptanceReport; reason?: string } {
    const report = this.getLatestReport(query)
    if (!report) {
      return {
        eligible: false,
        // i18n-exempt: 内部初验诊断原因，不直接在界面错误框显示
        reason: '未找到初验报告 (No preliminary acceptance report found)',
      }
    }

    if (isAcceptanceReportStale(report, currentContentHash, currentVersion)) {
      return {
        eligible: false,
        report,
        // i18n-exempt: 内部初验诊断原因，不直接在界面错误框显示
        reason: `初验报告已过期 (Report stale): 产物已被修改 (v${currentVersion}, hash ${currentContentHash.slice(0, 8)})，报告绑定为 (v${report.targetVersion}, hash ${report.contentHash.slice(0, 8)})`,
      }
    }

    const admissionCheck = validateReportForHumanReviewAdmission(report, currentContentHash, currentVersion)
    if (!admissionCheck.valid) {
      return {
        eligible: false,
        report,
        reason: admissionCheck.reason,
      }
    }

    return {
      eligible: true,
      report,
    }
  }

  /**
   * 清除特定项目的报告缓存（例如切换或关闭项目时）
   */
  public clearProjectReports(projectId: string): void {
    for (const key of Array.from(this.reports.keys())) {
      if (key.startsWith(`${projectId}:`)) {
        this.reports.delete(key)
      }
    }
  }
}
