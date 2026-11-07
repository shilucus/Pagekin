import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { applyM08PlanningFeedback } from '../../migrations/m08-planning-feedback'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { PlanningFeedbackService } from '../planning-feedback-service'
import { assertPlanningFeedbackProof, buildPlanningFeedbackTask, readPlanningFeedbackTask } from '../planning-feedback-generation'
import { GenerationRunRepository, textHash, type GenerationExecutionReceipt } from '../../repositories/generation-run-repository'

const frozen = vi.hoisted(() => ({ value: false }))
vi.mock('../portable-runtime-freeze', () => ({
  readPortableRuntimeFreeze: () => ({ isFrozen: () => frozen.value }),
}))
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
let db: import('better-sqlite3').Database
let service: PlanningFeedbackService

beforeEach(() => {
  frozen.value = false
  db = new Database(':memory:')
  initializeLegacyBaselineSchema(db)
  db.transaction(() => applyM08PlanningFeedback(db))()
  db.prepare("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction','Original')").run()
  service = new PlanningFeedbackService({ database: db, projectId: 'project', projectPath: 'fixture',
    assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
})
afterEach(() => db.close())

describe('planning feedback preparation', () => {
  it('captures the real core projection and tolerates unrelated cached state', () => {
    const base = service.captureBase('coreOutline')
    db.prepare("UPDATE project_core SET character_states='cached',plot_tree_snapshot='cached' WHERE id='main'").run()
    const prepared = service.prepare({ baseId: base.baseId, feedback: 'Focus', constraints: ['Brief'] })
    expect(prepared.context.sourceHash).toBe(base.sourceHash)
    expect(prepared.context.parentText).toBe('Original')
    expect(buildPlanningFeedbackTask(prepared.context, null).reasoningStage).toBe('planning')
    expect(service.prepare({ baseId: base.baseId, feedback: 'Focus', constraints: ['Brief'] })).toEqual(prepared)
  })

  it('rejects source changes including ABA and frozen history', () => {
    const base = service.captureBase('coreOutline')
    db.prepare("UPDATE project_core SET core_outline='Changed' WHERE id='main'").run()
    db.prepare("UPDATE project_core SET core_outline='Original' WHERE id='main'").run()
    expect(() => service.prepare({ baseId: base.baseId, feedback: '', constraints: [] })).toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
    const current = service.captureBase('coreOutline')
    frozen.value = true
    expect(() => service.prepare({ baseId: current.baseId, feedback: '', constraints: [] })).toThrow('PLANNING_FEEDBACK_HISTORY_FROZEN')
  })

  it('rejects unexpected request properties', () => {
    const base = service.captureBase('premise')
    expect(() => service.prepare({ baseId: base.baseId, feedback: '', constraints: [], generated: 'untrusted' } as never))
      .toThrow('PLANNING_FEEDBACK_PAYLOAD_INVALID')
  })

  it('requires explicit relineage instead of silently substituting a parent across bases', () => {
    const old = service.captureBase('coreOutline'), current = service.captureBase('coreOutline')
    const value = 'Old candidate', digest = textHash(value), h = 'a'.repeat(64)
    db.prepare(`INSERT INTO planning_feedback_candidates
      (candidate_id,schema_version,project_id,base_id,parent_candidate_id,generation_parent_hash,text,text_hash,feedback,constraints_json,origin_json,created_at)
      VALUES(?,1,?,?,NULL,?,?,?,?,?,?,?)`).run('old-candidate', 'project', old.baseId, old.valueHash, value, digest, '', '[]',
      JSON.stringify({ kind: 'generated', runId: 'run', attemptId: 'attempt', artifactId: 'artifact',
        modelLeaseRevision: h, skillSnapshotHash: h, contextSnapshotHash: h }), 1)
    expect(() => service.prepare({ baseId: current.baseId, parentCandidateId: 'old-candidate', feedback: '', constraints: [] }))
      .toThrow('PLANNING_FEEDBACK_PARENT_CONFLICT')
    const copy = service.relineage({ baseId: current.baseId, sourceCandidateId: 'old-candidate', feedback: '', constraints: [] })
    expect(copy.parentCandidateId).toBeNull()
    expect(copy.origin).toMatchObject({ kind: 'copied', sourceCandidateId: 'old-candidate' })
    expect(db.prepare("SELECT core_outline FROM project_core WHERE id='main'").pluck().get()).toBe('Original')
  })

  it('replays a lost adoption reply after service reconstruction without writing other fields', () => {
    const base = service.captureBase('coreOutline'), value = 'Approved candidate', h = 'a'.repeat(64)
    db.prepare(`INSERT INTO planning_feedback_candidates
      (candidate_id,schema_version,project_id,base_id,parent_candidate_id,generation_parent_hash,text,text_hash,feedback,constraints_json,origin_json,created_at)
      VALUES(?,1,?,?,NULL,?,?,?,?,?,?,?)`).run('candidate', 'project', base.baseId, base.valueHash, value, textHash(value), '', '[]',
      JSON.stringify({ kind: 'generated', runId: 'run', attemptId: 'attempt', artifactId: 'artifact',
        modelLeaseRevision: h, skillSnapshotHash: h, contextSnapshotHash: h }), 1)
    const request = { candidateId: 'candidate', idempotencyKey: 'operation', decision: 'full' as const, text: value }
    const accepted = service.adopt(request)
    service = new PlanningFeedbackService({ database: db, projectId: 'project', projectPath: 'fixture',
      assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
    expect(service.adopt(request)).toEqual(accepted)
    expect(() => service.adopt({ ...request, text: 'different' })).toThrow('PLANNING_FEEDBACK_IDEMPOTENCY_CONFLICT')
    expect(db.prepare("SELECT core_outline,world_setting FROM project_core WHERE id='main'").get())
      .toEqual({ core_outline: value, world_setting: '' })
    expect(service.listAdoptions(base.baseId)).toHaveLength(1)
  })
})

describe('persisted execution proof', () => {
  it('stages only the actual verified repository artifact with its exact frozen instructions', () => {
    db.exec(M01_GENERATION_SQL)
    const base = service.captureBase('coreOutline')
    const { context } = service.prepare({ baseId: base.baseId, feedback: 'Focus', constraints: ['Brief'] })
    const task = buildPlanningFeedbackTask(context, null), h = textHash('fixture')
    const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
      templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
    const runs = new GenerationRunRepository(() => db, () => 1000)
    const run = runs.open({ projectId: 'project', epoch: 'epoch', operation: 'planning-feedback', uiActionNonce: 'action',
      frozenInputHash: h, fingerprint, contextSnapshotId: 'context', sourceRefs: [],
      sourceManifest: { operation: 'planning-feedback', planningFeedbackContext: context,
        planningFeedbackContextHash: textHash(JSON.stringify(context)), planningFeedbackSkillText: null,
        planningFeedbackTask: task, planningFeedbackTaskHash: textHash(JSON.stringify(task)) },
      budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } })
    const policy = { estimatorVersion: 'fixture', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
    const reserved = runs.reserve(run.runId, 'invocation', textHash(JSON.stringify([task, h, h])), 200, 100, policy, task.purpose, task)
    runs.markDispatched(reserved.attempt.attemptId)
    const artifact = runs.snapshot(reserved.attempt.attemptId, 0, 'Generated candidate')
    runs.settle(reserved.attempt.attemptId, { policy, trusted: true, actualTokens: 100 }, 'stop')
    const request = { baseId: base.baseId, feedback: 'Focus', constraints: ['Brief'], runId: run.runId,
      attemptId: reserved.attempt.attemptId, artifactId: artifact.artifactId }
    expect(() => service.stage({ ...request, feedback: 'Substituted' })).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    const candidate = service.stage(request)
    expect(candidate.text).toBe('Generated candidate')
    expect(db.prepare("SELECT core_outline FROM project_core WHERE id='main'").pluck().get()).toBe('Original')
  })

  it('binds context, replay task and hash and rejects incomplete or substituted executions', () => {
    const base = service.captureBase('coreOutline')
    const { context } = service.prepare({ baseId: base.baseId, feedback: 'Focus', constraints: [] })
    const task = buildPlanningFeedbackTask(context, 'Keep a restrained style')
    const modelLeaseRevision = 'a'.repeat(64), policyHash = 'b'.repeat(64)
    const receipt = { run: { runId: 'run', binding: { projectId: 'project',
      fingerprint: { modelLeaseRevision, policyHash }, sourceManifest: { operation: 'planning-feedback',
        planningFeedbackContext: context, planningFeedbackContextHash: textHash(JSON.stringify(context)),
        planningFeedbackSkillText: 'Keep a restrained style', planningFeedbackTask: task,
        planningFeedbackTaskHash: textHash(JSON.stringify(task)) } } },
    attempt: { attemptId: 'attempt', status: 'settled' }, artifact: { text: 'Candidate' },
    result: { finishReason: 'stop' }, budget: { root: { status: 'active' } } } as unknown as GenerationExecutionReceipt
    db.exec('CREATE TABLE generation_attempts(attempt_id TEXT,run_id TEXT,usage_receipt_json TEXT)')
    const usage = { purpose: 'planning-feedback', replayTask: task,
      requestHash: textHash(JSON.stringify([task, modelLeaseRevision, policyHash])) }
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?)').run('attempt', 'run', JSON.stringify(usage))
    const recovered = readPlanningFeedbackTask(receipt.run)
    expect(recovered).toEqual(task)
    expect(recovered).not.toBe(task)
    expect(() => assertPlanningFeedbackProof(db, receipt, context)).not.toThrow()
    const unknown = { ...receipt, attempt: { ...receipt.attempt, status: 'unknown' as const } }
    expect(() => assertPlanningFeedbackProof(db, unknown, context)).not.toThrow()
    expect(() => assertPlanningFeedbackProof(db, { ...unknown, result: null }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...unknown, result: { finishReason: 'length', usage: null } }, context))
      .toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...unknown, unsavedTail: 'partial' }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...unknown, failureCode: 'GENERATION_PROVIDER_FAILED' }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...unknown, failureCode: 'GENERATION_STORAGE_FAILED' }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...unknown, budget: { ...unknown.budget,
      root: { ...unknown.budget.root, status: 'cancelled' } } }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...unknown, attempt: { ...unknown.attempt, status: 'dispatch-marked' } }, context))
      .toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    const changed = (values: Record<string, unknown>) => ({ ...receipt.run, binding: { ...receipt.run.binding,
      sourceManifest: { ...receipt.run.binding.sourceManifest, ...values } } })
    expect(() => readPlanningFeedbackTask(changed({ planningFeedbackContextHash: 'invalid' }))).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => readPlanningFeedbackTask(changed({ planningFeedbackTaskHash: 'invalid' }))).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => readPlanningFeedbackTask(changed({ planningFeedbackSkillText: undefined }))).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    const badContext = { ...context, parentText: 'substituted' }
    const badTask = buildPlanningFeedbackTask(badContext, 'Keep a restrained style')
    expect(() => readPlanningFeedbackTask(changed({ planningFeedbackContext: badContext,
      planningFeedbackContextHash: textHash(JSON.stringify(badContext)), planningFeedbackTask: badTask,
      planningFeedbackTaskHash: textHash(JSON.stringify(badTask)) }))).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    const badSource = { ...context, source: { ...context.source, coreOutline: 'substituted' } }
    const badSourceTask = buildPlanningFeedbackTask(badSource, 'Keep a restrained style')
    expect(() => readPlanningFeedbackTask(changed({ planningFeedbackContext: badSource,
      planningFeedbackContextHash: textHash(JSON.stringify(badSource)), planningFeedbackTask: badSourceTask,
      planningFeedbackTaskHash: textHash(JSON.stringify(badSourceTask)) }))).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, receipt, { ...context, feedback: 'Other' })).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, receipt, { ...context, parentCandidateId: 'other' })).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...receipt, result: { finishReason: 'length', usage: null } }, context))
      .toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(() => assertPlanningFeedbackProof(db, { ...receipt, unsavedTail: 'partial' }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    db.prepare('UPDATE generation_attempts SET usage_receipt_json=?').run(JSON.stringify({ ...usage, requestHash: 'invalid' }))
    expect(() => assertPlanningFeedbackProof(db, receipt, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    db.prepare('UPDATE generation_attempts SET usage_receipt_json=?').run(JSON.stringify({ ...usage, replayTask: { ...task, messages: [] } }))
    expect(() => assertPlanningFeedbackProof(db, receipt, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  })
})
