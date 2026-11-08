import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, History, LoaderCircle, Sparkles, X } from 'lucide-react'
import type { PlanningFeedbackCandidate, PlanningFeedbackCoreTarget } from '../../../shared/planning-feedback'
import type { PlanningFeedbackFieldBase, PlanningFeedbackHistory } from '../../../shared/planning-feedback-ipc'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { createPlanningFeedbackClient, type PlanningFeedbackClient } from '../../../services/planning-feedback-client'
import { diffProse } from '../history/version-diff'
import { Button } from '../../ui/Button'
import { toast } from '../../ui/Toast'
import { InkDialog } from '../InkDialog'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import './planning-feedback.css'

export interface PlanningFeedbackDialogProps {
  target: PlanningFeedbackCoreTarget
  label: string
  baseText: string
  isOpen: boolean
  onClose: () => void
  onAdopted: (adoptedText: string) => void
  projectSession?: ProjectSessionContext | null
  client?: PlanningFeedbackClient
}

export function PlanningFeedbackDialog({
  target,
  label,
  baseText,
  isOpen,
  onClose,
  onAdopted,
  projectSession,
  client: externalClient,
}: PlanningFeedbackDialogProps) {
  const text = useLocaleStore(s => s.text)
  const [baseId, setBaseId] = useState<string | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<PlanningFeedbackCandidate[]>([])
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [constraintsText, setConstraintsText] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isAdopting, setIsAdopting] = useState(false)
  const [parentCandidateId, setParentCandidateId] = useState<string | null>(null)

  const isCapturing = isOpen && !baseId && !captureError

  const currentProject = useProjectStore(s => s.currentProject)
  const activeSession = projectSession ?? captureProjectSession(currentProject)

  const resolvedClient = useMemo(() => {
    if (externalClient) return externalClient
    if (activeSession) return createPlanningFeedbackClient(activeSession)
    return null
  }, [externalClient, activeSession])

  // 初始化捕获基线
  useEffect(() => {
    if (!isOpen || !resolvedClient) return
    let active = true

    void resolvedClient.capture({ target })
      .then(async (base: PlanningFeedbackFieldBase) => {
        if (!active) return
        setBaseId(base.baseId)
        try {
          const history: PlanningFeedbackHistory = await resolvedClient.readHistory({ baseId: base.baseId })
          if (active && history.candidates.length > 0) {
            const list = history.candidates.map((c: PlanningFeedbackHistory['candidates'][number]) => c.candidate)
            setCandidates(list)
            setSelectedCandidateId(list[list.length - 1]?.candidateId ?? null)
          }
        } catch {
          // 初始无历史属正常场景
        }
      })
      .catch((err: unknown) => {
        if (!active) return
        const reason = displayedErrorMessage(useLocaleStore.getState().locale, err)
        setCaptureError(reason)
        toast.error(text(`捕获底稿失败：${reason}`, `Failed to capture base facts: ${reason}`))
      })

    return () => {
      active = false
    }
  }, [isOpen, target, resolvedClient, text])

  const selectedCandidate = useMemo(() => {
    return candidates.find(c => c.candidateId === selectedCandidateId) ?? null
  }, [candidates, selectedCandidateId])

  // 差异对比
  const diff = useMemo(() => {
    if (!selectedCandidate) return null
    return diffProse(baseText, selectedCandidate.text)
  }, [baseText, selectedCandidate])

  const handleGenerate = async () => {
    if (!baseId || !resolvedClient || !feedback.trim()) return
    if (activeSession && !isProjectSessionCurrent(activeSession)) {
      toast.error(text('当前项目已切换，已取消生成', 'Project changed, generation cancelled.'))
      return
    }

    setIsGenerating(true)
    const planningModelId = useLLMStore.getState().stageModelIds.planning
      || useLLMStore.getState().defaultModelId
      || 'default'

    const constraints = constraintsText
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)

    try {
      const newCandidate = await resolvedClient.generateCandidate({
        input: {
          baseId,
          parentCandidateId,
          feedback: feedback.trim(),
          constraints,
        },
        modelId: planningModelId,
        uiActionNonce: `author-feedback-${Date.now()}`,
      })

      setCandidates(prev => [...prev, newCandidate])
      setSelectedCandidateId(newCandidate.candidateId)
      setFeedback('')
      setConstraintsText('')
      setParentCandidateId(null)
      toast.success(text('已生成新候选', 'Generated new candidate.'))
    } catch (err: unknown) {
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, err)
      toast.error(text(`生成失败：${reason}`, `Generation failed: ${reason}`))
    } finally {
      setIsGenerating(false)
    }
  }

  const handleAdopt = async () => {
    if (!selectedCandidate || !resolvedClient) return
    if (activeSession && !isProjectSessionCurrent(activeSession)) {
      toast.error(text('当前项目已切换，无法采用', 'Project changed, adoption aborted.'))
      return
    }

    setIsAdopting(true)
    const idempotencyKey = `adopt-${selectedCandidate.candidateId}-${Date.now()}`

    try {
      await resolvedClient.adopt({
        candidateId: selectedCandidate.candidateId,
        idempotencyKey,
        decision: 'full',
        text: selectedCandidate.text,
      })

      toast.success(text(`已采用候选至「${label}」`, `Adopted candidate for ${label}.`))
      onAdopted(selectedCandidate.text)
      onClose()
    } catch (err: unknown) {
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, err)
      toast.error(text(`采用失败：${reason}`, `Adoption failed: ${reason}`))
    } finally {
      setIsAdopting(false)
    }
  }

  const handleIterateFromCurrent = () => {
    if (!selectedCandidate) return
    setParentCandidateId(selectedCandidate.candidateId)
    toast.info(text('已将当前选中的候选设为下一轮的修订基础', 'Current candidate set as basis for next iteration.'))
  }

  return (
    <InkDialog
      open={isOpen}
      onOpenChange={open => { if (!open) onClose() }}
      title={text(`意见修订：${label}`, `Feedback Revision: ${label}`)}
      description={text(
        '提出修改意见，生成独立候选并逐字对比；只有明确点击采用才会覆盖正式设定，未确认前绝不写库。',
        'Provide feedback to generate isolated candidates with diff inspection. Formal facts are only committed upon adoption.',
      )}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={isGenerating || isAdopting}>
            <X size={14} aria-hidden />
            {text('放弃 / 关闭', 'Dismiss / Close')}
          </Button>
          {selectedCandidate && (
            <Button
              variant="primary"
              onClick={() => { void handleAdopt() }}
              disabled={isGenerating || isAdopting || isCapturing}
            >
              {isAdopting ? <LoaderCircle size={14} className="stage-update-spin" aria-hidden /> : <Check size={14} aria-hidden />}
              {isAdopting ? text('正在采用…', 'Adopting…') : text('采用此候选', 'Adopt this candidate')}
            </Button>
          )}
        </>
      )}
    >
      <div className="pf-dialog">
        {/* 输入反馈意见 */}
        <div className="pf-section">
          <label className="pf-label">
            {parentCandidateId
              ? text('基于选定候选追加修改意见：', 'Feedback based on selected candidate:')
              : text('对本节的修改意见：', 'Feedback for this section:')}
          </label>
          <textarea
            className="pf-textarea"
            placeholder={text('例如：节奏加快，增加反转，语言风格更具压迫感…', 'e.g. Tighten the pacing, introduce a sharp twist…')}
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            disabled={isGenerating || isCapturing}
          />
        </div>

        {/* 约束条件（可选） */}
        <div className="pf-section">
          <label className="pf-label">{text('保留约束（可选，每行一条）：', 'Keep constraints (optional, one per line):')}</label>
          <textarea
            className="pf-textarea"
            style={{ minHeight: '50px' }}
            placeholder={text('例如：保留雨夜场景\n保留主角名字', 'e.g. Keep the lighthouse scene\nRetain protagonist name')}
            value={constraintsText}
            onChange={e => setConstraintsText(e.target.value)}
            disabled={isGenerating || isCapturing}
          />
          <div className="pf-actions-bar">
            {parentCandidateId && (
              <Button variant="text" size="sm" onClick={() => setParentCandidateId(null)}>
                {text('清除父级关联，直接基于原底稿修改', 'Clear parent candidate, revise from base')}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => { void handleGenerate() }}
              disabled={!feedback.trim() || isGenerating || isCapturing || !baseId}
            >
              {isGenerating ? <LoaderCircle size={14} className="stage-update-spin" aria-hidden /> : <Sparkles size={14} aria-hidden />}
              {isGenerating ? text('生成中…', 'Generating…') : text('生成候选', 'Generate candidate')}
            </Button>
          </div>
        </div>

        {/* 候选列表 Tabs */}
        {candidates.length > 0 && (
          <div className="pf-section">
            <label className="pf-label">{text('候选版本：', 'Candidates:')}</label>
            <div className="pf-candidates-tabs" role="tablist">
              {candidates.map((c, idx) => (
                <button
                  key={c.candidateId}
                  type="button"
                  role="tab"
                  className="pf-tab-btn"
                  data-active={c.candidateId === selectedCandidateId}
                  onClick={() => setSelectedCandidateId(c.candidateId)}
                >
                  <History size={12} aria-hidden />
                  {text(`第 ${idx + 1} 轮 (C${idx + 1})`, `Round ${idx + 1} (C${idx + 1})`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 结构化差异展示 */}
        {selectedCandidate && diff && (
          <div className="pf-diff-box">
            <div className="pf-diff-stats">
              <span>{text('与当前正式底稿对比：', 'Comparing with formal base:')}</span>
              {diff.added + diff.removed === 0 ? (
                <span>{text('与底稿完全相同', 'Identical to base')}</span>
              ) : (
                <>
                  <span data-kind="added">{text(`新增 ${diff.added} 处`, `${diff.added} added`)}</span>
                  <span data-kind="removed">{text(`删去 ${diff.removed} 处`, `${diff.removed} removed`)}</span>
                </>
              )}
            </div>
            <div className="pf-diff-content">
              {diff.paragraphs.map((p, pIdx) => (
                <p key={pIdx}>
                  {p.map((seg, sIdx) => {
                    if (seg.kind === 'added') return <ins key={sIdx}>{seg.text}</ins>
                    if (seg.kind === 'removed') return <del key={sIdx}>{seg.text}</del>
                    return <span key={sIdx}>{seg.text}</span>
                  })}
                </p>
              ))}
            </div>
            <div className="pf-actions-bar">
              <Button variant="text" size="sm" onClick={handleIterateFromCurrent} disabled={isGenerating}>
                <ArrowRight size={13} aria-hidden />
                {text('基于此候选继续提意见 (开启新一轮)', 'Iterate from this candidate (Next round)')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </InkDialog>
  )
}
