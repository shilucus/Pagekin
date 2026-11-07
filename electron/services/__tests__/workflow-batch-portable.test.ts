import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectDatabase } from '../../database'
import * as databaseModule from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { parseWorkflowBatchRecipe, parseWorkflowBatchStepInput, type WorkflowBatchStepInput } from '../../../src/shared/workflow-batch-contract'
import { parseWorkflowDriverTask } from '../../../src/shared/workflow-driver-contract'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import { DRAFT_VISIBLE_TEXT_VERSION } from '../../../src/shared/draft-visible-text'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { WorkflowBatchRepository } from '../../repositories/workflow-batch-repository'
import { ReviewCycleRepository } from '../../repositories/review-cycle-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { ChapterDeletionRepository } from '../../repositories/chapter-deletion-repository'
import { ReviewRepository } from '../../repositories/review-repository'
import { RevisionRepository } from '../../repositories/revision-repository'
import { createHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief } from '../../../src/shared/human-confirmed-review'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { buildReviewCycleRecheckReport, parseRecheckItems } from '../../../src/shared/review-cycle'
import { verifyM03ReviewCycle } from '../../migrations/m03-review-cycle'
import { verifyCurrentReviewCycles } from '../../migrations/current-review-cycle'
import { readWorkflowBatchEffectProof, verifyM13WorkflowBatch } from '../../migrations/m13-workflow-batch'
import { assertOrdinaryHistoryContext, assertOrdinaryHistoryFreezeCoverage, readVerifiedOrdinaryHistory,
  readOrdinaryReviewHistoryReport, ordinarySemanticHistoryHash, parseOrdinarySemanticHistory } from '../../migrations/ordinary-review-history'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { GenerationDraftEffects } from '../generation-draft-effects'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { openVerifiedProjectDatabase, closeCapturedProjectDatabase, type ProjectRuntime } from '../project-runtime'
import { probeProjectSqlite } from '../sqlite-project-migration'
import { readWorkflowBatchReceipt } from '../workflow-batch-authority'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
// Finite harness budget for native multi-generation archives, not a product performance SLA.
const MULTI_GENERATION_ARCHIVE_TIMEOUT_MS = 30_000
const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const machine = hash('fictional-batch-original-model-source-skill-machine')
const body = 'The fictional writer found a brass key beside the door and kept it for the next morning. '.repeat(15).trim()
  + ' The cracked latch stayed open. The brass key was left outside.'
const revisedBody = body.replace('The cracked latch stayed open.', 'The repaired latch was shut.')
  .replace('The brass key was left outside.', 'The brass key was stored safely.')
const rawReport = JSON.stringify({ summary: 'Fictional ordinary review.', items: [{ category: 'Expression', severity: 'warning',
  description: 'Describe the fictional key.', quote: 'brass key' }], goalReviews: [{ id: 'ch1:keyEvents:1', status: 'unmet',
  description: 'The latch is still damaged.', evidence: [{ quote: 'The cracked latch stayed open.' }] },
  { id: 'ch1:keyEvents:2', status: 'unmet', description: 'The key is not stored safely.', evidence: [{ quote: 'The brass key was left outside.' }] },
  { id: 'ch1:mustShow:1', status: 'unknown', description: 'The author must show a definite repair.', evidence: [] }] })
const recipe = parseWorkflowBatchRecipe({ schemaVersion: 2, writingLanguage: 'en-US', uiLocale: 'en-US',
  intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 1 }, targetUnits: 100 }, authorInputs: [] })
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbp-'))
  roots.push(base)
  const root = path.join(base, 'a'), projectId = randomUUID(), storage = path.join(root, '.ai-novel')
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-08T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  return { base, root, projectId, databasePath: path.join(storage, 'project.db') }
}
function reviewOwner(db: import('better-sqlite3').Database, root: string, projectId: string) {
  const model: ModelProfile = { id: 'fictional-model', name: 'Fictional', provider: 'openai', protocol: 'openai',
    modelName: 'fictional-model', apiKey: 'fictional-key-no-network', baseUrl: 'https://fictional.invalid/v1',
    temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768,
      maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const loadModel = (id: string) => id === model.id ? model : null
  const epoch = randomUUID(), deps = { db, projectStorageRoot: path.join(root, '.ai-novel'), globalDataRoot: root,
    readBuiltinPrompt: () => 'Review the fictional frozen prose.' }
  let output = rawReport
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: output })
    return { finishReason: 'stop' as const, usage: null }
  })
  const owner = createMainGenerationOwner({ database: db, projectPath: root, projectId, epoch, assertCurrent: () => {},
    leases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel, dispatch,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId, epoch,
      modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt,
      readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  const run = async (draftId: number, current = { status: 'draft' as 'draft' | 'revised', content: body }) => {
    const prepared = owner.prepareReviewRevision({ operation: 'review-chapter', draftId,
      expectedDraft: { chapterNumber: 1, version: 1, status: current.status, contentHash: hash(current.content) }, authorInputs: [], uiLocale: 'en-US' })
    const selection: BeginGenerationRequest = { operation: 'review-chapter', uiActionNonce: randomUUID(), modelId: model.id,
      chapterNumber: 1, selectedDraftIds: [draftId], selectedFinalizedDraftIds: [], promptKeys: ['consistency_check'],
      skillStages: ['review'], output: 'structured-data', reviewRevisionContextId: prepared.contextId,
      authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }] }
    const view = owner.begin(selection), prompt = 'Review the fictional frozen prose.'
    owner.bindMaterialDecision(view.handle, { version: 1, verdict: 'admitted', promptHash: hash(prompt),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 0 },
      coverage: { required: 0, included: 0, complete: true }, included: [], omitted: [] })
    const task = { purpose: 'review-chapter', output: 'structured-data' as const, messages: [{ role: 'user' as const, content: prompt }] }
    const result = await owner.execute({ handle: view.handle, invocationNonce: randomUUID(), task })
    const artifact = result.run.artifacts.at(-1)!
    const ref = { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }
    const receipt = owner.commitReview({ contextId: prepared.contextId, handle: view.handle, artifact: ref })
    return { runId: view.handle.runId, artifact: ref, task, receipt }
  }
  return { owner, run, dispatch, setOutput: (value: string) => { output = value }, modelId: model.id }
}

type FollowupStage = 'confirmation' | 'revision' | 'merge' | 'recheck' | 'invalid' | 'duplicate' | 'missing' | 'wrong-finding' | 'wrong-target' | 'wrong-known-target'
  | 'discard' | 'regenerate' | 'replace-pending'
async function authorFollowup(db: import('better-sqlite3').Database, live: ReturnType<typeof reviewOwner>,
  original: Awaited<ReturnType<ReturnType<typeof reviewOwner>['run']>>, cycleId: string, stage: FollowupStage) {
  const { owner } = live, source = original.receipt.source
  const expectedDraft = { chapterNumber: source.chapterNumber, version: source.version, status: source.status, contentHash: hash(source.content) }
  const confirmations: number[] = [], revisions: number[] = []
  const confirm = (legacy = false) => {
    const report = JSON.parse(original.receipt.content) as { summary: string; items: Record<string, unknown>[] }
    const findings = ReviewCycleRepository.getByReviewId(original.receipt.id, db)!.findings
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: original.receipt.id, sourceDraft: source,
      ...(legacy ? {} : { cycleId }), summary: report.summary,
      authorGuidance: `Keep the author wording exactly, including this quoted identifier: ${findings[0]!.findingId}`,
      items: report.items.map((item, index) => ({ category: String(item.category), severity: String(item.severity),
        description: String(item.description), ...(typeof item.quote === 'string' ? { quote: item.quote } : {}),
        ...(typeof item.goalId === 'string' ? { goalId: item.goalId } : {}),
        ...(!legacy ? { findingId: findings.find(value => value.reviewItemIndex === index)!.findingId } : {}),
        decision: !legacy && item.goalId === undefined ? 'waive' as const : 'apply' as const, origin: 'ai' as const })) })!
    expect(snapshot).not.toBeNull()
    const content = serializeHumanConfirmedReviewSnapshot(snapshot)
    const saved = db.transaction(() => {
      const saved = ReviewRepository.create({ baseDraftId: source.id, content, expectedSource: source }, db)
      ReviewCycleRepository.commitAuthorConfirmation({ cycleId, confirmationReviewId: saved.id }, db)
      return saved
    })()
    confirmations.push(saved.id)
    return { saved, snapshot, content }
  }
  let confirmation = confirm(stage === 'regenerate')
  const generate = async () => {
    const prepared = owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: source.id, expectedDraft,
      reviewSourceId: confirmation.saved.id, confirmedReviewContent: confirmation.content, authorInputs: [], uiLocale: 'en-US' })
    const view = owner.begin({ operation: 'refine-from-review', uiActionNonce: randomUUID(), modelId: live.modelId,
      chapterNumber: source.chapterNumber, selectedDraftIds: [source.id], selectedFinalizedDraftIds: [], promptKeys: ['refine_from_review'],
      skillStages: ['refinement'], output: 'visible-text', parentRootActionId: prepared.parentRootActionId,
      reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }] })
    const prompt = 'Repair only the fictional latch.', brief = renderHumanConfirmedReviewBrief(confirmation.snapshot, 'en-US')
    owner.bindMaterialDecision(view.handle, { version: 1, verdict: 'admitted', promptHash: hash(prompt),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: Buffer.byteLength(brief) },
      coverage: { required: 1, included: 1, complete: true }, included: [{ sourceId: `review:confirmed:${confirmation.saved.id}`,
        revision: confirmation.saved.id, contentHash: hash(brief), category: 'author', required: true, units: Buffer.byteLength(brief) }], omitted: [] })
    live.setOutput(revisedBody)
    const result = await owner.execute({ handle: view.handle, invocationNonce: randomUUID(), task: {
      purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    const artifact = result.run.artifacts.at(-1)!
    const composition = owner.composeVisible(view.handle, [artifact.artifactId], hash(revisedBody), 'visible-append-v1')
    const saved = owner.commitRevision({ contextId: prepared.contextId, handle: view.handle, expectedCompositionHash: composition.textHash })
    revisions.push(saved.id)
    return saved
  }
  if (stage === 'confirmation') return { confirmations, revisions }
  let revision = await generate()
  if (stage === 'discard' || stage === 'regenerate') {
    RevisionRepository.markDiscarded(revision.id, db)
    if (stage === 'discard') return { confirmations, revisions }
    confirmation = confirm()
    revision = await generate()
  }
  if (stage === 'replace-pending') revision = await generate()
  if (['revision', 'regenerate', 'replace-pending'].includes(stage)) return { confirmations, revisions }
  RevisionRepository.mergeIntoDraft({ revisionId: revision.id, targetDraftId: source.id, expectedDraftContent: body,
    mergedContent: revisedBody, wordCount: countDraftUnits(revisedBody) }, db)
  if (stage === 'merge') return { confirmations, revisions }
  const plan = ReviewCycleRepository.planRecheck(cycleId, db)
  expect(plan.disposition).toBe('required')
  const prepared = owner.prepareReviewRevision({ operation: 'review-chapter', draftId: source.id,
    expectedDraft: { ...expectedDraft, status: 'revised', contentHash: hash(revisedBody) }, reviewCycleId: cycleId,
    expectedMergedHash: hash(revisedBody), authorInputs: [], uiLocale: 'en-US' })
  const view = owner.begin({ operation: 'review-chapter', uiActionNonce: randomUUID(), modelId: live.modelId,
    chapterNumber: source.chapterNumber, selectedDraftIds: [source.id], selectedFinalizedDraftIds: [], promptKeys: ['consistency_check'],
    skillStages: ['review'], output: 'structured-data', parentRootActionId: prepared.parentRootActionId,
    reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }] })
  const prompt = 'Recheck the fictional changed latch.'
  owner.bindMaterialDecision(view.handle, { version: 1, verdict: 'admitted', promptHash: hash(prompt),
    capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 0 },
    coverage: { required: 0, included: 0, complete: true }, included: [], omitted: [] })
  const items = plan.context!.findings.map(finding => ({ findingId: finding.findingId, targetId: finding.targetId,
    resolved: false, evidenceQuote: 'The repaired latch was shut.', reason: 'Author verification is still required.' }))
  if (stage === 'duplicate') items.push({ ...items[0]! })
  if (stage === 'missing') items.shift()
  if (stage === 'wrong-finding') items[0]!.findingId = `fictional-private-unmatched:${machine}`
  if (stage === 'wrong-target') items[0]!.targetId = `fictional-private-target:${machine}`
  if (stage === 'wrong-known-target') items[0]!.targetId = items[1]!.targetId
  const raw = stage === 'invalid' ? JSON.stringify({ summary: 'Invalid fixture.', items, forbiddenMixedBinding: machine })
    : JSON.stringify({ summary: 'Fictional recheck report.', items })
  live.setOutput(raw)
  const result = await owner.execute({ handle: view.handle, invocationNonce: randomUUID(), task: {
    purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: prompt }] } })
  const artifact = result.run.artifacts.at(-1)!
  const recheck = owner.commitReview({ contextId: prepared.contextId, handle: view.handle,
    artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })
  const policy = { ...plan.context!, version: 2 as const }
  return { confirmations, revisions, recheck, policy, raw,
    built: buildReviewCycleRecheckReport(raw, revisedBody, policy, 'en-US', 2) }
}

/** Synthetic model I/O only; both domain commits use the actual production services. */
async function seed(f: ReturnType<typeof fixture>, unknown = false, followup?: FollowupStage) {
  const db = new Database(f.databasePath)
  let owner: ReturnType<typeof reviewOwner> | undefined
  try {
    db.pragma('foreign_keys=ON')
    db.exec("INSERT OR IGNORE INTO project_core(id,project_name,writing_language) VALUES('main','Fictional','en-US'); INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'Fictional key','Repair the cracked latch;Store the brass key safely');")
    db.prepare("UPDATE project_core SET world_setting=? WHERE id='main'").run('\u3010\u7b2c1\u7ae0\u5fc5\u73b0\u3011The author must show a definite repair.')
    const epoch = randomUUID(), runs = new GenerationRunRepository(() => db, () => 100)
    const fingerprint = { chapterBriefHash: machine, authorGuidanceHash: machine, dependencyHash: machine, contextSnapshotHash: machine,
      templateHash: machine, skillSnapshotHash: machine, modelLeaseRevision: machine, policyHash: machine, outputContractHash: machine }
    const budget = { maxPhysicalRequests: 8, maxTokenLiability: 10_000, maxOutputPerRequest: 2048, maxActiveElapsedMs: 30_000 }
    const binding = { projectId: f.projectId, epoch, fingerprint, contextSnapshotId: 'fictional-original-context', sourceRefs: [] }
    const batch = runs.open({ ...binding, operation: 'batch-chapters', uiActionNonce: randomUUID(), frozenInputHash: machine, budget,
      sourceManifest: { operation: 'batch-chapters', batchIntent: recipe.intent, authorInputs: [], freezeWritingLanguage: true,
        writingLanguage: 'en-US', modelReceipt: { modelId: 'fictional-model' } } })
    const draftRun = runs.open({ ...binding, operation: 'chapter-draft', uiActionNonce: randomUUID(), frozenInputHash: machine, budget,
      parentRootActionId: batch.rootActionId, sourceManifest: { operation: 'chapter-draft', chapterNumber: 1, batchId: batch.runId,
        outputContract: 'visible-text', freezeWritingLanguage: true, writingLanguage: 'en-US', authorInputs: [{ id: 'draft:target-units', text: '100' }] } })
    const taskId = randomUUID(), operationKey = randomUUID(), requestHash = hash(randomUUID())
    const task = parseWorkflowDriverTask({ purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'drafting',
      messages: [{ role: 'user', content: 'Write fictional prose.' }] })
    const nonce = randomUUID(), reserved = runs.reserve(draftRun.runId, nonce, hash(JSON.stringify([task, machine, machine])), 2048, 2048, undefined, task.purpose, task)
    runs.markDispatched(reserved.attempt.attemptId)
    const artifact = runs.snapshot(reserved.attempt.attemptId, 0, unknown ? 'A fictional interrupted prefix.' : body)
    runs.settle(reserved.attempt.attemptId, { trusted: true, actualTokens: 10, policy: { estimatorVersion: 'fictional-v1',
      safetyMarginTokens: 0, reasoning: 'included-in-completion', canBoundTotalLiability: true } }, unknown ? 'error' : 'stop')
    const stepIds: string[] = [], effectIds: string[] = []
    const insertStep = (kind: string, role: string, runId: string, input: WorkflowBatchStepInput, invocationNonce: string | null,
      receiptKind?: string, attemptId?: string, contentHash?: string) => {
      const stepId = randomUUID(), closed = parseWorkflowBatchStepInput(input)
      db.prepare('INSERT INTO workflow_batch_steps VALUES(?,?,?,?,?,0,?,?,?,?,?)').run(stepId, taskId, 1, role, kind,
        randomUUID(), runId, invocationNonce, JSON.stringify(closed), hash(JSON.stringify(closed)))
      stepIds.push(stepId)
      if (receiptKind) {
        db.prepare('INSERT INTO workflow_batch_effects VALUES(?,?,?,?,100,NULL,NULL)').run(stepId, receiptKind, attemptId, contentHash)
        effectIds.push(stepId)
        expect(readWorkflowBatchEffectProof(db, taskId, stepId)).toEqual({ receiptKind, receiptAttemptId: attemptId, contentHash })
      }
      return stepId
    }
    let review: Awaited<ReturnType<ReturnType<typeof reviewOwner>['run']>> | undefined
    let draftId: number | undefined
    if (!unknown) {
      runs.composeVisible(draftRun.runId, [artifact.artifactId], hash(body), DRAFT_VISIBLE_TEXT_VERSION)
      const saved = new GenerationDraftEffects(db, runs).commit({ handle: { projectId: f.projectId, epoch, rootActionId: batch.rootActionId,
        runId: draftRun.runId }, chapterNumber: 1, source: 'write', batchId: batch.runId, expectedCompositionHash: hash(body) }, () => {})
      draftId = saved.id
      owner = reviewOwner(db, f.root, f.projectId)
      review = await owner.run(saved.id)
    } else {
      const tail = ' Fictional visible suffix retained only as history.'
      db.prepare('INSERT INTO generation_recovery_tails VALUES(?,?,?,?,?,?,?)').run(reserved.attempt.attemptId, artifact.artifactId,
        artifact.revision, artifact.textHash, tail, hash(tail), '2026-11-08T00:00:00.000Z')
    }
    const reviewRun = review && runs.get(review.runId), reviewHash = reviewRun?.binding.fingerprint.modelLeaseRevision ?? machine
    db.prepare("INSERT INTO workflow_batch_tasks VALUES(?,?,?,?,'prepared-batch-review-v2',?,1,?,?,?, ?,?,?,100,100)")
      .run(taskId, f.projectId, operationKey, requestHash, batch.runId, unknown ? 'blocked' : 'waiting_review',
        unknown ? 'GENERATION_RESULT_UNKNOWN' : null, JSON.stringify(recipe), hash(JSON.stringify(recipe)), 'fictional-model', reviewHash)
    insertStep('draft', 'draft', draftRun.runId, { kind: 'model', task }, nonce, unknown ? undefined : 'model', reserved.attempt.attemptId, artifact.textHash)
    if (review) {
      insertStep('compose', 'draft', draftRun.runId, { kind: 'compose', artifactIds: [artifact.artifactId], algorithm: DRAFT_VISIBLE_TEXT_VERSION,
        expectedTextHash: hash(body) }, null, 'composition', reserved.attempt.attemptId, hash(body))
      insertStep('draft_commit', 'draft', draftRun.runId, { kind: 'draft-commit', expectedCompositionHash: hash(body) }, null,
        'draft_commit', reserved.attempt.attemptId, hash(body))
      const row = db.prepare('SELECT attempt_id,invocation_nonce FROM generation_attempts WHERE run_id=?').get(review.runId) as { attempt_id: string; invocation_nonce: string }
      insertStep('review', 'review', review.runId, { kind: 'model', task: review.task }, row.invocation_nonce, 'model', row.attempt_id, review.artifact.textHash)
      insertStep('review_commit', 'review', review.runId, { kind: 'review-commit', artifact: review.artifact }, null,
        'review_commit', row.attempt_id, review.receipt.contentHash)
    }
    const cycleId = review && (db.prepare('SELECT cycle_id FROM review_cycles WHERE review_id=?').pluck().get(review.receipt.id) as string)
    const author = followup && owner && review && cycleId ? await authorFollowup(db, owner, review, cycleId, followup) : undefined
    expect(verifyM03ReviewCycle(db)).toBe(true)
    expect(verifyM13WorkflowBatch(db)).toBe(true)
    return { taskId, batchRunId: batch.runId, stepIds, effectIds, cycleId, draftId, review, author, excluded: [operationKey, requestHash, nonce,
      epoch, machine, reviewHash, hash(reviewHash)] }
  } finally { owner?.owner.suspendForProjectClose(); db.close() }
}

async function copy(f: ReturnType<typeof fixture>, sourceRoot: string, projectId: string, generation: number) {
  const archivePath = path.join(f.base, `${generation}.ainovel`), targetProjectRoot = path.join(f.base, `c${generation}`)
  const attemptParentPath = path.join(f.base, `e${generation}`)
  fs.mkdirSync(attemptParentPath)
  await exportPortableProject({ sourceProjectRoot: sourceRoot, projectSession: { projectId, projectPath: sourceRoot, leaseId: `fictional-${generation}` },
    targetArchivePath: archivePath, attemptParentPath, assertCurrentContext: () => {},
    assets: { snapshot: () => ({ files: [], verifyUnchanged: () => {} }) } })
  const restored = await restorePortableProject({ archivePath, targetProjectRoot })
  return { root: targetProjectRoot, databasePath: path.join(targetProjectRoot, '.ai-novel', 'project.db'), projectId: restored.targetProjectId }
}
function capturedRuntime(current: { root: string; projectId: string }, database: import('better-sqlite3').Database): ProjectRuntime {
  return { projectPath: current.root, canonicalRoot: current.root, projectId: current.projectId,
    projectStorageRoot: path.join(current.root, '.ai-novel'), database, databaseIdentity: Object.freeze({}),
    executionEpoch: 'fictional-restored-history-reader', phase: 'open' }
}

describe('v2 batch ordinary semantic history (real native commits; synthetic model I/O)', () => {
  it.each(['confirmation', 'revision', 'merge', 'recheck', 'invalid', 'duplicate', 'missing', 'wrong-finding', 'wrong-target', 'wrong-known-target',
    'discard', 'regenerate', 'replace-pending'] as const)('preserves actual author followup %s through two frozen copies', async stage => {
    const f = fixture(), source = await seed(f, false, stage), original = fs.readFileSync(f.databasePath)
    const { sourceFindings, reviews, revisions } = (() => {
      const live = new Database(f.databasePath, { readonly: true })
      try {
        return { sourceFindings: live.prepare('SELECT finding_id,category,problem_text,target_id FROM review_findings WHERE cycle_id=?').all(source.cycleId) as {
          finding_id: string; category: string; problem_text: string; target_id: string | null }[],
        reviews: live.prepare('SELECT r.id,c.body FROM reviews r JOIN contents c ON c.id=r.content_id ORDER BY r.id').all() as { id: number; body: string }[],
        revisions: live.prepare('SELECT r.id,r.status,r.review_source_id,c.body FROM revisions r JOIN contents c ON c.id=r.content_id ORDER BY r.id').all() }
      } finally { live.close() }
    })()
    let current: { root: string; databasePath: string; projectId: string } = { root: f.root, databasePath: f.databasePath, projectId: f.projectId }
    for (const generation of [1, 2]) {
      const before = fs.readFileSync(current.databasePath)
      current = await copy(f, current.root, current.projectId, generation)
      expect(fs.readFileSync(generation === 1 ? f.databasePath : path.join(f.base, 'c1', '.ai-novel', 'project.db'))).toEqual(before)
      const db = new Database(current.databasePath), freeze = readPortableRuntimeFreeze(current.root)
      try {
        db.pragma('foreign_keys=ON')
        const bytes = fs.readFileSync(current.databasePath), changes = db.prepare('SELECT total_changes()').pluck().get()
        const history = readVerifiedOrdinaryHistory(db), saved = readOrdinaryReviewHistoryReport(db, source.cycleId!, history)
        expect(saved.proof.version).toBe(2)
        expect(saved.report).toBe(source.review!.receipt.content)
        expect(saved.rawArtifact).toBe(rawReport)
        const followup = saved.proof.followup!
        if (followup.merge) expect(freeze.isFrozen('review_cycle_merges', saved.proof.cycleId)).toBe(true)
        expect(verifyCurrentReviewCycles(db)).toBe(true)
        expect(verifyM03ReviewCycle(db)).toBe(false)
        assertOrdinaryHistoryFreezeCoverage(db, freeze)
        const nextFindings = db.prepare('SELECT finding_id,category,problem_text,target_id FROM review_findings WHERE cycle_id=?').all(source.cycleId) as typeof sourceFindings
        const ids = new Map(sourceFindings.map(old => [old.finding_id, nextFindings.find(next => next.category === old.category
          && next.problem_text === old.problem_text && next.target_id === old.target_id)!.finding_id]))
        const mapped = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(mapped)
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
            [key, key === 'findingId' && typeof item === 'string' ? ids.get(item) ?? item : mapped(item)]))
          return value
        }
        for (const review of reviews) {
          const actual = JSON.parse(db.prepare('SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?').pluck().get(review.id) as string)
          expect(actual).toEqual(mapped(JSON.parse(review.body)))
          expect(freeze.isFrozen('reviews', String(review.id))).toBe(true)
        }
        expect(db.prepare('SELECT r.id,r.status,r.review_source_id,c.body FROM revisions r JOIN contents c ON c.id=r.content_id ORDER BY r.id').all()).toEqual(revisions)
        expect(followup.confirmationHistory.map(value => value.reviewId)).toEqual(stage === 'regenerate' ? [source.author!.confirmations[0]] : [])
        expect(followup.discardedRevisions.map(value => value.revisionId)).toEqual(['discard', 'regenerate', 'replace-pending'].includes(stage)
          ? [source.author!.revisions[0]] : [])
        if (stage === 'regenerate') {
          const legacy = JSON.parse(db.prepare('SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?').pluck().get(source.author!.confirmations[0]) as string)
          expect(legacy.schemaVersion).toBe(1)
          expect(legacy.cycleId).toBeUndefined()
          expect(legacy.items.every((item: { findingId?: string; decision: string }) => item.findingId === undefined && item.decision !== 'waive')).toBe(true)
          const currentSnapshot = JSON.parse(db.prepare('SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?').pluck().get(source.author!.confirmations[1]) as string)
          expect(currentSnapshot.schemaVersion).toBe(2)
          expect(currentSnapshot.items.some((item: { decision: string }) => item.decision === 'waive')).toBe(true)
        }
        if (source.author && 'policy' in source.author && source.author.policy) {
          const recheck = followup.recheck!
          const raw = JSON.parse(db.prepare('SELECT artifact_json FROM generation_artifacts WHERE artifact_id=?').pluck().get(recheck.artifact.artifactId) as string).text as string
          expect(hash(raw)).toBe(recheck.artifact.textHash)
          const policy = { ...source.author.policy, findingSetHash: db.prepare('SELECT finding_set_hash FROM review_cycles WHERE cycle_id=?').pluck().get(source.cycleId) as string,
            findings: source.author.policy.findings.map(value => ({ ...value, findingId: ids.get(value.findingId)! })) }
          const built = buildReviewCycleRecheckReport(raw, revisedBody, policy, 'en-US', recheck.reportVersion)
          expect(built).toEqual(mapped(source.author.built))
          expect(built.validModelOutput).toBe(stage !== 'invalid')
          expect(recheck.findingIds).toEqual(source.author.policy.findings.map(value => ids.get(value.findingId)))
          expect(source.author.policy.findings.filter(value => value.mustShow)).toHaveLength(1)
          expect(source.author.policy.findings.filter(value => !value.mustShow)).toHaveLength(2)
          expect(built.decisions[0]!.status).toBe(stage === 'recheck' ? 'unresolved' : 'unknown')
          if (stage === 'invalid') expect(built.decisions.every(value => value.status === 'unknown')).toBe(true)
          else expect(built.decisions.slice(1).every(value => value.status === 'unresolved')).toBe(true)
          if (stage === 'invalid') { expect(parseRecheckItems(raw, recheck.reportVersion)).toBeNull(); expect(recheck.artifactProjection).toBe('invalid-output') }
          else {
            const parsed = parseRecheckItems(raw, recheck.reportVersion)!
            expect(parsed.items).toHaveLength(source.author.policy.findings.length + (stage === 'duplicate' ? 1 : stage === 'missing' ? -1 : 0))
            if (stage === 'duplicate') expect(parsed.items[0]!.findingId).toBe(parsed.items.at(-1)!.findingId)
            if (stage === 'wrong-finding') expect(parsed.items[0]!.findingId).toContain(':unmatched:')
            if (stage === 'wrong-target') expect(parsed.items[0]!.targetId).toContain(':invalid-target:')
            if (stage === 'wrong-known-target') expect(parsed.items[0]!.targetId).toBe(source.author.policy.findings[1]!.targetId)
          }
        }
        const receipt = readWorkflowBatchReceipt(capturedRuntime(current, db), source.taskId, () => {})
        expect(receipt.nonReplayable).toBe(true)
        expect(receipt.chapters[0]?.review?.content).toBe(source.review!.receipt.content)
        expect(() => db.transaction(() => ReviewCycleRepository.commitAuthorConfirmation({ cycleId: source.cycleId!,
          confirmationReviewId: source.author!.confirmations.at(-1)! }, db))()).toThrow('PORTABLE_RUNTIME_FROZEN')
        const repo = new WorkflowBatchRepository(db, { projectId: current.projectId, assertCurrent: () => {}, isFrozen: (table, id) => freeze.isFrozen(table, id) })
        expect(() => repo.resume({ taskId: source.taskId, revision: 1, batchRunId: source.batchRunId })).toThrow('WORKFLOW_BATCH_HISTORY_FROZEN')
        expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
        expect(fs.readFileSync(current.databasePath)).toEqual(bytes)
        for (const excluded of source.excluded) expect(bytes.includes(Buffer.from(excluded))).toBe(false)
        if (generation === 2) {
          const fresh = reviewOwner(db, current.root, current.projectId)
          try {
            const merged = !['confirmation', 'revision', 'discard', 'regenerate', 'replace-pending'].includes(stage)
            const next = await fresh.run(source.draftId!, { status: merged ? 'revised' : 'draft', content: merged ? revisedBody : body })
            expect(next.receipt.success).toBe(true)
            expect(fresh.dispatch).toHaveBeenCalledTimes(1)
            expect(verifyCurrentReviewCycles(db)).toBe(true)
          } finally { fresh.owner.suspendForProjectClose() }
        }
      } finally { db.close() }
    }
    expect(fs.readFileSync(f.databasePath)).toEqual(original)
  }, MULTI_GENERATION_ARCHIVE_TIMEOUT_MS)

  it('keeps frozen pending history intact while a fresh author revision completes and survives copies three and four', async () => {
    const f = fixture(), source = await seed(f, false, 'revision'), original = fs.readFileSync(f.databasePath)
    const oldRevisionId = source.author!.revisions[0]!, oldConfirmationId = source.author!.confirmations[0]!
    const oldHistory = (db: import('better-sqlite3').Database) => JSON.stringify({
      cycle: db.prepare('SELECT * FROM review_cycles WHERE cycle_id=?').get(source.cycleId),
      findings: db.prepare('SELECT * FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(source.cycleId),
      revision: db.prepare('SELECT r.*,c.body FROM revisions r JOIN contents c ON c.id=r.content_id WHERE r.id=?').get(oldRevisionId),
      reviews: db.prepare('SELECT r.*,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id IN (?,?) ORDER BY r.id')
        .all(source.review!.receipt.id, oldConfirmationId),
      effects: db.prepare('SELECT e.* FROM workflow_batch_effects e JOIN workflow_batch_steps s ON s.step_id=e.step_id WHERE s.task_id=? ORDER BY e.step_id')
        .all(source.taskId),
      roots: db.prepare(`SELECT * FROM generation_roots WHERE root_action_id IN (
        SELECT r.root_action_id FROM workflow_batch_steps s JOIN generation_runs r ON r.run_id=s.run_id WHERE s.task_id=?) ORDER BY root_action_id`).all(source.taskId),
      runs: db.prepare(`SELECT * FROM generation_runs WHERE root_action_id IN (
        SELECT r.root_action_id FROM workflow_batch_steps s JOIN generation_runs r ON r.run_id=s.run_id WHERE s.task_id=?) ORDER BY run_id`).all(source.taskId),
      attempts: db.prepare(`SELECT * FROM generation_attempts WHERE root_action_id IN (
        SELECT r.root_action_id FROM workflow_batch_steps s JOIN generation_runs r ON r.run_id=s.run_id WHERE s.task_id=?) ORDER BY attempt_id`).all(source.taskId),
      artifacts: db.prepare(`SELECT a.* FROM generation_artifacts a JOIN generation_runs r ON r.run_id=a.run_id WHERE r.root_action_id IN (
        SELECT r.root_action_id FROM workflow_batch_steps s JOIN generation_runs r ON r.run_id=s.run_id WHERE s.task_id=?) ORDER BY a.artifact_id`).all(source.taskId),
    })
    let current: { root: string; databasePath: string; projectId: string } = { root: f.root, databasePath: f.databasePath, projectId: f.projectId }
    let frozenBytes: string | undefined
    for (const generation of [1, 2]) {
      const before = fs.readFileSync(current.databasePath), previous = current.databasePath
      current = await copy(f, current.root, current.projectId, generation)
      expect(fs.readFileSync(previous)).toEqual(before)
      const db = new Database(current.databasePath, { readonly: true })
      try {
        const saved = oldHistory(db)
        if (frozenBytes !== undefined) expect(saved).toBe(frozenBytes)
        frozenBytes = saved
        expect(RevisionRepository.getFull(oldRevisionId, db)).toMatchObject({ status: 'pending', content: revisedBody })
        assertOrdinaryHistoryFreezeCoverage(db, readPortableRuntimeFreeze(current.root))
      } finally { db.close() }
    }
    const db = new Database(current.databasePath)
    let live: ReturnType<typeof reviewOwner> | undefined
    let freshReview: Awaited<ReturnType<ReturnType<typeof reviewOwner>['run']>>, freshCycleId: string
    let freshAuthor: Awaited<ReturnType<typeof authorFollowup>>
    try {
      db.pragma('foreign_keys=ON')
      live = reviewOwner(db, current.root, current.projectId)
      const freeze = readPortableRuntimeFreeze(current.root)
      expect(() => RevisionRepository.mergeIntoDraft({ revisionId: oldRevisionId, targetDraftId: source.draftId!,
        expectedDraftContent: body, mergedContent: revisedBody, wordCount: countDraftUnits(revisedBody) }, db)).toThrow('PORTABLE_RUNTIME_FROZEN')
      expect(() => RevisionRepository.markDiscarded(oldRevisionId, db)).toThrow('PORTABLE_RUNTIME_FROZEN')
      const repository = new WorkflowBatchRepository(db, { projectId: current.projectId, assertCurrent: () => {},
        isFrozen: (table, id) => freeze.isFrozen(table, id) })
      expect(() => repository.resume({ taskId: source.taskId, revision: 1, batchRunId: source.batchRunId })).toThrow('WORKFLOW_BATCH_HISTORY_FROZEN')
      expect(live.dispatch).not.toHaveBeenCalled()
      expect(oldHistory(db)).toBe(frozenBytes)
      freshReview = await live.run(source.draftId!)
      freshCycleId = ReviewCycleRepository.getByReviewId(freshReview.receipt.id, db)!.cycleId
      expect(freshCycleId).not.toBe(source.cycleId)
      freshAuthor = await authorFollowup(db, live, freshReview, freshCycleId, 'recheck')
      expect(freshAuthor.recheck?.success).toBe(true)
      expect(live.dispatch).toHaveBeenCalledTimes(3)
      expect(RevisionRepository.getFull(freshAuthor.revisions[0]!, db)).toMatchObject({ status: 'merged', content: revisedBody })
      expect(JSON.parse(ReviewRepository.getFull(freshAuthor.confirmations[0]!, db)!.content).schemaVersion).toBe(2)
      expect(ReviewCycleRepository.getByReviewId(freshReview.receipt.id, db)).toMatchObject({ cycleId: freshCycleId, recheckCount: 1 })
      expect(oldHistory(db)).toBe(frozenBytes)
      expect(verifyCurrentReviewCycles(db)).toBe(true)
    } finally { live?.owner.suspendForProjectClose(); db.close() }
    for (const generation of [3, 4]) {
      const before = fs.readFileSync(current.databasePath), previous = current.databasePath
      current = await copy(f, current.root, current.projectId, generation)
      expect(fs.readFileSync(previous)).toEqual(before)
      const restored = new Database(current.databasePath), freeze = readPortableRuntimeFreeze(current.root)
      try {
        const beforeRead = fs.readFileSync(current.databasePath)
        expect(oldHistory(restored)).toBe(frozenBytes)
        expect(RevisionRepository.getFull(oldRevisionId, restored)).toMatchObject({ status: 'pending', content: revisedBody })
        expect(RevisionRepository.getFull(freshAuthor.revisions[0]!, restored)).toMatchObject({ status: 'merged', content: revisedBody })
        expect(ReviewRepository.getFull(freshReview.receipt.id, restored)?.content).toBe(freshReview.receipt.content)
        expect(ReviewRepository.getFull(freshAuthor.recheck!.id, restored)?.content).toBe(freshAuthor.recheck!.content)
        expect(JSON.parse(ReviewRepository.getFull(freshAuthor.confirmations[0]!, restored)!.content).schemaVersion).toBe(2)
        expect(ReviewCycleRepository.getByReviewId(freshReview.receipt.id, restored)).toMatchObject({ cycleId: freshCycleId, recheckCount: 1 })
        assertOrdinaryHistoryFreezeCoverage(restored, freeze)
        expect(verifyCurrentReviewCycles(restored)).toBe(true)
        const receipt = readWorkflowBatchReceipt(capturedRuntime(current, restored), source.taskId, () => {})
        expect(receipt.nonReplayable).toBe(true)
        expect(receipt.chapters[0]?.draftSave.kind).toBe('changed')
        expect(receipt.chapters[0]?.review?.content).toBe(source.review!.receipt.content)
        expect(() => RevisionRepository.markDiscarded(oldRevisionId, restored)).toThrow('PORTABLE_RUNTIME_FROZEN')
        expect(() => restored.transaction(() => ReviewCycleRepository.commitMergedRevision({ revisionId: oldRevisionId,
          mergedHash: hash(revisedBody) }, restored))()).toThrow('PORTABLE_RUNTIME_FROZEN')
        const repository = new WorkflowBatchRepository(restored, { projectId: current.projectId, assertCurrent: () => {},
          isFrozen: (table, id) => freeze.isFrozen(table, id) })
        expect(() => repository.resume({ taskId: source.taskId, revision: 1, batchRunId: source.batchRunId })).toThrow('WORKFLOW_BATCH_HISTORY_FROZEN')
        expect(oldHistory(restored)).toBe(frozenBytes)
        expect(fs.readFileSync(current.databasePath)).toEqual(beforeRead)
      } finally { restored.close() }
    }
    expect(fs.readFileSync(f.databasePath)).toEqual(original)
  }, MULTI_GENERATION_ARCHIVE_TIMEOUT_MS)

  it.each([false, true])('retains two generations, including unknown=%s, without old execution or original X values', async unknown => {
    const f = fixture(), source = await seed(f, unknown), original = fs.readFileSync(f.databasePath)
    const evidence = probeProjectSqlite({ databasePath: f.databasePath })
    expect(evidence.preWorkflowBatchDomain?.tableCounts.workflow_batch_tasks).toBeUndefined()
    expect(evidence.assetMigrationDomain?.tableCounts.workflow_batch_tasks).toBe(1)
    let current: { root: string; databasePath: string; projectId: string } = { root: f.root, databasePath: f.databasePath, projectId: f.projectId }
    for (const generation of [1, 2]) {
      const before = fs.readFileSync(current.databasePath)
      const next = await copy(f, current.root, current.projectId, generation)
      expect(fs.readFileSync(current.databasePath)).toEqual(before)
      const bytes = fs.readFileSync(next.databasePath), freeze = readPortableRuntimeFreeze(next.root), db = new Database(next.databasePath)
      try {
        db.pragma('foreign_keys=ON')
        for (const excluded of source.excluded) { expect(bytes.includes(Buffer.from(excluded))).toBe(false); expect(bytes.includes(Buffer.from(hash(excluded)))).toBe(false) }
        assertOrdinaryHistoryFreezeCoverage(db, freeze)
        const context = readVerifiedOrdinaryHistory(db)
        expect(context.taskIds).toEqual([source.taskId])
        expect(verifyCurrentReviewCycles(db)).toBe(true)
        const readChanges = db.prepare('SELECT total_changes()').pluck().get()
        const receipt = readWorkflowBatchReceipt(capturedRuntime(next, db), source.taskId, () => {})
        expect(receipt.nonReplayable).toBe(true)
        expect(receipt.task.state).toBe(unknown ? 'blocked' : 'waiting_review')
        expect(receipt.historicalArtifacts?.map(item => item.text)).toContain(unknown ? 'A fictional interrupted prefix.' : body)
        expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(readChanges)
        if (source.cycleId && source.review) {
          expect(receipt.chapters[0]?.review).toMatchObject({ content: source.review.receipt.content, source: { content: body } })
          expect(verifyM03ReviewCycle(db)).toBe(false)
          const changes = db.prepare('SELECT total_changes()').pluck().get()
          const reserve = vi.spyOn(GenerationRunRepository.prototype, 'reserve'), commit = vi.spyOn(GenerationDraftEffects.prototype, 'commit')
          try {
            expect(readOrdinaryReviewHistoryReport(db, source.cycleId, context)).toMatchObject({ report: source.review.receipt.content, rawArtifact: rawReport,
              proof: { source: { content: body }, finishReason: 'stop' } })
            expect(ReviewCycleRepository.getByReviewId(source.review.receipt.id, db)?.cycleId).toBe(source.cycleId)
            expect(reserve).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
            expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
          } finally { reserve.mockRestore(); commit.mockRestore() }
          expect(() => db.transaction(() => ReviewCycleRepository.commitAuthorConfirmation({ cycleId: source.cycleId!, confirmationReviewId: source.review!.receipt.id }, db))())
            .toThrow('PORTABLE_RUNTIME_FROZEN')
        } else expect(db.prepare('SELECT tail_text FROM generation_recovery_tails').pluck().get()).toContain('Fictional visible suffix')
        const repo = new WorkflowBatchRepository(db, { projectId: next.projectId, assertCurrent: () => {}, isFrozen: (table, id) => freeze.isFrozen(table, id) })
        expect(() => db.transaction(() => repo.assertActive({ taskId: source.taskId, revision: 1, batchRunId: source.batchRunId }))())
          .toThrow('WORKFLOW_BATCH_HISTORY_FROZEN')
        expect(() => repo.resume({ taskId: source.taskId, revision: 1, batchRunId: source.batchRunId })).toThrow('WORKFLOW_BATCH_HISTORY_FROZEN')
        expect(fs.readFileSync(next.databasePath)).toEqual(bytes)
      } finally { db.close() }
      current = next
    }
    expect(fs.readFileSync(f.databasePath)).toEqual(original)
  })

  it('allows a new actual owner review in the restored copy while retaining old frozen cycles', async () => {
    const f = fixture(), source = await seed(f), restored = await copy(f, f.root, f.projectId, 1)
    const db = new Database(restored.databasePath), owner = reviewOwner(db, restored.root, restored.projectId)
    try {
      db.pragma('foreign_keys=ON')
      const saved = await owner.run(source.draftId!)
      expect(saved.receipt.success).toBe(true)
      expect(saved.receipt.id).not.toBe(source.review!.receipt.id)
      expect(verifyCurrentReviewCycles(db)).toBe(true)
      expect(owner.dispatch).toHaveBeenCalledTimes(1)
      expect(readVerifiedOrdinaryHistory(db).cycleIds).toEqual([source.cycleId])
      const guard = readPortableRuntimeFreeze(restored.root), runs = new GenerationRunRepository(() => db)
      const run = runs.open({ projectId: restored.projectId, epoch: randomUUID(), operation: 'batch-chapters', uiActionNonce: randomUUID(),
        frozenInputHash: machine, contextSnapshotId: 'fictional-new-context', sourceRefs: [],
        fingerprint: { chapterBriefHash: machine, authorGuidanceHash: machine, dependencyHash: machine, contextSnapshotHash: machine,
          templateHash: machine, skillSnapshotHash: machine, modelLeaseRevision: machine, policyHash: machine, outputContractHash: machine },
        sourceManifest: { operation: 'batch-chapters', batchIntent: recipe.intent, authorInputs: [], freezeWritingLanguage: true, writingLanguage: 'en-US' },
        budget: { maxPhysicalRequests: 2, maxTokenLiability: 1000, maxOutputPerRequest: 100, maxActiveElapsedMs: 10_000 } })
      const repo = new WorkflowBatchRepository(db, { projectId: restored.projectId, assertCurrent: () => {}, isFrozen: (table, id) => guard.isFrozen(table, id) })
      const fresh = repo.issue({ taskId: randomUUID(), operationKey: randomUUID(), requestHash: hash(randomUUID()), batchRunId: run.runId,
        recipe, reviewModelId: 'fictional-model', reviewModelHash: machine })
      expect(fresh.state).toBe('ready')
      expect(fresh.taskId).not.toBe(source.taskId)
      expect(verifyCurrentReviewCycles(db)).toBe(true)
    } finally { owner.owner.suspendForProjectClose(); db.close() }
  })

  it.each(['edited', 'soft-deleted'] as const)('preserves original save/review history through two copies after the current draft is %s', async state => {
    const f = fixture(), source = await seed(f), db = new Database(f.databasePath)
    const captured = vi.spyOn(databaseModule, 'getProjectDb').mockReturnValue(db)
    const location = vi.spyOn(databaseModule, 'getCurrentProjectPath').mockReturnValue(f.root)
    try {
      db.pragma('foreign_keys=ON')
      if (state === 'edited') DraftRepository.updateContent(source.draftId!, 'Fictional author-edited current prose.', 6)
      else {
        FinalizationRepository.commit({ finalizationId: randomUUID(), draftId: source.draftId!, chapterNumber: 1,
          chapterTitle: 'Fictional key', content: body, contentHash: hash(body), contentRevision: 1, targetFileName: 'fictional.txt' })
        ChapterDeletionRepository.begin({ operationId: randomUUID(), draftId: source.draftId!, chapterNumber: 1 })
        expect(db.prepare('SELECT status FROM drafts_all WHERE id=?').pluck().get(source.draftId)).toBe('deleted')
      }
    } finally { captured.mockRestore(); location.mockRestore(); db.close() }
    let current: { root: string; databasePath: string; projectId: string } = { root: f.root, databasePath: f.databasePath, projectId: f.projectId }
    for (const generation of [1, 2]) {
      current = await copy(f, current.root, current.projectId, generation)
      const history = new Database(current.databasePath)
      try {
        history.pragma('foreign_keys=ON')
        assertOrdinaryHistoryFreezeCoverage(history, readPortableRuntimeFreeze(current.root))
        const receipt = readOrdinaryReviewHistoryReport(history, source.cycleId!, readVerifiedOrdinaryHistory(history))
        expect(receipt.proof.source).toMatchObject({ id: source.draftId, status: 'draft', content: body })
        expect(receipt.report).toBe(source.review!.receipt.content)
        expect(receipt.rawArtifact).toBe(rawReport)
        const changes = history.prepare('SELECT total_changes()').pluck().get()
        const publicReceipt = readWorkflowBatchReceipt(capturedRuntime(current, history), source.taskId, () => {})
        expect(publicReceipt.chapters[0]).toMatchObject({ draftSave: { kind: 'changed' },
          review: { content: source.review!.receipt.content, source: { status: 'draft', content: body } } })
        expect(publicReceipt.historicalArtifacts?.map(item => item.text)).toContain(body)
        expect(history.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
        expect(verifyCurrentReviewCycles(history)).toBe(true)
        const actual = history.prepare('SELECT d.status,c.body FROM drafts_all d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(source.draftId) as { status: string; body: string }
        if (state === 'edited') expect(actual.body).toBe('Fictional author-edited current prose.')
        else expect(actual.status).toBe('deleted')
      } finally { history.close() }
    }
  })

  it.each(['missing-receipt', 'cross-root', 'false-confirmation-owner'] as const)('rejects detached historical source pollution: %s', async mode => {
    const f = fixture(), source = await seed(f, false, 'regenerate'), isolated = path.join(f.base, 'polluted.db')
    fs.copyFileSync(f.databasePath, isolated)
    const original = fs.readFileSync(f.databasePath), db = new Database(isolated)
    try {
      const revisionId = source.author!.revisions[0]!
      const attempt = db.prepare("SELECT attempt_id,run_id FROM generation_attempts WHERE json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='revision' AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.id')=?")
        .get(revisionId) as { attempt_id: string; run_id: string }
      if (mode === 'missing-receipt') db.prepare('UPDATE generation_attempts SET usage_receipt_json=NULL WHERE attempt_id=?').run(attempt.attempt_id)
      else if (mode === 'cross-root') {
        const root = db.prepare('SELECT root_action_id FROM generation_runs WHERE run_id=?').pluck().get(source.batchRunId) as string
        db.prepare('UPDATE generation_runs SET root_action_id=? WHERE run_id=?').run(root, attempt.run_id)
      } else {
        const row = db.prepare('SELECT r.content_id,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?')
          .get(source.author!.confirmations[0]) as { content_id: number; body: string }
        const snapshot = JSON.parse(row.body)
        snapshot.sourceReviewId = source.author!.confirmations[1]
        db.prepare('UPDATE contents SET body=? WHERE id=?').run(JSON.stringify(snapshot, null, 2), row.content_id)
      }
    } finally { db.close() }
    const expectedError = mode === 'cross-root' ? 'PORTABLE_SCHEMA_UNSUPPORTED' : 'ORDINARY_REVIEW_HISTORY_INVALID'
    expect(() => sanitizePortableDatabase(isolated)).toThrow(expectedError)
    expect(fs.readFileSync(f.databasePath)).toEqual(original)
  })

  it.each(['omitted-confirmation', 'omitted-discarded', 'cross-confirmation', 'unknown-history-field', 'missing-finding', 'extra-finding',
    'reordered-findings'] as const)('rejects frozen followup proof tampering: %s', async mode => {
    const f = fixture(), source = await seed(f, false, mode.includes('finding') ? 'recheck' : 'regenerate')
    const restored = await copy(f, f.root, f.projectId, 1), db = new Database(restored.databasePath)
    try {
      const row = db.prepare("SELECT step_id,semantic_history_json FROM workflow_batch_effects WHERE receipt_kind='review_commit'").get() as {
        step_id: string; semantic_history_json: string }
      const proof = JSON.parse(row.semantic_history_json)
      if (mode === 'omitted-confirmation') proof.followup.confirmationHistory = []
      if (mode === 'omitted-discarded') proof.followup.discardedRevisions = []
      if (mode === 'cross-confirmation') proof.followup.discardedRevisions[0].confirmationReviewId = proof.followup.confirmation.reviewId
      if (mode === 'unknown-history-field') proof.followup.confirmationHistory[0].modelLeaseRevision = machine
      if (mode === 'missing-finding') proof.followup.recheck.findingIds.shift()
      if (mode === 'extra-finding') proof.followup.recheck.findingIds.push('finding:fictional-other-cycle')
      if (mode === 'reordered-findings') proof.followup.recheck.findingIds.reverse()
      db.prepare('UPDATE workflow_batch_effects SET semantic_history_json=?,semantic_history_hash=? WHERE step_id=?')
        .run(JSON.stringify(proof), mode === 'unknown-history-field' ? hash(JSON.stringify(proof)) : ordinarySemanticHistoryHash(proof), row.step_id)
      expect(() => readVerifiedOrdinaryHistory(db)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
      expect(verifyCurrentReviewCycles(db)).toBe(false)
    } finally { db.close() }
    expect(source.author).toBeDefined()
  })

  it.each(['revision', 'confirmation-content', 'merge'] as const)('requires sidecar coverage for detached domain record: %s', async mode => {
    const f = fixture(), source = await seed(f, false, mode === 'merge' ? 'merge' : 'regenerate'), restored = await copy(f, f.root, f.projectId, 1)
    const freezePath = path.join(restored.root, '.ai-novel', 'portable-runtime-freeze.json')
    const document = JSON.parse(fs.readFileSync(freezePath, 'utf8'))
    let table = 'revisions', recordId = String(source.author!.revisions[0])
    if (mode === 'merge') { table = 'review_cycle_merges'; recordId = source.cycleId! }
    if (mode === 'confirmation-content') {
      const db = new Database(restored.databasePath, { readonly: true })
      try { table = 'contents'; recordId = String(db.prepare('SELECT content_id FROM reviews WHERE id=?').pluck().get(source.author!.confirmations[0])) }
      finally { db.close() }
    }
    expect(document.records.filter((row: { table: string; recordId: string }) => row.table === table && row.recordId === recordId)).toHaveLength(1)
    document.records = document.records.filter((row: { table: string; recordId: string }) => row.table !== table || row.recordId !== recordId)
    fs.writeFileSync(freezePath, JSON.stringify(document))
    const before = fs.readFileSync(restored.databasePath)
    expect(() => { const opened = openVerifiedProjectDatabase(restored.root, restored.projectId); closeCapturedProjectDatabase(opened) }).toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
    await expect(copy(f, restored.root, restored.projectId, 2)).rejects.toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
    expect(fs.readFileSync(restored.databasePath)).toEqual(before)
  })

  it.each(['unknown-field', 'semantic-change', 'cross-run', 'missing-proof'] as const)('rejects %s without granting old M03 authority', async mode => {
    const f = fixture(), source = await seed(f), restored = await copy(f, f.root, f.projectId, 1), db = new Database(restored.databasePath)
    try {
      db.pragma('foreign_keys=ON')
      const row = db.prepare("SELECT e.* FROM workflow_batch_effects e WHERE receipt_kind='review_commit'").get() as { step_id: string; semantic_history_json: string }
      const proof = JSON.parse(row.semantic_history_json)
      expect(parseOrdinarySemanticHistory(proof).kind).toBe('ordinary-review-history')
      if (mode === 'unknown-field') {
        proof.normalization.modelLeaseRevision = machine
        db.prepare('UPDATE workflow_batch_effects SET semantic_history_json=? WHERE step_id=?').run(JSON.stringify(proof), row.step_id)
      } else if (mode === 'semantic-change') {
        proof.normalization.frozenGoals.items[0].text = 'A changed fictional goal.'
        db.prepare('UPDATE workflow_batch_effects SET semantic_history_json=?,semantic_history_hash=? WHERE step_id=?')
          .run(JSON.stringify(proof), ordinarySemanticHistoryHash(proof), row.step_id)
      } else if (mode === 'cross-run') db.prepare('UPDATE workflow_batch_steps SET run_id=? WHERE step_id=?').run(source.batchRunId, row.step_id)
      else db.prepare('UPDATE workflow_batch_effects SET semantic_history_json=NULL,semantic_history_hash=NULL WHERE step_id=?').run(row.step_id)
      expect(() => readVerifiedOrdinaryHistory(db)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
      expect(verifyCurrentReviewCycles(db)).toBe(false)
      expect(verifyM03ReviewCycle(db)).toBe(false)
    } finally { db.close() }
  })

  it.each(['missing', 'incomplete', 'changed-projection'] as const)('requires actual sidecar graph coverage on open and reexport: %s', async mode => {
    const f = fixture(), source = await seed(f), restored = await copy(f, f.root, f.projectId, 1)
    const freezePath = path.join(restored.root, '.ai-novel', 'portable-runtime-freeze.json')
    const document = JSON.parse(fs.readFileSync(freezePath, 'utf8'))
    if (mode === 'missing') fs.unlinkSync(freezePath)
    else {
      if (mode === 'incomplete') document.records = document.records.filter((row: { table: string; recordId: string }) => row.table !== 'workflow_batch_steps' || row.recordId !== source.stepIds[0])
      else document.records.find((row: { table: string }) => row.table === 'workflow_batch_effects').projection.semantic_history_json = { version: 1 }
      fs.writeFileSync(freezePath, JSON.stringify(document))
    }
    const before = fs.readFileSync(restored.databasePath)
    expect(() => { const opened = openVerifiedProjectDatabase(restored.root, restored.projectId); closeCapturedProjectDatabase(opened) }).toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
    await expect(copy(f, restored.root, restored.projectId, 2)).rejects.toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
    expect(fs.readFileSync(restored.databasePath)).toEqual(before)
  })

  it('refuses unknown new columns and preserves the source on failed isolated sanitization', async () => {
    const f = fixture()
    await seed(f)
    const isolated = path.join(f.base, 'isolated.db')
    fs.copyFileSync(f.databasePath, isolated)
    const db = new Database(isolated)
    db.exec('ALTER TABLE workflow_batch_effects ADD COLUMN machine_extra TEXT')
    db.close()
    const source = fs.readFileSync(f.databasePath)
    expect(() => sanitizePortableDatabase(isolated)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.readFileSync(f.databasePath)).toEqual(source)
  })

  it('rejects forged, cross-DB and stale history contexts', async () => {
    const f = fixture(), source = await seed(f), restored = await copy(f, f.root, f.projectId, 1)
    const db = new Database(restored.databasePath), other = new Database(restored.databasePath, { readonly: true })
    try {
      const context = readVerifiedOrdinaryHistory(db)
      expect(() => assertOrdinaryHistoryContext(db, { taskIds: [source.taskId], cycleIds: [source.cycleId!] })).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
      expect(() => assertOrdinaryHistoryContext(other, context)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
      db.prepare('UPDATE workflow_batch_tasks SET updated_at=updated_at+1').run()
      expect(() => assertOrdinaryHistoryContext(db, context)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    } finally { other.close(); db.close() }
  })
})
