import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { parseWorkflowDriverRecipe, parseWorkflowDriverStepInput } from '../../src/shared/workflow-driver-contract'
import { draftShortOutlineBlock } from '../../src/shared/draft-short-outline'
import { sanitizeDraftText } from '../../src/shared/draft-visible-text'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M12_WORKFLOW_DRIVER_TABLES = ['workflow_tasks', 'workflow_steps', 'workflow_effects'] as const
export const M12_WORKFLOW_DRIVER_STEP_KINDS = ['outline', 'draft', 'compose', 'commit'] as const
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const contentHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const integer = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum
const identifier = (value: unknown) => typeof value === 'string' && /^[\p{L}\p{N}._:@+-]{1,512}$/u.test(value)
const code = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value)
type Row = Record<string, unknown>
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKFLOW_DRIVER_CATALOG_INVALID')
  return value as Row
}
function json(value: unknown): Row {
  if (typeof value !== 'string') throw new Error('WORKFLOW_DRIVER_CATALOG_INVALID')
  return object(JSON.parse(value))
}

function verifyReceipts(db: Database.Database, task: Row, steps: Row[], historical: boolean): boolean {
  const recipe = parseWorkflowDriverRecipe(JSON.parse(String(task.recipe_json))), binding = json(task.binding_json)
  let outline: Row | undefined, draft: { artifact: Row; usage: Row; attemptId: unknown } | undefined
  let composedHash: string | undefined
  let preceding = true
  for (const [ordinal, step] of steps.entries()) {
    const effect = db.prepare('SELECT * FROM workflow_effects WHERE step_id=?').get(step.step_id) as Row | undefined
    const input = step.input_json === null ? null : parseWorkflowDriverStepInput(JSON.parse(String(step.input_json)))
    if (input && !preceding || effect && !input) return false
    if (input?.kind === 'model') {
      if (ordinal === 0 && !isDeepStrictEqual(input.task, recipe.outlineTask)) return false
      if (ordinal === 1) {
        if (!outline) return false
        const outlineText = String(outline.text)
        const expected = { ...recipe.baseDraftTask, messages: recipe.baseDraftTask.messages.map(message => message.role === 'user'
          ? { ...message, content: `${message.content}\n\n${draftShortOutlineBlock(recipe.writingLanguage, outlineText)}` } : { ...message }) }
        if (!isDeepStrictEqual(input.task, expected)) return false
      }
    }
    if (input?.kind === 'compose' && (!draft || input.artifactIds.length !== 1 || input.artifactIds[0] !== draft.artifact.artifactId
      || input.expectedTextHash !== hash(sanitizeDraftText(String(draft.artifact.text), input.algorithm)))) return false
    if (input?.kind === 'commit' && (input.chapterNumber !== 1 || input.expectedCompositionHash !== composedHash)) return false
    if (!effect) { preceding = false; continue }
    if (!preceding || !identifier(effect.receipt_attempt_id) || !contentHash(effect.content_hash)
      || !integer(effect.acknowledged_at, 0) || !input) return false
    if (input.kind === 'model') {
      if (effect.receipt_kind !== 'model') return false
      const row = db.prepare(`SELECT a.*,r.root_action_id AS run_root,t.run_id AS attempt_run,t.root_action_id AS attempt_root,
        t.attempt_json,t.usage_receipt_json,t.invocation_nonce FROM generation_artifacts a
        JOIN generation_attempts t ON t.attempt_id=a.attempt_id JOIN generation_runs r ON r.run_id=a.run_id
        WHERE t.attempt_id=?`).get(effect.receipt_attempt_id) as Row | undefined
      if (!row || row.run_id !== task.run_id || row.attempt_run !== task.run_id || row.attempt_root !== row.run_root || row.status === 'discarded') return false
      const artifact = json(row.artifact_json), attempt = json(row.attempt_json)
      if (artifact.artifactId !== row.artifact_id || artifact.attemptId !== effect.receipt_attempt_id
        || artifact.rootActionId !== row.run_root || artifact.revision !== row.revision || !integer(artifact.revision, 0)
        || typeof artifact.text !== 'string' || !artifact.text.trim() || hash(artifact.text) !== artifact.textHash
        || effect.content_hash !== artifact.textHash || attempt.attemptId !== effect.receipt_attempt_id
        || attempt.rootActionId !== row.run_root || !['settled', 'unknown'].includes(String(attempt.status))) return false
      let usage: Row = {}
      if (!historical) {
        usage = json(row.usage_receipt_json)
        const identity = object(usage.artifactIdentity), result = object(usage.result), fingerprint = object(binding.fingerprint)
        if (row.invocation_nonce !== step.invocation_nonce || usage.purpose !== input.task.purpose
          || !isDeepStrictEqual(usage.replayTask, input.task)
          || usage.requestHash !== hash(JSON.stringify([input.task, fingerprint.modelLeaseRevision, fingerprint.policyHash]))
          || result.finishReason !== 'stop' || result.failureCode || artifact.projectId !== task.project_id
          || artifact.artifactId !== identity.artifactId || artifact.epoch !== identity.epoch
          || !isDeepStrictEqual(artifact.fingerprint, identity.fingerprint) || !isDeepStrictEqual(artifact.fingerprint, binding.fingerprint)) return false
        if (db.prepare('SELECT 1 FROM generation_recovery_tails WHERE attempt_id=?').get(effect.receipt_attempt_id)) return false
      }
      if (ordinal === 0) outline = artifact
      else draft = { artifact, usage, attemptId: effect.receipt_attempt_id }
    } else {
      if (!draft || effect.receipt_attempt_id !== draft.attemptId) return false
      if (input.kind === 'compose') {
        if (effect.receipt_kind !== 'composition' || effect.content_hash !== input.expectedTextHash) return false
        if (!historical) {
          const stored = object(draft.usage.visibleComposition)
          if (stored.algorithm !== input.algorithm || stored.textHash !== effect.content_hash
            || !isDeepStrictEqual(stored.artifactIds, input.artifactIds)
            || !isDeepStrictEqual(stored.sources, [{ artifactId: draft.artifact.artifactId,
              revision: draft.artifact.revision, textHash: draft.artifact.textHash }]) || stored.chapters !== undefined) return false
        }
        composedHash = input.expectedTextHash
      } else {
        if (effect.receipt_kind !== 'draft_commit' || effect.content_hash !== input.expectedCompositionHash) return false
        if (!historical) {
          const saved = object(draft.usage.draftCommit), handle = object(saved.handle), identity = object(draft.usage.artifactIdentity)
          const composeInput = parseWorkflowDriverStepInput(JSON.parse(String(steps[2]!.input_json)))
          if (composeInput.kind !== 'compose' || saved.success !== true || !integer(saved.id, 1) || !integer(saved.version, 1)
            || saved.chapterNumber !== 1 || saved.contentHash !== composedHash || typeof saved.content !== 'string'
            || hash(saved.content) !== saved.contentHash || saved.content !== sanitizeDraftText(String(draft.artifact.text), composeInput.algorithm)
            || saved.batchId !== undefined || !isDeepStrictEqual(handle, { projectId: task.project_id, epoch: identity.epoch,
              rootActionId: draft.artifact.rootActionId, runId: task.run_id })) return false
        }
      }
    }
  }
  return true
}

export const M12_WORKFLOW_DRIVER_SQL = `
CREATE TABLE workflow_tasks (
  task_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  request_hash TEXT CHECK(request_hash IS NULL OR (length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*')),
  template TEXT NOT NULL CHECK(template='prepared-first-chapter-v1'),
  run_id TEXT NOT NULL UNIQUE REFERENCES generation_runs(run_id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
  state TEXT NOT NULL CHECK(state IN ('ready','paused','blocked','cancelled','waiting_review')),
  blocked_code TEXT,
  recipe_json TEXT NOT NULL,
  recipe_hash TEXT NOT NULL CHECK(length(recipe_hash)=64 AND recipe_hash NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
  CHECK((state='blocked' AND blocked_code IS NOT NULL AND length(blocked_code) BETWEEN 1 AND 128 AND blocked_code NOT GLOB '*[^A-Z0-9_]*')
    OR (state<>'blocked' AND blocked_code IS NULL))
);
CREATE TABLE workflow_steps (
  step_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES workflow_tasks(task_id),
  ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 3),
  kind TEXT NOT NULL CHECK((ordinal=0 AND kind='outline') OR (ordinal=1 AND kind='draft')
    OR (ordinal=2 AND kind='compose') OR (ordinal=3 AND kind='commit')),
  command_id TEXT NOT NULL UNIQUE,
  invocation_nonce TEXT UNIQUE,
  input_json TEXT,
  input_hash TEXT CHECK(input_hash IS NULL OR (length(input_hash)=64 AND input_hash NOT GLOB '*[^a-f0-9]*')),
  UNIQUE(task_id,ordinal),
  CHECK((input_json IS NULL AND input_hash IS NULL) OR (input_json IS NOT NULL AND input_hash IS NOT NULL)),
  CHECK(kind IN ('outline','draft') OR invocation_nonce IS NULL)
);
CREATE TABLE workflow_effects (
  step_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_steps(step_id),
  receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('model','composition','draft_commit')),
  receipt_attempt_id TEXT NOT NULL REFERENCES generation_attempts(attempt_id),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  acknowledged_at INTEGER NOT NULL CHECK(typeof(acknowledged_at)='integer' AND acknowledged_at>=0)
);
`

export function applyM12WorkflowDriver(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('WORKFLOW_DRIVER_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M12_WORKFLOW_DRIVER_SQL)
}

/** Schema/history validation only. This never resumes a task or reconstructs execution authority. */
export function verifyM12WorkflowDriver(db: Database.Database): boolean {
  try {
    const tasks = db.prepare(`SELECT t.*,r.binding_json FROM workflow_tasks t
      LEFT JOIN generation_runs r ON r.run_id=t.run_id`).all() as Array<Record<string, unknown>>
    for (const task of tasks) {
      if (!identifier(task.task_id) || !identifier(task.project_id) || !identifier(task.operation_key)
        || task.request_hash !== null && !contentHash(task.request_hash)
        || task.template !== 'prepared-first-chapter-v1' || !identifier(task.run_id)
        || !integer(task.revision, 1) || !['ready', 'paused', 'blocked', 'cancelled', 'waiting_review'].includes(String(task.state))
        || (task.state === 'blocked' ? !code(task.blocked_code) : task.blocked_code !== null)
        || !integer(task.created_at, 0) || !integer(task.updated_at, Number(task.created_at))
        || typeof task.recipe_json !== 'string' || !contentHash(task.recipe_hash)
        || typeof task.binding_json !== 'string') return false
      const binding = JSON.parse(task.binding_json) as { projectId?: unknown }
      const historical = task.binding_json === '{}' && task.request_hash === null
        && task.operation_key === `portable-history:${task.task_id}`
      if (!historical && (task.request_hash === null || binding.projectId !== task.project_id)) return false
      const parsedRecipe = parseWorkflowDriverRecipe(JSON.parse(task.recipe_json)), recipe = JSON.stringify(parsedRecipe)
      if (recipe !== task.recipe_json || hash(recipe) !== task.recipe_hash) return false
      if ([parsedRecipe.outlineTask, parsedRecipe.baseDraftTask].some(input => input.budgetDemand
        && input.budgetDemand.writingLanguage !== parsedRecipe.writingLanguage)) return false
      if (!historical) {
        const manifest = object(object(binding).sourceManifest)
        if (manifest.freezeWritingLanguage !== true || manifest.writingLanguage !== parsedRecipe.writingLanguage) return false
      }
      const steps = db.prepare('SELECT * FROM workflow_steps WHERE task_id=? ORDER BY ordinal').all(task.task_id) as Array<Record<string, unknown>>
      if (steps.length !== 4) return false
      for (const [ordinal, step] of steps.entries()) {
        if (!identifier(step.step_id) || !identifier(step.command_id) || step.ordinal !== ordinal
          || step.kind !== M12_WORKFLOW_DRIVER_STEP_KINDS[ordinal]
          || step.invocation_nonce !== null && !identifier(step.invocation_nonce)
          || historical && step.invocation_nonce !== null
          || !historical && ordinal < 2 && step.invocation_nonce === null
          || ordinal > 1 && step.invocation_nonce !== null
          || (step.input_json === null) !== (step.input_hash === null)) return false
        if (step.input_json !== null) {
          if (typeof step.input_json !== 'string' || !contentHash(step.input_hash)) return false
          const input = parseWorkflowDriverStepInput(JSON.parse(step.input_json))
          const expectedKind = ordinal < 2 ? 'model' : ordinal === 2 ? 'compose' : 'commit'
          if (input.kind !== expectedKind || JSON.stringify(input) !== step.input_json || hash(step.input_json) !== step.input_hash) return false
        }
      }
      if (!verifyReceipts(db, task, steps, historical)) return false
    }
    const effects = db.prepare(`SELECT e.*,s.kind,s.input_json,s.task_id,t.run_id,a.run_id AS receipt_run_id
      FROM workflow_effects e LEFT JOIN workflow_steps s ON s.step_id=e.step_id
      LEFT JOIN workflow_tasks t ON t.task_id=s.task_id
      LEFT JOIN generation_attempts a ON a.attempt_id=e.receipt_attempt_id`).all() as Array<Record<string, unknown>>
    for (const effect of effects) {
      const expectedKind = effect.kind === 'outline' || effect.kind === 'draft' ? 'model'
        : effect.kind === 'compose' ? 'composition' : effect.kind === 'commit' ? 'draft_commit' : null
      if (!identifier(effect.step_id) || !identifier(effect.receipt_attempt_id) || !contentHash(effect.content_hash)
        || !integer(effect.acknowledged_at, 0) || effect.receipt_kind !== expectedKind
        || effect.input_json === null || !effect.run_id || effect.run_id !== effect.receipt_run_id) return false
      const ordinal = M12_WORKFLOW_DRIVER_STEP_KINDS.indexOf(effect.kind as typeof M12_WORKFLOW_DRIVER_STEP_KINDS[number])
      const preceding = db.prepare(`SELECT COUNT(*) FROM workflow_effects e JOIN workflow_steps s ON s.step_id=e.step_id
        WHERE s.task_id=? AND s.ordinal<?`).pluck().get(effect.task_id, ordinal) as number
      if (preceding !== ordinal) return false
    }
    if (db.prepare(`SELECT 1 FROM workflow_tasks t WHERE t.state='waiting_review' AND NOT EXISTS (
      SELECT 1 FROM workflow_steps s JOIN workflow_effects e ON e.step_id=s.step_id
      WHERE s.task_id=t.task_id AND s.kind='commit') LIMIT 1`).get()) return false
    return M12_WORKFLOW_DRIVER_TABLES.every(table => db.prepare(`PRAGMA foreign_key_check(${table})`).all().length === 0)
  } catch { return false }
}

export function createM12Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M12', from: 12, to: 13, owner: 'workflow-driver',
    migrate: reader => applyM12WorkflowDriver(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM12WorkflowDriver(deps.database(reader)) }
}
