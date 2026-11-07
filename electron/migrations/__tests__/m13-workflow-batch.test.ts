import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWorkflowBatchRecipe, parseWorkflowBatchStepInput } from '../../../src/shared/workflow-batch-contract'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { applyM13WorkflowBatch, M13_WORKFLOW_BATCH_SQL, M13_WORKFLOW_BATCH_TABLES, verifyM13WorkflowBatch } from '../m13-workflow-batch'
import { readVerifiedOrdinaryHistory } from '../ordinary-review-history'
import { textHash } from '../../repositories/generation-run-repository'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close() })
const h = textHash('fictional-frozen-model')
const recipe = parseWorkflowBatchRecipe({ schemaVersion: 2, writingLanguage: 'en-US', uiLocale: 'en-US',
  intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 10 }, targetUnits: 100 }, authorInputs: [] })
function fixture() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 13)
  db.prepare("INSERT INTO project_core(id,project_name,premise,writing_language) VALUES('main','Fictional M13 book','Retained author fact','en-US')").run()
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)').run('batch-root', 'batch-root-key', '{}', '{}')
  db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('batch-run', 'batch-root', JSON.stringify({ projectId: 'project-A',
    sourceManifest: { operation: 'batch-chapters', batchIntent: recipe.intent, authorInputs: [], freezeWritingLanguage: true, writingLanguage: 'en-US' } }), 'running', 100, 'batch-open')
  return db
}
function seed(db: Database.Database) {
  const taskId = randomUUID(), encoded = JSON.stringify(recipe)
  db.prepare("INSERT INTO workflow_batch_tasks VALUES(?,?,?,?,'prepared-batch-review-v2','batch-run',1,'ready',NULL,?,?,?, ?,100,100)")
    .run(taskId, 'project-A', randomUUID(), textHash('private-request'), encoded, textHash(encoded), 'review-model', h)
  return taskId
}
function model(db: Database.Database, taskId: string) {
  const input = parseWorkflowBatchStepInput({ kind: 'model', task: { purpose: 'chapter-draft-short-outline', output: 'visible-text',
    messages: [{ role: 'user', content: 'Frozen outline brief' }] } })
  if (input.kind !== 'model') throw new Error('fixture input')
  db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('chapter-run', 'batch-root', JSON.stringify({ projectId: 'project-A',
    fingerprint: { modelLeaseRevision: h, policyHash: h }, sourceManifest: { operation: 'chapter-draft', chapterNumber: 1, batchId: 'batch-run' } }), 'running', 100, 'chapter-open')
  const stepId = randomUUID(), nonce = randomUUID(), inputJson = JSON.stringify(input)
  db.prepare('INSERT INTO workflow_batch_steps VALUES(?,?,1,\'draft\',\'outline\',0,?,\'chapter-run\',?,?,?)')
    .run(stepId, taskId, randomUUID(), nonce, inputJson, textHash(inputJson))
  const fingerprint = { modelLeaseRevision: h, policyHash: h }, identity = { artifactId: 'outline-artifact', epoch: 'original-epoch', fingerprint }
  const text = 'Known frozen outline output.', usage = { requestHash: textHash(JSON.stringify([input.task, h, h])),
    purpose: input.task.purpose, replayTask: input.task, artifactIdentity: identity, result: { finishReason: 'length' } }
  db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run('outline-attempt', 'outline-reservation', 'chapter-run', 'batch-root',
    JSON.stringify({ attemptId: 'outline-attempt', rootActionId: 'batch-root', status: 'unknown' }), JSON.stringify(usage), nonce)
  db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run('outline-artifact', 'outline-attempt', 'chapter-run',
    JSON.stringify({ ...identity, projectId: 'project-A', attemptId: 'outline-attempt', rootActionId: 'batch-root', revision: 1, text, textHash: textHash(text) }), 1, 'partial')
  db.prepare('INSERT INTO workflow_batch_effects VALUES(?,?,?,?,100,NULL,NULL)').run(stepId, 'model', 'outline-attempt', textHash(text))
  return { stepId, input, usage }
}

describe('M13 independent workflow batch schema', () => {
  it('only appends three tables in the caller native transaction and preserves schema13 facts and v1', () => {
    const db = fixture(), author = db.prepare('SELECT * FROM project_core').all(), runs = db.prepare('SELECT * FROM generation_runs').all()
    const v1 = ['workflow_tasks', 'workflow_steps', 'workflow_effects'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
    expect(() => applyM13WorkflowBatch(db)).toThrow('MIGRATION_TRANSACTION_REQUIRED')
    db.transaction(() => applyM13WorkflowBatch(db))()
    expect(verifyM13WorkflowBatch(db)).toBe(true)
    expect(db.prepare('SELECT * FROM project_core').all()).toEqual(author)
    expect(db.prepare('SELECT * FROM generation_runs').all()).toEqual(runs)
    expect(['workflow_tasks', 'workflow_steps', 'workflow_effects'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(v1)
    expect(db.pragma('user_version', { simple: true })).toBe(13)
    expect(M13_WORKFLOW_BATCH_TABLES.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual([[], [], []])
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name)
    expect(columns('workflow_batch_tasks')).toEqual(['task_id', 'project_id', 'operation_key', 'request_hash', 'template', 'batch_run_id', 'revision',
      'state', 'blocked_code', 'recipe_json', 'recipe_hash', 'review_model_id', 'review_model_hash', 'created_at', 'updated_at'])
    expect(columns('workflow_batch_steps')).toEqual(['step_id', 'task_id', 'chapter_number', 'role', 'kind', 'slot', 'command_id', 'run_id', 'invocation_nonce', 'input_json', 'input_hash'])
    expect(columns('workflow_batch_effects')).toEqual(['step_id', 'receipt_kind', 'receipt_attempt_id', 'content_hash', 'acknowledged_at', 'semantic_history_json', 'semantic_history_hash'])
  })

  it('rolls back DDL and user_version without scanning or rewriting original runs', () => {
    const db = fixture(), before = sqliteSchemaFingerprint(db), runs = db.prepare('SELECT * FROM generation_runs').all()
    expect(() => db.transaction(() => { db.exec(M13_WORKFLOW_BATCH_SQL); db.pragma('user_version=14'); throw new Error('verification failed') })()).toThrow('verification failed')
    expect(sqliteSchemaFingerprint(db)).toBe(before)
    expect(db.pragma('user_version', { simple: true })).toBe(13)
    expect(db.prepare('SELECT * FROM generation_runs').all()).toEqual(runs)
    expect(verifyM13WorkflowBatch(db)).toBe(false)
  })

  it('allows sparse pending slots and terminal observation without claiming accepted or committed output', () => {
    const db = fixture(); db.transaction(() => applyM13WorkflowBatch(db))(); const taskId = seed(db)
    expect(verifyM13WorkflowBatch(db)).toBe(true)
    const prepared = model(db, taskId)
    expect(verifyM13WorkflowBatch(db)).toBe(true)
    db.prepare('DELETE FROM workflow_batch_effects WHERE step_id=?').run(prepared.stepId)
    expect(verifyM13WorkflowBatch(db)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
  })

  it.each(['recipe-hash', 'recipe-extra', 'input-hash', 'input-extra', 'wrong-project', 'wrong-purpose', 'receipt-hash', 'missing-artifact', 'live-semantic', 'language'])(
    'rejects %s corruption without repairing original evidence', corruption => {
      const db = fixture(); db.transaction(() => applyM13WorkflowBatch(db))(); const taskId = seed(db), prepared = model(db, taskId)
      if (corruption === 'recipe-hash') db.prepare('UPDATE workflow_batch_tasks SET recipe_hash=?').run('a'.repeat(64))
      if (corruption === 'recipe-extra') {
        const value = JSON.stringify({ ...recipe, modelProfile: { apiKey: 'fictional-excluded-secret' } })
        db.prepare('UPDATE workflow_batch_tasks SET recipe_json=?,recipe_hash=?').run(value, textHash(value))
      }
      if (corruption.startsWith('input-')) {
        const value = JSON.stringify({ ...prepared.input, ...(corruption === 'input-extra' ? { epoch: 'excluded-epoch' } : {}) })
        db.prepare('UPDATE workflow_batch_steps SET input_json=?,input_hash=?').run(value, corruption === 'input-hash' ? 'a'.repeat(64) : textHash(value))
      }
      if (corruption === 'wrong-project') db.prepare("UPDATE workflow_batch_tasks SET project_id='other-project'").run()
      if (corruption === 'wrong-purpose') db.prepare('UPDATE generation_attempts SET usage_receipt_json=?').run(JSON.stringify({ ...prepared.usage, purpose: 'chapter-draft' }))
      if (corruption === 'receipt-hash') db.prepare('UPDATE workflow_batch_effects SET content_hash=?').run('b'.repeat(64))
      if (corruption === 'missing-artifact') db.prepare('DELETE FROM generation_artifacts').run()
      if (corruption === 'live-semantic') db.prepare('UPDATE workflow_batch_effects SET semantic_history_json=?,semantic_history_hash=?').run('{}', textHash('{}'))
      if (corruption === 'language') {
        const row = db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=\'batch-run\'').pluck().get() as string
        const binding = JSON.parse(row); binding.sourceManifest.writingLanguage = 'zh-CN'
        db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=\'batch-run\'').run(JSON.stringify(binding))
      }
      const before = db.prepare('SELECT * FROM workflow_batch_tasks').all()
      expect(verifyM13WorkflowBatch(db)).toBe(false)
      expect(db.prepare('SELECT * FROM workflow_batch_tasks').all()).toEqual(before)
    })

  it('enforces scalar closed sets, integer bounds, native foreign keys and paired X/history columns', () => {
    const db = fixture(); db.transaction(() => applyM13WorkflowBatch(db))(); const taskId = seed(db), prepared = model(db, taskId)
    for (const assignment of ["template='prepared-first-chapter-v1'", 'revision=0', 'revision=1.5', "state='done'", "state='blocked'",
      'review_model_id=NULL', "request_hash='bad'", 'updated_at=99']) expect(() => db.prepare(`UPDATE workflow_batch_tasks SET ${assignment} WHERE task_id=?`).run(taskId)).toThrow()
    for (const assignment of ["role='review'", 'slot=2', 'slot=0.5', "run_id='absent'", "kind='arbitrary'"])
      expect(() => db.prepare(`UPDATE workflow_batch_steps SET ${assignment} WHERE step_id=?`).run(prepared.stepId)).toThrow()
    for (const assignment of ["receipt_kind='accepted'", "receipt_attempt_id='absent'", "semantic_history_json='{}'", 'acknowledged_at=-1'])
      expect(() => db.prepare(`UPDATE workflow_batch_effects SET ${assignment}`).run()).toThrow()
  })

  it('accepts only exact DB-proven historical tasks and keeps both portable generations nonexecuting', () => {
    const db = fixture(); db.transaction(() => applyM13WorkflowBatch(db))(); const taskId = seed(db); model(db, taskId)
    db.prepare("UPDATE generation_runs SET binding_json='{}'").run()
    db.prepare('UPDATE workflow_batch_tasks SET request_hash=NULL,review_model_id=NULL,review_model_hash=NULL').run()
    expect(verifyM13WorkflowBatch(db)).toBe(false)
    db.prepare('UPDATE workflow_batch_tasks SET operation_key=?').run(`portable-history:${taskId}`)
    db.prepare('UPDATE workflow_batch_steps SET invocation_nonce=NULL').run()
    db.prepare('UPDATE generation_attempts SET invocation_nonce=?,usage_receipt_json=NULL').run('portable-history:outline-attempt')
    let copy = db
    for (let generation = 1; generation <= 2; generation++) {
      copy = new Database(copy.serialize()); databases.push(copy); copy.pragma('foreign_keys=ON')
      expect(readVerifiedOrdinaryHistory(copy).taskIds).toEqual([taskId])
      expect(verifyM13WorkflowBatch(copy)).toBe(true)
      expect(copy.prepare('SELECT request_hash,review_model_id,review_model_hash FROM workflow_batch_tasks').get()).toEqual({ request_hash: null, review_model_id: null, review_model_hash: null })
    }
    db.prepare('UPDATE workflow_batch_effects SET content_hash=?').run('c'.repeat(64))
    expect(verifyM13WorkflowBatch(db)).toBe(false)
  })
})
