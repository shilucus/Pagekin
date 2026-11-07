import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBaselineTables } from '../../migrations/baseline-schema'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { applyM08PlanningFeedback } from '../../migrations/m08-planning-feedback'
import { applyM09PlanningFeedbackRanges } from '../../migrations/m09-planning-feedback-ranges'
import { applyM10RuntimeFeedbackGrants } from '../../migrations/m10-runtime-feedback-grants'
import { assertPlanningFeedbackProof, buildPlanningFeedbackContext, buildPlanningFeedbackTask } from '../../services/planning-feedback-generation'
import { GenerationRunRepository } from '../generation-run-repository'
import { PlanningFeedbackRepository } from '../planning-feedback-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import { RuntimeFeedbackGrantRepository, type RuntimeFeedbackGrant, type RuntimeFeedbackGrantRef,
  type IssueRuntimeFeedbackGrant } from '../runtime-feedback-grant-repository'
import type { PlanningFeedbackBase, PlanningFeedbackCandidate, StagePlanningFeedbackCandidate } from '../../../src/shared/planning-feedback'

const handles: Database.Database[] = []
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const h = hash('fictional-runtime-grant')
afterEach(() => { vi.restoreAllMocks(); for (const db of handles.splice(0)) if (db.open) db.close() })

function fixture(projectId = 'project-A') {
  const db = new Database(':memory:')
  handles.push(db)
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.exec("INSERT INTO project_core(id,project_name,premise,worldbuilding) VALUES('main','Fictional grant book','F0','World F0')")
  db.exec(M01_GENERATION_SQL)
  db.transaction(() => {
    applyM08PlanningFeedback(db)
    applyM09PlanningFeedbackRanges(db)
    applyM10RuntimeFeedbackGrants(db)
  })()
  const frozen = new Set<string>(), assertCurrent = vi.fn(() => {})
  const options = { projectId, assertCurrent, isFrozen: (grantId: string) => frozen.has(grantId), now: () => 1000 }
  const grants = new RuntimeFeedbackGrantRepository(db, options)
  const planning = new PlanningFeedbackRepository(db, { projectId, assertCurrent, isFrozen: () => false, now: () => 1000,
    assertGenerationCurrent(receipt, base, parent, request) {
      assertPlanningFeedbackProof(db, receipt, buildPlanningFeedbackContext(base, parent, request.feedback, request.constraints))
    } })
  return { db, projectId, frozen, assertCurrent, options, grants, planning }
}

function prepare(f: ReturnType<typeof fixture>, options: {
  base?: PlanningFeedbackBase; parent?: PlanningFeedbackCandidate; projectId?: string; operation?: string; maxRequests?: number
} = {}) {
  const base = options.base ?? f.planning.captureBase('premise'), parent = options.parent ?? null
  const feedback = 'Preserve the author facts', constraints = ['Keep the original title']
  const context = buildPlanningFeedbackContext(base, parent, feedback, constraints), task = buildPlanningFeedbackTask(context, null)
  const runs = new GenerationRunRepository(() => f.db, () => 1000)
  const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
    templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
  const run = runs.open({ projectId: options.projectId ?? f.projectId, epoch: 'fictional-resource-epoch',
    operation: options.operation ?? 'planning-feedback', uiActionNonce: randomUUID(), frozenInputHash: h,
    fingerprint, contextSnapshotId: 'fictional-context', sourceRefs: [],
    sourceManifest: { operation: 'planning-feedback', planningFeedbackContext: context,
      planningFeedbackContextHash: hash(JSON.stringify(context)), planningFeedbackSkillText: null,
      planningFeedbackTask: task, planningFeedbackTaskHash: hash(JSON.stringify(task)) },
    budget: { maxPhysicalRequests: options.maxRequests ?? 1, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } })
  const request: IssueRuntimeFeedbackGrant = { grantId: randomUUID(), operationKey: randomUUID(),
    requestHash: hash(JSON.stringify({ schemaVersion: 1, projectId: f.projectId, target: base.target, baseId: base.baseId,
      parentCandidateId: parent?.candidateId ?? null, feedback, constraints })),
    target: base.target as IssueRuntimeFeedbackGrant['target'], baseId: base.baseId, parentCandidateId: parent?.candidateId ?? null, runId: run.runId }
  const complete = (text = 'C1'): StagePlanningFeedbackCandidate => {
    const policy = { estimatorVersion: 'fictional-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
    const reserved = runs.reserve(run.runId, 'planning-feedback:0', hash(JSON.stringify([task, h, h])), 200, 100, policy, task.purpose, task)
    runs.markDispatched(reserved.attempt.attemptId)
    const artifact = runs.snapshot(reserved.attempt.attemptId, 0, text)
    runs.settle(reserved.attempt.attemptId, { policy, trusted: true, actualTokens: 50 }, 'stop')
    return { baseId: base.baseId, parentCandidateId: parent?.candidateId ?? null, feedback, constraints,
      runId: run.runId, attemptId: reserved.attempt.attemptId, artifactId: artifact.artifactId }
  }
  return { base, run, runs, request, complete }
}

const ref = (grant: RuntimeFeedbackGrant): RuntimeFeedbackGrantRef => ({ grantId: grant.grantId, revision: grant.revision, runId: grant.runId })
const candidateCount = (db: Database.Database) => db.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()

describe('runtime feedback grant repository', () => {
  it('issues only history bound to one main-issued run and replays the operation without a second row', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request)
    expect(grant).toMatchObject({ projectId: f.projectId, revision: 1, state: 'active', candidateId: null, revokedAt: null,
      action: 'planning-feedback-candidate', decisionSource: 'author-action', createdAt: 1000 })
    expect(grant.grantId).not.toBe(grant.operationKey)
    expect(f.grants.issue({ ...p.request, grantId: randomUUID(), createdAt: 2000 })).toEqual(grant)
    expect(f.grants.getByOperation(p.request.operationKey)).toEqual(grant)
    expect(f.grants.getByRun(p.run.runId)).toEqual(grant)
    expect(f.grants.get(randomUUID())).toBeNull()
    expect(f.db.prepare('SELECT COUNT(*) FROM runtime_feedback_grants').pluck().get()).toBe(1)
    const row = f.db.prepare('SELECT * FROM runtime_feedback_grants').get()
    expect(JSON.stringify(row)).not.toMatch(/fictional-resource-epoch|native|lease|bearer|Preserve the author facts|Keep the original title/u)
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it('shares its caller native transaction so a failed admission leaves neither run nor grant', () => {
    const f = fixture()
    expect(() => f.db.transaction(() => {
      const p = prepare(f)
      f.grants.issue(p.request)
      throw new Error('admission rollback')
    }).immediate()).toThrow('admission rollback')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM runtime_feedback_grants').pluck().get()).toBe(0)
  })

  it('never resolves another runtime grant or candidate through a different explicit database', () => {
    const a = fixture(), b = fixture('project-B'), pa = prepare(a), pb = prepare(b)
    const ga = a.grants.issue(pa.request), gb = b.grants.issue(pb.request)
    expect(a.grants.get(gb.grantId)).toBeNull()
    expect(b.grants.get(ga.grantId)).toBeNull()
    expect(() => b.db.transaction(() => b.grants.assertActive(ref(ga)))()).toThrow('MISSING')
    const stage = pa.complete()
    a.grants.withCandidateCommit(ref(ga), () => a.planning.stageCandidate(stage))
    expect(candidateCount(a.db)).toBe(1)
    expect(candidateCount(b.db)).toBe(0)
    expect(b.grants.get(gb.grantId)).toEqual(gb)
  })

  it('rejects same-operation changed payload and distinct operations borrowing an already-granted run', () => {
    const f = fixture(), p = prepare(f)
    f.grants.issue(p.request)
    expect(() => f.grants.issue({ ...p.request, requestHash: hash('different-author-payload') })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(() => f.grants.issue({ ...p.request, parentCandidateId: 'different-parent' })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(() => f.grants.issue({ ...p.request, operationKey: randomUUID() })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(() => f.grants.issue({ ...p.request, grantId: randomUUID(), operationKey: randomUUID() })).toThrow('RUN_ALREADY_GRANTED')
  })

  it('requires explicit UUID keys, valid author hashes and only the original eight targets', () => {
    const f = fixture(), p = prepare(f)
    expect(() => f.grants.issue({ ...p.request, operationKey: 'implicit-key' })).toThrow('ID_INVALID')
    expect(() => f.grants.issue({ ...p.request, requestHash: 'not-a-hash' })).toThrow('HASH_INVALID')
    expect(() => f.grants.issue({ ...p.request, target: 'plotOutlineRange' as never })).toThrow('TARGET_INVALID')
    expect(() => f.grants.issue({ ...p.request, createdAt: -1 })).toThrow('INVALID')
    expect(f.db.prepare('SELECT COUNT(*) FROM runtime_feedback_grants').pluck().get()).toBe(0)
  })

  it.each([
    ['project', { projectId: 'project-B' }], ['operation', { operation: 'write' }], ['budget', { maxRequests: 2 }],
  ])('rejects a wrong run %s before creating a grant', (_name, options) => {
    const f = fixture(), p = prepare(f, options)
    expect(() => f.grants.issue(p.request)).toThrow('RUN_MISMATCH')
    expect(f.db.prepare('SELECT COUNT(*) FROM runtime_feedback_grants').pluck().get()).toBe(0)
  })

  it('rejects bases from another project, target or schema, and a parent outside the exact base', () => {
    const f = fixture(), p = prepare(f)
    expect(() => f.grants.issue({ ...p.request, target: 'worldbuilding' })).toThrow('BASE_MISMATCH')
    f.db.prepare('UPDATE planning_feedback_bases SET project_id=? WHERE base_id=?').run('project-B', p.base.baseId)
    expect(() => f.grants.issue(p.request)).toThrow('BASE_MISMATCH')
    f.db.prepare('UPDATE planning_feedback_bases SET project_id=? WHERE base_id=?').run(f.projectId, p.base.baseId)
    const parent = f.planning.stageCandidate(p.complete('Parent'))
    const next = prepare(f), withWrongParent = { ...next.request, parentCandidateId: parent.candidateId }
    expect(() => f.grants.issue(withWrongParent)).toThrow('PARENT_MISMATCH')
    f.db.pragma('ignore_check_constraints=ON')
    f.db.prepare('UPDATE planning_feedback_bases SET schema_version=2 WHERE base_id=?').run(next.base.baseId)
    f.db.pragma('ignore_check_constraints=OFF')
    expect(() => f.grants.issue(next.request)).toThrow('BASE_MISMATCH')
  })

  it('rejects mismatched run context schema, base, target and parent even when the run project matches', () => {
    const f = fixture(), p = prepare(f)
    const original = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(p.run.runId) as string
    for (const patch of [{ schemaVersion: 2 }, { baseId: 'another-base' }, { target: 'worldbuilding' }, { parentCandidateId: 'another-parent' }]) {
      const binding = JSON.parse(original)
      Object.assign(binding.sourceManifest.planningFeedbackContext, patch)
      f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), p.run.runId)
      expect(() => f.grants.issue(p.request)).toThrow('RUN_MISMATCH')
    }
  })

  it('does not retroactively grant a run after its first physical attempt exists', () => {
    const f = fixture(), p = prepare(f)
    p.complete()
    expect(() => f.grants.issue(p.request)).toThrow('RUN_ALREADY_STARTED')
  })

  it('checks transaction, exact revision, run, current resources and frozen status before active use', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), binding = ref(grant)
    expect(() => f.grants.assertActive(binding)).toThrow('TRANSACTION_REQUIRED')
    expect(f.db.transaction(() => f.grants.assertActive(binding))()).toEqual(grant)
    expect(() => f.db.transaction(() => f.grants.assertActive({ ...binding, revision: 2 }))()).toThrow('REVISION_CONFLICT')
    expect(() => f.db.transaction(() => f.grants.assertActive({ ...binding, runId: 'wrong-run' }))()).toThrow('RUN_MISMATCH')
    f.frozen.add(grant.grantId)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
    expect(() => f.db.transaction(() => f.grants.assertActive(binding))()).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.revoke(binding)).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.issue(p.request)).toThrow('HISTORY_FROZEN')
    f.frozen.clear()
    f.assertCurrent.mockImplementation(() => { throw new Error('runtime resource closed') })
    expect(() => f.db.transaction(() => f.grants.assertActive(binding))()).toThrow('runtime resource closed')
  })

  it('keeps a new-copy frozen old-project row readable without transferring any mutation authority', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request)
    const restored = new RuntimeFeedbackGrantRepository(f.db, { ...f.options, projectId: 'new-copy-project' })
    expect(() => restored.get(grant.grantId)).toThrow('PROJECT_MISMATCH')
    f.frozen.add(grant.grantId)
    f.db.prepare('UPDATE runtime_feedback_grants SET operation_key=? WHERE grant_id=?').run('history:runtime-feedback:grant-1', grant.grantId)
    expect(restored.get(grant.grantId)).toMatchObject({ projectId: 'project-A', operationKey: 'history:runtime-feedback:grant-1', state: 'active' })
    expect(restored.getByRun(grant.runId)?.grantId).toBe(grant.grantId)
    expect(restored.getByOperation(grant.operationKey)).toBeNull()
    expect(() => restored.revoke(ref(grant))).toThrow('HISTORY_FROZEN')
    expect(() => restored.withCandidateCommit(ref(grant), vi.fn())).toThrow('HISTORY_FROZEN')
  })

  it('lets revocation win before dispatch or after response without running any new candidate effect', () => {
    for (const afterResponse of [false, true]) {
      const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), binding = ref(grant)
      if (afterResponse) p.complete()
      const revoked = f.grants.revoke(binding), callback = vi.fn()
      expect(revoked).toMatchObject({ state: 'revoked', revision: 2, revokedAt: 1000, candidateId: null })
      expect(f.grants.revoke(binding)).toEqual(revoked)
      expect(f.grants.issue(p.request)).toEqual(revoked)
      expect(() => f.grants.withCandidateCommit(binding, callback)).toThrow('REVISION_CONFLICT')
      expect(() => f.db.transaction(() => f.grants.assertActive(ref(revoked)))()).toThrow('INACTIVE')
      expect(callback).not.toHaveBeenCalled()
      expect(candidateCount(f.db)).toBe(0)
      expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
    }
  })

  it('commits the existing candidate writer and completion receipt atomically, then preserves both through revoke and replay', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), binding = ref(grant), stage = p.complete()
    const writer = vi.fn(() => f.planning.stageCandidate(stage))
    const completed = f.grants.withCandidateCommit(binding, writer)
    expect(completed).toMatchObject({ state: 'completed', revision: 1, candidateId: expect.any(String), revokedAt: null })
    expect(f.planning.getCandidate(completed.candidateId!)).toMatchObject({ baseId: p.base.baseId, origin: { kind: 'generated', runId: p.run.runId } })
    expect(f.grants.withCandidateCommit(binding, writer)).toEqual(completed)
    expect(f.grants.revoke(binding)).toEqual(completed)
    expect(f.grants.issue(p.request)).toEqual(completed)
    expect(writer).toHaveBeenCalledTimes(1)
    expect(candidateCount(f.db)).toBe(1)
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it('preserves a valid parent binding for a subsequent candidate without adopting either candidate', () => {
    const f = fixture(), first = prepare(f), parent = f.planning.stageCandidate(first.complete('C1'))
    const p = prepare(f, { base: first.base, parent }), grant = f.grants.issue(p.request), stage = p.complete('C2')
    const result = f.grants.withCandidateCommit(ref(grant), () => f.planning.stageCandidate(stage))
    expect(f.planning.getCandidate(result.candidateId!)).toMatchObject({ parentCandidateId: parent.candidateId, baseId: first.base.baseId })
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it('rolls back the candidate and leaves the grant active when the callback throws', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), stage = p.complete()
    expect(() => f.grants.withCandidateCommit(ref(grant), () => {
      f.planning.stageCandidate(stage)
      throw new Error('candidate effect failed')
    })).toThrow('candidate effect failed')
    expect(candidateCount(f.db)).toBe(0)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
  })

  it('rolls back the candidate when writing its completion receipt fails', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), stage = p.complete()
    f.db.exec(`CREATE TEMP TRIGGER fictional_grant_receipt_failure BEFORE UPDATE OF state ON runtime_feedback_grants
      WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fictional receipt failure'); END;`)
    expect(() => f.grants.withCandidateCommit(ref(grant), () => f.planning.stageCandidate(stage))).toThrow('fictional receipt failure')
    expect(candidateCount(f.db)).toBe(0)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
  })

  it('rejects async callbacks before invoking them and rolls back synchronous writes returning thenables', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), stage = p.complete()
    let called = false
    const asynchronous = async () => { called = true; return f.planning.stageCandidate(stage) }
    expect(() => f.grants.withCandidateCommit(ref(grant), asynchronous as never)).toThrow('ASYNC_CALLBACK_INVALID')
    expect(called).toBe(false)
    expect(() => f.grants.withCandidateCommit(ref(grant), (() => {
      const candidate = f.planning.stageCandidate(stage)
      return Promise.resolve(candidate)
    }) as never)).toThrow('ASYNC_CALLBACK_INVALID')
    expect(candidateCount(f.db)).toBe(0)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
  })

  it.each(['projectId', 'baseId', 'parentCandidateId', 'runId'] as const)('rolls back a callback whose candidate has the wrong %s', key => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), stage = p.complete()
    expect(() => f.grants.withCandidateCommit(ref(grant), () => {
      const candidate = f.planning.stageCandidate(stage)
      return key === 'runId' ? { ...candidate, origin: { ...candidate.origin, runId: 'wrong-run' } } as PlanningFeedbackCandidate
        : { ...candidate, [key]: 'wrong-identity' }
    })).toThrow('CANDIDATE_MISMATCH')
    expect(candidateCount(f.db)).toBe(0)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
  })

  it('rechecks exact resources and grant state after the nested candidate writer but before completion', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), stage = p.complete()
    expect(() => f.grants.withCandidateCommit(ref(grant), () => {
      const candidate = f.planning.stageCandidate(stage)
      f.frozen.add(grant.grantId)
      return candidate
    })).toThrow('HISTORY_FROZEN')
    f.frozen.clear()
    expect(candidateCount(f.db)).toBe(0)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
    expect(() => f.grants.withCandidateCommit(ref(grant), () => {
      const candidate = f.planning.stageCandidate(stage)
      f.assertCurrent.mockImplementation(() => { throw new Error('runtime changed before commit') })
      return candidate
    })).toThrow('runtime changed before commit')
    f.assertCurrent.mockImplementation(() => {})
    expect(candidateCount(f.db)).toBe(0)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
  })

  it('refuses multiple durable attempts even if a corrupted run bypassed the one-request budget', () => {
    const f = fixture(), p = prepare(f), grant = f.grants.issue(p.request), stage = p.complete()
    const row = f.db.prepare('SELECT * FROM generation_attempts WHERE attempt_id=?').get(stage.attemptId) as Record<string, unknown>
    f.db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,usage_receipt_json,invocation_nonce)
      VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), randomUUID(), row.run_id, row.root_action_id, row.attempt_json, row.usage_receipt_json, 'forbidden-second')
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toThrow('ATTEMPT_LIMIT')
    expect(candidateCount(f.db)).toBe(0)
  })

  it('fails closed for a Promise-returning resource guard and a closed explicit DB', () => {
    const f = fixture(), p = prepare(f)
    f.assertCurrent.mockImplementation((() => Promise.resolve()) as never)
    expect(() => f.grants.issue(p.request)).toThrow('ASYNC_GUARD_INVALID')
    f.assertCurrent.mockImplementation(() => {})
    f.db.close()
    expect(() => f.grants.get(p.request.grantId)).toThrow('DATABASE_NOT_READY')
  })
})
