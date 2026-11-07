import type Database from 'better-sqlite3'
import { PLANNING_FEEDBACK_TARGETS } from '../../src/shared/planning-feedback'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M10_RUNTIME_FEEDBACK_GRANT_TABLES = ['runtime_feedback_grants'] as const
const targets = PLANNING_FEEDBACK_TARGETS.map(target => `'${target}'`).join(',')

/** Historical rows do not contain bearer capabilities or runtime identities. */
export const M10_RUNTIME_FEEDBACK_GRANTS_SQL = `
CREATE TABLE runtime_feedback_grants (
  grant_id TEXT PRIMARY KEY NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
  action TEXT NOT NULL CHECK(action='planning-feedback-candidate'),
  target TEXT NOT NULL CHECK(target IN (${targets})),
  base_id TEXT NOT NULL REFERENCES planning_feedback_bases(base_id),
  parent_candidate_id TEXT REFERENCES planning_feedback_candidates(candidate_id),
  run_id TEXT NOT NULL UNIQUE REFERENCES generation_runs(run_id),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('active','completed','revoked')),
  candidate_id TEXT REFERENCES planning_feedback_candidates(candidate_id),
  decision_source TEXT NOT NULL CHECK(decision_source='author-action'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=0)),
  CHECK((state='active' AND candidate_id IS NULL AND revoked_at IS NULL)
    OR (state='completed' AND candidate_id IS NOT NULL AND revoked_at IS NULL)
    OR (state='revoked' AND candidate_id IS NULL AND revoked_at IS NOT NULL AND revision>=2))
);
`

export function applyM10RuntimeFeedbackGrants(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('RUNTIME_FEEDBACK_GRANT_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M10_RUNTIME_FEEDBACK_GRANTS_SQL)
}

export function verifyM10RuntimeFeedbackGrants(db: Database.Database): boolean {
  try {
    return !db.prepare(`SELECT 1 FROM runtime_feedback_grants WHERE
      typeof(revision)<>'integer' OR revision<1 OR action<>'planning-feedback-candidate'
      OR target NOT IN (${targets}) OR length(request_hash)<>64 OR request_hash GLOB '*[^a-f0-9]*'
      OR decision_source<>'author-action' OR typeof(created_at)<>'integer' OR created_at<0
      OR NOT ((state='active' AND candidate_id IS NULL AND revoked_at IS NULL)
        OR (state='completed' AND candidate_id IS NOT NULL AND revoked_at IS NULL)
        OR (state='revoked' AND candidate_id IS NULL AND typeof(revoked_at)='integer' AND revoked_at>=0 AND revision>=2))
      LIMIT 1`).get()
      && db.prepare('PRAGMA foreign_key_check(runtime_feedback_grants)').all().length === 0
  } catch { return false }
}

export function createM10Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M10', from: 10, to: 11, owner: 'runtime-feedback-grants',
    migrate: reader => applyM10RuntimeFeedbackGrants(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM10RuntimeFeedbackGrants(deps.database(reader)) }
}
