import { describe, expect, it } from 'vitest'
import {
  applyBlueprintFeedbackChanges,
  blueprintFeedbackPayloadHash,
  validateBlueprintFeedbackChanges,
} from '../blueprint-feedback-contract'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'

function createSampleBlueprint(chapterNumber: number): BlueprintData {
  return {
    chapterNumber,
    title: `第${chapterNumber}章`,
    role: '起',
    purpose: '交代世界观与初始危机',
    keyEvents: '主角在暴风雪夜遭遇强敌，偶然获得残破古剑',
    characters: ['李云', '雪女'],
    suspenseHook: '古剑中传来苍老的声音',
    userGuidance: '注意突出寒冷肃杀的氛围',
    notes: '核心伏笔',
    notesUpdatedAt: '2026-11-08T00:00:00.000Z',
  }
}

describe('blueprint-feedback-contract (FEEDBACK-003)', () => {
  describe('validateBlueprintFeedbackChanges', () => {
    it('接收合法子集字段修改，且未选字段不被自动补充', () => {
      const changes = {
        title: '第1章：风雪夜归人',
        keyEvents: '李云在风雪中觉醒天魔瞳，斩杀追兵',
      }
      const result = validateBlueprintFeedbackChanges(changes, ['李云', '雪女'])
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.changes).toEqual(changes)
        // 未选字段不存在于 changes 中
        expect(result.changes.purpose).toBeUndefined()
        expect(result.changes.role).toBeUndefined()
        expect(result.changes.characters).toBeUndefined()
      }
    })

    it('拒绝非法未知字段，防止非规范字段混入（AC-2）', () => {
      const changes = {
        title: '新标题',
        unauthorizedProperty: 'malicious-data',
      }
      const result = validateBlueprintFeedbackChanges(changes)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toContain('BLUEPRINT_UNKNOWN_FIELD_unauthorizedProperty')
      }
    })

    it('校验文本字段类型，非字符串字段立即拒绝（AC-2）', () => {
      const changes = {
        title: 12345,
      }
      const result = validateBlueprintFeedbackChanges(changes)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toContain('BLUEPRINT_FIELD_NOT_STRING_title')
      }
    })

    it('校验登场角色数组，包含空白或重复角色时拒绝（AC-2）', () => {
      const duplicateResult = validateBlueprintFeedbackChanges({
        characters: ['李云', '苏雪', '李云'],
      })
      expect(duplicateResult.valid).toBe(false)
      if (!duplicateResult.valid) {
        expect(duplicateResult.error).toContain('BLUEPRINT_CHARACTER_DUPLICATE_李云')
      }

      const emptyCharResult = validateBlueprintFeedbackChanges({
        characters: ['李云', '   '],
      })
      expect(emptyCharResult.valid).toBe(false)
      if (!emptyCharResult.valid) {
        expect(emptyCharResult.error).toBe('BLUEPRINT_CHARACTERS_INVALID')
      }
    })

    it('身份与关系闭包（Identity Closure）：新角色候选不在 characters 列表中时拒绝（AC-2）', () => {
      const unclosedResult = validateBlueprintFeedbackChanges({
        characters: ['李云', '苏雪'],
        newCharacterCandidates: [
          { name: '神秘老者', role: 'supporting' },
        ],
      })
      expect(unclosedResult.valid).toBe(false)
      if (!unclosedResult.valid) {
        expect(unclosedResult.error).toContain('BLUEPRINT_NEW_CHARACTER_UNCLOSED_神秘老者')
      }

      const closedResult = validateBlueprintFeedbackChanges({
        characters: ['李云', '苏雪', '神秘老者'],
        newCharacterCandidates: [
          { name: '神秘老者', role: 'supporting' },
        ],
      })
      expect(closedResult.valid).toBe(true)
    })

    it('身份与关系闭包（Identity Closure）：关系源/目标角色不在 characters 列表中时拒绝（AC-2）', () => {
      const unclosedFromResult = validateBlueprintFeedbackChanges({
        characters: ['李云', '苏雪'],
        relationshipHints: [
          { from: '周砚', to: '苏雪', relation: '同盟' },
        ],
      })
      expect(unclosedFromResult.valid).toBe(false)
      if (!unclosedFromResult.valid) {
        expect(unclosedFromResult.error).toContain('BLUEPRINT_RELATIONSHIP_UNCLOSED_FROM_周砚')
      }

      const unclosedToResult = validateBlueprintFeedbackChanges({
        characters: ['李云', '苏雪'],
        relationshipHints: [
          { from: '李云', to: '周砚', relation: '敌对' },
        ],
      })
      expect(unclosedToResult.valid).toBe(false)
      if (!unclosedToResult.valid) {
        expect(unclosedToResult.error).toContain('BLUEPRINT_RELATIONSHIP_UNCLOSED_TO_周砚')
      }

      const closedResult = validateBlueprintFeedbackChanges({
        characters: ['李云', '苏雪', '周砚'],
        relationshipHints: [
          { from: '李云', to: '周砚', relation: '敌对' },
        ],
      })
      expect(closedResult.valid).toBe(true)
    })
  })

  describe('applyBlueprintFeedbackChanges', () => {
    it('仅更新授权指定的字段，其余未选字段 100% 保持当前底稿值（AC-1）', () => {
      const original = createSampleBlueprint(3)
      const changes = {
        title: '第3章：全新风暴',
        suspenseHook: '悬念已更新为暴风雪中的黑影',
      }

      const updated = applyBlueprintFeedbackChanges(original, changes)

      // 选中的字段被更新
      expect(updated.title).toBe('第3章：全新风暴')
      expect(updated.suspenseHook).toBe('悬念已更新为暴风雪中的黑影')

      // 未选中的字段完全保持原值
      expect(updated.chapterNumber).toBe(3)
      expect(updated.role).toBe(original.role)
      expect(updated.purpose).toBe(original.purpose)
      expect(updated.keyEvents).toBe(original.keyEvents)
      expect(updated.characters).toEqual(original.characters)
      expect(updated.userGuidance).toBe(original.userGuidance)
      expect(updated.notes).toBe(original.notes)
      expect(updated.notesUpdatedAt).toBe(original.notesUpdatedAt)
    })
  })

  describe('blueprintFeedbackPayloadHash', () => {
    it('对相同的章号与字段集生成稳定一致的 SHA-256 哈希', () => {
      const hash1 = blueprintFeedbackPayloadHash(3, { title: 'T1', role: 'R1' })
      const hash2 = blueprintFeedbackPayloadHash(3, { role: 'R1', title: 'T1' })
      const hash3 = blueprintFeedbackPayloadHash(3, { title: 'T2', role: 'R1' })

      expect(hash1).toBe(hash2)
      expect(hash1).not.toBe(hash3)
      expect(typeof hash1).toBe('string')
      expect(hash1).toHaveLength(64)
    })
  })
})
