import type {
  CharacterStaticFields,
  CharacterProposalDecision,
} from './character-proposal'
import type { HumanConfirmedReviewSnapshot } from './human-confirmed-review'
import type { ReplacementImpact } from './chapter-reopen'

/**
 * 角色字段意见反馈输入
 */
export interface CharacterFeedbackInput {
  characterId?: string
  name: string
  role?: string
  fields: Partial<CharacterStaticFields>
  edits?: Record<string, string>
}

/**
 * 校验角色反馈并适配为身份提议决策 (AC-1)
 */
export function validateCharacterFeedbackProposal(
  input: CharacterFeedbackInput,
): {
  valid: true
  decision: CharacterProposalDecision
  sanitizedFields: Partial<CharacterStaticFields>
} | {
  valid: false
  error: string
} {
  const trimmedName = input.name?.trim()
  if (!trimmedName) {
    return { valid: false, error: 'CHARACTER_FEEDBACK_NAME_REQUIRED' }
  }

  // 若提供了现有角色标识符，必须映射到稳定角色 ID，保留既有身份
  if (input.characterId) {
    const trimmedId = input.characterId.trim()
    if (!trimmedId) {
      return { valid: false, error: 'CHARACTER_FEEDBACK_ID_INVALID' }
    }
    return {
      valid: true,
      decision: {
        selectionKey: `char-fb-${trimmedId}`,
        action: 'map',
        characterId: trimmedId,
      },
      sanitizedFields: {
        ...input.fields,
        name: trimmedName,
      },
    }
  }

  // 新角色候选：显式创建
  return {
    valid: true,
    decision: {
      selectionKey: `char-fb-new-${trimmedName}`,
      action: 'create',
    },
    sanitizedFields: {
      ...input.fields,
      name: trimmedName,
    },
  }
}

/**
 * 已有蓝图时禁止整批角色重新生成门禁断言 (AC-1)
 */
export function assertCharacterRegenerationAllowed(blueprintCount: number): {
  allowed: boolean
  reason?: string
} {
  if (!Number.isSafeInteger(blueprintCount) || blueprintCount < 0) {
    throw new Error('BLUEPRINT_COUNT_INVALID')
  }

  if (blueprintCount > 0) {
    return {
      allowed: false,
      reason: 'CHARACTER_REGEN_BLOCKED_BY_EXISTING_BLUEPRINTS',
    }
  }

  return { allowed: true }
}

/**
 * 正文修稿人审快照与就地合并契约校验 (AC-2)
 */
export function validateManuscriptReviewRefineContext(params: {
  reviewSourceId: number
  confirmedSnapshot: HumanConfirmedReviewSnapshot | null | undefined
}): {
  valid: boolean
  error?: string
} {
  if (!Number.isSafeInteger(params.reviewSourceId) || params.reviewSourceId <= 0) {
    return { valid: false, error: 'REVIEW_SOURCE_ID_INVALID' }
  }

  if (!params.confirmedSnapshot) {
    return { valid: false, error: 'HUMAN_CONFIRMED_REVIEW_MISSING' }
  }

  if (params.confirmedSnapshot.sourceReviewId !== params.reviewSourceId) {
    return { valid: false, error: 'REVIEW_SNAPSHOT_SOURCE_MISMATCH' }
  }

  if (!params.confirmedSnapshot.sourceDraft || !params.confirmedSnapshot.sourceDraft.content) {
    return { valid: false, error: 'REVIEW_SOURCE_DRAFT_EMPTY' }
  }

  const hasIncluded = params.confirmedSnapshot.items.some(
    item => item.decision === 'apply',
  )
  if (!hasIncluded && !params.confirmedSnapshot.authorGuidance?.trim()) {
    return { valid: false, error: 'REVIEW_ITEMS_NONE_INCLUDED' }
  }

  return { valid: true }
}

/**
 * 校验就地合并语义：确保就地合并更新同一草稿，不虚增不可变历史版本 (AC-2)
 */
export function verifyInPlaceMergeSemantics(params: {
  targetDraftId: number
  baseDraftId: number
  mergedContent: string
  newDraftVersionMinted?: boolean
}): {
  inPlace: boolean
  idempotent: boolean
  error?: string
} {
  if (params.targetDraftId !== params.baseDraftId) {
    return {
      inPlace: false,
      idempotent: false,
      error: 'REVISION_TARGET_MISMATCH',
    }
  }

  // 严禁在就地合并时自动为每一轮创建不可变新草稿版本
  if (params.newDraftVersionMinted) {
    return {
      inPlace: false,
      idempotent: false,
      error: 'MERGE_MUST_NOT_MINT_NEW_DRAFT_VERSION',
    }
  }

  return {
    inPlace: true,
    idempotent: true,
  }
}

/**
 * 定稿修改重开门禁与下游影响政策校验 (AC-3)
 */
export function validateFinalizedReplacementPolicy(params: {
  chapterFinalized: boolean
  isReopenedDraft: boolean
  impact: ReplacementImpact | null
  autoModifyLaterChapters?: boolean
  claimsCompleteSemanticResolution?: boolean
}): {
  allowed: boolean
  error?: string
} {
  // 若章节已定稿，修改必须通过打开的重开草稿
  if (params.chapterFinalized && !params.isReopenedDraft) {
    return {
      allowed: false,
      error: 'CHAPTER_FINALIZED_REOPEN_REQUIRED',
    }
  }

  // 严禁自动级联修改后续章节
  if (params.autoModifyLaterChapters) {
    return {
      allowed: false,
      error: 'AUTO_MODIFY_LATER_CHAPTERS_PROHIBITED',
    }
  }

  // 严禁虚假声称已自动覆盖/解决后续所有语义矛盾或全文
  if (params.claimsCompleteSemanticResolution) {
    return {
      allowed: false,
      error: 'CLAIMS_COMPLETE_SEMANTIC_RESOLUTION_PROHIBITED',
    }
  }

  return { allowed: true }
}
