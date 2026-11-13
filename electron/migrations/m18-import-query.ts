import type Database from 'better-sqlite3'
import { IMPORT_QUERY_PLAN_FIELDS, IMPORT_QUERY_TABLES_SQL, IMPORT_QUERY_TOPIC_FIELDS,
  assertImportQueryPlanRecord, assertImportQueryTopicRecord } from '../services/import-query-contract'
import type { MigrationImplementation, SchemaReader } from './registry'

export function applyM18ImportQuery(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('MIGRATION_TRANSACTION_REQUIRED')
  db.exec(IMPORT_QUERY_TABLES_SQL)
}

export function verifyM18ImportQuery(db: Database.Database): boolean {
  try {
    for (const [table, fields] of [['import_query_plans', IMPORT_QUERY_PLAN_FIELDS],
      ['import_query_topics', IMPORT_QUERY_TOPIC_FIELDS]] as const) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (columns.length !== fields.length || columns.some((column, index) => column.name !== fields[index])) return false
      if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) return false
    }
    const plans = db.prepare('SELECT * FROM import_query_plans').all() as Array<Record<string, unknown>>
    const topics = db.prepare('SELECT * FROM import_query_topics').all() as Array<Record<string, unknown>>
    for (const plan of plans) {
      assertImportQueryPlanRecord(plan)
      if (plan.binding_json === null && (plan.manifest_fingerprint !== null || plan.binding_fingerprint !== null)) return false
      const children = topics.filter(topic => topic.import_root_run_id === plan.import_root_run_id)
      if (children.length !== 4 || new Set(children.map(topic => topic.topic_key)).size !== 4) return false
    }
    for (const topic of topics) {
      const plan = plans.find(item => item.import_root_run_id === topic.import_root_run_id)
      if (!plan) return false
      assertImportQueryTopicRecord(topic, { portable: plan.binding_json === null })
    }
    return !db.prepare(`SELECT 1 FROM import_query_plans p JOIN import_runs i ON i.id=p.import_root_run_id
      JOIN generation_runs r ON r.run_id=p.generation_run_id
      WHERE i.purpose<>'reference' OR i.root_run_id<>i.id OR r.root_action_id<>p.root_action_id LIMIT 1`).get()
  } catch { return false }
}

export function createM18Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M18', from: 18, to: 19, owner: 'import-query-materials',
    migrate: reader => applyM18ImportQuery(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM18ImportQuery(deps.database(reader)) }
}
