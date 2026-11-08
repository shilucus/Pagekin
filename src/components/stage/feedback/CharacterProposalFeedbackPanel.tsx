import { useState } from 'react'
import { useLocaleStore } from '../../../stores/locale-store'
import { renderDiffProse } from './diff-prose-render'
import { Button } from '../../ui/Button'
import { validateCharacterFeedbackProposal } from '../../../shared/character-feedback-continuity'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import type { Locale } from '../../../i18n/types'
import type { CharacterRole } from '../../../shared/character-role'
import './planning-feedback.css'

export interface CharacterProposalItem {
  characterId?: string
  name: string
  role?: CharacterRole
  personality?: string
  background?: string
  appearance?: string
  action: 'map' | 'create'
  originalFields?: {
    name?: string
    role?: CharacterRole
    personality?: string
    background?: string
    appearance?: string
  }
}

export interface CharacterProposalFeedbackPanelProps {
  proposals: CharacterProposalItem[]
  hasExistingBlueprints: boolean
  onAdoptProposals: (adoptedProposals: CharacterProposalItem[]) => void
  onClose?: () => void
  isSubmitting?: boolean
  locale?: string
}

export function CharacterProposalFeedbackPanel({
  proposals,
  hasExistingBlueprints,
  onAdoptProposals,
  onClose,
  isSubmitting = false,
  locale: propLocale,
}: CharacterProposalFeedbackPanelProps) {
  const storeLocale = useLocaleStore(s => s.locale)
  const currentLocale = propLocale ?? storeLocale
  const isZh = currentLocale.startsWith('zh')

  // 每个提案是否勾选采纳
  const [selectedIndices, setSelectedIndices] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {}
    proposals.forEach((_, idx) => {
      init[idx] = true
    })
    return init
  })

  const [validationError, setValidationError] = useState<string | null>(null)

  const handleToggleSelect = (idx: number) => {
    setSelectedIndices(prev => ({ ...prev, [idx]: !prev[idx] }))
    setValidationError(null)
  }

  const selectedProposals = proposals.filter((_, idx) => selectedIndices[idx])

  const handleAdopt = () => {
    if (selectedProposals.length === 0) {
      setValidationError(
        isZh ? '请至少勾选一个角色提议进行采纳' : 'Please select at least one proposal to adopt.',
      )
      return
    }

    // 逐一校验选中的 proposal
    for (const p of selectedProposals) {
      const validation = validateCharacterFeedbackProposal({
        characterId: p.characterId,
        name: p.name,
        fields: {
          role: p.role,
          personality: p.personality,
          background: p.background,
          appearance: p.appearance,
        },
      })

      if (!validation.valid) {
        setValidationError(
          displayedErrorMessage(currentLocale as Locale, validation.error, isZh ? `角色 [${p.name}] 校验失败` : `Character [${p.name}] validation failed`),
        )
        return
      }
    }

    setValidationError(null)
    onAdoptProposals(selectedProposals)
  }

  return (
    <div className="pf-character-panel" data-testid="character-proposal-feedback-panel">
      <div className="pf-section">
        <div className="pf-character-header">
          <h3 className="pf-range-title">
            {isZh ? '角色提议与身份衔接反馈' : 'Character Proposal & Identity Feedback'}
          </h3>
          <span className="pf-badge pf-badge-safe" data-testid="identity-preservation-badge">
            {isZh
              ? '身份保护：映射稳定角色ID，保留作者自定字段'
              : 'Identity Protected: Maps stable IDs, preserves author fields'}
          </span>
        </div>

        {/* 蓝图存在时的硬门禁警示 */}
        {hasExistingBlueprints && (
          <div
            className="pf-warning-banner"
            role="alert"
            data-testid="blueprint-character-lock-notice"
          >
            <span className="pf-warning-icon">⚠️</span>
            <span>
              {isZh
                ? '提示：当前书籍已有章节蓝图依赖现有角色，整批角色重新生成已被锁定，仅允许通过稳定 ID 的提议进行增量修订。'
                : 'Notice: Existing chapter blueprints depend on current characters. Full batch regeneration is locked; only stable ID proposal adjustments are permitted.'}
            </span>
          </div>
        )}
      </div>

      {validationError && (
        <div className="pf-error-box" role="alert" data-testid="character-validation-error">
          {validationError}
        </div>
      )}

      {/* 角色提议卡片列表 */}
      <div className="pf-section pf-character-cards-list">
        {proposals.length === 0 ? (
          <div className="pf-empty-notice">
            {isZh ? '暂无角色微调提议' : 'No character proposals available'}
          </div>
        ) : (
          proposals.map((proposal, idx) => {
            const isSelected = !!selectedIndices[idx]
            const isMap = proposal.action === 'map'
            const orig = proposal.originalFields ?? {}

            return (
              <div
                key={proposal.characterId ?? `new-${idx}`}
                className={`pf-character-card ${isSelected ? 'is-selected' : 'is-unselected'}`}
                data-testid={`character-card-${idx}`}
              >
                <div className="pf-character-card-header">
                  <label className="pf-blueprint-checkbox-label">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleToggleSelect(idx)}
                      disabled={isSubmitting}
                      data-testid={`checkbox-char-${idx}`}
                    />
                    <span className="pf-character-name">{proposal.name}</span>
                  </label>

                  <span
                    className={`pf-character-action-badge ${isMap ? 'badge-map' : 'badge-create'}`}
                  >
                    {isMap
                      ? (isZh
                          ? `映射现有角色 (${proposal.characterId})`
                          : `Map to ${proposal.characterId}`)
                      : (isZh ? '新增角色提议' : 'Create New Character')}
                  </span>
                </div>

                <div className="pf-character-card-body">
                  {/* 身份/定位 diff */}
                  <div className="pf-char-attr-row">
                    <span className="pf-char-attr-key">{isZh ? '角色定位：' : 'Role:'}</span>
                    <span className="pf-char-attr-val">
                      {renderDiffProse(orig.role ?? '', proposal.role ?? '')}
                    </span>
                  </div>

                  {/* 性格特点 diff */}
                  <div className="pf-char-attr-row">
                    <span className="pf-char-attr-key">{isZh ? '性格特征：' : 'Personality:'}</span>
                    <span className="pf-char-attr-val">
                      {renderDiffProse(orig.personality ?? '', proposal.personality ?? '')}
                    </span>
                  </div>

                  {/* 背景设定 diff */}
                  {proposal.background !== undefined && (
                    <div className="pf-char-attr-row">
                      <span className="pf-char-attr-key">{isZh ? '背景故事：' : 'Background:'}</span>
                      <span className="pf-char-attr-val">
                        {renderDiffProse(orig.background ?? '', proposal.background ?? '')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 底部操作区 */}
      <div className="pf-footer">
        <div className="pf-hint-text">
          {isZh
            ? '采纳选中的角色提议将保留作者原生字段与派生快照，零写库清空既有蓝图。'
            : 'Adopting selected proposals preserves author fields and snapshots without wiping blueprints.'}
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
            disabled={selectedProposals.length === 0 || isSubmitting}
            data-testid="adopt-character-proposals-button"
          >
            {isZh
              ? `采纳勾选的角色提议 (${selectedProposals.length})`
              : `Adopt Selected Proposals (${selectedProposals.length})`}
          </Button>
        </div>
      </div>
    </div>
  )
}
