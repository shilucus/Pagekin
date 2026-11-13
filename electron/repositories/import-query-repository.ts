import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { assertImportQueryBinding, assertImportQueryPlanRecord, assertImportQueryReceipt, assertImportQueryTopicRecord,
  importQueryContextFingerprint, importQueryFailure, importQueryHash, importQueryId, ImportQueryBarrierError,
  IMPORT_QUERY_TOPIC_KEYS, type EmbeddingRequestOutcome, type ImportQueryFlight, type ImportQueryPlan,
  type ImportQueryPlanRecord, type ImportQueryReceipt, type ImportQueryRepositoryOptions,
  type ImportQueryTopic, type ImportQueryTopicRecord, type PrepareImportQuery } from '../services/import-query-contract'
import { assertEmbeddingRequestOutcome } from '../services/reference-embedding-dispatch-contract'
import { isContentHash } from '../../src/shared/source-ref'
import type { ImportGenerationContext } from '../../src/shared/import-generation'
export type { ImportQueryFlight, ImportQueryRepositoryOptions, PrepareImportQuery } from '../services/import-query-contract'

interface FlightIdentity {
  database: Database.Database
  plan: ImportQueryPlan
  marked: boolean
  closed: boolean
  release?: () => void
}
const flights = new WeakMap<object, FlightIdentity>()
const nativeQueries = new WeakMap<Database.Database, Map<string, ImportQueryFlight>>()
function fail(suffix: 'REQUIRED' | 'INVALID' | 'PLAN_CONFLICT' | 'ROOT_CHANGED' | 'RECOVERY_UNKNOWN'
  | 'RECEIPT_INVALID' | 'PERSISTENCE_FAILED' | 'HISTORY_FROZEN'): never {
  return importQueryFailure(`GENERATION_IMPORT_QUERY_${suffix}`)
}
function sync(operation: () => void): void {
  if (Object.prototype.toString.call(operation) === '[object AsyncFunction]') fail('INVALID')
  const result: unknown = operation()
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {})
    fail('INVALID')
  }
}

export class ImportQueryRepository {
  constructor(private readonly database: Database.Database, private readonly options: ImportQueryRepositoryOptions) {
    options.runs.assertDatabaseIdentity(database)
  }
  private native(): Map<string, ImportQueryFlight> {
    let value = nativeQueries.get(this.database)
    if (!value) { value = new Map(); nativeQueries.set(this.database, value) }
    return value
  }
  private resources(): void {
    this.options.runs.assertDatabaseIdentity(this.database)
    if (this.options.assertResources) sync(this.options.assertResources)
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_query_topics'").get()) fail('REQUIRED')
  }
  private now(): number {
    const value = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(value) || value < 0) fail('INVALID')
    return value
  }
  private storage<T>(root: string, operation: () => T): T {
    try { return operation() }
    catch (error) {
      if (error instanceof ImportQueryBarrierError || error instanceof Error && /^(GENERATION_|IMPORT_RUN_|ROOT_BUDGET_)/u.test(error.message)) throw error
      this.options.runs.poisonPhysicalActivity(root, 'GENERATION_IMPORT_QUERY_PERSISTENCE_FAILED')
      return fail('PERSISTENCE_FAILED')
    }
  }
  private resolve(importRunId: string): { root: string; manifest: string } {
    this.resources()
    const row = this.database.prepare('SELECT root_run_id,purpose,manifest_fingerprint FROM import_runs WHERE id=?').get(importRunId) as
      { root_run_id: string; purpose: string; manifest_fingerprint: string } | undefined
    if (!row || row.purpose !== 'reference' || !isContentHash(row.manifest_fingerprint)) fail('INVALID')
    const root = this.database.prepare('SELECT root_run_id,purpose FROM import_runs WHERE id=?').get(row.root_run_id) as
      { root_run_id: string; purpose: string } | undefined
    if (!root || root.purpose !== 'reference' || root.root_run_id !== row.root_run_id) fail('INVALID')
    return { root: row.root_run_id, manifest: row.manifest_fingerprint }
  }
  private mutable(root: string): void {
    if (this.options.freeze?.isFrozen('import_query_plans', root)) fail('HISTORY_FROZEN')
  }
  private read(root: string): ImportQueryPlan | null {
    this.mutable(root)
    const record = this.database.prepare('SELECT * FROM import_query_plans WHERE import_root_run_id=?').get(root) as ImportQueryPlanRecord | undefined
    if (!record) {
      if (this.database.prepare('SELECT 1 FROM import_query_topics WHERE import_root_run_id=? LIMIT 1').get(root)) fail('INVALID')
      return null
    }
    assertImportQueryPlanRecord(record)
    if (!record.binding_json || !record.binding_fingerprint || !record.manifest_fingerprint) fail('HISTORY_FROZEN')
    const binding = JSON.parse(record.binding_json)
    assertImportQueryBinding(binding)
    const rows = this.database.prepare('SELECT * FROM import_query_topics WHERE import_root_run_id=?').all(root) as ImportQueryTopicRecord[]
    if (rows.length !== 4) fail('INVALID')
    for (const row of rows) {
      assertImportQueryTopicRecord(row)
      if (this.options.freeze?.isFrozen('import_query_topics', row.query_id)) fail('HISTORY_FROZEN')
      if (row.state === 'completed' && row.receipt_fingerprint === null) fail('RECEIPT_INVALID')
    }
    const topics = IMPORT_QUERY_TOPIC_KEYS.map(key => {
      const row = rows.find(row => row.topic_key === key)
      if (!row) return fail('INVALID')
      return row
    })
    const owner = this.options.runs.get(record.generation_run_id)
    if (owner.rootActionId !== record.root_action_id) fail('ROOT_CHANGED')
    return { record, binding, topics }
  }
  get(importRunId: string): ImportQueryPlan | null {
    const identity = this.resolve(importRunId), plan = this.read(identity.root)
    if (plan && plan.record.manifest_fingerprint !== identity.manifest) fail('PLAN_CONFLICT')
    return plan
  }
  private current(plan: ImportQueryPlan): ImportQueryPlan {
    this.resources()
    const latest = this.read(plan.record.import_root_run_id)
    if (!latest || latest.record.root_action_id !== plan.record.root_action_id
      || latest.record.binding_fingerprint !== plan.record.binding_fingerprint) fail('PLAN_CONFLICT')
    if (latest.record.state !== 'ready') fail('RECOVERY_UNKNOWN')
    if (latest.topics.some(row => row.marked_at_ms !== null && row.state !== 'completed' && !this.native().has(row.query_id))) {
      this.quarantine(latest)
      fail('RECOVERY_UNKNOWN')
    }
    return latest
  }
  private topic(plan: ImportQueryPlan, topic: ImportQueryTopic): ImportQueryTopicRecord {
    const row = plan.topics.find(row => row.topic_key === topic)
    if (!row) return fail('INVALID')
    return row
  }
  private quarantine(plan: ImportQueryPlan): void {
    this.database.prepare("UPDATE import_query_plans SET state='recovery_unknown' WHERE import_root_run_id=?").run(plan.record.import_root_run_id)
    this.options.runs.poisonPhysicalActivity(plan.record.root_action_id)
  }
  preflight(importRunId: string): void {
    this.resources()
    if (this.database.inTransaction) fail('INVALID')
    const plan = this.get(importRunId)
    if (!plan) return
    this.storage(plan.record.root_action_id, () => this.database.transaction(() => {
      if (plan.topics.some(row => row.marked_at_ms !== null && row.state !== 'completed' && !this.native().has(row.query_id))) this.quarantine(plan)
    }).immediate())
    // This owns a separate short transaction; refusal must not roll the durable fence back.
    this.options.runs.preflightPhysicalActivity(plan.record.root_action_id)
    if (this.read(plan.record.import_root_run_id)?.record.state !== 'ready') fail('RECOVERY_UNKNOWN')
  }
  prepare(input: PrepareImportQuery): ImportQueryPlan {
    if (!this.database.inTransaction) this.preflight(input.importRunId)
    const identity = this.resolve(input.importRunId)
    assertImportQueryBinding(input.binding)
    return this.storage(this.options.runs.get(input.generationRunId).rootActionId, () => this.database.transaction(() => {
      sync(input.assertCurrent)
      this.resources()
      const run = this.options.runs.get(input.generationRunId)
      const slot = run.binding.sourceManifest.importSlot as { runId?: string; stage?: string; batchId?: string } | undefined
      const context = run.binding.sourceManifest.importContext as ImportGenerationContext | undefined
      if (!slot || slot.runId !== input.importRunId || slot.stage !== 'global' || slot.batchId !== input.binding.slot.batchId
        || !context || importQueryContextFingerprint(context) !== input.binding.contextFingerprint
        || context.core.writingLanguage !== input.binding.slot.writingLanguage) fail('PLAN_CONFLICT')
      this.mutable(identity.root)
      const existing = this.read(identity.root)
      if (existing) {
        if (existing.record.root_action_id !== run.rootActionId) fail('ROOT_CHANGED')
        const completed = existing.topics.every(row => row.state === 'completed')
        const expected = completed ? { ...input.binding, configurationFingerprint: existing.binding.configurationFingerprint } : input.binding
        if (existing.record.manifest_fingerprint !== identity.manifest || !isDeepStrictEqual(existing.binding, expected)) fail('PLAN_CONFLICT')
        if (existing.record.state !== 'ready') fail('RECOVERY_UNKNOWN')
        return existing
      }
      this.options.runs.assertAuxiliaryEffect(run.rootActionId)
      const binding = JSON.stringify(input.binding)
      this.database.prepare('INSERT INTO import_query_plans VALUES(?,?,?,?,?,?,?,?)').run(identity.root,
        run.runId, run.rootActionId, identity.manifest, binding, importQueryHash(binding), 'ready', this.now())
      const insert = this.database.prepare("INSERT INTO import_query_topics VALUES(?,?,?,'prepared',NULL,NULL,NULL,NULL,NULL,NULL)")
      for (const topic of IMPORT_QUERY_TOPIC_KEYS) insert.run(importQueryId(identity.root, topic), identity.root, topic)
      const created = this.read(identity.root)
      if (!created) return fail('INVALID')
      return created
    }).immediate())
  }
  assertDispatch(plan: ImportQueryPlan, topic: ImportQueryTopic): void {
    const current = this.current(plan), row = this.topic(current, topic)
    if (row.state !== 'prepared' || row.marked_at_ms !== null) fail('RECOVERY_UNKNOWN')
    this.options.runs.assertAuxiliaryEffect(current.record.root_action_id)
  }
  openFlight(plan: ImportQueryPlan, topic: ImportQueryTopic): ImportQueryFlight {
    this.assertDispatch(plan, topic)
    const queryId = importQueryId(plan.record.import_root_run_id, topic)
    if (this.native().has(queryId)) fail('INVALID')
    const flight = Object.freeze({ queryId, importRootRunId: plan.record.import_root_run_id,
      rootActionId: plan.record.root_action_id, topic })
    flights.set(flight, { database: this.database, plan, marked: false, closed: false })
    this.native().set(queryId, flight)
    return flight
  }
  private flight(flight: ImportQueryFlight, settlement = false): FlightIdentity {
    const identity = flights.get(flight)
    if (!identity || identity.database !== this.database) fail('INVALID')
    if (settlement) this.options.runs.assertDatabaseIdentity(this.database)
    else this.resources()
    this.mutable(flight.importRootRunId)
    return identity
  }
  beforeDispatch(flight: ImportQueryFlight, assertCurrent: () => void): void {
    const identity = this.flight(flight)
    if (identity.marked || identity.closed) fail('INVALID')
    this.storage(flight.rootActionId, () => {
      identity.release = this.options.runs.markAuxiliaryDispatch(identity.plan.record.generation_run_id, flight.queryId, () => {
        sync(assertCurrent)
        this.assertDispatch(identity.plan, flight.topic)
        const marked = this.database.prepare("UPDATE import_query_topics SET state='dispatch_marked',marked_at_ms=? WHERE query_id=? AND state='prepared' AND marked_at_ms IS NULL")
          .run(this.now(), flight.queryId)
        if (marked.changes !== 1) fail('RECOVERY_UNKNOWN')
      })
      identity.marked = true
    })
  }
  settle(flight: ImportQueryFlight, outcome: EmbeddingRequestOutcome): void {
    const identity = this.flight(flight, true)
    assertEmbeddingRequestOutcome(outcome)
    if (!identity.marked) fail('INVALID')
    this.storage(flight.rootActionId, () => this.database.transaction(() => {
      const row = this.database.prepare('SELECT * FROM import_query_topics WHERE query_id=?').get(flight.queryId) as ImportQueryTopicRecord
      assertImportQueryTopicRecord(row)
      const json = JSON.stringify(outcome)
      if (row.outcome_json !== null) { if (row.outcome_json !== json) fail('PLAN_CONFLICT'); return }
      this.database.prepare('UPDATE import_query_topics SET outcome_json=?,settled_at_ms=?,state=? WHERE query_id=?').run(json,
        this.now(), outcome.kind === 'transport_unknown' ? 'unknown' : 'dispatch_marked', flight.queryId)
      if (outcome.kind === 'transport_unknown') this.quarantine(identity.plan)
      // budget() detects clock rollback without throwing away the factual outcome above.
      this.options.runs.budget(flight.rootActionId)
    }).immediate())
  }
  releasePhysical(flight: ImportQueryFlight): void {
    const identity = this.flight(flight, true)
    if (identity.closed) return
    if (!identity.marked) { identity.closed = true; this.native().delete(flight.queryId); return }
    try {
      this.storage(flight.rootActionId, () => this.database.transaction(() => {
        this.database.prepare('UPDATE import_query_topics SET physical_closed_at_ms=? WHERE query_id=? AND physical_closed_at_ms IS NULL')
          .run(this.now(), flight.queryId)
        this.options.runs.budget(flight.rootActionId)
      }).immediate())
    } finally { identity.closed = true; identity.release?.() }
  }
  readReceipt(plan: ImportQueryPlan, topic: ImportQueryTopic): ImportQueryReceipt | null {
    const row = this.topic(this.current(plan), topic)
    if (row.state !== 'completed') return null
    if (!row.receipt_json || row.receipt_fingerprint !== importQueryHash(row.receipt_json)) fail('RECEIPT_INVALID')
    const receipt = JSON.parse(row.receipt_json)
    assertImportQueryReceipt(receipt)
    return receipt
  }
  complete(plan: ImportQueryPlan, topic: ImportQueryTopic, receipt: ImportQueryReceipt,
    assertCurrent: () => void): ImportQueryReceipt {
    assertImportQueryReceipt(receipt)
    return this.storage(plan.record.root_action_id, () => this.database.transaction(() => {
      sync(assertCurrent)
      const latest = this.current(plan), row = this.topic(latest, topic)
      const existing = this.readReceipt(latest, topic)
      if (existing) { if (!isDeepStrictEqual(existing, receipt)) fail('PLAN_CONFLICT'); return existing }
      this.options.runs.assertAuxiliaryEffect(latest.record.root_action_id)
      if (receipt.state === 'available' && receipt.snapshot.query !== latest.binding.topics.find(t => t.key === topic)?.query) fail('PLAN_CONFLICT')
      if (row.state === 'unknown' || row.marked_at_ms !== null && (row.outcome_json === null || row.physical_closed_at_ms === null
        || (JSON.parse(row.outcome_json) as EmbeddingRequestOutcome).kind === 'transport_unknown')) fail('RECOVERY_UNKNOWN')
      const json = JSON.stringify(receipt)
      const committed = this.database.prepare("UPDATE import_query_topics SET state='completed',receipt_json=?,receipt_fingerprint=? WHERE query_id=? AND state<>'completed'")
        .run(json, importQueryHash(json), row.query_id)
      if (committed.changes !== 1) fail('PERSISTENCE_FAILED')
      this.native().delete(row.query_id)
      return structuredClone(receipt)
    }).immediate())
  }
}
