import { useState, useMemo } from 'react'
import { useLocaleStore } from '../../../stores/locale-store'
import { renderDiffProse } from './diff-prose-render'
import { Button } from '../../ui/Button'
import { validateBlueprintFeedbackChanges } from '../../../shared/blueprint-feedback-validation'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import type { Locale } from '../../../i18n/types'
import './planning-feedback.css'

export interface BlueprintFieldsData {
  suspenseHook?: string
  userGuidance?: string
  notes?: string
  characters?: string[]
}

export interface BlueprintFieldFeedbackPanelProps {
  chapterNumber: number
  originalBlueprint: BlueprintFieldsData
  candidateBlueprint: BlueprintFieldsData
  availableCharacters?: string[]
  onAdoptFields: (fields: Partial<BlueprintFieldsData>) => void
  onClose?: () => void
  isSubmitting?: boolean
  locale?: string
}

type BlueprintFieldKey = 'suspenseHook' | 'userGuidance' | 'notes' | 'characters'

export function BlueprintFieldFeedbackPanel({
  chapterNumber,
  originalBlueprint,
  candidateBlueprint,
  availableCharacters = [],
  onAdoptFields,
  onClose,
  isSubmitting = false,
  locale: propLocale,
}: BlueprintFieldFeedbackPanelProps) {
  const storeLocale = useLocaleStore(s => s.locale)
  const currentLocale = propLocale ?? storeLocale
  const isZh = currentLocale.startsWith('zh')

  // 各字段是否被用户勾选采纳（默认全勾选）
  const [selectedFields, setSelectedFields] = useState<Record<BlueprintFieldKey, boolean>>({
    suspenseHook: true,
    userGuidance: true,
    notes: true,
    characters: true,
  })

  const [validationError, setValidationError] = useState<string | null>(null)

  const fieldLabels: Record<BlueprintFieldKey, { zh: string; en: string }> = {
    suspenseHook: { zh: '核心悬念/钩子', en: 'Suspense Hook' },
    userGuidance: { zh: '本章写作指导', en: 'User Guidance' },
    notes: { zh: '策划备注', en: 'Planning Notes' },
    characters: { zh: '登场角色', en: 'Appearing Characters' },
  }

  // 构造用户当前勾选的部分采纳载荷
  const pendingChanges = useMemo(() => {
    const changes: Partial<BlueprintFieldsData> = {}
    if (selectedFields.suspenseHook && candidateBlueprint.suspenseHook !== undefined) {
      changes.suspenseHook = candidateBlueprint.suspenseHook
    }
    if (selectedFields.userGuidance && candidateBlueprint.userGuidance !== undefined) {
      changes.userGuidance = candidateBlueprint.userGuidance
    }
    if (selectedFields.notes && candidateBlueprint.notes !== undefined) {
      changes.notes = candidateBlueprint.notes
    }
    if (selectedFields.characters && candidateBlueprint.characters !== undefined) {
      changes.characters = candidateBlueprint.characters
    }
    return changes
  }, [selectedFields, candidateBlueprint])

  // 校验当前勾选的载荷（利用 shared 契约 validateBlueprintFeedbackChanges，轻量同步求值）
  const selectedCount = Object.values(selectedFields).filter(Boolean).length
  const validationResult = selectedCount === 0
    ? {
        valid: false as const,
        error: isZh ? '请至少勾选一个要采纳的蓝图字段' : 'Please select at least one field to adopt.',
      }
    : (() => {
        const contractResult = validateBlueprintFeedbackChanges(pendingChanges, availableCharacters)
        if (!contractResult.valid) {
          return contractResult
        }
        if (availableCharacters.length > 0 && Array.isArray(pendingChanges.characters)) {
          for (const charId of pendingChanges.characters) {
            if (!availableCharacters.includes(charId)) {
              return {
                valid: false as const,
                error: `BLUEPRINT_FEEDBACK_CHARACTER_UNCLOSED: ${charId}`,
              }
            }
          }
        }
        return contractResult
      })()

  const handleToggleField = (field: BlueprintFieldKey) => {
    setSelectedFields(prev => ({ ...prev, [field]: !prev[field] }))
    setValidationError(null)
  }

  const handleAdopt = () => {
    if (!validationResult.valid) {
      setValidationError(
        displayedErrorMessage(currentLocale as Locale, validationResult.error, isZh ? '蓝图字段校验失败' : 'Blueprint validation failed'),
      )
      return
    }

    setValidationError(null)
    onAdoptFields(pendingChanges)
  }

  return (
    <div className="pf-blueprint-panel" data-testid="blueprint-field-feedback-panel">
      <div className="pf-section">
        <div className="pf-blueprint-header">
          <h3 className="pf-range-title">
            {isZh
              ? `第 ${chapterNumber} 章蓝图微调反馈`
              : `Chapter ${chapterNumber} Blueprint Feedback`}
          </h3>
          <span className="pf-badge pf-badge-safe" data-testid="blueprint-isolation-badge">
            {isZh
              ? `单章隔离：仅修改第 ${chapterNumber} 章，不影响其他章节蓝图`
              : `Isolated: Modifies Ch. ${chapterNumber} only`}
          </span>
        </div>
      </div>

      {(validationError || (!validationResult.valid && Object.values(selectedFields).some(Boolean))) && (
        <div className="pf-error-box" role="alert" data-testid="blueprint-validation-error">
          {validationError ?? (!validationResult.valid
            ? displayedErrorMessage(currentLocale as Locale, validationResult.error, isZh ? '蓝图字段校验失败' : 'Blueprint validation failed')
            : null)}
        </div>
      )}

      {/* 字段级勾选与 Diff 对比 */}
      <div className="pf-section pf-blueprint-fields-list">
        {(Object.keys(fieldLabels) as BlueprintFieldKey[]).map(fieldKey => {
          const isSelected = selectedFields[fieldKey]
          const label = isZh ? fieldLabels[fieldKey].zh : fieldLabels[fieldKey].en

          let origVal = ''
          let candVal = ''

          if (fieldKey === 'characters') {
            origVal = (originalBlueprint.characters ?? []).join('、')
            candVal = (candidateBlueprint.characters ?? []).join('、')
          } else {
            origVal = originalBlueprint[fieldKey] ?? ''
            candVal = candidateBlueprint[fieldKey] ?? ''
          }

              return (
                <div
                  key={fieldKey}
                  className={`pf-blueprint-field-card ${isSelected ? 'is-selected' : 'is-unselected'}`}
                  data-testid={`field-card-${fieldKey}`}
                >
                  <div className="pf-blueprint-field-header">
                    <label className="pf-blueprint-checkbox-label">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleField(fieldKey)}
                        disabled={isSubmitting}
                        data-testid={`checkbox-${fieldKey}`}
                      />
                      <span className="pf-blueprint-field-name">{label}</span>
                    </label>
                    <span className="pf-blueprint-select-hint">
                      {isSelected
                        ? (isZh ? '已勾选采纳' : 'Selected for adoption')
                        : (isZh ? '保留原蓝图内容' : 'Keep original')}
                    </span>
                  </div>

                  <div className="pf-blueprint-field-diff">
                    <div className="pf-diff-view">
                      {origVal === '' && candVal === '' ? (
                        <span className="pf-diff-eq">{isZh ? '（无变动）' : '(No change)'}</span>
                      ) : (
                        renderDiffProse(origVal, candVal)
                      )}
                    </div>
                  </div>
                </div>
              )
        })}
      </div>

      {/* 底部操作区 */}
      <div className="pf-footer">
        <div className="pf-hint-text">
          {isZh
            ? '勾选的字段将以单章替换范围（replace-range）提交，未勾选的字段保持当前蓝图原状。'
            : 'Selected fields will be updated via replace-range. Unselected fields remain unchanged.'}
        </div>
        <div className="pf-footer-actions">
          {onClose && (
            <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
              {isZh ? '取消' : 'Cancel'}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleAdopt}
            disabled={!validationResult.valid || isSubmitting}
            data-testid="adopt-blueprint-fields-button"
          >
            {isZh ? '采纳勾选的蓝图字段' : 'Adopt Selected Fields'}
          </Button>
        </div>
      </div>
    </div>
  )
}
