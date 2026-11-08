import { useState, useMemo } from 'react'
import { useLocaleStore } from '../../../stores/locale-store'
import { renderDiffProse } from './diff-prose-render'
import { Button } from '../../ui/Button'
import './planning-feedback.css'

export interface OutlineChapterItem {
  chapterNumber: number
  title: string
  synopsis: string
}

export interface OutlineRangeAdoptPayload {
  startChapter: number
  endChapter: number
  chapters: OutlineChapterItem[]
}

export interface OutlineRangeFeedbackPanelProps {
  totalChapters: number
  originalChapters: OutlineChapterItem[]
  candidateChapters: OutlineChapterItem[]
  onAdoptRange: (payload: OutlineRangeAdoptPayload) => void
  onClose?: () => void
  isSubmitting?: boolean
  defaultStartChapter?: number
  defaultEndChapter?: number
  locale?: string
}

export function OutlineRangeFeedbackPanel({
  totalChapters,
  originalChapters,
  candidateChapters,
  onAdoptRange,
  onClose,
  isSubmitting = false,
  defaultStartChapter = 1,
  defaultEndChapter = Math.min(totalChapters, 5),
  locale: propLocale,
}: OutlineRangeFeedbackPanelProps) {
  const storeLocale = useLocaleStore(s => s.locale)
  const currentLocale = propLocale ?? storeLocale
  const isZh = currentLocale.startsWith('zh')

  const [startChapter, setStartChapter] = useState(defaultStartChapter)
  const [endChapter, setEndChapter] = useState(defaultEndChapter)
  const [validationError, setValidationError] = useState<string | null>(null)

  // 校验范围合法性
  const isRangeValid = useMemo(() => {
    if (startChapter < 1 || endChapter < startChapter || endChapter > totalChapters) {
      return false
    }
    return true
  }, [startChapter, endChapter, totalChapters])

  // 筛选出范围内的候选章节
  const selectedCandidateChapters = useMemo(() => {
    return candidateChapters.filter(
      c => c.chapterNumber >= startChapter && c.chapterNumber <= endChapter,
    )
  }, [candidateChapters, startChapter, endChapter])

  // 范围外不受影响的描述说明
  const untouchedSummary = useMemo(() => {
    const parts: string[] = []
    if (startChapter > 1) {
      parts.push(
        isZh
          ? `第 1 至 ${startChapter - 1} 章`
          : `Chapters 1 to ${startChapter - 1}`,
      )
    }
    if (endChapter < totalChapters) {
      parts.push(
        isZh
          ? `第 ${endChapter + 1} 至 ${totalChapters} 章`
          : `Chapters ${endChapter + 1} to ${totalChapters}`,
      )
    }
    if (parts.length === 0) {
      return isZh ? '覆盖全部章节' : 'Covers all chapters'
    }
    return isZh
      ? `范围外保持不变：${parts.join('、')}`
      : `Untouched outside range: ${parts.join(', ')}`
  }, [startChapter, endChapter, totalChapters, isZh])

  const handleAdopt = () => {
    if (!isRangeValid) {
      setValidationError(
        isZh
          ? '章节范围无效，请确保起始章小于等于截止章且不超过总章数'
          : 'Invalid chapter range. Ensure start <= end and within total chapters.',
      )
      return
    }

    if (selectedCandidateChapters.length === 0) {
      setValidationError(
        isZh
          ? '选定范围内无可用候选大纲，无法采纳'
          : 'No candidate outline available in selected range.',
      )
      return
    }

    setValidationError(null)
    onAdoptRange({
      startChapter,
      endChapter,
      chapters: selectedCandidateChapters,
    })
  }

  return (
    <div className="pf-range-panel" data-testid="outline-range-feedback-panel">
      <div className="pf-section">
        <div className="pf-range-header">
          <h3 className="pf-range-title">
            {isZh ? '大纲章节范围反馈' : 'Outline Chapter Range Feedback'}
          </h3>
          <span className="pf-badge pf-badge-safe" data-testid="untouched-badge">
            {untouchedSummary}
          </span>
        </div>

        {/* 章节范围选择器 */}
        <div className="pf-range-selectors">
          <label className="pf-range-label">
            {isZh ? '起始章节：' : 'Start Chapter:'}
            <input
              type="number"
              aria-label={isZh ? '起始章节' : 'Start Chapter'}
              className="pf-range-input"
              value={startChapter}
              min={1}
              max={totalChapters}
              onChange={e => {
                setStartChapter(Number(e.target.value))
                setValidationError(null)
              }}
              disabled={isSubmitting}
            />
          </label>
          <span className="pf-range-sep">{isZh ? '至' : 'to'}</span>
          <label className="pf-range-label">
            {isZh ? '截止章节：' : 'End Chapter:'}
            <input
              type="number"
              aria-label={isZh ? '截止章节' : 'End Chapter'}
              className="pf-range-input"
              value={endChapter}
              min={1}
              max={totalChapters}
              onChange={e => {
                setEndChapter(Number(e.target.value))
                setValidationError(null)
              }}
              disabled={isSubmitting}
            />
          </label>
        </div>
      </div>

      {validationError && (
        <div className="pf-error-box" role="alert" data-testid="range-validation-error">
          {validationError}
        </div>
      )}

      {/* 范围内章节 Diff 对比列表 */}
      <div className="pf-section pf-diff-container">
        <h4 className="pf-label">
          {isZh
            ? `范围内章节差异对比（第 ${startChapter} - ${endChapter} 章）`
            : `Chapter Differences in Range (Ch. ${startChapter} - ${endChapter})`}
        </h4>

        {selectedCandidateChapters.length === 0 ? (
          <div className="pf-empty-notice">
            {isZh ? '当前范围内暂无候选大纲内容' : 'No candidate outline in this range'}
          </div>
        ) : (
          <div className="pf-range-items">
            {selectedCandidateChapters.map(candidate => {
              const original = originalChapters.find(
                o => o.chapterNumber === candidate.chapterNumber,
              )
              const origTitle = original?.title ?? ''
              const origSynopsis = original?.synopsis ?? ''

              return (
                <div
                  key={candidate.chapterNumber}
                  className="pf-range-chapter-card"
                  data-testid={`chapter-card-${candidate.chapterNumber}`}
                >
                  <div className="pf-chapter-card-header">
                    <span className="pf-chapter-num">
                      {isZh
                        ? `第 ${candidate.chapterNumber} 章`
                        : `Chapter ${candidate.chapterNumber}`}
                    </span>
                    <span className="pf-chapter-title-diff">
                      {renderDiffProse(origTitle, candidate.title)}
                    </span>
                  </div>

                  <div className="pf-chapter-synopsis-diff">
                    <div className="pf-synopsis-label">
                      {isZh ? '概要差异：' : 'Synopsis Diff:'}
                    </div>
                    <div className="pf-synopsis-content">
                      {renderDiffProse(origSynopsis, candidate.synopsis)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 底部操作区 */}
      <div className="pf-footer">
        <div className="pf-hint-text">
          {isZh
            ? '仅选定范围内的章节大纲会被采纳替换，范围外章节 100% 保持不变。'
            : 'Only selected chapter outlines will be replaced. Outside chapters remain untouched.'}
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
            disabled={!isRangeValid || isSubmitting || selectedCandidateChapters.length === 0}
            data-testid="adopt-range-button"
          >
            {isZh
              ? `采纳第 ${startChapter} - ${endChapter} 章大纲`
              : `Adopt Ch. ${startChapter} - ${endChapter}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
