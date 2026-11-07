import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { buildReviewGenerationReport } from '../../src/shared/review-generation-report'
import { buildReviewCycleRecheckReport, type ReviewCycleRecheckContext } from '../../src/shared/review-cycle'
import type { HumanConfirmedReviewSnapshot } from '../../src/shared/human-confirmed-review'
import { composeVisibleContinuation } from '../../src/shared/visible-continuation'
import type { ReviewRevisionContext } from '../../src/shared/review-revision-generation'

const HASH = /^[a-f0-9]{64}$/u
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum

export interface AttemptRow { attempt_id: string; run_id: string; root_action_id: string; run_root_action_id: string
  binding_json: string; attempt_json: string; usage_receipt_json: string | null }

export function effect(row: AttemptRow): Record<string, unknown> | null {
  if (!row.usage_receipt_json) return null
  const receipt = JSON.parse(row.usage_receipt_json) as { reviewRevisionEffect?: unknown }
  return receipt.reviewRevisionEffect && typeof receipt.reviewRevisionEffect === 'object'
    ? receipt.reviewRevisionEffect as Record<string, unknown> : null
}
export function proveEffect(db: Database.Database, row: AttemptRow, expected: {
  kind: 'review' | 'revision'; id: number; index: number; contentHash: string
  source: { id: number; chapterNumber: number; version: number; status: string; content: string }
  confirmation?: { reviewSourceId: number; content: string; originalReviewContentHash: string;
    snapshot: HumanConfirmedReviewSnapshot }
  recheck?: ReviewCycleRecheckContext
}): boolean {
  const stored = effect(row)
  if (!stored || stored.kind !== expected.kind || stored.id !== expected.id || stored.index !== expected.index
    || stored.contentHash !== expected.contentHash || !HASH.test(String(stored.contextHash))) return false
  if (stored.reportVersion !== undefined && (stored.reportVersion !== 2 || expected.kind !== 'review')) return false
  const allowed = expected.kind === 'revision'
    ? ['artifact', 'compositionHash', 'contentHash', 'contextHash', 'id', 'index', 'kind']
    : ['artifact', 'contentHash', 'contextHash', 'id', 'index', 'kind', ...(stored.reportVersion === 2 ? ['reportVersion'] : [])]
  if (Object.keys(stored).sort().join() !== allowed.join()) return false
  const binding = JSON.parse(row.binding_json) as Record<string, unknown>
  const manifest = binding.sourceManifest as Record<string, unknown> | undefined
  const context = manifest?.reviewRevisionContext as Record<string, unknown> | undefined
  const source = context?.source as Record<string, unknown> | undefined
  const confirmation = context?.confirmation as Record<string, unknown> | undefined
  const recheck = context?.recheck as Record<string, unknown> | undefined
  const validRecheckVersionPair = !expected.recheck || recheck?.version === 1
    && (expected.recheck.version === 1 || expected.recheck.version === 2)
    || recheck?.version === 2 && expected.recheck.version === 2
  const frozenRecheck = validRecheckVersionPair && expected.recheck && recheck
    ? { ...expected.recheck, version: recheck.version } : expected.recheck
  const sourceHash = hash(expected.source.content)
  if (!context || context.version !== 1 || context.operation !== (expected.kind === 'review' ? 'review-chapter' : 'refine-from-review')
    || !source || Object.keys(source).sort().join() !== 'chapterNumber,content,id,status,version'
    || source.id !== expected.source.id || source.chapterNumber !== expected.source.chapterNumber
    || source.version !== expected.source.version || source.status !== expected.source.status || source.content !== expected.source.content
    || context.sourceHash !== sourceHash || stored.contextHash !== hash(JSON.stringify(context))
    || !context.config || !['zh-CN', 'en-US'].includes(String(context.writingLanguage))
    || !['zh-CN', 'en-US'].includes(String(context.uiLocale)) || !Array.isArray(context.authorInputs)
    || typeof context.characterStates !== 'string' || typeof context.worldbuilding !== 'string'
    || !Array.isArray(context.history) || !Array.isArray(context.blueprints) || !context.frozenGoals
    || !Array.isArray(context.preflightFindings)
    || manifest?.reviewRevisionContextHash !== stored.contextHash || manifest.operation !== context.operation
    || JSON.stringify(manifest.authorInputs) !== JSON.stringify([{ id: 'review-revision-context', text: JSON.stringify(context) }])
    || (expected.kind === 'review' && (confirmation !== undefined
      || !validRecheckVersionPair || !isDeepStrictEqual(recheck, frozenRecheck)))
    || (expected.kind === 'revision' && (!expected.confirmation || !confirmation
      || Object.keys(confirmation).sort().join() !== 'content,originalReviewContentHash,reviewSourceId,snapshot'
      || confirmation.reviewSourceId !== expected.confirmation.reviewSourceId
      || confirmation.content !== expected.confirmation.content
      || confirmation.originalReviewContentHash !== expected.confirmation.originalReviewContentHash
      || !isDeepStrictEqual(confirmation.snapshot, expected.confirmation.snapshot)
      || recheck !== undefined))) return false
  const attempt = JSON.parse(row.attempt_json) as Record<string, unknown>
  const usage = JSON.parse(row.usage_receipt_json!) as Record<string, unknown>
  const result = usage.result as Record<string, unknown> | undefined
  if (!['settled', 'unknown'].includes(String(attempt.status)) || result?.finishReason !== 'stop' || result.failureCode !== undefined) return false
  const artifactRef = stored.artifact as Record<string, unknown> | undefined
  if (!artifactRef || Object.keys(artifactRef).sort().join() !== 'artifactId,revision,textHash'
    || !nonempty(artifactRef.artifactId) || !integer(artifactRef.revision) || !HASH.test(String(artifactRef.textHash))) return false
  const artifactRow = db.prepare(`SELECT artifact_id,attempt_id,run_id,artifact_json,revision,status
    FROM generation_artifacts WHERE artifact_id=?`).get(artifactRef.artifactId) as {
      artifact_id: string; attempt_id: string; run_id: string; artifact_json: string; revision: number; status: string
    } | undefined
  if (!artifactRow || artifactRow.attempt_id !== row.attempt_id || artifactRow.run_id !== row.run_id
    || artifactRow.revision !== artifactRef.revision || artifactRow.status === 'discarded') return false
  const artifact = JSON.parse(artifactRow.artifact_json) as Record<string, unknown>
  const identity = usage.artifactIdentity as Record<string, unknown> | undefined
  if (artifact.artifactId !== artifactRef.artifactId || artifact.attemptId !== row.attempt_id
    || artifact.rootActionId !== row.root_action_id || artifact.projectId !== binding.projectId || !nonempty(artifact.epoch)
    || artifact.revision !== artifactRef.revision || artifact.textHash !== artifactRef.textHash
    || typeof artifact.text !== 'string' || hash(artifact.text) !== artifact.textHash
    || JSON.stringify(artifact.fingerprint) !== JSON.stringify(binding.fingerprint)
    || identity?.artifactId !== artifact.artifactId || identity.epoch !== artifact.epoch
    || JSON.stringify(identity.fingerprint) !== JSON.stringify(artifact.fingerprint)) return false
  if (expected.kind === 'review') {
    const frozen = context as unknown as ReviewRevisionContext
    const rebuilt = JSON.stringify(expected.recheck
      ? (() => { const report = buildReviewCycleRecheckReport(artifact.text as string, frozen.source.content, expected.recheck!, frozen.uiLocale,
        stored.reportVersion === 2 ? 2 : 1)
        return { summary: report.summary, items: report.items } })()
      : buildReviewGenerationReport({ content: artifact.text as string,
        sourceContent: frozen.source.content, frozenGoals: frozen.frozenGoals, writingLanguage: frozen.writingLanguage,
        uiLocale: frozen.uiLocale, preflightFindings: frozen.preflightFindings, reportVersion: stored.reportVersion === 2 ? 2 : 1 }), null, 2)
    if (hash(rebuilt) !== expected.contentHash) return false
  }
  if (expected.kind === 'revision') {
    const composition = usage.visibleComposition as Record<string, unknown> | undefined
    const sources = composition?.sources as unknown[] | undefined, artifactIds = composition?.artifactIds
    if (!HASH.test(String(stored.compositionHash)) || stored.compositionHash !== expected.contentHash
      || composition?.algorithm !== 'visible-append-v1' || composition.textHash !== stored.compositionHash
      || !Array.isArray(artifactIds) || artifactIds.length < 1 || artifactIds.length > 32
      || new Set(artifactIds).size !== artifactIds.length || artifactIds.at(-1) !== artifactRef.artifactId
      || !Array.isArray(sources) || JSON.stringify(sources.at(-1)) !== JSON.stringify(artifactRef)) return false
    let composed = '', previousOrdinal = -1
    const rebuiltSources: unknown[] = []
    for (const artifactId of artifactIds) {
      if (!nonempty(artifactId)) return false
      const candidate = db.prepare(`SELECT a.attempt_id,a.run_id,a.status,a.artifact_json,a.revision,t.rowid AS ordinal,
          t.attempt_json,t.usage_receipt_json FROM generation_artifacts a JOIN generation_attempts t ON t.attempt_id=a.attempt_id
          WHERE a.artifact_id=?`).get(artifactId) as { attempt_id: string; run_id: string; status: string; artifact_json: string;
            revision: number; ordinal: number; attempt_json: string; usage_receipt_json: string } | undefined
      if (!candidate || candidate.run_id !== row.run_id || candidate.status === 'discarded' || candidate.ordinal <= previousOrdinal) return false
      const visible = JSON.parse(candidate.artifact_json) as Record<string, unknown>
      const physical = JSON.parse(candidate.attempt_json) as Record<string, unknown>
      const candidateUsage = JSON.parse(candidate.usage_receipt_json) as Record<string, unknown>
      const candidateResult = candidateUsage.result as Record<string, unknown> | undefined
      const candidateIdentity = candidateUsage.artifactIdentity as Record<string, unknown> | undefined
      if (!['settled', 'unknown'].includes(String(physical.status)) || !['stop', 'length'].includes(String(candidateResult?.finishReason))
        || typeof visible.text !== 'string' || !visible.text.trim() || hash(visible.text) !== visible.textHash
        || visible.artifactId !== artifactId || visible.attemptId !== candidate.attempt_id || visible.rootActionId !== row.root_action_id
        || visible.projectId !== binding.projectId || !nonempty(visible.epoch) || visible.revision !== candidate.revision
        || JSON.stringify(visible.fingerprint) !== JSON.stringify(binding.fingerprint)
        || candidateIdentity?.artifactId !== artifactId || candidateIdentity.epoch !== visible.epoch
        || JSON.stringify(candidateIdentity.fingerprint) !== JSON.stringify(visible.fingerprint)) return false
      const next = rebuiltSources.length > 0 ? composeVisibleContinuation(composed, visible.text) : visible.text.trim()
      if (!next.trim() || (rebuiltSources.length > 0
        && (next.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (composed.match(/[\p{L}\p{N}]/gu)?.length ?? 0))) return false
      composed = next; previousOrdinal = candidate.ordinal
      rebuiltSources.push({ artifactId, revision: visible.revision, textHash: visible.textHash })
    }
    if (hash(composed) !== stored.compositionHash || JSON.stringify(rebuiltSources) !== JSON.stringify(sources)) return false
  } else if (stored.compositionHash !== undefined) return false
  return true
}
