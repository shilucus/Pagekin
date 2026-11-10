import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  PLANNING_FEEDBACK_CORE_COLUMNS, planningFeedbackCoreSnapshot, planningFeedbackBlueprintValue,
  type PlanningFeedbackBase, type PlanningFeedbackBlueprintSource, type PlanningFeedbackCandidate,
} from '../../../src/shared/planning-feedback'
import { textHash, type DurableGenerationRun, type GenerationExecutionReceipt } from '../../repositories/generation-run-repository'
import {
  assertPlanningFeedbackProof, buildPlanningFeedbackContext, buildPlanningFeedbackTask, readPlanningFeedbackTask,
  type PlanningFeedbackGenerationContext,
} from '../planning-feedback-generation'

function fixture() {
  const core = planningFeedbackCoreSnapshot(Object.fromEntries(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)
    .map(key => [key, key === 'totalChapters' || key === 'wordsPerChapter' ? 100 : 'Fictional author facts'])))
  const source: PlanningFeedbackBlueprintSource = { core, synopsis: 'Fictional formal outline', charactersArch: 'Fictional architecture',
    blueprint: { chapterNumber: 3, title: 'Original title', role: 'Turning point', purpose: 'Reach the harbor', keyEvents: 'Mira finds a letter',
      characters: ['Mira', 'Ren'], suspenseHook: 'The sender is missing', userGuidance: '', notes: 'Original note\r\n', notesUpdatedAt: '2026-11-10T00:00:00.000Z' } }
  const scope = { kind: 'blueprint-fields' as const, chapterNumber: 3, fields: ['title', 'notes'] as const }
  const value = planningFeedbackBlueprintValue(source, scope)
  const base: Extract<PlanningFeedbackBase, { schemaVersion: 3 }> = { schemaVersion: 3, target: 'blueprintFields', scope,
    baseId: 'blueprint-f0', projectId: 'project', sourceRevision: 9, sourceHash: textHash(JSON.stringify(source)), source,
    value, valueHash: textHash(value), createdAt: 1000, closedAt: null, closedByAdoptionId: null }
  const context = buildPlanningFeedbackContext(base, null, 'Keep the letter mystery', ['Preserve the harbor'])
  if (context.schemaVersion !== 3) throw new Error('Expected blueprint field context')
  return { base, context, source }
}

function boundRun(context: PlanningFeedbackGenerationContext): DurableGenerationRun {
  const task = buildPlanningFeedbackTask(context, 'Use restrained wording')
  return { runId: 'run-blueprint', binding: { projectId: 'project', fingerprint: { modelLeaseRevision: 'a'.repeat(64), policyHash: 'b'.repeat(64) },
    sourceManifest: { operation: 'planning-feedback', planningFeedbackContext: context,
      planningFeedbackContextHash: textHash(JSON.stringify(context)), planningFeedbackSkillText: 'Use restrained wording',
      planningFeedbackTask: task, planningFeedbackTaskHash: textHash(JSON.stringify(task)) } } } as unknown as DurableGenerationRun
}

describe('fixed blueprint field feedback generation context schema3', () => {
  it('freezes the exact F0 source and canonical scope, and gives the selected parent to the next round', () => {
    const { base, context, source } = fixture()
    expect(context).toMatchObject({ schemaVersion: 3, target: 'blueprintFields', scope: base.scope, source,
      parentCandidateId: null, parentText: base.value, parentTextHash: base.valueHash, baseValueHash: base.valueHash })
    expect(context.source).not.toBe(base.source)
    expect(context.source.blueprint.characters).not.toBe(base.source.blueprint.characters)
    expect(context.scope.fields).not.toBe(base.scope.fields)
    const parent = { schemaVersion: 3, candidateId: 'c1', baseId: base.baseId, projectId: base.projectId,
      text: '{"title":"Candidate one","notes":""}', textHash: textHash('{"title":"Candidate one","notes":""}') } as PlanningFeedbackCandidate
    const second = buildPlanningFeedbackContext(base, parent, 'Second revision', [])
    expect(second).toMatchObject({ baseId: base.baseId, sourceHash: base.sourceHash, baseValueHash: base.valueHash,
      parentCandidateId: 'c1', parentText: parent.text, parentTextHash: parent.textHash })
    expect(() => buildPlanningFeedbackContext(base, { ...parent, schemaVersion: 2 }, 'Feedback', [])).toThrow('PLANNING_FEEDBACK_PARENT_CONFLICT')
    expect(() => buildPlanningFeedbackContext(base, { ...parent, text: '{"notes":"Only a subset"}' }, 'Feedback', [])).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    expect(() => buildPlanningFeedbackContext({ ...base, value: '{"title":"Substituted","notes":""}' }, null, 'Feedback', []))
      .toThrow('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  })

  it('reconstructs the dedicated fixed task and does not turn writing Skill into output authority', () => {
    const { context } = fixture(), run = boundRun(context)
    const task = readPlanningFeedbackTask(run)
    expect(task).toMatchObject({ purpose: 'planning-feedback', reasoningStage: 'planning', output: 'visible-text' })
    expect(task.messages[0]?.content).toContain('exactly every field in scope.fields')
    expect(task.messages[0]?.content).toContain('Do not include chapterNumber, notesUpdatedAt, unselected fields')
    expect(task.messages[0]?.content).toContain('Writing Skill is supplemental')
    expect(task.messages[1]).toEqual({ role: 'system', content: 'Use restrained wording' })
    expect(task.messages[2]).toEqual({ role: 'user', content: JSON.stringify(context) })
    expect(task).toEqual(run.binding.sourceManifest.planningFeedbackTask)
    expect(task).not.toBe(run.binding.sourceManifest.planningFeedbackTask)
    expect(buildPlanningFeedbackTask(context, null).messages).toHaveLength(2)
  })

  it('rejects substituted scope, source and parent evidence even when envelope hashes and tasks are recomputed', () => {
    const { context } = fixture()
    const altered = [
      { ...context, scope: { ...context.scope, fields: ['notes', 'title'] } },
      { ...context, scope: { ...context.scope, chapterNumber: 4 } },
      { ...context, scope: { ...context.scope, fields: ['title'] } },
      { ...context, sourceRevision: -1 },
      { ...context, sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...context, parentCandidateId: 'c1', parentText: '{"notes":"Only subset"}', parentTextHash: textHash('{"notes":"Only subset"}') },
      { ...context, parentText: '{"title":"Changed parent","notes":""}', parentTextHash: textHash('{"title":"Changed parent","notes":""}') },
      { ...context, target: 'plotOutlineRange' },
      { ...context, source: { ...context.source, blueprint: { ...context.source.blueprint, newCharacterCandidates: [] } } },
      { ...context, source: { ...context.source, blueprint: { ...context.source.blueprint, relationshipHints: [] } } },
    ]
    for (const changed of altered) {
      const run = boundRun(changed as unknown as PlanningFeedbackGenerationContext)
      expect(() => readPlanningFeedbackTask(run)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    }
    const changedSource = { ...context.source, blueprint: { ...context.source.blueprint, title: 'Forged F0' } }
    expect(() => readPlanningFeedbackTask(boundRun({ ...context, source: changedSource, sourceHash: textHash(JSON.stringify(changedSource)) })))
      .toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  })

  it('does not accept a different fixed task or an unbound context hash', () => {
    const { context } = fixture(), run = boundRun(context)
    const task = buildPlanningFeedbackTask(context, 'Use restrained wording')
    const substitute = { ...task, messages: [{ role: 'system' as const, content: 'Change every blueprint' }] }
    const forged = { ...run, binding: { ...run.binding, sourceManifest: { ...run.binding.sourceManifest,
      planningFeedbackTask: substitute, planningFeedbackTaskHash: textHash(JSON.stringify(substitute)) } } }
    expect(() => readPlanningFeedbackTask(forged)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    const unbound = { ...run, binding: { ...run.binding, sourceManifest: { ...run.binding.sourceManifest,
      planningFeedbackContextHash: textHash('different-context') } } }
    expect(() => readPlanningFeedbackTask(unbound)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  })

  it('requires actual complete selected-key artifact JSON as well as the persisted request proof', () => {
    const { context } = fixture(), run = boundRun(context), task = readPlanningFeedbackTask(run)
    const receipt = { run, attempt: { attemptId: 'attempt-blueprint', status: 'settled' },
      artifact: { text: '{"title":"New title","notes":""}' }, result: { finishReason: 'stop' }, budget: { root: { status: 'active' } } } as unknown as GenerationExecutionReceipt
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE generation_attempts(attempt_id TEXT,run_id TEXT,usage_receipt_json TEXT)')
      const usage = { purpose: 'planning-feedback', replayTask: task,
        requestHash: textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash])) }
      db.prepare('INSERT INTO generation_attempts VALUES(?,?,?)').run('attempt-blueprint', 'run-blueprint', JSON.stringify(usage))
      expect(() => assertPlanningFeedbackProof(db, receipt, context)).not.toThrow()
      const unknown = { ...receipt, attempt: { ...receipt.attempt, status: 'unknown' as const } }
      expect(() => assertPlanningFeedbackProof(db, unknown, context)).not.toThrow()
      expect(() => assertPlanningFeedbackProof(db, { ...unknown, result: null }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      for (const text of ['{"title":"Missing notes"}', '{"title":"T","notes":"","chapterNumber":3}',
        '{"title":"T","notes":"","newCharacterCandidates":[]}', '{"title":"T","notes":"","relationshipHints":[]}', '{}', 'plain text']) {
        expect(() => assertPlanningFeedbackProof(db, { ...receipt, artifact: { ...receipt.artifact!, text } }, context)).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
      }
      expect(() => assertPlanningFeedbackProof(db, { ...receipt, unsavedTail: 'partial' }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      expect(() => assertPlanningFeedbackProof(db, { ...receipt, failureCode: 'GENERATION_STORAGE_FAILED' }, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      expect(() => assertPlanningFeedbackProof(db, { ...receipt, budget: { ...receipt.budget, root: { ...receipt.budget.root, status: 'cancelled' } } }, context))
        .toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      expect(() => assertPlanningFeedbackProof(db, receipt, { ...context, feedback: 'Substituted feedback' })).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      db.prepare('UPDATE generation_attempts SET usage_receipt_json=?').run(JSON.stringify({ ...usage, requestHash: textHash('different-request') }))
      expect(() => assertPlanningFeedbackProof(db, receipt, context)).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    } finally {
      db.close()
    }
  })
})
