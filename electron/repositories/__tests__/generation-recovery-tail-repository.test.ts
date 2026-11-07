import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { M11_GENERATION_RECOVERY_TAILS_SQL } from '../../migrations/m11-generation-recovery-tails'
import { GenerationRunRepository, textHash } from '../generation-run-repository'
import { GenerationRecoveryTailRepository, type PreserveGenerationTailInput } from '../generation-recovery-tail-repository'

const handles: Database.Database[] = []
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })
const prefix = 'Fictional durable prefix.\r\n'
const tail = 'Fictional unsaved suffix.\r\n'
const h = textHash('fixture-only'), fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h,
  contextSnapshotHash: h, templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }

function fixture() {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  db.exec(M01_GENERATION_SQL + M11_GENERATION_RECOVERY_TAILS_SQL)
  const runs = new GenerationRunRepository(() => db, () => 1000)
  const run = runs.open({ projectId: 'fictional-project', epoch: 'fictional-epoch', operation: 'write', uiActionNonce: 'click',
    frozenInputHash: h, fingerprint, contextSnapshotId: 'fictional-context', sourceManifest: { fixture: true }, sourceRefs: [],
    budget: { maxPhysicalRequests: 5, maxTokenLiability: 5000, maxOutputPerRequest: 100, maxActiveElapsedMs: 10_000 } })
  const reserved = runs.reserve(run.runId, 'first', h, 200, 100)
  runs.markDispatched(reserved.attempt.attemptId)
  const artifact = runs.snapshot(reserved.attempt.attemptId, 0, prefix)
  const input: PreserveGenerationTailInput = { attemptId: reserved.attempt.attemptId, artifactId: artifact.artifactId,
    durableRevision: artifact.revision, prefixHash: artifact.textHash, text: tail }
  const history = new GenerationRecoveryTailRepository(db, runs)
  const settle = () => runs.settle(input.attemptId, null, 'error', 'GENERATION_STORAGE_FAILED')
  return { db, runs, run, artifact, input, history, settle }
}

describe('generation recovery tail repository', () => {
  it('commits a separate partial history without editing the terminal artifact, unknown ledger or author facts', () => {
    const f = fixture()
    f.settle()
    f.db.exec("CREATE TABLE fictional_author(text TEXT); INSERT INTO fictional_author VALUES('Author text unchanged');")
    const before = { artifact: f.db.prepare('SELECT * FROM generation_artifacts').all(),
      attempt: f.db.prepare('SELECT * FROM generation_attempts').all(), author: f.db.prepare('SELECT * FROM fictional_author').all() }
    f.history.preserve(f.input)
    expect(f.history.list(f.run.runId)).toEqual([{ kind: 'preserved-partial', attemptId: f.input.attemptId,
      artifactId: f.input.artifactId, durableRevision: f.input.durableRevision, durableText: prefix,
      prefixHash: textHash(prefix), tailText: tail, tailHash: textHash(tail), preservedAt: expect.any(String) }])
    expect(f.db.prepare('SELECT * FROM generation_artifacts').all()).toEqual(before.artifact)
    expect(f.db.prepare('SELECT * FROM generation_attempts').all()).toEqual(before.attempt)
    expect(f.db.prepare('SELECT * FROM fictional_author').all()).toEqual(before.author)
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(new GenerationRecoveryTailRepository(f.db, new GenerationRunRepository(() => f.db)).list(f.run.runId))
      .toEqual(f.history.list(f.run.runId))
  })

  it('is idempotent only for the identical attempt, revision, content and hashes', () => {
    const f = fixture()
    f.settle()
    f.history.preserve(f.input)
    const row = f.db.prepare('SELECT * FROM generation_recovery_tails').get()
    f.history.preserve({ ...f.input })
    expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([row])
    for (const changed of [{ text: tail + 'different' }, { prefixHash: h }, { durableRevision: 0 }]) {
      expect(() => f.history.preserve({ ...f.input, ...changed })).toThrow('GENERATION_RECOVERY_TAIL_CONFLICT')
    }
    expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([row])
  })

  it.each([{ durableRevision: -1 }, { durableRevision: 1.5 }, { text: '' }, { prefixHash: 'not-a-hash' }])(
    'rejects invalid history input without a partial row: %j', change => {
      const f = fixture()
      f.settle()
      expect(() => f.history.preserve({ ...f.input, ...change })).toThrow('GENERATION_RECOVERY_TAIL_INVALID')
      expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([])
    })

  it('requires the exact terminal source and never creates history for a live request', () => {
    const f = fixture()
    expect(() => f.history.preserve(f.input)).toThrow('GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT')
    f.settle()
    for (const change of [{ artifactId: 'another-artifact' }, { durableRevision: 2 }, { prefixHash: h }]) {
      expect(() => f.history.preserve({ ...f.input, ...change })).toThrow('GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT')
    }
    expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([])
  })

  it.each(['artifact-run', 'artifact-attempt', 'attempt-json-id', 'attempt-json-root'] as const)(
    'rejects mismatched native and JSON source links: %s', mode => {
      const f = fixture()
      f.settle()
      if (mode === 'artifact-run') {
        const second = f.runs.open({ ...f.run.binding, operation: 'write', uiActionNonce: 'second', frozenInputHash: h,
          budget: { maxPhysicalRequests: 5, maxTokenLiability: 5000, maxOutputPerRequest: 100, maxActiveElapsedMs: 10_000 } })
        f.db.prepare('UPDATE generation_artifacts SET run_id=?').run(second.runId)
      } else if (mode === 'artifact-attempt') {
        const second = f.runs.reserve(f.run.runId, 'second', h, 200, 100)
        f.db.prepare('DELETE FROM generation_artifacts WHERE attempt_id=?').run(second.attempt.attemptId)
        f.db.prepare('UPDATE generation_artifacts SET attempt_id=?').run(second.attempt.attemptId)
      } else {
        f.db.prepare(`UPDATE generation_attempts SET attempt_json=json_set(attempt_json,?,'wrong-identity')`)
          .run(mode === 'attempt-json-id' ? '$.attemptId' : '$.rootActionId')
      }
      expect(() => f.history.preserve(f.input)).toThrow('GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT')
      expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([])
    })

  it('rejects a frozen attempt before consulting its stripped portable execution receipt', () => {
    const f = fixture()
    f.settle()
    f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=NULL').run()
    const history = new GenerationRecoveryTailRepository(f.db, f.runs, (table, id) => table === 'generation_attempts' && id === f.input.attemptId)
    expect(() => history.preserve(f.input)).toThrow('GENERATION_RECOVERY_TAIL_READ_ONLY')
  })

  it('rolls back a real deferred native COMMIT failure and allows an identical retry', () => {
    const f = fixture()
    f.settle()
    f.db.exec(`CREATE TABLE commit_parent(id TEXT PRIMARY KEY);
      CREATE TABLE commit_child(parent_id TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_tail_commit AFTER INSERT ON generation_recovery_tails BEGIN
        INSERT INTO commit_child VALUES('missing-parent'); END;`)
    expect(() => f.history.preserve(f.input)).toThrow('FOREIGN KEY constraint failed')
    expect(f.db.inTransaction).toBe(false)
    expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([])
    expect(f.db.prepare('SELECT * FROM commit_child').all()).toEqual([])
    f.db.exec('DROP TRIGGER fail_tail_commit')
    f.history.preserve(f.input)
    expect(f.history.list(f.run.runId)[0].tailText).toBe(tail)
  })

  it('requires a top-level transaction so successful return proves native COMMIT', () => {
    const f = fixture()
    f.settle()
    f.db.transaction(() => {
      expect(() => f.history.preserve(f.input)).toThrow('GENERATION_RECOVERY_TAIL_TRANSACTION_ACTIVE')
      expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([])
    })()
    f.history.preserve(f.input)
    expect(f.history.list(f.run.runId)).toHaveLength(1)
  })

  it('recognizes a lost snapshot response only when the next revision proves the entire prefix plus exact held suffix', () => {
    const f = fixture()
    const durable = f.runs.snapshot(f.input.attemptId, f.input.durableRevision, prefix + tail)
    f.settle()
    f.history.preserve(f.input)
    expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([])
    expect(f.runs.receipt(f.input.attemptId).artifact).toEqual(durable)
  })

  it.each(['changed-prefix', 'extra-revision', 'different-suffix'] as const)(
    'does not guess lost-response equivalence for %s', mode => {
      const f = fixture()
      if (mode === 'extra-revision') {
        f.runs.snapshot(f.input.attemptId, f.input.durableRevision, prefix + 'intermediate')
        f.runs.snapshot(f.input.attemptId, f.input.durableRevision + 1, prefix + 'intermediate' + tail)
      } else {
        f.runs.snapshot(f.input.attemptId, f.input.durableRevision, prefix + (mode === 'changed-prefix' ? 'other-prefix' + tail : 'different-tail'))
      }
      f.settle()
      expect(() => f.history.preserve(f.input)).toThrow('GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT')
      expect(f.db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual([])
    })

  it.each(['prefix-hash', 'tail-hash', 'date', 'terminal', 'artifact-json', 'run-root'] as const)(
    'fails closed without echoing manuscript data for corrupt %s history', mode => {
      const f = fixture()
      f.settle()
      f.history.preserve(f.input)
      if (mode === 'prefix-hash' || mode === 'tail-hash') {
        f.db.prepare(`UPDATE generation_recovery_tails SET ${mode === 'prefix-hash' ? 'prefix_hash' : 'tail_hash'}=?`).run(h)
      } else if (mode === 'date') f.db.prepare("UPDATE generation_recovery_tails SET preserved_at='2026-11-07'").run()
      else if (mode === 'terminal') f.db.prepare("UPDATE generation_attempts SET attempt_json=json_set(attempt_json,'$.status','dispatch-marked')").run()
      else if (mode === 'run-root') {
        f.db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
          .run('another-real-root', 'another-key', '{}', '{}')
        f.db.prepare("UPDATE generation_runs SET root_action_id='another-real-root'").run()
        expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      }
      else f.db.prepare("UPDATE generation_artifacts SET artifact_json='Fictional manuscript must not appear in error'").run()
      expect(() => f.history.list(f.run.runId)).toThrow(/^GENERATION_RECOVERY_TAIL_INTEGRITY_FAILED$/)
    })
})
