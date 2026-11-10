import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { applyM15PlanningFeedbackBlueprints, M15_PLANNING_FEEDBACK_BLUEPRINTS_SQL, verifyM15PlanningFeedbackBlueprints } from '../m15-planning-feedback-blueprints'
import { migrateSchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const handles: Database.Database[] = []
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })

function fixture() {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 15)
  db.exec("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional author outline')")
  db.exec("INSERT INTO blueprints(chapter_number,title,notes) VALUES(3,'F0 title','F0 notes'),(8,'Unrelated','')")
  return db
}

/** Preserve the installed encodings and a grant that references both old tables. */
function seedHistory(db: Database.Database) {
  for (const version of [1, 2]) {
    const scope = version === 1 ? null : '{"kind":"plot-outline-range","from":3,"to":4}'
    const target = version === 1 ? 'coreOutline' : 'plotOutlineRange'
    db.prepare(`INSERT INTO planning_feedback_bases VALUES(?,?,?, ?,0,?,?,?, ?,100,100,?,?)`)
      .run(`base-${version}`, version, 'project-A', target, 'source-hash', '{"frozen":"original bytes"}', 'F0', 'value-hash', `adoption-${version}`, scope)
    db.prepare(`INSERT INTO planning_feedback_candidates VALUES(?,?,?, ?,NULL,?,'C1',?,'author feedback','[]','{}',100)`)
      .run(`candidate-${version}`, version, 'project-A', `base-${version}`, 'value-hash', 'text-hash')
    db.prepare(`INSERT INTO planning_feedback_adoptions VALUES(?,?,?, ?,?,?,?,?,'full','author-action','C1',?,'F0',?,0,1,100,?)`)
      .run(`adoption-${version}`, version, 'project-A', `base-${version}`, `candidate-${version}`, `nonce-${version}`, 'request-hash', target, 'text-hash', 'value-hash', scope)
  }
  db.exec("INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES('root','root-nonce','{}','{}')")
  db.exec("INSERT INTO generation_runs VALUES('run','root','{}','closed',100,'open-key')")
  db.prepare(`INSERT INTO runtime_feedback_grants VALUES('grant','operation','project-A',1,'planning-feedback-candidate',
    'coreOutline','base-1','candidate-1','run',?,'completed','candidate-1','author-action',100,NULL)`).run('a'.repeat(64))
}

function rows(db: Database.Database) {
  return Object.fromEntries(['blueprints', 'planning_feedback_bases', 'planning_feedback_candidates',
    'planning_feedback_adoptions', 'runtime_feedback_grants', 'generation_roots', 'generation_runs']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

const revision = (db: Database.Database, chapter = 3) => db.prepare(
  'SELECT revision FROM planning_feedback_blueprint_revisions WHERE chapter_number=?').pluck().get(chapter)

describe('M15 blueprint feedback installed migration', () => {
  it('widens only feedback CHECKs, preserves old encodings and grants, and installs through the central lane', () => {
    const db = fixture()
    seedHistory(db)
    const before = rows(db)
    const columns = ['planning_feedback_bases', 'planning_feedback_candidates', 'planning_feedback_adoptions', 'runtime_feedback_grants']
      .map(table => db.prepare(`PRAGMA table_info(${table})`).all())
    expect(() => applyM15PlanningFeedbackBlueprints(db)).toThrow('PLANNING_FEEDBACK_MIGRATION_TRANSACTION_REQUIRED')
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 16)
    expect(rows(db)).toEqual(before)
    expect(['planning_feedback_bases', 'planning_feedback_candidates', 'planning_feedback_adoptions', 'runtime_feedback_grants']
      .map(table => db.prepare(`PRAGMA table_info(${table})`).all())).toEqual(columns)
    expect(db.pragma('user_version', { simple: true })).toBe(16)
    expect(verifyM15PlanningFeedbackBlueprints(db)).toBe(true)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(revision(db)).toBe(0)
    db.prepare(`INSERT INTO planning_feedback_bases
      (base_id,schema_version,project_id,target,source_revision,source_hash,source_json,value,value_hash,created_at,scope_json)
      VALUES('blueprint-base',3,'project-A','blueprintFields',0,'source','{}','{}','value',100,?)`)
      .run('{"kind":"blueprint-fields","chapterNumber":3,"fields":["title"]}')
    expect(() => db.exec("UPDATE planning_feedback_bases SET target='coreOutline' WHERE base_id='blueprint-base'")).toThrow()
    expect(() => db.exec("UPDATE planning_feedback_candidates SET schema_version=4 WHERE candidate_id='candidate-1'")).toThrow()
  })

  it.each([
    ['copy', 'INSERT INTO planning_feedback_candidates_m15 SELECT * FROM planning_feedback_candidates;'],
    ['drop', 'DROP TABLE planning_feedback_bases;'],
    ['rename', 'ALTER TABLE planning_feedback_bases_m15 RENAME TO planning_feedback_bases;'],
  ])('rolls back old facts, grant references, DDL and stamp after %s failure', (_phase, marker) => {
    const db = fixture()
    seedHistory(db)
    const before = rows(db), fingerprint = sqliteSchemaFingerprint(db)
    expect(M15_PLANNING_FEEDBACK_BLUEPRINTS_SQL).toContain(marker)
    const injected = M15_PLANNING_FEEDBACK_BLUEPRINTS_SQL.replace(marker, `${marker}\nSELECT * FROM fictional_missing_m15_table;`)
    expect(() => db.transaction(() => db.exec(injected))()).toThrow()
    expect(rows(db)).toEqual(before)
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.pragma('user_version', { simple: true })).toBe(15)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('rolls back the completed rebuild when verification is rejected and does not stamp direct DDL', () => {
    const db = fixture()
    seedHistory(db)
    const before = rows(db), fingerprint = sqliteSchemaFingerprint(db)
    expect(() => db.transaction(() => {
      applyM15PlanningFeedbackBlueprints(db)
      expect(verifyM15PlanningFeedbackBlueprints(db)).toBe(true)
      db.pragma('user_version=16')
      throw new Error('fictional M15 verification rejection')
    })()).toThrow('fictional M15 verification rejection')
    expect(rows(db)).toEqual(before)
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.pragma('user_version', { simple: true })).toBe(15)
    db.transaction(() => applyM15PlanningFeedbackBlueprints(db))()
    expect(db.pragma('user_version', { simple: true })).toBe(15)
  })

  it.each(['title', 'role', 'purpose', 'key_events', 'characters', 'suspense_hook', 'user_guidance', 'notes', 'notes_updated_at'])('counts actual %s changes and ABA, but not same-value writes or other chapters', column => {
    const db = fixture()
    db.transaction(() => applyM15PlanningFeedbackBlueprints(db))()
    const original = db.prepare(`SELECT ${column} FROM blueprints WHERE chapter_number=3`).pluck().get()
    const changed = column === 'characters' ? '["Fictional character"]' : `${original} changed`
    db.prepare(`UPDATE blueprints SET ${column}=? WHERE chapter_number=3`).run(changed)
    db.prepare(`UPDATE blueprints SET ${column}=? WHERE chapter_number=3`).run(original)
    db.prepare(`UPDATE blueprints SET ${column}=? WHERE chapter_number=3`).run(original)
    db.exec("UPDATE blueprints SET title='Other chapter changed' WHERE chapter_number=8")
    expect(revision(db)).toBe(2)
    expect(revision(db, 8)).toBe(1)
  })

  it('keeps tombstones across deletion/reinsertion and both old/new chapter identities across rename', () => {
    const db = fixture()
    db.transaction(() => applyM15PlanningFeedbackBlueprints(db))()
    db.exec("DELETE FROM blueprints WHERE chapter_number=3; INSERT INTO blueprints(chapter_number,title,notes) VALUES(3,'F0 title','F0 notes')")
    expect(revision(db)).toBe(2)
    db.exec('UPDATE blueprints SET chapter_number=4 WHERE chapter_number=3')
    expect(revision(db)).toBe(3)
    expect(revision(db, 4)).toBe(1)
    db.exec('UPDATE blueprints SET chapter_number=3 WHERE chapter_number=4')
    expect(revision(db)).toBe(4)
    expect(revision(db, 4)).toBe(2)
    db.exec("UPDATE blueprints SET created_at='irrelevant',updated_at='derived' WHERE chapter_number=3")
    expect(revision(db)).toBe(4)
  })

  it('rolls back fences with their facts and refuses safe-integer overflow instead of resetting history', () => {
    const db = fixture()
    db.transaction(() => applyM15PlanningFeedbackBlueprints(db))()
    expect(() => db.transaction(() => { db.exec("UPDATE blueprints SET title='Transient' WHERE chapter_number=3"); throw new Error('rollback') })())
      .toThrow('rollback')
    expect(revision(db)).toBe(0)
    db.prepare('UPDATE planning_feedback_blueprint_revisions SET revision=? WHERE chapter_number=3').run(Number.MAX_SAFE_INTEGER)
    expect(() => db.exec("UPDATE blueprints SET title='Cannot overflow' WHERE chapter_number=3")).toThrow()
    expect(revision(db)).toBe(Number.MAX_SAFE_INTEGER)
    expect(db.prepare('SELECT title FROM blueprints WHERE chapter_number=3').pluck().get()).toBe('F0 title')
    expect(verifyM15PlanningFeedbackBlueprints(db)).toBe(true)
    db.pragma('ignore_check_constraints=ON')
    db.exec('UPDATE planning_feedback_blueprint_revisions SET revision=-1 WHERE chapter_number=3')
    db.pragma('ignore_check_constraints=OFF')
    expect(verifyM15PlanningFeedbackBlueprints(db)).toBe(false)
  })

  it('does not accept a missing fence for an existing blueprint as revision zero', () => {
    const db = fixture()
    db.transaction(() => applyM15PlanningFeedbackBlueprints(db))()
    db.exec('DELETE FROM planning_feedback_blueprint_revisions WHERE chapter_number=3')
    expect(verifyM15PlanningFeedbackBlueprints(db)).toBe(false)
  })
})
