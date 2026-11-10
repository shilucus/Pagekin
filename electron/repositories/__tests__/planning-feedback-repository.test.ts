import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBaselineTables } from '../../migrations/baseline-schema'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { applyM02CharacterIdentity } from '../../migrations/m02-character-identity'
import { applyM08PlanningFeedback, verifyM08PlanningFeedback } from '../../migrations/m08-planning-feedback'
import { applyM09PlanningFeedbackRanges } from '../../migrations/m09-planning-feedback-ranges'
import { applyM10RuntimeFeedbackGrants } from '../../migrations/m10-runtime-feedback-grants'
import { applyM15PlanningFeedbackBlueprints } from '../../migrations/m15-planning-feedback-blueprints'
import { ensureBaselineBlueprintTables } from '../../migrations/baseline-blueprint-schema'
import { PLANNING_FEEDBACK_CORE_COLUMNS, type PlanningFeedbackBase, type PlanningFeedbackCandidate,
  BLUEPRINT_FEEDBACK_FIELDS, type BlueprintFeedbackField, type StagePlanningFeedbackCandidate } from '../../../src/shared/planning-feedback'
import { GenerationRunRepository } from '../generation-run-repository'
import { PlanningFeedbackRepository, planningFeedbackSourceHash, readPlanningFeedbackCoreSnapshot,
  type PlanningFeedbackRepositoryOptions } from '../planning-feedback-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import { plotOutlineCoverageNote } from '../../../src/shared/plot-outline-contract'
import { BlueprintRepository, type BlueprintData } from '../blueprint-repository'
import { ensureCharacterRosterSchema } from '../character-roster-schema'

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
  db.transaction(() => applyM09PlanningFeedbackRanges(db))()
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

const outlineEntry = (chapter: number, label = 'F0') => `## Chapter ${chapter}: ${label}\n${label} complete chapter ${chapter}.`
const outlineBody = (from: number, to: number, label = 'F0') => Array.from({ length: to - from + 1 }, (_, index) => outlineEntry(from + index, label)).join('\n\n')
function outlineFixture(file = ':memory:') {
  const f = fixture(file)
  const synopsis = `Author preface e\u0301\r\n\r\n# Plot Outline\n\n${outlineBody(1, 6)}`
  ProjectCoreRepository.update({ synopsis, totalChapters: 6 }, f.db)
  f.db.prepare("UPDATE project_core SET characters_arch=? WHERE id='main'").run('Original author character architecture')
  return { ...f, synopsis }
}

describe('fixed plot-outline range feedback adapter', () => {
  it('lists only exact schema2 range summaries without full sources or JSON key-order dependence', () => {
    const f = outlineFixture(), scope = { kind: 'plot-outline-range' as const, from: 3, to: 4 }
    const closed = f.repository.captureBase(scope)
    f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 5 })
    f.repository.captureBase({ kind: 'plot-outline-range', from: 1, to: 2 })
    const field = f.repository.captureBase('coreOutline')
    const candidate = stage(f, closed, outlineBody(3, 4, 'Listed candidate'))
    const adoption = f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'listed-range', decision: 'full', text: candidate.text })
    const open = f.repository.captureBase(scope)
    f.db.prepare('UPDATE planning_feedback_bases SET scope_json=? WHERE base_id=?')
      .run(JSON.stringify({ to: 4, from: 3, kind: 'plot-outline-range' }), closed.baseId)
    f.db.prepare('UPDATE planning_feedback_bases SET created_at=1001 WHERE base_id=?').run(open.baseId)
    const changes = f.db.prepare('SELECT total_changes()').pluck().get()

    expect(f.repository.listRangeBases(scope)).toEqual([
      { baseId: open.baseId, projectId: 'project-A', target: 'plotOutlineRange', scope, createdAt: 1001, closedAt: null, closedByAdoptionId: null },
      { baseId: closed.baseId, projectId: 'project-A', target: 'plotOutlineRange', scope, createdAt: closed.createdAt,
        closedAt: adoption.createdAt, closedByAdoptionId: adoption.adoptionId },
    ])
    expect(f.repository.listFieldBases('coreOutline')).toEqual([{ baseId: field.baseId, projectId: 'project-A', target: 'coreOutline',
      createdAt: field.createdAt, closedAt: null, closedByAdoptionId: null }])
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  })

  it('lists current-project and exact frozen range history only, retaining the authority guard', () => {
    const f = outlineFixture(), scope = { kind: 'plot-outline-range' as const, from: 3, to: 4 }
    const own = f.repository.captureBase(scope)
    const foreign = new PlanningFeedbackRepository(f.db, { ...f.options, projectId: 'other-project' })
    const allowed = foreign.captureBase(scope), denied = foreign.captureBase(scope)
    f.frozen.add(`planning_feedback_candidates:${denied.baseId}`)
    expect(f.repository.listRangeBases(scope).map(base => base.baseId)).toEqual([own.baseId])
    f.frozen.add(`planning_feedback_bases:${allowed.baseId}`)
    expect(f.repository.listRangeBases(scope).map(base => base.baseId).sort()).toEqual([own.baseId, allowed.baseId].sort())
    expect(f.repository.listRangeBases(scope).find(base => base.baseId === allowed.baseId)?.projectId).toBe('other-project')
    f.assertCurrent.mockImplementationOnce(() => { throw new Error('FICTIONAL_SESSION_STALE') })
    expect(() => f.repository.listRangeBases(scope)).toThrow('FICTIONAL_SESSION_STALE')
  })

  it.each([
    { kind: 'field', field: 'coreOutline' },
    { kind: 'plot-outline-range', from: 0, to: 2 },
    { kind: 'plot-outline-range', from: 4, to: 3 },
    { kind: 'plot-outline-range', from: 3, to: 4, source: 'untrusted' },
  ])('rejects invalid range-summary scope %j without writing', scope => {
    const f = outlineFixture(), changes = f.db.prepare('SELECT total_changes()').pluck().get()
    expect(() => f.repository.listRangeBases(scope as never)).toThrow()
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  })

  it('keeps F0 while C2 records C1 as the real parent, then adopts only the exact range with the existing synopsis CAS writer', () => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const before = ProjectCoreRepository.get(f.db)!, first = stage(f, base, outlineBody(3, 4, 'C1')), second = stage(f, base, outlineBody(3, 4, 'C2'), first)
    expect(base).toMatchObject({ schemaVersion: 2, target: 'plotOutlineRange', value: outlineBody(3, 4),
      scope: { kind: 'plot-outline-range', from: 3, to: 4 }, source: { synopsis: f.synopsis, charactersArch: before.charactersArch } })
    expect(second).toMatchObject({ schemaVersion: 2, baseId: base.baseId, parentCandidateId: first.candidateId, generationParentHash: first.textHash })
    expect(ProjectCoreRepository.get(f.db)).toEqual(before)
    const writer = vi.spyOn(ProjectCoreRepository, 'commitSynopsis'), ordinaryWriter = vi.spyOn(ProjectCoreRepository, 'update')
    const request = { candidateId: second.candidateId, idempotencyKey: 'range-c2', decision: 'full' as const, text: second.text }
    const adoption = f.repository.adopt(request)
    expect(writer).toHaveBeenCalledTimes(1)
    expect(ordinaryWriter).not.toHaveBeenCalled()
    expect(ProjectCoreRepository.get(f.db)).toEqual({ ...before, synopsis: f.synopsis.replace(outlineBody(3, 4), second.text) })
    expect(adoption).toMatchObject({ schemaVersion: 2, beforeValue: base.value, sourceRevision: base.sourceRevision,
      committedRevision: base.sourceRevision + 1, adoptedScope: base.scope, decisionSource: 'author-action' })
    expect(f.repository.candidateState(first.candidateId)).toBe('conflict')
    expect(f.repository.adopt(request)).toEqual(adoption)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it.each([3, 4])('partially adopts only chapter %s within 3-4 and preserves every outside chapter and field', chapter => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const first = stage(f, base, outlineBody(3, 4, 'C1')), second = stage(f, base, outlineBody(3, 4, 'C2'), first)
    const before = ProjectCoreRepository.get(f.db)!, text = outlineEntry(chapter, 'Author final')
    const request = { candidateId: second.candidateId, idempotencyKey: `only-${chapter}`, decision: 'partial' as const,
      adoptedRange: { from: chapter, to: chapter }, text }
    const receipt = f.repository.adopt(request)
    expect(ProjectCoreRepository.get(f.db)).toEqual({ ...before, synopsis: f.synopsis.replace(outlineEntry(chapter), text) })
    expect(receipt.adoptedScope).toEqual({ kind: 'plot-outline-range', from: chapter, to: chapter })
    expect(receipt.beforeValue).toBe(outlineBody(3, 4))
    expect(f.repository.candidateState(first.candidateId)).toBe('conflict')
    expect(() => stage(f, base, outlineBody(3, 4, 'C3'), second)).toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
    expect(f.repository.adopt(request)).toEqual(receipt)
    expect(() => f.repository.adopt({ ...request, adoptedRange: { from: 3, to: 4 }, text: outlineBody(3, 4, 'different') }))
      .toThrow('PLANNING_FEEDBACK_IDEMPOTENCY_CONFLICT')
  })

  it.each([
    { label: 'no coverage note', eol: '\n', language: 'zh-CN' as const, tail: '\n\n\n' },
    { label: 'CRLF without coverage note', eol: '\r\n', language: 'zh-CN' as const, tail: '\r\n\r\n \t\r\n' },
    { label: 'old English coverage note with changed total', eol: '\n', language: 'zh-CN' as const,
      tail: `\n\n\n${plotOutlineCoverageNote(4, 30, 'en-US')}` },
    { label: 'old Chinese coverage note with changed language and total', eol: '\n', language: 'en-US' as const,
      tail: `\n\n${plotOutlineCoverageNote(4, 24, 'zh-CN')}` },
    { label: 'CRLF and mixed old coverage notes', eol: '\r\n', language: 'en-US' as const,
      tail: `\r\n\r\n\r\n${plotOutlineCoverageNote(4, 30, 'en-US')}\r\n\r\n${plotOutlineCoverageNote(4, 24, 'zh-CN')}\r\n\r\n \t\r\n` },
  ].flatMap(scenario => (['full', 'partial'] as const).map(mode => ({ ...scenario, mode }))))('preserves all bytes outside the existing last-chapter span ($label / $mode)', ({ eol, language, tail, mode }) => {
    const f = fixture(), entry = (chapter: number) => outlineEntry(chapter).replaceAll('\n', eol)
    const gap = `${eol}${eol} \t${eol}${eol}`
    const prefix = `Author preface e\u0301${eol}${eol}# Existing outline title${gap}${entry(1)}${gap}${entry(2)}${gap}`
      + (mode === 'partial' ? `${entry(3)}${gap}` : '')
    const selected = mode === 'partial' ? entry(4) : `${entry(3)}${gap}${entry(4)}`
    const synopsis = `${prefix}${selected}${tail}`
    ProjectCoreRepository.update({ synopsis, totalChapters: 12, writingLanguage: language }, f.db)
    f.db.prepare("UPDATE project_core SET characters_arch=? WHERE id='main'").run('Original author character architecture')
    const base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const candidate = stage(f, base, outlineBody(3, 4, 'Generated'))
    const before = ProjectCoreRepository.get(f.db)!, writer = vi.spyOn(ProjectCoreRepository, 'commitSynopsis')
    const text = mode === 'full' ? candidate.text : outlineEntry(4, 'Author final')
    const receipt = f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'last-existing-chapter',
      decision: mode, text, ...(mode === 'partial' ? { adoptedRange: { from: 4, to: 4 } } : {}) })
    const expected = `${prefix}${text}${tail}`, after = ProjectCoreRepository.get(f.db)!
    expect(writer).toHaveBeenCalledTimes(1)
    expect(after).toEqual({ ...before, synopsis: expected })
    expect(after.synopsis.slice(0, prefix.length)).toBe(prefix)
    expect(after.synopsis.slice(prefix.length + text.length)).toBe(tail)
    expect(receipt).toMatchObject({ committedRevision: base.sourceRevision + 1,
      adoptedScope: { kind: 'plot-outline-range', from: mode === 'partial' ? 4 : 3, to: 4 } })
  })

  it.each([
    { text: outlineEntry(3) },
    { text: `${outlineEntry(3)}\n\n${outlineEntry(3)}` },
    { text: `${outlineEntry(3)}\n\n${outlineEntry(5)}` },
    { text: `${outlineEntry(4)}\n\n${outlineEntry(3)}` },
    { text: `Unauthorized preface\n\n${outlineBody(3, 4)}` },
    { text: outlineBody(3, 4), adoptedRange: { from: 2, to: 4 } },
    { text: outlineBody(3, 4), adoptedRange: { from: 3, to: 5 } },
  ])('rejects malformed final chapter coverage or scope expansion before any formal write: %j', payload => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 }), candidate = stage(f, base, outlineBody(3, 4, 'C1'))
    const writer = vi.spyOn(ProjectCoreRepository, 'commitSynopsis')
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'invalid-range', decision: 'edited', ...payload })).toThrow()
    expect(writer).not.toHaveBeenCalled()
    expect(ProjectCoreRepository.get(f.db)?.synopsis).toBe(f.synopsis)
    expect(f.repository.listAdoptions(base.baseId)).toEqual([])
    expect(f.repository.candidateState(candidate.candidateId)).toBe('ready')
  })

  it('rejects full-selection scope narrowing and incomplete generated candidates', () => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 }), candidate = stage(f, base, outlineBody(3, 4, 'C1'))
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'full-but-narrow', decision: 'full',
      text: candidate.text, adoptedRange: { from: 3, to: 3 } })).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    expect(() => stage(f, base, outlineEntry(3, 'Missing chapter 4'))).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    expect(f.repository.listCandidates(base.baseId)).toEqual([candidate])
    expect(ProjectCoreRepository.get(f.db)?.synopsis).toBe(f.synopsis)
  })

  it.each([
    outlineEntry(1), `${outlineBody(1, 3)}\n\n${outlineEntry(5)}`, `${outlineBody(1, 3)}\n\n${outlineEntry(3)}\n\n${outlineBody(4, 6)}`,
    `${outlineBody(1, 2)}\n\n## Chapters 3-4: Grouped\nNot exact chapters.`,
  ])('never fills missing or malformed existing chapter ranges during capture', synopsis => {
    const f = outlineFixture()
    ProjectCoreRepository.update({ synopsis }, f.db)
    expect(() => f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })).toThrow()
    expect(f.db.prepare('SELECT COUNT(*) FROM planning_feedback_bases').pluck().get()).toBe(0)
    expect(ProjectCoreRepository.get(f.db)?.synopsis).toBe(synopsis)
  })

  it.each([...Object.entries(PLANNING_FEEDBACK_CORE_COLUMNS), ['synopsis', 'synopsis'], ['charactersArch', 'characters_arch']])('detects raw %s A -> B -> A writes through the range source revision', (_field, column) => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 }), candidate = stage(f, base, outlineBody(3, 4, 'C1'))
    const original = f.db.prepare(`SELECT ${column} FROM project_core WHERE id='main'`).pluck().get() as string | number
    f.db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(typeof original === 'number' ? original + 1 : `${original} changed`)
    f.db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(original)
    expect(f.repository.candidateState(candidate.candidateId)).toBe('conflict')
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'range-aba', decision: 'full', text: candidate.text }))
      .toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
    expect(ProjectCoreRepository.get(f.db)?.synopsis).toBe(f.synopsis)
  })

  it('consumes same-content range baselines without invalidating unrelated core fields or derived caches', () => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const otherBase = f.repository.captureBase({ kind: 'plot-outline-range', from: 1, to: 2 })
    const candidate = stage(f, base, base.value), other = stage(f, otherBase, outlineBody(1, 2, 'Other'))
    const fieldBase = f.repository.captureBase('premise'), field = stage(f, fieldBase, 'Core candidate')
    f.db.exec("UPDATE project_core SET synopsis=synopsis,character_states='derived',plot_tree_snapshot='cache',updated_at='later' WHERE id='main'")
    expect(f.repository.candidateState(candidate.candidateId)).toBe('ready')
    const receipt = f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'range-same', decision: 'full', text: candidate.text })
    expect(receipt.committedRevision).toBe(base.sourceRevision + 1)
    expect(ProjectCoreRepository.get(f.db)?.synopsis).toBe(f.synopsis)
    expect(f.repository.candidateState(other.candidateId)).toBe('conflict')
    expect(f.repository.candidateState(field.candidateId)).toBe('ready')
  })

  it('consumes dependent outline baselines when a same-content core adoption consumes their frozen upstream', () => {
    const f = outlineFixture(), range = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const candidate = stage(f, range, outlineBody(3, 4, 'C1')), fieldBase = f.repository.captureBase('premise'), field = stage(f, fieldBase, 'Field C1')
    f.repository.adopt({ candidateId: field.candidateId, idempotencyKey: 'core-same', decision: 'edited', text: fieldBase.value })
    expect(f.repository.candidateState(candidate.candidateId)).toBe('conflict')
    expect(ProjectCoreRepository.get(f.db)?.synopsis).toBe(f.synopsis)
  })

  it.each(['same', 'changed'] as const)('rolls back synopsis, revisions and history if range adoption persistence fails (%s)', mode => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 }), candidate = stage(f, base, outlineBody(3, 4, 'C1'))
    const before = f.repository.readSource('plotOutlineRange')
    f.db.exec("CREATE TRIGGER fail_range_history BEFORE INSERT ON planning_feedback_adoptions BEGIN SELECT RAISE(ABORT,'range history failure'); END")
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'range-failed', decision: 'edited',
      text: mode === 'same' ? base.value : candidate.text })).toThrow('range history failure')
    expect(f.repository.readSource('plotOutlineRange')).toEqual(before)
    expect(f.repository.getBase(base.baseId).closedAt).toBeNull()
    expect(f.repository.listAdoptions(base.baseId)).toEqual([])
    expect(f.repository.candidateState(candidate.candidateId)).toBe('ready')
  })

  it('preserves range lineage and partial-adoption idempotence across a real database reopen', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-feedback-range-'))
    directories.push(directory)
    const file = path.join(directory, 'project.sqlite'), f = outlineFixture(file)
    const base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 }), first = stage(f, base, outlineBody(3, 4, 'C1'))
    const second = stage(f, base, outlineBody(3, 4, 'C2'), first)
    const request = { candidateId: second.candidateId, idempotencyKey: 'saved-range', decision: 'partial' as const,
      adoptedRange: { from: 3, to: 3 }, text: outlineEntry(3, 'Final') }
    const receipt = f.repository.adopt(request)
    f.db.close()
    const reopened = new Database(file)
    handles.push(reopened)
    const repository = new PlanningFeedbackRepository(reopened, f.options)
    expect(repository.getCandidate(second.candidateId).parentCandidateId).toBe(first.candidateId)
    expect(repository.adopt(request)).toEqual(receipt)
    expect(repository.candidateState(first.candidateId)).toBe('conflict')
    expect(repository.readSource('plotOutlineRange').sourceRevision).toBe(receipt.committedRevision)
    expect(repository.listRangeBases({ kind: 'plot-outline-range', from: 3, to: 4 })).toEqual([
      { baseId: base.baseId, projectId: base.projectId, target: 'plotOutlineRange', scope: base.scope,
        createdAt: base.createdAt, closedAt: receipt.createdAt, closedByAdoptionId: receipt.adoptionId },
    ])
  })

  it('permits only explicit same-scope new-copy lineage and never adopts a frozen old range candidate', () => {
    const f = outlineFixture(), base = f.repository.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 }), candidate = stage(f, base, outlineBody(3, 4, 'Old'))
    f.frozen.add(`planning_feedback_bases:${base.baseId}`)
    f.frozen.add(`planning_feedback_candidates:${candidate.candidateId}`)
    const copy = new PlanningFeedbackRepository(f.db, { ...f.options, projectId: 'new-copy' })
    expect(copy.getCandidate(candidate.candidateId)).toEqual(candidate)
    expect(() => copy.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'old-range', decision: 'full', text: candidate.text }))
      .toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
    const other = copy.captureBase({ kind: 'plot-outline-range', from: 1, to: 2 })
    expect(() => copy.relineageCandidate({ baseId: other.baseId, sourceCandidateId: candidate.candidateId, feedback: 'Copy', constraints: [] }))
      .toThrow('PLANNING_FEEDBACK_PARENT_CONFLICT')
    const freshBase = copy.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const fresh = copy.relineageCandidate({ baseId: freshBase.baseId, sourceCandidateId: candidate.candidateId, feedback: 'Explicit new copy', constraints: [] })
    expect(fresh.origin).toMatchObject({ kind: 'copied', sourceCandidateId: candidate.candidateId })
    copy.adopt({ candidateId: fresh.candidateId, idempotencyKey: 'fresh-range', decision: 'full', text: fresh.text })
    expect(copy.getCandidate(candidate.candidateId)).toEqual(candidate)
  })
})

function blueprintFixture(file = ':memory:') {
  const f = outlineFixture(file)
  f.db.transaction(() => { ensureCharacterRosterSchema(f.db); applyM02CharacterIdentity(f.db) })()
  f.db.transaction(() => applyM10RuntimeFeedbackGrants(f.db))()
  ensureBaselineBlueprintTables(f.db)
  for (const chapterNumber of [1, 2, 3]) {
    const blueprint: BlueprintData = { chapterNumber, title: `Title ${chapterNumber}`, role: 'Turn', purpose: 'Original purpose',
      keyEvents: 'Original events', characters: ['Original hero'], suspenseHook: 'Original hook',
      userGuidance: 'Original guidance', notes: 'Original notes', notesUpdatedAt: '2026-11-10T00:00:00.000Z' }
    BlueprintRepository.upsert(blueprint, f.db)
  }
  f.db.transaction(() => applyM15PlanningFeedbackBlueprints(f.db))()
  return f
}

const blueprintScope = (fields: readonly BlueprintFeedbackField[] = ['title', 'purpose']) =>
  ({ kind: 'blueprint-fields' as const, chapterNumber: 2, fields })

describe('persistent single-chapter blueprint feedback kernel', () => {
  it('records actual F0-C1-C2 proof while leaving formal blueprints and character facts unchanged until adoption', () => {
    const f = blueprintFixture(), original = BlueprintRepository.getAll(f.db)
    const base = f.repository.captureBase(blueprintScope(['purpose', 'title']))
    const first = stage(f, base, JSON.stringify({ title: 'C1 title', purpose: 'C1 purpose' }))
    const second = stage(f, base, JSON.stringify({ purpose: 'C2 purpose', title: 'C2 title' }), first)
    expect(base).toMatchObject({ schemaVersion: 3, target: 'blueprintFields', scope: blueprintScope(),
      value: JSON.stringify({ title: 'Title 2', purpose: 'Original purpose' }) })
    expect(Object.keys(base.source.blueprint)).toEqual(['chapterNumber', ...BLUEPRINT_FEEDBACK_FIELDS, 'notesUpdatedAt'])
    expect(second).toMatchObject({ schemaVersion: 3, baseId: base.baseId, parentCandidateId: first.candidateId,
      generationParentHash: first.textHash, origin: { kind: 'generated' } })
    expect(first.generationParentHash).toBe(base.valueHash)
    expect(f.repository.getCandidate(second.candidateId)).toEqual(second)
    expect(f.repository.readSource('blueprintFields', base.scope)).toEqual({ source: base.source, sourceHash: base.sourceHash, sourceRevision: base.sourceRevision })
    expect(BlueprintRepository.getAll(f.db)).toEqual(original)
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
    const invalid = generated(f, base, second.text, { parent: second, wrongProof: true })
    expect(() => f.repository.stageCandidate(invalid.request)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.repository.listCandidates(base.baseId)).toHaveLength(2)
  })

  it.each(['partial', 'full'] as const)('adopts %s scope without authorizing identity/proposal sync or copying historic auxiliary input', decision => {
    const f = blueprintFixture(), original = BlueprintRepository.getAll(f.db)
    // A prior ordinary writer operation may retain auxiliary proposals; schema3 reads only the persisted ten fields.
    BlueprintRepository.commitRange({ mode: 'replace-range', operationId: 'old-auxiliary', startChapter: 2, endChapter: 2,
      blueprints: [{ ...original[1]!, newCharacterCandidates: [], relationshipHints: [] }] }, undefined, f.db)
    const rosterBefore = f.db.prepare('SELECT * FROM character_roster_meta').all()
    const identityTables = ['character_identity_meta', 'character_identity_origins', 'character_aliases',
      'character_identity_proposals', 'character_identity_approvals', 'character_relationships'] as const
    const identitiesBefore = identityTables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const oldInput = f.db.prepare("SELECT character_sync_input FROM blueprint_commit_operations WHERE operation_id='old-auxiliary'").pluck().get()
    const base = f.repository.captureBase(blueprintScope(['title', 'purpose', 'characters']))
    const first = stage(f, base, JSON.stringify({ title: 'C1 title', purpose: 'C1 purpose', characters: ['Original hero'] }))
    const candidate = stage(f, base, JSON.stringify({ title: 'C2 title', purpose: 'C2 purpose', characters: ['Candidate-only name'] }), first)
    const text = decision === 'full' ? candidate.text : JSON.stringify({ title: 'Author selected title' })
    const receipt = f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: `blueprint-${decision}`, decision, text })
    const expectedFields = decision === 'full' ? ['title', 'purpose', 'characters'] : ['title']
    expect(receipt).toMatchObject({ schemaVersion: 3, target: 'blueprintFields', beforeValue: base.value,
      beforeHash: base.valueHash, sourceRevision: base.sourceRevision, committedRevision: base.sourceRevision + 1,
      adoptedScope: blueprintScope(expectedFields as BlueprintFeedbackField[]) })
    expect(BlueprintRepository.getByChapter(2, f.db)).toEqual({ ...original[1],
      ...(decision === 'full' ? JSON.parse(candidate.text) : { title: 'Author selected title' }) })
    expect(BlueprintRepository.getByChapter(1, f.db)).toEqual(original[0])
    expect(BlueprintRepository.getByChapter(3, f.db)).toEqual(original[2])
    expect(f.repository.candidateState(first.candidateId)).toBe('conflict')
    expect(f.repository.candidateState(candidate.candidateId)).toBe('adopted')
    const operation = BlueprintRepository.getCommittedRangeOperation(`planning-feedback:${receipt.adoptionId}`, f.db)!
    expect(Object.keys(operation.characterSyncInput[0]!)).toEqual(['chapterNumber', ...BLUEPRINT_FEEDBACK_FIELDS, 'notesUpdatedAt'])
    expect(operation.characterSyncOperation.status).toBe('pending')
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT * FROM character_roster_meta').all()).toEqual(rosterBefore)
    expect(identityTables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(identitiesBefore)
    expect(f.db.prepare('SELECT COUNT(*) FROM character_roster_operations').pluck().get()).toBe(0)
    expect(f.db.prepare("SELECT character_sync_input FROM blueprint_commit_operations WHERE operation_id='old-auxiliary'").pluck().get()).toBe(oldInput)
  })

  it('saves explicitly empty author fields without refreshing notesUpdatedAt', () => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope(['notes', 'userGuidance']))
    const candidate = stage(f, base, JSON.stringify({ userGuidance: '', notes: '' }))
    f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'empty-author-fields', decision: 'full', text: candidate.text })
    expect(BlueprintRepository.getByChapter(2, f.db)).toMatchObject({ userGuidance: '', notes: '', notesUpdatedAt: base.source.blueprint.notesUpdatedAt })
  })

  it.each(['{}', '{"title":"missing purpose"}', '{"title":"x","purpose":"p","notes":"outside selection"}',
    '{"title":"x","purpose":"p","newCharacterCandidates":[]}', '{"title":"x","purpose":"p","relationshipHints":{}}',
    '```json\n{"title":"x","purpose":"p"}\n```'])('rejects invalid generated selection %s before creating a candidate or formal write', text => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope()), request = generated(f, base, text).request
    const original = BlueprintRepository.getAll(f.db)
    expect(() => f.repository.stageCandidate(request)).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(BlueprintRepository.getAll(f.db)).toEqual(original)
  })

  it('requires exact full candidate text and a nonempty selected-only author subset', () => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope()), candidate = stage(f, base, '{"title":"C1","purpose":"P1"}')
    const original = BlueprintRepository.getAll(f.db)
    for (const text of ['{}', '{"notes":"outside"}', '{"chapterNumber":3,"title":"x"}', '{"title":"x","relationshipHints":{}}']) {
      expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'invalid-subset', decision: 'partial', text })).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    }
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'invalid-full', decision: 'full', text: '{"title":"C1"}' })).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    expect(BlueprintRepository.getAll(f.db)).toEqual(original)
    expect(f.repository.getBase(base.baseId).closedAt).toBeNull()
  })

  it.each([{ characters: ['Name', ' Name '] }, { characters: [''] }, { characters: [null] }])('rejects invalid character-name values %j rather than authorizing identity changes', ({ characters }) => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope(['characters']))
    const request = generated(f, base, JSON.stringify({ characters })).request
    expect(() => f.repository.stageCandidate(request)).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    expect(f.repository.listCandidates(base.baseId)).toEqual([])
    expect(f.db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
  })

  it.each(['chapter-edit', 'delete-reinsert', 'upstream-core', 'upstream-outline', 'upstream-characters'] as const)('rejects source ABA through %s', mutation => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope()), candidate = stage(f, base, '{"title":"C1","purpose":"P1"}')
    const original = BlueprintRepository.getByChapter(2, f.db)!
    if (mutation === 'chapter-edit') {
      BlueprintRepository.upsert({ ...original, notes: 'changed unselected source' }, f.db)
      BlueprintRepository.upsert(original, f.db)
    } else if (mutation === 'delete-reinsert') {
      f.db.prepare('DELETE FROM blueprints WHERE chapter_number=2').run()
      BlueprintRepository.upsert(original, f.db)
    } else {
      const column = mutation === 'upstream-core' ? 'premise' : mutation === 'upstream-outline' ? 'synopsis' : 'characters_arch'
      const value = f.db.prepare(`SELECT ${column} FROM project_core WHERE id='main'`).pluck().get()
      f.db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run('ABA replacement')
      f.db.prepare(`UPDATE project_core SET ${column}=? WHERE id='main'`).run(value)
    }
    expect(f.repository.readSource('blueprintFields', base.scope).sourceHash).toBe(base.sourceHash)
    expect(f.repository.candidateState(candidate.candidateId)).toBe('conflict')
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'stale-blueprint', decision: 'full', text: candidate.text }))
      .toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  })

  it('ignores unrelated chapter edits but same-content adoption consumes every candidate at the target chapter F0', () => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope()), otherBase = f.repository.captureBase(blueprintScope(['notes']))
    const first = stage(f, base, base.value), second = stage(f, base, base.value, first), other = stage(f, otherBase, '{"notes":"other"}')
    BlueprintRepository.upsert({ ...BlueprintRepository.getByChapter(3, f.db)!, title: 'Unrelated chapter edit' }, f.db)
    expect(f.repository.candidateState(first.candidateId)).toBe('ready')
    const receipt = f.repository.adopt({ candidateId: first.candidateId, idempotencyKey: 'same-blueprint', decision: 'full', text: first.text })
    expect(receipt.committedRevision).toBe(base.sourceRevision + 1)
    expect(f.repository.candidateState(second.candidateId)).toBe('conflict')
    expect(f.repository.candidateState(other.candidateId)).toBe('conflict')
    expect(f.repository.readSource('blueprintFields', base.scope).sourceHash).toBe(base.sourceHash)
  })

  it.each(['characters-format', 'nullable-author-fields'] as const)('consumes exactly one revision when a same-content writer normalizes %s', representation => {
    const f = blueprintFixture()
    if (representation === 'characters-format') {
      f.db.prepare('UPDATE blueprints SET characters=? WHERE chapter_number=2').run('[ "Original hero" ]')
    } else {
      f.db.prepare('UPDATE blueprints SET user_guidance=NULL,notes=NULL,notes_updated_at=NULL WHERE chapter_number=2').run()
    }
    const base = f.repository.captureBase(blueprintScope()), first = stage(f, base, base.value), second = stage(f, base, base.value, first)
    const chapterRevision = f.db.prepare('SELECT revision FROM planning_feedback_blueprint_revisions WHERE chapter_number=2').pluck().get() as number
    const outlineRevision = f.repository.readSource('plotOutlineRange').sourceRevision
    const request = { candidateId: first.candidateId, idempotencyKey: `normalize-${representation}`, decision: 'full' as const, text: first.text }
    const receipt = f.repository.adopt(request)
    expect(receipt.committedRevision).toBe(base.sourceRevision + 1)
    expect(f.db.prepare('SELECT revision FROM planning_feedback_blueprint_revisions WHERE chapter_number=2').pluck().get()).toBe(chapterRevision + 1)
    expect(f.repository.readSource('plotOutlineRange').sourceRevision).toBe(outlineRevision)
    expect(f.repository.readSource('blueprintFields', base.scope).sourceHash).toBe(base.sourceHash)
    expect(BlueprintRepository.getByChapter(2, f.db)).toEqual(base.source.blueprint)
    if (representation === 'characters-format') {
      expect(f.db.prepare('SELECT characters FROM blueprints WHERE chapter_number=2').pluck().get()).toBe('["Original hero"]')
    } else {
      expect(f.db.prepare('SELECT user_guidance,notes,notes_updated_at FROM blueprints WHERE chapter_number=2').get())
        .toEqual({ user_guidance: '', notes: '', notes_updated_at: '' })
    }
    expect(f.repository.candidateState(second.candidateId)).toBe('conflict')
    const changes = f.db.prepare('SELECT total_changes()').pluck().get()
    expect(f.repository.adopt(request)).toEqual(receipt)
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  })

  it('rejects multiple revision consumptions during normalized same-content adoption and rolls back the writer', () => {
    const f = blueprintFixture()
    f.db.prepare('UPDATE blueprints SET characters=? WHERE chapter_number=2').run('[ "Original hero" ]')
    const base = f.repository.captureBase(blueprintScope()), candidate = stage(f, base, base.value)
    const original = f.db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all()
    const revisions = f.db.prepare('SELECT * FROM planning_feedback_blueprint_revisions ORDER BY chapter_number').all()
    f.db.exec(`CREATE TRIGGER synthetic_extra_blueprint_revision AFTER UPDATE ON blueprints BEGIN
      UPDATE planning_feedback_blueprint_revisions SET revision=revision+1 WHERE chapter_number=NEW.chapter_number;
    END`)
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'extra-normalization-revision', decision: 'full', text: candidate.text }))
      .toThrow('PLANNING_FEEDBACK_WRITE_FAILED')
    expect(f.db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all()).toEqual(original)
    expect(f.db.prepare('SELECT * FROM planning_feedback_blueprint_revisions ORDER BY chapter_number').all()).toEqual(revisions)
    expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_character_sync_operations').pluck().get()).toBe(0)
    expect(f.repository.getBase(base.baseId).closedAt).toBeNull()
    expect(f.repository.listAdoptions(base.baseId)).toEqual([])
    expect(f.repository.candidateState(candidate.candidateId)).toBe('ready')
  })

  it.each([['writer', false], ['history', false], ['writer', true], ['history', true]] as const)('rolls back blueprint rows, operations, revisions and F0 consumption on %s failure (same content %s)', (failure, sameContent) => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope())
    const candidate = stage(f, base, sameContent ? base.value : '{"title":"C1","purpose":"P1"}')
    const original = BlueprintRepository.getAll(f.db), revisions = f.db.prepare('SELECT * FROM planning_feedback_blueprint_revisions ORDER BY chapter_number').all()
    f.db.exec(failure === 'writer'
      ? "CREATE TRIGGER reject_blueprint_write BEFORE UPDATE ON blueprints BEGIN SELECT RAISE(ABORT,'synthetic writer failure'); END"
      : "CREATE TRIGGER reject_blueprint_history BEFORE INSERT ON planning_feedback_adoptions BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END")
    expect(() => f.repository.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'rollback-blueprint', decision: 'full', text: candidate.text }))
      .toThrow(`synthetic ${failure} failure`)
    expect(BlueprintRepository.getAll(f.db)).toEqual(original)
    expect(f.db.prepare('SELECT * FROM planning_feedback_blueprint_revisions ORDER BY chapter_number').all()).toEqual(revisions)
    expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_character_sync_operations').pluck().get()).toBe(0)
    expect(f.repository.getBase(base.baseId).closedAt).toBeNull()
    expect(f.repository.listAdoptions(base.baseId)).toEqual([])
    expect(f.repository.candidateState(candidate.candidateId)).toBe('ready')
  })

  it('replays the unchanged adoption after a real disk reopen before CAS, while binding candidate, decision and actual subset', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-blueprint-feedback-'))
    directories.push(directory)
    const file = path.join(directory, 'project.sqlite'), f = blueprintFixture(file)
    const base = f.repository.captureBase(blueprintScope()), first = stage(f, base, '{"title":"C1","purpose":"P1"}')
    const second = stage(f, base, '{"title":"C2","purpose":"P2"}', first)
    const request = { candidateId: second.candidateId, idempotencyKey: 'disk-blueprint', decision: 'partial' as const, text: '{"title":"author choice"}' }
    const receipt = f.repository.adopt(request)
    BlueprintRepository.upsert({ ...BlueprintRepository.getByChapter(2, f.db)!, title: 'Later formal edit' }, f.db)
    f.db.close()
    const reopened = new Database(file)
    handles.push(reopened)
    const repository = new PlanningFeedbackRepository(reopened, f.options), writer = vi.spyOn(BlueprintRepository, 'commitRange')
    const changes = reopened.prepare('SELECT total_changes()').pluck().get()
    expect(repository.adopt(request)).toEqual(receipt)
    expect(writer).not.toHaveBeenCalled()
    expect(BlueprintRepository.getByChapter(2, reopened)?.title).toBe('Later formal edit')
    for (const altered of [{ ...request, candidateId: first.candidateId }, { ...request, decision: 'edited' as const },
      { ...request, text: '{"purpose":"author choice"}' }]) {
      expect(() => repository.adopt(altered)).toThrow('PLANNING_FEEDBACK_IDEMPOTENCY_CONFLICT')
    }
    expect(reopened.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  })

  it('lists exact canonical schema3 summaries only and preserves authority/frozen-history boundaries', () => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope(['purpose', 'title']))
    f.repository.captureBase(blueprintScope(['title']))
    f.repository.captureBase({ ...blueprintScope(), chapterNumber: 3 })
    f.repository.captureBase({ kind: 'plot-outline-range', from: 1, to: 2 })
    f.repository.captureBase('premise')
    f.db.prepare('UPDATE planning_feedback_bases SET scope_json=? WHERE base_id=?')
      .run(JSON.stringify({ fields: ['purpose', 'title'], chapterNumber: 2, kind: 'blueprint-fields' }), base.baseId)
    const summary = { baseId: base.baseId, projectId: 'project-A', target: 'blueprintFields', scope: blueprintScope(),
      createdAt: base.createdAt, closedAt: null, closedByAdoptionId: null }
    const changes = f.db.prepare('SELECT total_changes()').pluck().get()
    expect(f.repository.listBlueprintBases(blueprintScope())).toEqual([summary])
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    const copy = new PlanningFeedbackRepository(f.db, { ...f.options, projectId: 'new-copy' })
    expect(copy.listBlueprintBases(blueprintScope())).toEqual([])
    f.frozen.add(`planning_feedback_bases:${base.baseId}`)
    expect(copy.listBlueprintBases(blueprintScope())).toEqual([summary])
    expect(() => copy.assertBaseCurrent(base.baseId)).toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
    f.assertCurrent.mockImplementation(() => { throw new Error('PROJECT_SESSION_STALE') })
    expect(() => f.repository.listBlueprintBases(blueprintScope())).toThrow('PROJECT_SESSION_STALE')
  })

  it('requires explicit exact-scope new lineage before a portable old blueprint candidate can be adopted', () => {
    const f = blueprintFixture(), base = f.repository.captureBase(blueprintScope()), candidate = stage(f, base, '{"title":"Old C1","purpose":"Old purpose"}')
    f.frozen.add(`planning_feedback_bases:${base.baseId}`)
    f.frozen.add(`planning_feedback_candidates:${candidate.candidateId}`)
    const copy = new PlanningFeedbackRepository(f.db, { ...f.options, projectId: 'new-copy' })
    expect(() => copy.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'frozen-blueprint', decision: 'full', text: candidate.text }))
      .toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
    const wrong = copy.captureBase(blueprintScope(['title']))
    expect(() => copy.relineageCandidate({ baseId: wrong.baseId, sourceCandidateId: candidate.candidateId, feedback: 'Copy', constraints: [] }))
      .toThrow('PLANNING_FEEDBACK_PARENT_CONFLICT')
    const freshBase = copy.captureBase(blueprintScope(['purpose', 'title']))
    const fresh = copy.relineageCandidate({ baseId: freshBase.baseId, sourceCandidateId: candidate.candidateId, feedback: 'Explicit new copy', constraints: [] })
    expect(fresh.origin).toMatchObject({ kind: 'copied', sourceCandidateId: candidate.candidateId, originProjectId: candidate.projectId })
    copy.adopt({ candidateId: fresh.candidateId, idempotencyKey: 'fresh-blueprint', decision: 'full', text: fresh.text })
    expect(copy.getCandidate(candidate.candidateId)).toEqual(candidate)
  })
})
