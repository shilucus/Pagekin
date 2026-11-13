import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBaselineTables } from '../../migrations/baseline-schema'
import { applyM14ReferenceImportGrants } from '../../migrations/m14-reference-import-grants'
import { applyM16ReferenceEmbeddingDispatches } from '../../migrations/m16-reference-embedding-dispatches'
import { applyM17ReferenceEmbeddingBudgets } from '../../migrations/m17-reference-embedding-budgets'
import { assertReferenceEmbeddingBudgetPlan, assertReferenceEmbeddingBudgetRecord,
  REFERENCE_EMBEDDING_BUDGET_FIELDS, REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION,
  type ReferenceEmbeddingBudgetPlan } from '../../services/reference-embedding-budget-contract'
import type { EmbeddingRequestOutcome, ReferenceEmbeddingDispatchRecord } from '../../services/reference-embedding-dispatch-contract'
import { ReferenceEmbeddingBudgetRepository, type ReferenceEmbeddingBudgetFlight } from '../reference-embedding-budget-repository'
import { ReferenceEmbeddingDispatchRepository } from '../reference-embedding-dispatch-repository'

const handles: Database.Database[] = []
const manifest = 'c'.repeat(64), documentA = 'a'.repeat(64), documentB = 'b'.repeat(64)
const plan: ReferenceEmbeddingBudgetPlan = { chunkSize: 500, chunkOverlap: 50, batchSize: 2, requestLimit: 4 }
afterEach(() => { vi.restoreAllMocks(); for (const db of handles.splice(0)) if (db.open) db.close() })

function insertRun(db: Database.Database, runId = 'run-A', rootRunId = runId, fingerprint = manifest) {
  db.prepare(`INSERT INTO import_runs
    (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,total_chapters,manifest_chapter_count)
    VALUES(?,'reference',?,?,?,?,'en-US','prepared','ready',1,1)`)
    .run(runId, rootRunId, `import:reference:${runId}`, 'd'.repeat(64), fingerprint)
}
function insertDocument(db: Database.Database, documentId: string) {
  db.prepare(`INSERT INTO import_reference_documents
    (document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state)
    VALUES(?,?,?,?,4,'reference','prepared')`).run(documentId, documentId, 'e'.repeat(64), 'f'.repeat(64))
}
function fixture(requestLimit = 4) {
  const db = new Database(':memory:'); handles.push(db)
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.transaction(() => {
    applyM14ReferenceImportGrants(db)
    applyM16ReferenceEmbeddingDispatches(db)
    applyM17ReferenceEmbeddingBudgets(db)
  })()
  insertRun(db); insertDocument(db, documentA); insertDocument(db, documentB)
  let now = 100, frozen = false
  const options = { assertCurrent: vi.fn(() => {}), isFrozen: () => frozen, now: () => now }
  const repository = new ReferenceEmbeddingBudgetRepository(db, options)
  const recorder = new ReferenceEmbeddingDispatchRepository(db, options)
  const tx = <T>(operation: () => T) => db.transaction(operation).immediate()
  const prepare = (runId = 'run-A', nextPlan: ReferenceEmbeddingBudgetPlan | undefined = { ...plan, requestLimit }) => tx(() => repository.prepare({
    runId, manifestFingerprint: manifest, ...(nextPlan ? { plan: nextPlan } : {}),
  }))
  const capability = prepare()
  const dispatch = (flight: ReferenceEmbeddingBudgetFlight, ordinal: number, documentId = documentA) => tx(() => repository.beforeDispatch(flight,
    () => recorder.mark({ runId: flight.runId, documentId, batchOrdinal: ordinal, inputCount: 1 })))
  const settle = (flight: ReferenceEmbeddingBudgetFlight, mark: ReferenceEmbeddingDispatchRecord,
    outcome: EmbeddingRequestOutcome = { kind: 'response_received', httpStatus: 200 }) => tx(() => repository.settle(flight, mark,
    () => recorder.settle(mark, outcome)))
  return { db, options, repository, recorder, tx, prepare, capability, dispatch, settle,
    time(value: number) { now = value }, freeze() { frozen = true } }
}

describe('reference embedding budget contract', () => {
  it('freezes the exact twelve fields and existing application time unit without a 32-request floor', () => {
    const f = fixture(1), row = f.repository.get('run-A')!
    expect(Object.keys(row)).toEqual([...REFERENCE_EMBEDDING_BUDGET_FIELDS])
    expect(row).toMatchObject({ request_limit: 1, active_limit_ms: 112_500, spent_requests: 0,
      active_elapsed_ms: 0, active_since_ms: null, policy_version: REFERENCE_EMBEDDING_BUDGET_POLICY_VERSION })
    expect(() => assertReferenceEmbeddingBudgetRecord(row)).not.toThrow()
  })
  it.each([
    { requestLimit: 0 }, { requestLimit: 0.5 }, { requestLimit: Number.MAX_SAFE_INTEGER },
    { chunkSize: 99 }, { chunkOverlap: 500 }, { batchSize: 51 }, { batchSize: 0 },
  ])('rejects unnormalized or unsafe plans: %j', change => {
    expect(() => assertReferenceEmbeddingBudgetPlan({ ...plan, ...change })).toThrow('BUDGET_INVALID')
  })
  it('allows a null portable manifest only as history and refuses extra or missing fields', () => {
    const f = fixture(), row = f.repository.get('run-A')!
    expect(() => assertReferenceEmbeddingBudgetRecord({ ...row, manifest_fingerprint: null })).not.toThrow()
    expect(() => assertReferenceEmbeddingBudgetRecord({ ...row, extra: 1 })).toThrow('BUDGET_INVALID')
    const { active_limit_ms: omitted, ...missing } = row
    expect(omitted).toBe(450_000)
    expect(() => assertReferenceEmbeddingBudgetRecord(missing)).toThrow('BUDGET_INVALID')
    expect(() => assertReferenceEmbeddingBudgetRecord({ ...row, active_limit_ms: 1 })).toThrow('BUDGET_INVALID')
  })
})

describe('reference embedding budget repository', () => {
  it.each(['epoch', 'stage', 'active-grant', 'completed-grant', 'revoked-grant', 'dispatch', 'receipt', 'effect'].flatMap(mode =>
    [false, true].map(descendant => ({ mode, descendant }))))(
    'refuses a first allocation after unbudgeted $mode on descendant=$descendant', ({ mode, descendant }) => {
      const f = fixture()
      insertRun(f.db, 'unbudgeted-root'); insertRun(f.db, 'unbudgeted-child', 'unbudgeted-root')
      f.db.exec("UPDATE import_runs SET stage='knowledge' WHERE root_run_id='unbudgeted-root'")
      const evidenceRun = descendant ? 'unbudgeted-child' : 'unbudgeted-root'
      const requestedRun = descendant ? 'unbudgeted-root' : 'unbudgeted-child'
      if (mode === 'epoch') f.db.prepare('UPDATE import_runs SET execution_epoch=1 WHERE id=?').run(evidenceRun)
      else if (mode === 'stage') f.db.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(evidenceRun)
      else if (mode.endsWith('-grant')) {
        const state = mode.replace('-grant', '')
        f.db.prepare(`INSERT INTO reference_import_grants VALUES(?,?,?,?,?,'reference-import-v1',?,?,?,'author-action',100,?,?)`)
          .run(randomUUID(), randomUUID(), 'fictional-project', evidenceRun, state === 'revoked' ? 2 : 1,
            manifest, manifest, state, state === 'completed' ? 101 : null, state === 'revoked' ? 101 : null)
      } else if (mode === 'dispatch') f.tx(() => f.recorder.mark({ runId: evidenceRun,
        documentId: documentA, batchOrdinal: 0, inputCount: 1 }))
      else if (mode === 'receipt') {
        f.db.prepare(`INSERT INTO import_run_chapters(run_id,chapter_number,content_fingerprint,content_size,content_snapshot)
          VALUES(?,1,?,9,'Fictional')`).run(evidenceRun, manifest)
        f.db.prepare(`INSERT INTO import_run_knowledge_receipts
          (run_id,chapter_number,purpose,source_id,source_chapter_number,content_fingerprint,document_id,state)
          VALUES(?,1,'reference','fictional-source',1,?,?,'committed')`).run(evidenceRun, manifest, documentA)
      } else {
        f.db.prepare(`INSERT INTO import_run_receipts
          (run_id,effect_namespace,effect_key,stage,batch_id,kind,payload_json,payload_hash,state)
          VALUES(?,?,?,'global','done','project-global-facts','{}',?,'prepared')`)
          .run(evidenceRun, `import:reference:${evidenceRun}`, 'global-facts', manifest)
      }
      expect(() => f.prepare(requestedRun)).toThrow('BUDGET_HISTORY_UNBUDGETED')
      expect(f.repository.get('unbudgeted-root')).toBeNull()
      expect(f.repository.get('unbudgeted-child')).toBeNull()
      expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 0, request_limit: 4 })
    },
  )
  it.each([false, true])('accepts the current direct prepare knowledge/ready/epoch0 shape on descendant=%s', descendant => {
    const f = fixture()
    insertRun(f.db, 'direct-root')
    const runId = descendant ? 'direct-child' : 'direct-root'
    if (descendant) insertRun(f.db, runId, 'direct-root')
    f.db.prepare("UPDATE import_runs SET stage='knowledge' WHERE id=?").run(runId)
    expect(f.db.prepare('SELECT stage,status,execution_epoch FROM import_runs WHERE id=?').get(runId))
      .toEqual({ stage: 'knowledge', status: 'ready', execution_epoch: 0 })
    expect(f.prepare(runId).rootRunId).toBe('direct-root')
    expect(f.repository.get(runId)).toMatchObject({ state: 'ready', spent_requests: 0, request_limit: 4 })
  })
  it.each(['failed', 'running', 'cancelled', 'completed'].flatMap(status =>
    [false, true].map(descendant => ({ status, descendant }))))(
    'refuses knowledge/$status/epoch0 on descendant=$descendant without pretending it is fresh', ({ status, descendant }) => {
      const f = fixture()
      insertRun(f.db, 'nonfresh-root'); insertRun(f.db, 'nonfresh-child', 'nonfresh-root')
      f.db.prepare("UPDATE import_runs SET stage='knowledge',status=? WHERE id=?")
        .run(status, descendant ? 'nonfresh-child' : 'nonfresh-root')
      expect(() => f.prepare(descendant ? 'nonfresh-root' : 'nonfresh-child')).toThrow('BUDGET_HISTORY_UNBUDGETED')
      expect(f.repository.get('nonfresh-root')).toBeNull()
    },
  )
  it('can freeze the first plan before managed start in the same transaction without rejecting later execution', () => {
    const f = fixture()
    insertRun(f.db, 'managed-root')
    const capability = f.tx(() => {
      const issued = f.repository.prepare({ runId: 'managed-root', manifestFingerprint: manifest, plan })
      f.db.exec("UPDATE import_runs SET execution_epoch=1,stage='knowledge' WHERE id='managed-root'")
      return issued
    })
    expect(() => f.tx(() => f.repository.assertEffect(capability))).not.toThrow()
    expect(f.prepare('managed-root', { ...plan, requestLimit: 100 }).rootRunId).toBe('managed-root')
    expect(f.repository.get('managed-root')).toMatchObject({ spent_requests: 0, request_limit: 4 })
  })
  it('does not replan on a new explicit prepare, changed options or a restarted descendant', () => {
    const f = fixture(2), before = f.repository.get('run-A')
    insertRun(f.db, 'run-B', 'run-A')
    const descendant = f.prepare('run-B', { chunkSize: 100, chunkOverlap: 0, batchSize: 1, requestLimit: 100 })
    expect(descendant).toMatchObject({ rootRunId: 'run-A', runId: 'run-B' })
    expect(f.repository.get('run-B')).toEqual(before)
    const flight = f.repository.openFlight(descendant)
    const mark = f.dispatch(flight, 0, documentB)
    f.settle(flight, mark); flight.finish()
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 1, request_limit: 2 })
    expect(f.tx(() => f.repository.prepare({ runId: 'run-B', manifestFingerprint: manifest })).rootRunId).toBe('run-A')
  })
  it('rejects changed actual manifest and cannot bind an independent root to another root capability', () => {
    const f = fixture()
    insertRun(f.db, 'run-B', 'run-A', 'e'.repeat(64))
    expect(() => f.prepare('run-B')).toThrow('BUDGET_PLAN_CONFLICT')
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_PLAN_CONFLICT')
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 0 })
  })
  it('permits the zero-manifest parsing ancestor while freezing the actual descendant manifest', () => {
    const f = fixture()
    f.db.prepare("UPDATE import_runs SET manifest_fingerprint=?,stage='parsing' WHERE id='run-A'").run('0'.repeat(64))
    insertRun(f.db, 'run-B', 'run-A')
    expect(f.prepare('run-B').rootRunId).toBe('run-A')
    expect(f.repository.get('run-B')).toMatchObject({ manifest_fingerprint: manifest, request_limit: 4 })
  })
  it('atomically spends the last shared slot and permits its result to commit', () => {
    const f = fixture(1), first = f.repository.openFlight(f.capability), second = f.repository.openFlight(f.capability)
    const mark = f.dispatch(first, 0)
    const forbiddenMark = vi.fn(() => f.recorder.mark({ runId: 'run-A', documentId: documentB, batchOrdinal: 0, inputCount: 1 }))
    expect(() => f.tx(() => f.repository.beforeDispatch(second, forbiddenMark))).toThrow('BUDGET_EXHAUSTED')
    expect(forbiddenMark).not.toHaveBeenCalled()
    f.time(150); f.settle(first, mark)
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).not.toThrow()
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 1, active_elapsed_ms: 50 })
    first.finish(); second.finish()
  })
  it('counts overlapping flights once, excludes idle waits and keeps cumulative intervals', () => {
    const f = fixture(), first = f.repository.openFlight(f.capability), second = f.repository.openFlight(f.capability)
    const one = f.dispatch(first, 0)
    f.time(130); const two = f.dispatch(second, 1)
    f.time(180); f.settle(second, two); second.finish()
    expect(f.repository.get('run-A')).toMatchObject({ active_elapsed_ms: 0, active_since_ms: 100 })
    f.time(200); f.settle(first, one); first.finish()
    expect(f.repository.get('run-A')).toMatchObject({ active_elapsed_ms: 100, active_since_ms: null })
    f.time(1000); const third = f.repository.openFlight(f.capability), three = f.dispatch(third, 2)
    f.time(1050); f.settle(third, three); third.finish()
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 3, active_elapsed_ms: 150, active_since_ms: null })
  })
  it('rolls back mark and debit together when the outer admission rejects', () => {
    const f = fixture(1), flight = f.repository.openFlight(f.capability)
    expect(() => f.tx(() => { f.repository.beforeDispatch(flight, () => f.recorder.mark({
      runId: 'run-A', documentId: documentA, batchOrdinal: 0, inputCount: 1,
    })); throw new Error('FICTIONAL_ADMISSION_POSTCHECK') })).toThrow('FICTIONAL_ADMISSION_POSTCHECK')
    expect(f.db.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 0, active_since_ms: null })
    flight.finish()
    const replacement = f.repository.openFlight(f.capability), mark = f.dispatch(replacement, 0)
    f.settle(replacement, mark); replacement.finish()
  })
  it.each([
    { kind: 'response_received', httpStatus: 200 }, { kind: 'http_failed', httpStatus: 429 },
    { kind: 'response_invalid', httpStatus: 200 }, { kind: 'transport_unknown' },
  ] satisfies EmbeddingRequestOutcome[])('settles $kind without refunding requests or requiring grant authority', outcome => {
    const f = fixture(1), flight = f.repository.openFlight(f.capability), mark = f.dispatch(flight, 0)
    f.db.prepare("UPDATE import_runs SET cancel_requested=1,execution_epoch=execution_epoch+1 WHERE id='run-A'").run()
    f.time(120); f.settle(flight, mark, outcome); flight.finish()
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 1, active_elapsed_ms: 20, active_since_ms: null })
    expect(f.db.prepare('SELECT state FROM reference_embedding_dispatches').pluck().get()).toBe(outcome.kind)
  })
  it('denies a new effect at the exact active cap after truthfully settling the response', () => {
    const f = fixture(1), flight = f.repository.openFlight(f.capability), mark = f.dispatch(flight, 0)
    f.time(112_600); f.settle(flight, mark); flight.finish()
    expect(f.repository.get('run-A')).toMatchObject({ active_elapsed_ms: 112_500, spent_requests: 1 })
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_ACTIVE_TIME_EXHAUSTED')
    expect(() => f.prepare()).toThrow('BUDGET_ACTIVE_TIME_EXHAUSTED')
  })
  it('retains a clock-rollback response and fences the open root without inventing elapsed time', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability), mark = f.dispatch(flight, 0)
    f.time(90)
    expect(() => f.settle(flight, mark)).not.toThrow()
    expect(f.db.prepare('SELECT state FROM reference_embedding_dispatches').pluck().get()).toBe('response_received')
    expect(f.repository.get('run-A')).toMatchObject({ state: 'recovery_unknown', spent_requests: 1,
      active_elapsed_ms: 0, active_since_ms: 100 })
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_RECOVERY_UNKNOWN')
    flight.finish()
  })
  it.each(['dispatch', 'effect'] as const)('persists a rolled-back %s clock fence with the later truthful settlement across restart', boundary => {
    const f = fixture(), first = f.repository.openFlight(f.capability), second = f.repository.openFlight(f.capability)
    const mark = f.dispatch(first, 0)
    f.time(110); f.tx(() => f.repository.assertEffect(f.capability))
    f.time(105)
    expect(() => boundary === 'dispatch' ? f.dispatch(second, 1)
      : f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_RECOVERY_UNKNOWN')
    expect(f.repository.get('run-A')?.state).toBe('ready')
    f.time(120); expect(() => f.settle(first, mark)).not.toThrow()
    expect(f.db.prepare('SELECT state FROM reference_embedding_dispatches').pluck().get()).toBe('response_received')
    const expected = { state: 'recovery_unknown', spent_requests: 1, active_elapsed_ms: 0, active_since_ms: 100 }
    expect(f.repository.get('run-A')).toMatchObject(expected)
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_RECOVERY_UNKNOWN')
    const forbiddenMark = vi.fn(() => f.recorder.mark({ runId: 'run-A', documentId: documentA, batchOrdinal: 1, inputCount: 1 }))
    expect(() => f.tx(() => f.repository.beforeDispatch(second, forbiddenMark))).toThrow('BUDGET_RECOVERY_UNKNOWN')
    expect(forbiddenMark).not.toHaveBeenCalled()
    first.finish(); second.finish()
    const reopened = new Database(f.db.serialize()); handles.push(reopened)
    const repository = new ReferenceEmbeddingBudgetRepository(reopened, { ...f.options, now: () => 1000 })
    expect(repository.get('run-A')).toMatchObject(expected)
    expect(() => repository.preflight('run-A')).toThrow('BUDGET_RECOVERY_UNKNOWN')
    expect(() => reopened.transaction(() => repository.prepare({ runId: 'run-A', manifestFingerprint: manifest }))())
      .toThrow('BUDGET_RECOVERY_UNKNOWN')
    expect(reopened.prepare('SELECT state FROM reference_embedding_dispatches').pluck().get()).toBe('response_received')
  })
  it.each([false, true])('reopens a %s closed interval without resetting consumption, but fences an open interval', close => {
    const f = fixture(), flight = f.repository.openFlight(f.capability), mark = f.dispatch(flight, 0)
    if (close) { f.time(140); f.settle(flight, mark); flight.finish() }
    const reopened = new Database(f.db.serialize()); handles.push(reopened)
    const repository = new ReferenceEmbeddingBudgetRepository(reopened, { ...f.options, now: () => 1000 })
    const prepare = () => reopened.transaction(() => repository.prepare({ runId: 'run-A', manifestFingerprint: manifest }))()
    if (close) {
      expect(() => repository.preflight('run-A')).not.toThrow()
      expect(prepare().rootRunId).toBe('run-A')
      expect(repository.get('run-A')).toMatchObject({ spent_requests: 1, active_elapsed_ms: 40, active_since_ms: null })
    } else {
      expect(prepare).toThrow('BUDGET_RECOVERY_UNKNOWN')
      // The grant transaction above rolled back its recovery UPDATE; preflight must commit independently.
      expect(repository.get('run-A')?.state).toBe('ready')
      expect(() => repository.preflight('run-A')).toThrow('BUDGET_RECOVERY_UNKNOWN')
      expect(repository.get('run-A')).toMatchObject({ state: 'recovery_unknown', spent_requests: 1,
        active_elapsed_ms: 0, active_since_ms: 100 })
      expect(prepare).toThrow('BUDGET_RECOVERY_UNKNOWN')
      f.settle(flight, mark); flight.finish()
    }
  })
  it('durably quarantines a rolled-back open-clock effect refusal before another grant transaction', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability), mark = f.dispatch(flight, 0)
    f.time(150); f.tx(() => f.repository.assertEffect(f.capability))
    f.time(140)
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_RECOVERY_UNKNOWN')
    expect(f.repository.get('run-A')?.state).toBe('ready')
    expect(() => f.tx(() => f.repository.preflight('run-A'))).toThrow('BUDGET_INVALID')
    expect(() => f.repository.preflight('run-A')).toThrow('BUDGET_RECOVERY_UNKNOWN')
    expect(f.repository.get('run-A')).toMatchObject({ state: 'recovery_unknown', active_elapsed_ms: 0,
      active_since_ms: 100, spent_requests: 1 })
    f.time(160); expect(() => f.settle(flight, mark)).not.toThrow()
    expect(f.db.prepare('SELECT state FROM reference_embedding_dispatches').pluck().get()).toBe('response_received')
    flight.finish()
  })
  it('does not create or reallocate a missing root during preflight', () => {
    const f = fixture()
    insertRun(f.db, 'unstarted')
    expect(() => f.repository.preflight('unstarted')).not.toThrow()
    expect(f.repository.get('unstarted')).toBeNull()
    expect(() => f.tx(() => f.repository.prepare({ runId: 'unstarted', manifestFingerprint: manifest }))).toThrow('BUDGET_REQUIRED')
    f.tx(() => f.repository.prepare({ runId: 'unstarted', manifestFingerprint: manifest, plan }))
    expect(f.repository.get('unstarted')).toMatchObject({ request_limit: 4, spent_requests: 0 })
    expect(f.repository.get('run-A')).toMatchObject({ request_limit: 4, spent_requests: 0 })
  })
  it('shares a failed-debit poison across repository instances even when the SQL transaction rolls back', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability)
    f.db.exec(`CREATE TRIGGER fail_budget_debit BEFORE UPDATE OF spent_requests ON reference_embedding_budgets
      BEGIN SELECT RAISE(ABORT,'fictional budget write failure'); END;`)
    expect(() => f.dispatch(flight, 0)).toThrow('BUDGET_PERSISTENCE_FAILED')
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 0 })
    expect(f.db.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
    f.db.exec('DROP TRIGGER fail_budget_debit')
    const other = new ReferenceEmbeddingBudgetRepository(f.db, f.options)
    expect(() => f.tx(() => other.prepare({ runId: 'run-A', manifestFingerprint: manifest }))).toThrow('BUDGET_PERSISTENCE_FAILED')
    flight.finish()
  })
  it('does not let a poisoned sibling prevent truthful outcome settlement', () => {
    const f = fixture(), first = f.repository.openFlight(f.capability), second = f.repository.openFlight(f.capability)
    const mark = f.dispatch(first, 0)
    f.db.exec(`CREATE TRIGGER fail_budget_debit BEFORE UPDATE OF spent_requests ON reference_embedding_budgets
      BEGIN SELECT RAISE(ABORT,'fictional sibling failure'); END;`)
    expect(() => f.dispatch(second, 1)).toThrow('BUDGET_PERSISTENCE_FAILED')
    f.db.exec('DROP TRIGGER fail_budget_debit')
    f.time(130); expect(() => f.settle(first, mark)).not.toThrow()
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 1, active_elapsed_ms: 30, active_since_ms: null })
    first.finish(); second.finish()
  })
  it('retains an unproven dispatch and shared poison when interval settlement cannot persist', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability), mark = f.dispatch(flight, 0)
    f.db.exec(`CREATE TRIGGER fail_budget_settle BEFORE UPDATE OF active_elapsed_ms ON reference_embedding_budgets
      BEGIN SELECT RAISE(ABORT,'fictional interval write failure'); END;`)
    f.time(130)
    expect(() => f.settle(flight, mark)).toThrow('BUDGET_PERSISTENCE_FAILED')
    expect(f.db.prepare('SELECT state FROM reference_embedding_dispatches').pluck().get()).toBe('dispatch_marked')
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 1, active_elapsed_ms: 0, active_since_ms: 100 })
    f.db.exec('DROP TRIGGER fail_budget_settle')
    expect(() => f.repository.preflight('run-A')).toThrow('BUDGET_PERSISTENCE_FAILED')
    expect(f.repository.get('run-A')?.state).toBe('recovery_unknown')
    flight.finish()
  })
  it('does not claim a durable recovery fence when a SQL hook ignores the quarantine update', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability), mark = f.dispatch(flight, 0)
    f.time(90)
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_RECOVERY_UNKNOWN')
    f.db.exec(`CREATE TRIGGER ignore_budget_recovery BEFORE UPDATE OF state ON reference_embedding_budgets
      BEGIN SELECT RAISE(IGNORE); END;`)
    expect(() => f.repository.preflight('run-A')).toThrow('BUDGET_PERSISTENCE_FAILED')
    expect(f.repository.get('run-A')?.state).toBe('ready')
    f.db.exec('DROP TRIGGER ignore_budget_recovery')
    f.time(150); expect(() => f.settle(flight, mark)).not.toThrow()
    flight.finish()
  })
  it('rejects a SQL-hook debit rewrite before allowing the physical request', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability)
    f.db.exec(`CREATE TRIGGER erase_budget_debit AFTER UPDATE OF spent_requests ON reference_embedding_budgets
      BEGIN UPDATE reference_embedding_budgets SET spent_requests=0 WHERE root_run_id=NEW.root_run_id; END;`)
    expect(() => f.dispatch(flight, 0)).toThrow('BUDGET_PERSISTENCE_FAILED')
    expect(f.db.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
    flight.finish()
  })
  it('requires an issued capability and flight, an exact issued mark, synchronous callbacks and a transaction', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability)
    expect(() => f.repository.assertEffect(f.capability)).toThrow('BUDGET_INVALID')
    expect(() => f.tx(() => f.repository.assertEffect({ ...f.capability }))).toThrow('BUDGET_INVALID')
    expect(() => f.tx(() => f.repository.beforeDispatch({ ...flight }, () => { throw new Error('not called') }))).toThrow('BUDGET_INVALID')
    const asynchronous = vi.fn(async () => { throw new Error('not called') })
    expect(() => f.tx(() => f.repository.beforeDispatch(flight,
      asynchronous as unknown as () => ReferenceEmbeddingDispatchRecord))).toThrow('BUDGET_INVALID')
    expect(asynchronous).not.toHaveBeenCalled()
    const mark = f.dispatch(flight, 0)
    expect(() => f.tx(() => f.repository.settle(flight, { ...mark }, () => {}))).toThrow('BUDGET_INVALID')
    expect(() => flight.finish()).toThrow('BUDGET_INVALID')
    f.settle(flight, mark); flight.finish()
    expect(() => flight.finish()).toThrow('BUDGET_INVALID')
    expect(() => f.tx(() => f.repository.beforeDispatch(flight, () => mark))).toThrow('BUDGET_INVALID')
  })
  it('keeps legacy and portable records readable without issuing executable capabilities', () => {
    const f = fixture()
    f.db.prepare('UPDATE reference_embedding_budgets SET manifest_fingerprint=NULL WHERE root_run_id=?').run('run-A')
    expect(f.repository.get('run-A')?.manifest_fingerprint).toBeNull()
    expect(() => f.prepare()).toThrow('BUDGET_HISTORY_FROZEN')
    f.db.prepare(`UPDATE reference_embedding_budgets SET manifest_fingerprint=NULL,initial_chunk_size=NULL,
      initial_chunk_overlap=NULL,initial_batch_size=NULL,request_limit=NULL,active_limit_ms=NULL,
      spent_requests=NULL,active_elapsed_ms=NULL,active_since_ms=NULL,state='legacy_unbudgeted' WHERE root_run_id=?`).run('run-A')
    expect(f.repository.get('run-A')).toMatchObject({ state: 'legacy_unbudgeted', spent_requests: null })
    expect(() => f.prepare()).toThrow('BUDGET_HISTORY_UNBUDGETED')
  })
  it('rejects the portable history fence before a new mark or effect', () => {
    const f = fixture(), flight = f.repository.openFlight(f.capability)
    f.freeze()
    expect(() => f.dispatch(flight, 0)).toThrow('BUDGET_HISTORY_FROZEN')
    expect(() => f.tx(() => f.repository.assertEffect(f.capability))).toThrow('BUDGET_HISTORY_FROZEN')
    expect(f.repository.get('run-A')).toMatchObject({ spent_requests: 0 })
    flight.finish()
  })
})
