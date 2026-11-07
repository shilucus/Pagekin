import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { buildReviewGenerationReport } from '../../src/shared/review-generation-report'
import type { FrozenChapterGoals } from '../../src/shared/chapter-goal-review'
import type { ConsistencyFinding } from '../../src/shared/consistency-preflight'
import { parseWorkflowBatchRecipe, parseWorkflowBatchStepInput, assertWorkflowBatchSlot } from '../../src/shared/workflow-batch-contract'
import { composeDraftVisibleContinuation, sanitizeDraftText } from '../../src/shared/draft-visible-text'
import { composeVisibleContinuation } from '../../src/shared/visible-continuation'
import { parseHumanConfirmedReviewSnapshot, type HumanConfirmedReviewSnapshot } from '../../src/shared/human-confirmed-review'
import { buildReviewCycleRecheckReport, classifyFindingEvidenceChange, parseRecheckItems,
  unshownMustShowRecheckFindings, type ReviewCycleRecheckContext, type ReviewCycleRecheckFinding } from '../../src/shared/review-cycle'
import { DRAFT_STATUS_INFO } from '../../src/shared/draft-status'
import { buildFindings, parseSavedReport, canonicalM03FindingSetHash, type M03FindingDescriptor } from './review-cycle-findings'
import { proveEffect, type AttemptRow } from './review-cycle-effect-proof'

type Row = Record<string, unknown>
const TABLES = ['workflow_batch_tasks', 'workflow_batch_steps', 'workflow_batch_effects'] as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
function invalid(): never { throw new Error('ORDINARY_REVIEW_HISTORY_INVALID') }
function object(value: unknown, keys?: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Row
  if (keys && (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))) invalid()
  return row
}
function text(value: unknown): string { if (typeof value !== 'string') invalid(); return value }
function id(value: unknown): string {
  const result = text(value)
  if (!/^[\p{L}\p{N}._:@+-]{1,512}$/u.test(result)) invalid()
  return result
}
function digest(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/u.test(result)) invalid(); return result }
function positive(value: unknown): number { if (!integer(value, 1)) invalid(); return value }
function json(value: unknown): Row { return object(JSON.parse(text(value))) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export interface DraftCommitHistory {
  version: 1; kind: 'draft-commit-history'
  draft: { id: number; chapterNumber: number; version: number; status: string; contentHash: string }
}
export interface OrdinaryReviewHistory {
  version: 1 | 2; kind: 'ordinary-review-history'; cycleId: string; reviewId: number; reviewIndex: number
  reportVersion: 1 | 2; draftCommitStepId: string
  artifact: { artifactId: string; revision: number; textHash: string }
  source: { id: number; chapterNumber: number; version: number; status: string; content: string }
  normalization: { writingLanguage: 'zh-CN' | 'en-US'; uiLocale: 'zh-CN' | 'en-US'
    frozenGoals: FrozenChapterGoals; preflightFindings: ConsistencyFinding[] }
  finishReason: 'stop'
  followup?: OrdinaryReviewFollowup
}
type ArtifactReference = OrdinaryReviewHistory['artifact']
interface RevisionHistory {
  revisionId: number; revisionIndex: number; runId: string; attemptId: string; artifact: ArtifactReference
  composition: { algorithm: 'visible-append-v1'; sources: { artifact: ArtifactReference; finishReason: 'stop' | 'length' }[]; textHash: string }
  finishReason: 'stop'
}
export interface OrdinaryReviewFollowup {
  confirmation: { reviewId: number } | null
  revision: RevisionHistory | null
  merge: { mergedHash: string } | null
  recheck: { runId: string; attemptId: string; reviewId: number; reviewIndex: number; artifact: ArtifactReference
    reportVersion: 1 | 2; uiLocale: 'zh-CN' | 'en-US'; policyVersion: 1 | 2; finishReason: 'stop'
    artifactProjection: 'mapped-recheck' | 'invalid-output'; findingIds: string[] } | null
  confirmationHistory: { reviewId: number }[]
  discardedRevisions: (RevisionHistory & { confirmationReviewId: number })[]
}
const INVALID_RECHECK_ARTIFACT = 'PORTABLE_HISTORY_INVALID_RECHECK_OUTPUT'
function artifactReference(value: unknown): ArtifactReference {
  const row = object(value, ['artifactId', 'revision', 'textHash'])
  return { artifactId: id(row.artifactId), revision: positive(row.revision), textHash: digest(row.textHash) }
}
function parseRevision(value: unknown, discarded = false): RevisionHistory & { confirmationReviewId?: number } {
    const revision = object(value, ['revisionId', 'revisionIndex', 'runId', 'attemptId', 'artifact', 'composition', 'finishReason',
      ...(discarded ? ['confirmationReviewId'] : [])])
    const raw = object(revision.composition, ['algorithm', 'sources', 'textHash'])
    if (revision.finishReason !== 'stop' || raw.algorithm !== 'visible-append-v1' || !Array.isArray(raw.sources)
      || raw.sources.length < 1 || raw.sources.length > 32) invalid()
    const sources: RevisionHistory['composition']['sources'] = raw.sources.map(value => {
      const source = object(value, ['artifact', 'finishReason'])
      if (source.finishReason !== 'stop' && source.finishReason !== 'length') invalid()
      return { artifact: artifactReference(source.artifact), finishReason: source.finishReason }
    })
    if (sources.at(-1)?.finishReason !== 'stop' || new Set(sources.map(source => source.artifact.artifactId)).size !== sources.length) invalid()
    return { revisionId: positive(revision.revisionId), revisionIndex: positive(revision.revisionIndex),
      runId: id(revision.runId), attemptId: id(revision.attemptId), artifact: artifactReference(revision.artifact),
      composition: { algorithm: 'visible-append-v1', sources, textHash: digest(raw.textHash) }, finishReason: 'stop',
      ...(discarded ? { confirmationReviewId: positive(revision.confirmationReviewId) } : {}) }
}
function parseFollowup(value: unknown): OrdinaryReviewFollowup {
  const row = object(value, ['confirmation', 'revision', 'merge', 'recheck', 'confirmationHistory', 'discardedRevisions'])
  const confirmation = row.confirmation === null ? null : object(row.confirmation, ['reviewId'])
  const revision = row.revision === null ? null : parseRevision(row.revision)
  const merge = row.merge === null ? null : object(row.merge, ['mergedHash'])
  const recheck = row.recheck === null ? null : object(row.recheck,
    ['runId', 'attemptId', 'reviewId', 'reviewIndex', 'artifact', 'reportVersion', 'uiLocale', 'policyVersion', 'finishReason', 'artifactProjection', 'findingIds'])
  if (!Array.isArray(row.confirmationHistory) || !Array.isArray(row.discardedRevisions)) invalid()
  const confirmationHistory = row.confirmationHistory.map(value => ({ reviewId: positive(object(value, ['reviewId']).reviewId) }))
  const discardedRevisions = row.discardedRevisions.map(value => {
    const parsed = parseRevision(value, true)
    return { ...parsed, confirmationReviewId: positive(parsed.confirmationReviewId) }
  })
  for (const values of [confirmationHistory.map(value => value.reviewId), discardedRevisions.map(value => value.revisionId)])
    if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) invalid()
  if (confirmationHistory.some(value => value.reviewId === confirmation?.reviewId)
    || discardedRevisions.some(value => value.revisionId === revision?.revisionId)) invalid()
  if (recheck && (recheck.finishReason !== 'stop' || ![1, 2].includes(Number(recheck.reportVersion))
    || typeof recheck.reportVersion !== 'number' || ![1, 2].includes(Number(recheck.policyVersion)) || typeof recheck.policyVersion !== 'number'
    || !['zh-CN', 'en-US'].includes(text(recheck.uiLocale)) || !['mapped-recheck', 'invalid-output'].includes(text(recheck.artifactProjection)))) invalid()
  if (recheck && (!Array.isArray(recheck.findingIds) || !recheck.findingIds.length
    || new Set(recheck.findingIds.map(id)).size !== recheck.findingIds.length)) invalid()
  return { confirmation: confirmation ? { reviewId: positive(confirmation.reviewId) } : null,
    revision,
    merge: merge ? { mergedHash: digest(merge.mergedHash) } : null,
    recheck: recheck ? { runId: id(recheck.runId), attemptId: id(recheck.attemptId), reviewId: positive(recheck.reviewId),
      reviewIndex: positive(recheck.reviewIndex), artifact: artifactReference(recheck.artifact), reportVersion: recheck.reportVersion as 1 | 2,
      uiLocale: recheck.uiLocale as 'zh-CN' | 'en-US', policyVersion: recheck.policyVersion as 1 | 2, finishReason: 'stop',
      artifactProjection: recheck.artifactProjection as 'mapped-recheck' | 'invalid-output', findingIds: (recheck.findingIds as unknown[]).map(id) } : null,
    confirmationHistory, discardedRevisions }
}
export type OrdinarySemanticHistory = DraftCommitHistory | OrdinaryReviewHistory

/** Closed content-only schema: no unknown keys survive a projection, at any nesting level. */
export function parseOrdinarySemanticHistory(value: unknown): OrdinarySemanticHistory {
  const row = object(value)
  if (row.version !== 1 && row.version !== 2) invalid()
  if (row.kind === 'draft-commit-history') {
    if (row.version !== 1) invalid()
    object(row, ['version', 'kind', 'draft'])
    const draft = object(row.draft, ['id', 'chapterNumber', 'version', 'status', 'contentHash'])
    const status = text(draft.status)
    if (!Object.hasOwn(DRAFT_STATUS_INFO, status) && status !== 'deleted') invalid()
    return { version: 1, kind: row.kind, draft: { id: positive(draft.id), chapterNumber: positive(draft.chapterNumber),
      version: positive(draft.version), status, contentHash: digest(draft.contentHash) } }
  }
  object(row, ['version', 'kind', 'cycleId', 'reviewId', 'reviewIndex', 'reportVersion', 'draftCommitStepId',
    'artifact', 'source', 'normalization', 'finishReason', ...(row.version === 2 ? ['followup'] : [])])
  if (row.kind !== 'ordinary-review-history' || row.finishReason !== 'stop' || row.reportVersion !== 1 && row.reportVersion !== 2) invalid()
  const artifact = object(row.artifact, ['artifactId', 'revision', 'textHash'])
  const source = object(row.source, ['id', 'chapterNumber', 'version', 'status', 'content'])
  if (!Object.hasOwn(DRAFT_STATUS_INFO, text(source.status)) && source.status !== 'deleted') invalid()
  const normalization = object(row.normalization, ['writingLanguage', 'uiLocale', 'frozenGoals', 'preflightFindings'])
  if (!['zh-CN', 'en-US'].includes(text(normalization.writingLanguage)) || !['zh-CN', 'en-US'].includes(text(normalization.uiLocale))) invalid()
  const goals = object(normalization.frozenGoals, ['chapterNumber', 'coverage', 'items'])
  if (goals.chapterNumber !== source.chapterNumber || !['complete', 'unknown', 'not_configured'].includes(text(goals.coverage))
    || !Array.isArray(goals.items) || !Array.isArray(normalization.preflightFindings)) invalid()
  const seen = new Set<string>()
  const items = goals.items.map(value => {
    const item = object(value, ['id', 'text']), key = id(item.id)
    if (seen.has(key) || !text(item.text).trim()) invalid()
    seen.add(key)
    return { id: key, text: text(item.text) }
  })
  const preflightFindings = normalization.preflightFindings.map(value => {
    const item = object(value, ['stableFactKey', 'severity', 'sourceChapter', 'evidence', 'issue', 'suggestion'])
    const issue = object(item.issue, ['zhCN', 'enUS']), suggestion = object(item.suggestion, ['zhCN', 'enUS'])
    if (item.severity !== 'warning') invalid()
    return { stableFactKey: id(item.stableFactKey), severity: 'warning' as const, sourceChapter: positive(item.sourceChapter),
      evidence: text(item.evidence), issue: { zhCN: text(issue.zhCN), enUS: text(issue.enUS) },
      suggestion: { zhCN: text(suggestion.zhCN), enUS: text(suggestion.enUS) } }
  })
  return { version: row.version, kind: row.kind, cycleId: id(row.cycleId), reviewId: positive(row.reviewId), reviewIndex: positive(row.reviewIndex),
    reportVersion: row.reportVersion as 1 | 2, draftCommitStepId: id(row.draftCommitStepId),
    artifact: { artifactId: id(artifact.artifactId), revision: positive(artifact.revision), textHash: digest(artifact.textHash) },
    source: { id: positive(source.id), chapterNumber: positive(source.chapterNumber), version: positive(source.version),
      status: text(source.status), content: text(source.content) },
    normalization: { writingLanguage: normalization.writingLanguage as 'zh-CN' | 'en-US', uiLocale: normalization.uiLocale as 'zh-CN' | 'en-US',
      frozenGoals: { chapterNumber: positive(goals.chapterNumber), coverage: goals.coverage as FrozenChapterGoals['coverage'], items }, preflightFindings },
    finishReason: 'stop', ...(row.version === 2 ? { followup: parseFollowup(row.followup) } : {}) }
}
export function ordinarySemanticHistoryHash(value: unknown): string { return hash(canonical(parseOrdinarySemanticHistory(value))) }

function exists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(table))
}
function one(db: Database.Database, sql: string, ...args: (string | number)[]): Row {
  const row = db.prepare(sql).get(...args) as Row | undefined
  if (!row) invalid()
  return row
}
function draft(db: Database.Database, draftId: number): Row {
  const table = exists(db, 'drafts_all') ? 'drafts_all' : 'drafts'
  return one(db, `SELECT d.*,c.body FROM ${table} d JOIN contents c ON c.id=d.content_id WHERE d.id=?`, draftId)
}
function readArtifact(db: Database.Database, attemptId: string, runId: string) {
  const row = one(db, `SELECT a.*,t.attempt_json,t.root_action_id AS attempt_root,t.run_id AS attempt_run,r.root_action_id AS run_root
    FROM generation_artifacts a JOIN generation_attempts t ON t.attempt_id=a.attempt_id
    JOIN generation_runs r ON r.run_id=t.run_id WHERE a.attempt_id=? AND a.run_id=?`, attemptId, runId)
  const value = json(row.artifact_json), attempt = json(row.attempt_json)
  if (row.status === 'discarded' || row.attempt_run !== runId || row.attempt_root !== row.run_root
    || value.artifactId !== row.artifact_id || value.attemptId !== attemptId || value.rootActionId !== row.run_root
    || value.revision !== row.revision || typeof value.text !== 'string' || hash(value.text) !== value.textHash
    || attempt.attemptId !== attemptId || attempt.rootActionId !== row.run_root) invalid()
  return { row, value, attempt }
}
function findings(proof: OrdinaryReviewHistory, projectId: string, report: string, epoch = `portable-history:${proof.cycleId}`): M03FindingDescriptor[] {
  return buildFindings(parseSavedReport(report), { projectId, epoch,
    sourceId: `draft:${proof.source.id}`, revision: proof.source.version, contentHash: hash(proof.source.content) }, proof.source.content)
}
function persisted(item: M03FindingDescriptor, cycleId: string): Row {
  return { cycle_id: cycleId, finding_id: item.findingId, source_project_id: item.source.projectId, source_epoch: item.source.epoch,
    source_id: item.source.sourceId, source_revision: item.source.revision, source_content_hash: item.source.contentHash,
    span_start: item.source.span?.start ?? null, span_end: item.source.span?.end ?? null, span_unit: item.source.span?.unit ?? null,
    excerpt_hash: item.excerptHash, occurrence: item.occurrence, category: item.category, target_id: item.targetId, kind: item.kind,
    problem_text: item.problemText, expected_text: item.expectedText, status: item.status, evidence_hash: null, confirmation_item_index: null }
}
function savedReview(db: Database.Database, reviewId: number): Row {
  return one(db, 'SELECT r.*,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?', reviewId)
}
function confirmationSnapshot(value: string): HumanConfirmedReviewSnapshot {
  const snapshot = parseHumanConfirmedReviewSnapshot(value)
  if (!snapshot || !isDeepStrictEqual(JSON.parse(value), snapshot)) invalid()
  return snapshot
}
function exactSource(row: Row, source: OrdinaryReviewHistory['source']): boolean {
  return row.base_draft_id === source.id && row.source_draft_chapter_number === source.chapterNumber
    && row.source_draft_version === source.version && row.source_draft_status === source.status && row.source_content === source.content
}
function linkedArtifact(db: Database.Database, runId: string, attemptId: string, ref: ArtifactReference, rootId: string) {
  const item = readArtifact(db, attemptId, runId)
  if (item.row.run_root !== rootId || item.value.artifactId !== ref.artifactId || item.value.revision !== ref.revision
    || item.value.textHash !== ref.textHash || !['settled', 'unknown'].includes(text(item.attempt.status))) invalid()
  return item
}
function cycleConfirmations(db: Database.Database, proof: Pick<OrdinaryReviewHistory, 'reviewId' | 'cycleId' | 'source'>): number[] {
  const result: number[] = []
  for (const row of db.prepare('SELECT r.*,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.base_draft_id=? ORDER BY r.id').all(proof.source.id) as Row[]) {
    let raw: unknown
    try { raw = JSON.parse(text(row.body)) } catch { continue }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const candidate = raw as Row
    if (candidate.kind !== 'human-confirmed-review' || candidate.sourceReviewId !== proof.reviewId) continue
    const snapshot = confirmationSnapshot(text(row.body))
    if (!exactSource(row, proof.source) || !isDeepStrictEqual(snapshot.sourceDraft, proof.source)
      || snapshot.schemaVersion === 2 && snapshot.cycleId !== proof.cycleId) invalid()
    result.push(positive(row.id))
  }
  return result
}
function verifyRevision(db: Database.Database, proof: OrdinaryReviewHistory, cycle: Row, revision: RevisionHistory,
  confirmationReviewId: number, status: 'pending' | 'merged' | 'discarded', projected: boolean): void {
  const row = one(db, 'SELECT r.*,c.body FROM revisions r JOIN contents c ON c.id=r.content_id WHERE r.id=?', revision.revisionId)
  if (!exactSource(row, proof.source) || row.review_source_id !== confirmationReviewId || row.revision_index !== revision.revisionIndex
    || row.status !== status || row.merged_to_draft_id !== (status === 'merged' ? proof.source.id : null)) invalid()
  let composed = '', ordinal = 0
  for (const [index, source] of revision.composition.sources.entries()) {
    const item = linkedArtifact(db, revision.runId, id(one(db, 'SELECT attempt_id FROM generation_artifacts WHERE artifact_id=?', source.artifact.artifactId).attempt_id),
      source.artifact, id(cycle.root_action_id))
    if (item.row.status === 'discarded') invalid()
    const next = Number(one(db, 'SELECT rowid AS ordinal FROM generation_attempts WHERE attempt_id=?', id(item.row.attempt_id)).ordinal)
    if (next <= ordinal || !text(item.value.text).trim()) invalid()
    const textValue = index === 0 ? text(item.value.text).trim() : composeVisibleContinuation(composed, text(item.value.text))
    if (index > 0 && (textValue.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (composed.match(/[\p{L}\p{N}]/gu)?.length ?? 0)) invalid()
    composed = textValue; ordinal = next
  }
  linkedArtifact(db, revision.runId, revision.attemptId, revision.artifact, id(cycle.root_action_id))
  if (!isDeepStrictEqual(revision.composition.sources.at(-1)?.artifact, revision.artifact)
    || revision.composition.textHash !== hash(composed) || row.body !== composed) invalid()
  if (!projected) {
    const confirmation = savedReview(db, confirmationReviewId)
    const attempts = db.prepare(`SELECT t.*,r.binding_json,r.root_action_id AS run_root_action_id FROM generation_attempts t
      JOIN generation_runs r ON r.run_id=t.run_id WHERE t.attempt_id=?`).all(revision.attemptId) as AttemptRow[]
    if (attempts.length !== 1 || attempts[0]!.run_id !== revision.runId || attempts[0]!.root_action_id !== cycle.root_action_id
      || attempts[0]!.run_root_action_id !== cycle.root_action_id || !proveEffect(db, attempts[0]!, { kind: 'revision',
        id: revision.revisionId, index: revision.revisionIndex, contentHash: hash(composed), source: proof.source,
        confirmation: { reviewSourceId: confirmationReviewId, content: text(confirmation.body),
          originalReviewContentHash: digest(cycle.review_content_hash), snapshot: confirmationSnapshot(text(confirmation.body)) } })) invalid()
  }
}
function recheckPolicy(proof: OrdinaryReviewHistory, cycle: Row, rows: Row[], report: string,
  snapshot: HumanConfirmedReviewSnapshot | null, merged: string, version: 1 | 2): ReviewCycleRecheckContext {
  const eligible: ReviewCycleRecheckFinding[] = rows.flatMap(row => {
    if (row.status === 'unverified' || row.status === 'author-waived' || row.target_id === null || row.span_start === null
      || row.span_end === null || row.span_unit !== 'utf16-code-unit' || row.occurrence === null) return []
    const value: ReviewCycleRecheckFinding = { findingId: id(row.finding_id), targetId: id(row.target_id),
      category: text(row.category), kind: row.kind as 'objective' | 'literary', problem: text(row.problem_text),
      ...(row.expected_text === null ? {} : { expected: text(row.expected_text) }),
      sourceSpan: { start: Number(row.span_start), end: Number(row.span_end), unit: 'utf16-code-unit' },
      occurrence: Number(row.occurrence), sourceExcerpt: proof.source.content.slice(Number(row.span_start), Number(row.span_end)) }
    return classifyFindingEvidenceChange(proof.source.content, merged, value) === 'changed' ? [value] : []
  })
  const unshown = unshownMustShowRecheckFindings(JSON.parse(report), snapshot, rows.map(row => ({
    findingId: id(row.finding_id), kind: text(row.kind), status: text(row.status), targetId: row.target_id === null ? null : id(row.target_id),
    problemText: text(row.problem_text), expectedText: row.expected_text === null ? null : text(row.expected_text),
  }))).filter(value => classifyFindingEvidenceChange(proof.source.content, merged, value) === 'changed')
  const byId = new Map([...eligible, ...unshown].map(value => [value.findingId, value]))
  const order = proof.followup?.recheck?.findingIds
  if (!order || byId.size !== order.length || order.some(value => !byId.has(value))) invalid()
  return { version, cycleId: proof.cycleId, comparisonVersion: positive(cycle.comparison_version), mergedHash: digest(cycle.merged_hash),
    findingSetHash: digest(cycle.finding_set_hash), ...(unshown.length ? { sourceContent: proof.source.content } : {}), findings: order.map(value => byId.get(value)!) }
}
function verifyFollowup(db: Database.Database, proof: OrdinaryReviewHistory, cycle: Row, expected: M03FindingDescriptor[], report: string, projected: boolean): Row[] {
  const followup = proof.followup
  if (!followup) invalid()
  const rows = expected.map(value => persisted(value, proof.cycleId))
  const confirmationIds = [...followup.confirmationHistory.map(value => value.reviewId),
    ...(followup.confirmation ? [followup.confirmation.reviewId] : [])].sort((a, b) => a - b)
  if (!isDeepStrictEqual(confirmationIds, cycleConfirmations(db, proof))) invalid()
  for (const reviewId of confirmationIds) {
    const snapshot = confirmationSnapshot(text(savedReview(db, reviewId).body)), seen = new Set<string>()
    for (const choice of snapshot.items) if (choice.findingId !== undefined) {
      if (!rows.some(row => row.finding_id === choice.findingId) || seen.has(choice.findingId)) invalid()
      seen.add(choice.findingId)
    }
  }
  const historicalRows = (db.prepare('SELECT id,review_source_id,status FROM revisions WHERE base_draft_id=? ORDER BY id').all(proof.source.id) as Row[])
    .filter(row => confirmationIds.includes(Number(row.review_source_id)) && row.id !== followup.revision?.revisionId)
  if (historicalRows.some(row => row.status !== 'discarded') || !isDeepStrictEqual(historicalRows.map(row => Number(row.id)),
    followup.discardedRevisions.map(value => value.revisionId))) invalid()
  const revisionRuns = new Set<string>()
  for (const revision of [...followup.discardedRevisions, ...(followup.revision ? [followup.revision] : [])]) {
    if (revisionRuns.has(revision.runId)) invalid()
    revisionRuns.add(revision.runId)
  }
  for (const revision of followup.discardedRevisions) {
    if (!confirmationIds.includes(revision.confirmationReviewId)) invalid()
    verifyRevision(db, proof, cycle, revision, revision.confirmationReviewId, 'discarded', projected)
  }
  let snapshot: HumanConfirmedReviewSnapshot | null = null
  if (followup.confirmation) {
    const confirmation = savedReview(db, followup.confirmation.reviewId)
    snapshot = confirmationSnapshot(text(confirmation.body))
    if (cycle.confirmation_review_id !== followup.confirmation.reviewId || cycle.confirmation_content_hash !== hash(text(confirmation.body))
      || !exactSource(confirmation, proof.source) || snapshot.sourceReviewId !== proof.reviewId
      || !isDeepStrictEqual(snapshot.sourceDraft, proof.source) || snapshot.schemaVersion === 2 && snapshot.cycleId !== proof.cycleId) invalid()
    const seen = new Set<string>()
    for (const [index, choice] of snapshot.items.entries()) {
      if (choice.origin !== 'ai' || choice.findingId === undefined) continue
      const row = rows.find(value => value.finding_id === choice.findingId)
      if (!row || seen.has(choice.findingId)) invalid()
      seen.add(choice.findingId)
      if (choice.decision === 'waive') Object.assign(row, { status: 'author-waived', evidence_hash: cycle.confirmation_content_hash, confirmation_item_index: index })
    }
  } else if (cycle.confirmation_review_id !== null || cycle.confirmation_content_hash !== null) invalid()
  if (followup.revision) {
    if (!followup.confirmation) invalid()
    const revision = followup.revision
    if (cycle.revision_id !== revision.revisionId || cycle.revision_status !== (followup.merge ? 'merge-committed' : 'generated')) invalid()
    verifyRevision(db, proof, cycle, revision, followup.confirmation.reviewId, followup.merge ? 'merged' : 'pending', projected)
  } else if (cycle.revision_id !== null || cycle.revision_status !== 'not-generated' || followup.merge || followup.recheck) invalid()
  let merged: string | undefined
  if (followup.merge) {
    merged = text(one(db, 'SELECT body FROM review_cycle_merges WHERE cycle_id=?', proof.cycleId).body)
    if (cycle.merged_hash !== followup.merge.mergedHash || hash(merged) !== followup.merge.mergedHash) invalid()
  } else if (cycle.merged_hash !== null || db.prepare('SELECT 1 FROM review_cycle_merges WHERE cycle_id=?').get(proof.cycleId)) invalid()
  if (followup.recheck) {
    if (merged === undefined) invalid()
    const recheck = followup.recheck, row = savedReview(db, recheck.reviewId)
    const item = linkedArtifact(db, recheck.runId, recheck.attemptId, recheck.artifact, id(cycle.root_action_id))
    const policy = recheckPolicy(proof, cycle, rows, report, snapshot, merged, recheck.policyVersion)
    if (cycle.recheck_count !== 1 || cycle.recheck_attempt_id !== recheck.attemptId || !policy.findings.length
      || row.review_index !== recheck.reviewIndex || !exactSource(row, { ...proof.source, status: 'revised', content: merged })) invalid()
    const parsed = parseRecheckItems(text(item.value.text), recheck.reportVersion)
    if (recheck.artifactProjection === 'invalid-output' ? parsed !== null || projected && item.value.text !== INVALID_RECHECK_ARTIFACT : parsed === null) invalid()
    const built = buildReviewCycleRecheckReport(text(item.value.text), merged, policy, recheck.uiLocale, recheck.reportVersion)
    if (row.body !== JSON.stringify({ summary: built.summary, items: built.items }, null, 2)) invalid()
    for (const finding of policy.findings) {
      if (finding.mustShow) continue
      const row = rows.find(value => value.finding_id === finding.findingId), decision = built.decisions.find(value => value.findingId === finding.findingId)
      if (!row || !decision) invalid()
      const resolved = decision.status === 'resolved', known = decision.status !== 'unknown'
      Object.assign(row, { status: decision.status, confirmation_item_index: null, evidence_hash: known ? hash(JSON.stringify({
        findingId: finding.findingId, targetId: finding.targetId, reviewItemIndex: decision.reviewItemIndex,
        item: built.items[decision.reviewItemIndex], resolved })) : null })
    }
  } else if (cycle.recheck_count !== 0 || cycle.recheck_attempt_id !== null) invalid()
  return rows
}
function originalRevision(db: Database.Database, revisionId: number): RevisionHistory {
    const attempts = (db.prepare('SELECT * FROM generation_attempts').all() as Row[])
      .filter(row => row.usage_receipt_json !== null && object(json(row.usage_receipt_json).reviewRevisionEffect ?? {}).id === revisionId
        && object(json(row.usage_receipt_json).reviewRevisionEffect ?? {}).kind === 'revision')
    if (attempts.length !== 1) invalid()
    const row = attempts[0]!, usage = json(row.usage_receipt_json), saved = object(usage.reviewRevisionEffect), stored = object(usage.visibleComposition)
    if (!Array.isArray(stored.sources)) invalid()
    return { revisionId, revisionIndex: positive(saved.index), runId: id(row.run_id), attemptId: id(row.attempt_id),
      artifact: artifactReference(saved.artifact), composition: { algorithm: 'visible-append-v1', textHash: digest(stored.textHash),
        sources: stored.sources.map(value => {
          const ref = artifactReference(value), source = one(db, 'SELECT t.usage_receipt_json FROM generation_attempts t JOIN generation_artifacts a ON a.attempt_id=t.attempt_id WHERE a.artifact_id=?', ref.artifactId)
          const finishReason = object(json(source.usage_receipt_json).result).finishReason
          if (finishReason !== 'stop' && finishReason !== 'length') invalid()
          return { artifact: ref, finishReason }
        }) }, finishReason: 'stop' }
}
function originalFollowup(db: Database.Database, cycle: Row): OrdinaryReviewFollowup {
  const confirmation = cycle.confirmation_review_id === null ? null : { reviewId: positive(cycle.confirmation_review_id) }
  const revision = cycle.revision_id === null ? null : originalRevision(db, positive(cycle.revision_id))
  const review = savedReview(db, positive(cycle.review_id))
  const confirmationIds = cycleConfirmations(db, { cycleId: id(cycle.cycle_id), reviewId: positive(cycle.review_id),
    source: { id: positive(review.base_draft_id), chapterNumber: positive(review.source_draft_chapter_number),
      version: positive(review.source_draft_version), status: text(review.source_draft_status), content: text(review.source_content) } })
  const confirmationHistory = confirmationIds.filter(reviewId => reviewId !== confirmation?.reviewId).map(reviewId => ({ reviewId }))
  const discardedRevisions = (db.prepare('SELECT id,review_source_id FROM revisions WHERE status=\'discarded\' ORDER BY id').all() as Row[])
    .filter(row => confirmationIds.includes(Number(row.review_source_id))).map(row => ({ ...originalRevision(db, positive(row.id)),
      confirmationReviewId: positive(row.review_source_id) }))
  // Current pointers may have been detached. Original committed effects independently close the historical set.
  const committedRevisionIds: number[] = []
  for (const attempt of db.prepare(`SELECT t.*,r.binding_json FROM generation_attempts t JOIN generation_runs r ON r.run_id=t.run_id
    WHERE t.root_action_id=?`).all(cycle.root_action_id) as Row[]) {
    if (attempt.usage_receipt_json === null) continue
    const effect = json(attempt.usage_receipt_json).reviewRevisionEffect
    if (effect === undefined || object(effect).kind !== 'revision') continue
    const context = object(object(json(attempt.binding_json).sourceManifest).reviewRevisionContext)
    const origin = object(context.confirmation), snapshot = object(origin.snapshot)
    if (!confirmationIds.includes(positive(origin.reviewSourceId)) || snapshot.sourceReviewId !== cycle.review_id
      || origin.content !== savedReview(db, positive(origin.reviewSourceId)).body
      || origin.originalReviewContentHash !== cycle.review_content_hash) invalid()
    committedRevisionIds.push(positive(object(effect).id))
  }
  const expectedRevisionIds = [...discardedRevisions.map(value => value.revisionId), ...(revision ? [revision.revisionId] : [])].sort((a, b) => a - b)
  if (!isDeepStrictEqual(committedRevisionIds.sort((a, b) => a - b), expectedRevisionIds)) invalid()
  let recheck: OrdinaryReviewFollowup['recheck'] = null
  if (cycle.recheck_attempt_id !== null) {
    const attempt = one(db, 'SELECT * FROM generation_attempts WHERE attempt_id=?', id(cycle.recheck_attempt_id))
    const usage = json(attempt.usage_receipt_json), saved = object(usage.reviewRevisionEffect), receipt = object(usage.reviewCycleRecheck)
    const context = object(object(json(one(db, 'SELECT binding_json FROM generation_runs WHERE run_id=?', id(attempt.run_id)).binding_json).sourceManifest).reviewRevisionContext)
    const ref = artifactReference(saved.artifact), item = readArtifact(db, id(attempt.attempt_id), id(attempt.run_id))
    recheck = { runId: id(attempt.run_id), attemptId: id(attempt.attempt_id), reviewId: positive(saved.id), reviewIndex: positive(saved.index),
      artifact: ref, reportVersion: saved.reportVersion === 2 ? 2 : 1, uiLocale: context.uiLocale as 'zh-CN' | 'en-US',
      policyVersion: receipt.version as 1 | 2, finishReason: 'stop',
      findingIds: (object(context.recheck).findings as unknown[]).map(value => id(object(value).findingId)),
      artifactProjection: parseRecheckItems(text(item.value.text), saved.reportVersion === 2 ? 2 : 1) === null ? 'invalid-output' : 'mapped-recheck' }
  }
  return parseFollowup({ confirmation, revision, merge: cycle.merged_hash === null ? null : { mergedHash: cycle.merged_hash }, recheck,
    confirmationHistory, discardedRevisions })
}
function writeReviewBody(db: Database.Database, reviewId: number, body: string): void {
  db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)').run(body, reviewId)
}
function projectFollowup(db: Database.Database, proof: OrdinaryReviewHistory, oldFindings: M03FindingDescriptor[], nextFindings: M03FindingDescriptor[], report: string): void {
  const followup = proof.followup!
  if (oldFindings.length !== nextFindings.length) invalid()
  const known = new Map(oldFindings.map((value, index) => [value.findingId, nextFindings[index]!.findingId]))
  if (known.size !== oldFindings.length || new Set(known.values()).size !== nextFindings.length) invalid()
  const originalCycle = one(db, 'SELECT * FROM review_cycles WHERE cycle_id=?', proof.cycleId)
  const originalSnapshot = followup.confirmation ? confirmationSnapshot(text(savedReview(db, followup.confirmation.reviewId).body)) : null
  const originalRows = oldFindings.map(value => persisted(value, proof.cycleId))
  for (const choice of originalSnapshot?.items ?? []) if (choice.origin === 'ai' && choice.decision === 'waive') {
    const row = originalRows.find(value => value.finding_id === choice.findingId)
    if (!row) invalid()
    row.status = 'author-waived'
  }
  const originalMerged = followup.recheck ? text(one(db, 'SELECT body FROM review_cycle_merges WHERE cycle_id=?', proof.cycleId).body) : null
  const originalBuilt = followup.recheck && originalMerged !== null ? buildReviewCycleRecheckReport(
    text(readArtifact(db, followup.recheck.attemptId, followup.recheck.runId).value.text), originalMerged,
    recheckPolicy(proof, originalCycle, originalRows, report, originalSnapshot, originalMerged, followup.recheck.policyVersion),
    followup.recheck.uiLocale, followup.recheck.reportVersion) : null
  let snapshot: HumanConfirmedReviewSnapshot | null = null
  for (const reviewId of [...followup.confirmationHistory.map(value => value.reviewId), ...(followup.confirmation ? [followup.confirmation.reviewId] : [])]) {
    const old = confirmationSnapshot(text(savedReview(db, reviewId).body))
    const projected = { ...old, items: old.items.map(item => {
      if (item.findingId === undefined) return item
      const next = known.get(item.findingId)
      if (!next) invalid()
      return { ...item, findingId: next }
    }) }
    const content = JSON.stringify(projected, null, 2)
    writeReviewBody(db, reviewId, content)
    if (reviewId === followup.confirmation?.reviewId) {
      snapshot = projected
      db.prepare('UPDATE review_cycles SET confirmation_content_hash=? WHERE cycle_id=?').run(hash(content), proof.cycleId)
    }
  }
  db.prepare('UPDATE review_cycles SET finding_set_hash=? WHERE cycle_id=?').run(canonicalM03FindingSetHash(nextFindings), proof.cycleId)
  if (followup.recheck) {
    const recheck = followup.recheck, item = readArtifact(db, recheck.attemptId, recheck.runId)
    recheck.findingIds = recheck.findingIds.map(value => known.get(value) ?? invalid())
    let projected = INVALID_RECHECK_ARTIFACT
    if (recheck.artifactProjection === 'mapped-recheck') {
      const parsed = parseRecheckItems(text(item.value.text), recheck.reportVersion)
      if (!parsed) invalid()
      const validTargets = new Set([...nextFindings.flatMap(value => value.targetId === null ? [] : [value.targetId]),
        ...proof.normalization.frozenGoals.items.map(value => value.id), ...proof.normalization.preflightFindings.map(value => value.stableFactKey)])
      const unknownIds = new Map<string, string>(), unknownTargets = new Map<string, string>()
      const label = (values: Map<string, string>, value: string, prefix: string, occupied: ReadonlySet<string>) => {
        const previous = values.get(value)
        if (previous) return previous
        let index = values.size, next: string
        do { next = `portable-history:${proof.cycleId}:${prefix}:${index++}` } while (occupied.has(next) || [...values.values()].includes(next))
        values.set(value, next)
        return next
      }
      const knownIds = new Set(known.values())
      projected = JSON.stringify({ summary: parsed.summary, items: parsed.items.map(value => ({ ...value,
        findingId: known.get(value.findingId) ?? label(unknownIds, value.findingId, 'unmatched', knownIds),
        targetId: validTargets.has(value.targetId) ? value.targetId : label(unknownTargets, value.targetId, 'invalid-target', validTargets),
      })) })
    }
    const visible = { ...item.value, text: projected, textHash: hash(projected) }
    db.prepare('UPDATE generation_artifacts SET artifact_json=? WHERE artifact_id=?').run(JSON.stringify(visible), recheck.artifact.artifactId)
    recheck.artifact = { ...recheck.artifact, textHash: hash(projected) }
    const cycle = one(db, 'SELECT * FROM review_cycles WHERE cycle_id=?', proof.cycleId)
    const rows = nextFindings.map(value => persisted(value, proof.cycleId))
    for (const [index, choice] of snapshot?.items.entries() ?? []) {
      if (choice.origin === 'ai' && choice.decision === 'waive') {
        const row = rows.find(value => value.finding_id === choice.findingId)
        if (!row) invalid()
        Object.assign(row, { status: 'author-waived', evidence_hash: cycle.confirmation_content_hash, confirmation_item_index: index })
      }
    }
    const merged = text(one(db, 'SELECT body FROM review_cycle_merges WHERE cycle_id=?', proof.cycleId).body)
    const policy = recheckPolicy(proof, cycle, rows, report, snapshot, merged, recheck.policyVersion)
    const built = buildReviewCycleRecheckReport(projected, merged, policy, recheck.uiLocale, recheck.reportVersion)
    if (!originalBuilt || !isDeepStrictEqual(built, { ...originalBuilt,
      items: originalBuilt.items.map(value => ({ ...value, findingId: known.get(text(value.findingId)) ?? invalid() })),
      decisions: originalBuilt.decisions.map(value => ({ ...value, findingId: known.get(value.findingId) ?? invalid() })),
    })) invalid()
    writeReviewBody(db, recheck.reviewId, JSON.stringify({ summary: built.summary, items: built.items }, null, 2))
  }
}
function historicalComposition(db: Database.Database, step: Row, effect: Row): string {
  const input = parseWorkflowBatchStepInput(JSON.parse(text(step.input_json)))
  if (input.kind !== 'compose' || effect.receipt_kind !== 'composition' || effect.content_hash !== input.expectedTextHash) invalid()
  let composed = '', ordinal = 0
  for (const [index, artifactId] of input.artifactIds.entries()) {
    const source = one(db, 'SELECT attempt_id FROM generation_artifacts WHERE artifact_id=? AND run_id=?', artifactId, id(step.run_id))
    const visible = readArtifact(db, id(source.attempt_id), id(step.run_id))
    const nextOrdinal = Number(one(db, 'SELECT rowid AS ordinal FROM generation_attempts WHERE attempt_id=?', id(source.attempt_id)).ordinal)
    const model = one(db, `SELECT s.input_json FROM workflow_batch_steps s JOIN workflow_batch_effects e ON e.step_id=s.step_id
      WHERE s.run_id=? AND e.receipt_kind='model' AND e.receipt_attempt_id=?`, id(step.run_id), id(source.attempt_id))
    const modelInput = parseWorkflowBatchStepInput(JSON.parse(text(model.input_json)))
    if (modelInput.kind !== 'model' || !['settled', 'unknown'].includes(text(visible.attempt.status)) || nextOrdinal <= ordinal
      || ['chapter-draft-short-outline', 'chapter-draft-reconcile'].includes(modelInput.task.purpose)) invalid()
    const condense = modelInput.task.purpose === 'chapter-draft-condense'
    if (condense && (index === 0 || index !== input.artifactIds.length - 1)) invalid()
    composed = index === 0 || condense ? sanitizeDraftText(text(visible.value.text), input.algorithm)
      : composeDraftVisibleContinuation(composed, text(visible.value.text), input.algorithm)
    ordinal = nextOrdinal
  }
  const last = readArtifact(db, id(effect.receipt_attempt_id), id(step.run_id))
  if (hash(composed) !== effect.content_hash || input.artifactIds.at(-1) !== last.row.artifact_id) invalid()
  return composed
}
function verifyDraft(db: Database.Database, step: Row, effect: Row, proof: DraftCommitHistory): void {
  const saved = draft(db, proof.draft.id), input = parseWorkflowBatchStepInput(JSON.parse(text(step.input_json)))
  if (step.kind !== 'draft_commit' || effect.receipt_kind !== 'draft_commit' || input.kind !== 'draft-commit'
    || saved.chapter_number !== step.chapter_number || proof.draft.chapterNumber !== step.chapter_number
    || saved.version !== proof.draft.version || proof.draft.status !== 'draft' || proof.draft.contentHash !== effect.content_hash
    || proof.draft.contentHash !== input.expectedCompositionHash) invalid()
  const compositions = db.prepare(`SELECT s.*,e.receipt_kind,e.receipt_attempt_id,e.content_hash FROM workflow_batch_steps s
    JOIN workflow_batch_effects e ON e.step_id=s.step_id WHERE s.task_id=? AND s.run_id=? AND s.kind='compose'
    AND e.content_hash=? AND e.receipt_attempt_id=?`).all(step.task_id, step.run_id, effect.content_hash, effect.receipt_attempt_id) as Row[]
  if (compositions.length !== 1 || hash(historicalComposition(db, compositions[0]!, compositions[0]!)) !== proof.draft.contentHash) invalid()
  readArtifact(db, id(effect.receipt_attempt_id), id(step.run_id))
}
function verifyReview(db: Database.Database, task: Row, step: Row, effect: Row, proof: OrdinaryReviewHistory, projected: boolean): void {
  const cycle = one(db, 'SELECT * FROM review_cycles WHERE cycle_id=?', proof.cycleId)
  const review = one(db, 'SELECT r.*,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?', proof.reviewId)
  const run = one(db, 'SELECT * FROM generation_runs WHERE run_id=?', id(step.run_id))
  const input = parseWorkflowBatchStepInput(JSON.parse(text(step.input_json)))
  const item = readArtifact(db, id(effect.receipt_attempt_id), id(step.run_id))
  const draftStep = one(db, 'SELECT * FROM workflow_batch_steps WHERE step_id=? AND task_id=?', proof.draftCommitStepId, id(task.task_id))
  const draftEffect = one(db, 'SELECT * FROM workflow_batch_effects WHERE step_id=?', proof.draftCommitStepId)
  const draftProof = parseOrdinarySemanticHistory(JSON.parse(text(draftEffect.semantic_history_json)))
  if (draftProof.kind !== 'draft-commit-history') invalid()
  verifyDraft(db, draftStep, draftEffect, draftProof)
  if (step.role !== 'review' || step.kind !== 'review_commit' || effect.receipt_kind !== 'review_commit' || input.kind !== 'review-commit'
    || draftStep.chapter_number !== step.chapter_number || draftStep.role !== 'draft'
    || proof.source.id !== draftProof.draft.id || proof.source.chapterNumber !== step.chapter_number
    || proof.source.version !== draftProof.draft.version || proof.source.status !== draftProof.draft.status
    || hash(proof.source.content) !== draftProof.draft.contentHash || !isDeepStrictEqual(input.artifact, proof.artifact)
    || proof.artifact.artifactId !== item.row.artifact_id || proof.artifact.revision !== item.row.revision || proof.artifact.textHash !== item.value.textHash
    || !['settled', 'unknown'].includes(text(item.attempt.status)) || cycle.root_action_id !== run.root_action_id
    || cycle.review_id !== proof.reviewId || review.review_index !== proof.reviewIndex
    || review.base_draft_id !== proof.source.id || review.source_draft_chapter_number !== proof.source.chapterNumber
    || review.source_draft_version !== proof.source.version || review.source_draft_status !== proof.source.status
    || review.source_content !== proof.source.content || cycle.source_hash !== hash(proof.source.content)
    || cycle.review_content_hash !== hash(text(review.body)) || effect.content_hash !== cycle.review_content_hash
    || cycle.comparison_version !== 1) invalid()
  const recipe = parseWorkflowBatchRecipe(JSON.parse(text(task.recipe_json)))
  if (proof.normalization.writingLanguage !== recipe.writingLanguage || proof.normalization.uiLocale !== recipe.uiLocale) invalid()
  const rebuilt = JSON.stringify(buildReviewGenerationReport({ content: text(item.value.text), sourceContent: proof.source.content,
    ...proof.normalization, reportVersion: proof.reportVersion }), null, 2)
  if (rebuilt !== review.body) invalid()
  const expected = findings(proof, id(task.project_id), rebuilt, projected ? undefined : text(json(run.binding_json).epoch))
  let expectedRows = expected.map(value => persisted(value, proof.cycleId))
  if (proof.version === 2) expectedRows = verifyFollowup(db, proof, cycle, expected, rebuilt, projected)
  else if (cycle.confirmation_review_id !== null || cycle.confirmation_content_hash !== null || cycle.revision_id !== null
    || cycle.revision_status !== 'not-generated' || cycle.merged_hash !== null || cycle.recheck_count !== 0
    || cycle.recheck_attempt_id !== null || db.prepare('SELECT 1 FROM review_cycle_merges WHERE cycle_id=?').get(proof.cycleId)) invalid()
  if (projected) {
    const actual = db.prepare('SELECT * FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(proof.cycleId)
    if (cycle.finding_set_hash !== canonicalM03FindingSetHash(expected)
      || !isDeepStrictEqual(actual, expectedRows.sort((a, b) => text(a.finding_id) < text(b.finding_id) ? -1 : 1))) invalid()
  }
}

export interface OrdinaryHistoryContext { readonly taskIds: readonly string[]; readonly cycleIds: readonly string[] }
const contexts = new WeakMap<OrdinaryHistoryContext, { db: Database.Database; stamp: string }>()
function stamp(db: Database.Database): string {
  // Same-handle writes (including rolled-back writes), external commits, and DDL each invalidate the context.
  return JSON.stringify([db.prepare('SELECT total_changes()').pluck().get(),
    db.pragma('data_version', { simple: true }), db.pragma('schema_version', { simple: true })])
}
export function assertOrdinaryHistoryContext(db: Database.Database, context: OrdinaryHistoryContext): void {
  const bound = contexts.get(context)
  if (!bound || bound.db !== db || bound.stamp !== stamp(db)) invalid()
}
export function verifyOrdinaryReviewHistoryCycle(db: Database.Database, cycleId: string, context: OrdinaryHistoryContext): boolean {
  assertOrdinaryHistoryContext(db, context)
  return context.cycleIds.includes(cycleId)
}

export function readOrdinaryReviewHistoryReport(db: Database.Database, cycleId: string, context: OrdinaryHistoryContext): {
  proof: OrdinaryReviewHistory; report: string; rawArtifact: string
} {
  if (!verifyOrdinaryReviewHistoryCycle(db, cycleId, context)) invalid()
  const row = one(db, `SELECT e.semantic_history_json,s.run_id,e.receipt_attempt_id FROM workflow_batch_effects e
    JOIN workflow_batch_steps s ON s.step_id=e.step_id WHERE json_extract(e.semantic_history_json,'$.cycleId')=?`, cycleId)
  const proof = parseOrdinarySemanticHistory(JSON.parse(text(row.semantic_history_json)))
  if (proof.kind !== 'ordinary-review-history') invalid()
  const report = one(db, 'SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?', proof.reviewId)
  const artifact = readArtifact(db, id(row.receipt_attempt_id), id(row.run_id))
  return { proof, report: text(report.body), rawArtifact: text(artifact.value.text) }
}

/** Reads only explicitly projected M13 tasks. Old/live M03 authority is never inferred from missing identities. */
export function readVerifiedOrdinaryHistory(db: Database.Database): OrdinaryHistoryContext {
  const before = stamp(db)
  const taskIds: string[] = [], cycleIds: string[] = []
  if (exists(db, TABLES[0])) {
    for (const task of db.prepare('SELECT * FROM workflow_batch_tasks').all() as Row[]) {
      const steps = db.prepare('SELECT * FROM workflow_batch_steps WHERE task_id=? ORDER BY rowid').all(task.task_id) as Row[]
      const effects = db.prepare('SELECT e.* FROM workflow_batch_effects e JOIN workflow_batch_steps s ON s.step_id=e.step_id WHERE s.task_id=?').all(task.task_id) as Row[]
      const historical = task.operation_key === `portable-history:${id(task.task_id)}`
      if (!historical) {
        if (effects.some(effect => effect.semantic_history_json !== null || effect.semantic_history_hash !== null)) invalid()
        continue
      }
      const recipe = parseWorkflowBatchRecipe(JSON.parse(text(task.recipe_json)))
      if (task.request_hash !== null || task.review_model_id !== null || task.review_model_hash !== null
        || task.template !== 'prepared-batch-review-v2' || JSON.stringify(recipe) !== task.recipe_json || hash(text(task.recipe_json)) !== task.recipe_hash) invalid()
      taskIds.push(id(task.task_id))
      const batch = one(db, 'SELECT * FROM generation_runs WHERE run_id=?', id(task.batch_run_id))
      const groups = new Map<string, string>()
      for (const step of steps) {
        const input = parseWorkflowBatchStepInput(JSON.parse(text(step.input_json)))
        assertWorkflowBatchSlot(step.role as 'draft' | 'review', step.kind as Parameters<typeof assertWorkflowBatchSlot>[1], Number(step.slot), input)
        if (!integer(step.chapter_number, recipe.intent.range.startChapter) || step.chapter_number > recipe.intent.range.endChapter
          || step.invocation_nonce !== null || JSON.stringify(input) !== step.input_json || hash(text(step.input_json)) !== step.input_hash) invalid()
        const run = one(db, 'SELECT * FROM generation_runs WHERE run_id=?', id(step.run_id)), group = `${step.chapter_number}:${step.role}`
        if (groups.has(group) && groups.get(group) !== step.run_id
          || step.role === 'draft' && run.root_action_id !== batch.root_action_id
          || step.role === 'review' && run.root_action_id === batch.root_action_id
          || db.prepare('SELECT 1 FROM workflow_batch_steps WHERE run_id=? AND (task_id<>? OR chapter_number<>? OR role<>?)').get(step.run_id, task.task_id, step.chapter_number, step.role)) invalid()
        groups.set(group, id(step.run_id))
        const effect = effects.find(value => value.step_id === step.step_id)
        if (!effect) continue
        const item = readArtifact(db, id(effect.receipt_attempt_id), id(step.run_id))
        if (!integer(effect.acknowledged_at)) invalid()
        if (input.kind === 'model') {
          if (effect.receipt_kind !== 'model' || effect.content_hash !== item.value.textHash || effect.semantic_history_json !== null || effect.semantic_history_hash !== null) invalid()
        } else if (input.kind === 'compose') {
          if (effect.receipt_kind !== 'composition' || effect.content_hash !== input.expectedTextHash || effect.semantic_history_json !== null || effect.semantic_history_hash !== null) invalid()
          historicalComposition(db, step, effect)
        } else {
          const proof = parseOrdinarySemanticHistory(JSON.parse(text(effect.semantic_history_json)))
          if (ordinarySemanticHistoryHash(proof) !== effect.semantic_history_hash) invalid()
          if (proof.kind === 'draft-commit-history') verifyDraft(db, step, effect, proof)
          else {
            verifyReview(db, task, step, effect, proof, true)
            if (cycleIds.includes(proof.cycleId)) invalid()
            cycleIds.push(proof.cycleId)
          }
        }
      }
      if (steps.length > 26 * (recipe.intent.range.endChapter - recipe.intent.range.startChapter + 1)) invalid()
      for (let chapter = recipe.intent.range.startChapter; chapter <= recipe.intent.range.endChapter; chapter++) {
        const has = (kind: string) => steps.some(step => step.chapter_number === chapter && step.kind === kind && effects.some(effect => effect.step_id === step.step_id))
        if ((steps.some(step => step.role === 'review') || task.state === 'waiting_review') && !has('draft_commit')
          || task.state === 'waiting_review' && !has('review_commit')) invalid()
      }
    }
  }
  const result = Object.freeze({ taskIds: Object.freeze(taskIds), cycleIds: Object.freeze(cycleIds) })
  if (before !== stamp(db)) invalid()
  contexts.set(result, { db, stamp: before })
  return result
}

/** The caller must strictly verify the original DB first, and call this only inside the isolated export transaction. */
export function materializeOrdinaryReviewHistory(db: Database.Database): void {
  if (!exists(db, TABLES[0])) return
  if (!db.inTransaction) invalid()
  readVerifiedOrdinaryHistory(db)
  const tasks = db.prepare('SELECT * FROM workflow_batch_tasks').all() as Row[]
  const write = (effect: Row, proof: OrdinarySemanticHistory) => {
    const closed = parseOrdinarySemanticHistory(proof)
    db.prepare('UPDATE workflow_batch_effects SET semantic_history_json=?,semantic_history_hash=? WHERE step_id=?')
      .run(JSON.stringify(closed), ordinarySemanticHistoryHash(closed), effect.step_id)
  }
  for (const task of tasks) {
    if (task.operation_key === `portable-history:${task.task_id}`) continue
    const rows = db.prepare(`SELECT s.*,e.receipt_kind,e.receipt_attempt_id,e.content_hash,e.acknowledged_at,e.semantic_history_json,e.semantic_history_hash
      FROM workflow_batch_steps s JOIN workflow_batch_effects e ON e.step_id=s.step_id WHERE s.task_id=? ORDER BY s.chapter_number,s.rowid`).all(task.task_id) as Row[]
    for (const step of rows.filter(row => row.kind === 'draft_commit')) {
      const attempt = one(db, 'SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=? AND run_id=?', id(step.receipt_attempt_id), id(step.run_id))
      const saved = object(json(attempt.usage_receipt_json).draftCommit)
      const proof: DraftCommitHistory = { version: 1, kind: 'draft-commit-history', draft: { id: positive(saved.id),
        chapterNumber: positive(step.chapter_number), version: positive(saved.version), status: 'draft', contentHash: digest(saved.contentHash) } }
      verifyDraft(db, step, step, proof)
      write(step, proof)
    }
    for (const step of rows.filter(row => row.kind === 'review_commit')) {
      const attempt = one(db, 'SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=? AND run_id=?', id(step.receipt_attempt_id), id(step.run_id))
      const usage = json(attempt.usage_receipt_json), saved = object(usage.reviewRevisionEffect), result = object(usage.result)
      const run = one(db, 'SELECT binding_json FROM generation_runs WHERE run_id=?', id(step.run_id))
      const context = object(object(json(run.binding_json).sourceManifest).reviewRevisionContext)
      if (context.operation !== 'review-chapter' || context.confirmation !== undefined || context.recheck !== undefined
        || saved.kind !== 'review' || result.finishReason !== 'stop' || result.failureCode) invalid()
      const cycle = one(db, 'SELECT * FROM review_cycles WHERE review_id=?', positive(saved.id))
      const draftStep = one(db, "SELECT step_id FROM workflow_batch_steps WHERE task_id=? AND chapter_number=? AND kind='draft_commit'", id(task.task_id), positive(step.chapter_number))
      const proof = parseOrdinarySemanticHistory({ version: 2, kind: 'ordinary-review-history', cycleId: cycle.cycle_id,
        reviewId: saved.id, reviewIndex: saved.index, reportVersion: saved.reportVersion ?? 1, draftCommitStepId: draftStep.step_id,
        artifact: saved.artifact, source: context.source, normalization: { writingLanguage: context.writingLanguage, uiLocale: context.uiLocale,
          frozenGoals: context.frozenGoals, preflightFindings: context.preflightFindings }, finishReason: 'stop', followup: originalFollowup(db, cycle) })
      if (proof.kind !== 'ordinary-review-history') invalid()
      verifyReview(db, task, step, step, proof, false)
      const review = one(db, 'SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?', proof.reviewId)
      const rebuilt = findings(proof, id(task.project_id), text(review.body))
      projectFollowup(db, proof, findings(proof, id(task.project_id), text(review.body), text(json(run.binding_json).epoch)), rebuilt, text(review.body))
      const projectedRows = verifyFollowup(db, proof, one(db, 'SELECT * FROM review_cycles WHERE cycle_id=?', proof.cycleId), rebuilt, text(review.body), true)
      write(step, proof)
      db.prepare('DELETE FROM review_findings WHERE cycle_id=?').run(proof.cycleId)
      for (const row of projectedRows) {
        const columns = Object.keys(row)
        db.prepare(`INSERT INTO review_findings(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(row))
      }
      db.prepare('UPDATE review_cycles SET finding_set_hash=? WHERE cycle_id=?').run(canonicalM03FindingSetHash(rebuilt), proof.cycleId)
    }
  }
}

export function assertOrdinaryReviewHistoryMutable(db: Database.Database, target: { cycleId?: string; reviewId?: number; rootActionId?: string; revisionId?: number }): void {
  const context = readVerifiedOrdinaryHistory(db)
  const domain = readOrdinaryHistoryDomainRecords(db)
  if (target.reviewId !== undefined && domain.some(row => row.table === 'reviews' && row.recordId === String(target.reviewId))
    || target.revisionId !== undefined && domain.some(row => row.table === 'revisions' && row.recordId === String(target.revisionId)))
    throw new Error('PORTABLE_RUNTIME_FROZEN')
  for (const cycleId of context.cycleIds) {
    const cycle = one(db, 'SELECT * FROM review_cycles WHERE cycle_id=?', cycleId)
    if (target.cycleId === cycleId || target.reviewId === cycle.review_id || target.rootActionId === cycle.root_action_id
      || target.revisionId !== undefined && target.revisionId === cycle.revision_id) throw new Error('PORTABLE_RUNTIME_FROZEN')
  }
}

export interface OrdinaryHistoryFreezeCoverage {
  readonly active: boolean
  isFrozen(table: string, recordId: string): boolean
  projection?(table: string, recordId: string): Readonly<Row> | null
}
/** Extra domain rows belong to this frozen proof graph, without reclassifying unrelated author facts. */
export function readOrdinaryHistoryDomainRecords(db: Database.Database): { table: 'drafts' | 'contents' | 'reviews' | 'revisions' | 'review_cycle_merges'; recordId: string }[] {
  if (!exists(db, TABLES[2])) return []
  const records = new Map<string, { table: 'drafts' | 'contents' | 'reviews' | 'revisions' | 'review_cycle_merges'; recordId: string }>()
  const add = (table: 'drafts' | 'contents' | 'reviews' | 'revisions' | 'review_cycle_merges', recordId: string | number) => {
    records.set(`${table}:${recordId}`, { table, recordId: String(recordId) })
  }
  for (const row of db.prepare("SELECT semantic_history_json FROM workflow_batch_effects WHERE receipt_kind='review_commit' AND semantic_history_json IS NOT NULL").all() as Row[]) {
    const proof = parseOrdinarySemanticHistory(JSON.parse(text(row.semantic_history_json)))
    if (proof.kind !== 'ordinary-review-history' || proof.version !== 2 || !proof.followup) continue
    add('drafts', proof.source.id)
    add('contents', positive(draft(db, proof.source.id).content_id))
    for (const reviewId of [proof.reviewId, proof.followup.confirmation?.reviewId, proof.followup.recheck?.reviewId,
      ...proof.followup.confirmationHistory.map(value => value.reviewId)]) {
      if (reviewId === undefined) continue
      add('reviews', reviewId)
      add('contents', positive(savedReview(db, reviewId).content_id))
    }
    for (const revision of [...proof.followup.discardedRevisions, ...(proof.followup.revision ? [proof.followup.revision] : [])]) {
      add('revisions', revision.revisionId)
      add('contents', positive(one(db, 'SELECT content_id FROM revisions WHERE id=?', revision.revisionId).content_id))
    }
    if (proof.followup.merge) add('review_cycle_merges', proof.cycleId)
  }
  return [...records.values()]
}
/** Sidecar coverage is separate from schema verification; a DB proof never grants live authority. */
export function assertOrdinaryHistoryFreezeCoverage(db: Database.Database, freeze: OrdinaryHistoryFreezeCoverage): void {
  const context = readVerifiedOrdinaryHistory(db)
  const require = (table: string, recordId: unknown) => {
    if (!freeze.active || !freeze.isFrozen(table, String(recordId))) throw new Error('PORTABLE_RUNTIME_FREEZE_INVALID')
  }
  const requireProjection = (table: string, recordId: unknown, field: string, value: unknown) => {
    require(table, recordId)
    const projection = freeze.projection?.(table, String(recordId))
    const allowed: Record<string, readonly string[]> = { workflow_batch_tasks: ['recipe_json'], workflow_batch_steps: ['input_json'],
      workflow_batch_effects: ['semantic_history_json'], generation_artifacts: ['artifact_json'], generation_attempts: ['attempt_json'],
      generation_roots: ['action_json', 'budget_json'] }
    if (!projection || Object.keys(projection).some(key => !allowed[table]?.includes(key))
      || !isDeepStrictEqual(projection[field], value)) throw new Error('PORTABLE_RUNTIME_FREEZE_INVALID')
  }
  for (const taskId of context.taskIds) {
    const task = one(db, 'SELECT * FROM workflow_batch_tasks WHERE task_id=?', taskId)
    require('workflow_batch_tasks', taskId)
    requireProjection('workflow_batch_tasks', taskId, 'recipe_json', JSON.parse(text(task.recipe_json)))
    const steps = db.prepare('SELECT * FROM workflow_batch_steps WHERE task_id=?').all(taskId) as Row[]
    const rootIds = new Set([id(one(db, 'SELECT root_action_id FROM generation_runs WHERE run_id=?', id(task.batch_run_id)).root_action_id),
      ...steps.map(step => id(one(db, 'SELECT root_action_id FROM generation_runs WHERE run_id=?', id(step.run_id)).root_action_id))])
    const runIds = new Set<string>()
    for (const rootId of rootIds) for (const run of db.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=?').all(rootId) as Row[])
      runIds.add(id(run.run_id))
    for (const step of steps) {
      require('workflow_batch_steps', step.step_id)
      requireProjection('workflow_batch_steps', step.step_id, 'input_json', JSON.parse(text(step.input_json)))
      const effect = db.prepare('SELECT * FROM workflow_batch_effects WHERE step_id=?').get(step.step_id) as Row | undefined
      if (effect) {
        require('workflow_batch_effects', step.step_id)
        requireProjection('workflow_batch_effects', step.step_id, 'semantic_history_json',
          effect.semantic_history_json === null ? null : parseOrdinarySemanticHistory(JSON.parse(text(effect.semantic_history_json))))
      }
    }
    for (const runId of runIds) {
      require('generation_runs', runId)
      const run = one(db, 'SELECT * FROM generation_runs WHERE run_id=?', runId)
      require('generation_roots', run.root_action_id)
      if (!isDeepStrictEqual(json(run.binding_json), {})) invalid()
      const root = one(db, 'SELECT * FROM generation_roots WHERE root_action_id=?', id(run.root_action_id))
      const action = object(JSON.parse(text(root.action_json)), ['rootActionId', 'operation', 'status'])
      object(JSON.parse(text(root.budget_json)), ['maxPhysicalRequests', 'maxTokenLiability', 'maxOutputPerRequest', 'maxActiveElapsedMs'])
      requireProjection('generation_roots', run.root_action_id, 'action_json', action)
      requireProjection('generation_roots', run.root_action_id, 'budget_json', json(root.budget_json))
      if (root.idempotency_key !== `portable-history:${run.root_action_id}` || action.projectId !== undefined || action.epoch !== undefined
        || run.open_key !== `portable-history:${runId}`) invalid()
      for (const attempt of db.prepare('SELECT * FROM generation_attempts WHERE run_id=?').all(runId) as Row[]) {
        require('generation_attempts', attempt.attempt_id)
        const physical = json(attempt.attempt_json)
        object(physical, ['attemptId', 'rootActionId', 'status', 'reservedTokens', 'requestedOutputTokens',
          ...(physical.actualTokens === undefined ? [] : ['actualTokens'])])
        requireProjection('generation_attempts', attempt.attempt_id, 'attempt_json', physical)
        if (attempt.invocation_nonce !== `portable-history:${attempt.attempt_id}` || attempt.usage_receipt_json !== null) invalid()
        for (const artifact of db.prepare('SELECT artifact_id,artifact_json FROM generation_artifacts WHERE attempt_id=?').all(attempt.attempt_id) as Row[]) {
          require('generation_artifacts', artifact.artifact_id)
          const visible = object(JSON.parse(text(artifact.artifact_json)), ['artifactId', 'attemptId', 'rootActionId', 'revision', 'text', 'textHash'])
          requireProjection('generation_artifacts', artifact.artifact_id, 'artifact_json', visible)
          if (visible.projectId !== undefined || visible.epoch !== undefined || visible.fingerprint !== undefined) invalid()
        }
        if (exists(db, 'generation_recovery_tails') && db.prepare('SELECT 1 FROM generation_recovery_tails WHERE attempt_id=?').get(attempt.attempt_id))
          require('generation_recovery_tails', attempt.attempt_id)
      }
    }
  }
  for (const cycleId of context.cycleIds) {
    require('review_cycles', cycleId)
    for (const finding of db.prepare('SELECT finding_id FROM review_findings WHERE cycle_id=?').all(cycleId) as Row[])
      require('review_findings', `${cycleId}:${finding.finding_id}`)
  }
  for (const row of readOrdinaryHistoryDomainRecords(db)) require(row.table, row.recordId)
}
