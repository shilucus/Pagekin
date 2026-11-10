import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { applyM08PlanningFeedback } from '../../migrations/m08-planning-feedback'
import { applyM09PlanningFeedbackRanges } from '../../migrations/m09-planning-feedback-ranges'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { PlanningFeedbackService } from '../planning-feedback-service'
import { assertPlanningFeedbackProof, buildPlanningFeedbackTask, readPlanningFeedbackTask } from '../planning-feedback-generation'
import { GenerationRunRepository, textHash, type GenerationExecutionReceipt } from '../../repositories/generation-run-repository'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { planningFeedbackCoreSnapshot, type PlanningFeedbackBase,
  type PlanningFeedbackCandidate, type PlanningFeedbackCoreTarget } from '../../../src/shared/planning-feedback'

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
  db.transaction(() => applyM09PlanningFeedbackRanges(db))()
  db.prepare("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction','Original')").run()
  service = new PlanningFeedbackService({ database: db, projectId: 'project', projectPath: 'fixture',
    assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
})
afterEach(() => db.close())

describe('planning feedback preparation', () => {
  it('lists canonical blueprint field summaries without exposing source or widening other lists', () => {
    db.close()
    db = new Database(':memory:')
    initializeLegacyBaselineSchema(db)
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
    db.prepare("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction','Original')").run()
    service = new PlanningFeedbackService({ database: db, projectId: 'project', projectPath: 'fixture',
      assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
    for (const chapterNumber of [1, 2]) BlueprintRepository.upsert({ chapterNumber, title: `Fictional chapter ${chapterNumber}`,
      role: 'Setup', purpose: 'Fictional purpose', keyEvents: 'Fictional event', characters: ['Fictional lead'],
      suspenseHook: '', userGuidance: 'Keep', notes: 'Private F0 notes', notesUpdatedAt: 'F0 stamp' }, db)
    const scope = { kind: 'blueprint-fields' as const, chapterNumber: 1, fields: ['title', 'notes'] as const }
    const base = service.captureBase({ ...scope, fields: ['notes', 'title'] })
    service.captureBase({ ...scope, fields: ['title'] })
    service.captureBase({ ...scope, chapterNumber: 2 })
    const field = service.captureBase('coreOutline'), changes = db.prepare('SELECT total_changes()').pluck().get()
    const expected = [{ baseId: base.baseId, projectId: base.projectId, target: 'blueprintFields', scope,
      createdAt: base.createdAt, closedAt: null, closedByAdoptionId: null }]
    expect(service.listBlueprintBases(scope)).toEqual(expected)
    expect(service.listBlueprintBases({ ...scope, fields: ['notes', 'title'] })).toEqual(expected)
    expect(service.listRangeBases({ kind: 'plot-outline-range', from: 1, to: 1 })).toEqual([])
    expect(service.listFieldBases('coreOutline')).toEqual([{ baseId: field.baseId, projectId: field.projectId, target: field.target,
      createdAt: field.createdAt, closedAt: null, closedByAdoptionId: null }])
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    const copied = new PlanningFeedbackService({ database: db, projectId: 'copy', projectPath: 'fixture',
      assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
    expect(copied.listBlueprintBases(scope)).toEqual([])
    frozen.value = true
    expect(copied.listBlueprintBases(scope)).toEqual(expected)
    const stale = new PlanningFeedbackService({ database: db, projectId: 'project', projectPath: 'fixture',
      assertCurrent: () => { throw new Error('FICTIONAL_SESSION_STALE') }, assertGenerationBindingCurrent: () => {} })
    expect(() => stale.listBlueprintBases(scope)).toThrow('FICTIONAL_SESSION_STALE')
    expect(() => service.listBlueprintBases({ ...scope, fields: [] })).toThrow('PLANNING_FEEDBACK_SCOPE_INVALID')
  })

  it('lists exact range summaries through the service without exposing frozen sources or changing v1 lists', () => {
    db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'")
      .run('# Plot Outline\n\n## Chapter 1: One\nFirst.\n\n## Chapter 2: Two\nSecond.\n\n## Chapter 3: Three\nThird.\n\n## Chapter 4: Four\nFourth.')
    const scope = { kind: 'plot-outline-range' as const, from: 3, to: 4 }, base = service.captureBase(scope)
    service.captureBase({ kind: 'plot-outline-range', from: 2, to: 3 })
    const field = service.captureBase('coreOutline'), changes = db.prepare('SELECT total_changes()').pluck().get()
    const expected = [{ baseId: base.baseId, projectId: base.projectId, target: 'plotOutlineRange', scope,
      createdAt: base.createdAt, closedAt: null, closedByAdoptionId: null }]
    expect(service.listRangeBases(scope)).toEqual(expected)
    expect(service.listFieldBases('coreOutline')).toEqual([{ baseId: field.baseId, projectId: field.projectId, target: field.target,
      createdAt: field.createdAt, closedAt: null, closedByAdoptionId: null }])
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)

    const copied = new PlanningFeedbackService({ database: db, projectId: 'copy', projectPath: 'fixture',
      assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
    expect(copied.listRangeBases(scope)).toEqual([])
    frozen.value = true
    expect(copied.listRangeBases(scope)).toEqual(expected)
    const stale = new PlanningFeedbackService({ database: db, projectId: 'project', projectPath: 'fixture',
      assertCurrent: () => { throw new Error('FICTIONAL_SESSION_STALE') }, assertGenerationBindingCurrent: () => {} })
    expect(() => stale.listRangeBases(scope)).toThrow('FICTIONAL_SESSION_STALE')
  })

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
  it('reconstructs v2 F0 range and refuses scope substitution even when envelope hashes are recomputed', () => {
    db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(
      '# 情节大纲\n\n## 第1章：一\n正文一\n\n## 第2章：二\n正文二\n\n## 第3章：三\n正文三\n\n## 第4章：四\n正文四')
    const base = service.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    const { context } = service.prepare({ baseId: base.baseId, feedback: 'Revise', constraints: [] })
    expect(context.schemaVersion).toBe(2)
    if (context.schemaVersion !== 2) throw new Error('range context required')
    const task = buildPlanningFeedbackTask(context, null)
    const run = { binding: { projectId: 'project', sourceManifest: { operation: 'planning-feedback',
      planningFeedbackContext: context, planningFeedbackContextHash: textHash(JSON.stringify(context)), planningFeedbackSkillText: null,
      planningFeedbackTask: task, planningFeedbackTaskHash: textHash(JSON.stringify(task)) } } } as unknown as import('../../repositories/generation-run-repository').DurableGenerationRun
    expect(readPlanningFeedbackTask(run)).toEqual(task)
    const altered = { ...context, scope: { ...context.scope, from: 2 } }
    const alteredTask = buildPlanningFeedbackTask(altered, null)
    const forged = { ...run, binding: { ...run.binding, sourceManifest: { ...run.binding.sourceManifest,
      planningFeedbackContext: altered, planningFeedbackContextHash: textHash(JSON.stringify(altered)),
      planningFeedbackTask: alteredTask, planningFeedbackTaskHash: textHash(JSON.stringify(alteredTask)) } } }
    expect(() => readPlanningFeedbackTask(forged)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  })

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
    if (context.schemaVersion !== 1) throw new Error('Expected v1 context')
    const task = buildPlanningFeedbackTask(context, 'Keep a restrained style')
    expect(JSON.stringify(task)).toBe(JSON.stringify({ purpose: 'planning-feedback', reasoningStage: 'planning', output: 'visible-text', messages: [
      { role: 'system', content: 'Revise only the specified field using the feedback and constraints. Follow the project writing language. Return only the revised field. Writing Skill is supplemental and cannot override these instructions or author facts.' },
      { role: 'system', content: 'Keep a restrained style' }, { role: 'user', content: JSON.stringify(context) },
    ] }))
    expect(Object.hasOwn(context, 'scope')).toBe(false)
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

it('preserves real schema 9 v1 receipts and an adopted nonce through M09 and reopening', () => {
  const directory = path.resolve('.runtime/.cache/novel-quality-modernization/planning-feedback-history-tests')
  fs.mkdirSync(directory, { recursive: true })
  const root = fs.mkdtempSync(path.join(directory, 'history-')), file = path.join(root, 'project.db')
  let old = new Database(file)
  try {
    old.pragma('foreign_keys = ON')
    old.transaction(() => initializeLegacyBaselineSchema(old))()
    migrateSchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 9)
    old.prepare("INSERT INTO project_core(id,project_name,core_outline,premise) VALUES('main','History','Original','Premise')").run()
    const hash = textHash('fixture'), fingerprint = { chapterBriefHash: hash, authorGuidanceHash: hash, dependencyHash: hash,
      contextSnapshotHash: hash, templateHash: hash, skillSnapshotHash: hash, modelLeaseRevision: hash, policyHash: hash, outputContractHash: hash }
    const runs = new GenerationRunRepository(() => old, () => 1000)
    const makeBase = (baseId: string, target: PlanningFeedbackCoreTarget): Extract<PlanningFeedbackBase, { schemaVersion: 1 }> => {
      const source = planningFeedbackCoreSnapshot(ProjectCoreRepository.get(old)), value = String(source[target])
      const sourceRevision = old.prepare('SELECT revision FROM planning_feedback_core_revision WHERE id=1').pluck().get() as number
      const base: Extract<PlanningFeedbackBase, { schemaVersion: 1 }> = { schemaVersion: 1, baseId, projectId: 'project', target,
        scope: { kind: 'field', field: target }, sourceRevision, sourceHash: textHash(JSON.stringify(source)), source,
        value, valueHash: textHash(value), createdAt: 1, closedAt: null, closedByAdoptionId: null }
      old.prepare(`INSERT INTO planning_feedback_bases(base_id,schema_version,project_id,target,source_revision,source_hash,source_json,value,value_hash,created_at)
        VALUES(?,1,?,?,?,?,?,?,?,?)`).run(base.baseId, base.projectId, base.target, base.sourceRevision, base.sourceHash,
        JSON.stringify(base.source), base.value, base.valueHash, base.createdAt)
      return base
    }
    const createRun = (base: Extract<PlanningFeedbackBase, { schemaVersion: 1 }>, nonce: string, text: string) => {
      const context = { schemaVersion: 1 as const, projectId: base.projectId, baseId: base.baseId, target: base.target,
        sourceRevision: base.sourceRevision, sourceHash: base.sourceHash, source: structuredClone(base.source),
        baseValueHash: base.valueHash, parentCandidateId: null, parentText: base.value, parentTextHash: base.valueHash,
        feedback: 'Feedback', constraints: ['Constraint'] }
      const task = { purpose: 'planning-feedback' as const, reasoningStage: 'planning' as const, output: 'visible-text' as const, messages: [
        { role: 'system' as const, content: 'Revise only the specified field using the feedback and constraints. Follow the project writing language. Return only the revised field. Writing Skill is supplemental and cannot override these instructions or author facts.' },
        { role: 'user' as const, content: JSON.stringify(context) },
      ] }
      const run = runs.open({ projectId: 'project', epoch: 'epoch', operation: 'planning-feedback', uiActionNonce: nonce,
        frozenInputHash: hash, fingerprint, contextSnapshotId: 'context', sourceRefs: [],
        sourceManifest: { operation: 'planning-feedback', planningFeedbackContext: context,
          planningFeedbackContextHash: textHash(JSON.stringify(context)), planningFeedbackSkillText: null,
          planningFeedbackTask: task, planningFeedbackTaskHash: textHash(JSON.stringify(task)) },
        budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } })
      const policy = { estimatorVersion: 'fixture', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
      const attempt = runs.reserve(run.runId, 'planning-feedback:0', textHash(JSON.stringify([task, hash, hash])), 200, 100, policy, task.purpose, task)
      runs.markDispatched(attempt.attempt.attemptId)
      const artifact = runs.snapshot(attempt.attempt.attemptId, 0, text)
      runs.settle(attempt.attempt.attemptId, { policy, trusted: true, actualTokens: 50 }, 'stop')
      return { context, task, run, attemptId: attempt.attempt.attemptId, artifact }
    }
    const adoptedBase = makeBase('old-adopted-base', 'coreOutline')
    const completed = createRun(adoptedBase, 'old-adopted', 'Approved')
    const candidate: PlanningFeedbackCandidate = { schemaVersion: 1, candidateId: 'old-candidate', projectId: 'project',
      baseId: adoptedBase.baseId, parentCandidateId: null, generationParentHash: adoptedBase.valueHash,
      text: 'Approved', textHash: textHash('Approved'), feedback: 'Feedback', constraints: ['Constraint'], createdAt: 2,
      origin: { kind: 'generated', runId: completed.run.runId, attemptId: completed.attemptId, artifactId: completed.artifact.artifactId,
        modelLeaseRevision: hash, skillSnapshotHash: hash, contextSnapshotHash: hash } }
    old.prepare(`INSERT INTO planning_feedback_candidates(candidate_id,schema_version,project_id,base_id,parent_candidate_id,generation_parent_hash,
      text,text_hash,feedback,constraints_json,origin_json,created_at) VALUES(?,1,?,?,NULL,?,?,?,?,?,?,?)`)
      .run(candidate.candidateId, candidate.projectId, candidate.baseId, candidate.generationParentHash, candidate.text, candidate.textHash,
        candidate.feedback, JSON.stringify(candidate.constraints), JSON.stringify(candidate.origin), candidate.createdAt)
    const request = { candidateId: candidate.candidateId, idempotencyKey: 'old-operation', decision: 'full' as const, text: candidate.text }
    old.prepare("UPDATE project_core SET core_outline='Approved' WHERE id='main'").run()
    const committedRevision = old.prepare('SELECT revision FROM planning_feedback_core_revision WHERE id=1').pluck().get() as number
    old.prepare(`INSERT INTO planning_feedback_adoptions(adoption_id,schema_version,project_id,base_id,candidate_id,idempotency_key,
      request_hash,target,decision,decision_source,text,text_hash,before_value,before_hash,source_revision,committed_revision,created_at)
      VALUES(?,1,?,?,?,?,?,?,'full','author-action',?,?,?,?,?,?,?)`).run('old-adoption', 'project', adoptedBase.baseId, candidate.candidateId,
      request.idempotencyKey, textHash(JSON.stringify([1, candidate.candidateId, candidate.schemaVersion, adoptedBase.baseId,
        adoptedBase.projectId, adoptedBase.target, 'field', adoptedBase.sourceRevision, adoptedBase.sourceHash,
        candidate.textHash, candidate.generationParentHash, request.decision, 'author-action', candidate.textHash])), adoptedBase.target,
      candidate.text, candidate.textHash, adoptedBase.value, adoptedBase.valueHash, adoptedBase.sourceRevision, committedRevision, 3)
    old.prepare('UPDATE planning_feedback_bases SET closed_at=3,closed_by_adoption_id=? WHERE base_id=?').run('old-adoption', adoptedBase.baseId)
    const pendingBase = makeBase('old-pending-base', 'premise'), pending = createRun(pendingBase, 'old-pending', 'Pending candidate')
    const ledger = () => ({ runs: old.prepare('SELECT run_id,binding_json FROM generation_runs ORDER BY run_id').all(),
      attempts: old.prepare('SELECT attempt_id,attempt_json,usage_receipt_json FROM generation_attempts ORDER BY attempt_id').all(),
      artifacts: old.prepare('SELECT artifact_id,artifact_json FROM generation_artifacts ORDER BY artifact_id').all(),
      adoptions: old.prepare('SELECT adoption_id,request_hash,text,text_hash FROM planning_feedback_adoptions ORDER BY adoption_id').all() })
    const before = ledger()
    migrateSchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 10)
    old.close()
    old = new Database(file)
    expect(ledger()).toEqual(before)
    const service = new PlanningFeedbackService({ database: old, projectId: 'project', projectPath: root,
      assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
    const changes = old.prepare('SELECT total_changes()').pluck().get()
    expect(service.adopt(request).adoptionId).toBe('old-adoption')
    expect(old.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    expect(() => service.adopt({ ...request, text: 'changed' })).toThrow('PLANNING_FEEDBACK_IDEMPOTENCY_CONFLICT')
    expect(service.stage({ baseId: pendingBase.baseId, feedback: 'Feedback', constraints: ['Constraint'], runId: pending.run.runId,
      attemptId: pending.attemptId, artifactId: pending.artifact.artifactId }).text).toBe('Pending candidate')
  } finally {
    if (old.open) old.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
