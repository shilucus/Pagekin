import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { applyM18ImportQuery, verifyM18ImportQuery } from '../m18-import-query'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { IMPORT_QUERY_PLAN_FIELDS, IMPORT_QUERY_TOPIC_FIELDS, importQueryHash, importQueryId } from '../../services/import-query-contract'
import { getImportInferenceTopics } from '../../../src/shared/import-inference-materials'

describe('M18 import query schema', () => {
  it.each(['standard', 'donor'] as const)('upgrades schema18 %s without inventing query history', variant => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys=ON')
      db.transaction(() => initializeLegacyBaselineSchema(db))()
      if (variant === 'donor') {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
        db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
        db.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
        db.exec('DROP TABLE characters_without_avatar')
      }
      const adapter = new SqliteSchemaAdapter(db), registry = getDesktopMigrationRegistry()
      migrateSchema(adapter, registry, 18)
      db.exec("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional author outline')")
      const fingerprint = sqliteSchemaFingerprint(db)
      expect(verifySchema(adapter, registry, 18).fingerprint).toBe(fingerprint)
      expect(() => applyM18ImportQuery(db)).toThrow('MIGRATION_TRANSACTION_REQUIRED')
      expect(() => db.transaction(() => { applyM18ImportQuery(db); throw new Error('rollback') })()).toThrow('rollback')
      expect(sqliteSchemaFingerprint(db)).toBe(fingerprint)
      expect(migrateSchema(adapter, registry, 19).completedSteps).toEqual(['M18'])
      expect(verifyM18ImportQuery(db)).toBe(true)
      expect(db.prepare('SELECT * FROM import_query_plans').all()).toEqual([])
      expect(db.prepare('SELECT * FROM import_query_topics').all()).toEqual([])
      expect(db.prepare('SELECT core_outline FROM project_core WHERE id=?').pluck().get('main')).toBe('Fictional author outline')
      expect((db.prepare('PRAGMA table_info(import_query_plans)').all() as Array<{ name: string }>).map(row => row.name)).toEqual(IMPORT_QUERY_PLAN_FIELDS)
      expect((db.prepare('PRAGMA table_info(import_query_topics)').all() as Array<{ name: string }>).map(row => row.name)).toEqual(IMPORT_QUERY_TOPIC_FIELDS)
      expect(verifySchema(adapter, registry, 19).version).toBe(19)
    } finally { db.close() }
  })

  it('validates the complete portable topic even when its original receipt fingerprint is null', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys=ON')
      db.transaction(() => initializeLegacyBaselineSchema(db))()
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 19)
      db.prepare(`INSERT INTO import_runs
        (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,total_chapters,manifest_chapter_count)
        VALUES('root','reference','root','','','','en-US','prepared','ready',1,1)`).run()
      db.prepare("INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES('action','key','{}','{}')").run()
      db.prepare("INSERT INTO generation_runs VALUES('run','action','{}','running',1,'open')").run()
      db.prepare("INSERT INTO import_query_plans VALUES('root','run','action',NULL,NULL,NULL,'ready',1)").run()
      const insert = db.prepare('INSERT INTO import_query_topics VALUES(?,?,?,?,?,?,?,?,?,?)')
      for (const key of ['worldview', 'protagonist', 'conflict', 'style'] as const) {
        insert.run(importQueryId('root', key), 'root', key, key === 'worldview' ? 'completed' : 'prepared',
          key === 'worldview' ? 1 : null, key === 'worldview' ? JSON.stringify({ kind: 'http_failed', httpStatus: 503 }) : null,
          key === 'worldview' ? 2 : null, key === 'worldview' ? 3 : null,
          key === 'worldview' ? JSON.stringify({ version: 1, state: 'unavailable' }) : null, null)
      }
      expect(verifyM18ImportQuery(db)).toBe(true)
      const update = db.prepare("UPDATE import_query_topics SET outcome_json=?,receipt_json=? WHERE topic_key='worldview'")
      update.run(JSON.stringify({ kind: 'transport_unknown' }), JSON.stringify({ version: 1, state: 'unavailable' }))
      expect(verifyM18ImportQuery(db)).toBe(false)
      update.run(JSON.stringify({ kind: 'http_failed', httpStatus: 503 }), JSON.stringify({ version: 1, state: 'unavailable', secret: 'x' }))
      expect(verifyM18ImportQuery(db)).toBe(false)
      update.run(JSON.stringify({ kind: 'http_failed', httpStatus: 200 }), JSON.stringify({ version: 1, state: 'unavailable' }))
      expect(verifyM18ImportQuery(db)).toBe(false)
      update.run(JSON.stringify({ kind: 'http_failed', httpStatus: 503 }), JSON.stringify({ version: 1, state: 'unavailable' }))
      const binding = JSON.stringify({ version: 1, slot: { stage: 'global', batchId: 'global', writingLanguage: 'en-US' },
        contextFingerprint: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64),
        topics: getImportInferenceTopics('en-US').map(({ key, query, topK }) => ({ key, query, topK })) })
      db.prepare('UPDATE import_query_plans SET manifest_fingerprint=?,binding_json=?,binding_fingerprint=?')
        .run('c'.repeat(64), binding, importQueryHash(binding))
      expect(verifyM18ImportQuery(db)).toBe(false)
      db.prepare('UPDATE import_query_plans SET manifest_fingerprint=NULL,binding_json=NULL,binding_fingerprint=NULL').run()
      expect(verifyM18ImportQuery(db)).toBe(true)
      db.pragma('ignore_check_constraints=ON')
      db.prepare("UPDATE import_query_topics SET physical_closed_at_ms=-1 WHERE topic_key='worldview'").run()
      expect(verifyM18ImportQuery(db)).toBe(false)
    } finally { db.close() }
  })
})
