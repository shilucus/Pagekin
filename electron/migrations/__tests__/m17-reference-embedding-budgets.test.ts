import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { applyM17ReferenceEmbeddingBudgets, REFERENCE_IMPORT_MANIFEST_CHAPTER_FIELDS,
  verifyM17ReferenceEmbeddingBudgets } from '../m17-reference-embedding-budgets'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { REFERENCE_EMBEDDING_BUDGET_FIELDS, REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION } from '../../services/reference-embedding-budget-contract'
import { referenceEmbeddingDispatchId } from '../../services/reference-embedding-dispatch-contract'

const handles: Database.Database[] = []
const hash = 'a'.repeat(64)
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })

function run(db: Database.Database, id: string, root = id, stage = 'prepared', epoch = 0, purpose = 'reference') {
  db.prepare(`INSERT INTO import_runs
    (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,execution_epoch,total_chapters,manifest_chapter_count)
    VALUES(?,?,?,?,?,?,'en-US',?,'ready',?,1,1)`).run(id, purpose, root, `import:${purpose}:${id}`, hash, hash, stage, epoch)
}

function fixture(donor = false) {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  if (donor) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
    db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
    db.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
    db.exec('DROP TABLE characters_without_avatar')
  }
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 17)
  db.exec("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional author outline')")
  run(db, 'reference-root')
  return db
}

function oldRows(db: Database.Database) {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('reference_embedding_budgets','reference_import_manifest_chapters') ORDER BY name")
    .pluck().all() as string[]).map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]))
}

function migrated(db: Database.Database) { migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 18) }
function ready(db: Database.Database) {
  db.prepare(`INSERT INTO reference_embedding_budgets VALUES(?,?,?,100,0,1,2,225000,0,0,NULL,'ready')`)
    .run('reference-root', hash, REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION)
}

function chapter(db: Database.Database, runId: string, number = 1, sourceId = 'fictional-source', sourceNumber = number) {
  db.prepare(`INSERT INTO import_run_chapters
    (run_id,chapter_number,source_id,source_chapter_number,title,content_fingerprint,content_size,content_snapshot)
    VALUES(?,?,?,?,'Fictional chapter',?,9,'Fictional')`).run(runId, number, sourceId, sourceNumber, hash)
}

function binding(db: Database.Database, owner: string, snapshot = owner, number = 1, snapshotNumber = number) {
  db.prepare(`INSERT INTO reference_import_manifest_chapters VALUES(?,?,?,?,'fictional-source',?)`)
    .run(owner, number, snapshot, snapshotNumber, number)
}

describe('M17 reference embedding budgets', () => {
  it.each(['standard', 'donor'] as const)('preserves every schema17 %s row and recognizes both source fingerprints', variant => {
    const db = fixture(variant === 'donor'), before = oldRows(db), fingerprint = sqliteSchemaFingerprint(db)
    expect(getDesktopMigrationRegistry().recognizedSchemas.filter(schema => schema.version === 17)).toHaveLength(2)
    expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 17).fingerprint).toBe(fingerprint)
    expect(() => applyM17ReferenceEmbeddingBudgets(db)).toThrow('MIGRATION_TRANSACTION_REQUIRED')
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(false)
    migrated(db)
    expect(oldRows(db)).toEqual(before)
    expect(db.pragma('user_version', { simple: true })).toBe(18)
    expect((db.prepare('PRAGMA table_info(reference_embedding_budgets)').all() as { name: string }[]).map(row => row.name))
      .toEqual(REFERENCE_EMBEDDING_BUDGET_FIELDS)
    expect((db.prepare('PRAGMA table_info(reference_import_manifest_chapters)').all() as { name: string }[]).map(row => row.name))
      .toEqual(REFERENCE_IMPORT_MANIFEST_CHAPTER_FIELDS)
    expect(db.prepare('SELECT * FROM reference_embedding_budgets').all()).toEqual([])
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it.each(['epoch', 'stage', 'active-grant', 'completed-grant', 'revoked-grant', 'dispatch', 'receipt'] as const)(
    'marks the entire old lineage unknown for %s evidence without inventing zero consumption', mode => {
    const db = fixture()
    run(db, 'descendant', 'reference-root')
    if (mode === 'epoch') db.exec("UPDATE import_runs SET execution_epoch=1 WHERE id='descendant'")
    else if (mode === 'stage') db.exec("UPDATE import_runs SET stage='knowledge' WHERE id='descendant'")
    else if (mode.endsWith('-grant')) {
      const state = mode.replace('-grant', '')
      db.prepare(`INSERT INTO reference_import_grants VALUES(?,?,?,?,?,'reference-import-v1',?,?,?,'author-action',100,?,?)`)
        .run(randomUUID(), randomUUID(), 'fictional-project', 'descendant', state === 'revoked' ? 2 : 1, hash, hash, state,
          state === 'completed' ? 101 : null, state === 'revoked' ? 101 : null)
    } else if (mode === 'dispatch') {
      db.prepare(`INSERT INTO import_reference_documents
        (document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state)
        VALUES(?,?,?,?,1,'reference','prepared')`).run(hash, hash, hash, hash)
      db.prepare(`INSERT INTO reference_embedding_dispatches VALUES(?,'descendant',?,0,1,'dispatch_marked',NULL,100,NULL)`)
        .run(referenceEmbeddingDispatchId(hash, 0), hash)
    } else {
      db.prepare(`INSERT INTO import_run_chapters(run_id,chapter_number,content_fingerprint,content_size,content_snapshot)
        VALUES('descendant',1,?,9,'Fictional')`).run(hash)
      db.prepare(`INSERT INTO import_run_knowledge_receipts
        (run_id,chapter_number,purpose,source_id,source_chapter_number,content_fingerprint,document_id,state)
        VALUES('descendant',1,'reference','fictional-source',1,?,?,'committed')`).run(hash, hash)
    }
    const before = oldRows(db)
    migrated(db)
    expect(oldRows(db)).toEqual(before)
    const rows = db.prepare('SELECT * FROM reference_embedding_budgets').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(Object.fromEntries(REFERENCE_EMBEDDING_BUDGET_FIELDS.map(field => [field,
      field === 'root_run_id' ? 'reference-root' : field === 'policy_version' ? REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION
        : field === 'state' ? 'legacy_unbudgeted' : null])))
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it('does not freeze never-started parsing/prepared lineages or author-manuscript runs', () => {
    const db = fixture()
    run(db, 'parsing-root', undefined, 'parsing')
    db.prepare("UPDATE import_runs SET manifest_fingerprint=? WHERE id='parsing-root'").run('0'.repeat(64))
    run(db, 'author-root', undefined, 'knowledge', 1, 'author-manuscript')
    migrated(db)
    expect(db.prepare('SELECT * FROM reference_embedding_budgets').all()).toEqual([])
  })

  it.each(['DDL', 'verification'] as const)('rolls back %s and preserves all old rows and the source version', failure => {
    const db = fixture(), before = oldRows(db), fingerprint = sqliteSchemaFingerprint(db)
    expect(() => db.transaction(() => {
      applyM17ReferenceEmbeddingBudgets(db)
      db.pragma('user_version=18')
      if (failure === 'DDL') db.exec('SELECT * FROM fictional_missing_budget_table')
      else { expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true); throw new Error('fictional verification failure') }
    })()).toThrow()
    expect(oldRows(db)).toEqual(before)
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.pragma('user_version', { simple: true })).toBe(17)
    migrated(db)
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it.each([
    "manifest_fingerprint='bad'", "policy_version='unknown'", 'initial_chunk_size=99', 'initial_chunk_size=4001',
    'initial_chunk_overlap=-1', 'initial_chunk_overlap=100', 'initial_batch_size=0', 'initial_batch_size=51',
    'request_limit=0', 'request_limit=1.5', 'active_limit_ms=1', 'spent_requests=-1', 'spent_requests=3',
    'active_elapsed_ms=-1', 'active_elapsed_ms=0.5', 'active_since_ms=-1', 'active_since_ms=0.5',
    "state='legacy_unbudgeted'", "state='unknown'", 'spent_requests=NULL', 'request_limit=9007199254740992',
  ])('SQLite refuses malformed state/plan/accounting %s', assignment => {
    const db = fixture()
    migrated(db); ready(db)
    expect(() => db.exec(`UPDATE reference_embedding_budgets SET ${assignment}`)).toThrow()
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it('retains known consumption in recovery_unknown and admits only NULL-neutralized portable manifest history', () => {
    const db = fixture()
    migrated(db); ready(db)
    db.exec("UPDATE reference_embedding_budgets SET spent_requests=2,active_elapsed_ms=225001,active_since_ms=100,state='recovery_unknown'")
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
    db.exec('UPDATE reference_embedding_budgets SET manifest_fingerprint=NULL')
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
    expect(() => db.exec("DELETE FROM import_runs WHERE id='reference-root'")).toThrow()
  })

  it.each(['column', 'row', 'orphan', 'descendant-root'] as const)('read-only verification rejects %s after constraint bypass', mode => {
    const db = fixture()
    migrated(db); ready(db)
    if (mode === 'column') db.exec('ALTER TABLE reference_embedding_budgets ADD COLUMN private_payload TEXT')
    else if (mode === 'row') {
      db.pragma('ignore_check_constraints=ON')
      db.exec('UPDATE reference_embedding_budgets SET spent_requests=-1')
      db.pragma('ignore_check_constraints=OFF')
    } else if (mode === 'orphan') {
      db.pragma('foreign_keys=OFF')
      db.exec("UPDATE reference_embedding_budgets SET root_run_id='missing'")
      db.pragma('foreign_keys=ON')
    } else {
      run(db, 'descendant', 'reference-root')
      db.exec("UPDATE reference_embedding_budgets SET root_run_id='descendant'")
    }
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(false)
  })

  it('backfills only known valid own snapshots, retaining sparse numbers without inventing duplicate membership', () => {
    const db = fixture()
    chapter(db, 'reference-root', 2)
    chapter(db, 'reference-root', 7)
    chapter(db, 'reference-root', 9, '', 0)
    run(db, 'author-root', undefined, 'prepared', 0, 'author-manuscript')
    chapter(db, 'author-root')
    const before = oldRows(db)
    migrated(db)
    expect(oldRows(db)).toEqual(before)
    expect(db.prepare('SELECT * FROM reference_import_manifest_chapters ORDER BY chapter_number').all()).toEqual([
      { import_run_id: 'reference-root', chapter_number: 2, snapshot_run_id: 'reference-root', snapshot_chapter_number: 2, source_id: 'fictional-source', source_chapter_number: 2 },
      { import_run_id: 'reference-root', chapter_number: 7, snapshot_run_id: 'reference-root', snapshot_chapter_number: 7, source_id: 'fictional-source', source_chapter_number: 7 },
    ])
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it.each(['self-reference', 'empty-parsing'] as const)('allows deletion of an otherwise removable %s owner', mode => {
    const db = fixture()
    if (mode === 'self-reference') chapter(db, 'reference-root')
    else db.exec("UPDATE import_runs SET stage='parsing' WHERE id='reference-root'")
    migrated(db)
    expect(() => db.exec("DELETE FROM import_runs WHERE id='reference-root'")).not.toThrow()
    expect(db.prepare('SELECT * FROM reference_import_manifest_chapters').all()).toEqual([])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it('protects snapshots referenced by another root while cascading only the deleted owner bindings', () => {
    const db = fixture()
    chapter(db, 'reference-root')
    run(db, 'other-root')
    migrated(db)
    binding(db, 'other-root', 'reference-root')
    expect(() => db.exec("DELETE FROM import_runs WHERE id='reference-root'")).toThrow()
    expect(db.prepare('SELECT COUNT(*) FROM reference_import_manifest_chapters').pluck().get()).toBe(2)
    expect(() => db.exec("DELETE FROM import_runs WHERE id='other-root'")).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) FROM import_run_chapters').pluck().get()).toBe(1)
    expect(() => db.exec("DELETE FROM import_runs WHERE id='reference-root'")).not.toThrow()
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it('keeps logical global numbering independent of an exact old snapshot primary key', () => {
    const db = fixture()
    chapter(db, 'reference-root', 1)
    run(db, 'other-root')
    migrated(db)
    binding(db, 'other-root', 'reference-root', 2, 1)
    expect(db.prepare(`SELECT b.chapter_number,b.snapshot_chapter_number,c.chapter_number AS actual_snapshot_number
      FROM reference_import_manifest_chapters b JOIN import_run_chapters c
      ON c.run_id=b.snapshot_run_id AND c.chapter_number=b.snapshot_chapter_number
      WHERE b.import_run_id='other-root'`).get()).toEqual({ chapter_number: 2, snapshot_chapter_number: 1, actual_snapshot_number: 1 })
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
    expect(() => db.exec("DELETE FROM import_runs WHERE id='reference-root'")).toThrow()
    expect(() => db.exec("DELETE FROM import_runs WHERE id='other-root'")).not.toThrow()
    expect(() => db.exec("DELETE FROM import_runs WHERE id='reference-root'")).not.toThrow()
  })

  it('retains the original logical source identity when legacy adoption changes snapshot aliases', () => {
    const db = fixture()
    chapter(db, 'reference-root')
    migrated(db)
    db.prepare('UPDATE import_run_chapters SET source_id=?,source_chapter_number=12').run(randomUUID())
    expect(db.prepare('SELECT source_id,source_chapter_number FROM reference_import_manifest_chapters').get())
      .toEqual({ source_id: 'fictional-source', source_chapter_number: 1 })
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it.each(['missing-owner', 'missing-snapshot', 'wrong-chapter'] as const)('enforces both exact binding foreign keys for %s', mode => {
    const db = fixture()
    chapter(db, 'reference-root')
    migrated(db)
    run(db, 'other-root')
    expect(() => binding(db, mode === 'missing-owner' ? 'missing' : 'other-root',
      mode === 'missing-snapshot' ? 'missing' : 'reference-root', mode === 'wrong-chapter' ? 2 : 1)).toThrow()
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it.each(['chapter_number=0', 'chapter_number=1.5', 'chapter_number=9007199254740992',
    'snapshot_chapter_number=0', 'snapshot_chapter_number=1.5', 'snapshot_chapter_number=9007199254740992',
    'source_chapter_number=0', 'source_chapter_number=1.5', 'source_chapter_number=9007199254740992', "source_id=''"])(
    'refuses malformed manifest binding %s', assignment => {
    const db = fixture()
    chapter(db, 'reference-root')
    migrated(db)
    expect(() => db.exec(`UPDATE reference_import_manifest_chapters SET ${assignment}`)).toThrow()
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(true)
  })

  it.each(['column', 'row', 'orphan', 'author-owner', 'author-snapshot'] as const)(
    'read-only binding verification rejects %s after bypass', mode => {
    const db = fixture()
    chapter(db, 'reference-root')
    migrated(db)
    if (mode === 'column') db.exec('ALTER TABLE reference_import_manifest_chapters ADD COLUMN private_payload TEXT')
    else if (mode === 'row') {
      db.pragma('ignore_check_constraints=ON')
      db.exec("UPDATE reference_import_manifest_chapters SET source_id=''")
      db.pragma('ignore_check_constraints=OFF')
    } else if (mode === 'orphan') {
      db.pragma('foreign_keys=OFF')
      db.exec("UPDATE reference_import_manifest_chapters SET snapshot_run_id='missing'")
      db.pragma('foreign_keys=ON')
    } else {
      run(db, 'author-root', undefined, 'prepared', 0, 'author-manuscript')
      chapter(db, 'author-root')
      db.exec(`UPDATE reference_import_manifest_chapters SET ${mode === 'author-owner' ? 'import_run_id' : 'snapshot_run_id'}='author-root'`)
    }
    expect(verifyM17ReferenceEmbeddingBudgets(db)).toBe(false)
  })
})
