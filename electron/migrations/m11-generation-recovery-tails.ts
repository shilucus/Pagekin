import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M11_GENERATION_RECOVERY_TAIL_TABLES = ['generation_recovery_tails'] as const
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

export const M11_GENERATION_RECOVERY_TAILS_SQL = `
CREATE TABLE generation_recovery_tails (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES generation_attempts(attempt_id),
  artifact_id TEXT NOT NULL UNIQUE REFERENCES generation_artifacts(artifact_id),
  durable_revision INTEGER NOT NULL CHECK(typeof(durable_revision)='integer' AND durable_revision>=0),
  prefix_hash TEXT NOT NULL CHECK(length(prefix_hash)=64 AND prefix_hash NOT GLOB '*[^a-f0-9]*'),
  tail_text TEXT NOT NULL CHECK(length(tail_text)>0),
  tail_hash TEXT NOT NULL CHECK(length(tail_hash)=64 AND tail_hash NOT GLOB '*[^a-f0-9]*'),
  preserved_at TEXT NOT NULL
);
`

export function applyM11GenerationRecoveryTails(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('GENERATION_RECOVERY_TAIL_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M11_GENERATION_RECOVERY_TAILS_SQL)
}

export function verifyM11GenerationRecoveryTails(db: Database.Database): boolean {
  try {
    const rows = db.prepare(`SELECT t.*,a.attempt_id AS actual_attempt_id,a.run_id AS artifact_run_id,
      a.artifact_json,a.revision AS actual_revision,p.run_id AS attempt_run_id,p.root_action_id AS attempt_root_id,p.attempt_json,
      r.run_id AS actual_run_id,r.root_action_id AS run_root_id
      FROM generation_recovery_tails t LEFT JOIN generation_artifacts a ON a.artifact_id=t.artifact_id
      LEFT JOIN generation_attempts p ON p.attempt_id=t.attempt_id
      LEFT JOIN generation_runs r ON r.run_id=p.run_id`).all() as Array<{
        attempt_id: string; artifact_id: string; durable_revision: number; prefix_hash: string; tail_text: string
        tail_hash: string; preserved_at: string; actual_attempt_id: string; artifact_run_id: string
        artifact_json: string; actual_revision: number; attempt_run_id: string; attempt_root_id: string; attempt_json: string
        actual_run_id: string; run_root_id: string
      }>
    for (const row of rows) {
      const artifact = JSON.parse(row.artifact_json) as { text: string; textHash: string; revision: number; artifactId: string; attemptId: string; rootActionId: string }
      const attempt = JSON.parse(row.attempt_json) as { status: string; attemptId: string; rootActionId: string }
      if (row.actual_attempt_id !== row.attempt_id || row.artifact_run_id !== row.attempt_run_id
        || row.actual_run_id !== row.attempt_run_id || row.run_root_id !== row.attempt_root_id
        || artifact.artifactId !== row.artifact_id || artifact.attemptId !== row.attempt_id
        || attempt.attemptId !== row.attempt_id || attempt.rootActionId !== row.attempt_root_id || artifact.rootActionId !== row.attempt_root_id
        || !Number.isSafeInteger(row.durable_revision) || row.durable_revision < 0
        || row.actual_revision !== row.durable_revision || artifact.revision !== row.durable_revision
        || typeof artifact.text !== 'string' || artifact.textHash !== hash(artifact.text) || row.prefix_hash !== artifact.textHash
        || typeof row.tail_text !== 'string' || !row.tail_text || row.tail_hash !== hash(row.tail_text)
        || !['settled', 'unknown', 'cancelled-before-dispatch'].includes(attempt.status)
        || typeof row.preserved_at !== 'string' || !Number.isFinite(Date.parse(row.preserved_at))
        || new Date(row.preserved_at).toISOString() !== row.preserved_at) return false
    }
    return db.prepare('PRAGMA foreign_key_check(generation_recovery_tails)').all().length === 0
  } catch { return false }
}

export function createM11Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M11', from: 11, to: 12, owner: 'generation-recovery-tails',
    migrate: reader => applyM11GenerationRecoveryTails(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM11GenerationRecoveryTails(deps.database(reader)) }
}
