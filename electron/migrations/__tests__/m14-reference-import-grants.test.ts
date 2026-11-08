import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applyBaselineTables } from '../baseline-schema'
import { applyM14ReferenceImportGrants, M14_REFERENCE_IMPORT_GRANTS_SQL, verifyM14ReferenceImportGrants } from '../m14-reference-import-grants'
import { sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const handles: Database.Database[] = []
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })

/** DDL fixture only. The central registry owns installed-lane progression. */
function fixture() {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.exec("INSERT INTO project_core(id,project_name,premise) VALUES('main','Fictional grant migration','Author F0')")
  db.prepare(`INSERT INTO import_runs
    (id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count)
    VALUES('import-A','import-A','import:reference:import-A',?,?,'en-US',1,1)`).run('a'.repeat(64), 'b'.repeat(64))
  db.pragma('user_version=14')
  return db
}

function seed(db: Database.Database) {
  const grantId = randomUUID(), operationKey = randomUUID()
  db.prepare(`INSERT INTO reference_import_grants VALUES(?,?,?,'import-A',1,'reference-import-v1',?,?,'active','author-action',1000,NULL,NULL)`)
    .run(grantId, operationKey, 'project-A', 'b'.repeat(64), 'c'.repeat(64))
  return { grantId, operationKey }
}

describe('M14 reference import grant DDL', () => {
  it('adds exactly thirteen classified fields without changing previous facts, imports or registry stamp', () => {
    const db = fixture(), core = db.prepare('SELECT * FROM project_core').all(), runs = db.prepare('SELECT * FROM import_runs').all()
    expect(() => applyM14ReferenceImportGrants(db)).toThrow('MIGRATION_TRANSACTION_REQUIRED')
    expect(verifyM14ReferenceImportGrants(db)).toBe(false)
    db.transaction(() => applyM14ReferenceImportGrants(db))()
    expect(verifyM14ReferenceImportGrants(db)).toBe(true)
    expect((db.prepare('PRAGMA table_info(reference_import_grants)').all() as { name: string }[]).map(column => column.name)).toEqual([
      'grant_id', 'operation_key', 'project_id', 'import_run_id', 'revision', 'action', 'manifest_fingerprint',
      'request_hash', 'state', 'decision_source', 'created_at', 'completed_at', 'revoked_at',
    ])
    expect(db.prepare('SELECT * FROM project_core').all()).toEqual(core)
    expect(db.prepare('SELECT * FROM import_runs').all()).toEqual(runs)
    expect(db.pragma('user_version', { simple: true })).toBe(14)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each(['ddl', 'verify'])('rolls back DDL and the caller stamp when %s fails', failure => {
    const db = fixture(), fingerprint = sqliteSchemaFingerprint(db), runs = db.prepare('SELECT * FROM import_runs').all()
    expect(() => db.transaction(() => {
      db.exec(M14_REFERENCE_IMPORT_GRANTS_SQL)
      db.pragma('user_version=15')
      if (failure === 'ddl') db.exec('SELECT * FROM fictional_missing_m14_table')
      else { expect(verifyM14ReferenceImportGrants(db)).toBe(true); throw new Error('fictional verification failure') }
    })()).toThrow()
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.pragma('user_version', { simple: true })).toBe(14)
    expect(db.prepare('SELECT * FROM import_runs').all()).toEqual(runs)
  })

  it('keeps a unique operation and only one active grant per import while preserving revoked history', () => {
    const db = fixture()
    db.transaction(() => applyM14ReferenceImportGrants(db))()
    const grant = seed(db)
    const duplicate = db.prepare(`INSERT INTO reference_import_grants
      SELECT ?,?,project_id,import_run_id,revision,action,manifest_fingerprint,request_hash,state,decision_source,created_at,completed_at,revoked_at
      FROM reference_import_grants WHERE grant_id=?`)
    expect(() => duplicate.run(randomUUID(), randomUUID(), grant.grantId)).toThrow()
    db.prepare("UPDATE reference_import_grants SET state='revoked',revision=2,revoked_at=1001 WHERE grant_id=?").run(grant.grantId)
    expect(() => duplicate.run(randomUUID(), grant.operationKey, grant.grantId)).toThrow()
    seed(db)
    expect(db.prepare('SELECT COUNT(*) FROM reference_import_grants').pluck().get()).toBe(2)
    expect(verifyM14ReferenceImportGrants(db)).toBe(true)
  })

  it.each([
    "action='author-import'", "decision_source='automation'", 'revision=0', 'revision=1.5', "state='unknown'",
    "state='completed'", "state='revoked'", 'completed_at=1001', 'revoked_at=1001', 'created_at=-1',
    "manifest_fingerprint='invalid'", "request_hash='A'", 'request_hash=NULL',
    "state='revoked',revision=2,revoked_at=-1", "state='completed',completed_at=-1",
  ])('SQLite refuses invalid state or scope %s', assignment => {
    const db = fixture()
    db.transaction(() => applyM14ReferenceImportGrants(db))()
    const { grantId } = seed(db)
    expect(() => db.prepare(`UPDATE reference_import_grants SET ${assignment} WHERE grant_id=?`).run(grantId)).toThrow()
    expect(verifyM14ReferenceImportGrants(db)).toBe(true)
  })

  it('permits paired NULL history and collision-safe historical labels without calling them current authority', () => {
    const db = fixture()
    db.transaction(() => applyM14ReferenceImportGrants(db))()
    const { grantId } = seed(db)
    db.prepare('UPDATE reference_import_grants SET operation_key=?,project_id=?,manifest_fingerprint=NULL,request_hash=NULL WHERE grant_id=?')
      .run('history:reference-import:grant-A', 'original-project', grantId)
    expect(verifyM14ReferenceImportGrants(db)).toBe(true)
    db.prepare("UPDATE reference_import_grants SET state='completed',completed_at=1001 WHERE grant_id=?").run(grantId)
    expect(verifyM14ReferenceImportGrants(db)).toBe(true)
  })

  it.each([
    'revision=1.5', "action='other'", "decision_source='automation'", "state='revoked'", 'created_at=-1',
    "request_hash='invalid'", 'manifest_fingerprint=NULL', "state='completed',completed_at=-1",
  ])('domain verifier detects bypassed checks for %s', assignment => {
    const db = fixture()
    db.transaction(() => applyM14ReferenceImportGrants(db))()
    const { grantId } = seed(db)
    db.pragma('ignore_check_constraints=ON')
    db.prepare(`UPDATE reference_import_grants SET ${assignment} WHERE grant_id=?`).run(grantId)
    db.pragma('ignore_check_constraints=OFF')
    expect(verifyM14ReferenceImportGrants(db)).toBe(false)
  })

  it('rejects missing import history and unknown fields instead of repairing or discarding them', () => {
    const db = fixture()
    db.transaction(() => applyM14ReferenceImportGrants(db))()
    const { grantId } = seed(db)
    db.pragma('foreign_keys=OFF')
    db.prepare('UPDATE reference_import_grants SET import_run_id=? WHERE grant_id=?').run('missing-import', grantId)
    db.pragma('foreign_keys=ON')
    expect(verifyM14ReferenceImportGrants(db)).toBe(false)
    db.prepare('UPDATE reference_import_grants SET import_run_id=? WHERE grant_id=?').run('import-A', grantId)
    db.exec('ALTER TABLE reference_import_grants ADD COLUMN unknown_authority TEXT')
    expect(verifyM14ReferenceImportGrants(db)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) FROM reference_import_grants').pluck().get()).toBe(1)
  })
})
