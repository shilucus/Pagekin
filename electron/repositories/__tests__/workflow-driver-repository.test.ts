import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorkflowDriverRecipe, parseWorkflowDriverStepInput, type WorkflowDriverStepInput } from '../../../src/shared/workflow-driver-contract'
import { draftShortOutlineBlock } from '../../../src/shared/draft-short-outline'
import { DRAFT_VISIBLE_TEXT_VERSION, sanitizeDraftText } from '../../../src/shared/draft-visible-text'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { verifyM12WorkflowDriver } from '../../migrations/m12-workflow-driver'
import { GenerationDraftEffects } from '../../services/generation-draft-effects'
import { GenerationRunRepository, textHash } from '../generation-run-repository'
import { WorkflowDriverRepository, type WorkflowDriverTask, type WorkflowDriverTaskRef, type WorkflowDriverStep,
  type WorkflowDriverTable } from '../workflow-driver-repository'

const databases: Database.Database[] = []
const h = textHash('fictional-frozen-model-and-source')
const outlineText = 'Open the door, preserve the author facts, and finish the promised action.'
const draftText = 'The author entered the quiet room and opened the letter. Every recorded promise remained unchanged. A visitor arrived with clear evidence and they completed the planned exchange before leaving the room together.'
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close() })

function fixture(projectId = 'project-A', writingLanguage: 'zh-CN' | 'en-US' = 'en-US') {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('foreign_keys=ON')
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.prepare("INSERT INTO project_core(id,project_name,premise,writing_language) VALUES('main','Fictional driver book','Original author fact',?)").run(writingLanguage)
  const frozen = new Set<string>(), assertCurrent = vi.fn(() => {}), now = { value: 1000 }
  const options = { projectId, assertCurrent, now: () => now.value,
    isFrozen: (table: WorkflowDriverTable, recordId: string) => frozen.has(`${table}:${recordId}`) }
  const repository = new WorkflowDriverRepository(db, options), runs = new GenerationRunRepository(() => db, () => now.value)
  const recipe = parseWorkflowDriverRecipe({ schemaVersion: 1, writingLanguage,
    outlineTask: { purpose: 'chapter-draft-short-outline', output: 'visible-text', reasoningStage: 'planning',
      messages: [{ role: 'user', content: 'Prepare the frozen chapter outline.' }] },
    baseDraftTask: { purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'drafting',
      budgetDemand: { kind: 'draft-units', writingLanguage, requestedUnits: 20, segmentable: false },
      messages: [{ role: 'user', content: 'Write the first chapter from the frozen author facts.' }] } })
  const fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h,
    templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h }
  const open = (patch: { projectId?: string; chapterNumber?: number; operation?: string } = {}) => runs.open({
    projectId: patch.projectId ?? projectId, epoch: 'fictional-runtime-epoch', operation: patch.operation ?? 'chapter-draft',
    uiActionNonce: randomUUID(), frozenInputHash: h, fingerprint, contextSnapshotId: 'fictional-frozen-context', sourceRefs: [],
    sourceManifest: { operation: patch.operation ?? 'chapter-draft', chapterNumber: patch.chapterNumber ?? 1, outputContract: 'visible-text',
      freezeWritingLanguage: true, writingLanguage,
      materialDecision: { version: 1, verdict: 'admitted', promptHash: textHash(recipe.baseDraftTask.messages[0]!.content),
        shortOutlinePromptHash: textHash(recipe.outlineTask.messages[0]!.content),
        capacity: { maxInputUnits: 1000, admittedUnits: 100, methodVersion: 'utf8-bytes-v1' },
        coverage: { required: 0, included: 0, complete: true }, included: [], omitted: [] },
      authorInputs: [{ id: 'draft:target-units', text: '20' }] },
    budget: { maxPhysicalRequests: 4, maxTokenLiability: 1000, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } })
  const run = open(), request = { taskId: randomUUID(), operationKey: randomUUID(), requestHash: textHash('private-canonical-start-request'), runId: run.runId, recipe }
  return { db, projectId, frozen, assertCurrent, now, options, repository, runs, recipe, run, request, open }
}
type Fixture = ReturnType<typeof fixture>
const ref = (task: WorkflowDriverTask): WorkflowDriverTaskRef => ({ taskId: task.taskId, revision: task.revision, runId: task.runId })
const count = (db: Database.Database, table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number
const step = (f: Fixture, task: WorkflowDriverTask, ordinal: number) => f.repository.readSteps(task.taskId)[ordinal]!

function finish(f: Fixture, task: WorkflowDriverTask, modelStep: WorkflowDriverStep, text: string, options: {
  finishReason?: string | null; trusted?: boolean; reserveOnly?: boolean; failureCode?: string
} = {}) {
  if (modelStep.input?.kind !== 'model' || modelStep.invocationNonce === null) throw new Error('fixture model input missing')
  const input = modelStep.input.task, requestHash = textHash(JSON.stringify([input, h, h]))
  const policy = { estimatorVersion: 'fictional-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true }
  const receipt = f.runs.reserve(task.runId, modelStep.invocationNonce, requestHash, 200, 100, policy, input.purpose, input)
  if (options.reserveOnly) return receipt
  f.runs.markDispatched(receipt.attempt.attemptId)
  f.runs.snapshot(receipt.attempt.attemptId, 0, text)
  return f.runs.settle(receipt.attempt.attemptId,
    options.trusted === false ? null : { policy, trusted: true, actualTokens: 20 },
    options.finishReason === undefined ? 'stop' : options.finishReason, options.failureCode)
}

function outline(f: Fixture, task: WorkflowDriverTask, acknowledge = true) {
  const bound = f.repository.bindInput(ref(task), step(f, task, 0).stepId, { kind: 'model', task: f.recipe.outlineTask })
  const receipt = finish(f, task, bound, outlineText)
  if (acknowledge) f.repository.acknowledgeFromReceipt(ref(task), bound.stepId)
  return { step: bound, receipt }
}
function draft(f: Fixture, task: WorkflowDriverTask, acknowledge = true) {
  const base = f.recipe.baseDraftTask
  const input = parseWorkflowDriverStepInput({ kind: 'model', task: { ...base, messages: base.messages.map(message => ({ ...message,
    content: `${message.content}\n\n${draftShortOutlineBlock(f.recipe.writingLanguage, outlineText)}` })) } })
  const bound = f.repository.bindInput(ref(task), step(f, task, 1).stepId, input)
  const receipt = finish(f, task, bound, draftText)
  if (acknowledge) f.repository.acknowledgeFromReceipt(ref(task), bound.stepId)
  return { step: bound, receipt }
}
function composition(f: Fixture, task: WorkflowDriverTask) {
  const artifact = f.repository.readEffects(task.taskId).find(effect => effect.stepId === step(f, task, 1).stepId)
  if (!artifact) throw new Error('fixture draft ACK missing')
  const draftArtifact = f.runs.receipt(artifact.receiptAttemptId).artifact
  if (!draftArtifact) throw new Error('fixture draft artifact missing')
  const input = parseWorkflowDriverStepInput({ kind: 'compose', artifactIds: [draftArtifact.artifactId],
    algorithm: DRAFT_VISIBLE_TEXT_VERSION, expectedTextHash: textHash(sanitizeDraftText(draftText)) })
  const bound = f.repository.bindInput(ref(task), step(f, task, 2).stepId, input)
  const write = () => {
    if (input.kind !== 'compose') throw new Error('fixture compose input missing')
    return f.runs.composeVisible(task.runId, input.artifactIds, input.expectedTextHash, input.algorithm)
  }
  return { step: bound, input, write }
}
function commit(f: Fixture, task: WorkflowDriverTask) {
  const visible = f.runs.readVisibleComposition(task.runId)
  if (!visible) throw new Error('fixture composition missing')
  const input = parseWorkflowDriverStepInput({ kind: 'commit', chapterNumber: 1, expectedCompositionHash: visible.textHash })
  const bound = f.repository.bindInput(ref(task), step(f, task, 3).stepId, input)
  const effects = new GenerationDraftEffects(f.db, f.runs)
  const write = () => effects.commit({ handle: { projectId: f.projectId, epoch: 'fictional-runtime-epoch', rootActionId: f.run.rootActionId, runId: task.runId },
    chapterNumber: 1, source: 'write', expectedCompositionHash: visible.textHash }, () => f.assertCurrent())
  return { step: bound, input, write }
}
function throughComposition(f: Fixture, task: WorkflowDriverTask) {
  outline(f, task)
  draft(f, task)
  const prepared = composition(f, task)
  f.repository.withEffectCommit(ref(task), prepared.step.stepId, prepared.write)
}

describe('WorkflowDriverRepository native control and receipt ledger', () => {
  it('persists the complete recipe and every independent stable ID before the first effect', () => {
    const f = fixture(), task = f.repository.issue(f.request), steps = f.repository.readSteps(task.taskId)
    expect(task).toMatchObject({ projectId: f.projectId, template: 'prepared-first-chapter-v1', state: 'ready', revision: 1,
      recipe: f.recipe, recipeHash: textHash(JSON.stringify(f.recipe)), blockedCode: null, createdAt: 1000, updatedAt: 1000 })
    expect(steps.map(item => item.kind)).toEqual(['outline', 'draft', 'compose', 'commit'])
    expect(new Set(steps.flatMap(item => [item.stepId, item.commandId, ...(item.invocationNonce ? [item.invocationNonce] : [])])).size).toBe(10)
    expect(steps.map(item => item.invocationNonce === null)).toEqual([false, false, true, true])
    expect(steps.every(item => item.input === null && item.inputHash === null)).toBe(true)
    expect(count(f.db, 'generation_attempts')).toBe(0)
    expect(f.repository.readEffects(task.taskId)).toEqual([])
    expect(verifyM12WorkflowDriver(f.db)).toBe(true)
    const reopened = new WorkflowDriverRepository(f.db, f.options)
    expect(reopened.get(task.taskId)).toEqual(task)
    expect(reopened.readSteps(task.taskId)).toEqual(steps)
  })

  it('replays same-key same-payload without new IDs and rejects another recipe, run, request or duplicate run', () => {
    const f = fixture(), task = f.repository.issue(f.request), steps = f.repository.readSteps(task.taskId)
    expect(f.repository.issue({ ...f.request, taskId: randomUUID(), createdAt: 2000 })).toEqual(task)
    const changedRecipe = { ...f.recipe, baseDraftTask: { ...f.recipe.baseDraftTask, messages: [{ role: 'user' as const, content: 'Different author request' }] } }
    for (const patch of [{ recipe: changedRecipe }, { requestHash: textHash('different') }, { runId: f.open().runId }]) {
      expect(() => f.repository.issue({ ...f.request, ...patch })).toThrow('IDEMPOTENCY_CONFLICT')
    }
    expect(() => f.repository.issue({ ...f.request, taskId: randomUUID(), operationKey: randomUUID() })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(f.repository.readSteps(task.taskId)).toEqual(steps)
    expect(count(f.db, 'workflow_tasks')).toBe(1)
    expect(f.repository.getByOperation(f.request.operationKey)).toEqual(task)
  })

  it('shares caller native rollback and survives a real deferred foreign-key COMMIT failure without partial IDs', () => {
    const f = fixture()
    expect(() => f.db.transaction(() => { f.repository.issue(f.request); throw new Error('caller rollback') }).immediate()).toThrow('caller rollback')
    expect(count(f.db, 'workflow_tasks')).toBe(0)
    expect(count(f.db, 'workflow_steps')).toBe(0)
    f.db.exec('CREATE TABLE fictional_deferred_child(task_id TEXT REFERENCES workflow_tasks(task_id) DEFERRABLE INITIALLY DEFERRED)')
    expect(() => f.db.transaction(() => {
      f.repository.issue(f.request)
      f.db.prepare('INSERT INTO fictional_deferred_child VALUES(?)').run('missing-task')
    }).immediate()).toThrow()
    expect(count(f.db, 'workflow_tasks')).toBe(0)
    expect(count(f.db, 'workflow_steps')).toBe(0)
    expect(f.repository.issue(f.request).revision).toBe(1)
  })

  it('rejects another native DB, another project, a different operation, nonfirst chapter and a run that already started', () => {
    const a = fixture(), b = fixture('project-B'), task = a.repository.issue(a.request)
    expect(b.repository.get(task.taskId)).toBeNull()
    expect(() => b.db.transaction(() => b.repository.assertActive(ref(task)))()).toThrow('MISSING')
    for (const patch of [{ projectId: 'other-project' }, { chapterNumber: 2 }, { operation: 'planning-feedback' }]) {
      expect(() => b.repository.issue({ ...b.request, runId: b.open(patch).runId })).toThrow('RUN_MISMATCH')
    }
    const started = fixture()
    started.runs.reserve(started.run.runId, 'already-reserved', h, 200, 100)
    expect(() => started.repository.issue(started.request)).toThrow('RUN_ALREADY_STARTED')
  })

  it.each(['zh-CN', 'en-US'] as const)('binds recipe and short-outline injection to the frozen %s source language', writingLanguage => {
    const f = fixture('project-A', writingLanguage), other = writingLanguage === 'en-US' ? 'zh-CN' : 'en-US'
    const wrong = parseWorkflowDriverRecipe({ ...f.recipe, writingLanguage: other,
      baseDraftTask: { ...f.recipe.baseDraftTask, budgetDemand: { kind: 'draft-units', writingLanguage: other, requestedUnits: 20, segmentable: false } } })
    expect(() => f.repository.issue({ ...f.request, recipe: wrong })).toThrow('LANGUAGE_MISMATCH')
    expect(count(f.db, 'workflow_tasks')).toBe(0)
    expect(count(f.db, 'generation_attempts')).toBe(0)
    const task = f.repository.issue(f.request)
    outline(f, task)
    const prepared = draft(f, task)
    if (prepared.step.input?.kind !== 'model') throw new Error('fixture model input missing')
    expect(prepared.step.input.task.messages[0]!.content).toContain(draftShortOutlineBlock(writingLanguage, outlineText))
    expect(prepared.step.input.task.messages[0]!.content).not.toContain(draftShortOutlineBlock(other, outlineText))
    expect(verifyM12WorkflowDriver(f.db)).toBe(true)
  })

  it.each(['outlineTask', 'baseDraftTask'] as const)('refuses %s budget language that contradicts the frozen recipe language', key => {
    const f = fixture()
    const recipe = parseWorkflowDriverRecipe({ ...f.recipe, [key]: { ...f.recipe[key],
      budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 20, segmentable: false } } })
    expect(() => f.repository.issue({ ...f.request, recipe })).toThrow('LANGUAGE_MISMATCH')
    expect(count(f.db, 'workflow_tasks')).toBe(0)
    expect(count(f.db, 'generation_attempts')).toBe(0)
  })

  it.each(['zh-CN', 'en-US'] as const)('rejects a changed %s project language before issue or a new live step, while retaining history', writingLanguage => {
    const changed = writingLanguage === 'en-US' ? 'zh-CN' : 'en-US', beforeIssue = fixture('project-A', writingLanguage)
    beforeIssue.db.prepare("UPDATE project_core SET writing_language=? WHERE id='main'").run(changed)
    expect(() => beforeIssue.repository.issue(beforeIssue.request)).toThrow('SOURCE_LANGUAGE_CHANGED')
    expect(count(beforeIssue.db, 'workflow_tasks')).toBe(0)
    const f = fixture('project-A', writingLanguage), task = f.repository.issue(f.request), first = step(f, task, 0)
    f.db.prepare("UPDATE project_core SET writing_language=? WHERE id='main'").run(changed)
    expect(() => f.db.transaction(() => f.repository.assertActive(ref(task)))()).toThrow('SOURCE_LANGUAGE_CHANGED')
    expect(() => f.repository.bindInput(ref(task), first.stepId, { kind: 'model', task: f.recipe.outlineTask })).toThrow('SOURCE_LANGUAGE_CHANGED')
    expect(() => f.repository.issue(f.request)).toThrow('SOURCE_LANGUAGE_CHANGED')
    expect(f.repository.get(task.taskId)?.recipe.writingLanguage).toBe(writingLanguage)
    expect(count(f.db, 'generation_attempts')).toBe(0)
    expect(verifyM12WorkflowDriver(f.db)).toBe(true)
    expect(f.repository.cancel(ref(task)).state).toBe('cancelled')
  })

  it.each(['missing-main-freeze', 'changed-frozen-language'])(
    'does not infer main language authority from current settings or renderer recipe: %s', change => {
      const f = fixture()
      if (change === 'missing-main-freeze') {
        f.db.prepare("UPDATE generation_runs SET binding_json=json_remove(binding_json,'$.sourceManifest.freezeWritingLanguage') WHERE run_id=?").run(f.run.runId)
        expect(() => f.repository.issue(f.request)).toThrow('LANGUAGE_MISMATCH')
        expect(count(f.db, 'workflow_tasks')).toBe(0)
      } else {
        const task = f.repository.issue(f.request)
        f.db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.sourceManifest.writingLanguage','zh-CN') WHERE run_id=?").run(f.run.runId)
        f.db.prepare("UPDATE project_core SET writing_language='zh-CN' WHERE id='main'").run()
        expect(() => f.db.transaction(() => f.repository.assertActive(ref(task)))()).toThrow('LANGUAGE_MISMATCH')
        expect(verifyM12WorkflowDriver(f.db)).toBe(false)
      }
      expect(count(f.db, 'generation_attempts')).toBe(0)
    },
  )

  it('requires native transaction, exact revision/run, current resources and each history fence', () => {
    const f = fixture(), task = f.repository.issue(f.request), first = step(f, task, 0)
    expect(() => f.repository.assertActive(ref(task))).toThrow('TRANSACTION_REQUIRED')
    expect(f.db.transaction(() => f.repository.assertActive(ref(task)))()).toEqual(task)
    expect(() => f.db.transaction(() => f.repository.assertActive({ ...ref(task), revision: 2 }))()).toThrow('REVISION_CONFLICT')
    expect(() => f.db.transaction(() => f.repository.assertActive({ ...ref(task), runId: 'another-run' }))()).toThrow('RUN_MISMATCH')
    for (const table of ['workflow_tasks', 'workflow_steps', 'workflow_effects'] as const) {
      const key = `${table}:${table === 'workflow_tasks' ? task.taskId : first.stepId}`
      f.frozen.add(key)
      expect(() => f.db.transaction(() => f.repository.assertActive(ref(task)))()).toThrow('HISTORY_FROZEN')
      expect(() => f.repository.bindInput(ref(task), first.stepId, { kind: 'model', task: f.recipe.outlineTask })).toThrow('HISTORY_FROZEN')
      expect(f.repository.get(task.taskId)).toEqual(task)
      f.frozen.delete(key)
    }
    f.assertCurrent.mockImplementation(() => { throw new Error('captured native resources changed') })
    expect(() => f.repository.get(task.taskId)).toThrow('captured native resources changed')
    expect(() => f.repository.pause(ref(task))).toThrow('captured native resources changed')
  })

  it('keeps frozen old-project history readable after two X projections but never grants mutation', () => {
    const f = fixture(), task = f.repository.issue(f.request), steps = f.repository.readSteps(task.taskId)
    f.repository.bindInput(ref(task), steps[0]!.stepId, { kind: 'model', task: f.recipe.outlineTask })
    const newCopy = new WorkflowDriverRepository(f.db, { ...f.options, projectId: 'new-copy-project' })
    expect(() => newCopy.get(task.taskId)).toThrow('PROJECT_MISMATCH')
    f.frozen.add(`workflow_tasks:${task.taskId}`)
    for (const item of steps) for (const table of ['workflow_steps', 'workflow_effects']) f.frozen.add(`${table}:${item.stepId}`)
    for (const generation of [1, 2]) {
      f.db.prepare('UPDATE workflow_tasks SET operation_key=?,request_hash=NULL WHERE task_id=?').run(`portable-history:${task.taskId}`, task.taskId)
      f.db.prepare('UPDATE workflow_steps SET invocation_nonce=NULL WHERE task_id=?').run(task.taskId)
      f.db.prepare("UPDATE generation_runs SET binding_json='{}' WHERE run_id=?").run(task.runId)
      expect(newCopy.get(task.taskId)).toMatchObject({ projectId: f.projectId, state: 'ready', requestHash: null, recipe: f.recipe })
      expect(newCopy.readSteps(task.taskId).every(item => item.invocationNonce === null)).toBe(true)
      expect(() => newCopy.resume(ref(task))).toThrow('HISTORY_FROZEN')
      expect(() => newCopy.cancel(ref(task))).toThrow('HISTORY_FROZEN')
      expect(() => newCopy.acknowledgeFromReceipt(ref(task), steps[0]!.stepId)).toThrow('HISTORY_FROZEN')
      expect({ generation, valid: verifyM12WorkflowDriver(f.db) }).toEqual({ generation, valid: true })
    }
  })

  it('freezes per-step semantic inputs and enforces order, actual outline injection and artifact membership', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    expect(() => f.repository.bindInput(ref(task), step(f, task, 1).stepId, { kind: 'model', task: f.recipe.baseDraftTask })).toThrow('STEP_ORDER')
    expect(() => f.repository.bindInput(ref(task), step(f, task, 0).stepId, { kind: 'model', task: f.recipe.baseDraftTask })).toThrow('INPUT_MISMATCH')
    const done = outline(f, task), original = f.repository.readSteps(task.taskId)[0]!
    expect(f.repository.bindInput(ref(task), done.step.stepId, { kind: 'model', task: f.recipe.outlineTask })).toEqual(original)
    expect(() => f.repository.bindInput(ref(task), done.step.stepId, { kind: 'model', task: f.recipe.baseDraftTask })).toThrow('INPUT_CONFLICT')
    expect(() => f.repository.bindInput(ref(task), step(f, task, 1).stepId, { kind: 'model', task: f.recipe.baseDraftTask })).toThrow('INPUT_MISMATCH')
    draft(f, task)
    expect(() => f.repository.bindInput(ref(task), step(f, task, 2).stepId, { kind: 'compose', artifactIds: [done.receipt.artifact!.artifactId],
      algorithm: DRAFT_VISIBLE_TEXT_VERSION, expectedTextHash: textHash(outlineText) })).toThrow('INPUT_MISMATCH')
  })

  it('recovers model COMMIT-before-ACK by original nonce with no second reservation or effect', () => {
    const f = fixture(), task = f.repository.issue(f.request), done = outline(f, task, false)
    const reopened = new WorkflowDriverRepository(f.db, f.options)
    expect(reopened.readEffects(task.taskId)).toEqual([])
    expect(reopened.acknowledgeFromReceipt(ref(task), done.step.stepId)).toMatchObject({ receiptKind: 'model', receiptAttemptId: done.receipt.attempt.attemptId })
    expect(reopened.acknowledgeFromReceipt(ref(task), done.step.stepId)).toEqual(reopened.readEffects(task.taskId)[0])
    expect(count(f.db, 'generation_attempts')).toBe(1)
  })

  it('accepts a complete stop with unknown usage, but refuses reserved/dispatched unknown, truncation and failures', () => {
    const allowed = fixture(), task = allowed.repository.issue(allowed.request)
    const bound = allowed.repository.bindInput(ref(task), step(allowed, task, 0).stepId, { kind: 'model', task: allowed.recipe.outlineTask })
    finish(allowed, task, bound, outlineText, { trusted: false })
    expect(allowed.repository.acknowledgeFromReceipt(ref(task), bound.stepId)?.receiptKind).toBe('model')
    for (const options of [{ reserveOnly: true }, { trusted: false, finishReason: null }, { finishReason: 'length' }, { failureCode: 'GENERATION_PROVIDER_FAILED' }]) {
      const f = fixture(), current = f.repository.issue(f.request)
      const model = f.repository.bindInput(ref(current), step(f, current, 0).stepId, { kind: 'model', task: f.recipe.outlineTask })
      finish(f, current, model, outlineText, options)
      expect(() => f.repository.acknowledgeFromReceipt(ref(current), model.stepId)).toThrow('RECEIPT_NOT_COMMITTED')
      expect(f.repository.readEffects(current.taskId)).toEqual([])
      expect(count(f.db, 'generation_attempts')).toBe(1)
    }
  })

  it('does not ACK a retained unsaved tail even when the prefix has a stop receipt', () => {
    const f = fixture(), task = f.repository.issue(f.request), done = outline(f, task, false), artifact = done.receipt.artifact!
    f.db.prepare('INSERT INTO generation_recovery_tails VALUES(?,?,?,?,?,?,?)')
      .run(done.receipt.attempt.attemptId, artifact.artifactId, artifact.revision, artifact.textHash, 'Unsaved author-visible tail', textHash('Unsaved author-visible tail'), '2026-11-07T00:00:00.000Z')
    expect(() => f.repository.acknowledgeFromReceipt(ref(task), done.step.stepId)).toThrow('RECEIPT_NOT_COMMITTED')
    expect(f.repository.readEffects(task.taskId)).toEqual([])
  })

  it.each(['wrong-purpose', 'wrong-replay-task', 'missing-artifact', 'discarded-artifact'])(
    'refuses %s as a model completion without a second reservation', corruption => {
      const f = fixture(), task = f.repository.issue(f.request), done = outline(f, task, false)
      if (corruption === 'wrong-purpose') f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.purpose','chapter-review') WHERE attempt_id=?")
        .run(done.receipt.attempt.attemptId)
      if (corruption === 'wrong-replay-task') {
        const usage = JSON.parse(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(done.receipt.attempt.attemptId) as string)
        f.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
          .run(JSON.stringify({ ...usage, replayTask: f.recipe.baseDraftTask }), done.receipt.attempt.attemptId)
      }
      if (corruption === 'missing-artifact') f.db.prepare('DELETE FROM generation_artifacts WHERE attempt_id=?').run(done.receipt.attempt.attemptId)
      if (corruption === 'discarded-artifact') f.db.prepare("UPDATE generation_artifacts SET status='discarded' WHERE attempt_id=?").run(done.receipt.attempt.attemptId)
      expect(() => f.repository.acknowledgeFromReceipt(ref(task), done.step.stepId)).toThrow()
      expect(f.repository.readEffects(task.taskId)).toEqual([])
      expect(count(f.db, 'generation_attempts')).toBe(1)
    },
  )

  it('rejects a live model step whose private nonce was removed even when its input is already bound', () => {
    const f = fixture(), task = f.repository.issue(f.request), first = step(f, task, 0)
    f.repository.bindInput(ref(task), first.stepId, { kind: 'model', task: f.recipe.outlineTask })
    f.db.prepare('UPDATE workflow_steps SET invocation_nonce=NULL WHERE step_id=?').run(first.stepId)
    expect(() => f.db.transaction(() => f.repository.assertActive(ref(task)))()).toThrow('HISTORY_FROZEN')
    expect(() => f.repository.bindInput(ref(task), first.stepId, { kind: 'model', task: f.recipe.outlineTask })).toThrow('HISTORY_FROZEN')
    expect(verifyM12WorkflowDriver(f.db)).toBe(false)
    expect(count(f.db, 'generation_attempts')).toBe(0)
  })

  it('reconciles both composition and draft COMMIT-before-ACK from original receipts without calling a writer again', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    outline(f, task); draft(f, task)
    const composed = composition(f, task)
    composed.write()
    const noCompose = vi.fn(() => { throw new Error('composition must not run twice') })
    f.repository.withEffectCommit(ref(task), composed.step.stepId, noCompose)
    expect(noCompose).not.toHaveBeenCalled()
    const saved = commit(f, task), original = saved.write(), noDraft = vi.fn(() => { throw new Error('draft must not run twice') })
    const receipt = f.repository.withEffectCommit(ref(task), saved.step.stepId, noDraft)
    expect(receipt).toMatchObject({ receiptKind: 'draft_commit', contentHash: original.contentHash })
    expect(noDraft).not.toHaveBeenCalled()
    expect(f.repository.get(task.taskId)?.state).toBe('waiting_review')
    expect(count(f.db, 'drafts')).toBe(1)
    expect(f.repository.readEffects(task.taskId)).toHaveLength(4)
    expect(verifyM12WorkflowDriver(f.db)).toBe(true)
  })

  it.each(['outline-hash', 'draft-hash', 'composition-hash', 'commit-hash', 'wrong-purpose', 'missing-artifact',
    'composition-receipt', 'commit-receipt', 'commit-epoch', 'missing-commit-receipt', 'wrong-receipt-attempt'])(
    'rejects completed catalog corruption: %s', corruption => {
      const f = fixture(), task = f.repository.issue(f.request)
      throughComposition(f, task)
      const save = commit(f, task)
      f.repository.withEffectCommit(ref(task), save.step.stepId, save.write)
      const effects = f.repository.readEffects(task.taskId)
      expect(verifyM12WorkflowDriver(f.db)).toBe(true)
      const ordinal = ['outline-hash', 'draft-hash', 'composition-hash', 'commit-hash'].indexOf(corruption)
      if (ordinal >= 0) f.db.prepare('UPDATE workflow_effects SET content_hash=? WHERE step_id=?').run('a'.repeat(64), effects[ordinal]!.stepId)
      const draftAttempt = effects[1]!.receiptAttemptId
      if (corruption === 'wrong-purpose') f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.purpose','chapter-review') WHERE attempt_id=?").run(draftAttempt)
      if (corruption === 'missing-artifact') f.db.prepare('DELETE FROM generation_artifacts WHERE attempt_id=?').run(draftAttempt)
      if (corruption === 'composition-receipt') f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.visibleComposition.textHash',?) WHERE attempt_id=?").run('b'.repeat(64), draftAttempt)
      if (corruption === 'commit-receipt') f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.draftCommit.contentHash',?) WHERE attempt_id=?").run('b'.repeat(64), draftAttempt)
      if (corruption === 'commit-epoch') f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.draftCommit.handle.epoch','another-runtime') WHERE attempt_id=?").run(draftAttempt)
      if (corruption === 'missing-commit-receipt') f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_remove(usage_receipt_json,'$.draftCommit') WHERE attempt_id=?").run(draftAttempt)
      if (corruption === 'wrong-receipt-attempt') f.db.prepare('UPDATE workflow_effects SET receipt_attempt_id=? WHERE step_id=?').run(effects[0]!.receiptAttemptId, effects[2]!.stepId)
      expect(verifyM12WorkflowDriver(f.db)).toBe(false)
      expect(f.repository.readEffects(task.taskId)).toHaveLength(4)
      expect(count(f.db, 'generation_attempts')).toBe(2)
    },
  )

  it.each(['edited', 'missing'])('keeps a known draft COMMIT but blocks %s current draft across the ACK gap', change => {
    const f = fixture(), task = f.repository.issue(f.request)
    throughComposition(f, task)
    const save = commit(f, task), original = save.write(), neverWrite = vi.fn(() => { throw new Error('known COMMIT must never rerun') })
    if (change === 'edited') f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)')
      .run('The author independently changed this draft after the original COMMIT.', original.id)
    else f.db.prepare('DELETE FROM drafts_all WHERE id=?').run(original.id)
    const effect = f.repository.withEffectCommit(ref(task), save.step.stepId, neverWrite)
    const blocked = f.repository.get(task.taskId)!
    expect(effect).toMatchObject({ receiptKind: 'draft_commit', contentHash: original.contentHash })
    expect(blocked).toMatchObject({ state: 'blocked', blockedCode: 'SOURCE_DRAFT_CHANGED', revision: 2 })
    expect(f.repository.withEffectCommit(ref(blocked), save.step.stepId, neverWrite)).toEqual(effect)
    expect(f.repository.get(task.taskId)).toEqual(blocked)
    expect(neverWrite).not.toHaveBeenCalled()
    expect(f.repository.readEffects(task.taskId)).toHaveLength(4)
    expect(count(f.db, 'drafts')).toBe(change === 'edited' ? 1 : 0)
    expect(verifyM12WorkflowDriver(f.db)).toBe(true)
  })

  it('rolls back a failed changed-source ACK without erasing the earlier domain COMMIT', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    throughComposition(f, task)
    const save = commit(f, task), original = save.write()
    f.db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('Independent author edit.', original.id)
    f.db.exec("CREATE TEMP TRIGGER reject_source_block BEFORE UPDATE ON workflow_tasks WHEN NEW.blocked_code='SOURCE_DRAFT_CHANGED' BEGIN SELECT RAISE(ABORT,'fictional state failure'); END")
    expect(() => f.repository.acknowledgeFromReceipt(ref(task), save.step.stepId)).toThrow('fictional state failure')
    expect(f.repository.readEffects(task.taskId)).toHaveLength(3)
    expect(f.repository.get(task.taskId)?.state).toBe('ready')
    expect(count(f.db, 'drafts')).toBe(1)
    expect(new GenerationDraftEffects(f.db, f.runs).readRecovery(task.runId)).toEqual({ kind: 'changed' })
    f.db.exec('DROP TRIGGER reject_source_block')
    expect(f.repository.acknowledgeFromReceipt(ref(task), save.step.stepId)?.contentHash).toBe(original.contentHash)
    expect(f.repository.get(task.taskId)?.blockedCode).toBe('SOURCE_DRAFT_CHANGED')
  })

  it('retains the complete four-effect catalog over two projected history generations without a usable nonce', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    throughComposition(f, task)
    const save = commit(f, task)
    f.repository.withEffectCommit(ref(task), save.step.stepId, save.write)
    const originalEffects = f.repository.readEffects(task.taskId), originalSteps = f.repository.readSteps(task.taskId)
    f.frozen.add(`workflow_tasks:${task.taskId}`)
    for (const item of originalSteps) for (const table of ['workflow_steps', 'workflow_effects']) f.frozen.add(`${table}:${item.stepId}`)
    const copy = new WorkflowDriverRepository(f.db, { ...f.options, projectId: 'new-copy-project' })
    for (const generation of [1, 2]) {
      f.db.prepare('UPDATE workflow_tasks SET operation_key=?,request_hash=NULL WHERE task_id=?').run(`portable-history:${task.taskId}`, task.taskId)
      f.db.prepare('UPDATE workflow_steps SET invocation_nonce=NULL WHERE task_id=?').run(task.taskId)
      f.db.prepare("UPDATE generation_runs SET binding_json='{}' WHERE run_id=?").run(task.runId)
      f.db.prepare("UPDATE generation_attempts SET usage_receipt_json=NULL,invocation_nonce='portable-history:'||attempt_id WHERE run_id=?").run(task.runId)
      f.db.prepare("UPDATE generation_artifacts SET artifact_json=json_remove(artifact_json,'$.projectId','$.epoch','$.fingerprint') WHERE run_id=?").run(task.runId)
      expect({ generation, valid: verifyM12WorkflowDriver(f.db) }).toEqual({ generation, valid: true })
      expect(copy.readEffects(task.taskId)).toEqual(originalEffects)
      expect(copy.get(task.taskId)).toMatchObject({ projectId: f.projectId, state: 'waiting_review', requestHash: null })
      expect(copy.readSteps(task.taskId).map(item => item.commandId)).toEqual(originalSteps.map(item => item.commandId))
      expect(() => copy.acknowledgeFromReceipt(ref(task), save.step.stepId)).toThrow('HISTORY_FROZEN')
      expect(() => copy.resume(ref(task))).toThrow('HISTORY_FROZEN')
    }
    f.db.prepare('UPDATE workflow_effects SET content_hash=? WHERE step_id=?').run('b'.repeat(64), originalSteps[2]!.stepId)
    expect(verifyM12WorkflowDriver(f.db)).toBe(false)
  })

  it('lets cancel win with zero draft writer calls, or preserves an earlier completed draft and repeat receipt', () => {
    const cancelled = fixture(), a = cancelled.repository.issue(cancelled.request)
    throughComposition(cancelled, a)
    const saveA = commit(cancelled, a), writerA = vi.fn(saveA.write), stopped = cancelled.repository.cancel(ref(a))
    expect(stopped).toMatchObject({ state: 'cancelled', revision: 2 })
    expect(cancelled.repository.cancel(ref(a))).toEqual(stopped)
    expect(() => cancelled.repository.withEffectCommit(ref(a), saveA.step.stepId, writerA)).toThrow('REVISION_CONFLICT')
    expect(() => cancelled.repository.withEffectCommit(ref(stopped), saveA.step.stepId, writerA)).toThrow('INACTIVE')
    expect(writerA).not.toHaveBeenCalled()
    expect(count(cancelled.db, 'drafts')).toBe(0)
    const committed = fixture(), b = committed.repository.issue(committed.request)
    throughComposition(committed, b)
    const saveB = commit(committed, b), writerB = vi.fn(saveB.write), receipt = committed.repository.withEffectCommit(ref(b), saveB.step.stepId, writerB)
    expect(committed.repository.cancel(ref(b)).state).toBe('waiting_review')
    expect(committed.repository.withEffectCommit(ref(b), saveB.step.stepId, writerB)).toEqual(receipt)
    expect(writerB).toHaveBeenCalledTimes(1)
    expect(count(committed.db, 'drafts')).toBe(1)
  })

  it('permits only receipt linking after cancellation, not a new effect or a false review transition', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    throughComposition(f, task)
    const save = commit(f, task)
    save.write()
    const cancelled = f.repository.cancel(ref(task))
    expect(f.repository.acknowledgeFromReceipt(ref(cancelled), save.step.stepId)?.receiptKind).toBe('draft_commit')
    expect(f.repository.get(task.taskId)?.state).toBe('cancelled')
    expect(count(f.db, 'drafts')).toBe(1)
  })

  it('atomically rolls back the original domain writer and ACK on callback failure, missing proof, async or thenable', () => {
    for (const failure of ['throw', 'missing-proof', 'async', 'thenable']) {
      const f = fixture(), task = f.repository.issue(f.request)
      throughComposition(f, task)
      const save = commit(f, task)
      const callback = failure === 'async' ? async () => { save.write() } : () => {
        if (failure !== 'missing-proof') save.write()
        if (failure === 'throw') throw new Error('fictional writer failure')
        return failure === 'thenable' ? { then() {} } : undefined
      }
      expect(() => f.repository.withEffectCommit(ref(task), save.step.stepId, callback)).toThrow()
      expect(count(f.db, 'drafts')).toBe(0)
      expect(f.repository.readEffects(task.taskId)).toHaveLength(3)
      expect(f.repository.get(task.taskId)?.state).toBe('ready')
      expect(new GenerationDraftEffects(f.db, f.runs).readCommit(task.runId)).toBeNull()
    }
  })

  it('rolls back domain COMMIT when an ACK write trigger fails and allows an exact later retry', () => {
    const f = fixture(), task = f.repository.issue(f.request)
    throughComposition(f, task)
    const save = commit(f, task)
    f.db.exec("CREATE TEMP TRIGGER reject_workflow_ack BEFORE INSERT ON workflow_effects WHEN NEW.receipt_kind='draft_commit' BEGIN SELECT RAISE(ABORT,'fictional ACK failure'); END")
    expect(() => f.repository.withEffectCommit(ref(task), save.step.stepId, save.write)).toThrow('fictional ACK failure')
    expect(count(f.db, 'drafts')).toBe(0)
    expect(f.repository.get(task.taskId)?.state).toBe('ready')
    f.db.exec('DROP TRIGGER reject_workflow_ack')
    expect(f.repository.withEffectCommit(ref(task), save.step.stepId, save.write).receiptKind).toBe('draft_commit')
    expect(count(f.db, 'drafts')).toBe(1)
  })

  it('persists pause/block/resume revisions without changing stable commands, recipe or existing effect references', () => {
    const f = fixture(), task = f.repository.issue(f.request), ids = f.repository.readSteps(task.taskId)
    const paused = f.repository.pause(ref(task))
    expect(paused).toMatchObject({ state: 'paused', revision: 2 })
    expect(f.repository.pause(ref(task))).toEqual(paused)
    expect(() => f.repository.bindInput(ref(paused), ids[0]!.stepId, { kind: 'model', task: f.recipe.outlineTask })).toThrow('INACTIVE')
    f.now.value = 900
    const resumed = f.repository.resume(ref(paused))
    expect(resumed).toMatchObject({ state: 'ready', revision: 3, updatedAt: 1000 })
    const blocked = f.repository.block(ref(resumed), 'GENERATION_SOURCE_CHANGED')
    expect(blocked).toMatchObject({ state: 'blocked', blockedCode: 'GENERATION_SOURCE_CHANGED', revision: 4 })
    expect(() => f.repository.block(ref(blocked), 'external error with secret')).toThrow('BLOCK_CODE_INVALID')
    expect(f.repository.readSteps(task.taskId)).toEqual(ids)
    expect(f.repository.get(task.taskId)?.recipe).toEqual(f.recipe)
    expect(f.repository.readEffects(task.taskId)).toEqual([])
  })

  it('rejects unexpected recipe/input fields and mismatched input hashes without invoking domain code', () => {
    const f = fixture(), task = f.repository.issue(f.request), first = step(f, task, 0)
    expect(() => f.repository.bindInput(ref(task), first.stepId, { kind: 'model', task: f.recipe.outlineTask, epoch: 'excluded' } as WorkflowDriverStepInput)).toThrow('WORKFLOW_DRIVER_PAYLOAD_INVALID')
    f.repository.bindInput(ref(task), first.stepId, { kind: 'model', task: f.recipe.outlineTask })
    f.db.prepare('UPDATE workflow_steps SET input_hash=? WHERE step_id=?').run('a'.repeat(64), first.stepId)
    expect(() => f.repository.readSteps(task.taskId)).toThrow('INTEGRITY_FAILED')
    expect(count(f.db, 'generation_attempts')).toBe(0)
  })
})
