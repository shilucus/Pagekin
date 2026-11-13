import type Database from 'better-sqlite3'
import { assertReferenceImportGrantId } from '../../src/shared/reference-import-grant'
import { isContentHash } from '../../src/shared/source-ref'
import { assertReferenceEmbeddingDispatchRecord, EmbeddingDispatchBarrierError,
  type ReferenceEmbeddingDispatchRecord } from '../services/reference-embedding-dispatch-contract'
import { assertReferenceEmbeddingBudgetPlan, assertReferenceEmbeddingBudgetRecord, referenceEmbeddingBudgetFailure,
  REFERENCE_EMBEDDING_BUDGET_MS_PER_REQUEST, REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION,
  type ExecutableReferenceEmbeddingBudgetRecord, type ReferenceEmbeddingBudgetErrorCode,
  type ReferenceEmbeddingBudgetPlan, type ReferenceEmbeddingBudgetRecord } from '../services/reference-embedding-budget-contract'

/** Main-private identity only; a structurally identical object has no authority. */
export interface ReferenceEmbeddingBudgetCapability {
  readonly rootRunId: string
  readonly runId: string
  readonly manifestFingerprint: string
}
export interface ReferenceEmbeddingBudgetFlight extends ReferenceEmbeddingBudgetCapability {
  /** The owner calls this only after every request and settlement has drained. */
  finish(): void
}
export interface PrepareReferenceEmbeddingBudget {
  runId: string
  manifestFingerprint: string
  plan?: ReferenceEmbeddingBudgetPlan
}
export interface ReferenceEmbeddingBudgetRepositoryOptions {
  /** Native resource identity only: settlement must remain possible after grant revocation. */
  assertCurrent(): void
  isFrozen(rootRunId: string): boolean
  now?(): number
}

interface LocalRoot {
  flights: Set<ReferenceEmbeddingBudgetFlight>
  poison?: ReferenceEmbeddingBudgetErrorCode
  recoveryRequired?: boolean
  lastOpenClock?: number
}
interface CapabilityIdentity {
  database: Database.Database
  policy: string
  flight?: { pending: Set<ReferenceEmbeddingDispatchRecord>; finished: boolean }
}
const localDatabases = new WeakMap<Database.Database, Map<string, LocalRoot>>()
const capabilities = new WeakMap<object, CapabilityIdentity>()
const issuedMarks = new WeakMap<object, ReferenceEmbeddingBudgetFlight>()
const code = (suffix: string) => `KNOWLEDGE_BASE_REFERENCE_BUDGET_${suffix}` as ReferenceEmbeddingBudgetErrorCode
function fail(suffix: string): never { return referenceEmbeddingBudgetFailure(code(suffix)) }
const policyIdentity = (row: ExecutableReferenceEmbeddingBudgetRecord) => JSON.stringify([
  row.root_run_id, row.manifest_fingerprint, row.policy_version, row.initial_chunk_size,
  row.initial_chunk_overlap, row.initial_batch_size, row.request_limit, row.active_limit_ms,
])

function synchronous<T>(operation: () => T): T {
  if (Object.prototype.toString.call(operation) === '[object AsyncFunction]') fail('INVALID')
  const result = operation()
  if (result && (typeof result === 'object' || typeof result === 'function')
    && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {})
    fail('INVALID')
  }
  return result
}

/** Admission/settlement join the caller's transaction; preflight commits its own recovery fence. */
export class ReferenceEmbeddingBudgetRepository {
  constructor(private readonly database: Database.Database, private readonly options: ReferenceEmbeddingBudgetRepositoryOptions) {}

  private local(root: string): LocalRoot {
    let roots = localDatabases.get(this.database)
    if (!roots) { roots = new Map(); localDatabases.set(this.database, roots) }
    let value = roots.get(root)
    if (!value) { value = { flights: new Set() }; roots.set(root, value) }
    return value
  }
  private sql<T>(root: string, operation: () => T): T {
    try { return operation() }
    catch (error) {
      if (error instanceof EmbeddingDispatchBarrierError) throw error
      this.local(root).poison = code('PERSISTENCE_FAILED')
      return fail('PERSISTENCE_FAILED')
    }
  }
  private current(root: string, requireTransaction = true): void {
    if (!this.database.open || requireTransaction && !this.database.inTransaction) fail('INVALID')
    if (synchronous(this.options.assertCurrent) !== undefined) fail('INVALID')
    const frozen = synchronous(() => this.options.isFrozen(root))
    if (typeof frozen !== 'boolean') fail('INVALID')
    if (frozen) fail('HISTORY_FROZEN')
  }
  private resolve(runId: string): { rootRunId: string; manifestFingerprint: string } {
    try { assertReferenceImportGrantId(runId) } catch { fail('INVALID') }
    const row = this.sql(runId, () => this.database.prepare(
      'SELECT root_run_id,manifest_fingerprint,purpose,stage FROM import_runs WHERE id=?').get(runId)) as {
        root_run_id: string; manifest_fingerprint: string; purpose: string; stage: string
      } | undefined
    if (!row || row.purpose !== 'reference') fail('INVALID')
    try { assertReferenceImportGrantId(row.root_run_id) } catch { fail('INVALID') }
    const root = this.sql(row.root_run_id, () => this.database.prepare(
      'SELECT id,root_run_id,purpose FROM import_runs WHERE id=?').get(row.root_run_id)) as {
        id: string; root_run_id: string; purpose: string
      } | undefined
    if (!root || root.purpose !== 'reference' || root.id !== root.root_run_id) fail('INVALID')
    return { rootRunId: root.id, manifestFingerprint: row.manifest_fingerprint }
  }
  private verifyManifest(runId: string, expected: string): string {
    if (!isContentHash(expected) || expected === '0'.repeat(64)) fail('INVALID')
    const scope = this.resolve(runId)
    if (scope.manifestFingerprint !== expected) fail('PLAN_CONFLICT')
    // A restarted parsing ancestor may still hold its original zero placeholder.
    const conflict = this.sql(scope.rootRunId, () => this.database.prepare(`SELECT 1 FROM import_runs
      WHERE root_run_id=? AND (purpose<>'reference' OR
        (manifest_fingerprint<>? AND NOT(stage='parsing' AND manifest_fingerprint=?))) LIMIT 1`)
      .get(scope.rootRunId, expected, '0'.repeat(64)))
    if (conflict) fail('PLAN_CONFLICT')
    return scope.rootRunId
  }
  private read(root: string): ReferenceEmbeddingBudgetRecord | null {
    const raw = this.sql(root, () => this.database.prepare('SELECT * FROM reference_embedding_budgets WHERE root_run_id=?').get(root))
    if (!raw) return null
    assertReferenceEmbeddingBudgetRecord(raw)
    return Object.freeze({ ...raw })
  }
  private counts(root: string): { total: number; pending: number } {
    return this.sql(root, () => this.database.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN d.state='dispatch_marked' THEN 1 ELSE 0 END),0) AS pending
      FROM reference_embedding_dispatches d JOIN import_runs r ON r.id=d.import_run_id
      WHERE r.root_run_id=?`).get(root)) as { total: number; pending: number }
  }
  private assertUnstartedLineage(root: string): void {
    const history = this.sql(root, () => this.database.prepare(`SELECT 1 FROM import_runs r
      WHERE r.root_run_id=? AND (r.execution_epoch>0
        OR (r.stage NOT IN ('parsing','prepared') AND NOT(r.stage='knowledge' AND r.status='ready' AND r.execution_epoch=0))
        OR EXISTS(SELECT 1 FROM reference_import_grants g WHERE g.import_run_id=r.id)
        OR EXISTS(SELECT 1 FROM reference_embedding_dispatches d WHERE d.import_run_id=r.id)
        OR EXISTS(SELECT 1 FROM import_run_knowledge_receipts k WHERE k.run_id=r.id)
        OR EXISTS(SELECT 1 FROM import_run_receipts e WHERE e.run_id=r.id)) LIMIT 1`).get(root))
    if (history) fail('HISTORY_UNBUDGETED')
  }
  private recover(root: string): void {
    const local = this.local(root)
    local.recoveryRequired = true
    local.poison ??= code('RECOVERY_UNKNOWN')
    this.sql(root, () => this.database.prepare(
      "UPDATE reference_embedding_budgets SET state='recovery_unknown' WHERE root_run_id=? AND state='ready'").run(root))
    if (this.read(root)?.state !== 'recovery_unknown') {
      this.local(root).poison = code('PERSISTENCE_FAILED')
      fail('PERSISTENCE_FAILED')
    }
  }
  private clock(root: string): number {
    const now = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) { this.recover(root); return fail('RECOVERY_UNKNOWN') }
    return now
  }
  private executable(row: ReferenceEmbeddingBudgetRecord | null): ExecutableReferenceEmbeddingBudgetRecord {
    if (!row) return fail('REQUIRED')
    if (row.state === 'legacy_unbudgeted') return fail('HISTORY_UNBUDGETED')
    if (row.manifest_fingerprint === null) return fail('HISTORY_FROZEN')
    if (row.state === 'recovery_unknown') return fail('RECOVERY_UNKNOWN')
    return row
  }
  private identity(capability: ReferenceEmbeddingBudgetCapability, settlement = false): {
    identity: CapabilityIdentity; row: ExecutableReferenceEmbeddingBudgetRecord; local: LocalRoot
  } {
    const identity = capability && typeof capability === 'object' ? capabilities.get(capability) : undefined
    if (!identity || identity.database !== this.database || identity.flight?.finished) fail('INVALID')
    const { rootRunId } = capability
    this.current(rootRunId)
    if (this.resolve(capability.runId).rootRunId !== rootRunId) fail('INVALID')
    const value = this.read(rootRunId)
    if (!value) fail('REQUIRED')
    if (value.state === 'legacy_unbudgeted') fail('HISTORY_UNBUDGETED')
    if (value.manifest_fingerprint === null) fail('HISTORY_FROZEN')
    if (policyIdentity(value) !== identity.policy) fail('PLAN_CONFLICT')
    const local = this.local(rootRunId)
    if (!settlement) {
      if (local.poison) referenceEmbeddingBudgetFailure(local.poison)
      this.executable(value)
      this.verifyManifest(capability.runId, capability.manifestFingerprint)
      const counts = this.counts(rootRunId)
      if (counts.total !== value.spent_requests
        || (value.active_since_ms === null) !== (counts.pending === 0)
        || value.active_since_ms !== null && local.flights.size === 0) {
        this.recover(rootRunId)
        fail('RECOVERY_UNKNOWN')
      }
    }
    return { identity, row: value, local }
  }
  private elapsed(row: ExecutableReferenceEmbeddingBudgetRecord, local: LocalRoot, now: number): number {
    if (row.active_since_ms === null) return row.active_elapsed_ms
    if (now < row.active_since_ms || local.lastOpenClock !== undefined && now < local.lastOpenClock) {
      this.recover(row.root_run_id)
      return fail('RECOVERY_UNKNOWN')
    }
    local.lastOpenClock = now
    const elapsed = row.active_elapsed_ms + now - row.active_since_ms
    if (!Number.isSafeInteger(elapsed)) { this.recover(row.root_run_id); return fail('RECOVERY_UNKNOWN') }
    return elapsed
  }
  private checkTime(row: ExecutableReferenceEmbeddingBudgetRecord, local: LocalRoot): number {
    const now = this.clock(row.root_run_id)
    if (this.elapsed(row, local, now) >= row.active_limit_ms) fail('ACTIVE_TIME_EXHAUSTED')
    return now
  }

  /** Call outside the grant transaction: a recovery refusal must not roll its own durable fence back. */
  preflight(runId: string): void {
    if (!this.database.open || this.database.inTransaction) fail('INVALID')
    let refusal: ReferenceEmbeddingBudgetErrorCode | undefined
    const originalRoot = this.resolve(runId).rootRunId
    this.sql(originalRoot, () => this.database.transaction(() => {
      const { rootRunId } = this.resolve(runId)
      if (rootRunId !== originalRoot) fail('INVALID')
      this.current(rootRunId)
      const row = this.read(rootRunId)
      if (!row) return
      const local = this.local(rootRunId)
      if (row.state === 'legacy_unbudgeted') fail('HISTORY_UNBUDGETED')
      if (row.manifest_fingerprint === null) fail('HISTORY_FROZEN')
      if (row.state === 'recovery_unknown') { refusal = code('RECOVERY_UNKNOWN'); return }
      const counts = this.counts(rootRunId)
      const now = (this.options.now ?? Date.now)()
      const unknown = counts.total !== row.spent_requests
        || (row.active_since_ms === null) !== (counts.pending === 0)
        || row.active_since_ms !== null && (local.flights.size === 0
          || !Number.isSafeInteger(now) || now < row.active_since_ms
          || local.lastOpenClock !== undefined && now < local.lastOpenClock
          || !Number.isSafeInteger(row.active_elapsed_ms + now - row.active_since_ms))
      if (local.poison || unknown) {
        this.recover(rootRunId)
        refusal = local.poison
      } else if (row.active_since_ms !== null) local.lastOpenClock = now
      this.current(rootRunId)
    }).immediate())
    if (refusal) referenceEmbeddingBudgetFailure(refusal)
  }

  prepare(input: PrepareReferenceEmbeddingBudget): ReferenceEmbeddingBudgetCapability {
    const root = this.verifyManifest(input.runId, input.manifestFingerprint)
    this.current(root)
    let row = this.read(root)
    if (!row) {
      // Both current prepare constructors are unstarted; a legacy start/resume may not mint credit.
      this.assertUnstartedLineage(root)
      if (!input.plan) fail('REQUIRED')
      assertReferenceEmbeddingBudgetPlan(input.plan)
      const plan = input.plan
      this.sql(root, () => this.database.prepare(`INSERT INTO reference_embedding_budgets
        (root_run_id,manifest_fingerprint,policy_version,initial_chunk_size,initial_chunk_overlap,initial_batch_size,
         request_limit,active_limit_ms,spent_requests,active_elapsed_ms,active_since_ms,state)
        VALUES(?,?,?,?,?,?,?,?,0,0,NULL,'ready')`).run(root, input.manifestFingerprint,
        REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION, plan.chunkSize, plan.chunkOverlap, plan.batchSize,
        plan.requestLimit, plan.requestLimit * REFERENCE_EMBEDDING_BUDGET_MS_PER_REQUEST))
      row = this.read(root)
      if (!row) { this.local(root).poison = code('PERSISTENCE_FAILED'); fail('PERSISTENCE_FAILED') }
    }
    const ready = this.executable(row)
    if (ready.manifest_fingerprint !== input.manifestFingerprint) fail('PLAN_CONFLICT')
    const capability: ReferenceEmbeddingBudgetCapability = Object.freeze({ rootRunId: root,
      runId: input.runId, manifestFingerprint: input.manifestFingerprint })
    capabilities.set(capability, { database: this.database, policy: policyIdentity(ready) })
    this.assertEffect(capability)
    return capability
  }
  get(runId: string): ReferenceEmbeddingBudgetRecord | null {
    return this.read(this.resolve(runId).rootRunId)
  }
  assertEffect(capability: ReferenceEmbeddingBudgetCapability): void {
    const { row, local } = this.identity(capability)
    this.checkTime(row, local)
    // Equal is legal for committing the result of the final allowed request.
    if (row.spent_requests > row.request_limit) fail('EXHAUSTED')
  }
  openFlight(capability: ReferenceEmbeddingBudgetCapability): ReferenceEmbeddingBudgetFlight {
    const issue = () => {
      this.assertEffect(capability)
      const identity = capabilities.get(capability)!
      const pending = new Set<ReferenceEmbeddingDispatchRecord>()
      const state = { pending, finished: false }
      const flight: ReferenceEmbeddingBudgetFlight = Object.freeze({ ...capability, finish: () => {
        if (state.finished) fail('INVALID')
        for (const mark of pending) {
          // An outer admission rollback means no physical request was dispatched.
          const persisted = this.sql(capability.rootRunId, () => this.database.prepare(
            'SELECT state FROM reference_embedding_dispatches WHERE dispatch_id=?').get(mark.dispatch_id))
          if (!persisted) pending.delete(mark)
        }
        if (pending.size) fail('INVALID')
        state.finished = true
        this.local(capability.rootRunId).flights.delete(flight)
      } })
      capabilities.set(flight, { ...identity, flight: state })
      this.local(capability.rootRunId).flights.add(flight)
      return flight
    }
    return this.database.inTransaction ? issue() : this.database.transaction(issue).immediate()
  }
  beforeDispatch(flight: ReferenceEmbeddingBudgetFlight, markCallback: () => ReferenceEmbeddingDispatchRecord): ReferenceEmbeddingDispatchRecord {
    const { identity, row, local } = this.identity(flight)
    if (!identity.flight || !local.flights.has(flight)) fail('INVALID')
    const now = this.checkTime(row, local)
    if (row.spent_requests >= row.request_limit) fail('EXHAUSTED')
    let mark: ReferenceEmbeddingDispatchRecord
    try { mark = synchronous(markCallback) }
    catch (error) {
      if (error instanceof EmbeddingDispatchBarrierError && error.code.endsWith('PERSISTENCE_FAILED')) {
        local.poison = code('PERSISTENCE_FAILED')
      }
      throw error
    }
    assertReferenceEmbeddingDispatchRecord(mark)
    if (mark.import_run_id !== flight.runId || mark.state !== 'dispatch_marked' || issuedMarks.has(mark)) fail('INVALID')
    const persisted = this.sql(row.root_run_id, () => this.database.prepare(
      'SELECT * FROM reference_embedding_dispatches WHERE dispatch_id=?').get(mark.dispatch_id))
    assertReferenceEmbeddingDispatchRecord(persisted)
    if (Object.entries(mark).some(([key, value]) => persisted[key as keyof ReferenceEmbeddingDispatchRecord] !== value)) fail('INVALID')
    const changed = this.sql(row.root_run_id, () => this.database.prepare(`UPDATE reference_embedding_budgets
      SET spent_requests=spent_requests+1,active_since_ms=COALESCE(active_since_ms,?)
      WHERE root_run_id=? AND state='ready' AND spent_requests=?`).run(now, row.root_run_id, row.spent_requests))
    if (changed.changes !== 1 || this.counts(row.root_run_id).total !== row.spent_requests + 1) {
      local.poison = code('PERSISTENCE_FAILED'); fail('PERSISTENCE_FAILED')
    }
    const updated = this.read(row.root_run_id)
    if (!updated || updated.state !== 'ready' || policyIdentity(updated) !== identity.policy
      || updated.spent_requests !== row.spent_requests + 1 || updated.active_elapsed_ms !== row.active_elapsed_ms
      || updated.active_since_ms !== (row.active_since_ms ?? now)) {
      local.poison = code('PERSISTENCE_FAILED'); fail('PERSISTENCE_FAILED')
    }
    issuedMarks.set(mark, flight)
    identity.flight.pending.add(mark)
    local.lastOpenClock = now
    this.current(row.root_run_id)
    return mark
  }
  settle(flight: ReferenceEmbeddingBudgetFlight, mark: ReferenceEmbeddingDispatchRecord, settleCallback: () => void): void {
    const { identity, row, local } = this.identity(flight, true)
    if (!identity.flight || !local.flights.has(flight) || issuedMarks.get(mark) !== flight
      || !identity.flight.pending.has(mark)) fail('INVALID')
    try {
      if (synchronous(settleCallback) !== undefined) fail('INVALID')
      const settled = this.sql(row.root_run_id, () => this.database.prepare(
        'SELECT * FROM reference_embedding_dispatches WHERE dispatch_id=?').get(mark.dispatch_id))
      assertReferenceEmbeddingDispatchRecord(settled)
      if (settled.state === 'dispatch_marked' || settled.import_run_id !== mark.import_run_id
        || settled.document_id !== mark.document_id || settled.batch_ordinal !== mark.batch_ordinal
        || settled.input_count !== mark.input_count || settled.marked_at !== mark.marked_at) fail('INVALID')
      if (row.state === 'recovery_unknown') return
      // A prior refusal's outer transaction may have rolled back its fence, but not the clock uncertainty.
      if (local.recoveryRequired) {
        this.recover(row.root_run_id)
        return
      }
      const now = (this.options.now ?? Date.now)()
      // Outcome settlement must survive a clock anomaly; only future effects are fenced.
      if (!Number.isSafeInteger(now) || now < 0 || row.active_since_ms === null
        || now < row.active_since_ms || local.lastOpenClock !== undefined && now < local.lastOpenClock
        || !Number.isSafeInteger(row.active_elapsed_ms + now - row.active_since_ms)) {
        this.recover(row.root_run_id)
        return
      }
      local.lastOpenClock = now
      if (this.counts(row.root_run_id).pending === 0) {
        const elapsed = row.active_elapsed_ms + now - row.active_since_ms
        const changed = this.sql(row.root_run_id, () => this.database.prepare(`UPDATE reference_embedding_budgets
          SET active_elapsed_ms=?,active_since_ms=NULL WHERE root_run_id=? AND state='ready'`)
          .run(elapsed, row.root_run_id))
        if (changed.changes !== 1) { local.poison = code('PERSISTENCE_FAILED'); fail('PERSISTENCE_FAILED') }
        const updated = this.read(row.root_run_id)
        if (!updated || updated.state !== 'ready' || policyIdentity(updated) !== identity.policy
          || updated.spent_requests !== row.spent_requests || updated.active_elapsed_ms !== elapsed
          || updated.active_since_ms !== null) {
          local.poison = code('PERSISTENCE_FAILED'); fail('PERSISTENCE_FAILED')
        }
        local.lastOpenClock = undefined
      }
      this.current(row.root_run_id)
    } catch (error) {
      local.poison ??= code('PERSISTENCE_FAILED')
      throw error
    } finally {
      identity.flight.pending.delete(mark)
      issuedMarks.delete(mark)
    }
  }
}
