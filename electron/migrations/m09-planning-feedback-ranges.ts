import type Database from 'better-sqlite3'
import { PLANNING_FEEDBACK_CORE_COLUMNS, PLANNING_FEEDBACK_TARGETS } from '../../src/shared/planning-feedback'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M09_PLANNING_FEEDBACK_TABLES = ['planning_feedback_outline_revision'] as const
const fields = PLANNING_FEEDBACK_TARGETS.map(target => `'${target}'`).join(',')
const changed = [...Object.values(PLANNING_FEEDBACK_CORE_COLUMNS), 'synopsis', 'characters_arch']
  .map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')

export const M09_PLANNING_FEEDBACK_RANGES_SQL = `
CREATE TABLE planning_feedback_outline_revision (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision>=0)
);
INSERT INTO planning_feedback_outline_revision(id,revision) VALUES(1,0);
CREATE TRIGGER planning_feedback_outline_update AFTER UPDATE ON project_core
WHEN (OLD.id='main' OR NEW.id='main') AND (OLD.id IS NOT NEW.id OR ${changed})
BEGIN UPDATE planning_feedback_outline_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER planning_feedback_outline_insert AFTER INSERT ON project_core
WHEN NEW.id='main'
BEGIN UPDATE planning_feedback_outline_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER planning_feedback_outline_delete AFTER DELETE ON project_core
WHEN OLD.id='main'
BEGIN UPDATE planning_feedback_outline_revision SET revision=revision+1 WHERE id=1; END;
CREATE TABLE planning_feedback_bases_m09 (
  base_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2)),
  project_id TEXT NOT NULL,
  target TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  source_hash TEXT NOT NULL,
  source_json TEXT NOT NULL,
  value TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by_adoption_id TEXT,
  scope_json TEXT,
  CHECK((closed_at IS NULL)=(closed_by_adoption_id IS NULL)),
  CHECK((schema_version=1 AND target IN (${fields}) AND scope_json IS NULL)
    OR (schema_version=2 AND target='plotOutlineRange' AND scope_json IS NOT NULL))
);
CREATE TABLE planning_feedback_candidates_m09 (
  candidate_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2)),
  project_id TEXT NOT NULL,
  base_id TEXT NOT NULL REFERENCES planning_feedback_bases_m09(base_id),
  parent_candidate_id TEXT REFERENCES planning_feedback_candidates_m09(candidate_id),
  generation_parent_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  feedback TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE planning_feedback_adoptions_m09 (
  adoption_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2)),
  project_id TEXT NOT NULL,
  base_id TEXT NOT NULL REFERENCES planning_feedback_bases_m09(base_id),
  candidate_id TEXT NOT NULL REFERENCES planning_feedback_candidates_m09(candidate_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('full','partial','edited')),
  decision_source TEXT NOT NULL CHECK(decision_source='author-action'),
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  before_value TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  committed_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  adopted_scope_json TEXT,
  UNIQUE(project_id,idempotency_key),
  UNIQUE(base_id),
  CHECK((schema_version=1 AND target IN (${fields}) AND adopted_scope_json IS NULL)
    OR (schema_version=2 AND target='plotOutlineRange' AND adopted_scope_json IS NOT NULL))
);
INSERT INTO planning_feedback_bases_m09
SELECT base_id,schema_version,project_id,target,source_revision,source_hash,source_json,value,value_hash,created_at,closed_at,closed_by_adoption_id,NULL
FROM planning_feedback_bases;
INSERT INTO planning_feedback_candidates_m09 SELECT * FROM planning_feedback_candidates;
INSERT INTO planning_feedback_adoptions_m09
SELECT adoption_id,schema_version,project_id,base_id,candidate_id,idempotency_key,request_hash,target,decision,decision_source,text,text_hash,before_value,before_hash,source_revision,committed_revision,created_at,NULL
FROM planning_feedback_adoptions;
DROP TABLE planning_feedback_adoptions;
DROP TABLE planning_feedback_candidates;
DROP TABLE planning_feedback_bases;
ALTER TABLE planning_feedback_bases_m09 RENAME TO planning_feedback_bases;
ALTER TABLE planning_feedback_candidates_m09 RENAME TO planning_feedback_candidates;
ALTER TABLE planning_feedback_adoptions_m09 RENAME TO planning_feedback_adoptions;
CREATE INDEX idx_planning_feedback_candidates_base ON planning_feedback_candidates(base_id,created_at,candidate_id);
`

/** The central runner owns the transaction, backup and installed schema version. */
export function applyM09PlanningFeedbackRanges(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('PLANNING_FEEDBACK_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M09_PLANNING_FEEDBACK_RANGES_SQL)
}

export function verifyM09PlanningFeedbackRanges(db: Database.Database): boolean {
  try {
    const revision = db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()
    return Number.isSafeInteger(revision) && Number(revision) >= 0
      && !db.prepare(`SELECT 1 FROM planning_feedback_bases WHERE
        (schema_version=1 AND scope_json IS NOT NULL) OR (schema_version=2 AND scope_json IS NULL) LIMIT 1`).get()
      && !db.prepare(`SELECT 1 FROM planning_feedback_adoptions WHERE
        (schema_version=1 AND adopted_scope_json IS NOT NULL) OR (schema_version=2 AND adopted_scope_json IS NULL) LIMIT 1`).get()
      && ['planning_feedback_bases', 'planning_feedback_candidates', 'planning_feedback_adoptions']
        .every(table => db.prepare(`PRAGMA foreign_key_check(${table})`).all().length === 0)
  } catch { return false }
}

export function createM09Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M09', from: 9, to: 10, owner: 'planning-feedback',
    migrate: reader => applyM09PlanningFeedbackRanges(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM09PlanningFeedbackRanges(deps.database(reader)) }
}
