import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getProjectDb } from '../database'
import {
  type BlueprintData,
  type BlueprintRangeCommitReceipt,
  BlueprintRepository,
} from './blueprint-repository'
import {
  applyBlueprintFeedbackChanges,
  blueprintFeedbackPayloadHash,
  type BlueprintFeedbackChanges,
  validateBlueprintFeedbackChanges,
} from '../../src/shared/blueprint-feedback-contract'

export interface BlueprintFeedbackBase {
  chapterNumber: number
  sourceHash: string
  snapshot: BlueprintData
  capturedAt: number
}

export interface AdoptBlueprintFeedbackRequest {
  chapterNumber: number
  baseHash: string
  operationId: string
  changes: BlueprintFeedbackChanges
}

function blueprintContentHash(data: BlueprintData): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

/**
 * 捕获指定章节蓝图的当前基线：
 * 提取权威蓝图事实并生成基线哈希，供后续 CAS 比较校验。
 */
export function captureBlueprintFeedbackBase(
  chapterNumber: number,
  db?: Database.Database,
): BlueprintFeedbackBase {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber <= 0) {
    throw new Error('BLUEPRINT_CHAPTER_NUMBER_INVALID')
  }

  const current = BlueprintRepository.getByChapter(chapterNumber, db)
  if (!current) {
    throw new Error('BLUEPRINT_NOT_FOUND')
  }

  return {
    chapterNumber,
    sourceHash: blueprintContentHash(current),
    snapshot: current,
    capturedAt: Date.now(),
  }
}

/**
 * 采纳蓝图字段修订：
 * 1. 严格校验章号有效性；
 * 2. 原请求先按固定输入与反馈绑定重放；仅新效果在 writer 事务内比对 baseHash；
 * 3. 严格校验变更字段（未选字段不补齐、角色身份引用必须闭合），校验失败零写入；
 * 4. 强制使用 mode: 'replace-range' 仅提交目标章节蓝图，100% 保护范围外章节蓝图不被删除；
 * 5. 事务内返回持久化收据，并支持相同 operationId 幂等重放。
 */
export function commitBlueprintFeedbackRevision(
  request: AdoptBlueprintFeedbackRequest,
  db?: Database.Database,
): BlueprintRangeCommitReceipt {
  if (!Number.isSafeInteger(request.chapterNumber) || request.chapterNumber <= 0) {
    throw new Error('BLUEPRINT_CHAPTER_NUMBER_INVALID')
  }

  const database = db ?? getProjectDb()
  if (!database) throw new Error('PROJECT_NOT_OPEN')
  return database.transaction(() => {
    const original = BlueprintRepository.getCommittedRangeOperation(request.operationId, database)
    if (original && (original.mode !== 'replace-range' || original.startChapter !== request.chapterNumber
      || original.endChapter !== request.chapterNumber || original.characterSyncInput.length !== 1)) {
      throw new Error('BLUEPRINT_OPERATION_CONFLICT')
    }
    const current = original?.characterSyncInput[0] ?? BlueprintRepository.getByChapter(request.chapterNumber, database)
    if (!current) throw new Error('BLUEPRINT_NOT_FOUND')
    const validated = validateBlueprintFeedbackChanges(request.changes, current.characters)
    if (!validated.valid) throw new Error(`BLUEPRINT_VALIDATION_FAILED: ${validated.error}`)
    const feedbackRequestHash = createHash('sha256').update(JSON.stringify(['blueprint-feedback-v1', request.chapterNumber,
      request.baseHash, blueprintFeedbackPayloadHash(request.chapterNumber, validated.changes)])).digest('hex')
    return BlueprintRepository.commitRange({ mode: 'replace-range', operationId: request.operationId,
      startChapter: request.chapterNumber, endChapter: request.chapterNumber,
      blueprints: original ? original.characterSyncInput : [applyBlueprintFeedbackChanges(current, validated.changes)] }, () => {
      const latest = BlueprintRepository.getByChapter(request.chapterNumber, database)
      if (!latest || blueprintContentHash(latest) !== request.baseHash) throw new Error('BLUEPRINT_SOURCE_CONFLICT')
    }, database, 'replace', { authorFields: 'exact', feedbackRequestHash })
  }).immediate()
}
