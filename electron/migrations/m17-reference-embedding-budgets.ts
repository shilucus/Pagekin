import type Database from 'better-sqlite3'
import { assertReferenceEmbeddingBudgetRecord, REFERENCE_EMBEDDING_BUDGET_FIELDS,
  REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION } from '../services/reference-embedding-budget-contract'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M17_REFERENCE_EMBEDDING_BUDGET_TABLES = ['reference_embedding_budgets', 'reference_import_manifest_chapters'] as const
export const REFERENCE_IMPORT_MANIFEST_CHAPTER_FIELDS = [
  'import_run_id', 'chapter_number', 'snapshot_run_id', 'snapshot_chapter_number', 'source_id', 'source_chapter_number',
] as const
export const M17_REFERENCE_EMBEDDING_BUDGETS_SQL = `
CREATE TABLE reference_embedding_budgets (
 root_run_id TEXT PRIMARY KEY NOT NULL REFERENCES import_runs(id),
 manifest_fingerprint TEXT CHECK(manifest_fingerprint IS NULL OR
   (length(manifest_fingerprint)=64 AND manifest_fingerprint NOT GLOB '*[^a-f0-9]*')),
 policy_version TEXT NOT NULL CHECK(policy_version='reference-embedding-budget-v1'),
 initial_chunk_size INTEGER,
 initial_chunk_overlap INTEGER,
 initial_batch_size INTEGER,
 request_limit INTEGER,
 active_limit_ms INTEGER,
 spent_requests INTEGER,
 active_elapsed_ms INTEGER,
 active_since_ms INTEGER,
 state TEXT NOT NULL CHECK(state IN ('ready','recovery_unknown','legacy_unbudgeted')),
 CHECK((state='legacy_unbudgeted' AND manifest_fingerprint IS NULL AND initial_chunk_size IS NULL
   AND initial_chunk_overlap IS NULL AND initial_batch_size IS NULL AND request_limit IS NULL
   AND active_limit_ms IS NULL AND spent_requests IS NULL AND active_elapsed_ms IS NULL AND active_since_ms IS NULL)
   OR (state IN ('ready','recovery_unknown')
     AND initial_chunk_size IS NOT NULL AND typeof(initial_chunk_size)='integer' AND initial_chunk_size BETWEEN 100 AND 4000
     AND initial_chunk_overlap IS NOT NULL AND typeof(initial_chunk_overlap)='integer' AND initial_chunk_overlap BETWEEN 0 AND initial_chunk_size-1
     AND initial_batch_size IS NOT NULL AND typeof(initial_batch_size)='integer' AND initial_batch_size BETWEEN 1 AND 50
     AND request_limit IS NOT NULL AND typeof(request_limit)='integer' AND request_limit BETWEEN 1 AND 9007199254740991
     AND active_limit_ms IS NOT NULL AND typeof(active_limit_ms)='integer' AND active_limit_ms BETWEEN 1 AND 9007199254740991
     AND active_limit_ms=request_limit*112500
     AND spent_requests IS NOT NULL AND typeof(spent_requests)='integer' AND spent_requests BETWEEN 0 AND request_limit
     AND active_elapsed_ms IS NOT NULL AND typeof(active_elapsed_ms)='integer' AND active_elapsed_ms BETWEEN 0 AND 9007199254740991
     AND (active_since_ms IS NULL OR (typeof(active_since_ms)='integer' AND active_since_ms BETWEEN 0 AND 9007199254740991))))
);
CREATE TABLE reference_import_manifest_chapters (
 import_run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
 chapter_number INTEGER NOT NULL CHECK(typeof(chapter_number)='integer' AND chapter_number BETWEEN 1 AND 9007199254740991),
 snapshot_run_id TEXT NOT NULL,
 snapshot_chapter_number INTEGER NOT NULL CHECK(typeof(snapshot_chapter_number)='integer' AND snapshot_chapter_number BETWEEN 1 AND 9007199254740991),
 source_id TEXT NOT NULL CHECK(length(source_id)>0),
 source_chapter_number INTEGER NOT NULL CHECK(typeof(source_chapter_number)='integer' AND source_chapter_number BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(import_run_id,chapter_number),
 FOREIGN KEY(snapshot_run_id,snapshot_chapter_number) REFERENCES import_run_chapters(run_id,chapter_number)
);
`

/** Missing old accounting is unknown, not an invitation to allocate a fresh budget on restart. */
export function applyM17ReferenceEmbeddingBudgets(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('REFERENCE_EMBEDDING_BUDGET_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M17_REFERENCE_EMBEDDING_BUDGETS_SQL)
  // Old runs only prove their own stored subset; the full-manifest reader must still verify completeness.
  db.exec(`INSERT INTO reference_import_manifest_chapters
    SELECT c.run_id,c.chapter_number,c.run_id,c.chapter_number,c.source_id,c.source_chapter_number
    FROM import_run_chapters c JOIN import_runs r ON r.id=c.run_id
    WHERE r.purpose='reference' AND typeof(c.chapter_number)='integer'
      AND c.chapter_number BETWEEN 1 AND 9007199254740991 AND length(c.source_id)>0
      AND typeof(c.source_chapter_number)='integer' AND c.source_chapter_number BETWEEN 1 AND 9007199254740991`)
  db.prepare(`INSERT INTO reference_embedding_budgets(root_run_id,policy_version,state)
    SELECT DISTINCT r.root_run_id,?,'legacy_unbudgeted' FROM import_runs r
    WHERE r.purpose='reference' AND (r.execution_epoch>0 OR r.stage NOT IN ('parsing','prepared')
      OR EXISTS(SELECT 1 FROM reference_import_grants g WHERE g.import_run_id=r.id)
      OR EXISTS(SELECT 1 FROM reference_embedding_dispatches d WHERE d.import_run_id=r.id)
      OR EXISTS(SELECT 1 FROM import_run_knowledge_receipts k WHERE k.run_id=r.id))`)
    .run(REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION)
}

export function verifyM17ReferenceEmbeddingBudgets(db: Database.Database): boolean {
  try {
    const columns = db.prepare('PRAGMA table_info(reference_embedding_budgets)').all() as { name: string }[]
    if (columns.length !== REFERENCE_EMBEDDING_BUDGET_FIELDS.length
      || columns.some((column, index) => column.name !== REFERENCE_EMBEDDING_BUDGET_FIELDS[index])) return false
    const keys = db.prepare('PRAGMA foreign_key_list(reference_embedding_budgets)').all() as {
      table: string; from: string; to: string; on_delete: string; on_update: string
    }[]
    if (keys.length !== 1 || keys[0]!.table !== 'import_runs' || keys[0]!.from !== 'root_run_id'
      || keys[0]!.to !== 'id' || keys[0]!.on_delete !== 'NO ACTION' || keys[0]!.on_update !== 'NO ACTION') return false
    for (const row of db.prepare('SELECT * FROM reference_embedding_budgets').all()) assertReferenceEmbeddingBudgetRecord(row)
    const bindings = db.prepare('PRAGMA table_info(reference_import_manifest_chapters)').all() as { name: string; pk: number }[]
    if (bindings.length !== REFERENCE_IMPORT_MANIFEST_CHAPTER_FIELDS.length
      || bindings.some((column, index) => column.name !== REFERENCE_IMPORT_MANIFEST_CHAPTER_FIELDS[index]
        || column.pk !== (index < 2 ? index + 1 : 0))) return false
    const bindingKeys = db.prepare('PRAGMA foreign_key_list(reference_import_manifest_chapters)').all() as {
      id: number; seq: number; table: string; from: string; to: string; on_delete: string; on_update: string
    }[]
    const owner = bindingKeys.find(key => key.from === 'import_run_id')
    const snapshot = bindingKeys.find(key => key.from === 'snapshot_run_id')
    const chapter = bindingKeys.find(key => key.from === 'snapshot_chapter_number')
    if (bindingKeys.length !== 3 || !owner || owner.table !== 'import_runs' || owner.to !== 'id'
      || owner.on_delete !== 'CASCADE' || owner.on_update !== 'NO ACTION' || owner.seq !== 0
      || !snapshot || snapshot.table !== 'import_run_chapters' || snapshot.to !== 'run_id'
      || snapshot.on_delete !== 'NO ACTION' || snapshot.on_update !== 'NO ACTION' || snapshot.seq !== 0
      || !chapter || chapter.id !== snapshot.id || chapter.table !== 'import_run_chapters'
      || chapter.to !== 'chapter_number' || chapter.on_delete !== 'NO ACTION'
      || chapter.on_update !== 'NO ACTION' || chapter.seq !== 1) return false
    return !db.prepare(`SELECT 1 FROM reference_embedding_budgets b JOIN import_runs r ON r.id=b.root_run_id
      WHERE r.purpose<>'reference' OR r.root_run_id<>r.id LIMIT 1`).get()
      && db.prepare('PRAGMA foreign_key_check(reference_embedding_budgets)').all().length === 0
      && !db.prepare(`SELECT 1 FROM reference_import_manifest_chapters b
        JOIN import_runs r ON r.id=b.import_run_id JOIN import_runs s ON s.id=b.snapshot_run_id
        WHERE r.purpose<>'reference' OR s.purpose<>'reference'
          OR typeof(b.chapter_number)<>'integer' OR b.chapter_number NOT BETWEEN 1 AND 9007199254740991
          OR typeof(b.snapshot_chapter_number)<>'integer' OR b.snapshot_chapter_number NOT BETWEEN 1 AND 9007199254740991
          OR typeof(b.source_chapter_number)<>'integer' OR b.source_chapter_number NOT BETWEEN 1 AND 9007199254740991
          OR typeof(b.source_id)<>'text' OR length(b.source_id)=0 LIMIT 1`).get()
      && db.prepare('PRAGMA foreign_key_check(reference_import_manifest_chapters)').all().length === 0
  } catch { return false }
}

export function createM17Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M17', from: 17, to: 18, owner: 'reference-embedding-budgets',
    migrate: reader => applyM17ReferenceEmbeddingBudgets(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM17ReferenceEmbeddingBudgets(deps.database(reader)) }
}
