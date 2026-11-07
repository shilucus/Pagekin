import type Database from 'better-sqlite3'
import { PLANNING_FEEDBACK_CORE_COLUMNS, PLANNING_FEEDBACK_TARGETS } from '../../src/shared/planning-feedback'
import type { MigrationImplementation, SchemaReader } from './registry'

const targets = PLANNING_FEEDBACK_TARGETS.map(target => `'${target}'`).join(',')
const changed = Object.values(PLANNING_FEEDBACK_CORE_COLUMNS).map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')

export const M08_PLANNING_FEEDBACK_TABLES = ['planning_feedback_core_revision', 'planning_feedback_bases',
  'planning_feedback_candidates', 'planning_feedback_adoptions'] as const

export const M08_PLANNING_FEEDBACK_SQL = `
CREATE TABLE planning_feedback_core_revision (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision>=0)
);
INSERT INTO planning_feedback_core_revision(id,revision) VALUES(1,0);
CREATE TRIGGER planning_feedback_core_update AFTER UPDATE ON project_core
WHEN (OLD.id='main' OR NEW.id='main') AND (OLD.id IS NOT NEW.id OR ${changed})
BEGIN UPDATE planning_feedback_core_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER planning_feedback_core_insert AFTER INSERT ON project_core
WHEN NEW.id='main'
BEGIN UPDATE planning_feedback_core_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER planning_feedback_core_delete AFTER DELETE ON project_core
WHEN OLD.id='main'
BEGIN UPDATE planning_feedback_core_revision SET revision=revision+1 WHERE id=1; END;
CREATE TABLE planning_feedback_bases (
  base_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  project_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target IN (${targets})),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  source_hash TEXT NOT NULL,
  source_json TEXT NOT NULL,
  value TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by_adoption_id TEXT,
  CHECK((closed_at IS NULL)=(closed_by_adoption_id IS NULL))
);
CREATE TABLE planning_feedback_candidates (
  candidate_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  project_id TEXT NOT NULL,
  base_id TEXT NOT NULL REFERENCES planning_feedback_bases(base_id),
  parent_candidate_id TEXT REFERENCES planning_feedback_candidates(candidate_id),
  generation_parent_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  feedback TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_planning_feedback_candidates_base ON planning_feedback_candidates(base_id,created_at,candidate_id);
CREATE TABLE planning_feedback_adoptions (
  adoption_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  project_id TEXT NOT NULL,
  base_id TEXT NOT NULL REFERENCES planning_feedback_bases(base_id),
  candidate_id TEXT NOT NULL REFERENCES planning_feedback_candidates(candidate_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target IN (${targets})),
  decision TEXT NOT NULL CHECK(decision IN ('full','partial','edited')),
  decision_source TEXT NOT NULL CHECK(decision_source='author-action'),
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  before_value TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  committed_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id,idempotency_key),
  UNIQUE(base_id)
);
`

/** Only the central runner opens the migration transaction and advances user_version. */
export function applyM08PlanningFeedback(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('PLANNING_FEEDBACK_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M08_PLANNING_FEEDBACK_SQL)
}

export function verifyM08PlanningFeedback(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT revision FROM planning_feedback_core_revision WHERE id=1').get() as { revision: number } | undefined
    return Boolean(row && Number.isSafeInteger(row.revision) && row.revision >= 0)
      && !db.prepare('SELECT 1 FROM planning_feedback_bases WHERE (closed_at IS NULL)<>(closed_by_adoption_id IS NULL) LIMIT 1').get()
  } catch { return false }
}

export function createM08Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M08', from: 8, to: 9, owner: 'planning-feedback',
    migrate: reader => applyM08PlanningFeedback(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM08PlanningFeedback(deps.database(reader)) }
}
