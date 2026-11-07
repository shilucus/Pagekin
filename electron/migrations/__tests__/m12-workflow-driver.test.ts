import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWorkflowDriverRecipe, parseWorkflowDriverStepInput } from '../../../src/shared/workflow-driver-contract'
import { textHash } from '../../repositories/generation-run-repository'
import { applyBaselineTables } from '../baseline-schema'
import { M01_GENERATION_SQL } from '../m01-generation-runs'
import { applyM11GenerationRecoveryTails } from '../m11-generation-recovery-tails'
import { applyM12WorkflowDriver, M12_WORKFLOW_DRIVER_SQL, verifyM12WorkflowDriver } from '../m12-workflow-driver'
import { sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close() })
const recipe = parseWorkflowDriverRecipe({ schemaVersion: 1, writingLanguage: 'en-US',
  outlineTask: { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [{ role: 'user', content: 'Frozen outline brief' }] },
  baseDraftTask: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: 'Frozen author brief' }] } })

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.exec("INSERT INTO project_core(id,project_name,premise) VALUES('main','Fictional migration book','Retained author fact')")
  db.exec(M01_GENERATION_SQL)
  db.transaction(() => applyM11GenerationRecoveryTails(db))()
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run('root-A', 'root-key-A', '{}', '{}')
  db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-A', 'root-A',
    JSON.stringify({ projectId: 'project-A', sourceManifest: { freezeWritingLanguage: true, writingLanguage: recipe.writingLanguage } }), 'running', 100, 'open-A')
  db.pragma('user_version=12')
  return db
}

function seed(db: Database.Database) {
  const taskId = randomUUID(), operationKey = randomUUID(), recipeJson = JSON.stringify(recipe)
  db.prepare(`INSERT INTO workflow_tasks VALUES(?,?,?,?,'prepared-first-chapter-v1','run-A',1,'ready',NULL,?,?,100,100)`)
    .run(taskId, 'project-A', operationKey, textHash('private-original-request'), recipeJson, textHash(recipeJson))
  const stepIds = ['outline', 'draft', 'compose', 'commit'].map((kind, ordinal) => {
    const stepId = randomUUID()
    db.prepare('INSERT INTO workflow_steps VALUES(?,?,?,?,?,?,NULL,NULL)').run(stepId, taskId, ordinal, kind, randomUUID(), ordinal < 2 ? randomUUID() : null)
    return stepId
  })
  return { taskId, operationKey, stepIds }
}

function modelReceipt(db: Database.Database, stepId: string) {
  const input = JSON.stringify({ kind: 'model', task: recipe.outlineTask }), text = 'The original frozen outline.'
  db.prepare('UPDATE workflow_steps SET input_json=?,input_hash=? WHERE step_id=?').run(input, textHash(input), stepId)
  const nonce = db.prepare('SELECT invocation_nonce FROM workflow_steps WHERE step_id=?').pluck().get(stepId)
  const fingerprint = { modelLeaseRevision: textHash('frozen-model'), policyHash: textHash('frozen-policy') }
  db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify({ projectId: 'project-A', fingerprint,
    sourceManifest: { freezeWritingLanguage: true, writingLanguage: recipe.writingLanguage } }), 'run-A')
  const identity = { artifactId: 'artifact-A', epoch: 'original-runtime', fingerprint }
  const usage = { requestHash: textHash(JSON.stringify([recipe.outlineTask, fingerprint.modelLeaseRevision, fingerprint.policyHash])),
    purpose: recipe.outlineTask.purpose, replayTask: recipe.outlineTask, artifactIdentity: identity, result: { finishReason: 'stop' } }
  db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run('attempt-A', 'reserve-A', 'run-A', 'root-A',
    JSON.stringify({ attemptId: 'attempt-A', rootActionId: 'root-A', status: 'settled' }), JSON.stringify(usage), nonce)
  db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run('artifact-A', 'attempt-A', 'run-A',
    JSON.stringify({ ...identity, projectId: 'project-A', attemptId: 'attempt-A', rootActionId: 'root-A', revision: 1, text, textHash: textHash(text) }), 1, 'partial')
  db.prepare('INSERT INTO workflow_effects VALUES(?,?,?,?,?)').run(stepId, 'model', 'attempt-A', textHash(text), 100)
  return { usage, contentHash: textHash(text) }
}

describe('M12 workflow driver migration', () => {
  it('only creates three classified tables inside the caller native transaction', () => {
    const db = fixture(), before = db.prepare('SELECT * FROM project_core').all(), runs = db.prepare('SELECT * FROM generation_runs').all()
    expect(() => applyM12WorkflowDriver(db)).toThrow('WORKFLOW_DRIVER_MIGRATION_TRANSACTION_REQUIRED')
    expect(verifyM12WorkflowDriver(db)).toBe(false)
    db.transaction(() => applyM12WorkflowDriver(db))()
    expect(verifyM12WorkflowDriver(db)).toBe(true)
    expect(db.prepare('SELECT * FROM workflow_tasks').all()).toEqual([])
    expect(db.prepare('SELECT * FROM workflow_steps').all()).toEqual([])
    expect(db.prepare('SELECT * FROM workflow_effects').all()).toEqual([])
    expect(db.prepare('SELECT * FROM project_core').all()).toEqual(before)
    expect(db.prepare('SELECT * FROM generation_runs').all()).toEqual(runs)
    expect(db.pragma('user_version', { simple: true })).toBe(12)
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name)
    expect(columns('workflow_tasks')).toEqual(['task_id', 'project_id', 'operation_key', 'request_hash', 'template', 'run_id', 'revision', 'state',
      'blocked_code', 'recipe_json', 'recipe_hash', 'created_at', 'updated_at'])
    expect(columns('workflow_steps')).toEqual(['step_id', 'task_id', 'ordinal', 'kind', 'command_id', 'invocation_nonce', 'input_json', 'input_hash'])
    expect(columns('workflow_effects')).toEqual(['step_id', 'receipt_kind', 'receipt_attempt_id', 'content_hash', 'acknowledged_at'])
  })

  it('rolls back DDL and the caller schema stamp when creation or later verification fails', () => {
    for (const failure of ['ddl', 'verification']) {
      const db = fixture(), fingerprint = sqliteSchemaFingerprint(db)
      expect(() => db.transaction(() => {
        db.exec(failure === 'ddl' ? `${M12_WORKFLOW_DRIVER_SQL}\nSELECT * FROM fictional_missing_workflow_table;` : M12_WORKFLOW_DRIVER_SQL)
        db.pragma('user_version=13')
        throw new Error('fictional verification failure')
      })()).toThrow()
      expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
      expect(db.pragma('user_version', { simple: true })).toBe(12)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'workflow_%'").all()).toEqual([])
    }
  })

  it('accepts only a complete four-step template and closed canonical recipe/input hashes', () => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    const { stepIds } = seed(db)
    const input = JSON.stringify(parseWorkflowDriverStepInput({ kind: 'model', task: recipe.outlineTask }))
    db.prepare('UPDATE workflow_steps SET input_json=?,input_hash=? WHERE step_id=?').run(input, textHash(input), stepIds[0])
    expect(verifyM12WorkflowDriver(db)).toBe(true)
    db.prepare('DELETE FROM workflow_steps WHERE step_id=?').run(stepIds[3])
    expect(verifyM12WorkflowDriver(db)).toBe(false)
  })

  it.each(['recipe-hash', 'unknown-recipe-field', 'input-hash', 'input-kind', 'input-unknown-field', 'project-reference'])(
    'fails closed on %s corruption without rewriting the row', corruption => {
      const db = fixture()
      db.transaction(() => applyM12WorkflowDriver(db))()
      const { taskId, stepIds } = seed(db)
      if (corruption === 'recipe-hash') db.prepare('UPDATE workflow_tasks SET recipe_hash=? WHERE task_id=?').run('a'.repeat(64), taskId)
      if (corruption === 'unknown-recipe-field') {
        const raw = JSON.stringify({ ...recipe, modelProfile: { apiKey: 'fictional-excluded-key' } })
        db.prepare('UPDATE workflow_tasks SET recipe_json=?,recipe_hash=? WHERE task_id=?').run(raw, textHash(raw), taskId)
      }
      if (corruption.startsWith('input-')) {
        const raw = JSON.stringify(corruption === 'input-kind' ? { kind: 'commit', chapterNumber: 1, expectedCompositionHash: 'a'.repeat(64) }
          : { kind: 'model', task: recipe.outlineTask, ...(corruption === 'input-unknown-field' ? { epoch: 'excluded-original-epoch' } : {}) })
        db.prepare('UPDATE workflow_steps SET input_json=?,input_hash=? WHERE step_id=?')
          .run(raw, corruption === 'input-hash' ? 'a'.repeat(64) : textHash(raw), stepIds[0])
      }
      if (corruption === 'project-reference') db.prepare('UPDATE workflow_tasks SET project_id=? WHERE task_id=?').run('another-project', taskId)
      const before = db.prepare('SELECT * FROM workflow_tasks').all()
      expect(verifyM12WorkflowDriver(db)).toBe(false)
      expect(db.prepare('SELECT * FROM workflow_tasks').all()).toEqual(before)
    },
  )

  it('enforces template, integer, state, paired input and nonmodel nonce constraints', () => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    const { taskId, stepIds } = seed(db)
    for (const assignment of ["template='batch'", 'revision=0', 'revision=1.5', "state='done'", "state='blocked'", 'created_at=-1', 'updated_at=99', "request_hash='not-a-hash'"]) {
      expect(() => db.prepare(`UPDATE workflow_tasks SET ${assignment} WHERE task_id=?`).run(taskId)).toThrow()
    }
    for (const assignment of ['ordinal=1', "kind='commit'", "input_json='{}'", "invocation_nonce='nonmodel-private-nonce'"]) {
      expect(() => db.prepare(`UPDATE workflow_steps SET ${assignment} WHERE step_id=?`).run(stepIds[2])).toThrow()
    }
    expect(verifyM12WorkflowDriver(db)).toBe(true)
  })

  it.each(['zh-CN', 'en-US'] as const)('rejects recipe language inconsistent with the main-frozen %s language', writingLanguage => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    const { taskId } = seed(db), other = writingLanguage === 'en-US' ? 'zh-CN' : 'en-US'
    const encoded = JSON.stringify(parseWorkflowDriverRecipe({ ...recipe, writingLanguage: other }))
    db.prepare('UPDATE workflow_tasks SET recipe_json=?,recipe_hash=? WHERE task_id=?').run(encoded, textHash(encoded), taskId)
    db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.sourceManifest.writingLanguage',?) WHERE run_id='run-A'").run(writingLanguage)
    expect(verifyM12WorkflowDriver(db)).toBe(false)
  })

  it('requires explicit main freezing for live tasks but does not reinterpret old history through current project language', () => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    seed(db)
    db.prepare("UPDATE project_core SET writing_language='zh-CN' WHERE id='main'").run()
    expect(verifyM12WorkflowDriver(db)).toBe(true)
    db.prepare("UPDATE generation_runs SET binding_json=json_remove(binding_json,'$.sourceManifest.freezeWritingLanguage') WHERE run_id='run-A'").run()
    expect(verifyM12WorkflowDriver(db)).toBe(false)
  })

  it.each(['live', 'history'])('rejects contradictory budget languages in %s recipes', mode => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    const { taskId } = seed(db)
    const encoded = JSON.stringify(parseWorkflowDriverRecipe({ ...recipe, baseDraftTask: { ...recipe.baseDraftTask,
      budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 20, segmentable: false } } }))
    db.prepare('UPDATE workflow_tasks SET recipe_json=?,recipe_hash=? WHERE task_id=?').run(encoded, textHash(encoded), taskId)
    if (mode === 'history') {
      db.prepare('UPDATE workflow_tasks SET operation_key=?,request_hash=NULL WHERE task_id=?').run(`portable-history:${taskId}`, taskId)
      db.prepare('UPDATE workflow_steps SET invocation_nonce=NULL WHERE task_id=?').run(taskId)
      db.prepare("UPDATE generation_runs SET binding_json='{}' WHERE run_id='run-A'").run()
    }
    expect(verifyM12WorkflowDriver(db)).toBe(false)
  })

  it('verifies receipt kind, original run ownership and content against the original artifact', () => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    const { stepIds } = seed(db)
    const original = modelReceipt(db, stepIds[0]!)
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-B', 'root-A', '{"projectId":"project-A"}', 'running', 100, 'open-B')
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run('attempt-B', 'reserve-B', 'run-B', 'root-A', '{}', '{}', 'private-nonce-B')
    expect(verifyM12WorkflowDriver(db)).toBe(true)
    db.prepare('UPDATE workflow_effects SET content_hash=? WHERE step_id=?').run('a'.repeat(64), stepIds[0])
    expect(verifyM12WorkflowDriver(db)).toBe(false)
    db.prepare('UPDATE workflow_effects SET content_hash=? WHERE step_id=?').run(original.contentHash, stepIds[0])
    db.prepare('UPDATE workflow_effects SET receipt_attempt_id=? WHERE step_id=?').run('attempt-B', stepIds[0])
    expect(verifyM12WorkflowDriver(db)).toBe(false)
    db.prepare('UPDATE workflow_effects SET receipt_attempt_id=?,receipt_kind=? WHERE step_id=?').run('attempt-A', 'draft_commit', stepIds[0])
    expect(verifyM12WorkflowDriver(db)).toBe(false)
  })

  it.each(['purpose', 'replay-task', 'missing-artifact', 'artifact-hash', 'live-nonce'])(
    'rejects %s catalog corruption rather than treating a scalar reference as proof', corruption => {
      const db = fixture()
      db.transaction(() => applyM12WorkflowDriver(db))()
      const { stepIds } = seed(db), { usage } = modelReceipt(db, stepIds[0]!)
      expect(verifyM12WorkflowDriver(db)).toBe(true)
      if (corruption === 'purpose') db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
        .run(JSON.stringify({ ...usage, purpose: 'chapter-review' }), 'attempt-A')
      if (corruption === 'replay-task') db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
        .run(JSON.stringify({ ...usage, replayTask: recipe.baseDraftTask }), 'attempt-A')
      if (corruption === 'missing-artifact') db.prepare('DELETE FROM generation_artifacts WHERE artifact_id=?').run('artifact-A')
      if (corruption === 'artifact-hash') db.prepare("UPDATE generation_artifacts SET artifact_json=json_set(artifact_json,'$.text','Changed artifact without original hash') WHERE artifact_id=?").run('artifact-A')
      if (corruption === 'live-nonce') db.prepare('UPDATE workflow_steps SET invocation_nonce=NULL WHERE step_id=?').run(stepIds[0])
      expect(verifyM12WorkflowDriver(db)).toBe(false)
    },
  )

  it('keeps acknowledged artifact history verifiable over two explicit portable projections', () => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    const { taskId, stepIds } = seed(db)
    modelReceipt(db, stepIds[0]!)
    for (const generation of [1, 2]) {
      db.prepare('UPDATE workflow_tasks SET operation_key=?,request_hash=NULL WHERE task_id=?').run(`portable-history:${taskId}`, taskId)
      db.prepare('UPDATE workflow_steps SET invocation_nonce=NULL WHERE task_id=?').run(taskId)
      db.prepare("UPDATE generation_runs SET binding_json='{}' WHERE run_id='run-A'").run()
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=NULL,invocation_nonce='portable-history:attempt-A' WHERE attempt_id='attempt-A'").run()
      db.prepare("UPDATE generation_artifacts SET artifact_json=json_remove(artifact_json,'$.projectId','$.epoch','$.fingerprint') WHERE artifact_id='artifact-A'").run()
      expect({ generation, valid: verifyM12WorkflowDriver(db) }).toEqual({ generation, valid: true })
    }
    db.prepare('UPDATE workflow_effects SET content_hash=? WHERE step_id=?').run('b'.repeat(64), stepIds[0])
    expect(verifyM12WorkflowDriver(db)).toBe(false)
  })

  it('permits projected X values and original project history without granting live execution', () => {
    const db = fixture()
    db.transaction(() => applyM12WorkflowDriver(db))()
    const { taskId } = seed(db)
    db.prepare("UPDATE generation_runs SET binding_json='{}' WHERE run_id='run-A'").run()
    expect(verifyM12WorkflowDriver(db)).toBe(false)
    for (const _generation of [1, 2]) {
      db.prepare('UPDATE workflow_tasks SET operation_key=?,request_hash=NULL WHERE task_id=?').run(`portable-history:${taskId}`, taskId)
      expect(verifyM12WorkflowDriver(db)).toBe(_generation === 2)
      db.prepare('UPDATE workflow_steps SET invocation_nonce=NULL WHERE task_id=?').run(taskId)
      expect(verifyM12WorkflowDriver(db)).toBe(true)
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
