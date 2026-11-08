import { InkDialog } from '../InkDialog'
import { useLocaleStore } from '../../../stores/locale-store'
import {
  PlanningFeedbackDialog,
  type PlanningFeedbackDialogProps,
} from './PlanningFeedbackDialog'
import {
  OutlineRangeFeedbackPanel,
  type OutlineChapterItem,
  type OutlineRangeAdoptPayload,
} from './OutlineRangeFeedbackPanel'
import {
  BlueprintFieldFeedbackPanel,
  type BlueprintFieldsData,
} from './BlueprintFieldFeedbackPanel'
import {
  CharacterProposalFeedbackPanel,
  type CharacterProposalItem,
} from './CharacterProposalFeedbackPanel'
import {
  ManuscriptReviewFeedbackPanel,
  type ManuscriptReviewSnapshotData,
} from './ManuscriptReviewFeedbackPanel'
import './planning-feedback.css'

export type ExtendedFeedbackMode =
  | 'config'
  | 'outline-range'
  | 'blueprint-field'
  | 'character-proposal'
  | 'manuscript-review'

export interface ExtendedPlanningFeedbackDialogProps {
  isOpen: boolean
  onClose: () => void
  mode: ExtendedFeedbackMode
  title?: string

  // 1. config 模式专有属性
  configProps?: Omit<PlanningFeedbackDialogProps, 'isOpen' | 'onClose'>

  // 2. outline-range 模式专有属性
  outlineRangeProps?: {
    totalChapters: number
    originalChapters: OutlineChapterItem[]
    candidateChapters: OutlineChapterItem[]
    onAdoptRange: (payload: OutlineRangeAdoptPayload) => void
    defaultStartChapter?: number
    defaultEndChapter?: number
  }

  // 3. blueprint-field 模式专有属性
  blueprintFieldProps?: {
    chapterNumber: number
    originalBlueprint: BlueprintFieldsData
    candidateBlueprint: BlueprintFieldsData
    availableCharacters?: string[]
    onAdoptFields: (fields: Partial<BlueprintFieldsData>) => void
  }

  // 4. character-proposal 模式专有属性
  characterProposalProps?: {
    proposals: CharacterProposalItem[]
    hasExistingBlueprints: boolean
    onAdoptProposals: (adopted: CharacterProposalItem[]) => void
  }

  // 5. manuscript-review 模式专有属性
  manuscriptReviewProps?: {
    isFinalized: boolean
    chapterNumber: number
    reviewSnapshot?: ManuscriptReviewSnapshotData
    diffText?: {
      original: string
      revised: string
    }
    onReopenDraft?: () => void
    onMergeInPlace?: () => void
  }

  isSubmitting?: boolean
  locale?: string
}

export function ExtendedPlanningFeedbackDialog({
  isOpen,
  onClose,
  mode,
  title,
  configProps,
  outlineRangeProps,
  blueprintFieldProps,
  characterProposalProps,
  manuscriptReviewProps,
  isSubmitting = false,
  locale: propLocale,
}: ExtendedPlanningFeedbackDialogProps) {
  const storeLocale = useLocaleStore(s => s.locale)
  const currentLocale = propLocale ?? storeLocale
  const isZh = currentLocale.startsWith('zh')

  if (!isOpen) return null

  // 若为旧的 config 模式，直接委托给 PlanningFeedbackDialog
  if (mode === 'config' && configProps) {
    return (
      <PlanningFeedbackDialog
        {...configProps}
        isOpen={isOpen}
        onClose={onClose}
      />
    )
  }

  const defaultTitles: Record<ExtendedFeedbackMode, { zh: string; en: string }> = {
    'config': { zh: '配置规划反馈', en: 'Config Planning Feedback' },
    'outline-range': { zh: '大纲章节范围反馈', en: 'Outline Range Feedback' },
    'blueprint-field': { zh: '章节蓝图字段反馈', en: 'Chapter Blueprint Feedback' },
    'character-proposal': { zh: '角色身份与提议反馈', en: 'Character Proposal Feedback' },
    'manuscript-review': { zh: '正文审修与合并反馈', en: 'Manuscript Review Feedback' },
  }

  const dialogTitle =
    title ?? (isZh ? defaultTitles[mode].zh : defaultTitles[mode].en)

  return (
    <InkDialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      title={dialogTitle}
      footer={null}
    >
      <div className="extended-feedback-container" data-testid="extended-feedback-container">
        {mode === 'outline-range' && outlineRangeProps && (
          <OutlineRangeFeedbackPanel
            {...outlineRangeProps}
            onClose={onClose}
            isSubmitting={isSubmitting}
            locale={currentLocale}
          />
        )}

        {mode === 'blueprint-field' && blueprintFieldProps && (
          <BlueprintFieldFeedbackPanel
            {...blueprintFieldProps}
            onClose={onClose}
            isSubmitting={isSubmitting}
            locale={currentLocale}
          />
        )}

        {mode === 'character-proposal' && characterProposalProps && (
          <CharacterProposalFeedbackPanel
            {...characterProposalProps}
            onClose={onClose}
            isSubmitting={isSubmitting}
            locale={currentLocale}
          />
        )}

        {mode === 'manuscript-review' && manuscriptReviewProps && (
          <ManuscriptReviewFeedbackPanel
            {...manuscriptReviewProps}
            onClose={onClose}
            isSubmitting={isSubmitting}
            locale={currentLocale}
          />
        )}
      </div>
    </InkDialog>
  )
}
