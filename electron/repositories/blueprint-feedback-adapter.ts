import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  type BlueprintData,
  type BlueprintRangeCommitReceipt,
  BlueprintRepository,
} from './blueprint-repository'
import {
  applyBlueprintFeedbackChanges,
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
 * 2. 读取当前在库蓝图并比对 baseHash，若已被外部修改则抛出 BLUEPRINT_SOURCE_CONFLICT，零写入；
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

  const current = BlueprintRepository.getByChapter(request.chapterNumber, db)
  if (!current) {
    throw new Error('BLUEPRINT_NOT_FOUND')
  }

  const currentHash = blueprintContentHash(current)
  if (currentHash !== request.baseHash) {
    throw new Error('BLUEPRINT_SOURCE_CONFLICT')
  }

  const validated = validateBlueprintFeedbackChanges(request.changes, current.characters)
  if (!validated.valid) {
    throw new Error(`BLUEPRINT_VALIDATION_FAILED: ${validated.error}`)
  }

  const updated = applyBlueprintFeedbackChanges(current, validated.changes)

  return BlueprintRepository.commitRange(
    {
      mode: 'replace-range',
      operationId: request.operationId,
      startChapter: request.chapterNumber,
      endChapter: request.chapterNumber,
      blueprints: [updated],
    },
    undefined,
    db,
  )
}
