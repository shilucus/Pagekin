import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applyBaselineTables } from '../baseline-schema'
import { M01_GENERATION_SQL } from '../m01-generation-runs'
import { applyM08PlanningFeedback } from '../m08-planning-feedback'
import { applyM09PlanningFeedbackRanges } from '../m09-planning-feedback-ranges'
import { applyM10RuntimeFeedbackGrants, M10_RUNTIME_FEEDBACK_GRANTS_SQL, verifyM10RuntimeFeedbackGrants } from '../m10-runtime-feedback-grants'
import { sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const handles: Database.Database[] = []
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })

/** Isolated DDL fixture; installed-lane registration is independently owned by the central registry. */
function fixture() {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.exec("INSERT INTO project_core(id,project_name,premise) VALUES('main','Fictional migration book','Author F0')")
  db.exec(M01_GENERATION_SQL)
  db.transaction(() => { applyM08PlanningFeedback(db); applyM09PlanningFeedbackRanges(db) })()
  db.pragma('user_version=10')
  db.prepare(`INSERT INTO planning_feedback_bases
    (base_id,schema_version,project_id,target,source_revision,source_hash,source_json,value,value_hash,created_at)
    VALUES('base-A',1,'project-A','premise',0,?,'{}','Author F0',?,1000)`).run('a'.repeat(64), 'b'.repeat(64))
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run('root-A', 'root-key-A', JSON.stringify({ projectId: 'project-A', operation: 'planning-feedback' }), '{}')
  db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-A', 'root-A', '{}', 'running', 1000, 'open-A')
  return db
}

function seedGrant(db: Database.Database) {
  const grantId = randomUUID(), operationKey = randomUUID()
  db.prepare(`INSERT INTO runtime_feedback_grants
    (grant_id,operation_key,project_id,revision,action,target,base_id,parent_candidate_id,run_id,request_hash,state,candidate_id,decision_source,created_at,revoked_at)
    VALUES(?,?,?,1,'planning-feedback-candidate','premise','base-A',NULL,'run-A',?,'active',NULL,'author-action',1000,NULL)`)
    .run(grantId, operationKey, 'project-A', 'c'.repeat(64))
  return { grantId, operationKey }
}

describe('M10 runtime feedback grant DDL', () => {
  it('adds exactly the classified historical fields without rewriting author facts, run history or schema stamps', () => {
    const db = fixture(), beforeCore = db.prepare('SELECT * FROM project_core').all(), beforeRuns = db.prepare('SELECT * FROM generation_runs').all()
    expect(() => applyM10RuntimeFeedbackGrants(db)).toThrow('RUNTIME_FEEDBACK_GRANT_MIGRATION_TRANSACTION_REQUIRED')
    expect(verifyM10RuntimeFeedbackGrants(db)).toBe(false)
    db.transaction(() => applyM10RuntimeFeedbackGrants(db))()
    expect(verifyM10RuntimeFeedbackGrants(db)).toBe(true)
    expect((db.prepare('PRAGMA table_info(runtime_feedback_grants)').all() as { name: string }[]).map(column => column.name)).toEqual([
      'grant_id', 'operation_key', 'project_id', 'revision', 'action', 'target', 'base_id', 'parent_candidate_id', 'run_id',
      'request_hash', 'state', 'candidate_id', 'decision_source', 'created_at', 'revoked_at',
    ])
    expect(db.prepare('SELECT * FROM runtime_feedback_grants').all()).toEqual([])
    expect(db.prepare('SELECT * FROM project_core').all()).toEqual(beforeCore)
    expect(db.prepare('SELECT * FROM generation_runs').all()).toEqual(beforeRuns)
    expect(db.pragma('user_version', { simple: true })).toBe(10)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('rolls back all DDL and caller schema changes when migration or verification fails', () => {
    for (const failure of ['ddl', 'verify']) {
      const db = fixture(), fingerprint = sqliteSchemaFingerprint(db), before = db.prepare('SELECT * FROM generation_runs').all()
      expect(() => db.transaction(() => {
        db.exec(failure === 'ddl' ? `${M10_RUNTIME_FEEDBACK_GRANTS_SQL}\nSELECT * FROM fictional_missing_m10_table;` : M10_RUNTIME_FEEDBACK_GRANTS_SQL)
        db.pragma('user_version=11')
        if (failure === 'verify') {
          expect(verifyM10RuntimeFeedbackGrants(db)).toBe(true)
          throw new Error('fictional M10 verification rejected')
        }
      })()).toThrow()
      expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
      expect(db.pragma('user_version', { simple: true })).toBe(10)
      expect(db.prepare('SELECT * FROM generation_runs').all()).toEqual(before)
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_feedback_grants'").get()).toBeUndefined()
    }
  })

  it('enforces one operation and one run per grant, fixed provenance, eight-field scope and terminal consistency', () => {
    const db = fixture()
    db.transaction(() => applyM10RuntimeFeedbackGrants(db))()
    const row = seedGrant(db)
    const invalid = [
      "action='adopt'", "target='plotOutlineRange'", "decision_source='automation'", "revision=0", 'revision=1.5',
      "request_hash='not-a-hash'", "state='completed'", "state='revoked'", 'revoked_at=1000', 'created_at=-1',
    ]
    for (const assignment of invalid) {
      expect(() => db.prepare(`UPDATE runtime_feedback_grants SET ${assignment} WHERE grant_id=?`).run(row.grantId)).toThrow()
    }
    expect(() => db.prepare(`INSERT INTO runtime_feedback_grants SELECT ?,?,project_id,revision,action,target,base_id,parent_candidate_id,run_id,
      request_hash,state,candidate_id,decision_source,created_at,revoked_at FROM runtime_feedback_grants WHERE grant_id=?`)
      .run(randomUUID(), randomUUID(), row.grantId)).toThrow()
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-B', 'root-A', '{}', 'running', 1000, 'open-B')
    expect(() => db.prepare(`INSERT INTO runtime_feedback_grants SELECT ?,operation_key,project_id,revision,action,target,base_id,parent_candidate_id,'run-B',
      request_hash,state,candidate_id,decision_source,created_at,revoked_at FROM runtime_feedback_grants WHERE grant_id=?`)
      .run(randomUUID(), row.grantId)).toThrow()
    db.prepare("UPDATE runtime_feedback_grants SET state='revoked',revision=2,revoked_at=1001 WHERE grant_id=?").run(row.grantId)
    expect(verifyM10RuntimeFeedbackGrants(db)).toBe(true)
    expect(db.prepare('PRAGMA foreign_key_check(runtime_feedback_grants)').all()).toEqual([])
  })

  it('permits a projected operation history label and original project identity without inferring authority from either', () => {
    const db = fixture()
    db.transaction(() => applyM10RuntimeFeedbackGrants(db))()
    const { grantId } = seedGrant(db)
    db.prepare('UPDATE runtime_feedback_grants SET operation_key=?,project_id=? WHERE grant_id=?')
      .run('history:runtime-feedback:grant-A', 'original-project-id', grantId)
    expect(verifyM10RuntimeFeedbackGrants(db)).toBe(true)
  })

  it.each([
    "revision=1.5", "target='plotOutlineRange'", "decision_source='automation'", "state='revoked'",
    "request_hash='invalid'", 'created_at=-1',
  ])('domain verification fails closed for corrupted %s even when SQLite checks were bypassed', assignment => {
    const db = fixture()
    db.transaction(() => applyM10RuntimeFeedbackGrants(db))()
    const { grantId } = seedGrant(db)
    db.pragma('ignore_check_constraints=ON')
    db.prepare(`UPDATE runtime_feedback_grants SET ${assignment} WHERE grant_id=?`).run(grantId)
    db.pragma('ignore_check_constraints=OFF')
    expect(verifyM10RuntimeFeedbackGrants(db)).toBe(false)
  })

  it('domain verification detects missing referenced history without silently repairing or deleting it', () => {
    const db = fixture()
    db.transaction(() => applyM10RuntimeFeedbackGrants(db))()
    const { grantId } = seedGrant(db)
    db.pragma('foreign_keys=OFF')
    db.prepare('UPDATE runtime_feedback_grants SET base_id=? WHERE grant_id=?').run('missing-base', grantId)
    db.pragma('foreign_keys=ON')
    expect(verifyM10RuntimeFeedbackGrants(db)).toBe(false)
    expect(db.prepare('SELECT base_id FROM runtime_feedback_grants WHERE grant_id=?').pluck().get(grantId)).toBe('missing-base')
  })
})
