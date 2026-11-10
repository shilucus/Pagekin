import { createHash } from 'node:crypto'
import type { BlueprintData } from '../../electron/repositories/blueprint-repository'
import type { BlueprintNewCharacterCandidate } from './blueprint-semantic-contract'
import { BLUEPRINT_FEEDBACK_FIELDS, type BlueprintFeedbackField } from './planning-feedback'

export { BLUEPRINT_FEEDBACK_FIELDS, type BlueprintFeedbackField } from './planning-feedback'

export interface BlueprintRelationshipHint {
  from: string
  to: string
  relation: string
}

export interface BlueprintFeedbackChanges {
  title?: string
  role?: string
  purpose?: string
  keyEvents?: string
  characters?: string[]
  suspenseHook?: string
  userGuidance?: string
  notes?: string
  newCharacterCandidates?: BlueprintNewCharacterCandidate[]
  relationshipHints?: BlueprintRelationshipHint[]
}

export type BlueprintFeedbackValidationResult =
  | { valid: true; changes: BlueprintFeedbackChanges }
  | { valid: false; error: string }

/**
 * 严格校验蓝图手改与局部修订载荷：
 * 1. 字段必须属于已声明的合法蓝图字段，未选字段绝不自动补齐；
 * 2. 文本字段必须为非空规范文本；
 * 3. characters 必须为字符串数组，且元素不能重复或为空白；
 * 4. 身份与关系闭包（Identity Closure）：若指定了新角色候选或关系，其提及的角色必须在 characters 列表中闭合；
 * 5. 校验失败时返回明确错误，防止脏数据流入正式提交事务。
 */
export function validateBlueprintFeedbackChanges(
  changes: unknown,
  existingCharacters: readonly string[] = [],
): BlueprintFeedbackValidationResult {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { valid: false, error: 'BLUEPRINT_CHANGES_INVALID_OBJECT' }
  }

  const raw = changes as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.length === 0) {
    return { valid: false, error: 'BLUEPRINT_CHANGES_EMPTY' }
  }

  const allowedKeys = new Set<string>([
    ...BLUEPRINT_FEEDBACK_FIELDS,
    'newCharacterCandidates',
    'relationshipHints',
  ])

  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `BLUEPRINT_UNKNOWN_FIELD_${key}` }
    }
  }

  const stringFields: BlueprintFeedbackField[] = [
    'title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes',
  ]

  for (const field of stringFields) {
    if (Object.hasOwn(raw, field)) {
      const val = raw[field]
      if (typeof val !== 'string') {
        return { valid: false, error: `BLUEPRINT_FIELD_NOT_STRING_${field}` }
      }
    }
  }

  let effectiveCharacters: Set<string>
  if (Object.hasOwn(raw, 'characters')) {
    const chars = raw.characters
    if (!Array.isArray(chars) || chars.some(c => typeof c !== 'string' || !c.trim())) {
      return { valid: false, error: 'BLUEPRINT_CHARACTERS_INVALID' }
    }
    const set = new Set<string>()
    for (const c of chars) {
      const trimmed = c.trim()
      if (set.has(trimmed)) {
        return { valid: false, error: `BLUEPRINT_CHARACTER_DUPLICATE_${trimmed}` }
      }
      set.add(trimmed)
    }
    effectiveCharacters = set
  } else {
    effectiveCharacters = new Set(existingCharacters)
  }

  // 校验新角色候选（newCharacterCandidates）
  if (Object.hasOwn(raw, 'newCharacterCandidates')) {
    const candidates = raw.newCharacterCandidates
    if (!Array.isArray(candidates)) {
      return { valid: false, error: 'BLUEPRINT_NEW_CHARACTERS_NOT_ARRAY' }
    }
    for (const item of candidates) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) {
        return { valid: false, error: 'BLUEPRINT_NEW_CHARACTER_MALFORMED' }
      }
      // 新角色候选必须在当前有效 characters 中闭合
      if (!effectiveCharacters.has(item.name.trim())) {
        return { valid: false, error: `BLUEPRINT_NEW_CHARACTER_UNCLOSED_${item.name}` }
      }
    }
  }

  // 校验角色关系（relationshipHints）
  if (Object.hasOwn(raw, 'relationshipHints')) {
    const relations = raw.relationshipHints
    if (!Array.isArray(relations)) {
      return { valid: false, error: 'BLUEPRINT_RELATIONSHIPS_NOT_ARRAY' }
    }
    for (const rel of relations) {
      if (!rel || typeof rel !== 'object' || typeof rel.from !== 'string' || typeof rel.to !== 'string' || typeof rel.relation !== 'string') {
        return { valid: false, error: 'BLUEPRINT_RELATIONSHIP_MALFORMED' }
      }
      const fromTrimmed = rel.from.trim()
      const toTrimmed = rel.to.trim()
      if (!effectiveCharacters.has(fromTrimmed)) {
        return { valid: false, error: `BLUEPRINT_RELATIONSHIP_UNCLOSED_FROM_${fromTrimmed}` }
      }
      if (!effectiveCharacters.has(toTrimmed)) {
        return { valid: false, error: `BLUEPRINT_RELATIONSHIP_UNCLOSED_TO_${toTrimmed}` }
      }
    }
  }

  return { valid: true, changes: raw as BlueprintFeedbackChanges }
}

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
