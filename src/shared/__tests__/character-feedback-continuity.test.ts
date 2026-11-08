import { describe, expect, it } from 'vitest'
import {
  assertCharacterRegenerationAllowed,
  validateCharacterFeedbackProposal,
  validateFinalizedReplacementPolicy,
  validateManuscriptReviewRefineContext,
  verifyInPlaceMergeSemantics,
} from '../character-feedback-continuity'
import type { HumanConfirmedReviewSnapshot } from '../human-confirmed-review'
import type { ReplacementImpact } from '../chapter-reopen'

describe('character-feedback-continuity (FEEDBACK-004)', () => {
  describe('AC-1: 角色字段反馈走身份提议与已有蓝图防重生门禁', () => {
    it('对已有稳定角色进行意见修改时映射到已有 characterId，保留身份标识与静态字段', () => {
      const result = validateCharacterFeedbackProposal({
        characterId: 'char-id-42',
        name: '周砚',
        fields: {
          appearance: '一袭墨青长袍，腰佩寒玉',
          personality: '沉稳缜密，不轻易表露喜怒',
          abilities: '天水剑法第六重',
        },
      })

      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.decision).toEqual({
          selectionKey: 'char-fb-char-id-42',
          action: 'map',
          characterId: 'char-id-42',
        })
        expect(result.sanitizedFields.name).toBe('周砚')
        expect(result.sanitizedFields.appearance).toContain('一袭墨青长袍')
      }
    })

    it('反馈提出新角色时适配为显式创建候选，名称为空时拒绝', () => {
      const newChar = validateCharacterFeedbackProposal({
        name: '新伙伴苏灵',
        fields: {
          role: 'supporting',
          personality: '古灵精怪',
        },
      })

      expect(newChar.valid).toBe(true)
      if (newChar.valid) {
        expect(newChar.decision).toEqual({
          selectionKey: 'char-fb-new-新伙伴苏灵',
          action: 'create',
        })
      }

      const emptyName = validateCharacterFeedbackProposal({
        name: '   ',
        fields: {},
      })
      expect(emptyName.valid).toBe(false)
      if (!emptyName.valid) {
        expect(emptyName.error).toBe('CHARACTER_FEEDBACK_NAME_REQUIRED')
      }
    })

    it('当已有章节蓝图时（blueprintCount > 0），严格阻断整批角色卡重新生成（AC-1）', () => {
      expect(assertCharacterRegenerationAllowed(0)).toEqual({ allowed: true })

      const blocked = assertCharacterRegenerationAllowed(5)
      expect(blocked.allowed).toBe(false)
      expect(blocked.reason).toBe('CHARACTER_REGEN_BLOCKED_BY_EXISTING_BLUEPRINTS')
    })
  })

  describe('AC-2: 正文沿用真实人审来源与合并/复验，不把就地合并描述为每轮自动创建不可变新稿', () => {
    const validSnapshot: HumanConfirmedReviewSnapshot = {
      kind: 'human-confirmed-review',
      schemaVersion: 1,
      sourceReviewId: 101,
      sourceDraft: {
        id: 12,
        chapterNumber: 3,
        version: 1,
        status: 'draft',
        content: '第三章原始底稿正文...',
      },
      summary: '修稿意见汇总',
      authorGuidance: '增强决战压迫感',
      items: [
        {
          category: '节奏',
          severity: '中',
          description: '前半段推进过慢',
          decision: 'apply',
          origin: 'ai',
        },
      ],
    }

    it('正文修稿必须具备有效的人审快照与真实 sourceReviewId 绑定', () => {
      // 正常合法快照
      expect(
        validateManuscriptReviewRefineContext({
          reviewSourceId: 101,
          confirmedSnapshot: validSnapshot,
        }),
      ).toEqual({ valid: true })

      // 缺失快照
      expect(
        validateManuscriptReviewRefineContext({
          reviewSourceId: 101,
          confirmedSnapshot: null,
        }),
      ).toEqual({
        valid: false,
        error: 'HUMAN_CONFIRMED_REVIEW_MISSING',
      })

      // sourceReviewId 不匹配
      expect(
        validateManuscriptReviewRefineContext({
          reviewSourceId: 999,
          confirmedSnapshot: validSnapshot,
        }),
      ).toEqual({
        valid: false,
        error: 'REVIEW_SNAPSHOT_SOURCE_MISMATCH',
      })

      // 没有选中的审修项且无作者指导
      const emptyItemsSnapshot: HumanConfirmedReviewSnapshot = {
        ...validSnapshot,
        authorGuidance: '',
        items: [
          {
            ...validSnapshot.items[0],
            decision: 'ignore',
          },
        ],
      }
      expect(
        validateManuscriptReviewRefineContext({
          reviewSourceId: 101,
          confirmedSnapshot: emptyItemsSnapshot,
        }),
      ).toEqual({
        valid: false,
        error: 'REVIEW_ITEMS_NONE_INCLUDED',
      })
    })

    it('差异合并就地更新目标草稿，不把就地合并描述为每轮自动创建不可变新稿（AC-2）', () => {
      // 合法的就地合并更新
      const merge = verifyInPlaceMergeSemantics({
        targetDraftId: 12,
        baseDraftId: 12,
        mergedContent: '合并后的全新正文内容',
        newDraftVersionMinted: false,
      })
      expect(merge.inPlace).toBe(true)
      expect(merge.idempotent).toBe(true)

      // 试图将就地合并曲解/实施为每轮自动虚增不可变新草稿版本
      const invalidVersionMint = verifyInPlaceMergeSemantics({
        targetDraftId: 12,
        baseDraftId: 12,
        mergedContent: '合并正文',
        newDraftVersionMinted: true,
      })
      expect(invalidVersionMint.inPlace).toBe(false)
      expect(invalidVersionMint.error).toBe('MERGE_MUST_NOT_MINT_NEW_DRAFT_VERSION')
    })
  })

  describe('AC-3: 定稿修改仍先重开；影响提示不自动改后续，不声称覆盖所有语义矛盾或后续定稿全文', () => {
    const syntheticImpact: ReplacementImpact = {
      chapterNumber: 2,
      finalizationId: 'fin-rep-2',
      laterChapters: [3, 4],
      blueprintOnlyChapters: [5],
      characters: ['主角', '配角'],
      unmovedConfirmations: [],
    }

    it('已定稿章节修改必须具有打开的重开草稿关系，否则拒绝', () => {
      // 试图不重开直接修改已定稿章节
      const directModify = validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: false,
        impact: syntheticImpact,
      })
      expect(directModify.allowed).toBe(false)
      expect(directModify.error).toBe('CHAPTER_FINALIZED_REOPEN_REQUIRED')

      // 正确走重开流程的草稿
      const reopenModify = validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: true,
        impact: syntheticImpact,
      })
      expect(reopenModify.allowed).toBe(true)
    })

    it('影响提示仅作作者警示提示，严禁自动级联修改后续章节或声称覆盖所有语义矛盾（AC-3）', () => {
      // 试图自动修改后续章节 -> 硬拦截
      const autoModify = validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: true,
        impact: syntheticImpact,
        autoModifyLaterChapters: true,
      })
      expect(autoModify.allowed).toBe(false)
      expect(autoModify.error).toBe('AUTO_MODIFY_LATER_CHAPTERS_PROHIBITED')

      // 试图虚假声称覆盖后续所有语义矛盾 -> 硬拦截
      const falseClaim = validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: true,
        impact: syntheticImpact,
        claimsCompleteSemanticResolution: true,
      })
      expect(falseClaim.allowed).toBe(false)
      expect(falseClaim.error).toBe('CLAIMS_COMPLETE_SEMANTIC_RESOLUTION_PROHIBITED')
    })
  })
})
