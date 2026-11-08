import type Database from 'better-sqlite3'
import { assertReferenceImportGrantId, assertReferenceImportGrantOperationId, referenceImportGrantInteger } from '../../src/shared/reference-import-grant'
import { isContentHash } from '../../src/shared/source-ref'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M14_REFERENCE_IMPORT_GRANT_TABLES = ['reference_import_grants'] as const
export const M14_REFERENCE_IMPORT_GRANTS_SQL = `
CREATE TABLE reference_import_grants (
 grant_id TEXT PRIMARY KEY NOT NULL,
 operation_key TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL,
 import_run_id TEXT NOT NULL REFERENCES import_runs(id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
 action TEXT NOT NULL CHECK(action='reference-import-v1'),
 manifest_fingerprint TEXT CHECK(manifest_fingerprint IS NULL OR (length(manifest_fingerprint)=64 AND manifest_fingerprint NOT GLOB '*[^a-f0-9]*')),
 request_hash TEXT CHECK(request_hash IS NULL OR (length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*')),
 state TEXT NOT NULL CHECK(state IN ('active','completed','revoked')),
 decision_source TEXT NOT NULL CHECK(decision_source='author-action'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 completed_at INTEGER CHECK(completed_at IS NULL OR (typeof(completed_at)='integer' AND completed_at>=0)),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=0)),
 CHECK((manifest_fingerprint IS NULL)=(request_hash IS NULL)),
 CHECK((state='active' AND completed_at IS NULL AND revoked_at IS NULL)
   OR (state='completed' AND completed_at IS NOT NULL AND revoked_at IS NULL)
   OR (state='revoked' AND completed_at IS NULL AND revoked_at IS NOT NULL AND revision>=2))
);
CREATE UNIQUE INDEX idx_reference_import_grants_active_run ON reference_import_grants(import_run_id) WHERE state='active';
`

export function applyM14ReferenceImportGrants(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('REFERENCE_IMPORT_GRANT_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M14_REFERENCE_IMPORT_GRANTS_SQL)
}

/** Neutralized history and hash-bearing rows are structurally readable, not thereby authorized. */
export function verifyM14ReferenceImportGrants(db: Database.Database): boolean {
  try {
    const fields = ['grant_id', 'operation_key', 'project_id', 'import_run_id', 'revision', 'action', 'manifest_fingerprint',
      'request_hash', 'state', 'decision_source', 'created_at', 'completed_at', 'revoked_at']
    const columns = db.prepare('PRAGMA table_info(reference_import_grants)').all() as { name: string }[]
    if (columns.length !== fields.length || columns.some((column, index) => column.name !== fields[index])) return false
    const rows = db.prepare('SELECT * FROM reference_import_grants').all() as Record<string, unknown>[]
    for (const row of rows) {
      assertReferenceImportGrantOperationId(row.grant_id)
      assertReferenceImportGrantId(row.operation_key)
      assertReferenceImportGrantId(row.project_id)
      assertReferenceImportGrantId(row.import_run_id)
      const revision = referenceImportGrantInteger(row.revision, 1)
      referenceImportGrantInteger(row.created_at)
      if (row.action !== 'reference-import-v1' || row.decision_source !== 'author-action'
        || (row.manifest_fingerprint === null) !== (row.request_hash === null)) return false
      for (const value of [row.manifest_fingerprint, row.request_hash]) {
        if (value !== null && (typeof value !== 'string' || !isContentHash(value))) return false
      }
      const completedAt = row.completed_at === null ? null : referenceImportGrantInteger(row.completed_at)
      const revokedAt = row.revoked_at === null ? null : referenceImportGrantInteger(row.revoked_at)
      if (!(row.state === 'active' && completedAt === null && revokedAt === null
        || row.state === 'completed' && completedAt !== null && revokedAt === null
        || row.state === 'revoked' && completedAt === null && revokedAt !== null && revision >= 2)) return false
    }
    return !db.prepare("SELECT 1 FROM reference_import_grants WHERE state='active' GROUP BY import_run_id HAVING COUNT(*)>1 LIMIT 1").get()
      && !db.prepare('SELECT 1 FROM reference_import_grants GROUP BY operation_key HAVING COUNT(*)>1 LIMIT 1').get()
      && db.prepare('PRAGMA foreign_key_check(reference_import_grants)').all().length === 0
  } catch { return false }
}

export function createM14Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M14', from: 14, to: 15, owner: 'reference-import-grants',
    migrate: reader => applyM14ReferenceImportGrants(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM14ReferenceImportGrants(deps.database(reader)) }
}
