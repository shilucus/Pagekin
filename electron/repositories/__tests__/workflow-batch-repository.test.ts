import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorkflowBatchRecipe, parseWorkflowBatchStepInput, type WorkflowBatchStepInput, type WorkflowBatchStepKind } from '../../../src/shared/workflow-batch-contract'
import { draftShortOutlineBlock } from '../../../src/shared/draft-short-outline'
import { composeDraftVisibleContinuation, DRAFT_VISIBLE_TEXT_VERSION, sanitizeDraftText } from '../../../src/shared/draft-visible-text'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { applyM13WorkflowBatch, verifyM13WorkflowBatch } from '../../migrations/m13-workflow-batch'
import { GenerationDraftEffects } from '../../services/generation-draft-effects'
import { ReviewRevisionGeneration } from '../../services/review-revision-generation'
import { GenerationRunRepository, textHash, type DurableGenerationRun } from '../generation-run-repository'
import { WorkflowBatchRepository, type WorkflowBatchTask, type WorkflowBatchRef, type WorkflowBatchStep,
  type WorkflowBatchTable } from '../workflow-batch-repository'

const databases: Database.Database[] = []
const h = textHash('fictional-frozen-source-model-and-policy')
const epoch = 'fictional-batch-runtime'
const outlineText = 'Open the door and resolve the promised exchange.'
const basePrompt = 'Write the author-approved chapter without changing recorded facts.'
const outlinePrompt = 'Prepare the frozen chapter short outline.'
const prose = (prefix: string, units: number) => Array.from({ length: units }, (_, index) =>
  `${prefix}${String.fromCharCode(97 + Math.floor(index / 26) % 26)}${String.fromCharCode(97 + index % 26)}`).join(' ')
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close() })

function fixture(endChapter = 1, targetUnits = 100, writingLanguage: 'en-US' | 'zh-CN' = 'en-US') {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  // Pin the original parent schema, including drafts_all and all native receipt catalogs.
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 13)
  db.transaction(() => applyM13WorkflowBatch(db))()
  db.prepare("INSERT INTO project_core(id,project_name,premise,writing_language) VALUES('main','Fictional batch book','Author fact',?)").run(writingLanguage)
  for (let chapter = 1; chapter <= endChapter; chapter++) db.prepare('INSERT INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapter, `Fictional chapter ${chapter}`)
  const projectId = 'fictional-project', frozen = new Set<string>(), assertCurrent = vi.fn(() => {}), now = { value: 1000 }
  const options = { projectId, assertCurrent, now: () => now.value,
    isFrozen: (table: WorkflowBatchTable, recordId: string) => frozen.has(`${table}:${recordId}`) }
  const repository = new WorkflowBatchRepository(db, options), runs = new GenerationRunRepository(() => db, options.now)
  const recipe = parseWorkflowBatchRecipe({ schemaVersion: 2, writingLanguage, uiLocale: 'en-US',
    intent: { mode: 'draft_review', range: { startChapter: 1, endChapter }, targetUnits }, authorInputs: [] })
  const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
    templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
  const open = (operation: string, manifest: Record<string, unknown>, parentRootActionId?: string, project = projectId) => runs.open({
    projectId: project, epoch, operation, uiActionNonce: randomUUID(), frozenInputHash: h, fingerprint,
    contextSnapshotId: 'fictional-context', sourceRefs: [], sourceManifest: { operation,
      outputContract: operation === 'review-chapter' ? 'structured-data' : 'visible-text', ...manifest },
    ...(parentRootActionId ? { parentRootActionId } : {}),
    budget: { maxPhysicalRequests: 200, maxTokenLiability: 1000000, maxOutputPerRequest: 10000, maxActiveElapsedMs: 100000 } })
  const root = open('batch-chapters', { batchIntent: recipe.intent, authorInputs: recipe.authorInputs,
    freezeWritingLanguage: true, writingLanguage, modelReceipt: { modelId: 'draft-model' } })
  const request = { taskId: randomUUID(), operationKey: randomUUID(), requestHash: textHash('private-canonical-author-request'),
    batchRunId: root.runId, recipe, reviewModelId: 'review-model', reviewModelHash: h }
  const openDraft = (chapterNumber = 1, parent = root.rootActionId, project = projectId) => open('chapter-draft', {
    chapterNumber, batchId: root.runId, authorInputs: [{ id: 'draft:target-units', text: String(targetUnits) }],
    materialDecision: { version: 1, verdict: 'admitted', promptHash: textHash(basePrompt), shortOutlinePromptHash: textHash(outlinePrompt),
      capacity: { maxInputUnits: 10000, admittedUnits: 100, methodVersion: 'utf8-bytes-v1' },
      coverage: { required: 0, included: 0, complete: true }, included: [], omitted: [] } }, parent, project)
  return { db, projectId, frozen, assertCurrent, options, now, runs, repository, recipe, root, request, open, openDraft }
}
type Fixture = ReturnType<typeof fixture>
const ref = (task: WorkflowBatchTask): WorkflowBatchRef => ({ taskId: task.taskId, revision: task.revision, batchRunId: task.batchRunId })
const count = (db: Database.Database, table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()
function modelInput(purpose: string, content = 'Frozen continuation prompt', review = false): WorkflowBatchStepInput {
  return parseWorkflowBatchStepInput({ kind: 'model', task: { purpose, output: review ? 'structured-data' : 'visible-text',
    messages: [{ role: 'user', content }] } })
}
function bind(f: Fixture, task: WorkflowBatchTask, run: DurableGenerationRun, kind: WorkflowBatchStepKind,
  slot: number, input: WorkflowBatchStepInput, chapterNumber = 1) {
  return f.db.transaction(() => f.repository.bindStep(ref(task), { chapterNumber,
    role: ['review', 'review_rebuild', 'review_commit'].includes(kind) ? 'review' : 'draft', kind, slot, runId: run.runId, input })).immediate()
}
function finish(f: Fixture, task: WorkflowBatchTask, step: WorkflowBatchStep, text: string,
  options: { finishReason?: string | null; trusted?: boolean; reserveOnly?: boolean; failureCode?: string } = {}) {
  if (step.input.kind !== 'model' || !step.invocationNonce) throw new Error('fixture model step missing')
  const input = step.input.task, policy = { estimatorVersion: 'fictional-v1', safetyMarginTokens: 10,
    reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
  const receipt = f.db.transaction(() => {
    f.repository.assertDispatch(ref(task), step.stepId, step.invocationNonce!, input)
    const value = f.runs.reserve(step.runId, step.invocationNonce!, textHash(JSON.stringify([input, h, h])), 200, 100,
      policy, input.purpose, input)
    if (!options.reserveOnly) f.runs.markDispatched(value.attempt.attemptId)
    return value
  }).immediate()
  if (options.reserveOnly) return receipt
  f.runs.snapshot(receipt.attempt.attemptId, 0, text)
  return f.runs.settle(receipt.attempt.attemptId, options.trusted === false ? null : { policy, trusted: true, actualTokens: 20 },
    options.finishReason === undefined ? 'stop' : options.finishReason, options.failureCode)
}
function outline(f: Fixture, task: WorkflowBatchTask, chapter = 1) {
  return f.db.transaction(() => {
    const run = f.openDraft(chapter), step = bind(f, task, run, 'outline', 0, modelInput('chapter-draft-short-outline', outlinePrompt), chapter)
    return { run, step }
  }).immediate()
}
function draft(f: Fixture, task: WorkflowBatchTask, chapter = 1, text = prose('draft', 100), finishReason = 'stop') {
  const prepared = outline(f, task, chapter)
  finish(f, task, prepared.step, outlineText)
  const step = bind(f, task, prepared.run, 'draft', 0,
    modelInput('chapter-draft', `${basePrompt}\n\n${draftShortOutlineBlock(f.recipe.writingLanguage, outlineText)}`), chapter)
  const receipt = finish(f, task, step, text, { finishReason })
  return { ...prepared, draftStep: step, receipt, text }
}
function compose(f: Fixture, task: WorkflowBatchTask, run: DurableGenerationRun, artifactIds: string[], text: string, slot = 0, chapter = 1) {
  const input = parseWorkflowBatchStepInput({ kind: 'compose', artifactIds, algorithm: DRAFT_VISIBLE_TEXT_VERSION, expectedTextHash: textHash(text) })
  const step = bind(f, task, run, 'compose', slot, input, chapter)
  const write = () => f.runs.composeVisible(run.runId, artifactIds, textHash(text), DRAFT_VISIBLE_TEXT_VERSION)
  return { step, input, write }
}
function preparedCommit(f: Fixture, task: WorkflowBatchTask, chapter = 1) {
  const d = draft(f, task, chapter), text = sanitizeDraftText(d.text)
  const c = compose(f, task, d.run, [d.receipt.artifact!.artifactId], text, 0, chapter)
  f.repository.withEffectCommit(ref(task), c.step.stepId, c.write)
  const step = bind(f, task, d.run, 'draft_commit', 0, { kind: 'draft-commit', expectedCompositionHash: textHash(text) }, chapter)
  const write = () => new GenerationDraftEffects(f.db, f.runs).commit({ handle: { projectId: f.projectId, epoch,
    rootActionId: d.run.rootActionId, runId: d.run.runId }, source: 'write', chapterNumber: chapter,
    batchId: task.batchRunId, expectedCompositionHash: textHash(text) }, () => f.assertCurrent())
  return { ...d, commitStep: step, write }
}
function savedDraft(f: Fixture, task: WorkflowBatchTask, chapter = 1) {
  const prepared = preparedCommit(f, task, chapter)
  f.repository.withEffectCommit(ref(task), prepared.commitStep.stepId, prepared.write)
  const saved = new GenerationDraftEffects(f.db, f.runs).readCommit(prepared.run.runId)!
  return { ...prepared, saved }
}
function preparedReview(f: Fixture, task: WorkflowBatchTask, chapter = 1) {
  const row = f.db.prepare('SELECT d.id,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC LIMIT 1').get(chapter) as { id: number; version: number; status: 'draft'; body: string }
  const service = new ReviewRevisionGeneration(f.db, f.runs, { projectId: f.projectId, epoch }, () => f.assertCurrent())
  const context = service.prepare({ operation: 'review-chapter', draftId: row.id, expectedDraft: { chapterNumber: chapter,
    version: row.version, status: row.status, contentHash: textHash(row.body) }, authorInputs: [], uiLocale: 'en-US' })
  return f.db.transaction(() => {
    const run = f.open('review-chapter', { chapterNumber: chapter, modelReceipt: { modelId: 'review-model' },
      reviewRevisionContext: context.context, reviewRevisionContextHash: textHash(JSON.stringify(context.context)),
      authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context.context) }] })
    const step = bind(f, task, run, 'review', 0, modelInput('review-chapter', 'Review the frozen current draft.', true), chapter)
    return { run, step, service, context }
  }).immediate()
}

describe('WorkflowBatchRepository native sparse ledger', () => {
  it('persists the full closed recipe and creates stable independent IDs only before admitted slots', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    expect(task).toMatchObject({ state: 'ready', revision: 1, recipe: f.recipe, recipeHash: textHash(JSON.stringify(f.recipe)) })
    expect(f.repository.readSteps(task.taskId)).toEqual([])
    const first = outline(f, task), again = bind(f, task, first.run, 'outline', 0, first.step.input)
    expect(again).toEqual(first.step)
    expect(new Set([first.step.stepId, first.step.commandId, first.step.invocationNonce]).size).toBe(3)
    expect(count(f.db, 'generation_attempts')).toBe(0)
    expect(verifyM13WorkflowBatch(f.db)).toBe(true)
    expect(new WorkflowBatchRepository(f.db, f.options).readSteps(task.taskId)).toEqual([first.step])
  })

  it('replays only the exact original operation and rejects different payload, review model and root', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    expect(f.repository.issue({ ...f.request, taskId: randomUUID(), createdAt: 2000 })).toEqual(task)
    for (const patch of [{ requestHash: textHash('different') }, { reviewModelId: 'other-model' },
      { reviewModelHash: textHash('changed-model') }, { recipe: { ...f.recipe, uiLocale: 'zh-CN' as const } }, { batchRunId: randomUUID() }]) {
      expect(() => f.repository.issue({ ...f.request, ...patch })).toThrow('IDEMPOTENCY_CONFLICT')
    }
    expect(() => f.repository.issue({ ...f.request, operationKey: randomUUID(), taskId: randomUUID() })).toThrow('IDEMPOTENCY_CONFLICT')
  })

  it('requires caller native TX for first-role binding and rolls back run plus IDs on COMMIT failure', () => {
    const f = fixture(), task = f.repository.issue(f.request), before = count(f.db, 'generation_runs')
    const run = f.openDraft()
    expect(() => f.repository.bindStep(ref(task), { chapterNumber: 1, role: 'draft', kind: 'outline', slot: 0,
      runId: run.runId, input: modelInput('chapter-draft-short-outline', outlinePrompt) })).toThrow('TRANSACTION_REQUIRED')
    f.db.exec('CREATE TABLE fictional_deferred(step_id TEXT REFERENCES workflow_batch_steps(step_id) DEFERRABLE INITIALLY DEFERRED)')
    expect(() => f.db.transaction(() => { outline(f, task); f.db.prepare('INSERT INTO fictional_deferred VALUES(?)').run('missing') }).immediate()).toThrow()
    expect(count(f.db, 'generation_runs')).toBe(Number(before) + 1)
    expect(f.repository.readSteps(task.taskId)).toEqual([])
    expect(() => f.db.transaction(() => { f.repository.issue({ ...f.request, batchRunId: f.open('batch-chapters', {
      batchIntent: f.recipe.intent, authorInputs: [], freezeWritingLanguage: true, writingLanguage: 'en-US' }).runId,
      taskId: randomUUID(), operationKey: randomUUID() }); throw new Error('native rollback') }).immediate()).toThrow('native rollback')
    expect(count(f.db, 'workflow_batch_tasks')).toBe(1)
  })

  it.each(['zh-CN', 'en-US'] as const)('binds recipe to the original %s language and rejects changed main facts', language => {
    const f = fixture(1, 100, language), other = language === 'en-US' ? 'zh-CN' : 'en-US'
    expect(() => f.repository.issue({ ...f.request, recipe: { ...f.recipe, writingLanguage: other } })).toThrow('LANGUAGE_MISMATCH')
    const task = f.repository.issue(f.request)
    f.db.prepare("UPDATE project_core SET writing_language=? WHERE id='main'").run(other)
    expect(() => f.db.transaction(() => f.repository.assertActive(ref(task)))()).toThrow('SOURCE_LANGUAGE_CHANGED')
  })

  it('enforces scope, resource, revision, frozen rows, chapter and role/run ownership', () => {
    const f = fixture(2), task = f.repository.issue(f.request), first = outline(f, task)
    expect(() => f.repository.assertActive(ref(task))).toThrow('TRANSACTION_REQUIRED')
    expect(() => f.db.transaction(() => f.repository.assertActive({ ...ref(task), revision: 2 }))()).toThrow('REVISION_CONFLICT')
    expect(() => new WorkflowBatchRepository(f.db, { ...f.options, projectId: 'other-project' }).get(task.taskId)).toThrow('PROJECT_MISMATCH')
    expect(() => bind(f, task, first.run, 'outline', 0, first.step.input, 2)).toThrow('RUN_MISMATCH')
    expect(() => bind(f, task, f.openDraft(), 'outline', 1, first.step.input)).toThrow('RUN_MISMATCH')
    f.frozen.add(`workflow_batch_steps:${first.step.stepId}`)
    expect(() => f.db.transaction(() => f.repository.assertActive(ref(task)))()).toThrow('HISTORY_FROZEN')
    f.frozen.clear(); f.assertCurrent.mockImplementation(() => { throw new Error('runtime retired') })
    expect(() => f.repository.get(task.taskId)).toThrow('runtime retired')
  })

  it('keeps pause/cancel revisions idempotent and portable history readable but never writable', () => {
    const f = fixture(), task = f.repository.issue(f.request), first = outline(f, task)
    const paused = f.repository.pause(ref(task))
    expect(f.repository.pause(ref(task))).toEqual(paused)
    expect(() => finish(f, paused, first.step, outlineText)).toThrow('INACTIVE')
    const resumed = f.repository.resume(ref(paused))
    expect(resumed).toMatchObject({ state: 'ready', revision: 3 })
    f.db.prepare('UPDATE workflow_batch_tasks SET operation_key=?,request_hash=NULL,review_model_id=NULL,review_model_hash=NULL').run(`portable-history:${task.taskId}`)
    f.db.prepare('UPDATE workflow_batch_steps SET invocation_nonce=NULL').run()
    f.db.prepare("UPDATE generation_runs SET binding_json='{}'").run()
    f.frozen.add(`workflow_batch_tasks:${task.taskId}`)
    const replica = new WorkflowBatchRepository(f.db, { ...f.options, projectId: 'portable-project-B' })
    expect(replica.get(task.taskId)?.projectId).toBe(f.projectId)
    expect(replica.readSteps(task.taskId)[0]?.invocationNonce).toBeNull()
    expect(() => replica.cancel(ref(resumed))).toThrow('HISTORY_FROZEN')
    expect(() => replica.acknowledgeFromReceipt(ref(resumed), first.step.stepId)).toThrow('HISTORY_FROZEN')
    expect(count(f.db, 'generation_attempts')).toBe(0)
  })

  it.each([
    ['outline', 2, modelInput('chapter-draft-short-outline', outlinePrompt)],
    ['draft', 1, modelInput('chapter-draft')], ['continue', 7, modelInput('chapter-draft-continuation')],
    ['condense', 1, modelInput('chapter-draft-condense')],
    ['compose', 9, { kind: 'compose', artifactIds: ['fictional-artifact'], algorithm: DRAFT_VISIBLE_TEXT_VERSION, expectedTextHash: h }],
    ['draft_commit', 1, { kind: 'draft-commit', expectedCompositionHash: h }],
    ['review', 2, modelInput('review-chapter', 'Review.', true)], ['review_rebuild', 2, modelInput('review-chapter-rebuild', 'Rebuild.', true)],
    ['review_commit', 1, { kind: 'review-commit', artifact: { artifactId: 'fictional-artifact', revision: 1, textHash: h } }],
  ] as [WorkflowBatchStepKind, number, WorkflowBatchStepInput][])('rejects an out-of-bound %s slot before a new effect', (kind, slot, input) => {
    const f = fixture(), task = f.repository.issue(f.request), run = f.openDraft()
    expect(() => bind(f, task, run, kind, slot, input)).toThrow('PAYLOAD_INVALID')
    expect(f.repository.readSteps(task.taskId)).toEqual([])
    expect(count(f.db, 'generation_attempts')).toBe(0)
  })

  it('never advances or redispatches a delivery-unknown invocation, but observes a known length result', () => {
    const f = fixture(), task = f.repository.issue(f.request), first = outline(f, task)
    finish(f, task, first.step, '', { reserveOnly: true })
    expect(f.repository.acknowledgeFromReceipt(ref(task), first.step.stepId)).toBeNull()
    expect(() => finish(f, task, first.step, outlineText)).toThrow('INVOCATION_ALREADY_RESERVED')
    expect(() => bind(f, task, first.run, 'outline', 1, first.step.input)).toThrow('STEP_UNRESOLVED')
    const b = fixture(), t = b.repository.issue(b.request), p = outline(b, t)
    const known = finish(b, t, p.step, 'Known truncated outline.', { finishReason: 'length', trusted: false })
    expect(known.attempt.status).toBe('unknown')
    expect(b.repository.acknowledgeFromReceipt(ref(t), p.step.stepId)?.receiptKind).toBe('model')
    expect(() => bind(b, t, p.run, 'outline', 1, p.step.input)).toThrow('OUTLINE_RETRY_INVALID')
    expect(b.repository.readSteps(t.taskId)).toHaveLength(1)
  })

  it.each([
    { finishReason: 'length', text: 'Known truncated outline.' },
    { finishReason: 'stop', text: '' },
  ])('retries only a truly settled $finishReason outline using its original derived nonce', ({ finishReason, text }) => {
    const b = fixture(), t = b.repository.issue(b.request), p = outline(b, t)
    const settled = finish(b, t, p.step, text, { finishReason })
    expect(settled.attempt.status).toBe('settled')
    expect(settled.artifact?.text).toBe(text)
    expect(b.repository.acknowledgeFromReceipt(ref(t), p.step.stepId)?.receiptKind).toBe('model')
    const retry = bind(b, t, p.run, 'outline', 1, p.step.input)
    const attempt = b.runs.budget(p.run.rootActionId).attempts[0]!
    expect(retry.invocationNonce).toBe(`draft-short-outline-retry:${attempt.attemptId}`)
    expect(() => b.db.transaction(() => b.repository.assertDispatch(ref(t), retry.stepId, retry.invocationNonce!,
      retry.input.kind === 'model' ? retry.input.task : neverTask())).immediate()).not.toThrow()
    expect(() => bind(b, t, p.run, 'outline', 2, p.step.input)).toThrow('PAYLOAD_INVALID')
    const rewritten = randomUUID()
    b.db.prepare('UPDATE workflow_batch_steps SET invocation_nonce=? WHERE step_id=?').run(rewritten, retry.stepId)
    expect(() => b.db.transaction(() => b.repository.assertDispatch(ref(t), retry.stepId, rewritten,
      retry.input.kind === 'model' ? retry.input.task : neverTask()))()).toThrow('OUTLINE_RETRY_INVALID')
    expect(verifyM13WorkflowBatch(b.db)).toBe(false)
  })

  it('observes an actual empty failed artifact without granting a NETWORK_ERROR retry or inventing missing evidence', () => {
    const f = fixture(), task = f.repository.issue(f.request), first = outline(f, task)
    const failed = finish(f, task, first.step, '', { trusted: false, finishReason: null, failureCode: 'NETWORK_ERROR' })
    expect(failed.attempt.status).toBe('unknown')
    expect(failed.artifact).toMatchObject({ text: '', textHash: textHash('') })
    expect(f.repository.acknowledgeFromReceipt(ref(task), first.step.stepId)?.contentHash).toBe(textHash(''))
    expect(() => bind(f, task, first.run, 'outline', 1, first.step.input)).toThrow('OUTLINE_RETRY_INVALID')
    f.db.prepare('DELETE FROM generation_artifacts WHERE attempt_id=?').run(failed.attempt.attemptId)
    expect(() => f.repository.acknowledgeFromReceipt(ref(task), first.step.stepId)).toThrow('WORKFLOW_BATCH_RECEIPT_INVALID')
  })

  it('does not equate a terminal empty or failed model observation with accepted draft output', () => {
    const f = fixture(), task = f.repository.issue(f.request), first = outline(f, task)
    finish(f, task, first.step, '', { failureCode: 'EMPTY_VISIBLE_OUTPUT' })
    expect(f.repository.acknowledgeFromReceipt(ref(task), first.step.stepId)?.contentHash).toBe(textHash(''))
    expect(() => bind(f, task, first.run, 'draft', 0, modelInput('chapter-draft', basePrompt))).toThrow('INPUT_MISMATCH')
  })

  it('uses the original composition receipt across a later accepted prefix and forbids singleton condense', () => {
    const f = fixture(1, 1000), task = f.repository.issue(f.request), d = draft(f, task, 1, prose('draft', 200), 'length')
    const first = compose(f, task, d.run, [d.receipt.artifact!.artifactId], d.text); first.write()
    const next = bind(f, task, d.run, 'continue', 0, modelInput('chapter-draft-continuation'))
    const result = finish(f, task, next, prose('next', 350)), text = composeDraftVisibleContinuation(d.text, result.artifact!.text)
    const second = compose(f, task, d.run, [d.receipt.artifact!.artifactId, result.artifact!.artifactId], text, 1)
    f.repository.withEffectCommit(ref(task), second.step.stepId, second.write)
    expect(f.repository.acknowledgeFromReceipt(ref(task), first.step.stepId)?.contentHash).toBe(textHash(d.text))
    expect(verifyM13WorkflowBatch(f.db)).toBe(true)
    const c = fixture(), t = c.repository.issue(c.request), long = draft(c, t, 1, prose('long', 160), 'length')
    const initial = compose(c, t, long.run, [long.receipt.artifact!.artifactId], long.text)
    c.repository.withEffectCommit(ref(t), initial.step.stepId, initial.write)
    const condense = bind(c, t, long.run, 'condense', 0, modelInput('chapter-draft-condense'))
    const compact = finish(c, t, condense, prose('compact', 140))
    expect(() => compose(c, t, long.run, [compact.artifact!.artifactId], compact.artifact!.text, 8)).toThrow('INPUT_MISMATCH')
    const accepted = compose(c, t, long.run, [long.receipt.artifact!.artifactId, compact.artifact!.artifactId], compact.artifact!.text, 8)
    expect(c.repository.withEffectCommit(ref(t), accepted.step.stepId, accepted.write).receiptKind).toBe('composition')
    expect(verifyM13WorkflowBatch(c.db)).toBe(true)
  })

  it('allows one shared-budget low-progress recovery and exits after an accepted low-progress stop', () => {
    const f = fixture(1, 1000), task = f.repository.issue(f.request), d = draft(f, task, 1, prose('draft', 200), 'length')
    const initial = compose(f, task, d.run, [d.receipt.artifact!.artifactId], d.text)
    f.repository.withEffectCommit(ref(task), initial.step.stepId, initial.write)
    const low = bind(f, task, d.run, 'continue', 0, modelInput('chapter-draft-continuation'))
    finish(f, task, low, prose('small', 100), { finishReason: 'length' })
    expect(f.repository.acknowledgeFromReceipt(ref(task), low.stepId)?.receiptKind).toBe('model')
    expect(() => bind(f, task, d.run, 'continue', 1, modelInput('chapter-draft-continuation'))).toThrow('STEP_ORDER')
    const recovery = bind(f, task, d.run, 'continue', 1, modelInput('chapter-draft-no-progress-recovery'))
    const recovered = finish(f, task, recovery, prose('recover', 100))
    const text = composeDraftVisibleContinuation(d.text, recovered.artifact!.text)
    const accepted = compose(f, task, d.run, [d.receipt.artifact!.artifactId, recovered.artifact!.artifactId], text, 2)
    f.repository.withEffectCommit(ref(task), accepted.step.stepId, accepted.write)
    expect(() => bind(f, task, d.run, 'continue', 2, modelInput('chapter-draft-continuation'))).toThrow('STEP_ORDER')
    expect(() => bind(f, task, d.run, 'continue', 7, modelInput('chapter-draft-continuation'))).toThrow('PAYLOAD_INVALID')
  })

  it('rolls back callback exceptions and async work without producing a ledger or domain receipt', () => {
    for (const mode of ['throw', 'async', 'thenable'] as const) {
      const f = fixture(), task = f.repository.issue(f.request), prepared = preparedCommit(f, task), callback = vi.fn(() => {
        prepared.write(); if (mode === 'throw') throw new Error('domain rollback'); return { then() {} }
      })
      const write = mode === 'async' ? async () => { callback() } : callback
      expect(() => f.repository.withEffectCommit(ref(task), prepared.commitStep.stepId, write)).toThrow(mode === 'throw' ? 'domain rollback' : 'ASYNC_CALLBACK_INVALID')
      expect(count(f.db, 'drafts')).toBe(0)
      expect(f.repository.readEffects(task.taskId).some(e => e.stepId === prepared.commitStep.stepId)).toBe(false)
      expect(callback).toHaveBeenCalledTimes(mode === 'async' ? 0 : 1)
    }
  })

  it('rolls back the original writer and ACK together on a real deferred native COMMIT failure', () => {
    const f = fixture(), task = f.repository.issue(f.request), prepared = preparedCommit(f, task)
    f.db.exec('CREATE TABLE fictional_effect_deferred(step_id TEXT REFERENCES workflow_batch_steps(step_id) DEFERRABLE INITIALLY DEFERRED)')
    expect(() => f.repository.withEffectCommit(ref(task), prepared.commitStep.stepId, () => {
      prepared.write(); f.db.prepare('INSERT INTO fictional_effect_deferred VALUES(?)').run('absent-step')
    })).toThrow()
    expect(count(f.db, 'drafts')).toBe(0)
    expect(f.repository.acknowledgeFromReceipt(ref(task), prepared.commitStep.stepId)).toBeNull()
    expect(f.repository.withEffectCommit(ref(task), prepared.commitStep.stepId, prepared.write).receiptKind).toBe('draft_commit')
  })

  it('recovers native COMMIT to ACK gaps, never reruns completed writers, and preserves cancelled facts', () => {
    const f = fixture(), task = f.repository.issue(f.request), prepared = preparedCommit(f, task)
    prepared.write()
    const cancelled = f.repository.cancel(ref(task)), callback = vi.fn(prepared.write)
    const proof = f.repository.withEffectCommit(ref(cancelled), prepared.commitStep.stepId, callback)
    expect(proof.receiptKind).toBe('draft_commit'); expect(callback).not.toHaveBeenCalled()
    expect(f.repository.acknowledgeFromReceipt(ref(cancelled), prepared.commitStep.stepId)).toEqual(proof)
    expect(f.repository.get(task.taskId)?.state).toBe('cancelled')
    const b = fixture(), t = b.repository.issue(b.request), p = preparedCommit(b, t), stopped = b.repository.cancel(ref(t)), write = vi.fn(p.write)
    expect(() => b.repository.withEffectCommit(ref(stopped), p.commitStep.stepId, write)).toThrow('INACTIVE')
    expect(write).not.toHaveBeenCalled(); expect(count(b.db, 'drafts')).toBe(0)
  })

  it('retains the real committed receipt after an author edit and blocks rather than treating it as absent', () => {
    const f = fixture(), task = f.repository.issue(f.request), prepared = preparedCommit(f, task), saved = prepared.write()
    f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('Author changed the actual manuscript.', saved.id)
    expect(f.repository.acknowledgeFromReceipt(ref(task), prepared.commitStep.stepId)?.contentHash).toBe(saved.contentHash)
    expect(f.repository.get(task.taskId)).toMatchObject({ state: 'blocked', blockedCode: 'SOURCE_DRAFT_CHANGED', revision: 2 })
    expect(() => f.repository.resume(ref(f.repository.get(task.taskId)!))).toThrow('SOURCE_DRAFT_CHANGED')
    expect(count(f.db, 'drafts')).toBe(1)
  })

  it('requires every sequential draft before independent ordinary reviews and cites the original strict review receipt', () => {
    const f = fixture(2), task = f.repository.issue(f.request), first = savedDraft(f, task)
    expect(() => preparedReview(f, task)).toThrow('STEP_ORDER')
    savedDraft(f, task, 2)
    const review = preparedReview(f, task), output = JSON.stringify({ summary: 'The frozen draft was reviewed.',
      items: [{ category: 'Expression', severity: 'pass', description: 'The recorded action is complete.' }] })
    const result = finish(f, task, review.step, output)
    const artifact = { artifactId: result.artifact!.artifactId, revision: result.artifact!.revision, textHash: result.artifact!.textHash }
    const step = bind(f, task, review.run, 'review_commit', 0, { kind: 'review-commit', artifact })
    const write = () => review.service.commitReview({ contextId: review.context.contextId, handle: {
      projectId: f.projectId, epoch, runId: review.run.runId, rootActionId: review.run.rootActionId }, artifact }, () => f.assertCurrent())
    write()
    const proof = f.repository.acknowledgeFromReceipt(ref(task), step.stepId)!
    expect(proof.receiptKind).toBe('review_commit')
    expect(review.service.readCommittedReview(review.run.runId)?.attemptId).toBe(proof.receiptAttemptId)
    expect(review.run.rootActionId).not.toBe(first.run.rootActionId)
    expect(f.repository.get(task.taskId)?.state).toBe('ready')
    expect(verifyM13WorkflowBatch(f.db)).toBe(true)
    const second = preparedReview(f, task, 2), next = finish(f, task, second.step, output)
    const nextArtifact = { artifactId: next.artifact!.artifactId, revision: next.artifact!.revision, textHash: next.artifact!.textHash }
    const commit = bind(f, task, second.run, 'review_commit', 0, { kind: 'review-commit', artifact: nextArtifact }, 2)
    f.repository.withEffectCommit(ref(task), commit.stepId, () => second.service.commitReview({ contextId: second.context.contextId,
      handle: { projectId: f.projectId, epoch, runId: second.run.runId, rootActionId: second.run.rootActionId }, artifact: nextArtifact }, () => f.assertCurrent()))
    expect(f.repository.get(task.taskId)?.state).toBe('waiting_review')
    expect(count(f.db, 'review_cycles')).toBe(2)
    expect(verifyM13WorkflowBatch(f.db)).toBe(true)
  })
})

function neverTask(): never { throw new Error('fixture model input missing') }
