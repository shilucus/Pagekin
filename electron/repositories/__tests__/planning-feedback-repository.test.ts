import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBaselineTables } from '../../migrations/baseline-schema'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { applyM08PlanningFeedback, verifyM08PlanningFeedback } from '../../migrations/m08-planning-feedback'
import { PLANNING_FEEDBACK_CORE_COLUMNS, type PlanningFeedbackBase, type PlanningFeedbackCandidate,
  type StagePlanningFeedbackCandidate } from '../../../src/shared/planning-feedback'
import { GenerationRunRepository } from '../generation-run-repository'
import { PlanningFeedbackRepository, planningFeedbackSourceHash, readPlanningFeedbackCoreSnapshot,
  type PlanningFeedbackRepositoryOptions } from '../planning-feedback-repository'
import { ProjectCoreRepository } from '../project-core-repository'

const handles: Database.Database[] = []
const directories: string[] = []
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(file = ':memory:') {
  const db = new Database(file)
  handles.push(db)
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.exec("INSERT INTO project_core(id,project_name,premise,worldbuilding) VALUES('main','Synthetic book','F0','World F0')")
  db.exec(M01_GENERATION_SQL)
  db.transaction(() => applyM08PlanningFeedback(db))()
  const frozen = new Set<string>()
  const assertCurrent = vi.fn(() => {})
  const assertGenerationCurrent: PlanningFeedbackRepositoryOptions['assertGenerationCurrent'] = vi.fn((receipt, base, parent, request) => {
    // Synthetic main-issued fixture evidence; production must use its admitted persistent proof.
    const expected = proof(base, parent, request.feedback, request.constraints)
    if (JSON.stringify(receipt.run.binding.sourceManifest.syntheticPlanningProof) !== JSON.stringify(expected)) {
      throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    }
  })
  const options: PlanningFeedbackRepositoryOptions = { projectId: 'project-A', assertCurrent,
    isFrozen: (table, id) => frozen.has(`${table}:${id}`), assertGenerationCurrent, now: () => 1000 }
  const repository = new PlanningFeedbackRepository(db, options)
  return { db, repository, options, frozen, assertCurrent }
}

function proof(base: PlanningFeedbackBase, parent: PlanningFeedbackCandidate | null, feedback: string, constraints: readonly string[]) {
  return { baseId: base.baseId, target: base.target, revision: base.sourceRevision, sourceHash: base.sourceHash,
    parentCandidateId: parent?.candidateId ?? null, parentHash: parent?.textHash ?? base.valueHash, feedback, constraints }
}

function generated(f: ReturnType<typeof fixture>, base: PlanningFeedbackBase, content: string, options: {
  parent?: PlanningFeedbackCandidate; feedback?: string; constraints?: readonly string[];
  finishReason?: string | null; trusted?: boolean; projectId?: string; wrongProof?: boolean;
  persistResult?: boolean; failureCode?: string;
} = {}) {
  const repository = new GenerationRunRepository(() => f.db)
  const h = hash('synthetic-frozen-input')
  const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
    templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
  const feedback = options.feedback ?? 'Keep the original premise', constraints = options.constraints ?? ['Preserve the title']
  const run = repository.open({ projectId: options.projectId ?? 'project-A', epoch: 'lease-A', operation: 'write',
    uiActionNonce: randomUUID(), frozenInputHash: h, fingerprint, contextSnapshotId: 'synthetic-context',
    sourceManifest: { syntheticPlanningProof: options.wrongProof ? {} : proof(base, options.parent ?? null, feedback, constraints) },
    sourceRefs: [], budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } })
  const policy = { estimatorVersion: 'fixture-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
  const reserved = repository.reserve(run.runId, 'request', h, 200, 100, policy)
  repository.markDispatched(reserved.attempt.attemptId)
  if (content) repository.snapshot(reserved.attempt.attemptId, 0, content)
  const receipt = options.persistResult === false ? repository.receipt(reserved.attempt.attemptId)
    : repository.settle(reserved.attempt.attemptId, { policy, trusted: options.trusted ?? true,
      actualTokens: 50, inputTokens: 25, completionTokens: 25 }, options.finishReason === undefined ? 'stop' : options.finishReason, options.failureCode)
  const request: StagePlanningFeedbackCandidate = { baseId: base.baseId, parentCandidateId: options.parent?.candidateId ?? null,
    feedback, constraints, runId: run.runId, attemptId: receipt.attempt.attemptId, artifactId: receipt.artifact!.artifactId }
  return { request, receipt, repository, policy }
}

function stage(f: ReturnType<typeof fixture>, base: PlanningFeedbackBase, content: string, parent?: PlanningFeedbackCandidate) {
  return f.repository.stageCandidate(generated(f, base, content, { parent }).request)
}

describe('planning feedback persistence and the single-field writer', () => {
  it('stores F0 -> C1 -> C2 without changing formal facts and keeps the real parent distinct from F0', () => {
    const f = fixture(), base = f.repository.captureBase('premise')
    const first = stage(f, base, 'C1'), second = stage(f, base, 'C2', first)
    expect(second).toMatchObject({ baseId: base.baseId, parentCandidateId: first.candidateId, generationParentHash: first.textHash })
    expect(f.repository.getBase(second.baseId)).toMatchObject({ value: 'F0', sourceRevision: 0 })
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
    expect(f.repository.listCandidates(base.baseId)).toHaveLength(2)
    expect(second.origin).toEqual({ kind: 'generated', runId: expect.any(String), attemptId: expect.any(String), artifactId: expect.any(String),
      modelLeaseRevision: expect.any(String), skillSnapshotHash: expect.any(String), contextSnapshotHash: expect.any(String) })
    expect(JSON.stringify(second.origin)).not.toMatch(/apiKey|baseUrl|leaseId|providerRequest/u)
  })

  it('adopts C2 against F0 through exactly one existing writer and retains the before snapshot', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), first = stage(f, base, 'C1'), second = stage(f, base, 'C2', first)
    const writer = vi.spyOn(ProjectCoreRepository, 'update')
    const receipt = f.repository.adopt({ candidateId: second.candidateId, idempotencyKey: 'choose-c2', decision: 'full', text: 'C2' })
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith({ premise: 'C2' }, f.db)
    expect(receipt).toMatchObject({ beforeValue: 'F0', beforeHash: base.valueHash, text: 'C2', sourceRevision: 0, committedRevision: 1,
      decisionSource: 'author-action' })
    expect(f.repository.candidateState(first.candidateId)).toBe('conflict')
    expect(f.repository.candidateState(second.candidateId)).toBe('adopted')
    expect(f.repository.listAdoptions(base.baseId)).toEqual([receipt])
  })

  it('stores only the fixed author-action provenance and rejects corrupt history instead of inferring authority from the candidate', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    const receipt = f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'author-action', decision: 'full', text: candidate.text })
    expect(f.db.prepare('SELECT decision_source FROM planning_feedback_adoptions WHERE adoption_id=?').pluck().get(receipt.adoptionId))
      .toBe('author-action')
    expect(() => f.db.prepare('UPDATE planning_feedback_adoptions SET decision_source=? WHERE adoption_id=?').run('automation', receipt.adoptionId))
      .toThrow()
    f.db.pragma('ignore_check_constraints=ON')
    try {
      f.db.prepare('UPDATE planning_feedback_adoptions SET decision_source=? WHERE adoption_id=?').run('automation', receipt.adoptionId)
    } finally { f.db.pragma('ignore_check_constraints=OFF') }
    expect(() => f.repository.listAdoptions(base.baseId)).toThrow('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  })

  it.each(['partial', 'edited'] as const)('%s adoption preserves exact final author bytes and permanently conflicts sibling descendants', decision => {
    const f = fixture(), base = f.repository.captureBase('premise'), first = stage(f, base, 'C1'), second = stage(f, base, 'C2', first)
    const sibling = stage(f, base, 'C3', first)
    const final = 'Author e\u0301\r\n  selection '
    f.repository.adopt({ candidateId: second.candidateId, idempotencyKey: decision, decision, text: final })
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe(final)
    for (const candidate of [first, sibling]) {
      expect(f.repository.candidateState(candidate.candidateId)).toBe('conflict')
      expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: candidate.candidateId,
        decision: 'full', text: candidate.text })).toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
    }
    expect(() => stage(f, base, 'late descendant', second)).toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  })

  it('consumes every base captured at F0 even when the final adopted text equals F0', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), first = stage(f, base, 'C1'), second = stage(f, base, 'C2', first)
    const otherBase = f.repository.captureBase('worldbuilding'), other = stage(f, otherBase, 'Other candidate')
    f.db.exec("UPDATE project_core SET premise='F0' WHERE id='main'")
    expect(f.repository.readSource().sourceRevision).toBe(base.sourceRevision)
    const receipt = f.repository.adopt({ candidateId: first.candidateId, idempotencyKey: 'same-value', decision: 'edited', text: 'F0' })
    expect(receipt.committedRevision).toBe(base.sourceRevision + 1)
    expect(f.repository.getBase(base.baseId).closedByAdoptionId).toBe(receipt.adoptionId)
    expect(f.repository.candidateState(second.candidateId)).toBe('conflict')
    expect(f.repository.getBase(otherBase.baseId).closedAt).toBeNull()
    expect(f.repository.candidateState(other.candidateId)).toBe('conflict')
    expect(() => f.repository.adopt({ candidateId: other.candidateId, idempotencyKey: 'other-base', decision: 'full', text: other.text }))
      .toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  })

  it('returns the original receipt on lost-reply replay without a writer call, but rejects any changed payload or decision', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    const request = { candidateId: candidate.candidateId, idempotencyKey: 'one-click', decision: 'full' as const, text: 'C1' }
    const receipt = f.repository.adopt(request), writer = vi.spyOn(ProjectCoreRepository, 'update')
    expect(f.repository.adopt(request)).toEqual(receipt)
    expect(writer).not.toHaveBeenCalled()
    expect(() => f.repository.adopt({ ...request, text: 'other' })).toThrow('PLANNING_FEEDBACK_IDEMPOTENCY_CONFLICT')
    expect(() => f.repository.adopt({ ...request, decision: 'edited' })).toThrow('PLANNING_FEEDBACK_IDEMPOTENCY_CONFLICT')
  })

  it.each(['C1', 'F0'])('rolls back formal value, source revision and base consumption when persisting %s fails', final => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    f.db.exec("CREATE TRIGGER fail_feedback_history BEFORE INSERT ON planning_feedback_adoptions BEGIN SELECT RAISE(ABORT,'fixture history failure'); END")
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'failed', decision: 'edited', text: final })).toThrow('fixture history failure')
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
    expect(f.repository.getBase(base.baseId).closedAt).toBeNull()
    expect(f.repository.listAdoptions(base.baseId)).toEqual([])
    expect(f.repository.candidateState(candidate.candidateId)).toBe('ready')
  })

  it('rejects a changed full-selection payload and unknown scope before any formal write', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'wrong', decision: 'full', text: 'not C1' })).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    const request = { candidateId: candidate.candidateId, idempotencyKey: 'scope', decision: 'edited' as const, text: 'other', scope: 'all' }
    expect(() => f.repository.adopt(request)).toThrow('PLANNING_FEEDBACK_PAYLOAD_INVALID')
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })
})

describe('planning feedback source identity and ABA', () => {
  it('exposes one authoritative source snapshot/hash and current-base check for main preparation', () => {
    const f = fixture(), base = f.repository.captureBase('premise')
    expect(f.repository.readSource()).toEqual({ source: base.source, sourceHash: base.sourceHash, sourceRevision: base.sourceRevision })
    expect(planningFeedbackSourceHash(readPlanningFeedbackCoreSnapshot(f.db))).toBe(base.sourceHash)
    expect(f.repository.assertBaseCurrent(base.baseId)).toEqual(base)
    f.db.exec("UPDATE project_core SET genre='changed author source' WHERE id='main'")
    expect(() => f.repository.assertBaseCurrent(base.baseId)).toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  })

  it.each(Object.entries(PLANNING_FEEDBACK_CORE_COLUMNS))('a raw %s A -> B -> A write never revives an old base', (field, column) => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    const original = base.source[field as keyof typeof base.source]
    const replacement = typeof original === 'number' ? original + 1 : `${original} changed`
    f.db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(replacement)
    f.db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(original)
    expect(f.repository.candidateState(candidate.candidateId)).toBe('conflict')
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'aba', decision: 'full', text: 'C1' }))
      .toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  })

  it('ignores derived fields and timestamp churn, but deletion/reinsertion changes source identity', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    f.db.exec("UPDATE project_core SET character_states='derived',characters_arch='projection',synopsis='not a v1 upstream',plot_tree_snapshot='cache',narrative_thread_dormant_threshold=8,updated_at='later' WHERE id='main'")
    expect(f.repository.candidateState(candidate.candidateId)).toBe('ready')
    f.db.exec("UPDATE project_core SET id='temporary' WHERE id='main'; UPDATE project_core SET id='main' WHERE id='temporary'")
    expect(f.repository.candidateState(candidate.candidateId)).toBe('conflict')
  })

  it('does not allow a parent from another adoption base', () => {
    const f = fixture(), firstBase = f.repository.captureBase('premise'), parent = stage(f, firstBase, 'C1')
    const otherBase = f.repository.captureBase('premise')
    expect(() => stage(f, otherBase, 'C2', parent)).toThrow('PLANNING_FEEDBACK_PARENT_CONFLICT')
  })

  it('rejects stale authority and corrupt candidate text without writing formal core', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    f.assertCurrent.mockImplementationOnce(() => { throw new Error('PROJECT_SESSION_STALE') })
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'stale', decision: 'full', text: 'C1' })).toThrow('PROJECT_SESSION_STALE')
    f.db.prepare('UPDATE planning_feedback_candidates SET text=? WHERE candidate_id=?').run('tampered', candidate.candidateId)
    expect(() => f.repository.getCandidate(candidate.candidateId)).toThrow('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })
})

describe('authoritative generation staging', () => {
  it('keeps the existing generation snapshot rejection without creating a candidate or writing formal facts', () => {
    const f = fixture(), base = f.repository.captureBase('premise')
    const writer = vi.spyOn(ProjectCoreRepository, 'update')
    expect(() => stage(f, base, 'The author discusses a literal <think> marker.')).toThrow('ARTIFACT_SNAPSHOT_CONFLICT')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(writer).not.toHaveBeenCalled()
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it.each([
    { finishReason: 'length' }, { trusted: false, finishReason: 'length' }, { trusted: false, finishReason: null },
    { projectId: 'another-project' }, { wrongProof: true },
    { failureCode: 'GENERATION_TRANSPORT_FAILED' }, { trusted: false, failureCode: 'GENERATION_TRANSPORT_FAILED' },
  ])('rejects incomplete/truncated/foreign/unproven/failed generation: %j', options => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'C1', options)
    expect(() => f.repository.stageCandidate(result.request)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it('stages and adopts a persisted stop with untrusted usage without settling or rewriting the unknown ledger', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'Complete C1', { trusted: false })
    const ledger = () => f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(result.request.attemptId)
    const before = ledger()
    expect(result.receipt.attempt.status).toBe('unknown')
    expect(result.receipt.result).toMatchObject({ finishReason: 'stop', usage: { trusted: false } })
    const candidate = f.repository.stageCandidate(result.request)
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
    const adoption = f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'choose-complete-unknown', decision: 'full', text: candidate.text })
    expect(adoption.text).toBe('Complete C1')
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('Complete C1')
    expect(result.repository.receipt(result.request.attemptId).attempt.status).toBe('unknown')
    expect(ledger()).toEqual(before)
  })

  it('rejects a recovered unknown attempt when no completion result was persisted', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'Saved partial text', { persistResult: false })
    result.repository.recoverInterrupted()
    expect(result.repository.receipt(result.request.attemptId)).toMatchObject({ attempt: { status: 'unknown' }, result: null })
    expect(() => f.repository.stageCandidate(result.request)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it.each([true, false])('rejects a cancelled root even with a persisted stop and trusted=%s usage', trusted => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'Complete C1', { trusted })
    result.repository.pause(result.receipt.run.rootActionId, true)
    expect(result.repository.receipt(result.request.attemptId).budget.root.status).toBe('cancelled')
    expect(() => f.repository.stageCandidate(result.request)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it('does not treat an in-memory stop as persisted completion when result storage fails', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'Persisted visible prefix', { persistResult: false })
    f.db.exec(`CREATE TRIGGER fail_feedback_result BEFORE UPDATE OF usage_receipt_json ON generation_attempts
      WHEN json_type(NEW.usage_receipt_json,'$.result') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'fixture result storage failure'); END`)
    expect(() => result.repository.settle(result.request.attemptId, { policy: result.policy, trusted: false, actualTokens: 50 }, 'stop'))
      .toThrow('fixture result storage failure')
    result.repository.recoverInterrupted()
    expect(result.repository.receipt(result.request.attemptId)).toMatchObject({ attempt: { status: 'unknown' }, result: null })
    expect(() => f.repository.stageCandidate(result.request)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it('rejects a receipt with an unsaved visible tail even when its stored prefix has a stop result', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'Stored prefix', { trusted: false })
    vi.spyOn(GenerationRunRepository.prototype, 'receipt').mockReturnValue({ ...result.receipt, unsavedTail: 'Unsaved tail' })
    expect(() => f.repository.stageCandidate(result.request)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
  })

  it('rolls back failed candidate storage without adopting text or changing an unknown ledger', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'Complete C1', { trusted: false })
    const before = f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(result.request.attemptId)
    f.db.exec("CREATE TRIGGER fail_feedback_candidate BEFORE INSERT ON planning_feedback_candidates BEGIN SELECT RAISE(ABORT,'fixture candidate storage failure'); END")
    expect(() => f.repository.stageCandidate(result.request)).toThrow('fixture candidate storage failure')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(ProjectCoreRepository.get(f.db)?.premise).toBe('F0')
    expect(f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(result.request.attemptId)).toEqual(before)
  })

  it('rejects forged feedback/constraints, discarded output and renderer-provided generated metadata', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), result = generated(f, base, 'C1')
    expect(() => f.repository.stageCandidate({ ...result.request, feedback: 'not the generated feedback' })).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => f.repository.stageCandidate({ ...result.request, constraints: ['different constraint'] })).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => f.repository.stageCandidate({ ...result.request, generated: true } as StagePlanningFeedbackCandidate)).toThrow('PLANNING_FEEDBACK_PAYLOAD_INVALID')
    f.db.prepare("UPDATE generation_artifacts SET status='discarded' WHERE artifact_id=?").run(result.request.artifactId)
    expect(() => f.repository.stageCandidate(result.request)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  })

  it('retains the generated global-guidance validator without imposing generated format on author edits', () => {
    const f = fixture(), base = f.repository.captureBase('globalGuidance')
    const invalid = generated(f, base, 'One rule')
    expect(() => f.repository.stageCandidate(invalid.request)).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    const candidate = stage(f, base, 'Keep names stable.\nPreserve chronology.\nKeep viewpoint stable.\nAvoid redundant summaries.')
    f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'author-edit', decision: 'edited', text: 'An author-selected free-text rule.' })
    expect(ProjectCoreRepository.get(f.db)?.globalGuidance).toBe('An author-selected free-text rule.')
  })

  it('does not stage C2 as a different parent or accept a promise as synchronous source proof', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), first = stage(f, base, 'C1')
    const result = generated(f, base, 'C2', { parent: first })
    expect(() => f.repository.stageCandidate({ ...result.request, parentCandidateId: null })).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    const asynchronous = new PlanningFeedbackRepository(f.db, { ...f.options, assertGenerationCurrent: () => Promise.resolve() })
    expect(() => asynchronous.stageCandidate(result.request)).toThrow('PLANNING_FEEDBACK_ASYNC_PROOF_INVALID')
    expect(f.repository.listCandidates(base.baseId)).toEqual([first])
  })
})

describe('restart, portable history and migration ownership', () => {
  it('reopens the original database with revision, parent lineage and receipt replay intact', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-planning-feedback-'))
    directories.push(directory)
    const file = path.join(directory, 'project.sqlite'), f = fixture(file)
    const base = f.repository.captureBase('premise'), first = stage(f, base, 'C1'), second = stage(f, base, 'C2', first)
    const request = { candidateId: second.candidateId, idempotencyKey: 'saved-click', decision: 'full' as const, text: 'C2' }
    const receipt = f.repository.adopt(request)
    f.db.close()
    const reopened = new Database(file)
    handles.push(reopened)
    const repository = new PlanningFeedbackRepository(reopened, f.options)
    expect(repository.getCandidate(second.candidateId).parentCandidateId).toBe(first.candidateId)
    expect(repository.adopt(request)).toEqual(receipt)
    expect(repository.captureBase('premise').sourceRevision).toBe(1)
    expect(repository.candidateState(first.candidateId)).toBe('conflict')
  })

  it('retains old content readably in a new copy but requires a new base and explicit lineage before adoption', () => {
    const f = fixture(), oldBase = f.repository.captureBase('premise'), old = stage(f, oldBase, 'old candidate')
    const oldRequest = { candidateId: old.candidateId, idempotencyKey: 'old-click', decision: 'full' as const, text: old.text }
    f.repository.adopt(oldRequest)
    f.frozen.add(`planning_feedback_bases:${oldBase.baseId}`)
    f.frozen.add(`planning_feedback_candidates:${old.candidateId}`)
    const copy = new PlanningFeedbackRepository(f.db, { ...f.options, projectId: 'new-copy-project' })
    expect(copy.getCandidate(old.candidateId).text).toBe('old candidate')
    expect(copy.candidateState(old.candidateId)).toBe('frozen')
    expect(() => copy.adopt(oldRequest)).toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
    const base = copy.captureBase('premise')
    const fresh = copy.relineageCandidate({ baseId: base.baseId, sourceCandidateId: old.candidateId, feedback: 'Explicitly reuse this text', constraints: [] })
    expect(fresh).toMatchObject({ baseId: base.baseId, parentCandidateId: null, generationParentHash: base.valueHash,
      origin: { kind: 'copied', sourceCandidateId: old.candidateId, originProjectId: 'project-A', sourceTextHash: old.textHash } })
    const receipt = copy.adopt({ candidateId: fresh.candidateId, idempotencyKey: 'new-explicit-click', decision: 'edited', text: 'new copy author selection' })
    expect(receipt.projectId).toBe('new-copy-project')
    expect(copy.getCandidate(old.candidateId)).toEqual(old)
    expect(copy.listAdoptions(oldBase.baseId)).toHaveLength(1)
  })

  it('checks the portable freeze before returning an old same-project idempotent receipt', () => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'C1')
    const request = { candidateId: candidate.candidateId, idempotencyKey: 'click', decision: 'full' as const, text: 'C1' }
    const receipt = f.repository.adopt(request)
    f.frozen.add(`planning_feedback_adoptions:${receipt.adoptionId}`)
    expect(() => f.repository.adopt(request)).toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
  })

  it.each(['generated', 'copied'] as const)('reads redacted %s origin and adoption only under the exact portable record freezes', sourceKind => {
    const f = fixture(), base = f.repository.captureBase('premise'), candidate = stage(f, base, 'Portable text')
    const request = { candidateId: candidate.candidateId, idempotencyKey: 'original-click', decision: 'full' as const, text: candidate.text }
    const receipt = f.repository.adopt(request)
    const origin = sourceKind === 'generated'
      ? { kind: 'portable-history', sourceKind, runId: 'old-run', attemptId: 'old-attempt', artifactId: 'old-artifact' }
      : { kind: 'portable-history', sourceKind, sourceCandidateId: 'older-candidate', originProjectId: 'older-project', sourceTextHash: candidate.textHash }
    f.db.prepare('UPDATE planning_feedback_candidates SET origin_json=? WHERE candidate_id=?').run(JSON.stringify(origin), candidate.candidateId)
    f.db.prepare('UPDATE planning_feedback_adoptions SET request_hash=?,idempotency_key=? WHERE adoption_id=?')
      .run('', `portable-history:${receipt.adoptionId}`, receipt.adoptionId)
    expect(() => f.repository.getCandidate(candidate.candidateId)).toThrow('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    f.frozen.add(`planning_feedback_candidates:${candidate.candidateId}`)
    expect(f.repository.getCandidate(candidate.candidateId).origin).toEqual(origin)
    expect(() => f.repository.listAdoptions(base.baseId)).toThrow('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    f.frozen.add('planning_feedback_adoptions:unrelated-receipt')
    expect(() => f.repository.listAdoptions(base.baseId)).toThrow('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    f.frozen.add(`planning_feedback_adoptions:${receipt.adoptionId}`)
    expect(f.repository.listAdoptions(base.baseId)[0]).toMatchObject({ text: candidate.text, beforeValue: 'F0', requestHash: '', decisionSource: 'author-action',
      idempotencyKey: `portable-history:${receipt.adoptionId}` })
    expect(() => f.repository.adopt(request)).toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
    const nextBase = f.repository.captureBase('premise')
    const next = f.repository.relineageCandidate({ baseId: nextBase.baseId, sourceCandidateId: candidate.candidateId, feedback: 'Explicit copy', constraints: [] })
    expect(next.origin).toEqual({ kind: 'copied', sourceCandidateId: candidate.candidateId, originProjectId: candidate.projectId, sourceTextHash: candidate.textHash })
    expect(next.origin.kind).not.toBe('generated')
    f.repository.adopt({ candidateId: next.candidateId, idempotencyKey: 'fresh-click', decision: 'full', text: next.text })
    expect(f.repository.listAdoptions(nextBase.baseId)).toHaveLength(1)
  })

  it('requires the central transaction and rolls back migration DDL with that transaction', () => {
    const db = new Database(':memory:')
    handles.push(db)
    applyBaselineTables(db)
    expect(() => applyM08PlanningFeedback(db)).toThrow('PLANNING_FEEDBACK_MIGRATION_TRANSACTION_REQUIRED')
    expect(() => db.transaction(() => { applyM08PlanningFeedback(db); throw new Error('rollback') })()).toThrow('rollback')
    expect(verifyM08PlanningFeedback(db)).toBe(false)
    db.transaction(() => applyM08PlanningFeedback(db))()
    expect(verifyM08PlanningFeedback(db)).toBe(true)
  })
})
