import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { applyM16ReferenceEmbeddingDispatches, M16_REFERENCE_EMBEDDING_DISPATCHES_SQL, verifyM16ReferenceEmbeddingDispatches } from '../m16-reference-embedding-dispatches'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { REFERENCE_EMBEDDING_DISPATCH_FIELDS, referenceEmbeddingDispatchId } from '../../services/reference-embedding-dispatch-contract'

const handles: Database.Database[] = [], documentId = 'a'.repeat(64)
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })

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
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 16)
  db.exec("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional author outline')")
  db.exec("INSERT INTO blueprints(chapter_number,title,notes) VALUES(3,'Fictional blueprint','Author notes')")
  db.prepare(`INSERT INTO import_runs
    (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,total_chapters,manifest_chapter_count)
    VALUES('run-A','reference','run-A','import:reference:run-A',?,?,'en-US','knowledge','running',1,1)`)
    .run('b'.repeat(64), 'c'.repeat(64))
  db.prepare(`INSERT INTO import_reference_documents
    (document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state)
    VALUES(?,?,?,?,1,'reference','prepared')`).run(documentId, documentId, 'd'.repeat(64), 'e'.repeat(64))
  return db
}

function oldRows(db: Database.Database) {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'reference_embedding_dispatches' ORDER BY name")
    .pluck().all() as string[]).map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]))
}

function mark(db: Database.Database) {
  db.prepare("INSERT INTO reference_embedding_dispatches VALUES(?,'run-A',?,0,2,'dispatch_marked',NULL,100,NULL)")
    .run(referenceEmbeddingDispatchId(documentId, 0), documentId)
}

describe('M16 reference embedding dispatch migration', () => {
  it.each(['standard', 'donor'] as const)('retains recognized schema16 %s and every old row through central migration', variant => {
    const db = fixture(variant === 'donor'), before = oldRows(db), fingerprint = sqliteSchemaFingerprint(db)
    expect(getDesktopMigrationRegistry().recognizedSchemas.filter(schema => schema.version === 16)).toHaveLength(2)
    expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 16).fingerprint).toBe(fingerprint)
    expect(() => applyM16ReferenceEmbeddingDispatches(db)).toThrow('MIGRATION_TRANSACTION_REQUIRED')
    expect(verifyM16ReferenceEmbeddingDispatches(db)).toBe(false)
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 17)
    expect(oldRows(db)).toEqual(before)
    expect(db.pragma('user_version', { simple: true })).toBe(17)
    expect((db.prepare('PRAGMA table_info(reference_embedding_dispatches)').all() as { name: string }[]).map(row => row.name))
      .toEqual(REFERENCE_EMBEDDING_DISPATCH_FIELDS)
    expect(db.prepare('SELECT * FROM reference_embedding_dispatches').all()).toEqual([])
    expect(verifyM16ReferenceEmbeddingDispatches(db)).toBe(true)
    expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 17).version).toBe(17)
  })

  it.each(['DDL', 'verification'] as const)('rolls back %s failure without changing schema16 facts or stamp', failure => {
    const db = fixture(), before = oldRows(db), fingerprint = sqliteSchemaFingerprint(db)
    expect(() => db.transaction(() => {
      db.exec(M16_REFERENCE_EMBEDDING_DISPATCHES_SQL)
      db.pragma('user_version=17')
      if (failure === 'DDL') db.exec('SELECT * FROM fictional_missing_dispatch_table')
      else { expect(verifyM16ReferenceEmbeddingDispatches(db)).toBe(true); throw new Error('fictional verification rejection') }
    })()).toThrow()
    expect(oldRows(db)).toEqual(before)
    expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
    expect(db.pragma('user_version', { simple: true })).toBe(16)
    db.transaction(() => applyM16ReferenceEmbeddingDispatches(db))()
    expect(db.pragma('user_version', { simple: true })).toBe(16)
  })

  it.each([
    "dispatch_id='replacement'", "document_id='invalid'", 'batch_ordinal=-1', 'batch_ordinal=0.5',
    'input_count=0', 'input_count=1.5', 'input_count=9007199254740992', "state='unknown'", 'marked_at=-1',
    'marked_at=0.5', 'settled_at=101', 'http_status=200', "state='response_received',settled_at=101",
    "state='response_invalid',http_status=400,settled_at=101", "state='http_failed',http_status=200,settled_at=101",
    "state='http_failed',http_status=99,settled_at=101", "state='http_failed',http_status=600,settled_at=101",
    "state='transport_unknown',http_status=200,settled_at=101", "state='transport_unknown',settled_at=-1",
  ])('SQLite refuses malformed state/identity combination %s', assignment => {
    const db = fixture()
    db.transaction(() => applyM16ReferenceEmbeddingDispatches(db))()
    mark(db)
    expect(() => db.exec(`UPDATE reference_embedding_dispatches SET ${assignment}`)).toThrow()
    expect(verifyM16ReferenceEmbeddingDispatches(db)).toBe(true)
  })

  it.each([
    ['response_received', 200], ['response_received', 299], ['response_invalid', 201],
    ['http_failed', 100], ['http_failed', 300], ['http_failed', 599], ['transport_unknown', null],
  ] as const)('preserves factual %s status %s, including a clock adjustment', (state, status) => {
    const db = fixture()
    db.transaction(() => applyM16ReferenceEmbeddingDispatches(db))()
    mark(db)
    db.prepare('UPDATE reference_embedding_dispatches SET state=?,http_status=?,settled_at=99').run(state, status)
    expect(verifyM16ReferenceEmbeddingDispatches(db)).toBe(true)
  })

  it('keeps stable document/batch identity and refuses parent deletion rather than erasing unknown dispatches', () => {
    const db = fixture()
    db.transaction(() => applyM16ReferenceEmbeddingDispatches(db))()
    mark(db)
    db.exec("UPDATE reference_embedding_dispatches SET state='transport_unknown',settled_at=101")
    expect(() => mark(db)).toThrow()
    expect(() => db.exec("DELETE FROM import_runs WHERE id='run-A'")).toThrow()
    expect(() => db.prepare('DELETE FROM import_reference_documents WHERE document_id=?').run(documentId)).toThrow()
    expect(db.prepare('SELECT state FROM reference_embedding_dispatches').pluck().all()).toEqual(['transport_unknown'])
    expect(verifyM16ReferenceEmbeddingDispatches(db)).toBe(true)
  })

  it.each(['unknown-column', 'bad-row', 'orphan'] as const)('read-only verifier rejects %s after DDL/constraint bypass', mode => {
    const db = fixture()
    db.transaction(() => applyM16ReferenceEmbeddingDispatches(db))()
    mark(db)
    if (mode === 'unknown-column') db.exec('ALTER TABLE reference_embedding_dispatches ADD COLUMN private_payload TEXT')
    else if (mode === 'bad-row') {
      db.pragma('ignore_check_constraints=ON')
      db.exec("UPDATE reference_embedding_dispatches SET dispatch_id='forged',input_count=0")
      db.pragma('ignore_check_constraints=OFF')
    } else {
      db.pragma('foreign_keys=OFF')
      db.exec("UPDATE reference_embedding_dispatches SET import_run_id='missing-run'")
      db.pragma('foreign_keys=ON')
    }
    expect(verifyM16ReferenceEmbeddingDispatches(db)).toBe(false)
  })
})
