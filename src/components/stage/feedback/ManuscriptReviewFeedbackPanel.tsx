import { useLocaleStore } from '../../../stores/locale-store'
import { renderDiffProse } from './diff-prose-render'
import { Button } from '../../ui/Button'
import './planning-feedback.css'

export interface ManuscriptReviewSnapshotData {
  reviewId: string
  reviewer?: string
  comments: string
  suggestions?: string[]
}

export interface ManuscriptReviewFeedbackPanelProps {
  isFinalized: boolean
  chapterNumber: number
  reviewSnapshot?: ManuscriptReviewSnapshotData
  diffText?: {
    original: string
    revised: string
  }
  onReopenDraft?: () => void
  onMergeInPlace?: () => void
  onClose?: () => void
  isSubmitting?: boolean
  locale?: string
}

export function ManuscriptReviewFeedbackPanel({
  isFinalized,
  chapterNumber,
  reviewSnapshot,
  diffText,
  onReopenDraft,
  onMergeInPlace,
  onClose,
  isSubmitting = false,
  locale: propLocale,
}: ManuscriptReviewFeedbackPanelProps) {
  const storeLocale = useLocaleStore(s => s.locale)
  const currentLocale = propLocale ?? storeLocale
  const isZh = currentLocale.startsWith('zh')

  const originalBody = diffText?.original ?? ''
  const revisedBody = diffText?.revised ?? ''

  return (
    <div className="pf-manuscript-panel" data-testid="manuscript-review-feedback-panel">
      <div className="pf-section">
        <div className="pf-manuscript-header">
          <h3 className="pf-range-title">
            {isZh
              ? `第 ${chapterNumber} 章正文审修与合并反馈`
              : `Chapter ${chapterNumber} Manuscript Review Feedback`}
          </h3>
          <span
            className={`pf-badge ${isFinalized ? 'pf-badge-warn' : 'pf-badge-safe'}`}
            data-testid="manuscript-status-badge"
          >
            {isFinalized
              ? (isZh ? '定稿保护状态' : 'Finalized State')
              : (isZh ? '草稿修订状态' : 'Draft Revision State')}
          </span>
        </div>

        {/* 定稿章节强提示与重开入口 */}
        {isFinalized ? (
          <div className="pf-finalized-notice-box" role="alert" data-testid="finalized-reopen-notice">
            <h4 className="pf-notice-title">
              {isZh
                ? '定稿章节修改政策（ADR-0024）'
                : 'Finalized Chapter Policy (ADR-0024)'}
            </h4>
            <p className="pf-notice-desc">
              {isZh
                ? '该章节当前处于定稿状态。定稿章节无法直接覆盖，必须先重开为草稿进行修订。'
                : 'This chapter is finalized. Direct overwrites are prohibited; you must reopen it as a draft first.'}
            </p>
            <div className="pf-read-only-warnings" data-testid="downstream-readonly-warnings">
              <span className="pf-warn-item">
                • {isZh ? '重开与替换定稿绝不自动修改后续章节；' : 'Reopening and replacing will NEVER automatically modify subsequent chapters;'}
              </span>
              <span className="pf-warn-item">
                • {isZh ? '系统不保证覆盖全部潜在剧情或人设矛盾，后续连续性需作者复核。' : 'The system does not claim to resolve all semantic continuity conflicts.'}
              </span>
            </div>

            {onReopenDraft && (
              <div className="pf-reopen-btn-wrapper">
                <Button
                  variant="primary"
                  onClick={onReopenDraft}
                  disabled={isSubmitting}
                  data-testid="reopen-chapter-button"
                >
                  {isZh ? '重开为修订草稿' : 'Reopen as Revision Draft'}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="pf-draft-merge-notice-box" data-testid="inplace-merge-notice">
            <span className="pf-notice-icon">ℹ️</span>
            <span>
              {isZh
                ? '就地合并说明：采纳修稿建议将直接就地更新当前草稿内容并标记为 revised，不虚增不可变新草稿版本行，保持历史真实性。'
                : 'In-place merge note: Adopting review edits updates the current draft content in place and marks it revised, without minting superfluous new draft rows.'}
            </span>
          </div>
        )}
      </div>

      {/* 人审意见快照 */}
      {reviewSnapshot && (
        <div className="pf-section pf-review-snapshot-box" data-testid="review-snapshot-box">
          <div className="pf-snapshot-header">
            <span className="pf-label">
              {isZh ? '关联人审意见快照' : 'Associated Human Review Snapshot'}
            </span>
            <span className="pf-snapshot-id">ID: {reviewSnapshot.reviewId}</span>
          </div>
          <div className="pf-snapshot-comments">{reviewSnapshot.comments}</div>
          {reviewSnapshot.suggestions && reviewSnapshot.suggestions.length > 0 && (
            <ul className="pf-snapshot-suggestions">
              {reviewSnapshot.suggestions.map((sug, sIdx) => (
                <li key={sIdx}>{sug}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 正文差异对比 */}
      <div className="pf-section pf-manuscript-diff-container">
        <h4 className="pf-label">
          {isZh ? '正文修改差异预览' : 'Manuscript Diff Preview'}
        </h4>
        <div className="pf-manuscript-diff-content" data-testid="manuscript-diff-content">
          {originalBody === '' && revisedBody === '' ? (
            <div className="pf-diff-eq">{isZh ? '（正文无变动）' : '(No manuscript changes)'}</div>
          ) : (
            renderDiffProse(originalBody, revisedBody)
          )}
        </div>
      </div>

      {/* 底部操作区 */}
      <div className="pf-footer">
        <div className="pf-hint-text">
          {isFinalized
            ? (isZh ? '定稿章节在重开前无法采纳合并。' : 'Finalized chapters cannot adopt merges before reopening.')
            : (isZh ? '点击采纳将执行就地合并，并保留完整人审追溯来源。' : 'Adopting merges will update in place preserving review provenance.')}
        </div>
        <div className="pf-footer-actions">
          {onClose && (
            <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
              {isZh ? '关闭' : 'Close'}
            </Button>
          )}
          {!isFinalized && onMergeInPlace && (
            <Button
              variant="primary"
              onClick={onMergeInPlace}
              disabled={isSubmitting || originalBody === revisedBody}
              data-testid="merge-in-place-button"
            >
              {isZh ? '就地采纳正文合并' : 'Adopt In-Place Merge'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
