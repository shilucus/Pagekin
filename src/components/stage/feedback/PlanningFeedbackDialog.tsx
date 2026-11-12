import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, Copy, Edit3, History, LoaderCircle, Sparkles, X } from 'lucide-react'
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
import { randomUUID } from '../../../utils/id'
import './planning-feedback.css'

export interface PlanningFeedbackAdoptionContext {
  projectSession: ProjectSessionContext | null
  baseTextAtAdoption: string
}

export interface PlanningFeedbackDialogProps {
  target: PlanningFeedbackCoreTarget
  label: string
  baseText: string
  isOpen: boolean
  onClose: () => void
  onAdopted: (adoptedText: string, context: PlanningFeedbackAdoptionContext) => void
  projectSession?: ProjectSessionContext | null
  client?: PlanningFeedbackClient
  initialBaseId?: string
  initialCapturedBaseText?: string
  initialCandidates?: PlanningFeedbackCandidate[]
  initialSelectedCandidateId?: string
  initialIsEditing?: boolean
}

function PlanningFeedbackDialogInner({
  target,
  label,
  baseText,
  isOpen,
  onClose,
  onAdopted,
  projectSession,
  client: externalClient,
  initialBaseId,
  initialCapturedBaseText,
  initialCandidates,
  initialSelectedCandidateId,
  initialIsEditing,
}: PlanningFeedbackDialogProps) {
  const text = useLocaleStore(s => s.text)
  const [baseId, setBaseId] = useState<string | null>(initialBaseId ?? null)
  const [capturedBaseText, setCapturedBaseText] = useState<string | null>(initialCapturedBaseText ?? null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<PlanningFeedbackCandidate[]>(initialCandidates ?? [])
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    initialSelectedCandidateId ?? (initialCandidates?.[0]?.candidateId ?? null),
  )
  const [feedback, setFeedback] = useState('')
  const [constraintsText, setConstraintsText] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isAdopting, setIsAdopting] = useState(false)
  const [parentCandidateId, setParentCandidateId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(initialIsEditing ?? false)
  const [userEditedText, setUserEditedText] = useState<string | null>(null)
  const adoptionKeys = useRef(new Map<string, string>())
  const instanceActive = useRef(false)

  useEffect(() => {
    instanceActive.current = true
    return () => { instanceActive.current = false }
  }, [])

  // 弹窗打开实例建立时，冻结当刻的项目会话，生命周期内保持不可变，防止跨书/换租约穿透
  const [frozenSession] = useState<ProjectSessionContext | null>(() => {
    const curr = useProjectStore.getState().currentProject
    const source = projectSession ?? (curr ? captureProjectSession(curr) : null)
    return source ? Object.freeze({ projectId: source.projectId, leaseId: source.leaseId, projectPath: source.projectPath }) : null
  })

  const sessionToCheck = frozenSession
  const closeDialog = () => {
    instanceActive.current = false
    onClose()
  }

  const isCapturing = isOpen && !baseId && !captureError
  const isStale = capturedBaseText !== null && baseText !== capturedBaseText

  const resolvedClient = useMemo(() => {
    if (externalClient) return externalClient
    if (sessionToCheck) return createPlanningFeedbackClient(sessionToCheck)
    return null
  }, [externalClient, sessionToCheck])

  // 初始化捕获基线
  useEffect(() => {
    if (!isOpen || !resolvedClient) return
    if (initialBaseId && initialCandidates && initialCandidates.length > 0) return
    let active = true

    if (sessionToCheck && !isProjectSessionCurrent(sessionToCheck)) {
      return
    }

    void resolvedClient.capture({ target })
      .then(async (base: PlanningFeedbackFieldBase) => {
        if (!active) return
        setBaseId(base.baseId)
        setCapturedBaseText(base.value)
        try {
          const history: PlanningFeedbackHistory = await resolvedClient.readHistory({ baseId: base.baseId })
          if (!active) return
          if (history.candidates.length > 0) {
            const list = history.candidates.map((c: PlanningFeedbackHistory['candidates'][number]) => c.candidate)
            setCandidates(list)
            setSelectedCandidateId(list[list.length - 1]?.candidateId ?? null)
          } else {
            setCandidates([])
            setSelectedCandidateId(null)
          }
        } catch {
          if (active) {
            setCandidates([])
            setSelectedCandidateId(null)
          }
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
  }, [isOpen, target, resolvedClient, sessionToCheck, initialBaseId, initialCandidates, text])

  const selectedCandidate = useMemo(() => {
    return candidates.find(c => c.candidateId === selectedCandidateId) ?? null
  }, [candidates, selectedCandidateId])

  const editedText = userEditedText ?? selectedCandidate?.text ?? ''

  // 差异对比
  const diff = useMemo(() => {
    if (!selectedCandidate) return null
    return diffProse(baseText, selectedCandidate.text)
  }, [baseText, selectedCandidate])

  const handleGenerate = async () => {
    if (!baseId || !resolvedClient || !feedback.trim()) return
    if (sessionToCheck && !isProjectSessionCurrent(sessionToCheck)) {
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
      setUserEditedText(null)
      setIsEditing(false)
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

  const handleCopyCandidate = async () => {
    if (!selectedCandidate) return
    const content = isEditing ? editedText : selectedCandidate.text
    try {
      await navigator.clipboard.writeText(content)
      toast.success(text('已复制候选内容到剪贴板', 'Candidate copied to clipboard.'))
    } catch {
      toast.error(text('复制失败', 'Failed to copy.'))
    }
  }

  const handleAdopt = async () => {
    if (!instanceActive.current || !selectedCandidate || !resolvedClient) return
    if (sessionToCheck && !isProjectSessionCurrent(sessionToCheck)) {
      toast.error(text('当前项目已切换，无法采用', 'Project changed, adoption aborted.'))
      return
    }
    if (isStale) {
      toast.error(text('底稿已发生变动，直接采用已禁用', 'Base facts have changed, direct adoption is disabled.'))
      return
    }

    setIsAdopting(true)
    const adoptedContent = isEditing ? editedText : selectedCandidate.text
    const decision = isEditing ? 'edited' : 'full'
    const adoptionContext: PlanningFeedbackAdoptionContext = {
      projectSession: sessionToCheck ?? null,
      baseTextAtAdoption: baseText,
    }
    const requestIdentity = JSON.stringify([
      sessionToCheck?.projectId ?? null, sessionToCheck?.leaseId ?? null, sessionToCheck?.projectPath ?? null,
      target, baseId, selectedCandidate.candidateId, decision, adoptedContent,
    ])
    // A lost acknowledgement must replay the same request only when the author clicks again.
    let idempotencyKey = adoptionKeys.current.get(requestIdentity)
    if (!idempotencyKey) {
      idempotencyKey = `adopt-${randomUUID()}`
      adoptionKeys.current.set(requestIdentity, idempotencyKey)
    }

    try {
      await resolvedClient.adopt({
        candidateId: selectedCandidate.candidateId,
        idempotencyKey,
        decision,
        text: adoptedContent,
      })

      if (!instanceActive.current || sessionToCheck && !isProjectSessionCurrent(sessionToCheck)) return

      onAdopted(adoptedContent, adoptionContext)
      if (instanceActive.current) {
        toast.success(text(`已采用候选至「${label}」`, `Adopted candidate for ${label}.`))
        closeDialog()
      }
    } catch (err: unknown) {
      if (!instanceActive.current || sessionToCheck && !isProjectSessionCurrent(sessionToCheck)) return
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, err)
      toast.error(text(`采用失败：${reason}`, `Adoption failed: ${reason}`))
    } finally {
      if (instanceActive.current && (!sessionToCheck || isProjectSessionCurrent(sessionToCheck))) setIsAdopting(false)
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
      onOpenChange={open => { if (!open) closeDialog() }}
      title={text(`意见修订：${label}`, `Feedback Revision: ${label}`)}
      description={text(
        '提出修改意见，生成独立候选并逐字对比；只有明确点击采用才会覆盖正式设定，未确认前绝不写库。',
        'Provide feedback to generate isolated candidates with diff inspection. Formal facts are only committed upon adoption.',
      )}
      footer={(
        <>
          <Button variant="secondary" onClick={closeDialog} disabled={isGenerating || isAdopting}>
            <X size={14} aria-hidden />
            {text('放弃 / 关闭', 'Dismiss / Close')}
          </Button>
          {selectedCandidate && (
            <Button
              variant="primary"
              onClick={() => { void handleAdopt() }}
              disabled={isGenerating || isAdopting || isCapturing || isStale}
              title={isStale ? text('底稿已发生变动，直接采用已禁用', 'Base facts have changed, direct adoption is disabled') : undefined}
            >
              {isAdopting ? <LoaderCircle size={14} className="stage-update-spin" aria-hidden /> : <Check size={14} aria-hidden />}
              {isAdopting
                ? text('正在采用…', 'Adopting…')
                : isEditing
                  ? text('采用微调版本', 'Adopt edited version')
                  : text('采用此候选', 'Adopt this candidate')}
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
                  onClick={() => {
                    setSelectedCandidateId(c.candidateId)
                    setUserEditedText(null)
                  }}
                >
                  <History size={12} aria-hidden />
                  {text(`第 ${idx + 1} 轮 (C${idx + 1})`, `Round ${idx + 1} (C${idx + 1})`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 结构化差异展示与微调编辑 */}
        {selectedCandidate && diff && (
          <div className="pf-diff-box">
            {isStale && (
              <div className="pf-stale-alert" role="alert">
                <AlertTriangle size={14} aria-hidden />
                <span>
                  {text(
                    '当前正式底稿已被外部修改，此候选版本基于旧底稿生成。为防止覆盖最新编辑，直接采用已禁用。您可以复制候选内容或重新生成。',
                    'The formal base has been updated elsewhere. Adoption is disabled to protect fresh edits. You may copy the text or regenerate.',
                  )}
                </span>
              </div>
            )}
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

            {isEditing ? (
              <div className="pf-section">
                <label className="pf-label">{text('在采用前微调内容：', 'Fine-tune before adoption:')}</label>
                <textarea
                  className="pf-textarea"
                  style={{ minHeight: '140px' }}
                  value={editedText}
                  onChange={e => setUserEditedText(e.target.value)}
                  disabled={isGenerating || isAdopting}
                />
              </div>
            ) : (
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
            )}

            <div className="pf-actions-bar">
              <div style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                <Button variant="text" size="sm" onClick={() => void handleCopyCandidate()}>
                  <Copy size={13} aria-hidden />
                  {text('复制候选', 'Copy candidate')}
                </Button>
                <Button variant="text" size="sm" onClick={() => setIsEditing(v => !v)}>
                  <Edit3 size={13} aria-hidden />
                  {isEditing ? text('查看逐字对比', 'View diff') : text('微调编辑此候选', 'Edit candidate')}
                </Button>
              </div>
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

export function PlanningFeedbackDialog(props: PlanningFeedbackDialogProps) {
  if (!props.isOpen) return null
  return <PlanningFeedbackDialogInner key={`${props.target}-${props.isOpen}`} {...props} />
}
