import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { M08_PLANNING_FEEDBACK_SQL } from '../m08-planning-feedback'
import { applyM09PlanningFeedbackRanges, M09_PLANNING_FEEDBACK_RANGES_SQL, verifyM09PlanningFeedbackRanges } from '../m09-planning-feedback-ranges'
import { migrateSchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { PLANNING_FEEDBACK_CORE_COLUMNS, planningFeedbackAdoptionBinding, planningFeedbackCoreSnapshot,
  type PlanningFeedbackBase, type PlanningFeedbackCandidate } from '../../../src/shared/planning-feedback'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { PlanningFeedbackRepository } from '../../repositories/planning-feedback-repository'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'

const handles: Database.Database[] = []
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
afterEach(() => { vi.restoreAllMocks(); for (const db of handles.splice(0)) if (db.open) db.close() })

// Native capture from the immutable 1815d16a source closure, not a second current registry.
// Evidence: .runtime/creation-runtime-modernization/stage-2b/baseline-schema9/capture-6Xuk1M/identities.json.
// Provenance: M08 e3110e3b10a2bb4a82ef03b8d0393d6d52ccbd3d; old registry 2cde74d267cef262430d5de8978b59241fbea044.
const STAGE_2A_SCHEMA9_FINGERPRINTS = {
  normal: '361b1c5416492d9e4a827119aaf8bcfdea25ecd52fc26e65207c77f901e780d2',
  donor: '6d513eed561970b9db78e9b75f7259b383f8e1eeb7194a71fe222dccaec007e7',
}

function fixture(donor = false) {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  if (donor) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").pluck().get() as string
    db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
    db.exec(sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
    db.exec('DROP TABLE characters_without_avatar')
  }
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
  db.prepare("INSERT INTO project_core(id,project_name,premise,worldbuilding) VALUES('main','Synthetic legacy book','F0','Legacy world')").run()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
  return db
}

/** Synthetic legacy rows use the frozen v1 layout and real run artifacts; no v2 API is called against schema9. */
function seedLegacyHistory(db: Database.Database) {
  const source = planningFeedbackCoreSnapshot(ProjectCoreRepository.get(db)), sourceHash = hash(JSON.stringify(source)), h = hash('legacy-frozen')
  const base = { schemaVersion: 1, baseId: 'legacy-base', projectId: 'project-A', target: 'premise', scope: { kind: 'field', field: 'premise' },
    sourceRevision: 0, sourceHash, source, value: 'F0', valueHash: hash('F0'), createdAt: 1000, closedAt: null, closedByAdoptionId: null } as const satisfies PlanningFeedbackBase
  db.prepare(`INSERT INTO planning_feedback_bases
    (base_id,schema_version,project_id,target,source_revision,source_hash,source_json,value,value_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(base.baseId, 1, base.projectId, base.target, 0, sourceHash, JSON.stringify(source, null, 2), 'F0', base.valueHash, 1000)
  const runs = new GenerationRunRepository(() => db)
  const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
    templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
  const policy = { estimatorVersion: 'fixture-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
  let parent: PlanningFeedbackCandidate | null = null
  for (const [index, text] of ['C1', 'C2'].entries()) {
    const run = runs.open({ projectId: base.projectId, epoch: 'legacy-lease', operation: 'write', uiActionNonce: `legacy-${index}`,
      frozenInputHash: h, fingerprint, contextSnapshotId: 'legacy-context', sourceManifest: { fixture: 'legacy-planning-feedback' }, sourceRefs: [],
      budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } })
    const reserved = runs.reserve(run.runId, 'request', h, 200, 100, policy)
    runs.markDispatched(reserved.attempt.attemptId)
    runs.snapshot(reserved.attempt.attemptId, 0, text)
    const receipt = runs.settle(reserved.attempt.attemptId, { policy, trusted: true, actualTokens: 50 }, 'stop')
    const candidate: PlanningFeedbackCandidate = { schemaVersion: 1, candidateId: `legacy-c${index + 1}`, projectId: base.projectId,
      baseId: base.baseId, parentCandidateId: parent?.candidateId ?? null, generationParentHash: parent?.textHash ?? base.valueHash,
      text, textHash: hash(text), feedback: 'Legacy author feedback', constraints: ['Keep the title'], createdAt: 1001 + index,
      origin: { kind: 'generated', runId: run.runId, attemptId: receipt.attempt.attemptId, artifactId: receipt.artifact!.artifactId,
        modelLeaseRevision: h, skillSnapshotHash: h, contextSnapshotHash: h } }
    db.prepare(`INSERT INTO planning_feedback_candidates
      (candidate_id,schema_version,project_id,base_id,parent_candidate_id,generation_parent_hash,text,text_hash,feedback,constraints_json,origin_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(candidate.candidateId, 1, candidate.projectId, candidate.baseId, candidate.parentCandidateId,
      candidate.generationParentHash, text, candidate.textHash, candidate.feedback, JSON.stringify(candidate.constraints, null, 2), JSON.stringify(candidate.origin, null, 2), candidate.createdAt)
    parent = candidate
  }
  const candidate = parent!, request = { candidateId: candidate.candidateId, idempotencyKey: 'legacy-original-click', decision: 'full' as const, text: candidate.text }
  const requestHash = hash(planningFeedbackAdoptionBinding(request, candidate, base, candidate.textHash))
  db.transaction(() => {
    ProjectCoreRepository.update({ premise: candidate.text }, db)
    db.prepare(`INSERT INTO planning_feedback_adoptions
      (adoption_id,schema_version,project_id,base_id,candidate_id,idempotency_key,request_hash,target,decision,decision_source,text,text_hash,before_value,before_hash,source_revision,committed_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-adoption', 1, base.projectId, base.baseId, candidate.candidateId,
      request.idempotencyKey, requestHash, base.target, 'full', 'author-action', candidate.text, candidate.textHash, 'F0', base.valueHash, 0, 1, 1003)
    db.prepare('UPDATE planning_feedback_bases SET closed_at=?,closed_by_adoption_id=? WHERE base_id=?').run(1003, 'legacy-adoption', base.baseId)
  })()
  return { base, request }
}

const rows = (db: Database.Database) => ({ bases: db.prepare('SELECT * FROM planning_feedback_bases ORDER BY base_id').all(),
  candidates: db.prepare('SELECT * FROM planning_feedback_candidates ORDER BY candidate_id').all(),
  adoptions: db.prepare('SELECT * FROM planning_feedback_adoptions ORDER BY adoption_id').all() })

describe('M09 planning feedback range migration', () => {
  it.each([false, true])('pins the immutable Stage2A schema9 fingerprint (donor=%s)', donor => {
    const db = fixture(donor)
    expect(db.pragma('user_version', { simple: true })).toBe(9)
    expect(sqliteSchemaFingerprint(db)).toBe(STAGE_2A_SCHEMA9_FINGERPRINTS[donor ? 'donor' : 'normal'])
    expect(M08_PLANNING_FEEDBACK_SQL).not.toContain('plotOutlineRange')
    expect(M08_PLANNING_FEEDBACK_SQL).not.toContain('scope_json')
  })

  it.each([false, true])('copies a real FK-connected v1 C1 -> C2 chain and adoption without changing any old row bytes (donor=%s)', donor => {
    const db = fixture(donor), legacy = seedLegacyHistory(db), before = rows(db)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.transaction(() => applyM09PlanningFeedbackRanges(db))()
    expect(verifyM09PlanningFeedbackRanges(db)).toBe(true)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const after = rows(db)
    expect(after.bases.map(value => { const { scope_json, ...row } = value as Record<string, unknown>; expect(scope_json).toBeNull(); return row })).toEqual(before.bases)
    expect(after.candidates).toEqual(before.candidates)
    expect(after.adoptions.map(value => { const { adopted_scope_json, ...row } = value as Record<string, unknown>; expect(adopted_scope_json).toBeNull(); return row })).toEqual(before.adoptions)
    const repository = new PlanningFeedbackRepository(db, { projectId: 'project-A', assertCurrent: () => {}, isFrozen: () => false,
      assertGenerationCurrent: () => { throw new Error('Migration receipt replay must not stage new generation') } })
    const writer = vi.spyOn(ProjectCoreRepository, 'update')
    expect(repository.getCandidate('legacy-c2').parentCandidateId).toBe('legacy-c1')
    expect(repository.getBase(legacy.base.baseId).sourceHash).toBe(legacy.base.sourceHash)
    expect(repository.adopt(legacy.request)).toMatchObject({ adoptionId: 'legacy-adoption', requestHash: (before.adoptions[0] as Record<string, unknown>).request_hash,
      adoptedScope: { kind: 'field', field: 'premise' } })
    expect(writer).not.toHaveBeenCalled()
    expect(ProjectCoreRepository.get(db)?.premise).toBe('C2')
    expect(db.prepare('SELECT revision FROM planning_feedback_core_revision WHERE id=1').pluck().get()).toBe(1)
    expect(db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()).toBe(0)
  })

  it.each([
    ['copy', 'INSERT INTO planning_feedback_candidates_m09 SELECT * FROM planning_feedback_candidates;'],
    ['delete', 'DROP TABLE planning_feedback_bases;'],
    ['rename', 'ALTER TABLE planning_feedback_bases_m09 RENAME TO planning_feedback_bases;'],
  ])('rolls back all old rows, DDL and the schema stamp after an injected %s failure', (_phase, marker) => {
    const db = fixture(), legacy = seedLegacyHistory(db), before = rows(db), schema = sqliteSchemaFingerprint(db)
    expect(M09_PLANNING_FEEDBACK_RANGES_SQL).toContain(marker)
    const injected = M09_PLANNING_FEEDBACK_RANGES_SQL.replace(marker, `${marker}\nSELECT * FROM fixture_missing_m09_table;`)
    expect(() => db.transaction(() => db.exec(injected))()).toThrow()
    expect(rows(db)).toEqual(before)
    expect(sqliteSchemaFingerprint(db)).toBe(schema)
    expect(db.pragma('user_version', { simple: true })).toBe(9)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('SELECT closed_by_adoption_id FROM planning_feedback_bases WHERE base_id=?').pluck().get(legacy.base.baseId)).toBe('legacy-adoption')
  })

  it('rolls back the completed rebuild when domain verification is deliberately rejected', () => {
    const db = fixture(), legacy = seedLegacyHistory(db), before = rows(db), schema = sqliteSchemaFingerprint(db)
    expect(() => db.transaction(() => {
      applyM09PlanningFeedbackRanges(db)
      expect(verifyM09PlanningFeedbackRanges(db)).toBe(true)
      db.pragma('user_version=10')
      throw new Error('fixture M09 verification rejected')
    })()).toThrow('fixture M09 verification rejected')
    expect(rows(db)).toEqual(before)
    expect(sqliteSchemaFingerprint(db)).toBe(schema)
    expect(db.pragma('user_version', { simple: true })).toBe(9)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('SELECT closed_by_adoption_id FROM planning_feedback_bases WHERE base_id=?').pluck().get(legacy.base.baseId)).toBe('legacy-adoption')
    expect(verifyM09PlanningFeedbackRanges(db)).toBe(false)
  })

  it('requires the runner transaction and rejects inconsistent installed scope rows', () => {
    const db = fixture()
    expect(() => applyM09PlanningFeedbackRanges(db)).toThrow('PLANNING_FEEDBACK_MIGRATION_TRANSACTION_REQUIRED')
    db.transaction(() => applyM09PlanningFeedbackRanges(db))()
    expect(verifyM09PlanningFeedbackRanges(db)).toBe(true)
    db.prepare('UPDATE planning_feedback_outline_revision SET revision=1.5 WHERE id=1').run()
    expect(verifyM09PlanningFeedbackRanges(db)).toBe(false)
  })

  it.each([...Object.values(PLANNING_FEEDBACK_CORE_COLUMNS), 'synopsis', 'characters_arch'])('counts actual %s changes and ABA but not same-value writes', column => {
    const db = fixture()
    db.transaction(() => applyM09PlanningFeedbackRanges(db))()
    const original = db.prepare(`SELECT ${column} FROM project_core WHERE id='main'`).pluck().get() as string | number
    db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(typeof original === 'number' ? original + 1 : `${original} changed`)
    db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(original)
    db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(original)
    expect(db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()).toBe(2)
  })

  it('ignores derived churn, detects source-row identity changes and rolls back revision changes with facts', () => {
    const db = fixture()
    db.transaction(() => applyM09PlanningFeedbackRanges(db))()
    db.exec("UPDATE project_core SET character_states='cache',plot_tree_snapshot='cache',updated_at='later' WHERE id='main'")
    expect(db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()).toBe(0)
    expect(() => db.transaction(() => { db.exec("UPDATE project_core SET synopsis='temporary' WHERE id='main'"); throw new Error('rollback') })()).toThrow('rollback')
    expect(db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()).toBe(0)
    db.exec("UPDATE project_core SET id='temporary' WHERE id='main'; UPDATE project_core SET id='main' WHERE id='temporary'")
    expect(db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()).toBe(2)
    db.exec("DELETE FROM project_core WHERE id='main'; INSERT INTO project_core(id,project_name) VALUES('main','Recreated')")
    expect(db.prepare('SELECT revision FROM planning_feedback_outline_revision WHERE id=1').pluck().get()).toBe(4)
  })
})
