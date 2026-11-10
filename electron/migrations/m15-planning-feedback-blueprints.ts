import type Database from 'better-sqlite3'
import { PLANNING_FEEDBACK_TARGETS } from '../../src/shared/planning-feedback'
import { M10_RUNTIME_FEEDBACK_GRANTS_SQL } from './m10-runtime-feedback-grants'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M15_PLANNING_FEEDBACK_TABLES = ['planning_feedback_blueprint_revisions'] as const
const fields = PLANNING_FEEDBACK_TARGETS.map(target => `'${target}'`).join(',')
const blueprintColumns = ['chapter_number', 'title', 'role', 'purpose', 'key_events', 'characters', 'suspense_hook', 'user_guidance', 'notes', 'notes_updated_at']
// Rebuild the unchanged referencing child before swapping its parents, keeping FK enforcement enabled.
const grantRebuildSql = M10_RUNTIME_FEEDBACK_GRANTS_SQL
  .replace('CREATE TABLE runtime_feedback_grants (', 'CREATE TABLE runtime_feedback_grants_m15 (')
  .replaceAll('REFERENCES planning_feedback_bases(', 'REFERENCES planning_feedback_bases_m15(')
  .replaceAll('REFERENCES planning_feedback_candidates(', 'REFERENCES planning_feedback_candidates_m15(')

/** Only local ABA fences are new; existing feedback columns and historical encodings stay intact. */
export const M15_PLANNING_FEEDBACK_BLUEPRINTS_SQL = `
CREATE TABLE planning_feedback_bases_m15 (
  base_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2,3)),
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
    OR (schema_version=2 AND target='plotOutlineRange' AND scope_json IS NOT NULL)
    OR (schema_version=3 AND target='blueprintFields' AND scope_json IS NOT NULL))
);
CREATE TABLE planning_feedback_candidates_m15 (
  candidate_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2,3)),
  project_id TEXT NOT NULL,
  base_id TEXT NOT NULL REFERENCES planning_feedback_bases_m15(base_id),
  parent_candidate_id TEXT REFERENCES planning_feedback_candidates_m15(candidate_id),
  generation_parent_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  feedback TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE planning_feedback_adoptions_m15 (
  adoption_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2,3)),
  project_id TEXT NOT NULL,
  base_id TEXT NOT NULL REFERENCES planning_feedback_bases_m15(base_id),
  candidate_id TEXT NOT NULL REFERENCES planning_feedback_candidates_m15(candidate_id),
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
    OR (schema_version=2 AND target='plotOutlineRange' AND adopted_scope_json IS NOT NULL)
    OR (schema_version=3 AND target='blueprintFields' AND adopted_scope_json IS NOT NULL))
);
${grantRebuildSql}
INSERT INTO planning_feedback_bases_m15 SELECT * FROM planning_feedback_bases;
INSERT INTO planning_feedback_candidates_m15 SELECT * FROM planning_feedback_candidates;
INSERT INTO planning_feedback_adoptions_m15 SELECT * FROM planning_feedback_adoptions;
INSERT INTO runtime_feedback_grants_m15 SELECT * FROM runtime_feedback_grants;
DROP TABLE runtime_feedback_grants;
DROP TABLE planning_feedback_adoptions;
DROP TABLE planning_feedback_candidates;
DROP TABLE planning_feedback_bases;
ALTER TABLE planning_feedback_bases_m15 RENAME TO planning_feedback_bases;
ALTER TABLE planning_feedback_candidates_m15 RENAME TO planning_feedback_candidates;
ALTER TABLE planning_feedback_adoptions_m15 RENAME TO planning_feedback_adoptions;
ALTER TABLE runtime_feedback_grants_m15 RENAME TO runtime_feedback_grants;
CREATE INDEX idx_planning_feedback_candidates_base ON planning_feedback_candidates(base_id,created_at,candidate_id);
CREATE TABLE planning_feedback_blueprint_revisions (
  chapter_number INTEGER PRIMARY KEY CHECK(typeof(chapter_number)='integer' AND chapter_number BETWEEN 1 AND 9007199254740991),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO planning_feedback_blueprint_revisions SELECT chapter_number,0 FROM blueprints;
CREATE TRIGGER planning_feedback_blueprint_insert AFTER INSERT ON blueprints BEGIN
  INSERT INTO planning_feedback_blueprint_revisions VALUES(NEW.chapter_number,1)
    ON CONFLICT(chapter_number) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER planning_feedback_blueprint_update AFTER UPDATE ON blueprints
WHEN ${blueprintColumns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')} BEGIN
  INSERT INTO planning_feedback_blueprint_revisions VALUES(OLD.chapter_number,1)
    ON CONFLICT(chapter_number) DO UPDATE SET revision=revision+1;
  INSERT INTO planning_feedback_blueprint_revisions SELECT NEW.chapter_number,1 WHERE OLD.chapter_number IS NOT NEW.chapter_number
    ON CONFLICT(chapter_number) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER planning_feedback_blueprint_delete AFTER DELETE ON blueprints BEGIN
  INSERT INTO planning_feedback_blueprint_revisions VALUES(OLD.chapter_number,1)
    ON CONFLICT(chapter_number) DO UPDATE SET revision=revision+1;
END;
`

export function applyM15PlanningFeedbackBlueprints(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('PLANNING_FEEDBACK_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M15_PLANNING_FEEDBACK_BLUEPRINTS_SQL)
}

export function verifyM15PlanningFeedbackBlueprints(db: Database.Database): boolean {
  try {
    const outlineRevision = db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()
    return Number.isSafeInteger(outlineRevision) && Number(outlineRevision) >= 0
      && !db.prepare(`SELECT 1 FROM planning_feedback_blueprint_revisions WHERE
      typeof(chapter_number)<>'integer' OR chapter_number NOT BETWEEN 1 AND 9007199254740991
      OR typeof(revision)<>'integer' OR revision NOT BETWEEN 0 AND 9007199254740991 LIMIT 1`).get()
      && !db.prepare(`SELECT 1 FROM planning_feedback_bases WHERE NOT (
        (schema_version=1 AND target IN (${fields}) AND scope_json IS NULL)
        OR (schema_version=2 AND target='plotOutlineRange' AND scope_json IS NOT NULL)
        OR (schema_version=3 AND target='blueprintFields' AND scope_json IS NOT NULL)) LIMIT 1`).get()
      && !db.prepare(`SELECT 1 FROM planning_feedback_adoptions WHERE NOT (
        (schema_version=1 AND target IN (${fields}) AND adopted_scope_json IS NULL)
        OR (schema_version=2 AND target='plotOutlineRange' AND adopted_scope_json IS NOT NULL)
        OR (schema_version=3 AND target='blueprintFields' AND adopted_scope_json IS NOT NULL)) LIMIT 1`).get()
      && !db.prepare('SELECT 1 FROM planning_feedback_candidates WHERE schema_version NOT IN (1,2,3) LIMIT 1').get()
      && !db.prepare(`SELECT 1 FROM blueprints b LEFT JOIN planning_feedback_blueprint_revisions r
        ON r.chapter_number=b.chapter_number WHERE r.chapter_number IS NULL LIMIT 1`).get()
      && db.prepare('PRAGMA foreign_key_check').all().length === 0
  } catch { return false }
}

export function createM15Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M15', from: 15, to: 16, owner: 'planning-feedback',
    migrate: reader => applyM15PlanningFeedbackBlueprints(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM15PlanningFeedbackBlueprints(deps.database(reader)) }
}
