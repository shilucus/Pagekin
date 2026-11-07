import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { M01_GENERATION_SQL } from '../m01-generation-runs'
import { applyM11GenerationRecoveryTails, M11_GENERATION_RECOVERY_TAILS_SQL, verifyM11GenerationRecoveryTails } from '../m11-generation-recovery-tails'
import { sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { GenerationRunRepository, textHash } from '../../repositories/generation-run-repository'
import { GenerationRecoveryTailRepository } from '../../repositories/generation-recovery-tail-repository'

const handles: Database.Database[] = []
afterEach(() => { for (const db of handles.splice(0)) if (db.open) db.close() })

function fixture() {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  db.exec(M01_GENERATION_SQL)
  db.pragma('user_version=11')
  return db
}

function seed(db: Database.Database) {
  const runs = new GenerationRunRepository(() => db, () => 1000), h = textHash('fictional')
  const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
    templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
  const run = runs.open({ projectId: 'fictional-project', epoch: 'fictional-epoch', operation: 'write', uiActionNonce: 'click',
    frozenInputHash: h, fingerprint, contextSnapshotId: 'context', sourceManifest: { fixture: true }, sourceRefs: [],
    budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10_000 } })
  const attempt = runs.reserve(run.runId, 'call', h, 200, 100)
  runs.markDispatched(attempt.attempt.attemptId)
  const artifact = runs.snapshot(attempt.attempt.attemptId, 0, 'Fictional prefix')
  runs.settle(attempt.attempt.attemptId, null)
  new GenerationRecoveryTailRepository(db, runs).preserve({ attemptId: attempt.attempt.attemptId,
    artifactId: artifact.artifactId, durableRevision: artifact.revision, prefixHash: artifact.textHash, text: 'Fictional tail' })
  return { attemptId: attempt.attempt.attemptId, artifactId: artifact.artifactId, runId: run.runId }
}

describe('M11 generation recovery tail schema', () => {
  it('requires a caller transaction and adds exactly seven classified historical fields and two references', () => {
    const db = fixture(), before = db.prepare('SELECT * FROM generation_runs').all()
    expect(() => applyM11GenerationRecoveryTails(db)).toThrow('GENERATION_RECOVERY_TAIL_MIGRATION_TRANSACTION_REQUIRED')
    expect(verifyM11GenerationRecoveryTails(db)).toBe(false)
    db.transaction(() => applyM11GenerationRecoveryTails(db))()
    expect(verifyM11GenerationRecoveryTails(db)).toBe(true)
    expect(db.prepare('PRAGMA table_info(generation_recovery_tails)').all()).toHaveLength(7)
    expect(db.prepare('PRAGMA table_info(generation_recovery_tails)').all().map(row => (row as { name: string }).name))
      .toEqual(['attempt_id', 'artifact_id', 'durable_revision', 'prefix_hash', 'tail_text', 'tail_hash', 'preserved_at'])
    expect(db.prepare('PRAGMA foreign_key_list(generation_recovery_tails)').all()).toHaveLength(2)
    expect(db.prepare('SELECT * FROM generation_runs').all()).toEqual(before)
    expect(db.pragma('user_version', { simple: true })).toBe(11)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each(['ddl', 'verify'] as const)('rolls back schema and caller version on %s failure', failure => {
    const db = fixture(), before = sqliteSchemaFingerprint(db)
    expect(() => db.transaction(() => {
      db.exec(M11_GENERATION_RECOVERY_TAILS_SQL)
      db.pragma('user_version=12')
      if (failure === 'ddl') db.exec('SELECT * FROM fictional_missing_table')
      else {
        expect(verifyM11GenerationRecoveryTails(db)).toBe(true)
        throw new Error('Fictional verification rejection')
      }
    })()).toThrow()
    expect(sqliteSchemaFingerprint(db)).toBe(before)
    expect(db.pragma('user_version', { simple: true })).toBe(11)
    expect(verifyM11GenerationRecoveryTails(db)).toBe(false)
  })

  it.each(["durable_revision=-1", 'durable_revision=1.5', "prefix_hash='invalid'", "tail_hash='invalid'", "tail_text=''" ])(
    'native constraints reject %s', assignment => {
      const db = fixture()
      db.transaction(() => applyM11GenerationRecoveryTails(db))()
      seed(db)
      expect(() => db.prepare(`UPDATE generation_recovery_tails SET ${assignment}`).run()).toThrow()
      expect(verifyM11GenerationRecoveryTails(db)).toBe(true)
    })

  it.each(['prefix', 'tail', 'revision', 'date', 'attempt-id', 'attempt-root', 'terminal', 'artifact-link', 'run-root'] as const)(
    'read-only domain verification rejects corrupted %s without rewriting it', mode => {
      const db = fixture()
      db.transaction(() => applyM11GenerationRecoveryTails(db))()
      seed(db)
      if (mode === 'prefix' || mode === 'tail') {
        db.prepare(`UPDATE generation_recovery_tails SET ${mode === 'prefix' ? 'prefix_hash' : 'tail_hash'}=?`).run(textHash('changed'))
      } else if (mode === 'revision') db.prepare('UPDATE generation_recovery_tails SET durable_revision=2').run()
      else if (mode === 'date') db.prepare("UPDATE generation_recovery_tails SET preserved_at='2026-11-07'").run()
      else if (mode === 'artifact-link') db.prepare("UPDATE generation_artifacts SET artifact_json=json_set(artifact_json,'$.attemptId','another-attempt')").run()
      else if (mode === 'run-root') {
        db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
          .run('another-real-root', 'another-key', '{}', '{}')
        db.prepare("UPDATE generation_runs SET root_action_id='another-real-root'").run()
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      }
      else db.prepare('UPDATE generation_attempts SET attempt_json=json_set(attempt_json,?,?)')
        .run(mode === 'attempt-id' ? '$.attemptId' : mode === 'attempt-root' ? '$.rootActionId' : '$.status', mode === 'terminal' ? 'dispatch-marked' : 'another-identity')
      const before = db.prepare('SELECT * FROM generation_recovery_tails').all()
      expect(verifyM11GenerationRecoveryTails(db)).toBe(false)
      expect(db.prepare('SELECT * FROM generation_recovery_tails').all()).toEqual(before)
    })

  it('detects a missing native reference without deleting historical evidence', () => {
    const db = fixture()
    db.transaction(() => applyM11GenerationRecoveryTails(db))()
    seed(db)
    db.pragma('foreign_keys=OFF')
    db.prepare("UPDATE generation_recovery_tails SET artifact_id='missing-artifact'").run()
    db.pragma('foreign_keys=ON')
    expect(verifyM11GenerationRecoveryTails(db)).toBe(false)
    expect(db.prepare('SELECT artifact_id FROM generation_recovery_tails').pluck().get()).toBe('missing-artifact')
  })
})
