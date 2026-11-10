import type Database from 'better-sqlite3'
import { assertReferenceEmbeddingDispatchRecord, REFERENCE_EMBEDDING_DISPATCH_FIELDS } from '../services/reference-embedding-dispatch-contract'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M16_REFERENCE_EMBEDDING_DISPATCH_TABLES = ['reference_embedding_dispatches'] as const
export const M16_REFERENCE_EMBEDDING_DISPATCHES_SQL = `
CREATE TABLE reference_embedding_dispatches (
 dispatch_id TEXT PRIMARY KEY NOT NULL,
 import_run_id TEXT NOT NULL REFERENCES import_runs(id),
 document_id TEXT NOT NULL REFERENCES import_reference_documents(document_id),
 batch_ordinal INTEGER NOT NULL CHECK(typeof(batch_ordinal)='integer' AND batch_ordinal BETWEEN 0 AND 9007199254740991),
 input_count INTEGER NOT NULL CHECK(typeof(input_count)='integer' AND input_count BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN ('dispatch_marked','response_received','http_failed','response_invalid','transport_unknown')),
 http_status INTEGER CHECK(http_status IS NULL OR (typeof(http_status)='integer' AND http_status BETWEEN 100 AND 599)),
 marked_at INTEGER NOT NULL CHECK(typeof(marked_at)='integer' AND marked_at BETWEEN 0 AND 9007199254740991),
 settled_at INTEGER CHECK(settled_at IS NULL OR (typeof(settled_at)='integer' AND settled_at BETWEEN 0 AND 9007199254740991)),
 UNIQUE(document_id,batch_ordinal),
 CHECK(length(document_id)=64 AND document_id NOT GLOB '*[^a-f0-9]*'),
 CHECK(dispatch_id='reference-embedding:' || document_id || ':' || batch_ordinal),
 CHECK((state='dispatch_marked' AND http_status IS NULL AND settled_at IS NULL)
   OR (state IN ('response_received','response_invalid') AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299 AND settled_at IS NOT NULL)
   OR (state='http_failed' AND http_status IS NOT NULL AND http_status NOT BETWEEN 200 AND 299 AND settled_at IS NOT NULL)
   OR (state='transport_unknown' AND http_status IS NULL AND settled_at IS NOT NULL))
);
`

export function applyM16ReferenceEmbeddingDispatches(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('REFERENCE_EMBEDDING_DISPATCH_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M16_REFERENCE_EMBEDDING_DISPATCHES_SQL)
}

/** Dispatch facts remain readable history, never proof that another request may be sent. */
export function verifyM16ReferenceEmbeddingDispatches(db: Database.Database): boolean {
  try {
    const columns = db.prepare('PRAGMA table_info(reference_embedding_dispatches)').all() as { name: string }[]
    if (columns.length !== REFERENCE_EMBEDDING_DISPATCH_FIELDS.length
      || columns.some((column, index) => column.name !== REFERENCE_EMBEDDING_DISPATCH_FIELDS[index])) return false
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(reference_embedding_dispatches)').all() as {
      table: string; from: string; to: string; on_delete: string; on_update: string
    }[]
    if (foreignKeys.length !== 2 || ![['import_runs', 'import_run_id', 'id'], ['import_reference_documents', 'document_id', 'document_id']]
      .every(([table, from, to]) => foreignKeys.some(key => key.table === table && key.from === from && key.to === to
        && key.on_delete === 'NO ACTION' && key.on_update === 'NO ACTION'))) return false
    for (const row of db.prepare('SELECT * FROM reference_embedding_dispatches').all()) assertReferenceEmbeddingDispatchRecord(row)
    return !db.prepare(`SELECT 1 FROM reference_embedding_dispatches GROUP BY document_id,batch_ordinal HAVING COUNT(*)>1 LIMIT 1`).get()
      && db.prepare('PRAGMA foreign_key_check(reference_embedding_dispatches)').all().length === 0
  } catch { return false }
}

export function createM16Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M16', from: 16, to: 17, owner: 'reference-embedding-dispatches',
    migrate: reader => applyM16ReferenceEmbeddingDispatches(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM16ReferenceEmbeddingDispatches(deps.database(reader)) }
}
