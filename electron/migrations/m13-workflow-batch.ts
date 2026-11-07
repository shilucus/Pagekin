import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { assertWorkflowBatchSlot, parseWorkflowBatchRecipe, parseWorkflowBatchStepInput,
  type WorkflowBatchReceiptKind } from '../../src/shared/workflow-batch-contract'
import { composeDraftVisibleContinuation, DRAFT_CONDENSE_PURPOSE, sanitizeDraftText } from '../../src/shared/draft-visible-text'
import { countDraftUnits, draftTargetUnitRange } from '../../src/shared/draft-units'
import type { MigrationImplementation, SchemaReader } from './registry'
import { readVerifiedOrdinaryHistory } from './ordinary-review-history'

export const M13_WORKFLOW_BATCH_TABLES = ['workflow_batch_tasks', 'workflow_batch_steps', 'workflow_batch_effects'] as const
export const M13_WORKFLOW_BATCH_SQL = `
CREATE TABLE workflow_batch_tasks (
 task_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL,
 operation_key TEXT NOT NULL UNIQUE,
 request_hash TEXT CHECK(request_hash IS NULL OR (length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*')),
 template TEXT NOT NULL CHECK(template='prepared-batch-review-v2'),
 batch_run_id TEXT NOT NULL UNIQUE REFERENCES generation_runs(run_id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
 state TEXT NOT NULL CHECK(state IN ('ready','paused','blocked','cancelled','waiting_review')),
 blocked_code TEXT,
 recipe_json TEXT NOT NULL,
 recipe_hash TEXT NOT NULL CHECK(length(recipe_hash)=64 AND recipe_hash NOT GLOB '*[^a-f0-9]*'),
 review_model_id TEXT,
 review_model_hash TEXT CHECK(review_model_hash IS NULL OR (length(review_model_hash)=64 AND review_model_hash NOT GLOB '*[^a-f0-9]*')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
 CHECK((review_model_id IS NULL)=(review_model_hash IS NULL)),
 CHECK((state='blocked' AND blocked_code IS NOT NULL AND length(blocked_code) BETWEEN 1 AND 128 AND blocked_code NOT GLOB '*[^A-Z0-9_]*')
   OR (state<>'blocked' AND blocked_code IS NULL))
);
CREATE TABLE workflow_batch_steps (
 step_id TEXT PRIMARY KEY NOT NULL,
 task_id TEXT NOT NULL REFERENCES workflow_batch_tasks(task_id),
 chapter_number INTEGER NOT NULL CHECK(typeof(chapter_number)='integer' AND chapter_number>=1),
 role TEXT NOT NULL CHECK(role IN ('draft','review')),
 kind TEXT NOT NULL CHECK(kind IN ('outline','draft','continue','condense','compose','draft_commit','review','review_rebuild','review_commit')),
 slot INTEGER NOT NULL CHECK(typeof(slot)='integer' AND slot>=0 AND (
   (kind IN ('outline','review','review_rebuild') AND slot<=1) OR (kind='continue' AND slot<=6)
   OR (kind='compose' AND slot<=8) OR (kind IN ('draft','condense','draft_commit','review_commit') AND slot=0))),
 command_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL REFERENCES generation_runs(run_id),
 invocation_nonce TEXT UNIQUE,
 input_json TEXT NOT NULL,
 input_hash TEXT NOT NULL CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^a-f0-9]*'),
 UNIQUE(task_id,chapter_number,kind,slot),
 CHECK((role='review')=(kind IN ('review','review_rebuild','review_commit'))),
 CHECK(kind NOT IN ('compose','draft_commit','review_commit') OR invocation_nonce IS NULL)
);
CREATE TABLE workflow_batch_effects (
 step_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_batch_steps(step_id),
 receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('model','composition','draft_commit','review_commit')),
 receipt_attempt_id TEXT NOT NULL REFERENCES generation_attempts(attempt_id),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
 acknowledged_at INTEGER NOT NULL CHECK(typeof(acknowledged_at)='integer' AND acknowledged_at>=0),
 semantic_history_json TEXT,
 semantic_history_hash TEXT CHECK(semantic_history_hash IS NULL OR (length(semantic_history_hash)=64 AND semantic_history_hash NOT GLOB '*[^a-f0-9]*')),
 UNIQUE(receipt_kind,receipt_attempt_id),
 CHECK((semantic_history_json IS NULL)=(semantic_history_hash IS NULL))
);
`
type Row = Record<string, unknown>
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const identifier = (v: unknown) => typeof v === 'string' && /^[\p{L}\p{N}._:@+-]{1,512}$/u.test(v)
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min
function invalid(): never { throw new Error('WORKFLOW_BATCH_RECEIPT_INVALID') }
function object(v: unknown): Row {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid()
  return v as Row
}
function json(v: unknown): Row { if (typeof v !== 'string') invalid(); return object(JSON.parse(v)) }
function run(db: Database.Database, runId: unknown) {
  const row = db.prepare('SELECT * FROM generation_runs WHERE run_id=?').get(runId) as Row | undefined
  if (!row) invalid()
  return { row, binding: json(row.binding_json) }
}
function artifact(db: Database.Database, attemptId: unknown, runId: unknown) {
  const row = db.prepare(`SELECT t.*,a.artifact_id,a.artifact_json,a.revision,a.status AS artifact_status,
    a.run_id AS artifact_run FROM generation_attempts t JOIN generation_artifacts a ON a.attempt_id=t.attempt_id
    WHERE t.attempt_id=? AND t.run_id=?`).get(attemptId, runId) as Row | undefined
  if (!row || row.artifact_run !== runId || row.artifact_status === 'discarded') invalid()
  const attempt = json(row.attempt_json), usage = json(row.usage_receipt_json), value = json(row.artifact_json)
  const owner = run(db, runId), identity = object(usage.artifactIdentity)
  if (attempt.attemptId !== row.attempt_id || attempt.rootActionId !== row.root_action_id
    || row.root_action_id !== owner.row.root_action_id || value.artifactId !== row.artifact_id
    || value.attemptId !== row.attempt_id || value.rootActionId !== row.root_action_id
    || value.projectId !== owner.binding.projectId || value.revision !== row.revision
    || identity.artifactId !== value.artifactId || identity.epoch !== value.epoch
    || !isDeepStrictEqual(identity.fingerprint, value.fingerprint) || !isDeepStrictEqual(value.fingerprint, owner.binding.fingerprint)
    || typeof value.text !== 'string' || hash(value.text) !== value.textHash) invalid()
  return { row, attempt, usage, value }
}
function composition(db: Database.Database, runId: unknown, input: Extract<ReturnType<typeof parseWorkflowBatchStepInput>, { kind: 'compose' }>) {
  let text = '', ordinal = -1
  const sources: Row[] = []
  let last: ReturnType<typeof artifact> | undefined
  for (const [index, artifactId] of input.artifactIds.entries()) {
    const locator = db.prepare('SELECT attempt_id FROM generation_artifacts WHERE artifact_id=? AND run_id=?').get(artifactId, runId) as Row | undefined
    if (!locator) invalid()
    const item = artifact(db, locator.attempt_id, runId), result = object(item.usage.result)
    const nextOrdinal = Number(db.prepare('SELECT rowid FROM generation_attempts WHERE attempt_id=?').pluck().get(item.row.attempt_id))
    if (nextOrdinal <= ordinal || !['settled', 'unknown'].includes(String(item.attempt.status))
      || !['stop', 'length'].includes(String(result.finishReason)) || result.failureCode
      || !String(item.value.text).trim() || ['chapter-draft-short-outline', 'chapter-draft-reconcile'].includes(String(item.usage.purpose))) invalid()
    if (db.prepare('SELECT 1 FROM generation_recovery_tails WHERE attempt_id=?').get(item.row.attempt_id)) invalid()
    const condense = item.usage.purpose === DRAFT_CONDENSE_PURPOSE
    const next = condense || !sources.length ? sanitizeDraftText(String(item.value.text), input.algorithm)
      : composeDraftVisibleContinuation(text, String(item.value.text), input.algorithm)
    if (!next.trim()) invalid()
    if (condense) {
      const manifest = object(run(db, runId).binding.sourceManifest)
      const target = Number((manifest.authorInputs as { id: string; text: string }[]).find(v => v.id === 'draft:target-units')?.text)
      if (!sources.length || index !== input.artifactIds.length - 1 || result.finishReason !== 'stop'
        || !integer(target, 1) || countDraftUnits(text) <= draftTargetUnitRange(target).maximum) invalid()
    } else if (sources.length && (result.finishReason === 'length' && countDraftUnits(next) - countDraftUnits(text) < 300
      || (next.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0))) invalid()
    sources.push({ artifactId, revision: item.value.revision, textHash: item.value.textHash })
    text = next; ordinal = nextOrdinal; last = item
  }
  if (!last || hash(text) !== input.expectedTextHash) invalid()
  const stored = last.usage.visibleComposition
  if (stored === undefined) return null
  const value = object(stored)
  if (value.algorithm !== input.algorithm || value.textHash !== input.expectedTextHash
    || !isDeepStrictEqual(value.artifactIds, input.artifactIds) || !isDeepStrictEqual(value.sources, sources)) invalid()
  return { item: last, text, value }
}
export interface WorkflowBatchEffectProof { receiptKind: WorkflowBatchReceiptKind; receiptAttemptId: string; contentHash: string }

/** Checks original DB receipt links, never executes a writer or reconstructs an execution capability. */
export function readWorkflowBatchEffectProof(db: Database.Database, taskId: string, stepId: string): WorkflowBatchEffectProof | null {
  const task = db.prepare('SELECT * FROM workflow_batch_tasks WHERE task_id=?').get(taskId) as Row | undefined
  const step = db.prepare('SELECT * FROM workflow_batch_steps WHERE step_id=? AND task_id=?').get(stepId, taskId) as Row | undefined
  if (!task || !step) invalid()
  const input = parseWorkflowBatchStepInput(JSON.parse(String(step.input_json)))
  const owner = run(db, step.run_id)
  if (owner.binding.projectId !== task.project_id) invalid()
  if (input.kind === 'model') {
    if (!identifier(step.invocation_nonce)) invalid()
    const row = db.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=? AND invocation_nonce=?').get(step.run_id, step.invocation_nonce) as Row | undefined
    if (!row) return null
    const item = artifact(db, row.attempt_id, step.run_id), fp = object(owner.binding.fingerprint)
    if (item.usage.requestHash !== hash(JSON.stringify([input.task, fp.modelLeaseRevision, fp.policyHash]))
      || item.usage.purpose !== input.task.purpose || item.usage.replayTask !== undefined && !isDeepStrictEqual(item.usage.replayTask, input.task)) invalid()
    // A terminal observation is not acceptance of its output. Unknown without a known result stays unresolved.
    if (!['settled', 'unknown'].includes(String(item.attempt.status)) || !item.usage.result) return null
    const result = object(item.usage.result)
    if (result.finishReason !== null && typeof result.finishReason !== 'string') invalid()
    return { receiptKind: 'model', receiptAttemptId: String(row.attempt_id), contentHash: String(item.value.textHash) }
  }
  if (input.kind === 'compose') {
    const found = composition(db, step.run_id, input)
    return found ? { receiptKind: 'composition', receiptAttemptId: String(found.item.row.attempt_id), contentHash: input.expectedTextHash } : null
  }
  const key = input.kind === 'draft-commit' ? 'draftCommit' : 'reviewRevisionEffect'
  const candidates = db.prepare(`SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? AND json_type(usage_receipt_json,?) IS NOT NULL`)
    .all(step.run_id, `$.${key}`) as Row[]
  if (!candidates.length) return null
  if (candidates.length !== 1) invalid()
  const item = artifact(db, candidates[0].attempt_id, step.run_id), saved = object(item.usage[key])
  if (input.kind === 'draft-commit') {
    const stored = object(item.usage.visibleComposition)
    const found = composition(db, step.run_id, parseWorkflowBatchStepInput({ kind: 'compose', artifactIds: stored.artifactIds,
      algorithm: stored.algorithm, expectedTextHash: stored.textHash }) as Extract<ReturnType<typeof parseWorkflowBatchStepInput>, { kind: 'compose' }>)
    const handle = object(saved.handle), identity = object(item.usage.artifactIdentity)
    const draft = db.prepare('SELECT chapter_number,version FROM drafts_all WHERE id=?').get(saved.id) as Row | undefined
    if (!found || saved.success !== true || saved.batchId !== task.batch_run_id || saved.chapterNumber !== step.chapter_number
      || !integer(saved.id, 1) || !integer(saved.version, 1) || saved.content !== found.text
      || draft && (draft.chapter_number !== saved.chapterNumber || draft.version !== saved.version)
      || saved.contentHash !== found.value.textHash || saved.contentHash !== input.expectedCompositionHash
      || !isDeepStrictEqual(handle, { projectId: task.project_id, epoch: identity.epoch, runId: step.run_id, rootActionId: owner.row.root_action_id })) invalid()
    return { receiptKind: 'draft_commit', receiptAttemptId: String(item.row.attempt_id), contentHash: String(saved.contentHash) }
  }
  const manifest = object(owner.binding.sourceManifest), context = object(manifest.reviewRevisionContext), source = object(context.source)
  const draftStep = db.prepare("SELECT step_id FROM workflow_batch_steps WHERE task_id=? AND chapter_number=? AND kind='draft_commit'").get(taskId, step.chapter_number) as Row | undefined
  if (!draftStep) invalid()
  const draftProof = readWorkflowBatchEffectProof(db, taskId, String(draftStep.step_id))
  if (!draftProof || draftProof.receiptKind !== 'draft_commit') invalid()
  const draftSaved = object(json(db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(draftProof.receiptAttemptId)).draftCommit)
  const review = db.prepare(`SELECT r.*,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(saved.id) as Row | undefined
  const cycle = db.prepare('SELECT * FROM review_cycles WHERE review_id=?').get(saved.id) as Row | undefined
  if (context.operation !== 'review-chapter' || context.recheck !== undefined || context.confirmation !== undefined
    || saved.kind !== 'review' || !review || !cycle || cycle.root_action_id !== owner.row.root_action_id
    || review.base_draft_id !== source.id || review.review_index !== saved.index
    || review.source_draft_chapter_number !== step.chapter_number || source.chapterNumber !== step.chapter_number
    || review.source_draft_version !== source.version || review.source_draft_status !== source.status || review.source_content !== source.content
    || saved.contextHash !== hash(JSON.stringify(context)) || manifest.reviewRevisionContextHash !== saved.contextHash
    || source.id !== draftSaved.id || source.version !== draftSaved.version || source.content !== draftSaved.content
    || hash(String(review.body)) !== saved.contentHash || !isDeepStrictEqual(saved.artifact, input.artifact)
    || item.value.artifactId !== input.artifact.artifactId || item.value.revision !== input.artifact.revision || item.value.textHash !== input.artifact.textHash
    || object(item.usage.result).finishReason !== 'stop' || object(item.usage.result).failureCode) invalid()
  return { receiptKind: 'review_commit', receiptAttemptId: String(item.row.attempt_id), contentHash: String(saved.contentHash) }
}

export function applyM13WorkflowBatch(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('WORKFLOW_BATCH_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M13_WORKFLOW_BATCH_SQL)
}

export function verifyM13WorkflowBatch(db: Database.Database): boolean {
  try {
    for (const table of M13_WORKFLOW_BATCH_TABLES) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false
    const historicalTasks = new Set(readVerifiedOrdinaryHistory(db).taskIds)
    const tasks = db.prepare('SELECT * FROM workflow_batch_tasks').all() as Row[]
    for (const task of tasks) {
      const recipe = parseWorkflowBatchRecipe(JSON.parse(String(task.recipe_json)))
      if (!identifier(task.task_id) || !identifier(task.project_id) || !identifier(task.operation_key)
        || task.template !== 'prepared-batch-review-v2' || !integer(task.revision, 1)
        || !['ready', 'paused', 'blocked', 'cancelled', 'waiting_review'].includes(String(task.state))
        || (task.state === 'blocked' ? typeof task.blocked_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(task.blocked_code) : task.blocked_code !== null)
        || !integer(task.created_at) || !integer(task.updated_at, Number(task.created_at))
        || JSON.stringify(recipe) !== task.recipe_json || hash(String(task.recipe_json)) !== task.recipe_hash) return false
      const historical = historicalTasks.has(String(task.task_id))
      const root = run(db, task.batch_run_id)
      const manifest = historical ? {} : object(root.binding.sourceManifest)
      if (historical ? !isDeepStrictEqual(root.binding, {}) : root.binding.projectId !== task.project_id || manifest.operation !== 'batch-chapters'
        || manifest.freezeWritingLanguage !== true || manifest.writingLanguage !== recipe.writingLanguage
        || !isDeepStrictEqual(manifest.batchIntent, recipe.intent) || !isDeepStrictEqual(manifest.authorInputs ?? [], recipe.authorInputs)
        || !digest(task.request_hash) || typeof task.review_model_id !== 'string' || !task.review_model_id.trim() || !digest(task.review_model_hash)) return false
      const steps = db.prepare('SELECT * FROM workflow_batch_steps WHERE task_id=?').all(task.task_id) as Row[]
      if (steps.length > 26 * (recipe.intent.range.endChapter - recipe.intent.range.startChapter + 1)) return false
      const groups = new Map<string, unknown>()
      for (const step of steps) {
        const input = parseWorkflowBatchStepInput(JSON.parse(String(step.input_json)))
        assertWorkflowBatchSlot(step.role as 'draft' | 'review', step.kind as never, Number(step.slot), input)
        if (!identifier(step.step_id) || !identifier(step.command_id) || !identifier(step.run_id)
          || !integer(step.chapter_number, recipe.intent.range.startChapter) || Number(step.chapter_number) > recipe.intent.range.endChapter
          || JSON.stringify(input) !== step.input_json || hash(String(step.input_json)) !== step.input_hash
          || (input.kind === 'model' && !historical ? !identifier(step.invocation_nonce) : step.invocation_nonce !== null)) return false
        const group = `${step.chapter_number}:${step.role}`, assigned = groups.get(group)
        if (assigned !== undefined && assigned !== step.run_id) return false
        groups.set(group, step.run_id)
        if (db.prepare('SELECT 1 FROM workflow_batch_steps WHERE run_id=? AND (task_id<>? OR chapter_number<>? OR role<>?) LIMIT 1')
          .get(step.run_id, task.task_id, step.chapter_number, step.role)) return false
        const child = run(db, step.run_id), childManifest = historical ? {} : object(child.binding.sourceManifest)
        if (historical ? !isDeepStrictEqual(child.binding, {}) : child.binding.projectId !== task.project_id || childManifest.chapterNumber !== step.chapter_number
          || childManifest.operation !== (step.role === 'draft' ? 'chapter-draft' : 'review-chapter')
          || (step.role === 'draft' ? child.row.root_action_id !== root.row.root_action_id || childManifest.batchId !== task.batch_run_id
            : child.row.root_action_id === root.row.root_action_id || childManifest.batchId !== undefined)) return false
        if (!historical && input.kind === 'model' && input.task.budgetDemand
          && input.task.budgetDemand.writingLanguage !== recipe.writingLanguage) return false
        if (!historical && step.role === 'review') {
          const context = object(childManifest.reviewRevisionContext), model = object(childManifest.modelReceipt)
          if (context.operation !== 'review-chapter' || context.recheck !== undefined || context.confirmation !== undefined
            || context.writingLanguage !== recipe.writingLanguage || context.uiLocale !== recipe.uiLocale
            || model.modelId !== task.review_model_id || object(child.binding.fingerprint).modelLeaseRevision !== task.review_model_hash) return false
        }
        if (step.role === 'review' && db.prepare(`SELECT 1 FROM workflow_batch_steps s JOIN generation_runs r ON r.run_id=s.run_id
          WHERE s.role='review' AND r.root_action_id=? AND (s.task_id<>? OR s.chapter_number<>?) LIMIT 1`)
          .get(child.row.root_action_id, task.task_id, step.chapter_number)) return false
        if (!historical && step.kind === 'outline' && step.slot === 1) {
          const first = steps.find(value => value.chapter_number === step.chapter_number && value.kind === 'outline' && value.slot === 0)
          if (!first || first.input_json !== step.input_json) return false
          const prior = readWorkflowBatchEffectProof(db, String(task.task_id), String(first.step_id))
          if (!prior || step.invocation_nonce !== `draft-short-outline-retry:${prior.receiptAttemptId}`) return false
        }
        const effect = db.prepare('SELECT * FROM workflow_batch_effects WHERE step_id=?').get(step.step_id) as Row | undefined
        if (effect) {
          if (!integer(effect.acknowledged_at) || !digest(effect.content_hash) || !identifier(effect.receipt_attempt_id)) return false
          if (!historical) {
            if (effect.semantic_history_json !== null || effect.semantic_history_hash !== null) return false
            const proof = readWorkflowBatchEffectProof(db, String(task.task_id), String(step.step_id))
            if (!proof || proof.receiptKind !== effect.receipt_kind || proof.receiptAttemptId !== effect.receipt_attempt_id || proof.contentHash !== effect.content_hash) return false
          }
        }
      }
      if (steps.some(step => step.role === 'review') || task.state === 'waiting_review') {
        for (let chapter = recipe.intent.range.startChapter; chapter <= recipe.intent.range.endChapter; chapter++) {
          if (!db.prepare(`SELECT 1 FROM workflow_batch_steps s JOIN workflow_batch_effects e ON e.step_id=s.step_id
            WHERE s.task_id=? AND s.chapter_number=? AND s.kind='draft_commit' AND e.receipt_kind='draft_commit'`).get(task.task_id, chapter)) return false
          if (task.state === 'waiting_review' && !db.prepare(`SELECT 1 FROM workflow_batch_steps s JOIN workflow_batch_effects e ON e.step_id=s.step_id
            WHERE s.task_id=? AND s.chapter_number=? AND s.kind='review_commit' AND e.receipt_kind='review_commit'`).get(task.task_id, chapter)) return false
        }
      }
    }
    return M13_WORKFLOW_BATCH_TABLES.every(table => db.prepare(`PRAGMA foreign_key_check(${table})`).all().length === 0)
  } catch { return false }
}

export function createM13Migration(deps: { database(reader: SchemaReader): Database.Database; verifyKnownSchema(reader: SchemaReader): boolean }): MigrationImplementation {
  return { id: 'M13', from: 13, to: 14, owner: 'workflow-batch', migrate: reader => applyM13WorkflowBatch(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM13WorkflowBatch(deps.database(reader)) }
}
