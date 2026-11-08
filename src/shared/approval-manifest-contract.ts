import { createHash } from 'node:crypto'

export type ApprovalItemStatus = 'pending' | 'frozen' | 'unfrozen' | 'committed' | 'rejected'
export type ManifestStatus =
  | 'draft'
  | 'pending_handshake'
  | 'pending_author_action'
  | 'frozen'
  | 'committed'
  | 'unfrozen'
  | 'cancelled'

export interface ApprovalItem {
  draftId: string
  chapterNumber: number
  version: number
  contentHash: string
  status: ApprovalItemStatus
  preliminaryReportId: string
  reopenRelation?: {
    previousFinalizedId: string
    supersedeReason?: string
  }
  expectedTransition: 'finalize' | 'replace_superseded'
}

export interface FrozenEditorBuffer {
  chapterNumber: number
  bufferHash: string
  content: string
  revision: number
  timestamp: number
}

export interface ApprovalManifest {
  manifestId: string
  projectId: string
  sessionLeaseId: string
  scopeRange: {
    startChapter: number
    endChapter: number
  }
  items: ApprovalItem[]
  frozenBuffers: Record<number, FrozenEditorBuffer>
  authorConfirmed: boolean
  status: ManifestStatus
  pendingReason?: string
  createdAt: number
  updatedAt: number
}

export interface CreateApprovalManifestParams {
  projectId: string
  sessionLeaseId: string
  scopeRange: {
    startChapter: number
    endChapter: number
  }
  items: Array<{
    draftId: string
    chapterNumber: number
    version: number
    contentHash: string
    preliminaryReportId: string
    reopenRelation?: {
      previousFinalizedId: string
      supersedeReason?: string
    }
    expectedTransition?: 'finalize' | 'replace_superseded'
  }>
  authorConfirmed: boolean
}

export function computeBufferHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

export function createApprovalManifest(params: CreateApprovalManifestParams): ApprovalManifest {
  const manifestId = `amf-${createHash('sha256')
    .update(`${params.projectId}:${params.sessionLeaseId}:${params.scopeRange.startChapter}-${params.scopeRange.endChapter}:${Date.now()}`)
    .digest('hex')
    .slice(0, 16)}`

  const items: ApprovalItem[] = params.items.map(item => ({
    draftId: item.draftId,
    chapterNumber: item.chapterNumber,
    version: item.version,
    contentHash: item.contentHash,
    status: 'pending',
    preliminaryReportId: item.preliminaryReportId,
    reopenRelation: item.reopenRelation,
    expectedTransition: item.expectedTransition ?? (item.reopenRelation ? 'replace_superseded' : 'finalize'),
  }))

  return {
    manifestId,
    projectId: params.projectId,
    sessionLeaseId: params.sessionLeaseId,
    scopeRange: params.scopeRange,
    items,
    frozenBuffers: {},
    authorConfirmed: params.authorConfirmed,
    status: 'draft',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function validateApprovalManifest(
  manifest: ApprovalManifest,
  clientScope: string,
): { valid: boolean; reason?: string } {
  // 1. 权限门禁：普通客户端禁止自签 human_approval
  if (!clientScope || !clientScope.split(',').map(s => s.trim()).includes('human_approval')) {
    return {
      valid: false,
      reason: '缺少人审批准权限 (Missing human_approval scope): 外部任务或普通客户端无权自签批准清单',
    }
  }

  // 2. 作者确认门禁
  if (!manifest.authorConfirmed) {
    return {
      valid: false,
      reason: '作者尚未确认 (Author not confirmed): 清单必须明确包含作者人审确认',
    }
  }

  // 3. 范围校验
  if (manifest.items.length === 0) {
    return {
      valid: false,
      reason: '批准清单条目为空 (Empty items in manifest)',
    }
  }

  for (const item of manifest.items) {
    if (item.chapterNumber < manifest.scopeRange.startChapter || item.chapterNumber > manifest.scopeRange.endChapter) {
      return {
        valid: false,
        reason: `清单条目越界: 第 ${item.chapterNumber} 章不在声明范围 [${manifest.scopeRange.startChapter}, ${manifest.scopeRange.endChapter}] 内`,
      }
    }
    if (!item.preliminaryReportId) {
      return {
        valid: false,
        reason: `第 ${item.chapterNumber} 章缺少前置初验报告 (Missing preliminaryReportId)`,
      }
    }
    if (!item.contentHash || item.contentHash.length !== 64) {
      return {
        valid: false,
        reason: `第 ${item.chapterNumber} 章内容哈希非法或缺失`,
      }
    }
  }

  return { valid: true }
}

export function canUnfreezeManifest(manifest: ApprovalManifest): { allowed: boolean; reason?: string } {
  if (manifest.status === 'committed') {
    return {
      allowed: false,
      reason: '提交先赢 (Commit wins): 该批次已落盘定稿，不可直接解封撤销；若需改动请按 ADR-0024 执行重开草稿流程',
    }
  }

  if (manifest.status === 'cancelled' || manifest.status === 'unfrozen') {
    return {
      allowed: false,
      reason: '清单已被撤销或已处于解封状态',
    }
  }

  return { allowed: true }
}

export function mergeEditorBufferSnapshot(
  manifest: ApprovalManifest,
  buffer: FrozenEditorBuffer,
): ApprovalManifest {
  return {
    ...manifest,
    frozenBuffers: {
      ...manifest.frozenBuffers,
      [buffer.chapterNumber]: buffer,
    },
    updatedAt: Date.now(),
  }
}
