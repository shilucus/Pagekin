import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { applyM08PlanningFeedback } from '../m08-planning-feedback'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
type Db = import('better-sqlite3').Database

function fixture(donor = false): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  if (donor) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").pluck().get() as string
    db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
    db.exec(sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
    db.exec('DROP TABLE characters_without_avatar')
  }
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
  db.prepare("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fictional project','A')").run()
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('Fictional author manuscript')
  return db
}

const revision = (db: Db): number => db.prepare('SELECT revision FROM planning_feedback_core_revision WHERE id=1').pluck().get() as number

describe('installed M08 planning feedback lane', () => {
  it.each([false, true])('upgrades the exact v8 schema and preserves author facts (donor=%s)', donor => {
    const db = fixture(donor)
    try {
      const before = { core: db.prepare('SELECT * FROM project_core').all(), contents: db.prepare('SELECT * FROM contents').all() }
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(19)
      expect(result.completedSteps).toEqual(['M08'])
      expect(db.prepare('SELECT * FROM project_core').all()).toEqual(before.core)
      expect(db.prepare('SELECT * FROM contents').all()).toEqual(before.contents)
      expect(revision(db)).toBe(0)
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9).version).toBe(9)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9).completedSteps).toEqual([])
    } finally { db.close() }
  })

  it('rolls back the DDL and schema stamp when M08 domain verification fails', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M08'
        ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(8)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('Fictional author manuscript')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'planning_feedback_%'").all()).toEqual([])
    } finally { db.close() }
  })

  it('requires a central-runner transaction rather than installing tables during a read', () => {
    const db = fixture()
    try {
      expect(() => applyM08PlanningFeedback(db)).toThrow('PLANNING_FEEDBACK_MIGRATION_TRANSACTION_REQUIRED')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'planning_feedback_%'").all()).toEqual([])
      expect(db.pragma('user_version', { simple: true })).toBe(8)
    } finally { db.close() }
  })

  it('counts repository and raw-SQL author writes, preserving A-to-B-to-A history', () => {
    const db = fixture()
    try {
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
      ProjectCoreRepository.update({ coreOutline: 'B' }, db)
      db.prepare("UPDATE project_core SET core_outline='A' WHERE id='main'").run()
      expect(revision(db)).toBe(2)
      expect(db.prepare("SELECT core_outline FROM project_core WHERE id='main'").pluck().get()).toBe('A')
      db.prepare("UPDATE project_core SET core_outline='A',updated_at='same-value-write' WHERE id='main'").run()
      expect(revision(db)).toBe(2)
    } finally { db.close() }
  })

  it('does not count derived caches or timestamps as a changed author source', () => {
    const db = fixture()
    try {
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
      db.prepare("UPDATE project_core SET character_states='derived state',plot_tree_snapshot='derived graph',updated_at='cache refresh' WHERE id='main'").run()
      expect(revision(db)).toBe(0)
    } finally { db.close() }
  })

  it('rolls back source revisions with their fact transaction and detects delete/reinsert ABA', () => {
    const db = fixture()
    try {
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
      expect(() => db.transaction(() => {
        ProjectCoreRepository.update({ coreOutline: 'uncommitted' }, db)
        expect(revision(db)).toBe(1)
        throw new Error('FICTIONAL_WRITE_INTERRUPTED')
      })()).toThrow('FICTIONAL_WRITE_INTERRUPTED')
      expect(revision(db)).toBe(0)
      db.prepare("DELETE FROM project_core WHERE id='main'").run()
      db.prepare("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fictional project','A')").run()
      expect(revision(db)).toBe(2)
    } finally { db.close() }
  })
})
