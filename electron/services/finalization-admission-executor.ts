import {
  assembleAdmissionReceipt,
  validateAdmissionForFinalization,
  type BatchFinalizationProgress,
  type FinalizationAdmissionReceipt,
} from '../../src/shared/finalization-admission-contract'
import { computeBufferHash } from '../../src/shared/approval-manifest-contract'
import type { ApprovalManifestCoordinator } from './approval-manifest-coordinator'

export interface ChapterDraftData {
  title: string
  content: string
  revision: number
}

export interface FinalizationCommitResult {
  success: boolean
  committed: boolean
  finalizationId?: string
  publicationStatus: 'projected' | 'pending' | 'failed'
  error?: string
}

export interface FinalizationCommitHandler {
  commitChapter(params: {
    manifestId: string
    draftId: string
    chapterNumber: number
    chapterTitle: string
    content: string
    contentRevision: number
    reopenRelation?: { previousFinalizedId: string }
  }): Promise<FinalizationCommitResult>
}

export class FinalizationAdmissionExecutor {
  private readonly progressStore = new Map<string, BatchFinalizationProgress>()

  constructor(
    private readonly coordinator: ApprovalManifestCoordinator,
    private readonly commitHandler: FinalizationCommitHandler,
  ) {}

  /**
   * 执行多章批次权威定稿提交
   * 铁律：
   * 1. 严格按章节升序执行；
   * 2. 逐章独立收据，部分成功不谎称整批 ACID，失败后继暂停，绝不回滚已生效章节！
   * 3. 幂等性：针对已提交的批次直接幂等返回完成进度；
   * 4. 严防假完全成功：只有所有章节均定稿且实体文件投影全部为 projected 时，方可标记为 completed。
   */
  public async executeBatchFinalization(
    manifestId: string,
    chapterFetcher: (chapterNumber: number) => Promise<ChapterDraftData>,
  ): Promise<BatchFinalizationProgress> {
    const manifest = this.coordinator.getManifest(manifestId)
    if (!manifest) {
      throw new Error(`未找到对应批次批准清单 [${manifestId}]`) // i18n-exempt: 内部断言错误
    }

    // 1. 幂等性支持：若该清单已落盘提交完成，且进度已存在并处于完成状态，直接幂等返回
    const existingProgress = this.progressStore.get(manifestId)
    if (manifest.status === 'committed' && existingProgress?.status === 'completed') {
      return existingProgress
    }

    if (manifest.status !== 'frozen' && manifest.status !== 'committed') {
      throw new Error(`清单状态为 [${manifest.status}]，只有处于 [frozen] 或 [committed] 状态的清单才允许执行定稿事务`) // i18n-exempt: 内部断言错误
    }

    // 2. 初始化或复用已有进度（断点续跑支持）
    let progress: BatchFinalizationProgress
    if (!existingProgress) {
      progress = {
        manifestId,
        totalCount: manifest.items.length,
        completedCount: 0,
        failedCount: 0,
        status: 'in_progress',
        receipts: [],
      }
      this.progressStore.set(manifestId, progress)
    } else {
      progress = existingProgress
      // 断点重试时重新进入 in_progress 状态，校准 failedCount
      progress.status = 'in_progress'
      progress.failedCount = 0
      progress.failureReason = undefined
    }

    // 严格按章节升序排序
    const sortedItems = [...manifest.items].sort((a, b) => a.chapterNumber - b.chapterNumber)

    for (const item of sortedItems) {
      // 幂等性：如果该章已有 committed 收据，直接复用已提交事实
      const existingReceipt = progress.receipts.find(r => r.chapterNumber === item.chapterNumber && r.committed)
      if (existingReceipt) {
        continue
      }

      // 3. 带异常保护获取草稿数据
      let draftData: ChapterDraftData
      try {
        draftData = await chapterFetcher(item.chapterNumber)
      } catch (fetchErr) {
        progress.status = 'partially_failed'
        progress.failedCount = progress.totalCount - progress.completedCount
        // i18n-exempt: 内部诊断原因
        progress.failureReason = `读取第 ${item.chapterNumber} 章草稿发生异常: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`
        return progress
      }

      const currentContentHash = computeBufferHash(draftData.content)

      // 4. 强校验准入条件
      const admissionCheck = validateAdmissionForFinalization(manifest, item.chapterNumber, currentContentHash)
      if (!admissionCheck.valid) {
        progress.status = 'partially_failed'
        progress.failedCount = progress.totalCount - progress.completedCount
        // i18n-exempt: 内部诊断原因
        progress.failureReason = `第 ${item.chapterNumber} 章准入校验失败: ${admissionCheck.reason}`
        return progress
      }

      // 5. 驱动权威定稿事务（带异常捕获保护）
      let commitRes: FinalizationCommitResult
      try {
        commitRes = await this.commitHandler.commitChapter({
          manifestId,
          draftId: item.draftId,
          chapterNumber: item.chapterNumber,
          chapterTitle: draftData.title,
          content: draftData.content,
          contentRevision: draftData.revision,
          reopenRelation: item.reopenRelation,
        })
      } catch (commitErr) {
        progress.status = 'partially_failed'
        progress.failedCount = progress.totalCount - progress.completedCount
        // i18n-exempt: 内部诊断原因
        progress.failureReason = `第 ${item.chapterNumber} 章定稿事务异常挂起: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`
        return progress
      }

      // 无论投影是否成功，只要 committed === true，定稿事实即已成立，不可回滚
      if (commitRes.committed && commitRes.finalizationId) {
        const receipt = assembleAdmissionReceipt({
          manifestId,
          draftId: item.draftId,
          chapterNumber: item.chapterNumber,
          finalizationId: commitRes.finalizationId,
          contentHash: currentContentHash,
          committed: true,
          publicationStatus: commitRes.publicationStatus,
          transition: item.expectedTransition === 'replace_superseded' ? 'superseded' : 'finalized',
        })
        progress.receipts.push(receipt)
        progress.completedCount += 1

        // 若实体投影失败或 pending，如实记录待发布队列，不谎称完全成功，暂停后续推进
        if (commitRes.publicationStatus !== 'projected') {
          progress.status = 'partially_failed'
          // i18n-exempt: 内部诊断原因
          progress.failureReason = `第 ${item.chapterNumber} 章定稿事实已落盘，但实体正文投影处于 [${commitRes.publicationStatus}] 状态，请调用 retryFailedProjections`
          return progress
        }
      } else {
        // 数据库事务未提交
        progress.status = 'partially_failed'
        progress.failedCount = progress.totalCount - progress.completedCount
        // i18n-exempt: 内部诊断原因
        progress.failureReason = `第 ${item.chapterNumber} 章定稿事务失败: ${commitRes.error ?? '未知错误'}`
        return progress
      }
    }

    // 6. 防假完全成功校验：循环结束后，必须校验所有收据均处于 projected 状态
    const unprojectedReceipt = progress.receipts.find(r => r.publicationStatus !== 'projected')
    if (unprojectedReceipt || progress.completedCount < progress.totalCount) {
      progress.status = 'partially_failed'
      // i18n-exempt: 内部诊断原因
      progress.failureReason = unprojectedReceipt
        ? `所有章节定稿事实已落盘，但第 ${unprojectedReceipt.chapterNumber} 章实体投影处于 [${unprojectedReceipt.publicationStatus}] 状态，请调用 retryFailedProjections`
        : `批次完成数 (${progress.completedCount}) 未达到总数 (${progress.totalCount})`
      return progress
    }

    // 全部章节成功定稿与投影
    progress.status = 'completed'
    progress.failedCount = 0
    progress.failureReason = undefined
    this.coordinator.markManifestCommitted(manifestId)

    return progress
  }

  /**
   * 专用于后处理/投影恢复：重试失败或待处理的 outbox 文件投影，不重复执行定稿事务
   */
  public async retryFailedProjections(
    manifestId: string,
    publisher: (receipt: FinalizationAdmissionReceipt) => Promise<boolean>,
  ): Promise<BatchFinalizationProgress> {
    const progress = this.progressStore.get(manifestId)
    if (!progress) {
      throw new Error(`未找到定稿进度 [${manifestId}]`) // i18n-exempt: 内部断言错误
    }

    let allProjected = true
    for (const receipt of progress.receipts) {
      if (receipt.publicationStatus !== 'projected') {
        const success = await publisher(receipt)
        if (success) {
          receipt.publicationStatus = 'projected'
        } else {
          allProjected = false
        }
      }
    }

    if (allProjected && progress.completedCount === progress.totalCount) {
      progress.status = 'completed'
      progress.failedCount = 0
      progress.failureReason = undefined
      this.coordinator.markManifestCommitted(manifestId)
    }

    return progress
  }

  public getProgress(manifestId: string): BatchFinalizationProgress | undefined {
    return this.progressStore.get(manifestId)
  }

  public clearProjectProgress(projectId: string): void {
    for (const id of Array.from(this.progressStore.keys())) {
      if (id.startsWith(`amf-`) && id.includes(projectId)) {
        this.progressStore.delete(id)
      }
    }
  }
}
