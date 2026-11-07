import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parseOrdinarySemanticHistory, ordinarySemanticHistoryHash, readVerifiedOrdinaryHistory,
  assertOrdinaryHistoryContext } from '../ordinary-review-history'
import { buildReviewCycleRecheckReport, type ReviewCycleRecheckContext } from '../../../src/shared/review-cycle'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const proof = { version: 1, kind: 'ordinary-review-history', cycleId: 'fictional-cycle', reviewId: 1, reviewIndex: 1,
  reportVersion: 2, draftCommitStepId: 'fictional-draft-step', artifact: { artifactId: 'fictional-artifact', revision: 1, textHash: 'a'.repeat(64) },
  source: { id: 1, chapterNumber: 1, version: 1, status: 'draft', content: 'Fictional prose.' },
  normalization: { writingLanguage: 'en-US', uiLocale: 'en-US', frozenGoals: { chapterNumber: 1, coverage: 'complete',
    items: [{ id: 'ch1:keyEvents:1', text: 'Find a fictional key.' }] }, preflightFindings: [{ stableFactKey: 'fact:fictional',
    severity: 'warning', sourceChapter: 1, evidence: 'Fictional evidence.', issue: { zhCN: 'issue', enUS: 'issue' },
    suggestion: { zhCN: 'suggestion', enUS: 'suggestion' } }] }, finishReason: 'stop' }
const ref = { artifactId: 'fictional-revision-artifact', revision: 1, textHash: 'b'.repeat(64) }
const revision = { revisionId: 1, revisionIndex: 1, runId: 'fictional-revision-run', attemptId: 'fictional-revision-attempt', artifact: ref,
  composition: { algorithm: 'visible-append-v1', sources: [{ artifact: ref, finishReason: 'stop' }], textHash: 'b'.repeat(64) }, finishReason: 'stop' }
const followed = { ...proof, version: 2, followup: { confirmation: { reviewId: 3 }, revision, merge: { mergedHash: 'c'.repeat(64) },
  recheck: { runId: 'fictional-recheck-run', attemptId: 'fictional-recheck-attempt', reviewId: 4, reviewIndex: 4,
    artifact: { ...ref, artifactId: 'fictional-recheck-artifact' }, reportVersion: 2, uiLocale: 'en-US', policyVersion: 2,
    finishReason: 'stop', artifactProjection: 'mapped-recheck', findingIds: ['fictional-finding'] },
  confirmationHistory: [{ reviewId: 2 }], discardedRevisions: [{ ...revision, revisionId: 2, confirmationReviewId: 2 }] } }

describe('closed ordinary review semantic history leaf', () => {
  it('hashes only the closed safe projection, independent of object-key order', () => {
    expect(parseOrdinarySemanticHistory(proof)).toEqual(proof)
    expect(ordinarySemanticHistoryHash(proof)).toBe(ordinarySemanticHistoryHash(Object.fromEntries(Object.entries(proof).reverse())))
    expect(parseOrdinarySemanticHistory({ version: 1, kind: 'draft-commit-history', draft: { id: 1, chapterNumber: 1,
      version: 1, status: 'draft', contentHash: 'a'.repeat(64) } })).toMatchObject({ kind: 'draft-commit-history' })
  })
  it.each(['root', 'artifact', 'source', 'normalization', 'goals', 'goal', 'preflight', 'issue', 'suggestion'] as const)(
    'rejects excluded/unknown nesting at %s instead of silently dropping it', location => {
      const changed = structuredClone(proof)
      const targets = { root: changed, artifact: changed.artifact, source: changed.source, normalization: changed.normalization,
        goals: changed.normalization.frozenGoals, goal: changed.normalization.frozenGoals.items[0]!,
        preflight: changed.normalization.preflightFindings[0]!, issue: changed.normalization.preflightFindings[0]!.issue,
        suggestion: changed.normalization.preflightFindings[0]!.suggestion }
      Object.assign(targets[location], { modelLeaseRevision: 'fictional-private-model-digest' })
      expect(() => parseOrdinarySemanticHistory(changed)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    })
  it.each(['1', 0, null, 3])('rejects reportVersion=%s without coercion', reportVersion => {
    expect(() => parseOrdinarySemanticHistory({ ...proof, reportVersion })).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
  })
  it('keeps contexts unforgeable, DB-bound, and invalid after a local write', () => {
    const db = new Database(':memory:'), other = new Database(':memory:')
    try {
      const context = readVerifiedOrdinaryHistory(db)
      assertOrdinaryHistoryContext(db, context)
      expect(() => assertOrdinaryHistoryContext(db, { taskIds: [], cycleIds: [] })).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
      expect(() => assertOrdinaryHistoryContext(other, context)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
      db.exec('CREATE TABLE fictional_change(id INTEGER)')
      expect(() => assertOrdinaryHistoryContext(db, context)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    } finally { db.close(); other.close() }
  })
  it('keeps old v1 closed while permitting explicit v2 historical slots and unbounded actual-domain lists', () => {
    expect(parseOrdinarySemanticHistory(followed)).toEqual(followed)
    expect(() => parseOrdinarySemanticHistory({ ...followed, version: 1 })).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    expect(() => parseOrdinarySemanticHistory({ ...proof, version: 2 })).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    const many = structuredClone(followed)
    many.followup.confirmationHistory = Array.from({ length: 256 }, (_, index) => ({ reviewId: index + 10 }))
    expect(parseOrdinarySemanticHistory(many)).toEqual(many)
  })
  it.each(['followup', 'confirmation', 'revision', 'composition', 'source', 'sourceArtifact', 'merge', 'recheck',
    'historicalConfirmation', 'discardedRevision'] as const)('rejects unknown v2 field at %s', location => {
      const value = structuredClone(followed), followup = value.followup
      const targets = { followup, confirmation: followup.confirmation, revision: followup.revision,
        composition: followup.revision.composition, source: followup.revision.composition.sources[0]!,
        sourceArtifact: followup.revision.composition.sources[0]!.artifact, merge: followup.merge, recheck: followup.recheck,
        historicalConfirmation: followup.confirmationHistory[0]!, discardedRevision: followup.discardedRevisions[0]! }
      Object.assign(targets[location], { modelLeaseRevision: 'fictional-excluded-digest' })
      expect(() => parseOrdinarySemanticHistory(value)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    })
  it.each(['duplicate-confirmation', 'current-confirmation', 'duplicate-revision', 'current-revision', 'unordered-confirmation',
    'empty-composition', 'duplicate-artifact', 'unfinished-composition', 'empty-findings', 'duplicate-finding'] as const)(
    'rejects invalid closed list/composition boundary: %s', mode => {
      const value = structuredClone(followed), followup = value.followup
      if (mode === 'duplicate-confirmation') followup.confirmationHistory.push(followup.confirmationHistory[0]!)
      if (mode === 'current-confirmation') followup.confirmationHistory[0]!.reviewId = followup.confirmation.reviewId
      if (mode === 'duplicate-revision') followup.discardedRevisions.push(followup.discardedRevisions[0]!)
      if (mode === 'current-revision') followup.discardedRevisions[0]!.revisionId = followup.revision.revisionId
      if (mode === 'unordered-confirmation') followup.confirmationHistory = [{ reviewId: 5 }, { reviewId: 2 }]
      if (mode === 'empty-composition') followup.revision.composition.sources = []
      if (mode === 'duplicate-artifact') followup.revision.composition.sources.push(followup.revision.composition.sources[0]!)
      if (mode === 'unfinished-composition') followup.revision.composition.sources[0]!.finishReason = 'length'
      if (mode === 'empty-findings') followup.recheck.findingIds = []
      if (mode === 'duplicate-finding') followup.recheck.findingIds.push(followup.recheck.findingIds[0]!)
      expect(() => parseOrdinarySemanticHistory(value)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    })
  it('retains original context order when historical finding labels reverse sorting, including eligible and mustShow findings', () => {
    const context: ReviewCycleRecheckContext = { version: 2, cycleId: 'fictional-cycle', comparisonVersion: 1,
      mergedHash: 'a'.repeat(64), findingSetHash: 'b'.repeat(64), sourceContent: 'The fictional old latch was open.',
      findings: ['old:a', 'old:b', 'old:c'].map((findingId, index) => ({ findingId, targetId: `goal:${index}`,
        category: 'Goal', kind: 'objective', problem: `Fictional problem ${index}.`, ...(index === 2 ? { mustShow: true as const } : {}) })) }
    const next = new Map([['old:a', 'new:z'], ['old:b', 'new:y'], ['old:c', 'new:x']])
    const raw = JSON.stringify({ summary: 'Fictional ordered report.', items: context.findings.map(value => ({ findingId: value.findingId,
      targetId: value.targetId, resolved: false, evidenceQuote: 'The fictional new latch was shut.', reason: 'An author must verify.' })) })
    const projected = JSON.stringify({ ...JSON.parse(raw), items: JSON.parse(raw).items.map((value: { findingId: string }) => ({ ...value, findingId: next.get(value.findingId) })) })
    const policy = { ...context, findings: context.findings.map(value => ({ ...value, findingId: next.get(value.findingId)! })) }
    const before = buildReviewCycleRecheckReport(raw, 'The fictional new latch was shut.', context, 'en-US', 2)
    const after = buildReviewCycleRecheckReport(projected, 'The fictional new latch was shut.', policy, 'en-US', 2)
    expect(after).toEqual({ ...before, items: before.items.map(value => ({ ...value, findingId: next.get(String(value.findingId)) })),
      decisions: before.decisions.map(value => ({ ...value, findingId: next.get(value.findingId) })) })
    expect(after.decisions.map(value => value.reviewItemIndex)).toEqual([0, 1, 2])
    const incorrectlySorted = buildReviewCycleRecheckReport(projected, 'The fictional new latch was shut.',
      { ...policy, findings: [...policy.findings].sort((a, b) => a.findingId.localeCompare(b.findingId)) }, 'en-US', 2)
    expect(incorrectlySorted).not.toEqual(after)
    const ordered = structuredClone(followed)
    ordered.followup.recheck.findingIds = policy.findings.map(value => value.findingId)
    const closed = parseOrdinarySemanticHistory(ordered)
    expect(closed.kind === 'ordinary-review-history' && closed.followup?.recheck?.findingIds).toEqual(['new:z', 'new:y', 'new:x'])
  })
})
