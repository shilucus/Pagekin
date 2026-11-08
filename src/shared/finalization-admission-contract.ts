import { createHash } from 'node:crypto'
import type { ApprovalManifest } from './approval-manifest-contract'

export interface FinalizationAdmissionReceipt {
  receiptId: string
  manifestId: string
  draftId: string
  chapterNumber: number
  finalizationId: string
  contentHash: string
  committed: boolean
  publicationStatus: 'projected' | 'pending' | 'failed'
  transition: 'finalized' | 'superseded'
  timestamp: number
}

export interface BatchFinalizationProgress {
  manifestId: string
  totalCount: number
  completedCount: number
  failedCount: number
  status: 'in_progress' | 'completed' | 'partially_failed' | 'paused'
  receipts: FinalizationAdmissionReceipt[]
  failureReason?: string
}

export function validateAdmissionForFinalization(
  manifest: ApprovalManifest,
  chapterNumber: number,
  expectedHash: string,
): { valid: boolean; reason?: string } {
  // 1. 检查清单状态：必须是已完成安全握手并封存的状态，或处于已提交/进行中状态
  if (manifest.status !== 'frozen' && manifest.status !== 'committed') {
    return {
      valid: false,
      reason: `清单状态非法 [${manifest.status}]: 只有处于 [frozen] 或已提交状态的批准清单允许核验定稿事务准入`,
    }
  }

  // 2. 查找清单中该章节的条目
  const item = manifest.items.find(i => i.chapterNumber === chapterNumber)
  if (!item) {
    return {
      valid: false,
      reason: `清单中未找到第 ${chapterNumber} 章的批准条目`,
    }
  }

  // 3. 校验内容哈希一致性
  if (item.contentHash !== expectedHash) {
    return {
      valid: false,
      reason: `内容哈希不匹配 (Content hash mismatch): 待定稿正文哈希 (${expectedHash.slice(0, 8)}) 与清单绑定哈希 (${item.contentHash.slice(0, 8)}) 不符`,
    }
  }

  // 4. 校验前置初验报告引用
  if (!item.preliminaryReportId) {
    return {
      valid: false,
      reason: `第 ${chapterNumber} 章缺少前置自动化初验报告引用`,
    }
  }

  return { valid: true }
}

export function assembleAdmissionReceipt(params: {
  manifestId: string
  draftId: string
  chapterNumber: number
  finalizationId: string
  contentHash: string
  committed: boolean
  publicationStatus: 'projected' | 'pending' | 'failed'
  transition?: 'finalized' | 'superseded'
  timestamp?: number
}): FinalizationAdmissionReceipt {
  // 确定性收据 ID：绑定 manifestId、chapterNumber、finalizationId 与 contentHash
  const receiptId = `far-${createHash('sha256')
    .update(`${params.manifestId}:${params.chapterNumber}:${params.finalizationId}:${params.contentHash}`)
    .digest('hex')
    .slice(0, 16)}`

  return {
    receiptId,
    manifestId: params.manifestId,
    draftId: params.draftId,
    chapterNumber: params.chapterNumber,
    finalizationId: params.finalizationId,
    contentHash: params.contentHash,
    committed: params.committed,
    publicationStatus: params.publicationStatus,
    transition: params.transition ?? 'finalized',
    timestamp: params.timestamp ?? Date.now(),
  }
}
