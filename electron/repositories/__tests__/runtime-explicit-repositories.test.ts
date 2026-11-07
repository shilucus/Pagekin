import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Sqlite from 'better-sqlite3'
import { getProjectDb } from '../../database'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { ProjectCoreRepository } from '../project-core-repository'
import { FinalizationRepository } from '../finalization-repository'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: () => null }))

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof Sqlite
const databases: Sqlite.Database[] = []

function fixture(): Sqlite.Database {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('foreign_keys = ON')
  db.transaction(() => initializeLegacyBaselineSchema(db, Buffer.alloc(32, 1)))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  return db
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('captured runtime repository adapters', () => {
  it('initializes only the explicitly selected DB while the compatibility view points elsewhere', () => {
    const a = fixture(), b = fixture()
    vi.mocked(getProjectDb).mockReturnValue(b)
    ProjectCoreRepository.init('Fictional A', 'en-US', a)
    expect(ProjectCoreRepository.get(a)?.projectName).toBe('Fictional A')
    expect(ProjectCoreRepository.get(b)).toBeNull()
    expect(getProjectDb).not.toHaveBeenCalled()
  })

  it('reads finalized KB identities only from the captured DB', () => {
    const a = fixture(), b = fixture()
    const seed = (db: Sqlite.Database, documentId: string, chapter: number) => {
      db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run('fictional final')
      db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id) VALUES(1,?,1,'finalized',1)").run(chapter)
      db.prepare(`INSERT INTO finalization_outbox_all(finalization_id,draft_id,chapter_number,content_hash,content_revision,
        content_snapshot,target_file_name,knowledge_document_id) VALUES('final-1',1,?,'hash',1,'fictional final','chapter.txt',?)`)
        .run(chapter, documentId)
    }
    seed(a, 'kb-a', 1)
    seed(b, 'kb-b', 9)
    vi.mocked(getProjectDb).mockReturnValue(b)
    expect(FinalizationRepository.knowledgeDocumentChapters(a)).toEqual(new Map([['kb-a', 1]]))
    expect(getProjectDb).not.toHaveBeenCalled()
  })

  it('keeps duplicate-final cleanup registration and its nested status refresh in the captured transaction', () => {
    const a = fixture(), b = fixture()
    for (const version of [1, 2]) {
      const body = `fictional final ${version}`
      a.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(version, body)
      a.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id) VALUES(?,1,?,'finalized',?)")
        .run(version, version, version)
      a.prepare(`INSERT INTO finalization_outbox_all(finalization_id,draft_id,chapter_number,content_hash,content_revision,
        content_snapshot,target_file_name,knowledge_document_id,publication_status) VALUES(?,?,1,?,1,?,?,?,'published')`)
        .run(`final-${version}`, version, createHash('sha256').update(body).digest('hex'), body,
          `chapter-${version}.txt`, `kb-${version}`)
    }
    a.prepare(`INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id,source_label,all_critical_passed)
      VALUES('run-1','chapter_finalize','finalization:final-2','fictional',1)`).run()
    a.prepare("INSERT INTO post_process_steps(run_id,step_key,label,critical) VALUES('run-1','review','Review',1)").run()
    b.prepare(`INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id,source_label,all_critical_passed)
      VALUES('run-1','chapter_finalize','finalization:final-2','fictional other',0)`).run()
    const bChanges = b.prepare('SELECT total_changes()').pluck().get()
    vi.mocked(getProjectDb).mockReturnValue(b)
    const repair = FinalizationRepository.repairDuplicateFinalizations({
      remove_replaced_knowledge: 'Remove superseded knowledge', remove_replaced_manuscripts: 'Remove superseded manuscript',
    }, a)
    expect(repair.chapters).toMatchObject([{ keptDraftId: 2, cleanupRegistered: true }])
    expect(a.prepare('SELECT id,status FROM drafts ORDER BY id').all()).toEqual([
      { id: 1, status: 'superseded' }, { id: 2, status: 'finalized' },
    ])
    expect(a.prepare('SELECT step_key FROM post_process_steps ORDER BY id').pluck().all()).toEqual([
      'review', 'remove_replaced_knowledge', 'remove_replaced_manuscripts',
    ])
    expect(a.prepare("SELECT all_critical_passed FROM post_process_runs WHERE id='run-1'").pluck().get()).toBe(0)
    expect(b.prepare('SELECT total_changes()').pluck().get()).toBe(bChanges)
    expect(b.prepare('SELECT count(*) FROM post_process_steps').pluck().get()).toBe(0)
    expect(getProjectDb).not.toHaveBeenCalled()
  })
})
