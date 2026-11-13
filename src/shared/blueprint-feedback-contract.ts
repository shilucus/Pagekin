import { createHash } from 'node:crypto'
import type { BlueprintData } from '../../electron/repositories/blueprint-repository'
import type { BlueprintFeedbackChanges } from './blueprint-feedback-validation'

export { BLUEPRINT_FEEDBACK_FIELDS, type BlueprintFeedbackField } from './planning-feedback'
export {
  validateBlueprintFeedbackChanges,
  type BlueprintRelationshipHint,
  type BlueprintFeedbackChanges,
  type BlueprintFeedbackValidationResult,
} from './blueprint-feedback-validation'

/**
 * 将手改或修订建议字段精确应用到现有蓝图上：
 * 只有在 changes 中明确包含的键会被更新；未包含的字段 100% 保持当前底稿值。
 */
export function applyBlueprintFeedbackChanges(
  current: BlueprintData,
  changes: BlueprintFeedbackChanges,
): BlueprintData {
  return {
    chapterNumber: current.chapterNumber,
    title: changes.title !== undefined ? changes.title : current.title,
    role: changes.role !== undefined ? changes.role : current.role,
    purpose: changes.purpose !== undefined ? changes.purpose : current.purpose,
    keyEvents: changes.keyEvents !== undefined ? changes.keyEvents : current.keyEvents,
    characters: changes.characters !== undefined ? [...changes.characters] : [...current.characters],
    newCharacterCandidates: changes.newCharacterCandidates !== undefined
      ? structuredClone(changes.newCharacterCandidates)
      : (current.newCharacterCandidates ? structuredClone(current.newCharacterCandidates) : undefined),
    relationshipHints: changes.relationshipHints !== undefined
      ? structuredClone(changes.relationshipHints)
      : (current.relationshipHints ? structuredClone(current.relationshipHints) : undefined),
    suspenseHook: changes.suspenseHook !== undefined ? changes.suspenseHook : current.suspenseHook,
    userGuidance: changes.userGuidance !== undefined ? changes.userGuidance : current.userGuidance,
    notes: changes.notes !== undefined ? changes.notes : current.notes,
    notesUpdatedAt: current.notesUpdatedAt,
  }
}

/** 计算蓝图修订载荷哈希 */
export function blueprintFeedbackPayloadHash(
  chapterNumber: number,
  changes: BlueprintFeedbackChanges,
): string {
  const sorted = Object.keys(changes).sort().map(k => [k, (changes as Record<string, unknown>)[k]])
  return createHash('sha256').update(JSON.stringify([chapterNumber, sorted])).digest('hex')
}
