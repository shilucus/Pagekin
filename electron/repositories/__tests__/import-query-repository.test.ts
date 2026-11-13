import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBaselineTables } from '../../migrations/baseline-schema'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { getImportInferenceTopics } from '../../../src/shared/import-inference-materials'
import type { ImportGenerationContext } from '../../../src/shared/import-generation'
import { IMPORT_QUERY_PLAN_FIELDS, IMPORT_QUERY_TABLES_SQL, IMPORT_QUERY_TOPIC_FIELDS, IMPORT_QUERY_TOPIC_KEYS,
  assertImportQueryBinding, assertImportQueryPlanRecord, assertImportQueryTopicRecord, assertPortableImportQueryReceipt,
  importQueryContextFingerprint, importQueryHash, type ImportQueryBinding, type ImportQueryTopic,
  type ImportQueryReceipt } from '../../services/import-query-contract'
import { GenerationRunRepository, type OpenGenerationRunRequest } from '../generation-run-repository'
import { ImportQueryRepository } from '../import-query-repository'

const handles: Database.Database[] = []
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })
const h = importQueryHash('fictional input')
const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
  templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
const unavailable: ImportQueryReceipt = { version: 1, state: 'unavailable' }

/** Native repository contract fixture, not main-owner/import execution admission qualification. */
function fixture(maxPhysicalRequests = 8, maxActiveElapsedMs = 1000) {
  const db = new Database(':memory:'); handles.push(db)
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.exec(M01_GENERATION_SQL)
  db.exec(IMPORT_QUERY_TABLES_SQL)
  db.prepare(`INSERT INTO import_runs(id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,
    locale,stage,status,total_chapters,manifest_chapter_count) VALUES('import-A','reference','import-A','import:A',?,?,'en-US','global','running',1,1)`).run(h, h)
  let time = 1000, allowed = true
  const context = { slot: { runId: 'import-A', stage: 'global', batchId: 'global' }, manifestFingerprint: h,
    totalChapters: 1, totalWords: 0, chapters: [], core: { writingLanguage: 'en-US' }, prompts: {} } as unknown as ImportGenerationContext
  const runs = new GenerationRunRepository(() => db, () => time)
  const open: OpenGenerationRunRequest = { projectId: 'project', epoch: 'epoch', operation: 'import-global-facts',
    uiActionNonce: 'first', frozenInputHash: h, fingerprint, contextSnapshotId: 'context',
    sourceRefs: [], sourceManifest: { importSlot: context.slot, importContext: context },
    budget: { maxPhysicalRequests, maxTokenLiability: 10_000, maxOutputPerRequest: 100, maxActiveElapsedMs } }
  const run = runs.open(open)
  const binding: ImportQueryBinding = { version: 1, slot: { stage: 'global', batchId: 'global', writingLanguage: 'en-US' },
    contextFingerprint: importQueryContextFingerprint(context), configurationFingerprint: importQueryHash('frozen config'),
    topics: getImportInferenceTopics('en-US').map(({ key, query, topK }) => ({ key, query, topK })) }
  const queries = new ImportQueryRepository(db, { runs, now: () => time })
  const assertCurrent = () => { if (!allowed) throw new Error('GENERATION_ACTION_CANCELLED') }
  const prepare = () => queries.prepare({ generationRunId: run.runId, importRunId: 'import-A', binding, assertCurrent })
  const plan = prepare()
  const dispatch = (topic: ImportQueryTopic = IMPORT_QUERY_TOPIC_KEYS[0]) => {
    const flight = queries.openFlight(plan, topic)
    queries.beforeDispatch(flight, assertCurrent)
    return flight
  }
  const reserve = (nonce = 'generation') => runs.reserve(run.runId, nonce, h, 100, 20)
  const reopen = () => {
    const copy = new Database(db.serialize()); handles.push(copy)
    const repository = new GenerationRunRepository(() => copy, () => time)
    return { db: copy, runs: repository, queries: new ImportQueryRepository(copy, { runs: repository, now: () => time }) }
  }
  return { db, runs, queries, run, plan, binding, open, context, assertCurrent, prepare, dispatch, reserve, reopen,
    now(value: number) { time = value }, revoke() { allowed = false } }
}
function finish(f: ReturnType<typeof fixture>, flight: ReturnType<ReturnType<typeof fixture>['dispatch']>) {
  f.queries.settle(flight, { kind: 'response_received', httpStatus: 200 })
  f.queries.releasePhysical(flight)
}

describe('import query durable plan and shared root budget', () => {
  it('freezes exactly eight/ten fields and four deterministic prepared identities without attempts/artifacts', () => {
    const f = fixture()
    expect(Object.keys(f.plan.record)).toEqual([...IMPORT_QUERY_PLAN_FIELDS])
    expect(f.plan.topics.map(row => row.topic_key)).toEqual([...IMPORT_QUERY_TOPIC_KEYS])
    for (const row of f.plan.topics) {
      expect(Object.keys(row)).toEqual([...IMPORT_QUERY_TOPIC_FIELDS])
      expect(row.state).toBe('prepared'); expect(row.marked_at_ms).toBeNull()
      expect(() => assertImportQueryTopicRecord(row)).not.toThrow()
    }
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(0)
    expect(f.runs.attemptCount(f.run.runId)).toBe(0)
    expect(f.db.prepare('SELECT count(*) FROM generation_artifacts').pluck().get()).toBe(0)
  })
  it('FTS-only completed receipts cost zero and replay after a new database handle without current config', () => {
    const f = fixture()
    for (const topic of IMPORT_QUERY_TOPIC_KEYS) f.queries.complete(f.plan, topic, unavailable, f.assertCurrent)
    const next = f.reopen()
    next.queries.preflight('import-A')
    const plan = next.queries.prepare({ generationRunId: f.run.runId, importRunId: 'import-A',
      binding: { ...f.binding, configurationFingerprint: importQueryHash('changed current config') }, assertCurrent: f.assertCurrent })
    expect(next.queries.readReceipt(plan, 'worldview')).toEqual(unavailable)
    expect(next.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(0)
    expect(next.runs.attemptCount(f.run.runId)).toBe(0)
  })
  it('rejects a changed pending configuration rather than refreezing the plan', () => {
    const f = fixture()
    expect(() => f.queries.prepare({ generationRunId: f.run.runId, importRunId: 'import-A',
      binding: { ...f.binding, configurationFingerprint: importQueryHash('changed') }, assertCurrent: f.assertCurrent })).toThrow('PLAN_CONFLICT')
    expect(f.queries.get('import-A')?.binding).toEqual(f.binding)
  })
  it('replays completed query materials on a known retry sharing the original generation root', () => {
    const f = fixture(), flight = f.dispatch()
    finish(f, flight)
    for (const topic of IMPORT_QUERY_TOPIC_KEYS) f.queries.complete(f.plan, topic, unavailable, f.assertCurrent)
    const retry = f.runs.open({ ...f.open, uiActionNonce: 'known-retry', parentRootActionId: f.run.rootActionId })
    const plan = f.queries.prepare({ generationRunId: retry.runId, importRunId: 'import-A', binding: f.binding,
      assertCurrent: f.assertCurrent })
    expect(plan.record.generation_run_id).toBe(f.run.runId)
    expect(plan.record.root_action_id).toBe(retry.rootActionId)
    expect(f.queries.readReceipt(plan, 'worldview')).toEqual(unavailable)
    expect(f.runs.budget(retry.rootActionId).auxiliaryRequestCount).toBe(1)
    expect(f.runs.attemptCount(retry.runId)).toBe(0)
  })
  it('rejects incomplete topic history without backfilling a prepared replacement', () => {
    const f = fixture()
    f.db.prepare("DELETE FROM import_query_topics WHERE topic_key='style'").run()
    expect(f.prepare).toThrow('QUERY_INVALID')
    expect(f.db.prepare('SELECT count(*) FROM import_query_topics').pluck().get()).toBe(3)
  })
  it('does not move the plan onto a new generation root or enlarge its credit', () => {
    const f = fixture(), other = f.runs.open({ ...f.open, uiActionNonce: 'different' })
    expect(() => f.queries.prepare({ generationRunId: other.runId, importRunId: 'import-A', binding: f.binding,
      assertCurrent: f.assertCurrent })).toThrow('ROOT_CHANGED')
    expect(f.queries.get('import-A')?.record.root_action_id).toBe(f.run.rootActionId)
  })
  it('a reference descendant resolves its original plan rather than allocating another query identity', () => {
    const f = fixture()
    f.db.prepare(`INSERT INTO import_runs(id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,
      locale,stage,status,total_chapters,manifest_chapter_count) VALUES('import-B','reference','import-A','import:B',?,?,'en-US','global','running',1,1)`).run(h, h)
    expect(f.queries.get('import-B')).toEqual(f.plan)
    expect(f.db.prepare('SELECT count(*) FROM import_query_plans').pluck().get()).toBe(1)
    f.db.prepare("UPDATE import_runs SET manifest_fingerprint=? WHERE id='import-B'").run(importQueryHash('changed manifest'))
    expect(() => f.queries.get('import-B')).toThrow('PLAN_CONFLICT')
  })
  it('a query mark takes the final credit before a generation reservation', () => {
    const f = fixture(1), flight = f.dispatch()
    expect(f.reserve).toThrow('ROOT_BUDGET_EXHAUSTED')
    finish(f, flight)
    f.queries.complete(f.plan, 'worldview', unavailable, f.assertCurrent)
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(1)
    expect(f.runs.attemptCount(f.run.runId)).toBe(0)
  })
  it('a generation reservation occupies the final credit before a query physical mark', () => {
    const f = fixture(1)
    f.reserve()
    expect(() => f.dispatch()).toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(0)
    expect(f.queries.get('import-A')?.topics[0].state).toBe('prepared')
  })
  it('repository instances compete for one final query mark without refunding known HTTP failure', () => {
    const f = fixture(1), second = new ImportQueryRepository(f.db, { runs: new GenerationRunRepository(() => f.db, () => 1000), now: () => 1000 })
    const flight = f.dispatch()
    const pending = second.openFlight(f.plan, 'protagonist')
    expect(() => second.beforeDispatch(pending, f.assertCurrent)).toThrow('ROOT_BUDGET_EXHAUSTED')
    second.releasePhysical(pending)
    f.queries.settle(flight, { kind: 'http_failed', httpStatus: 429 })
    f.queries.releasePhysical(flight)
    f.queries.complete(f.plan, 'worldview', unavailable, f.assertCurrent)
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(1)
  })
  it('rolls a physical mark back with a failed clock write and poisons other repository instances', () => {
    const f = fixture(), flight = f.queries.openFlight(f.plan, 'worldview')
    f.db.exec("CREATE TEMP TRIGGER fail_clock BEFORE UPDATE OF active_since_ms ON generation_roots BEGIN SELECT RAISE(ABORT,'synthetic clock write'); END")
    expect(() => f.queries.beforeDispatch(flight, f.assertCurrent)).toThrow('PERSISTENCE_FAILED')
    f.db.exec('DROP TRIGGER fail_clock')
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(0)
    expect(f.db.prepare('SELECT marked_at_ms FROM import_query_topics WHERE topic_key=\'worldview\'').pluck().get()).toBeNull()
    const second = new GenerationRunRepository(() => f.db)
    expect(() => second.reserve(f.run.runId, 'later', h, 100, 20)).toThrow('GENERATION_DISPATCH_BLOCKED')
    f.queries.releasePhysical(flight)
  })
  it('charges the union of query/generation intervals through logical settlement and physical drain', () => {
    const f = fixture(), flight = f.dispatch()
    f.now(1010)
    const generation = f.reserve()
    f.runs.markDispatched(generation.attempt.attemptId)
    const release = f.runs.openPhysicalFlight(generation.attempt.attemptId)
    f.now(1020)
    f.runs.settle(generation.attempt.attemptId, null, 'stop')
    f.queries.settle(flight, { kind: 'response_received', httpStatus: 200 })
    f.now(1030); f.queries.releasePhysical(flight)
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(30)
    f.now(1040); release()
    f.now(2000)
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(40)
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(1)
  })
  it('a native physical close may stop the clock before its generation logical settle', () => {
    const f = fixture(), generation = f.reserve()
    f.runs.markDispatched(generation.attempt.attemptId)
    const release = f.runs.openPhysicalFlight(generation.attempt.attemptId)
    f.now(1010); release(); release()
    f.now(1100); f.runs.settle(generation.attempt.attemptId, null, 'stop')
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(10)
  })
  it('releases a closed database native hold without SQL or throwing, preserving lost-interval fencing on reopen', () => {
    const f = fixture(), generation = f.reserve()
    f.runs.markDispatched(generation.attempt.attemptId)
    const release = f.runs.openPhysicalFlight(generation.attempt.attemptId)
    const bytes = f.db.serialize()
    f.db.close()
    const prepare = vi.spyOn(f.db, 'prepare'), exec = vi.spyOn(f.db, 'exec'), transaction = vi.spyOn(f.db, 'transaction')
    try {
      expect(release).not.toThrow()
      expect(release).not.toThrow()
      expect(() => f.runs.poisonPhysicalActivity(f.run.rootActionId)).not.toThrow()
      expect(f.runs.hasPhysicalFlight(f.run.rootActionId)).toBe(false)
      expect(prepare).not.toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
      expect(transaction).not.toHaveBeenCalled()
    } finally { prepare.mockRestore(); exec.mockRestore(); transaction.mockRestore() }
    const copy = new Database(bytes); handles.push(copy)
    const runs = new GenerationRunRepository(() => copy, () => 1020)
    const queries = new ImportQueryRepository(copy, { runs, now: () => 1020 })
    expect(() => queries.preflight('import-A')).toThrow('RECOVERY_UNKNOWN')
    expect(copy.prepare('SELECT state FROM import_query_plans').pluck().get()).toBe('recovery_unknown')
    expect(copy.prepare('SELECT active_since_ms FROM generation_roots').pluck().get()).toBe(1000)
    expect(copy.prepare('SELECT active_elapsed_ms FROM generation_roots').pluck().get()).toBe(0)
  })
  it('pauses legacy direct generation marks without inventing a live native hold or changing their receipt', () => {
    const f = fixture(), generation = f.reserve()
    f.runs.markDispatched(generation.attempt.attemptId)
    f.now(1010); f.runs.pause(f.run.rootActionId)
    f.now(2000)
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(10)
    expect(f.runs.budget(f.run.rootActionId).root.status).toBe('paused')
    expect(f.runs.receipt(generation.attempt.attemptId).attempt.status).toBe('dispatch-marked')
    expect(f.db.prepare('SELECT active_since_ms FROM generation_roots').pluck().get()).toBeNull()
  })
  it.each([false, true])('preserves a real generation hold through pause/cancel=%s until actual close', cancel => {
    const f = fixture(), generation = f.reserve()
    f.runs.markDispatched(generation.attempt.attemptId)
    const release = f.runs.openPhysicalFlight(generation.attempt.attemptId)
    f.now(1010); f.runs.pause(f.run.rootActionId, cancel)
    f.now(1020); f.runs.settle(generation.attempt.attemptId, null, 'cancelled')
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(20)
    f.now(1030); release()
    f.now(2000)
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(30)
    expect(f.runs.budget(f.run.rootActionId).root.status).toBe(cancel ? 'cancelled' : 'paused')
    expect(f.db.prepare('SELECT active_since_ms FROM generation_roots').pluck().get()).toBeNull()
  })
  it('pure retrieval/idle gaps do not add activity between two physical requests', () => {
    const f = fixture(), first = f.dispatch()
    f.now(1010); finish(f, first)
    f.queries.complete(f.plan, 'worldview', unavailable, f.assertCurrent)
    f.now(2000)
    const second = f.dispatch('protagonist')
    f.now(2010); finish(f, second)
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(20)
  })
  it('cancel/revocation cannot clear an active query interval or suppress its real outcome', () => {
    const f = fixture(), flight = f.dispatch()
    f.now(1010); f.revoke(); f.runs.pause(f.run.rootActionId, true)
    f.now(1020); f.queries.settle(flight, { kind: 'http_failed', httpStatus: 400 })
    f.now(1030); f.queries.releasePhysical(flight)
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(30)
    expect(f.queries.get('import-A')?.topics[0].outcome_json).toBe(JSON.stringify({ kind: 'http_failed', httpStatus: 400 }))
    expect(() => f.queries.complete(f.plan, 'worldview', unavailable, f.assertCurrent)).toThrow('GENERATION_ACTION_CANCELLED')
  })
  it('rejects material completion after the original active duration cap, without erasing the outcome', () => {
    const f = fixture(8, 10), flight = f.dispatch()
    f.now(1010); finish(f, flight)
    expect(() => f.queries.complete(f.plan, 'worldview', unavailable, f.assertCurrent)).toThrow('ROOT_BUDGET_EXHAUSTED')
    expect(f.queries.get('import-A')?.topics[0].settled_at_ms).toBe(1010)
  })
  it('transport unknown permanently fences the plan and retains one actual mark', () => {
    const f = fixture(), flight = f.dispatch()
    f.queries.settle(flight, { kind: 'transport_unknown' }); f.queries.releasePhysical(flight)
    expect(f.prepare).toThrow('RECOVERY_UNKNOWN')
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(1)
    expect(f.queries.get('import-A')?.topics[0].state).toBe('unknown')
  })
  it('commits a lost-flight quarantine before refusal rather than rolling it back with admission', () => {
    const f = fixture(); f.dispatch()
    const copy = f.reopen()
    expect(() => copy.queries.preflight('import-A')).toThrow('RECOVERY_UNKNOWN')
    expect(copy.db.prepare('SELECT state FROM import_query_plans').pluck().get()).toBe('recovery_unknown')
    expect(copy.db.prepare('SELECT active_since_ms FROM generation_roots').pluck().get()).toBe(1000)
    expect(copy.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(1)
  })
  it('closed transport without a complete material receipt cannot be re-embedded after reopen', () => {
    const f = fixture(), flight = f.dispatch(); finish(f, flight)
    const copy = f.reopen()
    expect(() => copy.queries.preflight('import-A')).toThrow('RECOVERY_UNKNOWN')
    expect(copy.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(1)
  })
  it('an outer rollback cannot erase clock-rollback poison when the real outcome later settles', () => {
    const f = fixture(), flight = f.dispatch()
    f.now(1010); f.runs.budget(f.run.rootActionId)
    f.now(1005)
    expect(() => f.db.transaction(() => f.runs.assertAuxiliaryEffect(f.run.rootActionId))()).toThrow('RECOVERY_UNKNOWN')
    expect(f.db.prepare('SELECT state FROM import_query_plans').pluck().get()).toBe('ready')
    f.now(1020); f.queries.settle(flight, { kind: 'response_received', httpStatus: 200 }); f.queries.releasePhysical(flight)
    const copy = f.reopen()
    expect(copy.db.prepare('SELECT state FROM import_query_plans').pluck().get()).toBe('recovery_unknown')
    expect(copy.db.prepare('SELECT outcome_json FROM import_query_topics WHERE topic_key=\'worldview\'').pluck().get())
      .toBe(JSON.stringify({ kind: 'response_received', httpStatus: 200 }))
    expect(() => copy.queries.preflight('import-A')).toThrow('RECOVERY_UNKNOWN')
    expect(copy.db.prepare('SELECT active_elapsed_ms FROM generation_roots').pluck().get()).toBe(0)
  })
  it('immutable final receipts reject replacement and corrupted fingerprints', () => {
    const f = fixture()
    f.queries.complete(f.plan, 'worldview', unavailable, f.assertCurrent)
    const changed: ImportQueryReceipt = { version: 1, state: 'available', snapshot: { version: 1, state: 'empty',
      query: f.binding.topics[0].query, topK: 5, storageState: 'absent', canonicalRevision: null,
      documentsRevision: null, tableRevisions: [], registryHash: null, results: [], items: [] } }
    expect(() => f.queries.complete(f.plan, 'worldview', changed, f.assertCurrent)).toThrow('PLAN_CONFLICT')
    f.db.prepare("UPDATE import_query_topics SET receipt_fingerprint=? WHERE topic_key='worldview'").run('a'.repeat(64))
    expect(() => f.queries.readReceipt(f.plan, 'worldview')).toThrow('QUERY_INVALID')
  })
  it('live completed receipts require their original non-null integrity fingerprint', () => {
    const f = fixture()
    f.queries.complete(f.plan, 'worldview', unavailable, f.assertCurrent)
    const plan = f.queries.get('import-A')
    if (!plan) throw new Error('fixture plan missing')
    const row = plan.topics[0]
    expect(() => assertImportQueryTopicRecord(row)).not.toThrow()
    expect(() => assertImportQueryTopicRecord({ ...row, receipt_fingerprint: null })).toThrow('QUERY_INVALID')
    expect(() => assertImportQueryTopicRecord({ ...row, receipt_fingerprint: null }, { portable: true })).not.toThrow()
    f.db.prepare("UPDATE import_query_topics SET receipt_fingerprint=NULL WHERE topic_key='worldview'").run()
    expect(() => f.queries.get('import-A')).toThrow('QUERY_INVALID')
  })
  it.each(['manifest_fingerprint', 'binding_fingerprint'] as const)('SQL rejects a partial NULL live binding: %s', field => {
    const f = fixture()
    expect(() => f.db.prepare(`UPDATE import_query_plans SET ${field}=NULL`).run()).toThrow()
  })
  it.each(['import_query_plans', 'import_query_topics'] as const)('SQL rejects a NULL text primary key: %s', table => {
    const f = fixture(), field = table === 'import_query_plans' ? 'import_root_run_id' : 'query_id'
    expect(() => f.db.prepare(`UPDATE ${table} SET ${field}=NULL`).run()).toThrow()
  })
  it('portable completed receipts validate the projected shape without restoring an operational digest', () => {
    const f = fixture()
    const receipt = { version: 1, state: 'available', snapshot: { version: 1, state: 'empty',
      query: f.binding.topics[0].query, topK: 5, storageState: 'absent', canonicalRevision: null,
      documentsRevision: null, tableRevisions: [], results: [], items: [] } }
    expect(() => assertPortableImportQueryReceipt(receipt)).not.toThrow()
    const historical = { ...f.plan.topics[0], state: 'completed', receipt_json: JSON.stringify(receipt) }
    expect(() => assertImportQueryTopicRecord(historical, { portable: true })).not.toThrow()
    expect(() => assertImportQueryTopicRecord({ ...historical, marked_at_ms: 1 }, { portable: true })).toThrow('QUERY_INVALID')
    expect(() => assertPortableImportQueryReceipt({ ...receipt, snapshot: { ...receipt.snapshot, registryHash: h } })).toThrow('QUERY_INVALID')
  })
  it('closed binding/record validators reject extra keys and unsafe timestamps', () => {
    const f = fixture()
    expect(() => assertImportQueryBinding({ ...f.binding, endpoint: 'private' })).toThrow('QUERY_INVALID')
    expect(() => assertImportQueryPlanRecord({ ...f.plan.record, created_at_ms: Number.MAX_SAFE_INTEGER + 1 })).toThrow('QUERY_INVALID')
    expect(() => assertImportQueryTopicRecord({ ...f.plan.topics[0], extra: 1 })).toThrow('QUERY_INVALID')
  })
  it('frozen history cannot acquire a native query capability', () => {
    const f = fixture()
    const frozen = new ImportQueryRepository(f.db, { runs: f.runs,
      freeze: { active: true, isFrozen: () => true, assertMutable: () => { throw new Error('PORTABLE_RUNTIME_FROZEN') } } })
    expect(() => frozen.openFlight(f.plan, 'worldview')).toThrow('HISTORY_FROZEN')
  })
  it('forged capabilities and foreign database repositories cannot authorize dispatch', () => {
    const f = fixture(), other = fixture()
    expect(() => f.queries.beforeDispatch({ queryId: f.plan.topics[0].query_id, importRootRunId: 'import-A',
      rootActionId: f.run.rootActionId, topic: 'worldview' }, f.assertCurrent)).toThrow('QUERY_INVALID')
    expect(() => new ImportQueryRepository(other.db, { runs: f.runs })).toThrow('QUERY_INVALID')
  })
  it('cancellation before dispatch and a smoke-style unused flight charge zero and release idempotently', () => {
    const f = fixture(), flight = f.queries.openFlight(f.plan, 'worldview')
    f.revoke()
    expect(() => f.queries.beforeDispatch(flight, f.assertCurrent)).toThrow('GENERATION_ACTION_CANCELLED')
    f.queries.releasePhysical(flight); f.queries.releasePhysical(flight)
    expect(f.runs.budget(f.run.rootActionId).auxiliaryRequestCount).toBe(0)
    expect(f.runs.budget(f.run.rootActionId).activeElapsedMs).toBe(0)
    expect(f.queries.get('import-A')?.topics[0].state).toBe('prepared')
  })
  it('unsafe active arithmetic fences the root but still commits a factual known response', () => {
    const f = fixture(), flight = f.dispatch()
    f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=?').run(Number.MAX_SAFE_INTEGER)
    f.now(1001)
    f.queries.settle(flight, { kind: 'response_received', httpStatus: 200 }); f.queries.releasePhysical(flight)
    expect(f.db.prepare('SELECT state FROM import_query_plans').pluck().get()).toBe('recovery_unknown')
    expect(f.db.prepare('SELECT outcome_json FROM import_query_topics WHERE topic_key=\'worldview\'').pluck().get())
      .toBe(JSON.stringify({ kind: 'response_received', httpStatus: 200 }))
    expect(f.db.prepare('SELECT active_elapsed_ms FROM generation_roots').pluck().get()).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('a failed durable fence does not discard settlement and remains poisoned across repository instances', () => {
    const f = fixture(), flight = f.dispatch()
    f.now(1010); f.runs.budget(f.run.rootActionId); f.now(1005)
    f.db.exec("CREATE TEMP TRIGGER fail_fence BEFORE UPDATE OF blocked_code ON generation_roots BEGIN SELECT RAISE(ABORT,'synthetic fence write'); END")
    f.queries.settle(flight, { kind: 'http_failed', httpStatus: 400 })
    expect(f.db.prepare('SELECT outcome_json FROM import_query_topics WHERE topic_key=\'worldview\'').pluck().get())
      .toBe(JSON.stringify({ kind: 'http_failed', httpStatus: 400 }))
    f.db.exec('DROP TRIGGER fail_fence')
    f.now(1020); f.queries.releasePhysical(flight)
    const second = new GenerationRunRepository(() => f.db, () => 1020)
    expect(() => second.assertAuxiliaryEffect(f.run.rootActionId)).toThrow('PERSISTENCE_FAILED')
    expect(f.db.prepare('SELECT state FROM import_query_plans').pluck().get()).toBe('recovery_unknown')
  })
})
